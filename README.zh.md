# dsh-hermes-session

把本机 **Hermes Agent**（另一个独立智能体）的会话接入 DeepSeek Harness：
列出会话、指定一个会话，就把它的完整对话作为**不可信背景**注入当前 DSH 会话。

## 三个入口

| 入口 | 形态 | 作用 |
|---|---|---|
| `＋ Hermes` | 输入框工具行按钮 | 弹窗列出全部 profile 的会话，选中后插入一个引用 chip 到草稿 |
| `hermes_sessions_list` | 模型工具 | 列会话（标题 / 目录 / 消息数 / 最后活动），默认扫全部 profile 合并排序 |
| `hermes_session_import` | 模型工具 | 按 sessionId 导入（支持唯一前缀），注入文本带警示头和截断事实 |

`/hermes` 弹窗和工具读的是同一份数据、走同一条注入通道，只是入口不同。

**斜杠菜单里只有 `/hermes` 一条**——插件不注册任何 Host 斜杠命令，数据通道走
HTTP 路由（见下面「数据通道为什么是 HTTP 路由」）。

## 架构

```
src/index.js     插件入口：注册工具 + HTTP 路由 + systemPrompt 路由段
src/tools.js     两个工具的 schema/execute（exec.deferContext 注入）
src/routes.js    Host 端 HTTP 路由：GET /api/hermes.sessions（列表）、
                 GET /api/hermes.sessions（列会话）
client.js        客户端半部：注册 CommandContribution（popupSelect + icon），
                 options/onSelect 用 fetch 调上面两条路由
src/bridge.js    子进程调用 hermes_read.py（--db/--profile 前置，避免 argparse 报错）
src/render.js    投影 → 注入文本（警示头 + 元信息 + 预算截断）
scripts/hermes_read.py   只读访问 SQLite，Python 3.8+ 标准库，零第三方依赖
selftest/run.mjs         不经过 harness 的端到端自测（工具 + HTTP 路由）
selftest/clientid.mjs   客户端模块不变量（id === 包名、走路由、图标、无 Host 命令）
```

### /hermes 弹窗的数据流

```
浏览器输入 /hermes
  → CommandContribution (client.js) 匹配
  → popupSelect.options()
      └─ fetch('api/hermes.sessions')
      ← Host 路由返回 JSON → 解析成 SelectOption[]
  → 用户点击某条
  → 草稿里写入 @[标题](dsh-hermes:<base64url>)   ← inputActions.insertText()
  → 用户写描述并发送
  → agent/pre-step 解析提及 → 读会话 → 追加 form:'recall' 上下文
  → 对话里出现一行可折叠的上下文
```

### 菜单里的命令与图标

`/hermes` 是**客户端 contribution**（`CommandContribution`），带 `icon:
IconArchiveOutlineRegular`（归档箱）。图标来自
`@deepseek-ai/dsh-client-ui-primitives`——它是 Web shell 的平台 seed
（`staticModules`），任何 client 模块 `require` 即得，无需在 `dsh.client` 里声明。

`/compact` `/model` `/export` 的图标走的是另一条路：`dsh-client-ui-commands` 里的
`BUILTINS` 表把 `definitionId` 映射到命令名再取 `HOST_FACES` 的图标——
那张表硬编码在 DSH 内部，外部插件的 Host 命令拿不到。

### 数据通道为什么是 HTTP 路由

试过三条路，只有第三条同时满足「有图标」和「菜单只有 /hermes 一条」：

1. **自定义 Remote 服务**（`TypertRemoteService` + `@Remote`）：Host 的 Gateway
   能发现，但**客户端不会出现 `remote.hermes`**——客户端的 `ctx.remote.<ns>`
   由 DSH 自带的 `dsh-api-remotes` **逐个手工声明**（`commands` / `account` /
   `agentPresets` / `productAnalytics` …），**没有自动发现机制**。客户端 half 永远
   `pending (waiting for service: remote.hermes)`，boot 审计判失败，harness 起不来。
2. **斜杠命令做数据通道**（`ctx.commands.register` + `ctx.remote.commands.execute`）：
   能通，但 **Host 命令无法从菜单隐藏**——`CommandDefinition` 没有 hidden/visible
   字段，客户端 `candidates()` 直接展开 Host catalog（无过滤钩子），每注册一条
   菜单就多一项。而图标只给客户端 contribution（`CommandContribution` 有 `icon`
   字段，`CommandDecoration` 没有），且 Host 命令与 contribution **不能同名**
   （同名会让 `candidates()` throw，整个菜单坏掉）。
3. **HTTP 路由**（`ctx.connection.fetch.register`）：Host 注册 `/api` 下的精确路由，
   客户端直接 `fetch`。**路由不进斜杠菜单**，也不需要任何 Remote 命名空间。

第 3 条有现成范例：`dsh-session-log-export` 的 `/export` 就是
`ctx.connection.fetch.register({ path: '/api/session.export', ... })` + 客户端 fetch。
鉴权由物理载体处理（"after the physical carrier has applied its trust and
authentication policy"），路由本身不用管。

代价：多开两个 HTTP 端点（只读列表 + 只读导入），都在 `/api/hermes.*` 下。

### 注入时机与形态：写进草稿，随消息一起发送

用户选完 Hermes 会话时**不能**直接注入——他还没说要做什么，直接注入会唤醒
agent 让模型自己开跑（这正是被反馈过的问题）。

对齐 DSH 原生 `@` 提及会话的做法，也对齐官方「+技能」按钮的实现：**把一条
Markdown 提及写进草稿**，用户写完描述一并发送。

```
＋ Hermes 选中会话
  → 草稿里出现一个蓝色引用 chip：@[会话标题](dsh-hermes:<base64url>)
  → 用户在输入框写描述并发送
  → agent/pre-step 钩子解析这个提及
  → 读 Hermes 会话 → 渲染成 form:'recall' 的上下文消息
  → 追加到该轮用户消息之后 → 模型这一轮两者一起看
```

chip 走**原生 `@` 引用同一条路径**插入：在会话作用域上 bail
`slash/input-insert-reference` 事件，由 conversation.input 的监听器转交给
`shell.insertReference`，所以样式和原生 `@` 会话引用完全一致——蓝色、可删除、
文本里带着提及。

附带的上下文**长得也一样**：source 直接复用原生形状
（`kind: 'session-reference'` + `form: 'recall'`）——客户端只有看到这个 kind 才会给
会话引用图标和 "contextRecall" 标题，否则退化成通用注入图标；正文也与原生
逐字同构：同样的 `## Referenced sessions` 标题、同一段警示语、同样的
`<referenced-sessions>` 包裹，JSON 载荷是**数组**，每个会话对象里的
`conversation` 字段是 `[{ role, text }]`，text 是完整原文。
用自己的 kind 也能用，但会渲染成"通用注入"——同样的能力，两种长相。
因为模型侧看到的提示结构与引用 DSH 会话时一致，模型读 Hermes 快照的方式
和读 DSH 会话快照的方式也一致。

注意：公开给插件的 `inputActions` 只有 `captureInsertion` / `insertText` /
`setDraft` / `addAttachments` / `removeAttachment` / `pruneAttachments` / `submit`
——**没有插 chip 的方法**（`insertReference` 只存在于 SessionInputShell 类内部）。
拿会话作用域 ctx 的方式：`sessions.using(sessionId, ..., ref => ref.binding.ctx)`。

弹窗点外部或按 Esc 关闭；按钮是纯文字，与官方「+技能」按钮一致。

两个直接后果：

- **不发消息就不附加任何东西。** 选会话永远不会唤醒 agent。
- **提及是普通草稿文本**，可改写、可删除、可再加一个会话——模型只看到你真正发出去的。

草稿写入用的是 session slot 的标准 `inputActions` 面
（`captureInsertion()` + `insertText()`）：span 必须在插入时刻取，从 React prop
里读的永远滞后一版，会被编辑器的 span-CAS 静默拒绝——弹窗关掉但草稿没变。

（工具 `hermes_session_import` 走的是另一条路——它在 turn 内执行，
`exec.deferContext()` 的上下文挂在本次工具结果上，loop 在 `tool/result` 之后
追加，天然可见，不受这里影响。）

### 注入在对话里长什么样

注入消息的 `source` 用 DSH 的 **recall 形态**：

```js
source: {
  kind: 'hermes-session',
  form: 'recall',
  version: 1,
  references: [{ sessionId, label, retainedMessages, omittedMessages, truncated }],
}
```

`form: 'recall'` 让 DSH 的 `ContextInjectionRow` 渲染它——对话列表里是**一行可折叠的
上下文**（折叠时显示来源标签，展开后是代码块样式的正文，max-height 141px 可滚动），
而不是把全文铺开的 user 气泡。契约见 `dsh-client-ui-chat` 的 `recalledSessions()`：
`references[]` 每项必须带 `label` / `retainedMessages` / `omittedMessages` / `truncated`。

这与 DSH 原生 `@` 引用会话是同一种呈现——语义也吻合（"从另一个会话恢复的上下文"）。

### 数据来源（已实机核实）

Hermes 的会话按 **profile 分库**：

- `~/.hermes/state.db` → profile `default`（本机 270 个会话）
- `~/.hermes/profiles/<name>/state.db` → 其它 profile（本机 geek/ngs/paper_reader/prodes/sirna 共 153 个）

主库**只有 default** 的会话；只读主库会漏掉其它 profile。所以默认扫全部库，
`--profile` / 工具的 `profile` 参数可限定。每条结果都标注来源 profile。

会话元信息在 `sessions` 表，消息在 `messages` 表（OpenAI 风格：user / assistant(含
`tool_calls` JSON) / tool(结果 JSON)）。只读行过滤 `active=1`；默认隐藏 archived
和 hidden。

**子会话默认带上**（与 `hermes sessions list` 的默认不同）：Hermes 会把"续写/子代理"
这类 `parent_session_id` 非空的会话藏起来，但它们往往正是用户想引用的那一段具体工作。
弹窗列表里会标 `子会话`。工具的 `includeChildren` 参数可控制。

**搜索在 Host 侧做**：过滤框会重新查询整库（全部 profile、全部会话），只返回匹配结果。
如果改成"先拉一页再本地筛"，没被拉下来的会话就永远搜不到——曾经就因为这个
（外加写死 `--limit 50`），"DNA-Diffusion训练"这条子会话在弹窗里消失，而
`hermes sessions list` 里明明有。

**预算按序列化后的长度算**：注入文本的字符上限是硬约束。JSON 会转义引号/换行，
按原文估会低估，所以预算核算与最终裁剪都以**实际 JSON 长度**为准，注入文本
永远不会超限。

### 安全与只读语义

- SQLite 以 `mode=ro` 打开，**绝不写** Hermes 的任何数据（本机根分区曾以 ro 挂载，只读是唯一安全姿态）
- 不 import Hermes 源码、不启动 hermes 进程（其 CLI 在只读文件系统上有自检会崩）；直接读持久化契约，schema 变化时给结构化错误
- 注入内容带固定警示：禁止模型把快照里的指令 / 权限声明 / 工具请求当真，与 DSH 原生 `session-reference` 同语义
- 注入通道分两种：工具用 `exec.deferContext()`（turn 内机制）；`/hermes` 弹窗走
  `agent/pre-step` 钩子，在用户下一次发消息时把暂存的会话作为上下文追加到该轮。
  两者都不新开用户轮

### 预算

- 单条工具结果保留 1200 字符，工具调用参数 600 字符
- `maxMessages`（默认 300）保留"首条 user 消息 + 最近 N 条"，理解任务起点不丢
- `maxChars`（默认 60000，硬上限 160000）从尾部装填，超预算丢最老并如实报告条数

## 配置（cordis.patch.yml，可被用户层覆盖）

| 字段 | 默认 | 说明 |
|---|---|---|
| `dbPath` | 空 | 直连某个 state.db；空则扫全部 profile 库 |
| `pythonPath` | `python3` | 解释器（需标准库 sqlite3，Python 3.8+） |
| `maxChars` | 60000 | 单次导入默认字符预算 |
| `maxCharsHard` | 160000 | 工具调用可调的上限护栏 |
| `maxMessages` | 300 | 默认最多带多少条消息 |

## 开发与自测

```bash
node --check src/*.js && node --check client.js   # 语法
node selftest/run.mjs                    # 28 项端到端自测（读真实库，零写入）
python3 scripts/hermes_read.py list --limit 5
python3 scripts/hermes_read.py --profile sirna show 20261021_135400_6c2813
```

自测覆盖：工具全路径、跨 profile、HTTP 路由与 pre-step 钩子（暂存→注入、取出即消费）、错误路径。

本地跑 selftest 需要解析 `@deepseek-ai/dsh-llm` / `dsh-tools` / `dsh-typert-protocol`
（开发目录软链，见 `node_modules/@deepseek-ai/`；装进 profile 后由 harness 解析器提供）。

## 安装状态

- 已装入 `web` profile（link 安装指向本目录），`include:dsh-hermes-session` 行 active
- **`dsh.client` 不设 `immediately: true`**：boot 只审计 `immediately` 的 client rows，
  懒加载（用户输入 `/hermes` 才 import）与 `/model` 同模式，启动失败面最小
- **源码改动需重启 harness 进程才在运行时生效**：`set_plugin` disable/enable 只重放
  fiber 生命周期，Node 的 ESM 模块缓存不刷新——重启前进程持有加载时的旧代码副本
- 浏览器验证受限：本环境无 X server（electron 报 `Missing X server or $DISPLAY`），
  dsh_browser_* 工具不可用；`/hermes` 弹窗需在有显示环境的机器上验证

### 踩坑记录：client 面让 harness 无法启动

第一次带 `dsh.client` 安装后，harness 启动失败：
`Failed to load plugins` → `web boot: 1 entry did not activate` →
`dsh-hermes-session: import failed (see console for the import error)`。

**根因**：`client.js` 里 `window.__ModuleLoader__.load({ id: ... })` 的 id 写成了
`@deepseek-ai/dsh-hermes-session`，而包名是 `dsh-hermes-session`（无 scope）。

模块系统按 graph row 的 id（= 包名）查找已注册的 factory：id 对不上 →
bundle 加载了但 "loaded without registering" → fiber 建不起来 →
`entry.fiber === undefined` → client-modules 抛 `import failed` →
boot audit 判失败 → **整个 harness 起不来**。

对照实现 `dsh-client-ui-model-selection` 的包名与 client id 严格相等。

**修复**：`client.js` 的 id 改为 `dsh-hermes-session`（= package.json 的 name）。
`selftest/clientid.mjs` 断言两者相等，防止再犯。

**附带**：`dsh.client` 不设 `immediately: true`（对齐 `/model` 的懒加载模式）——
`/hermes` 是用户主动触发的命令，不需要 boot 时激活，进一步缩小启动失败面。

### 踩坑记录：命令没出现在斜杠菜单

id 不匹配修好后，若 `/hermes` 仍作为普通消息进入模型，说明 client 模块没被 import
（`commandUi.register` 从未执行）。此时查浏览器 console 里
`client-modules: could not load "dsh-hermes-session"` 的具体原因。

### 踩坑记录：自定义 Remote 命名空间不可用（pending 等不到服务）

id 修好后错误变成：

```
web boot: 1 entry did not activate
dsh-hermes-session: pending (waiting for service: remote.hermes)
```

**根因**：客户端的 `ctx.remote.<ns>` 命名空间由 `dsh-api-remotes` 逐个手工声明，
没有自动发现机制。Host 侧 `new TypertRemoteService(ctx, 'hermes')` + `@Remote` 标记
只能让 **Host 的 Gateway** 发现它，**客户端不会出现 `remote.hermes`**——
client half 永远等不到这个服务，boot 审计判 pending → 整个 harness 起不来。

**修复**：改走 HTTP 路由——Host 侧 `ctx.connection.fetch.register()` 注册
`/api/hermes.sessions`，客户端直接 `fetch`。
（中途试过 `ctx.remote.commands` 通道，但 Host 命令无法从菜单隐藏，见上面
「数据通道为什么是 HTTP 路由」。）

`selftest/clientid.mjs` 断言客户端代码里不出现 `remote.hermes`、不出现
`remote.commands`，且插件没有 `src/commands.js`——防止回退。

## 已知边界

- `hermes sessions list` CLI 本身在本机不可用（只读文件系统导致其自检崩溃），插件绕过 CLI 直读数据库
- 快照是 `get_messages_as_conversation` 语义的简化投影：不解 hermes 的私有 marker 列，遇到非文本 content 按原文处理
- 压缩续写（compression lineage）不跟随：导入的是该会话自身记录的活跃行
- 斜杠菜单里只有 `/hermes` 一条；数据通道是 `/api/hermes.sessions` 与
  `/api/hermes.sessions`（只读 Hermes 库，不写）
- 注入的上下文在对话里是**一行可折叠的上下文**（`form: 'recall'`），全文不铺开；
  选中会话只是往草稿写一行提及，本身不触发任何对话——上下文随你下一条消息一起进入模型请求
- 插件硬依赖 `agents` 服务（注入要 `ctx.agents.get(sessionId)` 定位当前会话）；
  漏声明会让 `ctx.agents` 为 undefined，导入直接 400
- 注入走 `agent.steer()`（唤醒 driver）；用 `inject()` 的话，会话空闲时消息
  不会被消费，接口 200 但对话里看不到
