#!/usr/bin/env node
/**
 * 客户端模块自测：验证 client.js 的模块 id 与 package.json 的 name 一致。
 *
 * 背景：模块系统按 graph row 的 id（= 包名）查找已注册的 factory。
 * id 不一致 → "loaded without registering" → fiber 建不起来 →
 * "import failed" → 有 immediately 时整个 harness 起不来。
 *
 * 用法：node selftest/clientid.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '..')

let failed = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failed++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const clientSrc = readFileSync(join(ROOT, 'client.js'), 'utf8')

console.log('1) 客户端模块 id')
const idMatch = clientSrc.match(/id:\s*'([^']+)'/)
const moduleId = idMatch?.[1]
console.log(`  package.json name = ${pkg.name}`)
console.log(`  client.js id      = ${moduleId}`)
check('client.js 声明了模块 id', typeof moduleId === 'string')
check(
  'id 与 package.json 的 name 严格相等',
  moduleId === pkg.name,
  `id=${moduleId} name=${pkg.name}`,
)

console.log('\n2) dsh.client 声明')
const decl = pkg.dsh?.client
check('有 dsh.client 声明', !!decl)
check('platform 是 web', decl?.platform === 'web', String(decl?.platform))
check('未设 immediately（懒加载，避免 boot 期失败）', decl?.immediately === undefined, String(decl?.immediately))
check('exports 有 ./client', typeof pkg.exports?.['./client'] === 'string', JSON.stringify(pkg.exports?.['./client']))
check(
  './client 指向的文件存在',
  readFileSync(join(ROOT, pkg.exports['./client']), 'utf8').length > 0,
)

console.log('\n3) 客户端用 HTTP 路由（不进斜杠菜单，也不依赖 remote.hermes）')
// 只看代码行（去掉注释），避免注释里的说明文字误判。
const clientCode = clientSrc
  .split('\n')
  .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
  .join('\n')
check(
  '客户端代码不含 remote.hermes',
  !clientCode.includes('remote.hermes'),
  'remote.hermes 不会存在——自定义 TypertRemoteService 不会让客户端出现该命名空间',
)
check(
  '客户端代码不含 remote.commands',
  !clientCode.includes('remote.commands'),
  '走 HTTP 路由就不需要 commands 命名空间',
)
check(
  '客户端用 fetch 调 Host 路由',
  clientCode.includes('fetch(') && clientCode.includes('api/hermes.'),
  '数据通道是 /api/hermes.sessions 与 /api/hermes.import',
)
check(
  '客户端不再注册斜杠命令（写不进草稿，已删除）',
  !clientCode.includes('commandUi') && !clientCode.includes('command.register('),
  'popupSelect 的 onSelect 拿不到 inputActions',
)
check(
  '客户端按钮是纯文字（与官方 +技能 一致，不塞图标）',
  !clientCode.includes('dsh-client-ui-primitives') && clientCode.includes('＋ Hermes'),
  '塞图标组件会撑出多余空白',
)
check(
  '客户端弹窗用 portal 挂到 body',
  clientCode.includes('createPortal'),
  '官方 +技能 按钮同一做法：避免被输入框容器裁剪',
)

console.log('\n4) Host 侧只注册 HTTP 路由，不注册斜杠命令')
const { LIST_ROUTE, MENTION_SCHEME } = await import(join(ROOT, 'src/routes.js'))
check('列表路由 === /api/hermes.sessions', LIST_ROUTE === '/api/hermes.sessions', LIST_ROUTE)
check('提及 scheme === dsh-hermes:', MENTION_SCHEME === 'dsh-hermes:', MENTION_SCHEME)
check(
  '客户端用的路由与 Host 一致',
  clientCode.includes(LIST_ROUTE.replace('/api/', 'api/')),
  '客户端应调 document-relative 的同名路由',
)
check(
  '客户端与 Host 用同一个提及 scheme',
  clientCode.includes(`'${MENTION_SCHEME}'`),
  `两端必须都是 ${MENTION_SCHEME}`,
)
check(
  '客户端在输入框工具行注册按钮',
  clientCode.includes('conversation.input.left') && clientCode.includes('slots.register('),
  '草稿写入需要 slot 的 inputActions 面，popupSelect 拿不到',
)
check(
  '客户端用 insertReference 插入引用 chip',
  clientCode.includes('insertReference(') && clientCode.includes('appearance:'),
  "appearance:'session' 才是原生 @ 引用的蓝色 chip 样式；insertReference 走显式 span，与原生同路径",
)
check(
  '客户端用 captureInsertion 取 span',
  clientCode.includes('captureInsertion()'),
  'span 必须在插入时刻取（带 draftRev），否则被编辑器的 span-CAS 静默拒绝',
)
check(
  '客户端插入的是可编辑的提及',
  clientCode.includes('@['),
  '提及随用户消息一起发送，Host 侧 pre-step 解析后挂上下文',
)
check(
  '客户端实现了点外部关闭',
  clientCode.includes("addEventListener('pointerdown'") && clientCode.includes('contains('),
  '与内置 popupSelect 同一手法：capture 阶段 pointerdown + contains 检查',
)
check(
  '客户端实现了 Esc 关闭',
  clientCode.includes("addEventListener('keydown'"),
  '与官方 +技能 按钮一致',
)
check(
  '插件不注册任何 Host 斜杠命令',
  !existsSync(join(ROOT, 'src/commands.js')),
  'Host 命令无法从菜单隐藏——必须走路由',
)
const indexSrc = readFileSync(join(ROOT, 'src/index.js'), 'utf8')
check(
  'index.js 不依赖 commands 服务',
  !indexSrc.includes("'commands'"),
  '依赖 commands 会让插件注册 Host 命令进菜单',
)
check(
  'index.js 不再依赖 agents 服务',
  !indexSrc.includes("'agents'"),
  'pre-step 钩子直接拿到 agent 对象，不需要 ctx.agents',
)

console.log('\n5) 语法')
try {
  new Function(`return (${clientSrc.replace(/^window\./, 'globalThis.')})`)
  check('client.js 可解析', true)
} catch (e) {
  check('client.js 可解析', false, e.message)
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
