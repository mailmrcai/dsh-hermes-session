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
  check('消息 source.kind=user', msg && msg.source && msg.source.kind === 'user')
  const text = msg?.content?.[0]?.text || ''
  check('注入文本含不可信警示', text.includes('不可信背景'))
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

console.log('\n5) Host HTTP 路由 + pre-step 钩子（选中只暂存，发消息时才注入）')
const { registerRoutes, LIST_ROUTE, SELECT_ROUTE } = await import('../src/routes.js')

// 假 ctx：捕获注册的两条路由与 pre-step 钩子
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
check('注册了两条路由', registered.length === 2, `实际 ${registered.length}`)
const listRoute = registered.find((r) => r.path === LIST_ROUTE)
const selectRoute = registered.find((r) => r.path === SELECT_ROUTE)
check('列表路由存在', !!listRoute, LIST_ROUTE)
check('选择路由存在', !!selectRoute, SELECT_ROUTE)
check('路由路径在 /api 下', LIST_ROUTE.startsWith('/api/') && SELECT_ROUTE.startsWith('/api/'))
check('列表路由是 GET', listRoute?.methods?.includes('GET'))
check('选择路由是 POST', selectRoute?.methods?.includes('POST'))
check('注册了 agent/pre-step 钩子', preStepHooks.length === 1, `实际 ${preStepHooks.length}`)

// GET 列表
const listResponse = await listRoute.fetch(new Request(`http://x${LIST_ROUTE}`))
check('列表路由返回 200', listResponse.status === 200, String(listResponse.status))
const payload = await listResponse.json()
check('列表返回含 sessions 数组', Array.isArray(payload.sessions), String(typeof payload.sessions))
check('列表每条带 sessionId', (payload.sessions || []).every((s) => typeof s.sessionId === 'string'))
check('列表每条带 profile', (payload.sessions || []).every((s) => typeof s.profile === 'string'))
check('列表会话数 > 0', (payload.sessions || []).length > 0, `条数 ${payload.sessions?.length}`)

// POST 选择：只暂存，不注入
const target = payload.sessions[0].sessionId
const selectResponse = await selectRoute.fetch(
  new Request(`http://x${SELECT_ROUTE}`, {
    method: 'POST',
    body: JSON.stringify({ sessionId: target, dshSessionId: 'current-session' }),
  }),
)
check('选择路由返回 200', selectResponse.status === 200, String(selectResponse.status))
const selectBody = await selectResponse.json()
check('选择返回 ok', selectBody.ok === true, JSON.stringify(selectBody).slice(0, 120))
check('选择只暂存（pending），不直接注入', selectBody.pending === true, JSON.stringify(selectBody).slice(0, 120))

// pre-step：用户发消息时才注入上下文
const preStep = preStepHooks[0]
const userMessage = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我总结这个会话' }] }
const decision = await preStep(
  { agent: { id: 'current-session' }, messages: [userMessage], signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [userMessage] }),
)
check('pre-step 返回 enter', decision.kind === 'enter', String(decision.kind))
check('pre-step 后消息数 = 2（用户消息 + 上下文）', decision.messages.length === 2, `实际 ${decision.messages.length}`)
const ctxMessage = decision.messages[1]
check('追加的是上下文消息', ctxMessage && ctxMessage !== userMessage)
check('上下文消息带 source', !!ctxMessage?.source)
check('上下文文本带不可信警示', (ctxMessage?.content?.[0]?.text || '').includes('不可信背景'))

// 折叠渲染：source 必须是 DSH 的 recall 形态，对话列表才会渲染成可折叠的上下文行
const src = ctxMessage?.source || {}
check('source.form === recall（触发折叠渲染）', src.form === 'recall', String(src.form))
check('source.kind 是插件自己的标识', src.kind === 'hermes-session', String(src.kind))
check('source.references 是数组', Array.isArray(src.references))
const ref = src.references?.[0]
check('reference 带 label', typeof ref?.label === 'string' && ref.label.length > 0, String(ref?.label))
check('reference 带 retainedMessages 数字', typeof ref?.retainedMessages === 'number', String(ref?.retainedMessages))
check('reference 带 omittedMessages 数字', typeof ref?.omittedMessages === 'number', String(ref?.omittedMessages))
check('reference 带 truncated 布尔', typeof ref?.truncated === 'boolean', String(ref?.truncated))

// 一次选择只服务下一次发送：再跑一次 pre-step 不应重复注入
const decision2 = await preStep(
  { agent: { id: 'current-session' }, messages: [userMessage], signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [userMessage] }),
)
check('暂存取出即消费（第二次 pre-step 不再追加）', decision2.messages.length === 1, `实际 ${decision2.messages.length}`)

// 错误路径
const emptySelect = await selectRoute.fetch(
  new Request(`http://x${SELECT_ROUTE}`, { method: 'POST', body: JSON.stringify({}) }),
)
check('空 sessionId 返回 400', emptySelect.status === 400, String(emptySelect.status))
const noDsh = await selectRoute.fetch(
  new Request(`http://x${SELECT_ROUTE}`, { method: 'POST', body: JSON.stringify({ sessionId: target }) }),
)
check('缺 dshSessionId 返回 400', noDsh.status === 400, String(noDsh.status))
const badJson = await selectRoute.fetch(
  new Request(`http://x${SELECT_ROUTE}`, { method: 'POST', body: 'not json' }),
)
check('非 JSON 请求体返回 400', badJson.status === 400, String(badJson.status))

await dispose()
check('注销后路由已移除', true)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
