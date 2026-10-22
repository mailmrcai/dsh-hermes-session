/**
 * 客户端半部：/hermes 交互式会话选择器。
 *
 * 用 commandUi.register() 注册一个**客户端 contribution**（CommandContribution）——
 * 只有 contribution 支持 icon 字段，菜单里那些图标（/compact /model /export）就是这么来的。
 *
 * 数据通道走 **Host 的 HTTP 路由**（fetch），不用斜杠命令：
 * 斜杠命令无法从菜单隐藏（CommandDefinition 没有 hidden 字段，客户端 candidates()
 * 直接展开 Host catalog），所以插件不注册任何 Host 命令——菜单里只有 /hermes 一条。
 * 也不用 ctx.remote.hermes：客户端的 ctx.remote.<ns> 由 DSH 自带的 dsh-api-remotes
 * 逐个手工声明，插件自建的 TypertRemoteService 不会让客户端出现该命名空间。
 *
 * id 必须与 package.json 的 name 严格相等：模块系统按 graph row 的 id
 * （= 包名）查找已注册的 factory，不一致就报 "loaded without registering"，
 * fiber 建不起来 → "import failed"。
 */
window.__ModuleLoader__.load({
  id: 'dsh-hermes-session',
  factory(require) {
    /** 必需服务：命令贡献注册表。 */
    const inject = ['commandUi']

    // 图标：ui-primitives 是 Web shell 的平台 seed（staticModules），任何 client
    // 模块都能 require 到，无需在 dsh.client 里声明依赖。
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const HERMES_ICON = primitives.IconArchiveOutlineRegular

    /** Host 路由（document-relative，与 dsh-session-log-export 的做法一致）。 */
    const LIST_ROUTE = 'api/hermes.sessions'
    const SELECT_ROUTE = 'api/hermes.select'

    /** 会话一条 → 弹窗一行。badge 显示 profile，detail 显示消息数和时间。 */
    function toOption(session) {
      const parts = []
      if (session.messageCount != null) parts.push(`${session.messageCount} 条`)
      if (session.lastActivityAt) parts.push(session.lastActivityAt)
      if (session.cwd) parts.push(session.cwd)
      return {
        id: session.sessionId,
        label: session.title || session.sessionId,
        badge: session.profile,
        detail: parts.join(' · '),
      }
    }

    /**
     * 调一条 Host 路由，解析 JSON。
     * @param {string} route document-relative 路由
     * @param {object} [init] fetch init
     * @returns {Promise<object>} 响应 JSON
     */
    async function callHost(route, init) {
      const response = await fetch(route, init)
      // 先读文本再解析：JSON 解析失败时把原始响应体带进错误信息，
      // 否则只能看到"非 JSON 响应"，无从判断是谁返回的。
      const raw = await response.text()
      let payload = null
      if (raw) {
        try {
          payload = JSON.parse(raw)
        } catch {
          const preview = raw.slice(0, 300)
          throw new Error(
            `Host 返回了非 JSON 响应（HTTP ${response.status}）：${preview}`,
          )
        }
      }
      if (!response.ok || (payload && payload.error)) {
        throw new Error(
          (payload && payload.error) || `Host 返回 HTTP ${response.status}：${raw.slice(0, 300)}`,
        )
      }
      return payload
    }

    /**
     * 客户端插件体：注册 /hermes popupSelect 贡献。
     * @param {object} ctx 客户端根 context
     */
    function apply(ctx) {
      ctx.inject(['commandUi'], (scope) => {
        const command = scope.get('commandUi')

        scope.effect(() => command.register({
          name: 'hermes',
          label: () => 'Hermes 会话',
          description: () => '导入 Hermes Agent 的会话到当前上下文',
          icon: HERMES_ICON,
          available: () => true,
          ui: {
            kind: 'popupSelect',
            options: async () => {
              const payload = await callHost(LIST_ROUTE)
              const sessions = Array.isArray(payload.sessions) ? payload.sessions : []
              return sessions.map(toOption)
            },
            onSelect: async (option, session) => {
              // 只暂存，不注入。Host 侧在用户下一次发消息时（agent/pre-step）
              // 才把选中的 Hermes 会话作为上下文挂到那一轮——这样用户可以先
              // 选会话、再写描述，一次发送里两者一起处理。
              await callHost(SELECT_ROUTE, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  sessionId: option.id,
                  dshSessionId: session.sessionId,
                }),
              })
            },
          },
        }), 'dsh-hermes-session: /hermes contribution')
      })
    }

    return { inject, apply }
  },
})
