
// 测试用的内存文件系统与假 fetch。
// 它们只证明本地逻辑与协议处理正确，不代表真实 ComfyUI 已经跑通。

function normalize(path) {
  return String(path).replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * tree 形如：
 *   { 'D:/root/models/checkpoints': { type: 'directory' },
 *     'D:/root/models/checkpoints/a.safetensors': { type: 'file', size: 12 } }
 * 可选 symlinks: { 'D:/root/link': 'D:/outside' }，deny: ['D:/root/secret'] 模拟权限拒绝。
 */
export function createMemoryFs({ tree = {}, symlinks = {}, deny = [] } = {}) {
  const nodes = new Map()
  for (const [path, info] of Object.entries(tree)) {
    nodes.set(normalize(path), { ...info, type: info.type ?? 'file' })
  }
  const links = new Map()
  for (const [path, target] of Object.entries(symlinks)) {
    links.set(normalize(path), normalize(target))
  }
  const denied = new Set(deny.map(normalize))

  const stats = { resolveCalls: 0, listCalls: 0, readCalls: 0 }

  function targetOf(path) {
    const key = normalize(path)
    return { targetKey: key, displayPath: key }
  }

  function infoOf(path) {
    const key = normalize(path)
    if (links.has(key)) {
      const real = links.get(key)
      const info = nodes.get(real)
      return info ? { ...info, type: info.type } : null
    }
    return nodes.get(key) ?? null
  }

  const adapter = {
    available: true,
    stats,
    async resolve(path) {
      stats.resolveCalls += 1
      const key = normalize(path)
      if (!nodes.has(key) && !links.has(key)) {
        const error = new Error(`ENOENT: ${path}`)
        error.code = 'ENOENT'
        throw error
      }
      if (denied.has(key)) {
        const error = new Error(`EACCES: ${path}`)
        error.code = 'EACCES'
        throw error
      }
      // 符号链接解析到真实路径，越界的判断交给 contains()。
      return targetOf(links.has(key) ? links.get(key) : key)
    },
    async stat(target) {
      const info = infoOf(target.targetKey)
      if (!info) return undefined
      return { version: 'v1', type: info.type, size: info.size }
    },
    async lstat(path) {
      const key = normalize(path)
      if (links.has(key)) return { version: 'v1', type: 'symlink' }
      const info = nodes.get(key)
      return info ? { version: 'v1', type: info.type, size: info.size } : undefined
    },
    async listDir(target) {
      stats.listCalls += 1
      const parent = target.targetKey
      if (denied.has(parent)) {
        const error = new Error(`EACCES: ${parent}`)
        error.code = 'EACCES'
        throw error
      }
      const names = new Map()
      for (const key of [...nodes.keys(), ...links.keys()]) {
        if (!key.startsWith(`${parent}/`)) continue
        const rest = key.slice(parent.length + 1)
        if (rest.includes('/')) continue
        const info = infoOf(key)
        if (!info) continue
        const isLink = links.has(key)
        names.set(rest, {
          name: rest,
          // 链接的"类型"按它指向的东西算，这样扫描才会递归进去并触发越界判断。
          type: info.type,
          is_symlink: isLink,
          target: targetOf(isLink ? links.get(key) : key),
          version: 'v1',
          size: info.size,
        })
      }
      return [...names.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    },
    contains(parent, child) {
      const p = parent.targetKey
      const c = child.targetKey
      return c === p || c.startsWith(`${p}/`)
    },
    async readTextBounded(target) {
      stats.readCalls += 1
      const info = infoOf(target.targetKey)
      if (!info || info.type !== 'file') {
        const error = new Error('ENOENT')
        error.code = 'ENOENT'
        throw error
      }
      return info.text ?? ''
    },
    displayPath(target) {
      return target.displayPath
    },
    targetKey(target) {
      return target.targetKey
    },
  }
  return adapter
}

function jsonResponse(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    status,
    ok: status >= 200 && status < 300,
    body: {
      getReader() {
        let sent = false
        return {
          async read() {
            if (sent) return { done: true, value: undefined }
            sent = true
            return { done: false, value: new TextEncoder().encode(text) }
          },
          async cancel() {},
          releaseLock() {},
        }
      },
    },
  }
}

/**
 * routes: { '/system_stats': (init) => response | Error | Promise<...> }
 * 每次请求都记进 calls，用来断言"没有重发"。
 */
export function createFakeFetch(routes = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const pathname = new URL(String(url)).pathname
    calls.push({ pathname, method: init?.method ?? 'GET' })
    const handler = routes[pathname] ?? routes['*']
    if (!handler) return jsonResponse(404, { error: 'not found' })
    const result = await handler(init, pathname)
    if (result instanceof Error) throw result
    if (typeof result === 'string') return jsonResponse(200, result)
    if (result && typeof result.status === 'number') return result
    return jsonResponse(200, result)
  }
  return { fetchImpl, calls, jsonResponse }
}

export { jsonResponse }
