import { COMFY_CODES, ComfyError } from './errors.js'
import { mapFsError } from './fs-adapter.js'

/**
 * 本地工作流库。
 *
 * 只做两件事：在少数几个已知根目录里列出 .json，按名字把人指的那个挑出来。
 * 不扫盘、不猜目录、不在多个同名文件里替用户选。
 */

export const WORKFLOW_EXTENSIONS = Object.freeze(['.json'])

export const WORKFLOW_SCAN_LIMITS = Object.freeze({
  maxDepth: 4,
  maxEntries: 500,
  maxDirs: 200,
})

function joinPath(base, child) {
  const trimmed = String(base).replace(/[\\/]+$/, '')
  const separator = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/'
  return `${trimmed}${separator}${child}`
}

/**
 * 工作流根。ComfyUI 把用户工作流放在 <安装根>/user/default/workflows，
 * 老版本或第三方整合包也可能有 <安装根>/workflows，两个都看，但标清来源。
 */
export function workflowRoots({ installRoot = null, workflowDirs = [] } = {}) {
  const roots = []
  if (typeof installRoot === 'string' && installRoot.trim() !== '') {
    roots.push({
      path: joinPath(installRoot.trim(), 'user/default/workflows'),
      source: 'install',
      primary: true,
    })
    roots.push({
      path: joinPath(installRoot.trim(), 'workflows'),
      source: 'install-legacy',
      primary: false,
    })
  }
  for (const dir of workflowDirs ?? []) {
    if (typeof dir !== 'string' || dir.trim() === '') continue
    const path = dir.trim()
    if (roots.some((item) => item.path.toLowerCase() === path.toLowerCase())) continue
    roots.push({ path, source: 'config', primary: false })
  }
  return roots
}

export function workflowExtensionOf(name) {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot).toLowerCase()
}

/** 名字比较用：大小写无关，分隔符与空白一并抹掉，所以 61（2） 与 61(2) 是同一个。 */
export function looseWorkflowKey(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[-_.\s（）()]+/g, '')
}

/**
 * 列出所有根下的工作流文件。只读目录元数据，不读文件内容。
 * 根目录不存在不算错误：整合包布局各不相同，缺一个根是常态。
 */
export async function listWorkflows(fsAdapter, roots, options = {}) {
  const {
    signal = null,
    maxDepth = WORKFLOW_SCAN_LIMITS.maxDepth,
    maxEntries = WORKFLOW_SCAN_LIMITS.maxEntries,
    maxDirs = WORKFLOW_SCAN_LIMITS.maxDirs,
  } = options

  const items = []
  const diagnostics = []
  const scannedRoots = []
  const seenDirs = new Set()
  let partial = false
  let dirCount = 0
  let skipped = 0

  for (const root of roots) {
    let rootTarget
    try {
      rootTarget = await fsAdapter.resolve(root.path, { signal })
    } catch (error) {
      const mapped = mapFsError(error, { path: root.path, action: '列工作流目录' })
      // 目录不存在是正常情况；权限问题才值得报出来。
      if (mapped.code !== COMFY_CODES.PATH_MISSING) {
        diagnostics.push({
          error_code: mapped.code,
          field_path: root.path,
          message: mapped.message,
          suggested_fix: mapped.suggested_fix,
        })
        partial = true
      }
      scannedRoots.push({ path: root.path, source: root.source, exists: false })
      continue
    }

    const info = await fsAdapter.stat(rootTarget, { signal }).catch(() => null)
    if (!info || info.type !== 'directory') {
      scannedRoots.push({ path: root.path, source: root.source, exists: false })
      continue
    }
    scannedRoots.push({ path: root.path, source: root.source, exists: true })

    const stack = [{ target: rootTarget, relative: '', depth: 0 }]
    while (stack.length > 0) {
      const current = stack.pop()
      if (signal?.aborted) {
        partial = true
        break
      }
      if (dirCount >= maxDirs) {
        diagnostics.push({
          error_code: COMFY_CODES.SCAN_PARTIAL,
          field_path: root.path,
          message: `工作流目录数超过上限 ${maxDirs}，扫描提前停止。`,
          suggested_fix: '把工作流收进更少的子目录，或直接用 workflow_name 指定文件名。',
        })
        partial = true
        break
      }
      dirCount += 1

      let children
      try {
        children = await fsAdapter.listDir(current.target, { signal })
      } catch (error) {
        const mapped = mapFsError(error, { path: current.target?.displayPath ?? root.path, action: '枚举工作流目录' })
        diagnostics.push({
          error_code: mapped.code,
          field_path: current.relative || root.path,
          message: mapped.message,
          suggested_fix: mapped.suggested_fix,
        })
        partial = true
        continue
      }

      for (const child of children) {
        if (signal?.aborted) {
          partial = true
          break
        }
        if (items.length >= maxEntries) {
          diagnostics.push({
            error_code: COMFY_CODES.SCAN_PARTIAL,
            field_path: root.path,
            message: `工作流条目数超过上限 ${maxEntries}，扫描提前停止。`,
            suggested_fix: '用 workflow_name 直接指定文件名，或清理工作流目录。',
          })
          partial = true
          break
        }

        const relative = current.relative ? `${current.relative}/${child.name}` : child.name

        if (!fsAdapter.contains(rootTarget, child.target)) {
          diagnostics.push({
            error_code: COMFY_CODES.SCAN_PARTIAL,
            field_path: relative,
            message: `${relative} 解析后落在工作流根之外（可能是越界符号链接），已跳过。`,
            suggested_fix: '确认这个链接指向工作流目录内部，或把它移出扫描范围。',
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
              suggested_fix: '把工作流放到更浅的目录。',
            })
            partial = true
            continue
          }
          stack.push({ target: child.target, relative, depth: current.depth + 1 })
          continue
        }

        if (child.type !== 'file') continue
        if (!WORKFLOW_EXTENSIONS.includes(workflowExtensionOf(child.name))) {
          skipped += 1
          continue
        }

        items.push({
          name: child.name,
          stem: child.name.slice(0, child.name.length - workflowExtensionOf(child.name).length),
          relative_path: relative,
          directory: current.relative,
          root: root.path,
          root_source: root.source,
          display_path: fsAdapter.displayPath(child.target),
          size: typeof child.size === 'number' ? child.size : null,
          version: child.version ?? null,
        })
      }
      if (signal?.aborted) break
    }
  }

  items.sort((a, b) => {
    const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    if (byName !== 0) return byName
    return String(a.display_path ?? '').localeCompare(String(b.display_path ?? ''))
  })

  return { items, roots: scannedRoots, diagnostics, partial, skipped, cancelled: signal?.aborted === true }
}

/**
 * 按名字匹配。三档：完全同名 → 去掉扩展名同名 → 抹掉分隔符后同名。
 * 返回全部命中项，由调用方决定是唯一命中还是要用户挑。
 */
export function matchWorkflows(items, query) {
  const raw = String(query ?? '').trim()
  if (raw === '') return { matches: [], level: 'none' }
  const lower = raw.toLowerCase()
  const withExt = WORKFLOW_EXTENSIONS.some((ext) => lower.endsWith(ext)) ? lower : `${lower}.json`
  const looseQuery = looseWorkflowKey(raw)

  const exact = items.filter((item) => item.name.toLowerCase() === withExt)
  if (exact.length > 0) return { matches: exact, level: 'exact' }

  const stem = items.filter((item) => item.stem.toLowerCase() === lower)
  if (stem.length > 0) return { matches: stem, level: 'stem' }

  const loose = items.filter((item) => looseWorkflowKey(item.stem) === looseQuery)
  if (loose.length > 0) return { matches: loose, level: 'loose' }

  return { matches: [], level: 'none' }
}

/** 用户挑错时给的线索：先给同名前缀，再给最近的前几个名字。 */
export function suggestWorkflowNames(items, query, limit = 8) {
  const lower = String(query ?? '').trim().toLowerCase()
  const prefix = items.filter((item) => lower !== '' && item.stem.toLowerCase().startsWith(lower.slice(0, 2)))
  const pool = prefix.length > 0 ? prefix : items
  return pool.slice(0, limit).map((item) => item.name)
}

/**
 * 把 workflow_name 解析成一个真实文件。
 * 命中多个时抛 BINDING_AMBIGUOUS 并带上候选，绝不替用户选。
 */
export async function resolveWorkflowByName(fsAdapter, roots, name, options = {}) {
  const { signal = null } = options
  const listing = await listWorkflows(fsAdapter, roots, { signal })
  const { matches, level } = matchWorkflows(listing.items, name)
  if (matches.length === 1) {
    return { item: matches[0], listing, level }
  }
  if (matches.length > 1) {
    const error = new ComfyError(
      COMFY_CODES.BINDING_AMBIGUOUS,
      `有 ${matches.length} 个本地工作流都叫 ${name}，需要指定其中一个。`,
      '用 workflow_path 指定完整路径，或先改名。',
    )
    error.candidates = matches.map((item) => ({
      name: item.name,
      display_path: item.display_path,
      root_source: item.root_source,
    }))
    throw error
  }
  const suggestions = suggestWorkflowNames(listing.items, name)
  const error = new ComfyError(
    COMFY_CODES.PATH_MISSING,
    suggestions.length > 0
      ? `没有找到名为 ${name} 的本地工作流。可用的有：${suggestions.join('、')}。`
      : `没有找到名为 ${name} 的本地工作流，工作流目录里也没有可列出的 .json 文件。`,
    '先用 comfyui_list_workflows 看一遍可用名称，或确认 comfyui.installRoot 是否指向正确的安装根。',
  )
  error.available = suggestions
  throw error
}
