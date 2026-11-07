
import { COMFY_CODES, ComfyError } from './errors.js'

export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1', 'localhost', '[::1]'])
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
export const DEFAULT_TIMEOUT_MS = 30000
/** 建运行时模型索引时最多查多少个分类，防止插件众多的实例把一次调用拖成几分钟。 */
export const MAX_MODEL_CATEGORIES = 256

/**
 * 只接受 loopback 的 http URL。
 * 这里不做"失败就回退默认值"的处理：非法地址必须原样报错，让上层决定禁用。
 */
export function assertLoopbackUrl(raw) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    throw new ComfyError(COMFY_CODES.TARGET_NOT_LOCAL, `不是合法 URL：${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ComfyError(COMFY_CODES.TARGET_NOT_LOCAL, `只允许 http/https：${raw}`)
  }
  if (url.username || url.password) {
    throw new ComfyError(COMFY_CODES.TARGET_NOT_LOCAL, 'URL 里不允许内嵌凭据。')
  }
  const host = url.hostname
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new ComfyError(
      COMFY_CODES.TARGET_NOT_LOCAL,
      `只允许本机地址，收到 ${host}。`,
      '把 baseUrl 改成 http://127.0.0.1:8188 这类本机地址。',
    )
  }
  if (url.search || url.hash) {
    throw new ComfyError(COMFY_CODES.TARGET_NOT_LOCAL, 'baseUrl 不应带查询串或锚点。')
  }
  return url
}

const ALLOWED_PATHS = [
  /^\/system_stats$/,
  /^\/models$/,
  // server.py:415 `@routes.get("/models/{folder}")`，folder 必须是已注册的分类名。
  /^\/models\/[A-Za-z0-9_.-]+$/,
  /^\/object_info$/,
  /^\/object_info\/[A-Za-z0-9_.-]+$/,
  /^\/queue$/,
  /^\/history\/[A-Za-z0-9_-]+$/,
  /^\/prompt$/,
  /^\/view$/,
]

function assertAllowedPath(pathname) {
  for (const pattern of ALLOWED_PATHS) {
    if (pattern.test(pathname)) return
  }
  throw new ComfyError(
    COMFY_CODES.BAD_RESPONSE,
    `不在允许列表里的接口路径：${pathname}`,
  )
}

/**
 * Node 24 在 `NODE_USE_ENV_PROXY=1` 时会把 fetch 交给环境代理，
 * 连 127.0.0.1 也会被塞进代理——能不能直连完全取决于 NO_PROXY 有没有排除本机。
 * 一旦本机地址走了代理，请求实际发给了谁就不再可控，所以这里直接拒绝。
 */
export function assertLoopbackNotProxied(hostname, { env = process.env, allowProxy = false } = {}) {
  if (allowProxy) return true
  const proxy =
    env.http_proxy ?? env.HTTP_PROXY ?? env.all_proxy ?? env.ALL_PROXY ?? env.https_proxy ?? env.HTTPS_PROXY
  if (!proxy) return true
  const bypass = String(env.no_proxy ?? env.NO_PROXY ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  const host = String(hostname).replace(/^\[|\]$/g, '').toLowerCase()
  const covered = bypass.some(
    (item) => item === '*' || item === host || (item.startsWith('.') && host.endsWith(item)),
  )
  if (covered) return true
  throw new ComfyError(
    COMFY_CODES.CAPABILITY_UNAVAILABLE,
    `检测到环境代理 ${proxy}，而 no_proxy 没有排除本机地址 ${host}：请求可能被代理转发出去。`,
    `把 ${host} 加入 no_proxy，或在不设代理的环境里运行。`,
  )
}

async function readBounded(response, maxBytes) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new ComfyError(
          COMFY_CODES.BAD_RESPONSE,
          `响应超过 ${maxBytes} 字节上限。`,
        )
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock?.()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8').decode(merged)
}

function combineSignals(signal, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  timer.unref?.()
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    },
  }
}

/**
 * ComfyUI 本机 HTTP 客户端。
 *
 * 三条纪律写死在实现里：
 *   1. 只连 loopback，路径必须在白名单内；
 *   2. 重定向直接判失败（redirect: 'error'），不跟随到别的地址；
 *   3. POST 永不重试——请求一旦发出，结果未知就是未知。
 */
export function createComfyClient(options = {}) {
  const {
    baseUrl = 'http://127.0.0.1:8188',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    fetchImpl = globalThis.fetch,
    getRetries = 2,
    env = process.env,
    allowProxy = false,
  } = options

  const base = assertLoopbackUrl(baseUrl)
  assertLoopbackNotProxied(base.hostname, { env, allowProxy })
  if (typeof fetchImpl !== 'function') {
    throw new ComfyError(COMFY_CODES.CAPABILITY_UNAVAILABLE, '当前运行时没有 fetch。')
  }

  async function once(method, pathname, { body = null, signal = null, timeoutOverride = null } = {}) {
    assertAllowedPath(pathname)
    const url = new URL(pathname, base)
    // URL 构造会把 `/models/..` 这类路径归一成 `/`。对归一后的路径再查一次，
    // 保证真正发出去的请求路径也在白名单里，而不是只查了字符串入参。
    assertAllowedPath(url.pathname)
    const budget = combineSignals(signal, timeoutOverride ?? timeoutMs)
    try {
      const response = await fetchImpl(url, {
        method,
        // redirect:'error' 会让任何 3xx 变成异常，而不是静默跟到新地址。
        redirect: 'error',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: budget.signal,
      })
      const text = await readBounded(response, maxResponseBytes)
      return { status: response.status, ok: response.ok, text }
    } catch (error) {
      if (error instanceof ComfyError) throw error
      const aborted = budget.timedOut() || error?.name === 'AbortError'
      throw new ComfyError(
        COMFY_CODES.CONNECTION_FAILED,
        aborted ? `请求超时（${timeoutMs}ms）：${pathname}` : `连接失败：${error?.message ?? error}`,
        '确认 ComfyUI 正在运行，且 baseUrl 指向它的本机端口。',
      )
    } finally {
      budget.cleanup()
    }
  }

  function parseJson(text, pathname) {
    try {
      return JSON.parse(text)
    } catch {
      throw new ComfyError(COMFY_CODES.BAD_RESPONSE, `${pathname} 返回的不是合法 JSON。`)
    }
  }

  async function request(method, pathname, options = {}) {
    const isGet = method === 'GET'
    const attempts = isGet ? Math.max(1, getRetries + 1) : 1
    let lastError = null
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const result = await once(method, pathname, options)
        if (result.status === 0) throw new ComfyError(COMFY_CODES.CONNECTION_FAILED, '空响应')
        return result
      } catch (error) {
        lastError = error
        // 只有 GET 的连接类失败值得重试；POST 一次就是一次。
        if (!isGet || error.code !== COMFY_CODES.CONNECTION_FAILED) throw error
        if (options.signal?.aborted) throw error
      }
    }
    throw lastError
  }

  async function getJson(pathname, options) {
    const result = await request('GET', pathname, options)
    if (!result.ok) {
      throw new ComfyError(COMFY_CODES.BAD_RESPONSE, `${pathname} 返回 HTTP ${result.status}。`)
    }
    return parseJson(result.text, pathname)
  }

  function assertStringArray(value, pathname) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new ComfyError(COMFY_CODES.BAD_RESPONSE, `${pathname} 结构异常：应为字符串数组。`)
    }
    return value
  }

  return {
    baseUrl: base.origin,
    getJson,
    async postJson(pathname, payload, options) {
      return request('POST', pathname, { ...options, body: payload })
    },
    async getSystemStats(options) {
      const data = await getJson('/system_stats', options)
      if (!data || typeof data !== 'object') {
        throw new ComfyError(COMFY_CODES.BAD_RESPONSE, '/system_stats 结构异常。')
      }
      return data
    },
    /**
     * `GET /models` 在 server.py:409-413 里返回的是 `list(folder_names_and_paths.keys())`，
     * 也就是分类名数组——不是分类到文件的映射。分类下的文件名要再逐类查。
     */
    async getModelCategories(options) {
      return assertStringArray(await getJson('/models', options), '/models')
    },
    /**
     * `GET /models/{folder}` 在 server.py:415-421：未注册的分类直接 404。
     * 返回 null 表示"这个分类在当前运行时里不存在"，不是错误。
     */
    async getModelFiles(category, options) {
      const raw = String(category)
      // `.`/`..` 能通过白名单正则，但会在 URL 归一里跳出 /models/ 前缀。
      if (raw === '.' || raw === '..') {
        throw new ComfyError(COMFY_CODES.BAD_RESPONSE, `分类名不合法：${raw}`)
      }
      const safe = encodeURIComponent(raw)
      const result = await request('GET', `/models/${safe}`, options)
      if (result.status === 404) return null
      if (!result.ok) {
        throw new ComfyError(COMFY_CODES.BAD_RESPONSE, `/models/${category} 返回 HTTP ${result.status}。`)
      }
      return assertStringArray(parseJson(result.text, `/models/${category}`), `/models/${category}`)
    },
    /**
     * 把运行时模型索引一次建好：分类 -> 文件名数组。
     * 单个分类取不到时跳过并记录，不让一个分类拖垮整份索引。
     */
    async getModels(options = {}) {
      const categories = await this.getModelCategories(options)
      const files = {}
      const missing = []
      const failures = []
      for (const category of categories.slice(0, MAX_MODEL_CATEGORIES)) {
        if (options.signal?.aborted) break
        try {
          const names = await this.getModelFiles(category, options)
          if (names === null) missing.push(category)
          else files[category] = names
        } catch (error) {
          failures.push({ category, code: error?.code ?? null, message: error?.message ?? String(error) })
        }
      }
      return { categories, files, missing, failures, truncated: categories.length > MAX_MODEL_CATEGORIES }
    },
    async getObjectInfo(options) {
      const data = await getJson('/object_info', options)
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new ComfyError(COMFY_CODES.BAD_RESPONSE, '/object_info 结构异常。')
      }
      return data
    },
    /**
     * 未知节点会返回 HTTP 200 + `{}`。所以"节点存在"必须靠内容判断，
     * 不能靠状态码。返回 null 表示这个节点在当前 ComfyUI 上不可用。
     */
    async getObjectInfoFor(nodeClass, options) {
      const safe = encodeURIComponent(String(nodeClass))
      const result = await request('GET', `/object_info/${safe}`, options)
      if (!result.ok) {
        throw new ComfyError(COMFY_CODES.BAD_RESPONSE, `/object_info/${nodeClass} 返回 HTTP ${result.status}。`)
      }
      const data = parseJson(result.text, `/object_info/${nodeClass}`)
      if (!data || typeof data !== 'object') {
        throw new ComfyError(COMFY_CODES.BAD_RESPONSE, `/object_info/${nodeClass} 结构异常。`)
      }
      const entry = data[nodeClass]
      if (!entry || typeof entry !== 'object') return null
      return entry
    },
    async getQueue(options) {
      const data = await this.getJson('/queue', options)
      if (!data || typeof data !== 'object') {
        throw new ComfyError(COMFY_CODES.BAD_RESPONSE, '/queue 结构异常。')
      }
      return data
    },
    async getHistory(promptId, options) {
      const safe = encodeURIComponent(String(promptId))
      const data = await this.getJson(`/history/${safe}`, options)
      if (!data || typeof data !== 'object') {
        throw new ComfyError(COMFY_CODES.BAD_RESPONSE, '/history 结构异常。')
      }
      return data
    },
    viewUrl({ filename, subfolder = '', type = 'output' }) {
      const params = new URLSearchParams({ filename, subfolder, type })
      return new URL(`/view?${params.toString()}`, base).toString()
    },
    /**
     * 取一张输出图。走 /view 的合法参数，不碰任何本地路径——
     * ComfyUI 在别的机器上时本地路径根本不存在，读文件是错的。
     */
    async fetchImage({ filename, subfolder = '', type = 'output' }, options = {}) {
      const params = new URLSearchParams({ filename, subfolder, type })
      const budget = combineSignals(options.signal ?? null, options.timeoutOverride ?? timeoutMs)
      try {
        const response = await fetchImpl(new URL(`/view?${params.toString()}`, base), {
          method: 'GET',
          redirect: 'error',
          signal: budget.signal,
        })
        if (!response.ok) {
          throw new ComfyError(
            COMFY_CODES.OUTPUT_UNAVAILABLE,
            `/view 返回 HTTP ${response.status}：${filename}`,
            '确认任务已完成，且文件名与子目录来自 /history 的真实输出。',
          )
        }
        const mediaType = (response.headers.get('content-type') ?? '').split(';')[0].trim()
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (bytes.byteLength === 0) {
          throw new ComfyError(COMFY_CODES.OUTPUT_UNAVAILABLE, `/view 返回空内容：${filename}`)
        }
        if (bytes.byteLength > maxResponseBytes) {
          throw new ComfyError(
            COMFY_CODES.OUTPUT_UNAVAILABLE,
            `图片超过上限（${bytes.byteLength} > ${maxResponseBytes} 字节）。`,
          )
        }
        return { bytes, mediaType: mediaType || 'image/png', filename }
      } catch (error) {
        if (error instanceof ComfyError) throw error
        const aborted = budget.timedOut() || error?.name === 'AbortError'
        throw new ComfyError(
          COMFY_CODES.OUTPUT_UNAVAILABLE,
          aborted ? `取图超时（${timeoutMs}ms）：${filename}` : `取图失败：${error?.message ?? error}`,
        )
      } finally {
        budget.cleanup()
      }
    },
  }
}
