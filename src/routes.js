/**
 * Host 端 HTTP 路由 + pre-step 钩子：Hermes 会话注入通道。
 *
 * ## 为什么走 HTTP 路由而不是斜杠命令
 * DSH 的斜杠命令（ctx.commands.register）**无法从菜单隐藏**——CommandDefinition
 * 没有 hidden/visible 字段，客户端 candidates() 直接展开 Host catalog（无过滤钩子），
 * 每注册一条命令，菜单里就多一项。而客户端的 `ctx.remote.<ns>` 命名空间又由 DSH
 * 自带的 dsh-api-remotes 逐个手工声明，插件自建的 TypertRemoteService 不会让
 * 客户端出现 `remote.hermes`。
 *
 * 于是剩下这条路：Host 用 ctx.connection.fetch.register() 注册一条 /api 下的
 * 精确路由，客户端直接 fetch。路由**不进斜杠菜单**。
 *
 * 范例：dsh-session-log-export 的 /export 就是
 * "ctx.connection.fetch.register({path:'/api/session.export', ...})" + 客户端 fetch。
 * 鉴权由物理载体处理，路由本身不用管。
 *
 * ## 注入时机与形态：对齐原生 @ 提及会话
 * 用户在输入框选一个 Hermes 会话（客户端把 `@[标题](dsh-hermes:<base64url>)`
 * 写进草稿）→ 写描述 → 发送 → **agent/pre-step 钩子**解析用户消息里的提及 →
 * 读 Hermes 会话 → 渲染成 form:'recall' 的上下文消息 → 追加到用户消息**之后**。
 *
 * 模型这一轮同时看到用户的描述和会话内容；对话列表里上下文渲染成一行可折叠的行。
 *
 * 关键是**不要在用户选中时就注入**：那会唤醒 agent 让模型自己开跑（用户反馈过
 * 这个问题）。挂 pre-step 是原生 `@` 提及会话的做法，语义一致。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { runHermesRead, HermesReadError } from './bridge.js'
import { renderProjection } from './render.js'

/** 会话列表路由（GET）。 */
export const LIST_ROUTE = '/api/hermes.sessions'

/** 提及 scheme：与官方 dsh-session: 平行。 */
export const MENTION_SCHEME = 'dsh-hermes:'

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
    ctx.logger?.warn?.('dsh-hermes-session: connection.fetch 不可用，会话选择器无法使用')
    return () => Promise.resolve()
  }

  const disposers = [
    fetch.register({
      path: LIST_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          // 查询词从 URL 上取，让过滤发生在 **Host 侧**（423 个会话全量过滤），
          // 而不是客户端先拉一小截再在本地筛——后者永远筛不到没被拉下来的会话。
          const url = new URL(request.url)
          const query = (url.searchParams.get('query') || '').trim()
          // 子会话（压缩续写 / 子代理）默认被 hermes_read.py 过滤掉，但它们往往
          // 正是用户想引用的那一段（父会话是主线，子会话是具体任务）。默认带上。
          const includeChildren = url.searchParams.get('children') !== '0'
          const limit = clampLimit(url.searchParams.get('limit'), 500, 1, 2000)

          const argv = ['list', '--limit', String(limit)]
          if (query) argv.push('--query', query)
          if (includeChildren) argv.push('--include-children')

          const result = await runHermesRead(argv, {
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
            parentSessionId: s.parentSessionId || '',
          }))
          return json({
            sessions,
            totalSessions: result.totalSessions ?? sessions.length,
            matched: sessions.length,
            query,
          })
        } catch (error) {
          return json({ error: failureText(error) }, 500)
        }
      },
    }),
  ]

  // pre-step：用户消息里的 Hermes 提及 → 追加会话上下文。
  const onPreStep = async ({ agent, messages, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision

    // 逐条消息处理：**上下文紧跟在引用它的那条消息之后**（原生 prepareDirectMessages
    // 就是这么排的：每条带提及的消息 → [规范化后的直消息, 该消息的上下文]）。
    // 全部堆到末尾会让"提到 A 的问题"和"A 的材料"在多条消息时错位。
    const out = []
    let contextCount = 0
    for (const message of decision.messages) {
      const parsed = parseMentions(message)
      if (parsed.references.length === 0) {
        out.push(message)
        continue
      }
      out.push(parsed.message)
      for (const reference of parsed.references) {
        const context = await buildContext(cfg, reference, signal)
        if (!context) continue
        out.push(context)
        contextCount++
      }
    }
    if (contextCount === 0) return decision

    ctx.logger?.info?.(
      `dsh-hermes-session: 已把 ${contextCount} 个 Hermes 会话附加到 ${agent.id} 的本轮消息`,
    )

    // 用户消息在前（提及已规范化为 @标签），会话上下文紧随其后。
    // 注意要把 parseMentions 规范化过的消息写回——原生也是把
    // `@[标签](dsh-session:...)` 换成 `@标签`（保留可见引用，去掉 URI）。
    return {
      ...decision,
      messages: out,
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
  }
}

/**
 * 解析一条消息里的 Hermes 提及。
 *
 * 与原生 dsh-session: 提及同构：`@[标签](dsh-hermes:<base64url>)` 或裸 URI。
 * 提及被替换成 `@标签`——保留可见引用，去掉 URI。
 *
 * @param {object} message user 消息
 * @returns {{message: object, references: Array<{sessionId: string, label: string}>}}
 */
export function parseMentions(message) {
  const references = []
  if (!message || !Array.isArray(message.content)) return { message, references }
  if (message.source?.kind !== 'user') return { message, references }

  // 两个捕获组：1=标签，2=URI。markdown 分支的 URI 必须自己加括号捕获，
  // 否则它只是"非捕获"的一部分，而裸 URI 分支不参与匹配时该组是 undefined。
  const pattern = new RegExp(
    `@\\[((?:\\\\.|[^\\\\\\]])*)\\]\\((${MENTION_SCHEME}[^\\s)]*)\\)|(${MENTION_SCHEME}[A-Za-z0-9_-]+)`,
    'gu',
  )

  const content = message.content.map((block) => {
    if (block.type !== 'text') return block
    // replace 的回调尾部还有 offset 与整个匹配串，不是捕获组——别把第三个
    // 参数当 URI。
    const text = block.text.replace(pattern, (_match, rawLabel, markdownUri, bareUri) => {
      const uri = markdownUri ?? bareUri
      if (typeof uri !== 'string') return _match
      const sessionId = decodeMentionUri(uri)
      if (sessionId === undefined) return _match
      const label = rawLabel === undefined ? sessionId : unescapeLabel(rawLabel)
      references.push({ sessionId, label })
      return `@${label}`
    })
    return { ...block, text }
  })

  return { message: { ...message, content }, references }
}

/** 解码提及 URI → 会话 id；不合法返回 undefined。 */
function decodeMentionUri(uri) {
  if (!uri.startsWith(MENTION_SCHEME)) return undefined
  const payload = uri.slice(MENTION_SCHEME.length)
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return undefined
  try {
    const json = decodeURIComponent(escape(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))))
    const value = JSON.parse(json)
    return typeof value === 'string' && value ? value : undefined
  } catch {
    return undefined
  }
}

function unescapeLabel(label) {
  return label.replace(/\\(.)/gu, '$1')
}

/**
 * 读一个 Hermes 会话并渲染成上下文消息。
 * @param {object} cfg 插件配置
 * @param {{sessionId: string, label: string}} reference 提及
 * @param {AbortSignal} signal 取消信号
 * @returns {Promise<object|null>} 上下文消息；读取失败返回 null
 */
async function buildContext(cfg, reference, signal) {
  let projection
  try {
    projection = await runHermesRead(
      [
        'show', reference.sessionId,
        '--max-msgs', String(cfg.maxMessages),
        '--max-chars', String(cfg.maxChars),
      ],
      { dbPath: cfg.dbPath, pythonPath: cfg.pythonPath, signal },
    )
  } catch (error) {
    // 读不到就跳过：不能因为一个坏会话让整条用户消息发不出去。
    return null
  }

  const rendered = renderProjection(projection, { maxChars: cfg.maxChars })
  if (!rendered.text) return null

  // form:'recall' → 客户端渲染成一行可折叠的上下文，而不是铺开全文。
  return createUserMessage({
    content: [{ type: 'text', text: rendered.text }],
    source: rendered.source,
  })
}

/**
 * 把请求参数里的 limit 夹到 [min, max]。缺省或非法值退回 fallback。
 *
 * 注意 `Number(null)` 是 0（有限数！），所以"参数缺失"必须显式判空——
 * 否则缺省会静默变成 min=1，列表只剩一条。
 */
function clampLimit(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
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
