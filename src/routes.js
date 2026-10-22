/**
 * Host 端 HTTP 路由 + pre-step 钩子：客户端 /hermes 弹窗的数据通道。
 *
 * ## 为什么走 HTTP 路由而不是斜杠命令
 * DSH 的斜杠命令（ctx.commands.register）**无法从菜单隐藏**——CommandDefinition
 * 没有 hidden/visible 字段，客户端 candidates() 直接展开 Host catalog（无过滤钩子），
 * 每注册一条命令，菜单里就多一项。而客户端的 `ctx.remote.<ns>` 命名空间又由 DSH
 * 自带的 dsh-api-remotes 逐个手工声明，插件自建的 TypertRemoteService 不会让
 * 客户端出现 `remote.hermes`。
 *
 * 于是剩下这条路：Host 用 ctx.connection.fetch.register() 注册一条 /api 下的
 * 精确路由，客户端直接 fetch。路由**不进斜杠菜单**，客户端的 /hermes contribution
 * 是菜单里唯一的条目（还能带图标）。
 *
 * 范例：dsh-session-log-export 的 /export 就是
 * "ctx.connection.fetch.register({path:'/api/session.export', ...})" + 客户端 fetch。
 * 鉴权由物理载体处理，路由本身不用管。
 *
 * ## 为什么注入要挂在 pre-step，而不是选中即注入
 * 选中会话时**不能**直接注入：用户还没说要做什么，直接注入会唤醒 agent 让模型
 * 自己开跑（用户明确反馈过这个问题）。
 *
 * DSH 原生的 `@` 提及会话走的就是这个模式：用户写完消息发送 → agent/pre-step
 * 钩子解析提及 → 读会话 → 在用户消息**后面**追加上下文消息 → 模型这一轮同时看到
 * 用户的描述和会话内容。
 *
 * 这里照搬：客户端选会话时只**暂存**（POST /api/hermes.import 只写暂存区），
 * 用户随后在输入框写描述并发送 → pre-step 钩子取出暂存 → 读 Hermes 会话 →
 * 渲染成 form:'recall' 的上下文消息 → 追加到用户消息之后。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { runHermesRead, HermesReadError } from './bridge.js'
import { renderProjection } from './render.js'

/** 会话列表路由（GET）。 */
export const LIST_ROUTE = '/api/hermes.sessions'
/** 暂存选中的会话（POST，body 是 { sessionId, dshSessionId }）。 */
export const SELECT_ROUTE = '/api/hermes.select'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

/**
 * 注册路由与 pre-step 钩子。
 * @param {object} ctx Cordis 上下文（需要 connection 服务）
 * @param {object} cfg 插件配置
 * @returns {() => Promise<void>} 注销路由
 */
export function registerRoutes(ctx, cfg) {
  const fetch = ctx.connection?.fetch
  if (!fetch) {
    ctx.logger?.warn?.('dsh-hermes-session: connection.fetch 不可用，/hermes 弹窗无法使用')
    return () => Promise.resolve()
  }

  // 每个 DSH 会话一份暂存：agentId → 选中的 Hermes 会话 id。
  // 选中只是记账，注入要等用户下一次发消息。
  const pending = new Map()

  const disposers = [
    fetch.register({
      path: LIST_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          const result = await runHermesRead(['list', '--limit', '50'], {
            dbPath: cfg.dbPath,
            pythonPath: cfg.pythonPath,
          })
          const sessions = (Array.isArray(result.sessions) ? result.sessions : []).map((s) => ({
            sessionId: s.sessionId,
            title: s.title || '',
            profile: s.profile || 'default',
            messageCount: s.messageCount ?? 0,
            cwd: s.cwd || '',
            lastActivityAt: s.lastActivityAt || s.startedAt || '',
          }))
          return json({ sessions })
        } catch (error) {
          return json({ error: failureText(error) }, 500)
        }
      },
    }),
    fetch.register({
      path: SELECT_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let payload = {}
        try {
          payload = await request.json()
        } catch (error) {
          ctx.logger?.warn?.(
            `dsh-hermes-session: 选择路由收到非 JSON 请求体：${String(error)}`,
          )
          return json({ error: '请求体不是合法 JSON' }, 400)
        }
        const hermesSessionId = String(payload?.sessionId || '').trim()
        const dshSessionId = String(payload?.dshSessionId || '').trim()
        if (!hermesSessionId) {
          return json({ error: 'sessionId 不能为空' }, 400)
        }
        if (!dshSessionId) {
          return json({ error: '缺少 dshSessionId（无法定位要附加到哪个会话）' }, 400)
        }

        // 只暂存，不注入——注入发生在用户下一次发消息时（pre-step 钩子）。
        pending.set(dshSessionId, { hermesSessionId, at: Date.now() })
        ctx.logger?.info?.(
          `dsh-hermes-session: 已暂存 ${hermesSessionId}，等待用户在 ${dshSessionId} 中发送消息`,
        )
        return json({ ok: true, pending: true, hermesSessionId })
      },
    }),
  ]

  // pre-step：用户发消息时，把暂存的 Hermes 会话作为上下文追加到该轮。
  const onPreStep = async ({ agent, messages, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision

    const selected = pending.get(agent.id)
    if (!selected) return decision

    // 取出即消费：一次选择只服务于下一次发送。
    pending.delete(agent.id)

    let projection
    try {
      projection = await runHermesRead(
        ['show', selected.hermesSessionId, '--max-msgs', String(cfg.maxMessages), '--max-chars', String(cfg.maxChars)],
        { dbPath: cfg.dbPath, pythonPath: cfg.pythonPath, signal },
      )
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-hermes-session: 读取暂存会话 ${selected.hermesSessionId} 失败：${failureText(error)}`,
      )
      return decision
    }

    const rendered = renderProjection(projection, { maxChars: cfg.maxChars })
    if (!rendered.text) return decision

    // form:'recall' → 客户端渲染成一行可折叠的上下文，而不是铺开全文。
    const context = createUserMessage({
      content: [{ type: 'text', text: rendered.text }],
      source: rendered.source,
    })

    ctx.logger?.info?.(
      `dsh-hermes-session: 已把 ${projection.session?.sessionId || selected.hermesSessionId}`
      + ` 附加到 ${agent.id} 的本轮消息（${rendered.stats.includedMessages} 条）`,
    )

    return {
      ...decision,
      messages: [...decision.messages, context],
    }
  }

  ctx.on('agent/pre-step', onPreStep, { prepend: true })

  return async () => {
    for (const dispose of disposers) {
      try {
        await dispose()
      } catch {
        /* 卸载期的错误不阻断其它清理 */
      }
    }
    pending.clear()
  }
}

/** 把 HermesReadError / 通用 Error 变成人类可读的失败文案。 */
function failureText(error) {
  if (error instanceof HermesReadError) {
    return [
      `失败（${error.code}）：${error.message}`,
      error.hint ? `提示：${error.hint}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }
  return `失败：${error instanceof Error ? error.message : String(error)}`
}
