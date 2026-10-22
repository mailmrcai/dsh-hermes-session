/**
 * Host 端 HTTP 路由：客户端 /hermes 弹窗的数据通道。
 *
 * 为什么走 HTTP 路由而不是斜杠命令：
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
 * 这条路有现成范例：dsh-session-log-export 的 /export 就是
 * "ctx.connection.fetch.register({path:'/api/session.export', ...})" + 客户端 fetch。
 * 鉴权由物理载体处理（"after the physical carrier has applied its trust and
 * authentication policy"），路由本身不用管。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { runHermesRead, HermesReadError } from './bridge.js'
import { renderProjection } from './render.js'

/** 会话列表路由（GET）。 */
export const LIST_ROUTE = '/api/hermes.sessions'
/** 导入路由（POST，body 是 { sessionId }）。 */
export const IMPORT_ROUTE = '/api/hermes.import'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

/**
 * 注册两条路由。
 * @param {object} ctx Cordis 上下文（需要 connection 服务）
 * @param {object} cfg 插件配置
 * @returns {() => Promise<void>} 注销两个路由
 */
export function registerRoutes(ctx, cfg) {
  const fetch = ctx.connection?.fetch
  if (!fetch) {
    ctx.logger?.warn?.('dsh-hermes-session: connection.fetch 不可用，/hermes 弹窗无法使用')
    return () => Promise.resolve()
  }

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
      path: IMPORT_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let sessionId = ''
        try {
          const payload = await request.json()
          sessionId = String(payload?.sessionId || '').trim()
        } catch (error) {
          ctx.logger?.warn?.(
            `dsh-hermes-session: 导入路由收到非 JSON 请求体：${String(error)}`,
          )
          return json({ error: '请求体不是合法 JSON' }, 400)
        }
        if (!sessionId) {
          return json({ error: 'sessionId 不能为空' }, 400)
        }

        const maxChars = cfg.maxChars
        const argv = [
          'show', sessionId,
          '--max-msgs', String(cfg.maxMessages),
          '--max-chars', String(maxChars),
        ]

        let projection
        try {
          projection = await runHermesRead(argv, {
            dbPath: cfg.dbPath,
            pythonPath: cfg.pythonPath,
          })
        } catch (error) {
          return json({ error: failureText(error) }, 500)
        }

        const rendered = renderProjection(projection, { maxChars })
        if (!rendered.text) {
          return json({ error: `会话 ${sessionId} 没有可导入的对话内容（可能是空会话）。` }, 400)
        }

        // 注入当前轮：agent.inject 把快照放进 inbox 的 next-step，
        // 当前轮下一个 step boundary 模型就能看到，不开新用户轮。
        // agent 由客户端通过 ?sessionId= 传进来。
        const agentId = new URL(request.url).searchParams.get('sessionId')
        if (!agentId) {
          return json({ error: '缺少 sessionId 查询参数（无法定位要注入的会话）' }, 400)
        }
        const agent = ctx.agents?.get(agentId)
        if (!agent) {
          // ctx.agents 未注入（插件没声明 agents 依赖）或会话不活跃。
          const hasAgents = typeof ctx.agents?.get === 'function'
          ctx.logger?.warn?.(
            `dsh-hermes-session: 导入路由找不到会话 ${agentId}`
            + `（agents 服务可用：${hasAgents}）`,
          )
          return json({
            error: hasAgents
              ? `会话 ${agentId} 当前不活跃，无法注入（请在活跃会话中重试）`
              : `插件未获得 agents 服务，无法定位会话 ${agentId}`,
          }, 400)
        }

        // source 用 DSH 的 recall 形态 → 对话列表里渲染成一行可折叠的上下文，
        // 而不是把全文铺开。契约见 dsh-client-ui-chat 的 recalledSessions()。
        //
        // 用 steer 而不是 inject：inject 是 send(input,'next-step',wakeup=false)
        // ——**不唤醒 driver**。本路由由浏览器直接 POST，在 turn 之外执行，
        // agent 空闲时注入的消息会静静躺在 inbox 的 next-step 队列里，
        // 没有 turn 去 claim 它 → 请求 200 但对话里看不到任何东西。
        // steer 是同样的 next-step 语义，但 wakeup=true：会开一个新 turn，
        // 消息在那一轮被消费，模型随之看到注入的上下文。
        const message = createUserMessage({
          content: [{ type: 'text', text: rendered.text }],
          source: rendered.source,
        })
        if (typeof agent.steer === 'function') {
          agent.steer(message)
        } else {
          // 老版本没有 steer，退回 inject（此时需会话已有在跑的 turn 才可见）。
          agent.inject(message)
        }

        const s = projection.session || {}
        const st = rendered.stats
        ctx.logger?.info?.(
          `dsh-hermes-session: 已注入 ${s.sessionId || sessionId}`
          + `（${st.includedMessages} 条，${st.chars} 字符）到 ${agentId}`,
        )
        return json({
          ok: true,
          sessionId: s.sessionId || sessionId,
          title: s.title || '',
          profile: s.profile || projection.profile || 'default',
          includedMessages: st.includedMessages,
          chars: st.chars,
          budget: st.budget,
          truncatedHead: st.truncatedHead,
          droppedForBudget: st.droppedForBudget,
        })
      },
    }),
  ]

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
