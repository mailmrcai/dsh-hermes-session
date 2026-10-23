/**
 * 客户端半部：Hermes 会话选择器。
 *
 * 交互对齐官方「+技能」按钮（@weibaohui/skills-management 的做法）：
 *   1. 在输入框工具行（conversation.input.left）放一个按钮
 *   2. 点开一个可搜索的会话列表
 *   3. 选中后把一条 **Markdown 提及** 插入草稿：`@[标题](dsh-hermes:<base64url>)`
 *      —— 用 session slot 的标准 inputActions 面写入（captureInsertion() +
 *      insertText()），这样草稿里可见、可编辑、可删除
 *   4. 用户写完描述一并发送；Host 侧 agent/pre-step 钩子解析该提及，
 *      读 Hermes 会话并把内容作为上下文追加到那一轮
 *
 * 为什么不直接注入：直接注入会在用户还没说明目的时就唤醒 agent 让模型自己开跑。
 * 插入草稿把「选上下文」和「说诉求」拆成两步，一次发送里两者一起处理。
 *
 * 数据通道走 HTTP 路由（不是斜杠命令）：斜杠命令无法从菜单隐藏——CommandDefinition
 * 没有 hidden/visible 字段，客户端 candidates() 直接展开 Host catalog，无过滤钩子。
 * 而客户端的 ctx.remote.<ns> 命名空间由 DSH 自带的 dsh-api-remotes 逐个手工声明，
 * 插件自建的 TypertRemoteService 不会让客户端出现 remote.hermes。
 *
 * id 必须与 package.json 的 name 严格相等：模块系统按 graph row 的 id
 * （= 包名）查找已注册的 factory，不一致就报 "loaded without registering"，
 * fiber 建不起来 → "import failed"。
 */
window.__ModuleLoader__.load({
  id: 'dsh-hermes-session',
  factory(require) {
    /** 必需服务：命令贡献注册表 + slot 注册表。 */
    const inject = ['commandUi', 'slots']

    // 图标：ui-primitives 是 Web shell 的平台 seed（staticModules），任何 client
    // 模块都能 require 到，无需在 dsh.client 里声明依赖。
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const HERMES_ICON = primitives.IconArchiveOutlineRegular

    /** Host 路由（document-relative，与 dsh-session-log-export 的做法一致）。 */
    const LIST_ROUTE = 'api/hermes.sessions'

    /** 提及 scheme：与官方 dsh-session: 平行，Host 侧据此解析。 */
    const MENTION_SCHEME = 'dsh-hermes:'

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

    /** 把 Host 错误变成弹窗能显示的可读文本。 */
    function errorText(error) {
      if (error instanceof Error) return error.message
      if (error && typeof error === 'object' && 'message' in error) return String(error.message)
      return String(error)
    }

    /**
     * 调一条 Host 路由，解析 JSON。
     * @param {string} route document-relative 路由
     * @returns {Promise<object>} 响应 JSON
     */
    async function callHost(route) {
      const response = await fetch(route)
      // 先读文本再解析：JSON 解析失败时把原始响应体带进错误信息，
      // 否则只能看到"非 JSON 响应"，无从判断是谁返回的。
      const raw = await response.text()
      let payload = null
      if (raw) {
        try {
          payload = JSON.parse(raw)
        } catch {
          throw new Error(`Host 返回了非 JSON 响应（HTTP ${response.status}）：${raw.slice(0, 300)}`)
        }
      }
      if (!response.ok || (payload && payload.error)) {
        throw new Error(
          (payload && payload.error) || `Host 返回 HTTP ${response.status}：${raw.slice(0, 300)}`,
        )
      }
      return payload
    }

    /** 会话 id → 规范化的提及 URI（base64url 编码的 JSON，与官方 dsh-session: 同构）。 */
    function encodeMention(sessionId) {
      const payload = JSON.stringify(sessionId)
      const base64 = btoa(unescape(encodeURIComponent(payload)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
      return `${MENTION_SCHEME}${base64}`
    }

    /** 提及文本：`@[标题](dsh-hermes:...)`。 */
    function mentionText(session) {
      const label = (session.title || session.sessionId || 'Hermes 会话').replace(/[[\]]/g, '')
      return `@[${label}](${encodeMention(session.sessionId)})`
    }

    /**
     * 把文本插入当前草稿。
     *
     * dsh 0.2.x：slot 拿到的是标准 inputActions 面，span 必须在插入时刻
     * captureInsertion() 取（带草稿版本号），从 React prop 里读的 span 永远滞后一版，
     * 会被编辑器的 span-CAS 静默拒绝——弹窗关掉但草稿里什么都没变。
     *
     * @param {object} inputActions session slot 的 inputActions
     * @param {string} text 要插入的文本
     * @returns {boolean} 是否插入成功
     */
    function insertIntoDraft(inputActions, text) {
      if (!inputActions
        || typeof inputActions.captureInsertion !== 'function'
        || typeof inputActions.insertText !== 'function') return false
      try {
        const span = inputActions.captureInsertion()
        if (!span || typeof span.draftRev !== 'number') return false
        return inputActions.insertText(text, span) === true
      } catch {
        return false
      }
    }

    /**
     * 输入框按钮：点开会话列表，选中后把提及写进草稿。
     *
     * 自绘列表而不复用 commandUi 的 popupSelect：popupSelect 的 onSelect 只拿到
     * ClientSessionContext（没有 inputActions），而写草稿必须要 inputActions。
     *
     * @param {object} props slot 注入的 props（含 inputActions、sessionId）
     */
    function HermesButton(props) {
      const React = require('react')
      const h = React.createElement
      const [open, setOpen] = React.useState(false)
      const [options, setOptions] = React.useState([])
      const [loading, setLoading] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [query, setQuery] = React.useState('')

      const load = React.useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
          const payload = await callHost(LIST_ROUTE)
          setOptions((Array.isArray(payload.sessions) ? payload.sessions : []).map(toOption))
        } catch (e) {
          setError(errorText(e))
        } finally {
          setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        if (open) load()
      }, [open, load])

      const pick = (option) => {
        const text = mentionText({ sessionId: option.id, title: option.label })
        const ok = insertIntoDraft(props.inputActions, text)
        if (ok) {
          setOpen(false)
          setQuery('')
        } else {
          setError('无法写入草稿（编辑器正忙或草稿已变化），请重试')
        }
      }

      const needle = query.trim().toLowerCase()
      const filtered = needle
        ? options.filter((o) => `${o.label} ${o.id} ${o.badge || ''}`.toLowerCase().includes(needle))
        : options

      const chipStyle = {
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12))',
        borderRadius: 'var(--dsw-radius-sm, 8px)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '18px',
        padding: '2px 8px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
      }

      if (!open) {
        return h('button', {
          type: 'button',
          className: 'sk-chip',
          title: '选择一个 Hermes 会话，其内容将注入本条消息',
          'aria-haspopup': 'dialog',
          'aria-expanded': 'false',
          style: chipStyle,
          onClick: () => setOpen(true),
        }, '＋ Hermes')
      }

      const dim = 'var(--dsw-alias-label-tertiary, inherit)'
      return h('div', { style: { position: 'relative', display: 'inline-block' } },
        h('button', {
          type: 'button',
          className: 'sk-chip',
          title: '关闭会话选择器',
          'aria-haspopup': 'dialog',
          'aria-expanded': 'true',
          style: chipStyle,
          onClick: () => setOpen(false),
        }, '× 关闭'),
        h('div', {
          role: 'dialog',
          'aria-label': '选择 Hermes 会话',
          style: {
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            left: '0',
            zIndex: '1100',
            width: 'min(420px, 88vw)',
            maxHeight: '320px',
            overflow: 'auto',
            background: 'var(--dsw-specific-bubble, #fff)',
            color: 'var(--dsw-alias-label-primary, inherit)',
            border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12))',
            borderRadius: 'var(--dsw-radius-md, 10px)',
            boxShadow: '0 6px 24px rgba(0,0,0,0.18)',
            padding: '8px',
            textAlign: 'left',
          },
        },
          h('input', {
            type: 'text',
            value: query,
            placeholder: '按标题或 id 过滤',
            'aria-label': '过滤 Hermes 会话',
            onChange: (e) => setQuery(e.target.value),
            style: {
              width: '100%', boxSizing: 'border-box', marginBottom: '6px',
              padding: '4px 8px', font: 'inherit',
              background: 'var(--dsw-alias-markdown-code-block, rgba(0,0,0,0.04))',
              color: 'inherit',
              border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12))',
              borderRadius: 'var(--dsw-radius-sm, 8px)',
            },
          }),
          error
            ? h('div', {
              role: 'alert',
              style: { color: 'var(--dsw-alias-state-error-primary, #c00)', fontSize: '12px', padding: '4px 2px' },
            }, error)
            : null,
          loading ? h('div', { style: { fontSize: '12px', padding: '4px 2px' } }, '加载中…') : null,
          !loading && !error && filtered.length === 0
            ? h('div', { style: { fontSize: '12px', padding: '4px 2px' } }, '没有匹配的会话')
            : null,
          filtered.map((o) => h('div', {
            key: o.id,
            role: 'option',
            'aria-selected': 'false',
            title: o.id,
            onClick: () => pick(o),
            style: {
              padding: '6px 8px', borderRadius: 'var(--dsw-radius-sm, 8px)',
              cursor: 'pointer', fontSize: '13px', lineHeight: '1.4',
            },
            onMouseEnter: (e) => { e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05))' },
            onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
          },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '6px' } },
              h('span', { style: { fontWeight: '500' } }, o.label),
              o.badge ? h('span', { style: { fontSize: '11px', color: dim } }, `[${o.badge}]`) : null,
            ),
            o.detail ? h('div', { style: { fontSize: '11px', color: dim } }, o.detail) : null,
          )),
        ),
      )
    }

    /**
     * 客户端插件体：注册 /hermes 斜杠命令 + 输入框按钮。
     * @param {object} ctx 客户端根 context
     */
    function apply(ctx) {
      // 1) 斜杠命令：/hermes 打开会话列表（commandUi 的 popupSelect 自带搜索框与图标）。
      //    注意：它的 onSelect 拿不到 inputActions，写不进草稿——真正能写草稿的是
      //    下面输入框按钮那条路径。所以 /hermes 只负责"看列表"，插入请用按钮。
      ctx.inject(['commandUi'], (scope) => {
        const command = scope.get('commandUi')

        scope.effect(() => command.register({
          name: 'hermes',
          label: () => 'Hermes 会话',
          description: () => '选择一个 Hermes 会话，其内容将随本条消息注入上下文',
          icon: HERMES_ICON,
          available: () => true,
          ui: {
            kind: 'popupSelect',
            options: async () => {
              const payload = await callHost(LIST_ROUTE)
              const sessions = Array.isArray(payload.sessions) ? payload.sessions : []
              return sessions.map(toOption)
            },
            onSelect: async () => {
              // popupSelect 的 onSelect 拿不到 inputActions，无法写草稿。
              // 这里提示用户用输入框的「＋ Hermes」按钮完成插入。
              throw new Error('请用输入框工具行的「＋ Hermes」按钮选择会话（斜杠命令无法写入草稿）')
            },
          },
        }), 'dsh-hermes-session: /hermes contribution')
      })

      // 2) 输入框工具行按钮：与「+技能」同位置，选中后写入草稿。
      ctx.inject(['slots'], (scope) => {
        const slots = scope.get('slots')
        scope.effect(() => slots.inject('conversation.input.left', () => slots.register({
          name: 'conversation.input.left',
          id: 'hermes-sessions',
          order: 60,
          label: 'Hermes 会话',
        }, HermesButton)), 'dsh-hermes-session: composer button')
      })
    }

    return { inject, apply }
  },
})
