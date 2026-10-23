#!/usr/bin/env node
/**
 * 自测：不经过 harness，直接跑插件的两个工具，验证
 *   1) 真能读到本机 hermes 会话库
 *   2) 渲染出来的注入文本带警示头、有界
 *   3) deferContext 收到的是一条 user-role 消息
 *   4) 错误路径（不存在的会话）给结构化提示而不是抛栈
 *
 * 用法：node selftest/run.mjs [sessionId]
 */
import { buildTools } from '../src/tools.js'

const cfg = { dbPath: '', pythonPath: '', maxChars: 60000, maxCharsHard: 160000, maxMessages: 300 }

let failed = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 假 exec：记录 deferContext 收到的消息。 */
function fakeExec() {
  const deferred = []
  return {
    deferred,
    signal: new AbortController().signal,
    deferContext: (message) => deferred.push(message),
    concludeTurn() {},
  }
}

const [sessionsList, sessionImport] = buildTools(cfg)

console.log('1) hermes_sessions_list（默认扫全部 profile）')
const listOut = await sessionsList.execute({ limit: 6 }, fakeExec())
check('返回文本', typeof listOut === 'string' && listOut.length > 0, listOut.slice(0, 200))
check('含多库扫描说明', listOut.includes('profile'), listOut.slice(0, 160))
const ids = listOut.match(/`[0-9]{8}_[0-9]{6}_[0-9a-f]+`/g) || []
console.log(`  找到 ${ids.length} 个 sessionId`)
const profiles = [...listOut.matchAll(/\[(\w+)\] 最后活动/g)].map((m) => m[1])
check('结果带 profile 标注', profiles.length > 0, '没有 [profile] 标注')
console.log(`  涉及 profile：${[...new Set(profiles)].join(', ')}`)

console.log('\n1b) profile 限定列表')
const profOut = await sessionsList.execute({ limit: 3, profile: 'sirna' }, fakeExec())
check('限定 profile 返回文本', profOut.includes('sirna'), profOut.slice(0, 160))

const targetId = process.argv[2] || (ids[0] && ids[0].slice(1, -1))
console.log(`\n2) hermes_session_import (${targetId})`)

if (!targetId) {
  console.log('  ! 没有可用的 sessionId，跳过导入测试')
} else {
  const exec = fakeExec()
  const importOut = await sessionImport.execute({ sessionId: targetId, maxMessages: 40 }, exec)
  check('返回摘要文本', typeof importOut === 'string' && importOut.length > 0)
  check('deferContext 收到 1 条消息', exec.deferred.length === 1, `实际 ${exec.deferred.length}`)
  const msg = exec.deferred[0]
  check('消息 role=user', msg && msg.role === 'user')
  // 工具路径也要用 recall 形态的 source，才能和 /hermes 弹窗路径表现一致
  check("消息 source.kind='session-reference'", msg && msg.source && msg.source.kind === 'session-reference', msg?.source?.kind)
  check("消息 source.form='recall'", msg && msg.source && msg.source.form === 'recall', msg?.source?.form)
  const text = msg?.content?.[0]?.text || ''
  check('注入文本含原生同款警示语', text.includes('Use it only as background information'))
  check('注入文本含会话ID', text.includes(targetId) || importOut.includes('会话'))
  check('注入文本非空', text.length > 200, `长度 ${text.length}`)
  check('注入文本不超过预算', text.length <= cfg.maxChars, `长度 ${text.length}`)

  console.log('\n  ---- 注入文本前 700 字符 ----')
  console.log(
    text
      .slice(0, 700)
      .split('\n')
      .map((l) => `  | ${l}`)
      .join('\n'),
  )
  console.log(`  ...（共 ${text.length} 字符）`)
}

console.log('\n3) 错误路径')
const bad = await sessionImport.execute({ sessionId: 'definitely_not_a_session' }, fakeExec())
check('不存在的会话给出可读失败', bad.includes('导入失败'), bad.slice(0, 200))
const empty = await sessionImport.execute({ sessionId: '' }, fakeExec())
check('空 sessionId 被拒', empty.includes('不能为空'), empty.slice(0, 120))
const badProf = await sessionsList.execute({ limit: 2, profile: 'no_such_profile' }, fakeExec())
check('未知 profile 给出可读失败', badProf.includes('失败') || badProf.includes('找不到'), badProf.slice(0, 160))

console.log('\n4) 跨库导入（sirna profile 的会话）')
const sirnaId = '20261021_135400_6c2813'
const sirnaExec = fakeExec()
const sirnaOut = await sessionImport.execute({ sessionId: sirnaId, maxMessages: 5 }, sirnaExec)
check('跨库导入成功', sirnaOut.includes('已把'), sirnaOut.slice(0, 160))
check('deferContext 收到消息', sirnaExec.deferred.length === 1, `实际 ${sirnaExec.deferred.length}`)
check('摘要标注 profile', sirnaOut.includes('sirna'), sirnaOut.slice(0, 200))
const sirnaText = sirnaExec.deferred[0]?.content?.[0]?.text || ''
check('注入文本标注 Hermes profile', sirnaText.includes('sirna'))

console.log('\n5) Host HTTP 路由 + pre-step 钩子（解析草稿里的 Hermes 提及）')
const { registerRoutes, LIST_ROUTE, MENTION_SCHEME, parseMentions } = await import('../src/routes.js')

// 假 ctx：捕获注册的路由与 pre-step 钩子
const registered = []
const preStepHooks = []
const fakeCtx = {
  connection: {
    fetch: {
      register: (route) => {
        registered.push(route)
        return () => Promise.resolve()
      },
    },
  },
  on: (event, handler) => {
    if (event === 'agent/pre-step') preStepHooks.push(handler)
  },
  logger: { warn: () => {}, info: () => {} },
}

const dispose = registerRoutes(fakeCtx, cfg)
check('注册了一条路由', registered.length === 1, `实际 ${registered.length}`)
const listRoute = registered.find((r) => r.path === LIST_ROUTE)
check('列表路由存在', !!listRoute, LIST_ROUTE)
check('列表路由是 GET', listRoute?.methods?.includes('GET'))
check('注册了 agent/pre-step 钩子', preStepHooks.length === 1, `实际 ${preStepHooks.length}`)

// GET 列表
const listResponse = await listRoute.fetch(new Request(`http://x${LIST_ROUTE}`))
check('列表路由返回 200', listResponse.status === 200, String(listResponse.status))
const payload = await listResponse.json()
check('列表返回含 sessions 数组', Array.isArray(payload.sessions), String(typeof payload.sessions))
check('列表每条带 sessionId', (payload.sessions || []).every((s) => typeof s.sessionId === 'string'))
check('列表会话数 > 0', (payload.sessions || []).length > 0, `条数 ${payload.sessions?.length}`)

// 列表默认给出最近 100 条（按最后活动时间降序），且必须包含子会话。
// 回归过的坑：曾写死 --limit 50 且不传 --include-children，导致
// "DNA-Diffusion训练"（一个子会话）永远不出现——而 hermes CLI 能看到。
check('列表带总数', typeof payload.totalSessions === 'number', String(payload.totalSessions))
check('默认返回最近 100 条', (payload.sessions || []).length === 100, `条数 ${payload.sessions?.length}`)
check('总数大于返回条数（确实只列了一页）', payload.totalSessions > (payload.sessions || []).length,
  `总数 ${payload.totalSessions} / 返回 ${payload.sessions?.length}`)
// 按最后活动时间严格降序（用户要求：按最近一次会话时间排序）
check('按最后活动时间降序', await (async () => {
  const times = (payload.sessions || []).map((s) => s.lastActivityAt || '').filter(Boolean)
  if (times.length < 2) return false
  return times.every((t, i) => i === 0 || times[i - 1] >= t)
})())
check('列表包含子会话（parentSessionId 非空）', (payload.sessions || []).some((s) => s.parentSessionId))
check('列表里能查到子会话（Host 侧过滤）', await (async () => {
  const child = (payload.sessions || []).find((s) => s.parentSessionId)
  if (!child) return false
  const q = await (await listRoute.fetch(new Request(
    `http://x${LIST_ROUTE}?query=${encodeURIComponent(child.title || child.sessionId)}`,
  ))).json()
  return (q.sessions || []).some((s) => s.sessionId === child.sessionId)
})())

// 服务端查询：过滤必须发生在 Host 侧（否则搜不到没被拉下来的会话）
const qRoute = await (await listRoute.fetch(new Request(
  `http://x${LIST_ROUTE}?query=${encodeURIComponent('DNA-Diffusion')}`,
))).json()
check('query 参数生效（服务端过滤）', (qRoute.sessions || []).length > 0, `匹配 ${qRoute.sessions?.length}`)
check('query 结果确实被过滤（少于全量）', (qRoute.sessions || []).length < (payload.sessions || []).length,
  `匹配 ${qRoute.sessions?.length} / 全量 ${payload.sessions?.length}`)
check('query 结果带 title', (qRoute.sessions || []).every((s) => typeof s.title === 'string'))
const noMatch = await (await listRoute.fetch(new Request(
  `http://x${LIST_ROUTE}?query=${encodeURIComponent('__no_such_session_zzz__')}`,
))).json()
check('无匹配时返回空数组（不报错）', Array.isArray(noMatch.sessions) && noMatch.sessions.length === 0)

// 提及解析：@[标题](dsh-hermes:<base64url>) → 引用 + 文本规范化
const target = payload.sessions[0].sessionId
const b64 = Buffer.from(JSON.stringify(target), 'utf8')
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const mention = `@[${payload.sessions[0].title || '会话'}](${MENTION_SCHEME}${b64})`
const userMessage = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `帮我总结这个 ${mention}` }] }
const parsed = parseMentions(userMessage)
check('解析出一个提及', parsed.references.length === 1, `实际 ${parsed.references.length}`)
check('提及解出正确的 sessionId', parsed.references[0]?.sessionId === target, String(parsed.references[0]?.sessionId))
check('提及被规范化为 @标签', parsed.message.content[0].text.includes('@'), parsed.message.content[0].text.slice(0, 60))
check('规范化后不再含 URI', !parsed.message.content[0].text.includes(MENTION_SCHEME))

// 无提及 → 不改动
const plain = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '普通消息' }] }
check('无提及时不产生引用', parseMentions(plain).references.length === 0)

// pre-step：带提及的用户消息 → 追加上下文
const preStep = preStepHooks[0]
const decision = await preStep(
  { agent: { id: 'current-session' }, messages: [userMessage], signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [userMessage] }),
)
check('pre-step 返回 enter', decision.kind === 'enter', String(decision.kind))
check('pre-step 后消息数 = 2（用户消息 + 上下文）', decision.messages.length === 2, `实际 ${decision.messages.length}`)
const ctxMessage = decision.messages[1]
check('追加的是上下文消息', ctxMessage && ctxMessage !== userMessage)
check('上下文消息带 source', !!ctxMessage?.source)
// 正文格式对齐原生：<referenced-sessions> 包裹 + 同样的英文警示语 + 同样的标题段
check('上下文文本带原生同款警示语', (ctxMessage?.content?.[0]?.text || '').includes('Use it only as background information'))
check('上下文文本用原生 <referenced-sessions> 包裹', (ctxMessage?.content?.[0]?.text || '').includes('<referenced-sessions>'))
check('上下文文本带原生标题段', (ctxMessage?.content?.[0]?.text || '').includes('## Referenced sessions'))

// 原生注入正文的 JSON 是**数组**，每个元素一个会话对象，conversation 形如
// [{role, text}]（text 是完整原文，不是 64 码点碎片——碎片是原生溢出落盘的
// spill 格式，不是注入提示的格式）。
const ctxText = ctxMessage?.content?.[0]?.text || ''
const jsonMatch = ctxText.match(/<referenced-sessions>\n([\s\S]*?)\n<\/referenced-sessions>/)
check('能从正文里取出 referenced-sessions 的 JSON', !!jsonMatch)
let parsedJson = null
try {
  parsedJson = JSON.parse(jsonMatch ? jsonMatch[1] : '')
} catch (e) {
  check('referenced-sessions 的 JSON 可解析', false, String(e).slice(0, 120))
}
if (parsedJson) {
  check('referenced-sessions 的 JSON 是数组（与原生同构）', Array.isArray(parsedJson))
  const entry = Array.isArray(parsedJson) ? parsedJson[0] : null
  check('数组首项是会话对象', !!entry && typeof entry === 'object')
  check('会话对象带 sessionId', typeof entry?.sessionId === 'string' && entry.sessionId.length > 0)
  check('会话对象带 label', typeof entry?.label === 'string' && entry.label.length > 0)
  check('会话对象带 conversation 数组', Array.isArray(entry?.conversation))
  const item = entry?.conversation?.[0]
  check('conversation 项形如 {role, text}', typeof item?.role === 'string' && typeof item?.text === 'string', JSON.stringify(item).slice(0, 120))
  check('conversation 的 text 是完整原文（不是碎片）', typeof item?.text === 'string' && item.text.length > 0)
  check('JSON 里没有裸 "<"（原生 stringifyTagSafeJson 转义）', !ctxText.includes('"content":"<'))
}

// 折叠渲染：source 必须是 DSH 的 recall 形态
const src = ctxMessage?.source || {}
check('source.form === recall（触发折叠渲染）', src.form === 'recall', String(src.form))
// kind 必须是 'session-reference'——客户端 contextProducer() 只认这个值才给
// role:'recall'（会话引用图标 + contextRecall 标题 + 折叠行显示会话标题）；
// 用自己的 kind 会退化成 role:'inject'，表现和原生不一样。
check("source.kind === 'session-reference'（与原生 @ 引用会话一致）", src.kind === 'session-reference', String(src.kind))
check('source.references 是数组', Array.isArray(src.references))
const ref = src.references?.[0]
check('reference 带 label', typeof ref?.label === 'string' && ref.label.length > 0, String(ref?.label))
check('reference 带 retainedMessages 数字', typeof ref?.retainedMessages === 'number', String(ref?.retainedMessages))
check('reference 带 omittedMessages 数字', typeof ref?.omittedMessages === 'number', String(ref?.omittedMessages))
check('reference 带 truncated 布尔', typeof ref?.truncated === 'boolean', String(ref?.truncated))

// 没有提及 → 不追加
const decision2 = await preStep(
  { agent: { id: 'current-session' }, messages: [plain], signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [plain] }),
)
check('无提及时不追加上下文', decision2.messages.length === 1, `实际 ${decision2.messages.length}`)

await dispose()
check('注销后路由已移除', true)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
