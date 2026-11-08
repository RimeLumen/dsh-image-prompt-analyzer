
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

  const stats = { resolveCalls: 0, listCalls: 0, readCalls: 0, writeCalls: 0 }
  const writes = []

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
    writes,
    async resolve(path) {
      stats.resolveCalls += 1
      const key = normalize(path)
      if (!nodes.has(key) && !links.has(key)) {
        // 真实 Host 的 resolve 是词法解析：路径不必存在，存在与否交给 stat 判。
        // 这里只在"连父目录都不存在"时才报错，否则 createIfAbsent 写入没有目标可用。
        const cut = key.lastIndexOf('/')
        const parent = cut > 0 ? nodes.get(key.slice(0, cut)) : null
        if (!parent || parent.type !== 'directory') {
          const error = new Error(`ENOENT: ${path}`)
          error.code = 'ENOENT'
          throw error
        }
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
    // Host fs 的真实方法名是 readText(target, signal)；适配器直接调它。
    async readText(target) {
      stats.readCalls += 1
      const info = infoOf(target.targetKey)
      if (!info || info.type !== 'file') {
        const error = new Error('ENOENT')
        error.code = 'ENOENT'
        throw error
      }
      return info.text ?? ''
    },
    // 旧名字保留：早期用例直接拿适配器的 readTextBounded 名字当 api 用。
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
    // 写能力按 Host fs 的真实签名模拟：expected 只有 createIfAbsent 一种意图，
    // 目标已存在就按真实实现那样报 EEXIST，绝不悄悄覆盖。
    async writeText(target, content, expected) {
      const key = target.targetKey
      stats.writeCalls += 1
      if (denied.has(key)) {
        const error = new Error(`EACCES: ${key}`)
        error.code = 'EACCES'
        throw error
      }
      const existing = nodes.get(key)
      if (expected?.kind === 'createIfAbsent' && existing) {
        const error = new Error(`EEXIST: ${key}`)
        error.code = 'EEXIST'
        throw error
      }
      // 只记真正落盘的写入：被拒绝的那次不该在断言里算成一次写入。
      writes.push({ targetKey: key, content, expected })
      nodes.set(key, { type: 'file', text: content })
      return { operation: existing ? 'update' : 'create', version: 'v1', before: existing?.text ?? null, after: content }
    },
  }
  return adapter
}

/**
 * 造一段只有头部的 PNG：签名 + IHDR。取图预检只看文件头，不需要真的像素数据，
 * 但头部必须合法——这正是"不能只信 Content-Type"要验证的东西。
 */
export function pngBytes(width = 2, height = 2) {
  const header = new Uint8Array(33)
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  header.set([0x00, 0x00, 0x00, 0x0d], 8)
  header.set([0x49, 0x48, 0x44, 0x52], 12)
  const view = new DataView(header.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  header.set([0x08, 0x02, 0x00, 0x00, 0x00], 24)
  return header
}

export function imageResponse(bytes, mediaType = 'image/png') {
  return new Response(bytes, { status: 200, headers: { 'content-type': mediaType } })
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
 * 假的 subprocess 服务。只实现 T18 用到的 spawn：记下每次 argv，
 * 返回一个立刻退出（或挂住不退出）的句柄，好让测试分辨"打开了"和"还在跑"。
 */
export function createFakeSubprocess({ hang = false, exitCode = 0 } = {}) {
  const calls = []
  const handles = []
  return {
    calls,
    handles,
    spawn(spec) {
      calls.push(spec)
      let terminated = 0
      const handle = {
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        control: undefined,
        collected: { stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
        done: hang ? new Promise(() => {}) : Promise.resolve({ exitCode, signal: null }),
        terminate() {
          terminated += 1
        },
        waitForExit: async () => true,
        get terminateCalls() {
          return terminated
        },
      }
      handles.push(handle)
      return handle
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