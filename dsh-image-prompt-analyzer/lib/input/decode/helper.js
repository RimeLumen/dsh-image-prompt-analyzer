
import { join } from 'node:path'

import { NULL_LOGGER } from '../../log.js'
import { DecodeError, suggestedFixFor } from './errors.js'

const HELPER_SEGMENTS = ['python', 'decode_helper.py']

const STDOUT_MAX_BYTES = 16 * 1024 * 1024
const STDERR_MAX_BYTES = 64 * 1024
const GRACE_MS = 2000

const DEFAULT_HELPER_TIMEOUT_MS = 30000

export function createHelperRunner({ ctx, pythonConfig, packageDir, logger = NULL_LOGGER }) {
  const helperPath = join(packageDir, ...HELPER_SEGMENTS)

  let resolvedExecutable = null

  function subprocessService() {
    const service = ctx?.subprocess
    if (!service || typeof service.spawn !== 'function') {
      throw new DecodeError(
        'PYTHON_UNAVAILABLE',
        '本机 DSH 没有提供 subprocess 服务，无法启动解码子进程。',
        null,
        '这属于宿主能力缺失：确认运行环境是完整的 DSH Desktop 而不是裁剪过的运行时。',
      )
    }
    return service
  }

  async function resolvePython(signal) {
    if (resolvedExecutable) return resolvedExecutable
    const service = subprocessService()
    const command = String(pythonConfig.executable || 'python')
    try {
      const resolved = await service.resolveExecutable(command, undefined, signal)
      if (!resolved || typeof resolved !== 'string') {
        throw new Error('解析结果为空')
      }
      resolvedExecutable = resolved
      return resolved
    } catch (error) {
      throw new DecodeError(
        'PYTHON_NOT_FOUND',
        `找不到 Python 解释器：${command}`,
        error?.message ?? String(error),
        '安装 Python 3 并确保它在 PATH 里，或把插件配置的 python.executable 指到解释器的绝对路径。',
      )
    }
  }

  async function callHelper(op, request, { signal, timeoutMs } = {}) {
    const service = subprocessService()
    const executable = await resolvePython(signal)
    const effectiveTimeoutMs = Math.max(1000, Number(timeoutMs) || DEFAULT_HELPER_TIMEOUT_MS)

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, effectiveTimeoutMs)

    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal

    let handle
    try {
      handle = service.spawn({
        argv: [executable, helperPath],
        cwd: packageDir,
        stdio: {
          stdin: { data: JSON.stringify({ op, ...request }) },
          stdout: { maxBytes: STDOUT_MAX_BYTES },
          stderr: { maxBytes: STDERR_MAX_BYTES },
        },
        graceMs: GRACE_MS,
        signal: combined,
      })
    } catch (error) {
      clearTimeout(timer)
      throw new DecodeError(
        'PYTHON_UNAVAILABLE',
        '启动解码子进程失败。',
        error?.message ?? String(error),
        '确认 python.executable 指向一个可执行文件，并且该文件对当前用户可执行。',
      )
    }

    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      throw new DecodeError(
        'PYTHON_UNAVAILABLE',
        '解码子进程异常退出。',
        error?.message ?? String(error),
        '重试一次；若持续失败，把插件日志里的 stderr 摘要一起报告。',
      )
    } finally {
      clearTimeout(timer)
    }

    const stdoutRead = handle.collected?.stdout?.readFrom(0) ?? null
    const stderrRead = handle.collected?.stderr?.readFrom(0) ?? null
    const stdoutText = stdoutRead?.text ?? ''
    const stderrText = (stderrRead?.text ?? '').trim()

    if (timedOut) {
      throw new DecodeError(
        'PYTHON_TIMEOUT',
        `解码子进程超过 ${Math.round(effectiveTimeoutMs / 1000)} 秒未返回。`,
        stderrText || null,
        '图片过大或磁盘过慢时会超时；可调大插件配置的 python.timeout_seconds，或先缩小图片。',
      )
    }

    if (stdoutRead?.lossy) {
      throw new DecodeError(
        'DECODE_HELPER_PROTOCOL_ERROR',
        '解码子进程的输出被截断，协议不可信。',
        `上限 ${STDOUT_MAX_BYTES} 字节，完整输出在 ${stdoutRead.spillPath ?? '未知位置'}`,
        '这通常意味着 helper 收到了异常巨大的输入或进入了死循环，请报告。',
      )
    }

    const trimmed = stdoutText.trim()
    if (trimmed.length === 0) {
      throw new DecodeError(
        'DECODE_HELPER_PROTOCOL_ERROR',
        '解码子进程没有输出任何内容。',
        stderrText || `退出码 ${outcome?.exitCode ?? '未知'}，信号 ${outcome?.signal ?? '无'}`,
        '确认 python.executable 是真正的 Python 3（而不是 Windows 的 py 启动器桩或商店别名）。',
      )
    }

    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      throw new DecodeError(
        'DECODE_HELPER_PROTOCOL_ERROR',
        '解码子进程的输出不是合法 JSON。',
        `${error?.message ?? error}；前 200 字节：${trimmed.slice(0, 200)}`,
        '常见原因是 python.executable 指向了别的程序，或环境里注入了会往 stdout 打印内容的启动脚本。',
      )
    }

    if (parsed?.ok === true) {
      if (stderrText) logger.debug(`解码 helper stderr：${stderrText}`)
      return parsed
    }

    const error = parsed?.error ?? {}
    throw new DecodeError(
      typeof error.code === 'string' && error.code.length > 0 ? error.code : 'INTERNAL_ERROR',
      typeof error.message === 'string' && error.message.length > 0 ? error.message : '解码失败。',
      error.detail ?? (stderrText || null),
      suggestedFixFor(error.code),
    )
  }

  return { helperPath, resolvePython, callHelper }
}
