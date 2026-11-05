
import { COMFY_CODES, ComfyError } from './errors.js'

// Host fs 的已知错误码（来自实际契约，不靠猜）。只做归类，不改写原始信息。
const MISSING_CODES = new Set(['ENOENT', 'FS_NOT_FOUND', 'FS_NO_SUCH_FILE', 'FS_PATH_MISSING'])
const DENIED_CODES = new Set(['EACCES', 'EPERM', 'FS_DENIED', 'FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED'])
const UNRESOLVED_CODES = new Set(['EINVAL', 'ENOTDIR', 'FS_INVALID_PATH', 'FS_PATH_INVALID', 'ERR_INVALID_ARG_TYPE'])
const TOO_LARGE_CODES = new Set(['FS_TOO_LARGE', 'EFBIG'])

/** 把任意 fs 层异常收敛成带 COMFY_* 码的 ComfyError。 */
export function mapFsError(error, { path = null, action = '访问' } = {}) {
  if (error instanceof ComfyError) return error
  const code = String(error?.code ?? '')
  const detail = error?.message ?? String(error)
  const where = path ? `路径 ${path}` : '目标'
  if (MISSING_CODES.has(code)) {
    return new ComfyError(COMFY_CODES.PATH_MISSING, `${where} 不存在（${action}）。`, undefined)
  }
  if (DENIED_CODES.has(code)) {
    // 权限拒绝是终点：绝不在这里换一个接口重试同一个路径。
    return new ComfyError(COMFY_CODES.PATH_DENIED, `${where} 访问被拒绝（${action}）：${detail}`, undefined)
  }
  if (TOO_LARGE_CODES.has(code)) {
    return new ComfyError(COMFY_CODES.PATH_UNRESOLVED, `${where} 超过允许的大小上限（${action}）。`, undefined)
  }
  if (UNRESOLVED_CODES.has(code)) {
    return new ComfyError(COMFY_CODES.PATH_UNRESOLVED, `${where} 无法解析（${action}）：${detail}`, undefined)
  }
  return new ComfyError(COMFY_CODES.PATH_UNRESOLVED, `${where} 读取失败（${action}）：${detail}`, undefined)
}

export const DEFAULT_MAX_TEXT_BYTES = 4 * 1024 * 1024

/**
 * Host fs 适配器。
 *
 * 这里只包装 T00 实测过的 ctx.fs 方法，绝不 import node:fs 兜底：
 * 权限拒绝之后换一个接口重读同一个路径，等于绕过宿主授权。
 * 也绝不伪造 mtime——Host 契约里没有时间戳，只有 FsVersion 与 size。
 */
export function createFsAdapter(ctx) {
  const fs = ctx?.fs ?? null
  const available = Boolean(
    fs && typeof fs.resolve === 'function' && typeof fs.stat === 'function' && typeof fs.listDir === 'function',
  )

  function requireFs() {
    if (!available) {
      throw new ComfyError(
        COMFY_CODES.CAPABILITY_UNAVAILABLE,
        '当前 profile 没有挂载 fs 服务，ComfyUI 无法读取模型目录。',
      )
    }
    return fs
  }

  return {
    available,

    async resolve(path, { signal } = {}) {
      const api = requireFs()
      if (typeof path !== 'string' || path.trim() === '') {
        throw new ComfyError(COMFY_CODES.PATH_UNRESOLVED, `需要非空路径，收到 ${JSON.stringify(path)}。`)
      }
      try {
        return await api.resolve(path, signal ? { signal } : undefined)
      } catch (error) {
        throw mapFsError(error, { path, action: '解析路径' })
      }
    },

    /** 返回 undefined 表示不存在；符号链接被 lstat 保留为 symlink 类型。 */
    async stat(target, { signal } = {}) {
      const api = requireFs()
      try {
        return (await api.stat(target, signal)) ?? null
      } catch (error) {
        throw mapFsError(error, { path: target?.displayPath, action: '读取元数据' })
      }
    },

    async lstat(path, { signal } = {}) {
      const api = requireFs()
      if (typeof api.lstat !== 'function') {
        throw new ComfyError(
          COMFY_CODES.CAPABILITY_UNAVAILABLE,
          '当前 fs 服务没有提供 lstat，无法判断符号链接。',
        )
      }
      try {
        return (await api.lstat(path, undefined, signal)) ?? null
      } catch (error) {
        throw mapFsError(error, { path, action: '读取链接元数据' })
      }
    },

    async listDir(target, { signal } = {}) {
      const api = requireFs()
      try {
        const entries = await api.listDir(target, signal)
        return Array.isArray(entries) ? entries : []
      } catch (error) {
        throw mapFsError(error, { path: target?.displayPath, action: '枚举目录' })
      }
    },

    /** canonical containment；不做字符串前缀比较。 */
    contains(parent, child) {
      const api = requireFs()
      if (typeof api.contains !== 'function') return false
      try {
        return api.contains(parent, child) === true
      } catch {
        return false
      }
    },

    /** 有界读取：先看 size 再读，读的时候把上限一并交给宿主。 */
    async readTextBounded(target, { maxBytes = DEFAULT_MAX_TEXT_BYTES, signal } = {}) {
      const api = requireFs()
      const info = await this.stat(target, { signal })
      if (!info) {
        throw new ComfyError(COMFY_CODES.PATH_MISSING, `文件不存在：${target?.displayPath ?? ''}`)
      }
      if (typeof info.size === 'number' && info.size > maxBytes) {
        throw new ComfyError(
          COMFY_CODES.PATH_UNRESOLVED,
          `文件 ${target?.displayPath ?? ''} 有 ${info.size} 字节，超过上限 ${maxBytes}。`,
        )
      }
      try {
        if (typeof api.readBytes === 'function') {
          const bytes = await api.readBytes(target, signal, maxBytes)
          return new TextDecoder('utf-8').decode(bytes)
        }
        return await api.readText(target, signal)
      } catch (error) {
        throw mapFsError(error, { path: target?.displayPath, action: '读取文本' })
      }
    },

    displayPath(target) {
      return target?.displayPath ?? null
    },

    targetKey(target) {
      return target?.targetKey ?? null
    },
  }
}
