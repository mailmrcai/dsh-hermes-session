#!/usr/bin/env python3
"""
hermes-read: 只读访问 Hermes Agent 的会话库（SQLite: ~/.hermes/state.db）。

设计约束（重要）：
- **只读**：以 `mode=ro` 打开，绝不写 hermes 的任何状态文件。
  本机根分区曾被以 ro 挂载，任何写操作都可能失败；只读是唯一安全的姿态。
- **无第三方依赖**：只用标准库 sqlite3，兼容 Python 3.8+（本机 /usr/bin/python3 是 3.8）。
- **无网络**：纯本地读取。
- **不 import hermes 源码**：hermes 自身启动有 install.lock / pm-runtime 自检，
  在只读文件系统上会直接崩。这里直接读它的持久化契约（表结构），并做防御性读取。

输出：stdout 输出**单个 JSON 对象**。失败时输出 {"ok": false, "error": {...}}，
       并保证非零退出码，便于 Node 侧统一处理。

子命令：
  list    列出会话（支持 --query 过滤、--limit）
  show    读取一个会话的完整消息（支持 --max-msgs / --max-chars / --roles）
  get     读取单个会话的元信息

用法示例：
  hermes-read list --limit 20 --query sirna
  hermes-read show 20261021_135435_55dc36 --max-msgs 200 --max-chars 60000
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import time
from typing import Any, Dict, List, Optional

DEFAULT_DB = os.path.expanduser("~/.hermes/state.db")

# 模型从这些角色里拿上下文；session_meta 是 hermes 的内部行，不喂给模型。
FEEDABLE_ROLES = ("user", "assistant", "tool")

_SESSION_ID_RE = re.compile(r"^[0-9]{8}_[0-9]{6}_[0-9a-f]{6,}$")


class ReadError(Exception):
    def __init__(self, code: str, message: str, hint: Optional[str] = None):
        super().__init__(message)
        self.code = code
        self.hint = hint


def _connect(db_path: str) -> sqlite3.Connection:
    if not os.path.exists(db_path):
        raise ReadError(
            "DB_NOT_FOUND",
            "hermes 会话库不存在：%s" % db_path,
            "确认 ~/.hermes/state.db 存在，或传入 --db 指定其它路径。",
        )
    # mode=ro：SQLite 只读打开；uri=True 才允许这种 DSN。
    # timeout 给足，避免 hermes 进程持锁时立即报 database is locked。
    try:
        conn = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True, timeout=15.0)
    except sqlite3.Error as exc:
        raise ReadError("DB_OPEN_FAILED", "无法只读打开 hermes 会话库：%s" % exc)
    conn.row_factory = sqlite3.Row
    return conn


def _table_columns(conn: sqlite3.Connection, table: str) -> List[str]:
    try:
        return [r[1] for r in conn.execute("PRAGMA table_info(%s)" % table)]
    except sqlite3.Error:
        return []


# ─────────────────────── 会话库发现（多 profile）───────────────────────
#
# Hermes 的会话不是存一个库，而是按 profile 分库：
#   ~/.hermes/state.db                     → profile "default"
#   ~/.hermes/profiles/<name>/state.db     → profile "<name>"
# 只读主库会漏掉其它 profile 的会话（本机实测：主库 270 个会话，
# 另外 5 个 profile 还有 153 个）。所以默认扫全部库，并给每条结果标上 profile。


def hermes_home() -> str:
    """Hermes 数据根目录：$HERMES_HOME，否则 ~/.hermes。"""
    return os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")


def discover_dbs(explicit_db: Optional[str], profile: Optional[str]) -> List[Dict[str, str]]:
    """返回 [{profile, path}]，default 恒排第一（--db 指定时只有它）。"""
    if explicit_db and explicit_db != DEFAULT_DB:
        name = profile or _profile_from_path(explicit_db)
        return [{"profile": name, "path": explicit_db}]

    home = hermes_home()
    found: List[Dict[str, str]] = []
    main_db = os.path.join(home, "state.db")
    if os.path.exists(main_db):
        found.append({"profile": "default", "path": main_db})

    profiles_dir = os.path.join(home, "profiles")
    if os.path.isdir(profiles_dir):
        for name in sorted(os.listdir(profiles_dir)):
            if name == "default":
                continue  # default 就是主库，别重复
            db = os.path.join(profiles_dir, name, "state.db")
            if os.path.isfile(db):
                found.append({"profile": name, "path": db})

    if profile:
        found = [d for d in found if d["profile"] == profile]
        if not found:
            raise ReadError(
                "PROFILE_NOT_FOUND",
                "找不到 profile「%s」的会话库。" % profile,
                "可用 profile：%s" % (", ".join(_available_profiles(home)) or "（无）"),
            )
    if not found:
        raise ReadError(
            "DB_NOT_FOUND",
            "在 %s 下没有找到任何 hermes 会话库。" % home,
            "确认 Hermes Agent 已安装并跑过会话，或用 --db 指定 state.db。",
        )
    return found


def _available_profiles(home: str) -> List[str]:
    names = ["default"]
    profiles_dir = os.path.join(home, "profiles")
    if os.path.isdir(profiles_dir):
        for name in sorted(os.listdir(profiles_dir)):
            if name == "default":
                continue
            if os.path.isfile(os.path.join(profiles_dir, name, "state.db")):
                names.append(name)
    return names


def _profile_from_path(path: str) -> str:
    """从路径反推 profile 名，便于 --db 直连时仍能标注来源。"""
    parts = os.path.normpath(path).split(os.sep)
    if "profiles" in parts:
        i = parts.index("profiles")
        if i + 1 < len(parts):
            return parts[i + 1]
    return "default"


def _resolve_target(dbs: List[Dict[str, str]], session_id: str) -> Dict[str, Any]:
    """在候选库里定位一个会话：先精确 id，再唯一前缀。"""
    prefix_matches: List[Dict[str, Any]] = []
    for db in dbs:
        try:
            conn = _connect(db["path"])
        except ReadError:
            continue
        try:
            row = conn.execute("SELECT id FROM sessions WHERE id = ?", (session_id,)).fetchone()
            if row is not None:
                return {"db": db, "sessionId": row[0], "byPrefix": False}
            for full in _resolve_prefix(conn, session_id):
                prefix_matches.append({"db": db, "sessionId": full, "byPrefix": True})
        except sqlite3.Error:
            continue  # 这个库可能没有 sessions 表，换下一个
        finally:
            conn.close()

    if len(prefix_matches) == 1:
        return prefix_matches[0]
    if len(prefix_matches) > 1:
        listed = ", ".join(
            "%s (%s)" % (m["sessionId"], m["db"]["profile"]) for m in prefix_matches[:8]
        )
        raise ReadError(
            "AMBIGUOUS_SESSION",
            "会话 id 前缀 %s 在多个库里匹配到：%s" % (session_id, listed),
            "请给出更完整或精确的 sessionId。",
        )
    raise ReadError(
        "SESSION_NOT_FOUND",
        "所有 hermes 会话库里都找不到会话：%s" % session_id,
        "先用 hermes_sessions_list 找到准确的 sessionId（可加 --profile 限定范围）。",
    )


def _require_tables(conn: sqlite3.Connection, tables: List[str]) -> None:
    existing = {
        r[0]
        for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    missing = [t for t in tables if t not in existing]
    if missing:
        raise ReadError(
            "SCHEMA_MISMATCH",
            "hermes 会话库缺少表：%s" % ", ".join(missing),
            "hermes 版本可能已升级并改变了持久化格式；先跑 `hermes-read list` 看是否可读，再考虑适配。",
        )


def _iso(ts: Optional[float]) -> Optional[str]:
    if not ts:
        return None
    try:
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(float(ts)))
    except (ValueError, OSError):
        return None


# ───────────────────────────── list ─────────────────────────────


def _list_one_db(
    conn: sqlite3.Connection, args: argparse.Namespace, profile: str, limit: int
) -> Dict[str, Any]:
    """在一个库里查一页会话；缺列的旧库按可用列降级，不报错。"""
    _require_tables(conn, ["sessions"])

    cols = _table_columns(conn, "sessions")
    want = [
        "id", "title", "source", "model", "message_count", "cwd",
        "started_at", "last_activity_at", "archived", "hidden",
        "parent_session_id", "git_repo_root",
    ]
    picked = [c for c in want if c in cols]

    sql = "SELECT %s FROM sessions" % ", ".join(picked)
    params: List[Any] = []

    where = []
    if "hidden" in cols and not args.include_hidden:
        where.append("COALESCE(hidden, 0) = 0")
    if "archived" in cols and not args.include_archived:
        where.append("COALESCE(archived, 0) = 0")
    # 子会话（压缩续写 / 子代理）默认隐藏
    if "parent_session_id" in cols and not args.include_children:
        where.append("COALESCE(parent_session_id, '') = ''")
    if args.query:
        q = "%" + args.query.lower() + "%"
        like_parts = ["LOWER(COALESCE(id, '')) LIKE ?"]
        params.append(q)
        for c in ("title", "cwd", "display_name"):
            if c in cols:
                like_parts.append("LOWER(COALESCE(%s, '')) LIKE ?" % c)
                params.append(q)
        where.append("(" + " OR ".join(like_parts) + ")")
    if where:
        sql += " WHERE " + " AND ".join(where)

    order = (
        "COALESCE(last_activity_at, started_at) DESC"
        if "last_activity_at" in cols
        else "started_at DESC"
    )
    # 每个库各取一页再全局排序：取满 limit 就够，不会漏掉全局最近的会话。
    sql += " ORDER BY %s LIMIT ?" % order
    params.append(int(limit))

    try:
        rows = list(conn.execute(sql, params))
    except sqlite3.Error as exc:
        raise ReadError("QUERY_FAILED", "查询 sessions 失败（%s）：%s" % (profile, exc))

    sessions = []
    for r in rows:
        d = dict(r)
        sessions.append(
            {
                "sessionId": d.get("id"),
                "profile": profile,
                "title": d.get("title"),
                "source": d.get("source"),
                "model": d.get("model"),
                "messageCount": d.get("message_count"),
                "cwd": d.get("cwd"),
                "gitRepoRoot": d.get("git_repo_root"),
                "startedAt": _iso(d.get("started_at")),
                "lastActivityAt": _iso(d.get("last_activity_at")),
                # 排序用的原始时间戳：_iso 丢了精度，不能拿来比大小。返回前会删掉。
                "_lastActivityRaw": d.get("last_activity_at") or d.get("started_at") or 0,
                "archived": bool(d.get("archived")),
                "hidden": bool(d.get("hidden")),
                "parentSessionId": d.get("parent_session_id"),
            }
        )

    total = None
    try:
        total = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    except sqlite3.Error:
        pass
    return {"sessions": sessions, "total": total}


def cmd_list(dbs: List[Dict[str, str]], args: argparse.Namespace) -> Dict[str, Any]:
    """跨 profile 聚合会话，按最后活动时间倒序，返回 limit 条。"""
    merged: List[Dict[str, Any]] = []
    totals: Dict[str, int] = {}
    unreadable: List[str] = []

    for db in dbs:
        try:
            conn = _connect(db["path"])
        except ReadError as exc:
            unreadable.append("%s: %s" % (db["profile"], exc.code))
            continue
        try:
            page = _list_one_db(conn, args, db["profile"], args.limit)
            merged.extend(page["sessions"])
            if page["total"] is not None:
                totals[db["profile"]] = page["total"]
        except ReadError as exc:
            # 单个库结构异常不影响其它库；记下来让用户知道范围缩小了。
            unreadable.append("%s: %s" % (db["profile"], exc.code))
        finally:
            conn.close()

    merged.sort(key=_activity_key, reverse=True)
    limited = merged[: int(args.limit)]
    for item in limited:
        item.pop("_lastActivityRaw", None)

    return {
        "ok": True,
        "db": dbs[0]["path"] if len(dbs) == 1 else None,
        "dbs": [{"profile": d["profile"], "path": d["path"]} for d in dbs],
        "totalSessions": sum(totals.values()) if totals else None,
        "perProfileTotals": totals,
        "unreadableProfiles": unreadable,
        "returned": len(limited),
        "sessions": limited,
    }


def _activity_key(item: Dict[str, Any]) -> float:
    """用渲染前的原始时间戳排序；_iso 丢了精度，不能拿来比大小。"""
    raw = item.get("_lastActivityRaw")
    return float(raw) if isinstance(raw, (int, float)) else 0.0



# ───────────────────────────── get ──────────────────────────────


def cmd_get(dbs: List[Dict[str, str]], args: argparse.Namespace) -> Dict[str, Any]:
    target = _resolve_target(dbs, args.session_id)
    conn = _connect(target["db"]["path"])
    try:
        row = conn.execute(
            "SELECT * FROM sessions WHERE id = ?", (target["sessionId"],)
        ).fetchone()
    finally:
        conn.close()
    if row is None:  # _resolve_target 命中过，这里只是防御
        raise ReadError(
            "SESSION_NOT_FOUND",
            "找不到会话：%s" % args.session_id,
            "先用 hermes_sessions_list 找到准确的 sessionId。",
        )
    d = dict(row)
    # 不返回 system_prompt（几万字符），只给长度，方便判断。
    sp = d.pop("system_prompt", None)
    return {
        "ok": True,
        "profile": target["db"]["profile"],
        "session": {
            "sessionId": d.get("id"),
            "profile": target["db"]["profile"],
            "title": d.get("title"),
            "source": d.get("source"),
            "model": d.get("model"),
            "messageCount": d.get("message_count"),
            "toolCallCount": d.get("tool_call_count"),
            "cwd": d.get("cwd"),
            "gitRepoRoot": d.get("git_repo_root"),
            "startedAt": _iso(d.get("started_at")),
            "endedAt": _iso(d.get("ended_at")),
            "lastActivityAt": _iso(d.get("last_activity_at")),
            "archived": bool(d.get("archived")),
            "hidden": bool(d.get("hidden")),
            "parentSessionId": d.get("parent_session_id"),
            "systemPromptChars": len(sp) if isinstance(sp, str) else None,
        },
    }


def _resolve_prefix(conn: sqlite3.Connection, prefix: str) -> List[str]:
    """精确 id 之外的唯一前缀匹配（对齐 hermes 的 resolve_session_id）。"""
    # LIKE 里 _ 和 % 是通配符，而 hermes 的 id 恰好含下划线（20261021_135435_55dc36），
    # 必须显式转义并声明 ESCAPE，否则前缀永远匹配不到。
    escaped = (
        prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    )
    try:
        rows = conn.execute(
            "SELECT id FROM sessions WHERE id LIKE ? ESCAPE '\\' "
            "ORDER BY COALESCE(started_at, 0) DESC LIMIT 5",
            (escaped + "%",),
        )
        return [r[0] for r in rows]
    except sqlite3.Error:
        return []


# ───────────────────────────── show ─────────────────────────────

_TOOL_RESULT_MAX = 1200   # 单条工具结果最多保留的字符
_ARG_MAX = 600            # 单条工具调用参数最多保留的字符


def _clip(text: str, limit: int) -> str:
    if text is None:
        return ""
    if len(text) <= limit:
        return text
    return text[:limit] + " …[截断，原长 %d 字符]" % len(text)


def _decode_tool_calls(raw: Any) -> List[Dict[str, str]]:
    """hermes 的 tool_calls 是 OpenAI 风格 JSON 数组文本。"""
    if not raw:
        return []
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
    except (ValueError, TypeError):
        return []
    if not isinstance(parsed, list):
        return []
    out = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        fn = item.get("function") or {}
        if not isinstance(fn, dict):
            continue
        name = fn.get("name") or item.get("name") or "?"
        arguments = fn.get("arguments")
        if not isinstance(arguments, str):
            arguments = json.dumps(arguments, ensure_ascii=False) if arguments is not None else ""
        out.append({"name": str(name), "arguments": _clip(arguments, _ARG_MAX)})
    return out


def _tool_content_text(raw: Any) -> str:
    """tool 行 content 通常是 {"output": ...} 这类 JSON；取可读文本。"""
    if raw is None:
        return ""
    if not isinstance(raw, str):
        return json.dumps(raw, ensure_ascii=False)
    s = raw.strip()
    if not s.startswith("{") and not s.startswith("["):
        return raw
    try:
        v = json.loads(s)
    except (ValueError, TypeError):
        return raw
    if isinstance(v, dict):
        for key in ("output", "content", "text", "result", "stdout", "message", "error"):
            if key in v and v[key] not in (None, ""):
                val = v[key]
                return val if isinstance(val, str) else json.dumps(val, ensure_ascii=False)
        return json.dumps(v, ensure_ascii=False)
    return json.dumps(v, ensure_ascii=False)


def cmd_show(dbs: List[Dict[str, str]], args: argparse.Namespace) -> Dict[str, Any]:
    # 跨库定位会话（先精确 id，再唯一前缀）
    target = _resolve_target(dbs, args.session_id)
    sid = target["sessionId"]
    profile = target["db"]["profile"]
    conn = _connect(target["db"]["path"])
    _require_tables(conn, ["sessions", "messages"])
    srow = conn.execute("SELECT * FROM sessions WHERE id = ?", (sid,)).fetchone()
    if srow is None:  # _resolve_target 命中过，这里只是防御
        conn.close()
        raise ReadError(
            "SESSION_NOT_FOUND",
            "找不到会话：%s" % args.session_id,
            "先用 hermes_sessions_list 找到准确的 sessionId。",
        )

    mcols = _table_columns(conn, "messages")
    pick = ["id", "role", "content", "tool_calls", "tool_name", "reasoning"]
    pick = [c for c in pick if c in mcols]

    where = ["session_id = ?"]
    params: List[Any] = [sid]
    # 默认只读活行（active=1）；压缩后留下的死行不喂给模型。
    if "active" in mcols:
        where.append("COALESCE(active, 1) = 1")
    if args.roles:
        roles = [r.strip() for r in args.roles.split(",") if r.strip()]
        bad = [r for r in roles if r not in FEEDABLE_ROLES]
        if bad:
            raise ReadError("BAD_ARGS", "未知角色：%s（可用 %s）" % (",".join(bad), ",".join(FEEDABLE_ROLES)))
        where.append("role IN (%s)" % ",".join("?" * len(roles)))
        params.extend(roles)
    else:
        where.append("role IN (%s)" % ",".join("?" * len(FEEDABLE_ROLES)))
        params.extend(FEEDABLE_ROLES)

    sql = "SELECT %s FROM messages WHERE %s ORDER BY id" % (", ".join(pick), " AND ".join(where))
    try:
        rows = list(conn.execute(sql, params))
    except sqlite3.Error as exc:
        raise ReadError("QUERY_FAILED", "查询 messages 失败：%s" % exc)

    total_rows = len(rows)
    nested = any(isinstance(r["content"], (list, dict)) for r in rows)

    # 取最近 N 条（长会话优先保留尾部，但保证第一条 user 消息在，用于理解任务起点）
    omitted_head = 0
    if args.max_msgs and len(rows) > args.max_msgs:
        keep_tail = rows[-args.max_msgs:]
        first_user = next((r for r in rows if r["role"] == "user"), None)
        if first_user is not None and all(r["id"] != first_user["id"] for r in keep_tail):
            rows = [first_user] + keep_tail
            omitted_head = total_rows - len(keep_tail) - 1
        else:
            rows = keep_tail
            omitted_head = total_rows - len(keep_tail)

    # 逐条组装，同时按字符预算从尾部截断
    built = []
    for r in rows:
        role = r["role"]
        entry: Dict[str, Any] = {
            "role": role,
            "time": _iso(_get(r, "time")),
        }
        if role == "tool":
            entry["toolName"] = _get(r, "tool_name")
            entry["text"] = _clip(_tool_content_text(_get(r, "content")), _TOOL_RESULT_MAX)
        else:
            entry["text"] = _clip(_get(r, "content") or "", args.max_chars)
            calls = _decode_tool_calls(_get(r, "tool_calls"))
            if calls:
                entry["toolCalls"] = calls
            if role == "assistant" and args.include_reasoning:
                reason = _clip(_get(r, "reasoning") or "", 800)
                if reason:
                    entry["reasoning"] = reason
        built.append(entry)

    # 字符预算：从尾部往前累计，超了就丢最老的
    budget = args.max_chars
    total_chars = sum(len(e.get("text") or "") for e in built)
    head_dropped = omitted_head
    if total_chars > budget:
        kept = []
        acc = 0
        for e in reversed(built):
            length = len(e.get("text") or "")
            if acc + length > budget and kept:
                break
            kept.append(e)
            acc += length
        kept.reverse()
        head_dropped += len(built) - len(kept)
        built = kept

    d = dict(srow)
    conn.close()
    return {
        "ok": True,
        "profile": profile,
        "session": {
            "sessionId": d.get("id"),
            "profile": profile,
            "title": d.get("title"),
            "source": d.get("source"),
            "model": d.get("model"),
            "cwd": d.get("cwd"),
            "startedAt": _iso(d.get("started_at")),
            "lastActivityAt": _iso(d.get("last_activity_at")),
            "messageCount": d.get("message_count"),
        },
        "messageRows": total_rows,
        "returned": len(built),
        "omittedHead": head_dropped,
        "truncated": head_dropped > 0,
        "contentIsStructured": nested,
        "messages": built,
    }


def _get(row: sqlite3.Row, key: str) -> Any:
    try:
        return row[key]
    except (IndexError, KeyError):
        return None


# ───────────────────────────── main ─────────────────────────────


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(prog="hermes-read", description="只读 Hermes Agent 会话库（支持多 profile）")
    # --db 直连一个库；--profile 限定 profile；都不给则扫全部库。
    p.add_argument("--db", default="", help="直连某个 state.db（默认扫描全部 profile 库）")
    p.add_argument("--profile", default="", help="限定 profile 名（default / geek / ngs / …）")
    sub = p.add_subparsers(dest="cmd", required=True)

    pl = sub.add_parser("list", help="列出会话")
    pl.add_argument("--limit", type=int, default=30)
    pl.add_argument("--query", default="")
    pl.add_argument("--include-archived", action="store_true")
    pl.add_argument("--include-hidden", action="store_true")
    pl.add_argument("--include-children", action="store_true")

    pg = sub.add_parser("get", help="单个会话元信息")
    pg.add_argument("session_id")

    ps = sub.add_parser("show", help="读取会话消息")
    ps.add_argument("session_id")
    ps.add_argument("--max-msgs", type=int, default=300)
    ps.add_argument("--max-chars", type=int, default=60000)
    ps.add_argument("--roles", default="")
    ps.add_argument("--include-reasoning", action="store_true")

    args = p.parse_args(argv)

    try:
        dbs = discover_dbs(args.db or None, args.profile or None)
        if args.cmd == "list":
            out = cmd_list(dbs, args)
        elif args.cmd == "get":
            out = cmd_get(dbs, args)
        elif args.cmd == "show":
            out = cmd_show(dbs, args)
        else:  # pragma: no cover
            raise ReadError("BAD_ARGS", "未知子命令")
    except ReadError as exc:
        json.dump(
            {"ok": False, "error": {"code": exc.code, "message": str(exc), "hint": exc.hint}},
            sys.stdout,
            ensure_ascii=False,
        )
        sys.stdout.write("\n")
        return 2
    except Exception as exc:  # 兜底：任何未预期异常也要给结构化输出
        json.dump(
            {"ok": False, "error": {"code": "UNEXPECTED", "message": "%s: %s" % (type(exc).__name__, exc)}},
            sys.stdout,
            ensure_ascii=False,
        )
        sys.stdout.write("\n")
        return 3

    json.dump(out, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
