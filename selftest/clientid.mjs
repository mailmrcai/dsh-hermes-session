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
  '客户端用 commandUi.register（contribution 才支持 icon）',
  clientCode.includes('command.register('),
  'decorate 没有 icon 字段',
)
check(
  '客户端声明了 icon',
  clientCode.includes('icon:'),
  '菜单图标来自 CommandContribution.icon',
)
check(
  '客户端从平台 seed 取图标',
  clientCode.includes("require('@deepseek-ai/dsh-client-ui-primitives')"),
  'ui-primitives 是 Web shell 的 staticModules seed，require 即得',
)

console.log('\n4) Host 侧只注册 HTTP 路由，不注册斜杠命令')
const { LIST_ROUTE, IMPORT_ROUTE } = await import(join(ROOT, 'src/routes.js'))
check('列表路由 === /api/hermes.sessions', LIST_ROUTE === '/api/hermes.sessions', LIST_ROUTE)
check('导入路由 === /api/hermes.import', IMPORT_ROUTE === '/api/hermes.import', IMPORT_ROUTE)
check(
  '客户端用的路由与 Host 一致',
  clientCode.includes(LIST_ROUTE.replace('/api/', 'api/')) &&
    clientCode.includes(IMPORT_ROUTE.replace('/api/', 'api/')),
  '客户端应调 document-relative 的同名路由',
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
  'index.js 声明了 agents 依赖',
  indexSrc.includes("'agents'"),
  '注入当前轮需要 ctx.agents.get(sessionId)——没声明依赖时 ctx.agents 是 undefined',
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
