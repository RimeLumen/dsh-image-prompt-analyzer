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
 * ComfyUI 的用户根。规则照抄 folder_paths.py 与 main.py：
 *   user_directory = os.path.join(base_path, "user")，然后被 --user-directory 整个换掉。
 * base_path 本身被 --base-directory 换掉。所以顺序是 user-directory > base-directory > 安装根。
 */
export function workflowUserRoot({ installRoot = null, launch = null } = {}) {
  const explicit = typeof launch?.user_directory === 'string' ? launch.user_directory.trim() : ''
  if (explicit !== '' && isAbsolutePath(explicit)) {
    return { path: stripTrailing(explicit), source: 'arg_user_directory' }
  }
  const base = typeof launch?.base_directory === 'string' ? launch.base_directory.trim() : ''
  if (base !== '' && isAbsolutePath(base)) {
    return { path: joinPath(base, 'user'), source: 'arg_base_directory' }
  }
  if (typeof installRoot === 'string' && installRoot.trim() !== '') {
    return { path: joinPath(installRoot.trim(), 'user'), source: 'install_root' }
  }
  return null
}

function stripTrailing(value) {
  return String(value).replace(/[\\/]+$/, '')
}

/** 只有绝对路径才当覆盖用；相对路径的含义取决于进程 cwd，猜不得。 */
export function isAbsolutePath(value) {
  const text = String(value ?? '')
  if (text === '') return false
  if (/^[a-zA-Z]:[\\/]/u.test(text)) return true
  if (/^\\\\[^\\]/u.test(text)) return true
  return text.startsWith('/')
}

/**
 * 工作流根。
 *
 * 主根是当前实例的用户目录下的 workflows：<user 根>/<用户>/workflows。
 * 单用户环境用户是 default；开了 --multi-user 就是一人一层，这时不能假定 default。
 * 老整合包还有 <安装根>/workflows，留着当次要根，但标清来源，不冒充主根。
 */
export function workflowRoots({ installRoot = null, launch = null, userId = null, workflowDirs = [] } = {}) {
  const roots = []
  const userRoot = workflowUserRoot({ installRoot, launch })
  const activeUser = typeof userId === 'string' && userId.trim() !== '' ? userId.trim() : 'default'
  if (userRoot) {
    roots.push({
      path: joinPath(joinPath(userRoot.path, activeUser), 'workflows'),
      source: userRoot.source,
      primary: true,
      user_id: activeUser,
    })
  }
  if (typeof installRoot === 'string' && installRoot.trim() !== '') {
    const legacy = joinPath(installRoot.trim(), 'workflows')
    if (!roots.some((item) => item.path.toLowerCase() === legacy.toLowerCase())) {
      roots.push({ path: legacy, source: 'install-legacy', primary: false, user_id: null })
    }
  }
  for (const dir of workflowDirs ?? []) {
    if (typeof dir !== 'string' || dir.trim() === '') continue
    const path = stripTrailing(dir.trim())
    if (roots.some((item) => item.path.toLowerCase() === path.toLowerCase())) continue
    roots.push({ path, source: 'config', primary: false, user_id: null })
  }
  return roots
}

/**
 * 开了 --multi-user 时，用户根下面每个公开用户一层。
 * 只有恰好一个候选才敢用它；多个就报候选，不替用户挑。
 * `__` 开头的是 ComfyUI 自己的系统目录（缓存、系统设置），不是人。
 */
export async function detectActiveUser(fsAdapter, userRoot, { signal = null } = {}) {
  const root = typeof userRoot === 'string' ? stripTrailing(userRoot) : ''
  if (root === '') return { user_id: 'default', ambiguous: false, candidates: [] }
  let target
  try {
    target = await fsAdapter.resolve(root, { signal })
  } catch {
    return { user_id: 'default', ambiguous: false, candidates: [] }
  }
  const info = await fsAdapter.stat(target, { signal })
  if (!info || info.type !== 'directory') return { user_id: 'default', ambiguous: false, candidates: [] }

  let entries = []
  try {
    entries = await fsAdapter.listDir(target, { signal })
  } catch {
    return { user_id: 'default', ambiguous: false, candidates: [] }
  }
  const users = entries
    .filter((entry) => entry.type === 'directory')
    .map((entry) => entry.name)
    .filter((name) => typeof name === 'string' && name !== '' && !name.startsWith('__'))
    .sort((a, b) => a.localeCompare(b))

  if (users.length === 0) return { user_id: 'default', ambiguous: false, candidates: [] }
  if (users.length === 1) return { user_id: users[0], ambiguous: false, candidates: users }
  if (users.includes('default')) return { user_id: 'default', ambiguous: false, candidates: users }
  return { user_id: null, ambiguous: true, candidates: users }
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
