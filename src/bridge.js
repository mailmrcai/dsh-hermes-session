/**
 * hermes_read.py 的 Node 侧桥：用子进程跑只读脚本，把 stdout 的单个 JSON 对象取回来。
 *
 * 为什么走子进程而不是在 Node 里直连 SQLite：
 *  - 不引入 better-sqlite3 之类的原生依赖（profile 里没有，且本机根分区可能只读）；
 *  - Python 标准库 sqlite3 已足够读，且与 hermes 同机，未来字段变化只改一处；
 *  - 只读语义最容易在 Python 侧用 `mode=ro` 明确表达。
 */
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 脚本随包发布，位置固定在 ../scripts/hermes_read.py。 */
export const SCRIPT_PATH = join(HERE, '..', 'scripts', 'hermes_read.py')

/** 一次读取失败：code 是稳定标识，hint 直接给模型/用户可操作的建议。 */
export class HermesReadError extends Error {
  constructor(message, { code = 'HERMES_READ_FAILED', hint } = {}) {
    super(message)
    this.name = 'HermesReadError'
    this.code = code
    this.hint = hint
  }
}

/**
 * 跑一次 hermes_read.py。
 *
 * @param {string[]} args  子命令与参数（不含脚本路径）
 * @param {{dbPath?: string, pythonPath?: string, signal?: AbortSignal, timeoutMs?: number}} options
 * @returns {Promise<object>} 脚本输出的 JSON 对象（ok:true 时）
 * @throws {HermesReadError} 脚本报告错误、退出码非零、超时或取消
 */
export function runHermesRead(args, options = {}) {
  const { dbPath, pythonPath, profile, signal, timeoutMs = 30_000 } = options
  const python = pythonPath || process.env.HERMES_PYTHON || 'python3'
  // 注意：--db / --profile 是 argparse 主命令的参数，必须放在子命令之前，
  // 否则 argparse 会报 unrecognized arguments。之前只在 dbPath 非空时才触发这个坑。
  const global = []
  if (dbPath) global.push('--db', dbPath)
  if (profile) global.push('--profile', profile)
  const argv = [SCRIPT_PATH, ...global, ...args]

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }

    const child = execFile(
      python,
      argv,
      { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs, signal, windowsHide: true },
      (error, stdout, stderr) => {
        if (signal && signal.aborted) {
          return finish(
            reject,
            new HermesReadError('hermes 读取被取消。', { code: 'HERMES_READ_CANCELLED' }),
          )
        }
        if (error && error.killed) {
          return finish(
            reject,
            new HermesReadError(`hermes 读取超时（>${timeoutMs}ms）。`, {
              code: 'HERMES_READ_TIMEOUT',
              hint: '换个更小的 maxMessages / maxChars 重试，或确认 hermes 进程没有长时间持有数据库锁。',
            }),
          )
        }
        if (error && error.code === 'ENOENT') {
          return finish(
            reject,
            new HermesReadError(`找不到 Python 解释器：${python}`, {
              code: 'HERMES_PYTHON_MISSING',
              hint: '把插件 config 的 pythonPath 指向可用的 python3（需要标准库 sqlite3）。',
            }),
          )
        }
        // 脚本自己会把错误写成 JSON 并给非零退出码；优先解析 stdout。
        const parsed = tryParseJson(stdout)
        if (parsed && parsed.ok === false) {
          const e = parsed.error || {}
          return finish(
            reject,
            new HermesReadError(e.message || 'hermes 读取失败。', { code: e.code, hint: e.hint }),
          )
        }
        if (parsed && parsed.ok === true) return finish(resolve, parsed)
        if (error) {
          const detail = (stderr || stdout || error.message || '').toString().trim().slice(0, 1200)
          return finish(
            reject,
            new HermesReadError(`hermes_read.py 执行失败：${detail || error.message}`, {
              code: 'HERMES_SCRIPT_FAILED',
              hint: '直接跑 `python3 scripts/hermes_read.py list` 看完整错误。',
            }),
          )
        }
        return finish(
          reject,
          new HermesReadError('hermes_read.py 没有返回可解析的 JSON。', {
            code: 'HERMES_BAD_OUTPUT',
          }),
        )
      },
    )

    // 子进程自然退出；上面回调统一收口。这里只挡住未捕获的 stream 错误。
    child.on('error', (err) => {
      finish(
        reject,
        new HermesReadError(`无法启动 hermes 读取进程：${err.message}`, {
          code: 'HERMES_SPAWN_FAILED',
        }),
      )
    })
  })
}

function tryParseJson(text) {
  const s = (text || '').trim()
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    // 脚本可能在前面打印了别的行；取最后一个能解析的 JSON 行。
    const lines = s.split('\n').filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i])
      } catch {
        /* keep scanning */
      }
    }
    return null
  }
}
