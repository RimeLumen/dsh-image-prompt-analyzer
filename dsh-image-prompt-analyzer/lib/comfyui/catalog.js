
import { COMFY_CODES } from './errors.js'
import { mapFsError } from './fs-adapter.js'
import { canonicalCategory } from './paths.js'

// 已知模型格式只用来打标记，不用来过滤：白名单之外的文件照样进结果，
// 否则用户自己起的扩展名会凭空消失，比"列出来但标 unknown"更糟。
export const KNOWN_MODEL_EXTENSIONS = Object.freeze([
  '.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf', '.onnx', '.sft', '.pkl', '.vae',
])

export const DEFAULT_SCAN_LIMITS = Object.freeze({
  maxDepth: 8,
  maxEntries: 20000,
  maxDirs: 2000,
})

export function extensionOf(name) {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot).toLowerCase()
}

function joinDisplay(base, child) {
  if (!base) return child
  const trimmed = base.replace(/[\\/]+$/, '')
  return `${trimmed}/${child}`
}

/**
 * 递归扫描一个根目录。只读元数据，绝不读文件内容。
 *
 * 三条安全线：
 *   1. 每个子项都用 Host 的 contains() 做 canonical 包含判断（不是字符串前缀）；
 *   2. 目录用 targetKey 去重，符号链接成环时不会无限递归；
 *   3. 深度、目录数、条目数都有上限，超了就停并如实标记。
 */
export async function scanRoot(fsAdapter, root, options = {}) {
  const {
    signal = null,
    maxDepth = DEFAULT_SCAN_LIMITS.maxDepth,
    maxEntries = DEFAULT_SCAN_LIMITS.maxEntries,
    maxDirs = DEFAULT_SCAN_LIMITS.maxDirs,
  } = options

  const entries = []
  const diagnostics = []
  const categories = new Set()
  let partial = false
  let cancelled = false

  // 分类要么由 YAML 明确给出，要么按 ComfyUI 的目录约定从 models/<分类>/ 的第一段推出。
  // 空分类目录也要记下来：用户需要看到"这里本该有模型但是空的"。
  const explicitCategory = root.category ?? null
  const categoryOf = (relative) => {
    if (explicitCategory) {
      return {
        category: canonicalCategory(explicitCategory),
        category_raw: root.category_raw ?? explicitCategory,
      }
    }
    const cut = relative.indexOf('/')
    if (cut <= 0) return { category: null, category_raw: null }
    const raw = relative.slice(0, cut)
    return { category: canonicalCategory(raw), category_raw: raw }
  }

  let rootTarget
  try {
    rootTarget = await fsAdapter.resolve(root.path, { signal })
  } catch (error) {
    return {
      entries,
      categories: [],
      diagnostics: [toScanDiagnostic(error, root, '解析根目录')],
      partial: true,
      cancelled: false,
    }
  }

  const rootInfo = await fsAdapter.stat(rootTarget, { signal }).catch(() => null)
  if (!rootInfo) {
    return {
      entries,
      categories: [],
      diagnostics: [
        {
          error_code: COMFY_CODES.PATH_MISSING,
          field_path: root.path,
          message: `模型根目录不存在：${root.path}`,
          suggested_fix: '检查配置里的路径拼写，或把它从配置里去掉。',
        },
      ],
      partial: true,
      cancelled: false,
    }
  }
  if (rootInfo.type !== 'directory') {
    return {
      entries,
      categories: [],
      diagnostics: [
        {
          error_code: COMFY_CODES.PATH_UNRESOLVED,
          field_path: root.path,
          message: `模型根路径不是目录：${root.path}`,
          suggested_fix: '把配置改成目录路径。',
        },
      ],
      partial: true,
      cancelled: false,
    }
  }

  const seenDirs = new Set([fsAdapter.targetKey(rootTarget)])
  const stack = [{ target: rootTarget, relative: '', depth: 0 }]
  let dirCount = 0

  while (stack.length > 0) {
    if (signal?.aborted) {
      cancelled = true
      partial = true
      break
    }
    const current = stack.pop()
    dirCount += 1
    if (dirCount > maxDirs) {
      diagnostics.push({
        error_code: COMFY_CODES.SCAN_PARTIAL,
        field_path: root.path,
        message: `目录数超过上限 ${maxDirs}，扫描提前停止。`,
        suggested_fix: '缩小扫描根范围，或调高上限。',
      })
      partial = true
      break
    }

    let children
    try {
      children = await fsAdapter.listDir(current.target, { signal })
    } catch (error) {
      const mapped = toScanDiagnostic(
        error,
        root,
        `枚举 ${current.relative || '.'}`,
        current.relative ? joinDisplay(root.path, current.relative) : root.path,
      )
      diagnostics.push(mapped)
      // 权限拒绝只记录，不换接口重试；其余错误同样只影响这一个目录。
      partial = true
      continue
    }

    for (const child of children) {
      if (signal?.aborted) {
        cancelled = true
        partial = true
        break
      }
      if (entries.length >= maxEntries) {
        diagnostics.push({
          error_code: COMFY_CODES.SCAN_PARTIAL,
          field_path: root.path,
          message: `条目数超过上限 ${maxEntries}，扫描提前停止。`,
          suggested_fix: '缩小扫描根范围，或调高上限。',
        })
        partial = true
        break
      }

      const relative = joinDisplay(current.relative, child.name)

      // 符号链接指向根外时，resolve 之后就不在 contains 里了——这是唯一的判断依据。
      if (!fsAdapter.contains(rootTarget, child.target)) {
        diagnostics.push({
          error_code: COMFY_CODES.SCAN_PARTIAL,
          field_path: relative,
          message: `${relative} 解析后落在扫描根之外（可能是越界符号链接），已跳过。`,
          suggested_fix: '确认这个链接指向模型目录内部，或把它移出扫描范围。',
        })
        partial = true
        continue
      }

      if (child.type === 'directory') {
        const key = fsAdapter.targetKey(child.target)
        if (seenDirs.has(key)) continue
        seenDirs.add(key)
        if (current.depth + 1 > maxDepth) {
          diagnostics.push({
            error_code: COMFY_CODES.SCAN_PARTIAL,
            field_path: relative,
            message: `${relative} 超过最大深度 ${maxDepth}，其下内容未扫描。`,
            suggested_fix: '把模型放到更浅的目录，或调高扫描深度上限。',
          })
          partial = true
          continue
        }
        if (current.depth === 0 && !explicitCategory) categories.add(canonicalCategory(child.name))
        stack.push({ target: child.target, relative, depth: current.depth + 1 })
        continue
      }

      if (child.type !== 'file') continue

      const ext = extensionOf(child.name)
      const { category, category_raw: categoryRaw } = categoryOf(relative)
      entries.push({
        id: fsAdapter.targetKey(child.target),
        name: child.name,
        extension: ext,
        known_format: KNOWN_MODEL_EXTENSIONS.includes(ext),
        category,
        category_raw: categoryRaw,
        root: root.path,
        root_source: root.source ?? 'unknown',
        relative_path: relative,
        display_path: fsAdapter.displayPath(child.target),
        size: typeof child.size === 'number' ? child.size : null,
        // Host 契约没有 mtime：只用 FsVersion 与 size 做身份与变化判断。
        version: child.version ?? null,
        type: 'file',
        is_default: root.is_default === true,
        priority: root.priority ?? 0,
      })
    }
    if (cancelled) break
  }

  return { entries, categories: [...categories].sort(), diagnostics, partial, cancelled }
}

function toScanDiagnostic(error, root, action, path = root.path) {
  // 走同一套映射：EACCES 这类原生错误码也要落成 PATH_DENIED，
  // 否则"权限拒绝"会被含糊成"无法解析"，用户没法判断该改权限还是改路径。
  const mapped = mapFsError(error, { path, action })
  return {
    error_code: mapped.code,
    field_path: path,
    message: mapped.message,
    suggested_fix: mapped.suggested_fix,
  }
}

/**
 * 扫描多个根并按 targetKey 去重。
 * 重复项不丢弃来源：第一个出现的作为主记录，其余进 sources。
 */
export async function scanModelRoots(fsAdapter, roots, options = {}) {
  const all = []
  const diagnostics = []
  const categories = new Set()
  let partial = false
  let cancelled = false

  for (const root of roots) {
    if (options.signal?.aborted) {
      cancelled = true
      partial = true
      break
    }
    const result = await scanRoot(fsAdapter, root, options)
    all.push(...result.entries)
    for (const name of result.categories ?? []) categories.add(name)
    diagnostics.push(...result.diagnostics)
    partial = partial || result.partial
    cancelled = cancelled || result.cancelled
  }

  const byId = new Map()
  for (const entry of all) {
    const existing = byId.get(entry.id)
    if (!existing) {
      byId.set(entry.id, { ...entry, sources: [{ root: entry.root, source: entry.root_source, priority: entry.priority }] })
      continue
    }
    existing.sources.push({ root: entry.root, source: entry.root_source, priority: entry.priority })
    // 同名不同路径不合并：它们是两个 id，各自留在结果里。
  }

  const entries = [...byId.values()]
  for (const item of entries) if (item.category) categories.add(item.category)
  const sorted = [...categories].sort()

  return { entries, categories: sorted, diagnostics, partial, cancelled }
}

/** 进程内缓存：不落盘，也不跨进程复用（FsVersion 的跨会话稳定性尚未确认）。 */
export function createCatalogCache() {
  let snapshot = null
  return {
    get() {
      return snapshot
    },
    set(value) {
      snapshot = value
    },
    clear() {
      snapshot = null
    },
    get size() {
      return snapshot?.entries?.length ?? 0
    },
  }
}
