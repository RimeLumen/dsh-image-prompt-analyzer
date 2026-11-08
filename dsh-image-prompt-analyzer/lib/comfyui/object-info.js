import { COMFY_CODES, ComfyError } from './errors.js'
import { enumOptionsOf } from './patch.js'

/**
 * /object_info 的进程内缓存与投影。
 *
 * ComfyUI 的 /object_info/{node} 一次只认一个节点名（没有逗号批量），
 * 而一次生图会反复问到同几个 loader。全量 /object_info 有几十个节点、
 * 单节点还能带上百个模型选项，两者都不该原样进对话。
 *
 * 所以：完整节点定义留在缓存里，对外只给投影后的摘要。
 */

export const DEFAULT_OBJECT_INFO_TTL_MS = 5 * 60 * 1000
export const MAX_CACHED_NODES = 256
export const MAX_OPTIONS_SHOWN = 12

export function createObjectInfoCache({ ttlMs = DEFAULT_OBJECT_INFO_TTL_MS, maxNodes = MAX_CACHED_NODES, now = () => Date.now() } = {}) {
  const entries = new Map()
  const stats = { hits: 0, misses: 0, expired: 0, fetches: 0, negatives: 0 }
  let baseUrl = null

  function dropExpired(at) {
    for (const [key, entry] of entries) {
      if (at - entry.at > ttlMs) {
        entries.delete(key)
        stats.expired += 1
      }
    }
  }

  return {
    ttlMs,
    maxNodes,
    get baseUrl() {
      return baseUrl
    },
    /** 换一个 ComfyUI 实例（哪怕同端口换了进程）就整体作废，避免把旧定义套到新节点上。 */
    bind(nextBaseUrl) {
      if (baseUrl === nextBaseUrl) return false
      baseUrl = nextBaseUrl ?? null
      entries.clear()
      return true
    },
    stats() {
      return { ...stats, size: entries.size, ttl_ms: ttlMs }
    },
    /**
     * 三种返回要分清：undefined = 没缓存过（该去问一次），
     * null = 缓存过、服务端说没有这个节点（不该再问），对象 = 节点定义。
     * 混成一种的话，负缓存就永远命不中，同一个不存在的节点会被反复请求。
     */
    get(node) {
      const entry = entries.get(node)
      if (!entry) {
        stats.misses += 1
        return undefined
      }
      if (now() - entry.at > ttlMs) {
        entries.delete(node)
        stats.expired += 1
        stats.misses += 1
        return undefined
      }
      stats.hits += 1
      return entry.info
    },
    set(node, info) {
      const at = now()
      dropExpired(at)
      // 满了先清过期，还满就按插入顺序丢最旧的：缓存只为省请求，不该无限长。
      if (!entries.has(node) && entries.size >= maxNodes) {
        const oldest = entries.keys().next()
        if (!oldest.done) entries.delete(oldest.value)
      }
      entries.set(node, { info, at })
      if (info === null) stats.negatives += 1
      return info
    },
    invalidate(node) {
      if (node === undefined) {
        entries.clear()
        return
      }
      entries.delete(node)
    },
    keys() {
      return [...entries.keys()]
    },
  }
}

/**
 * 按需取节点定义：命中缓存就不发请求，未命中只问这一个节点。
 * 未知节点（服务端回 {}）也缓存，否则每轮都要为同一个不存在节点付一次请求。
 */
export async function fetchNodeInfos({ client, cache, classTypes, signal = null, refresh = false } = {}) {
  const wanted = [...new Set((classTypes ?? []).filter((item) => typeof item === 'string' && item.trim() !== ''))]
  const byClass = new Map()
  const missing = []
  const failures = []
  let fetched = 0

  if (wanted.length === 0) return { byClass, missing, failures, fetched, hits: 0 }

  cache.bind(client.baseUrl)

  for (const classType of wanted) {
    const cached = refresh ? undefined : cache.get(classType)
    if (cached !== undefined) {
      // 负缓存也算命中：服务端上次就说没有，别为同一个名字反复付一次请求。
      if (cached) byClass.set(classType, cached)
      else missing.push(classType)
      continue
    }
    try {
      const info = await client.getObjectInfoFor(classType, { signal })
      fetched += 1
      statsNote(cache, refresh)
      cache.set(classType, info ?? null)
      if (info) byClass.set(classType, info)
      else missing.push(classType)
    } catch (error) {
      // 一个节点取不到不该让整次校验失败：把它记下来，其余节点照常。
      failures.push({
        class_type: classType,
        error_code: error?.code ?? COMFY_CODES.CONNECTION_FAILED,
        message: error?.message ?? String(error),
      })
    }
  }

  return { byClass, missing, failures, fetched, hits: wanted.length - fetched }
}

function statsNote(cache, refresh) {
  if (refresh && typeof cache.noteRefresh === 'function') cache.noteRefresh()
}

export function typeNameOfSpec(spec) {
  if (!Array.isArray(spec)) return 'UNKNOWN'
  if (Array.isArray(spec[0])) return 'COMBO'
  return typeof spec[0] === 'string' ? spec[0] : 'UNKNOWN'
}

export function enumOptionsFromSpec(spec) {
  const options = enumOptionsOf(spec)
  return Array.isArray(options) ? options : null
}

/**
 * 一个输入的紧凑描述。COMBO 只报总数与前几个样例：
 * 模型选择器动辄上百项，全量回灌等于把缓存白做了。
 */
export function describeInput(name, spec, { maxOptions = MAX_OPTIONS_SHOWN } = {}) {
  const type = typeNameOfSpec(spec)
  const meta = Array.isArray(spec) && spec.length > 1 && spec[1] && typeof spec[1] === 'object' ? spec[1] : {}
  const out = { name, type }
  if (meta.required === false || meta.optional === true) out.required = false
  if (Array.isArray(spec) && spec.length > 2) out.mode = spec[2]
  if (type === 'COMBO') {
    const options = enumOptionsFromSpec(spec) ?? []
    out.options_count = options.length
    out.options = options.slice(0, maxOptions)
    if (options.length > maxOptions) out.options_truncated = true
  }
  if (typeof meta.min === 'number') out.min = meta.min
  if (typeof meta.max === 'number') out.max = meta.max
  if (typeof meta.default === 'number' || typeof meta.default === 'string' || typeof meta.default === 'boolean') {
    out.default = meta.default
  }
  return out
}

/** 节点定义的紧凑投影：只要"存不存在、必填什么、有哪些可选项"。 */
export function projectNodeInfo(nodeInfo, { maxOptions = MAX_OPTIONS_SHOWN } = {}) {
  if (!nodeInfo || typeof nodeInfo !== 'object') return null
  const requiredSpecs = nodeInfo.input?.required ?? {}
  const optionalSpecs = nodeInfo.input?.optional ?? {}
  const order = Array.isArray(nodeInfo.input_order) ? nodeInfo.input_order : []
  const required = Object.entries(requiredSpecs).map(([name, spec]) => describeInput(name, spec, { maxOptions }))
  const optional = Object.entries(optionalSpecs).map(([name, spec]) => describeInput(name, spec, { maxOptions }))
  if (order.length > 0) {
    const rank = new Map(order.map((name, index) => [name, index]))
    const sortByOrder = (a, b) => (rank.get(a.name) ?? 999) - (rank.get(b.name) ?? 999)
    required.sort(sortByOrder)
    optional.sort(sortByOrder)
  }
  return {
    class_type: nodeInfo.name ?? null,
    display_name: nodeInfo.display_name ?? null,
    category: nodeInfo.category ?? null,
    output_node: nodeInfo.output_node === true,
    required,
    optional,
    input_order: order,
  }
}

/** 某个节点上某个输入的候选值，用于校验模型名是否真的可选。 */
export function optionsForInput(nodeInfo, field) {
  const spec = nodeInfo?.input?.required?.[field] ?? nodeInfo?.input?.optional?.[field]
  if (!spec) return null
  return enumOptionsFromSpec(spec)
}

/** 在候选里找与用户所写最接近的几个，找不到时给线索而不是空手而归。 */
export function suggestOptions(options, query, limit = 8) {
  const list = Array.isArray(options) ? options : []
  const raw = String(query ?? '').trim().toLowerCase()
  if (raw === '') return list.slice(0, limit)
  const stem = raw.replace(/\.[a-z0-9]+$/, '')
  const scored = []
  for (const option of list) {
    const value = String(option).toLowerCase()
    const optionStem = value.replace(/\.[a-z0-9]+$/, '')
    if (value === raw) scored.push({ option, score: 0 })
    else if (optionStem === stem) scored.push({ option, score: 1 })
    else if (value.includes(stem) || stem.includes(optionStem)) scored.push({ option, score: 2 })
    else if (optionStem.startsWith(stem.slice(0, 3))) scored.push({ option, score: 3 })
  }
  scored.sort((a, b) => a.score - b.score || String(a.option).localeCompare(String(b.option)))
  return scored.slice(0, limit).map((item) => item.option)
}

/** 校验失败时，把"这个名字到底存不存在"从三个来源分别说清楚。 */
export function explainOptionMiss({ value, options, category = null, catalog = null, runtimeFiles = null }) {
  const list = Array.isArray(options) ? options : []
  const lower = String(value ?? '').toLowerCase()
  const inOptions = list.some((item) => String(item).toLowerCase() === lower)
  const disk = catalog?.files?.some?.((item) => String(item).toLowerCase() === lower) ?? null
  const runtime = Array.isArray(runtimeFiles)
    ? runtimeFiles.some((item) => String(item).toLowerCase() === lower)
    : null
  return {
    value,
    category,
    in_loader_options: inOptions,
    disk_present: disk,
    runtime_visible: runtime,
    closest: suggestOptions(list, value, 5),
  }
}

export function requireNodeInfo(nodeInfo, classType) {
  if (nodeInfo) return nodeInfo
  throw new ComfyError(
    COMFY_CODES.CAPABILITY_UNAVAILABLE,
    `拿不到 ${classType} 的节点定义，无法校验它的输入。`,
    '确认 ComfyUI 在运行，并且这个节点真的装了。',
  )
}
