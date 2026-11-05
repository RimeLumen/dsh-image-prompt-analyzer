
import { COMFY_CODES, ComfyError } from './errors.js'

// ComfyUI 的 folder_paths.py 里，这些旧名是别名，指向新的规范分类。
// 保留原始名与规范名两份，是因为 YAML 里写的是哪个名字，用户就该看到哪个名字。
export const CATEGORY_ALIASES = Object.freeze({
  clip: 'text_encoders',
  unet: 'diffusion_models',
})

export const MAX_YAML_BYTES = 1024 * 1024

/** Python 的 os.path.expandvars：`$VAR`、`${VAR}`，Windows 上还有 `%VAR%`。未知变量原样保留。 */
export function expandVars(value, env = {}, { windows = true } = {}) {
  if (typeof value !== 'string') return value
  let unresolved = false
  const replaced = value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) => {
      if (Object.prototype.hasOwnProperty.call(env, name)) return env[name]
      unresolved = true
      return whole
    })
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name) => {
      if (Object.prototype.hasOwnProperty.call(env, name)) return env[name]
      unresolved = true
      return whole
    })
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name) => {
      if (!windows) return whole
      if (Object.prototype.hasOwnProperty.call(env, name)) return env[name]
      unresolved = true
      return whole
    })
  return { value: replaced, unresolved }
}

/**
 * Python 的 os.path.expanduser。只认开头的 `~`：
 * `~/x` 用给定的 homedir，`~user/x` 拿不到别的用户目录，标记未解析。
 */
export function expandUser(value, homedir) {
  if (typeof value !== 'string') return { value, unresolved: false }
  if (value === '~') {
    return homedir ? { value: homedir, unresolved: false } : { value, unresolved: true }
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    if (!homedir) return { value, unresolved: true }
    return { value: `${homedir}${value.slice(1)}`, unresolved: false }
  }
  if (value.startsWith('~')) return { value, unresolved: true }
  return { value, unresolved: false }
}

const DRIVE_RE = /^[A-Za-z]:[\\/]/
const UNC_RE = /^[\\\\/]{2}[^\\/]+[\\/][^\\/]+/

export function isAbsoluteLike(value) {
  if (typeof value !== 'string' || value === '') return false
  if (DRIVE_RE.test(value)) return true
  if (UNC_RE.test(value)) return true
  return value.startsWith('/') || value.startsWith('\\')
}

function driveOf(value) {
  const match = /^([A-Za-z]:)/.exec(value ?? '')
  return match ? match[1] : ''
}

/**
 * 复刻 ntpath.join 的关键行为，而不是直接用 path.join：
 *   ntpath.join('D:\\a', 'D:\\b') -> 'D:\\b'   （子路径自带盘符，丢弃 base）
 *   ntpath.join('D:\\a', '\\b')   -> 'D:\\b'   （子路径无盘符但绝对，借用 base 的盘符）
 *   ntpath.join('D:\\a', 'b')     -> 'D:\\a\\b'
 * 用 path.join 会把第三种情况的绝对子路径拼错，也会把前两种拼成嵌套路径。
 */
export function joinLikePython(base, child) {
  if (typeof base !== 'string' || base === '') return child
  if (typeof child !== 'string' || child === '') return base

  if (DRIVE_RE.test(child)) return child
  if (UNC_RE.test(child)) return child

  const baseDrive = driveOf(base)
  if (child.startsWith('/') || child.startsWith('\\')) {
    const rest = child.replace(/^[\\/]+/, '')
    return baseDrive ? `${baseDrive}\\${rest}` : child
  }

  const trimmed = base.replace(/[\\/]+$/, '')
  return `${trimmed}\\${child}`
}

/**
 * 复刻 ntpath.normpath。ComfyUI 在 `add_model_folder_path` 之前一定会走一次
 * `os.path.normpath`，所以分隔符会被统一成反斜杠、`..` 会被就地消解。
 * 不做这一步，YAML 里写的 `models/checkpoints` 会保留正斜杠，
 * 和 ComfyUI 实际注册进 folder_paths 的字符串对不上。
 */
export function normalizePath(value, { windows = true } = {}) {
  if (typeof value !== 'string') return value
  if (value === '') return '.'

  const sep = windows ? '\\' : '/'
  let input = windows ? value.replace(/\//g, '\\') : value
  let prefix = ''
  let rooted = false

  if (windows) {
    const unc = /^\\\\[^\\]+\\[^\\]+/.exec(input)
    if (unc) {
      prefix = unc[0]
      input = input.slice(prefix.length)
    } else {
      const drive = /^[A-Za-z]:/.exec(input)
      if (drive) {
        prefix = drive[0]
        input = input.slice(2)
      }
    }
    rooted = input.startsWith('\\')
    input = input.replace(/^\\+/, '')
  } else {
    rooted = input.startsWith('/')
    input = input.replace(/^\/+/, '')
  }

  const out = []
  for (const segment of input.split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!rooted) out.push('..')
      continue
    }
    out.push(segment)
  }

  const body = out.join(sep)
  if (body === '') {
    if (prefix) return rooted ? `${prefix}${sep}` : prefix
    return rooted ? sep : '.'
  }
  if (prefix) return `${prefix}${sep}${body}`
  return rooted ? `${sep}${body}` : body
}

/** 规范化分类名：只做别名映射，不改大小写，不丢弃原始名。 */
export function canonicalCategory(raw) {
  const key = String(raw)
  return CATEGORY_ALIASES[key] ?? key
}

function yamlError(message, extra = {}) {
  return new ComfyError(COMFY_CODES.VALIDATION_FAILED, message)
}

/**
 * 解析一份 extra_model_paths.yaml。
 *
 * 返回的 roots 保留 YAML 里的原始分类名、原始路径串、解析后的绝对路径、
 * 是否 is_default、以及这条根来自哪个配置文件。解析不出绝对路径的条目
 * 不会凭空猜一个值，而是标记 unresolved 并附带原因。
 */
export function parseModelPathsYaml(text, options = {}) {
  const {
    yamlFile = null,
    yamlDir = null,
    env = {},
    homedir = null,
    windows = true,
    YAML = null,
  } = options

  const diagnostics = []
  if (typeof text !== 'string') throw yamlError('YAML 内容必须是字符串。')
  if (Buffer.byteLength(text, 'utf8') > MAX_YAML_BYTES) {
    throw yamlError(`YAML 超过 ${MAX_YAML_BYTES} 字节上限，拒绝解析。`)
  }
  if (!YAML) throw yamlError('未提供 YAML 解析器。')

  const docs = YAML.parseAllDocuments(text, {
    // core schema：不解析自定义标签、不执行任何构造器。
    schema: 'core',
    customTags: [],
    uniqueKeys: true,
    maxAliasCount: 100,
    prettyErrors: false,
  })

  if (docs.length === 0) throw yamlError('YAML 是空文档。')
  if (docs.length > 1) throw yamlError(`YAML 含 ${docs.length} 个文档，只接受单文档。`)

  const doc = docs[0]
  if (doc.errors && doc.errors.length > 0) {
    throw yamlError(`YAML 语法错误：${doc.errors[0].message}`)
  }
  const data = doc.toJS({ maxAliasCount: 100 })
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw yamlError('YAML 顶层必须是映射（config 名 → 配置块）。')
  }

  const roots = []
  for (const [configName, block] of Object.entries(data)) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) {
      diagnostics.push({
        error_code: COMFY_CODES.VALIDATION_FAILED,
        field_path: `/${configName}`,
        message: `配置块 ${configName} 不是映射，已跳过。`,
      })
      continue
    }

    const rawBase = block.base_path
    const isDefault = block.is_default === true
    let basePath = yamlDir
    let baseUnresolved = null

    if (rawBase !== undefined) {
      if (typeof rawBase !== 'string' || rawBase.trim() === '') {
        diagnostics.push({
          error_code: COMFY_CODES.VALIDATION_FAILED,
          field_path: `/${configName}/base_path`,
          message: `base_path 必须是字符串，收到 ${JSON.stringify(rawBase)}。`,
        })
        baseUnresolved = 'base_path 类型非法'
      } else {
        const vars = expandVars(rawBase, env, { windows })
        if (vars.unresolved) baseUnresolved = `环境变量未解析：${rawBase}`
        const user = expandUser(vars.value, homedir)
        if (user.unresolved) baseUnresolved = `用户目录无法展开：${rawBase}`
        // 相对 base_path 相对 YAML 所在目录，与 extra_config.py 一致。
        basePath = isAbsoluteLike(user.value)
          ? user.value
          : yamlDir
            ? joinLikePython(yamlDir, user.value)
            : null
        if (!basePath) baseUnresolved = 'YAML 所在目录未知，相对 base_path 无法解析'
      }
    }

    for (const [rawCategory, rawValue] of Object.entries(block)) {
      if (rawCategory === 'base_path' || rawCategory === 'is_default') continue
      // 多行写法是 ComfyUI 的实际用法：一个分类写多行，按 "\n" 切成多个目录。
      const list = Array.isArray(rawValue) ? rawValue : String(rawValue ?? '').split('\n')
      for (const item of list) {
        if (typeof item !== 'string') continue
        const trimmed = item.trim()
        if (trimmed === '') continue

        const vars = expandVars(trimmed, env, { windows })
        const user = expandUser(vars.value, homedir)
        const unresolved = vars.unresolved
          ? `环境变量未解析：${trimmed}`
          : user.unresolved
            ? `用户目录无法展开：${trimmed}`
            : baseUnresolved

        let resolvedPath = null
        if (!unresolved && basePath) {
          const joined = isAbsoluteLike(user.value) ? user.value : joinLikePython(basePath, user.value)
          resolvedPath = normalizePath(joined, { windows })
        }

        roots.push({
          config_name: configName,
          category_raw: rawCategory,
          category: canonicalCategory(rawCategory),
          path_raw: trimmed,
          path_expanded: user.value,
          path: resolvedPath,
          is_default: isDefault,
          yaml_file: yamlFile,
          unresolved,
          source: 'yaml',
        })
      }
    }
  }

  return { roots, diagnostics }
}

/**
 * 从配置推出的、允许扫描的根集合。这里只做推导，不碰文件系统。
 *
 * installRoot 本身不扫：只扫它下面约定俗成的 models 目录，
 * 否则会把整个 ComfyUI 安装目录连同 custom_nodes、python 环境一起遍历。
 */
export function deriveScanRoots(settings, { defaultModelDir = 'models' } = {}) {
  const roots = []
  const seen = new Set()
  const push = (entry) => {
    if (!entry.path) return
    const key = `${entry.source}:${entry.path}`
    if (seen.has(key)) return
    seen.add(key)
    roots.push(entry)
  }

  if (settings?.installRoot) {
    push({
      path: joinLikePython(settings.installRoot, defaultModelDir),
      source: 'install_root_models',
      category: null,
      is_default: true,
    })
  }
  for (const path of settings?.additionalModelRoots ?? []) {
    push({ path, source: 'user_root', category: null, is_default: false })
  }
  return roots
}
