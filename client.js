/**
 * 客户端半部：Hermes 会话选择器（输入框工具行的「＋ Hermes」按钮）。
 *
 * 交互对齐官方「+技能」按钮（@weibaohui/skills-management）：
 *   1. 在输入框工具行（conversation.input.left）放一个按钮
 *   2. 点开一个可搜索的会话列表；点列表外部或按 Esc 关闭
 *   3. 选中后插入一条**引用 chip**（appearance: 'session'）——与原生 `@` 会话引用
 *      同样的蓝色样式，chip 里的文本是 `@[标题](dsh-hermes:<base64url>)`
 *   4. 用户写完描述一并发送；Host 侧 agent/pre-step 钩子解析 chip 里的提及，
 *      读 Hermes 会话并把内容作为上下文追加到那一轮
 *
 * 为什么不直接注入：直接注入会在用户还没说明目的时就唤醒 agent 让模型自己开跑。
 * 插入 chip 把「选上下文」和「说诉求」拆成两步，一次发送里两者一起处理。
 *
 * 为什么不用斜杠命令：commandUi 的 popupSelect 的 onSelect 只拿到
 * ClientSessionContext，没有 inputActions，写不进草稿；而且弹窗要自己实现
 * 「点外部关闭」。所以只保留输入框按钮这一条路径。
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
    /** 必需服务：slot 注册表 + sessions（取会话作用域 ctx 用）。 */
    const inject = ['slots', 'sessions']

    // 图标：ui-primitives 是 Web shell 的平台 seed（staticModules），任何 client
    // 模块都能 require 到，无需在 dsh.client 里声明依赖。
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    // 归档箱：取回一个历史会话。
    const HERMES_ICON = primitives.IconArchiveOutlineRegular

    /** Host 路由（document-relative，与 dsh-session-log-export 的做法一致）。 */
    const LIST_ROUTE = 'api/hermes.sessions'

    /** 提及 scheme：与官方 dsh-session: 平行，Host 侧据此解析。 */
    const MENTION_SCHEME = 'dsh-hermes:'

    /** 会话一条 → 列表一行。badge 显示 profile，detail 显示消息数和时间。 */
    function toOption(session) {
      const parts = []
      if (session.messageCount != null) parts.push(`${session.messageCount} 条`)
      if (session.lastActivityAt) parts.push(session.lastActivityAt)
      // 子会话（压缩续写 / 子代理）标出来——它们以前被默认过滤掉，
      // 但往往正是用户想引用的那段具体工作。
      if (session.parentSessionId) parts.push('子会话')
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

    /** 提及文本：`@[标题](dsh-hermes:...)`——chip 里的可见文本。 */
    function mentionText(session) {
      const label = (session.title || session.sessionId || 'Hermes 会话').replace(/[[\]]/g, '')
      return `@[${label}](${encodeMention(session.sessionId)})`
    }

    // 关键事实（dsh 0.2.0-rc.1 实测源码）：公开给插件的 inputActions 只有
    //   captureInsertion / insertText / setDraft
    //   addAttachments / removeAttachment / pruneAttachments / submit
    // **没有 insertReference，也没有插 chip 的公开方法**——`insertReference` 只存在
    // 于 SessionInputShell 类内部（line 13762），插件拿不到。之前两版（addFiles /
    // insertReference）都因此失败，报"无法插入草稿"。
    //
    // 正确路径 = 原生 `@` 引用同一条：在会话作用域上 bail 事件
    //   slash/input-insert-reference
    // 监听器由 conversation.input 注册（client.js:14264）→ 调 shell.insertReference。
    // 拿 actx 照抄官方「+技能」按钮：sessions.using(sessionId, ...) →
    // reference.binding.ctx。
    //
    // 兜底：拿不到 actx / 没人接事件 → 退化为 insertText 插纯文本。
    // 宁可样式降级，也不能让用户看到"无法插入草稿"。

    let sessionsScope = null

    /** 构造原生同构的 ReferenceInsert。 */
    function referenceFor(session) {
      const mention = mentionText(session)
      return {
        source: 'reference',
        ref: mention,
        label: session.title || session.sessionId || 'Hermes 会话',
        appearance: 'session', // ← 渲染成蓝色会话 chip（与原生 @ 一致）
        clipboardText: mention,
      }
    }

    /**
     * 插入引用 chip（事件路径，失败退化为纯文本）。
     *
     * sessions.using() 是异步的——回调在会话就绪后才跑，所以这里必须 await，
     * 否则同步读 ok 永远是 false，会误判成"插入失败"而退化成纯文本。
     *
     * @param {object} inputActions slot 的 inputActions
     * @param {string} sessionId 当前 DSH 会话 id
     * @param {{sessionId: string, title: string}} session 选中的 Hermes 会话
     * @returns {Promise<boolean>} 是否插入成功
     */
    async function insertChip(inputActions, sessionId, session) {
      if (!inputActions || typeof inputActions.captureInsertion !== 'function') return false
      let span = null
      try {
        span = inputActions.captureInsertion()
        if (!span || typeof span.draftRev !== 'number') return false
      } catch {
        return false
      }

      // 1) 首选：作用域事件 → 真正的 reference chip（蓝色）。
      const sessions = sessionsScope && sessionsScope.sessions
      if (sessions && typeof sessions.using === 'function') {
        try {
          let ok = false
          await sessions.using(sessionId, { source: 'hermesComposer' }, (reference) => {
            const actx = reference && reference.binding && reference.binding.ctx
            if (actx && typeof actx.bail === 'function') {
              ok = actx.bail(actx, 'slash/input-insert-reference', {
                reference: referenceFor(session),
                span,
              }) === true
            }
          })
          if (ok) return true
        } catch {
          /* 落到兜底 */
        }
      }

      // 2) 兜底：纯文本插入（样式降级，功能不丢）。
      try {
        if (typeof inputActions.insertText === 'function') {
          return inputActions.insertText(` ${mentionText(session)} `, span) === true
        }
      } catch {
        /* 忽略 */
      }
      return false
    }

    /**
     * 输入框按钮：点开会话列表，选中后插入引用 chip。
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
      // total：库里一共多少会话；用于提示"只显示前 N 条 / 匹配 N 条"。
      const [total, setTotal] = React.useState(0)
      // cardRef：弹窗卡片（外部点击判定用）；btnRef：按钮（弹窗定位用）。
      const cardRef = React.useRef(null)
      const btnRef = React.useRef(null)

      // 过滤发生在 **Host 侧**：423 个会话全量匹配。
      // 客户端只拉一页再本地筛的话，永远找不到没被拉下来的那条
      // （之前 DNA-Diffusion训练 就是这么丢的）。
      const load = React.useCallback(async (q) => {
        setLoading(true)
        setError(null)
        try {
          const url = q ? `${LIST_ROUTE}?query=${encodeURIComponent(q)}` : LIST_ROUTE
          const payload = await callHost(url)
          setOptions((Array.isArray(payload.sessions) ? payload.sessions : []).map(toOption))
          setTotal(Number(payload.totalSessions) || 0)
        } catch (e) {
          setError(errorText(e))
        } finally {
          setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        if (open) load(query)
      }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

      // 输入过滤词 → 防抖后重新向 Host 查询（250ms）。
      React.useEffect(() => {
        if (!open) return undefined
        const timer = setTimeout(() => {
          load(query)
        }, 250)
        return () => clearTimeout(timer)
      }, [query, open, load])

      // 点列表外部关闭——与内置 popupSelect 同一手法：
      // capture 阶段的 pointerdown，检查点击目标是否在卡片内。
      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (ev) => {
          if (cardRef.current !== null && ev.target instanceof Node && cardRef.current.contains(ev.target)) return
          setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
        }
      }, [open])

      // Esc 关闭。
      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (ev) => {
          if (ev.key === 'Escape' && ev.isComposing !== true) setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      const pick = async (option) => {
        const ok = await insertChip(props.inputActions, props.sessionId, { sessionId: option.id, title: option.label })
        if (ok) {
          setOpen(false)
          setQuery('')
        } else {
          setError('无法插入草稿（编辑器正忙或草稿已变化），请重试')
        }
      }

      // 过滤已在 Host 侧完成，这里直接用结果——客户端再筛一遍会把
      // "cwd 里含关键词但标题不含"的会话误杀。
      const filtered = options
      // 有过滤词时展示"匹配 N / 共 M"；否则说明默认只列了最近 100 条，
      // 更早的会话需要用过滤框搜（服务端全量匹配）。
      const summary = query.trim()
        ? `匹配 ${filtered.length} / 共 ${total} 个会话`
        : `最近 ${filtered.length} 个会话（共 ${total} 个，按最后活动时间排序）`

      // 按钮样式对齐官方「+技能」按钮的 .sk-chip（同样的高度/内边距/圆角），
      // 免得在输入框工具行里显得突兀。
      const chipStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        height: '26px',
        padding: '0 9px',
        borderRadius: 'var(--dsw-radius-sm, 8px)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        fontFamily: 'var(--dsw-font-family, inherit)',
        fontSize: '12px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }

      const dim = 'var(--dsw-alias-label-tertiary, inherit)'

      // 弹窗用 portal 挂到 document.body——官方「+技能」按钮同一做法：
      // 避免被输入框容器的 overflow 裁剪，也不用管父级的定位上下文。
      const ReactDOM = require('react-dom')
      const card = h('div', {
        role: 'dialog',
        'aria-label': '选择 Hermes 会话',
        style: {
          position: 'fixed',
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
        !loading && !error
          ? h('div', { style: { fontSize: '11px', color: dim, padding: '0 2px 4px' } }, summary)
          : null,
        !loading && !error && filtered.length === 0
          ? h('div', { style: { fontSize: '12px', padding: '4px 2px' } }, '没有匹配的会话')
          : null,
        filtered.map((o) => h('div', {
          key: o.id,
          role: 'option',
          'aria-selected': 'false',
          title: o.id,
          onMouseDown: (e) => { e.preventDefault(); pick(o) },
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
      )

      const button = h('button', {
        type: 'button',
        className: 'sk-chip',
        ref: btnRef,
        title: '选择一个 Hermes 会话，其内容将注入本条消息',
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        style: chipStyle,
        onClick: () => setOpen((v) => !v),
      },
        open
          ? '× 关闭'
          : h(React.Fragment, null,
            // 图标跟着 currentColor 走（IconProps 只有 size/className）。
            h(HERMES_ICON, { size: 14, className: 'hermes-chip-icon' }),
            '＋ Hermes',
          ),
      )

      if (!open) return button

      // 弹窗贴着按钮定位：固定定位 + 按钮的 left，底部对齐按钮顶部。
      // 高度不预设（内容多少弹多高），上边界由 maxHeight 兜底。
      const rect = btnRef.current ? btnRef.current.getBoundingClientRect() : null
      const left = rect ? Math.max(8, Math.min(rect.left, window.innerWidth - 440)) : 8
      const bottomGap = rect ? Math.max(8, window.innerHeight - rect.top + 6) : 8
      const positioned = h('div', {
        ref: cardRef,
        style: {
          ...card.props.style,
          left: `${left}px`,
          bottom: `${bottomGap}px`,
          top: 'auto',
        },
      }, card.props.children)

      const portal = ReactDOM.createPortal
        ? ReactDOM.createPortal(positioned, document.body)
        : positioned

      return h(React.Fragment, null, button, portal)
    }

    /**
     * 客户端插件体：在输入框工具行注册「＋ Hermes」按钮。
     * @param {object} ctx 客户端根 context
     */
    function apply(ctx) {
      // 拿 sessions 服务：插入 chip 要靠它取会话作用域 ctx（actx），
      // 再 bail `slash/input-insert-reference` 事件——原生 @ 引用同一条路径。
      ctx.inject(['sessions'], (scope) => {
        sessionsScope = scope
      })

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
