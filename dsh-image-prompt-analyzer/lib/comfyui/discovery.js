import { COMFY_CODES, ComfyError } from './errors.js'
import { mapFsError } from './fs-adapter.js'
import { parseModelPathsYaml } from './paths.js'

/**
 * ComfyUI 自动发现。
 *
 * 设计前提（都已核对过实际源码或本机产物，不是猜的）：
 *   - 安装根的判定标志是 `main.py` + `folder_paths.py`，二者同目录才算；
 *     `comfy/cli_args.py` 作为加强证据。
 *   - 模型根与安装根是两件事：`folder_paths.py:15-23` 里
 *     `models_dir = abspath(args.models_directory) or join(base_path, 'models')`。
 *   - 进程启动参数里 `--extra-model-paths-config` 是 nargs='+' + append，
 *     解析后是 list of list，必须 chain 展开。
 *
 * 支持范围：只适配本地 ComfyUI 核心程序（Portable、Git clone、第三方整合启动器）。
 * 官方 ComfyUI Desktop 不在支持范围内——不解析它的 settings.json /
 * installations.json / extra_models_config.yaml，也不登记它的安装目录。
 * 如果 Desktop 拉起的进程实际在跑 ComfyUI 的 main.py，通用进程发现照样能认出
 * 那个核心程序，但那属于"进程发现"，不是 Desktop 适配。
 *
 * 安全约束：只碰有限候选路径、只读元数据与文本、只连 loopback。
 * 所有 fs 访问都经过 fsAdapter，从不 import node:fs。
 */

export const DISCOVERY_SOURCES = Object.freeze({
  PROCESS: 'process',
  PORTABLE: 'portable',
  GIT: 'git',
  KNOWN_LOCATION: 'known_location',
  USER_CONFIG: 'user_config',
})

export const CONFIDENCE = Object.freeze({
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
})

export const DISCOVERY_STATUS = Object.freeze({
  FOUND: 'found',
  NOT_FOUND: 'not_found',
  NOT_RUNNING: 'not_running',
  AMBIGUOUS: 'ambiguous',
  PARTIAL: 'partial',
  DISABLED: 'disabled',
})

/** 安装根必须同时具备的文件。来自 ComfyUI 仓库结构，不是文件名猜测。 */
export const INSTALL_MARKERS = Object.freeze(['main.py', 'folder_paths.py'])
/** 有则置信度更高，没有也不否定。 */
export const INSTALL_HINTS = Object.freeze(['comfy/cli_args.py', 'comfy_extras', 'custom_nodes'])

export const DEFAULT_PROBE_TIMEOUT_MS = 1500
export const MAX_PROCESS_OUTPUT_BYTES = 1_000_000

/** 候选上限：即便环境变量被污染也不会把候选表撑成一次全盘扫描。 */
export const MAX_CANDIDATES = 24

/**
 * 盘符级探测的上限。整合启动器（绘世、Stability Matrix 之类）会把 ComfyUI 埋在
 * 任意盘的任意层子目录里，光靠固定候选碰不到。这里允许从盘根往下看一眼，
 * 但只进名字里带 comfy 的目录，且深度、目录数、每层条目数全部封顶。
 */
export const DRIVE_PROBE_LIMITS = Object.freeze({
  maxDepth: 4,
  maxEntriesPerDir: 200,
  maxTotalDirs: 240,
})

/** 这些目录名下面不会有第二个 ComfyUI 安装根，进去只会白扫几十万个模型文件。 */
const PROBE_SKIP_NAMES = Object.freeze([
  'models',
  'input',
  'output',
  'temp',
  'custom_nodes',
  'user',
  'web',
  'tests',
  'node_modules',
  '.git',
  '__pycache__',
  'venv',
  '.venv',
  'python',
  'python_embeded',
  'python_embedded',
  'git',
])

const SOURCE_PRIORITY = Object.freeze({
  [DISCOVERY_SOURCES.USER_CONFIG]: 0,
  [DISCOVERY_SOURCES.PROCESS]: 1,
  [DISCOVERY_SOURCES.PORTABLE]: 2,
  [DISCOVERY_SOURCES.GIT]: 3,
  [DISCOVERY_SOURCES.KNOWN_LOCATION]: 4,
})

function joinWin(...parts) {
  const cleaned = parts.filter((part) => typeof part === 'string' && part !== '')
  if (cleaned.length === 0) return ''
  let out = cleaned[0].replace(/[\\/]+$/, '')
  for (const part of cleaned.slice(1)) {
    out = `${out}\\${part.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '')}`
  }
  return out
}

function joinPosix(...parts) {
  const cleaned = parts.filter((part) => typeof part === 'string' && part !== '')
  if (cleaned.length === 0) return ''
  let out = cleaned[0].replace(/\/+$/, '')
  for (const part of cleaned.slice(1)) {
    out = `${out}/${part.replace(/^\/+/, '').replace(/\/+$/, '')}`
  }
  return out
}

function dirnameOf(value, windows) {
  const text = String(value ?? '')
  const sep = windows ? /[\\/]/ : /\//
  const index = text.search(new RegExp(`[^\\\\/]*$`))
  const trimmed = index > 0 ? text.slice(0, index) : ''
  if (trimmed === '') return windows ? 'C:\\' : '/'
  const stripped = trimmed.replace(sep, '')
  if (stripped === '' && windows && /^[A-Za-z]:[\\/]$/.test(trimmed)) return trimmed
  return trimmed.length > 1 ? trimmed.replace(/[\\/]+$/, '') : trimmed
}

function diagnosticOf(code, message, { fieldPath = null, suggestedFix = null } = {}) {
  return {
    error_code: code,
    field_path: fieldPath,
    message,
    suggested_fix: suggestedFix,
  }
}

/** 已知的有限候选安装位置。每个平台固定几条，绝不遍历目录树。 */
export function knownInstallCandidates({ platform = process.platform, env = {}, driveRoots = [] } = {}) {
  const windows = platform === 'win32'
  const join = windows ? joinWin : joinPosix
  const home = windows ? env.USERPROFILE : env.HOME
  const list = []

  const push = (path, source, label) => {
    if (typeof path !== 'string' || path === '') return
    if (list.some((item) => item.path.toLowerCase() === path.toLowerCase())) return
    list.push({ path, source, label })
  }

  if (windows) {
    // 只列本地核心程序的常见位置。官方 Desktop 的 electron 应用目录与
    // %APPDATA%\ComfyUI 都不在候选里：那不是本项目的支持目标。
    push('C:\\ComfyUI', DISCOVERY_SOURCES.GIT, '常见 Git 安装位置')
    push('C:\\ComfyUI_windows_portable\\ComfyUI', DISCOVERY_SOURCES.PORTABLE, '常见 Portable 位置')
    push('D:\\ComfyUI', DISCOVERY_SOURCES.GIT, '常见 Git 安装位置')
    push('D:\\ComfyUI_windows_portable\\ComfyUI', DISCOVERY_SOURCES.PORTABLE, '常见 Portable 位置')
    if (home) {
      push(join(home, 'ComfyUI'), DISCOVERY_SOURCES.GIT, '用户主目录下的 Git 安装')
      push(join(home, 'Documents', 'ComfyUI'), DISCOVERY_SOURCES.GIT, '文档目录下的 Git 安装')
      push(join(home, 'ComfyUI_windows_portable', 'ComfyUI'), DISCOVERY_SOURCES.PORTABLE, '用户主目录下的 Portable')
    }
    // 盘符是枚举出来的，不在候选里写死。每块盘只加两条固定形状，
    // 不列盘根、不遍历——盘根里有永远读不了的系统目录。
    for (const drive of driveRoots) {
      const letter = String(drive).replace(/[\\/]+$/, '')
      if (!/^[A-Za-z]:$/.test(letter)) continue
      push(`${letter}\\ComfyUI`, DISCOVERY_SOURCES.GIT, `${letter.toUpperCase()} 盘上的 ComfyUI 目录`)
      push(
        `${letter}\\ComfyUI_windows_portable\\ComfyUI`,
        DISCOVERY_SOURCES.PORTABLE,
        `${letter.toUpperCase()} 盘上的 Portable`,
      )
    }
    return list.slice(0, MAX_CANDIDATES)
  }

  if (platform === 'darwin') {
    if (home) {
      push(join(home, 'ComfyUI'), DISCOVERY_SOURCES.GIT, '用户主目录下的 Git 安装')
      push(join(home, 'Documents', 'ComfyUI'), DISCOVERY_SOURCES.GIT, '文档目录下的 Git 安装')
    }
    return list.slice(0, MAX_CANDIDATES)
  }

  if (home) {
    push(join(home, 'ComfyUI'), DISCOVERY_SOURCES.GIT, '用户主目录下的 Git 安装')
    push(join(home, 'comfyui'), DISCOVERY_SOURCES.GIT, '用户主目录下的 Git 安装（小写）')
  }
  push('/opt/ComfyUI', DISCOVERY_SOURCES.GIT, '系统级安装位置')
  push('/usr/local/ComfyUI', DISCOVERY_SOURCES.GIT, '系统级安装位置')
  return list.slice(0, MAX_CANDIDATES)
}

/** 判定一个路径是否落在官方 ComfyUI Desktop 的应用包内。
 *
 * 只用于标注与拒收，不用于解析任何 Desktop 私有配置。命中说明这段核心程序是
 * Desktop 自带的，不是用户自己装的本地 ComfyUI，不能算本项目的支持目标。
 */
export function isDesktopBundlePath(value, { platform = process.platform } = {}) {
  if (typeof value !== 'string' || value === '') return false
  if (platform === 'win32') {
    const text = value.replace(/\//g, '\\').toLowerCase()
    return (
      text.includes('\\programs\\@comfyorgcomfyui-electron\\') ||
      text.includes('\\programs\\comfyui\\resources\\comfyui')
    )
  }
  const text = value.toLowerCase()
  if (platform === 'darwin') return text.includes('/applications/comfyui.app/')
  return text.includes('comfyui-electron') || text.includes('/comfyui.app/')
}

/** 拒收 Desktop 自带核心程序时给出的原因码。 */
export const UNSUPPORTED_DESKTOP_REASON = 'unsupported_desktop_bundle'

const ARGV_VALUE_FLAGS = Object.freeze([
  '--listen',
  '--port',
  '--base-directory',
  '--models-directory',
  '--output-directory',
  '--input-directory',
  '--temp-directory',
  '--user-directory',
  '--previews-directory',
])
const ARGV_MULTI_FLAGS = Object.freeze(['--extra-model-paths-config'])

/**
 * 解析 ComfyUI 的启动参数。
 *
 * 只关心与本任务相关的几项；`--extra-model-paths-config` 按 argparse 的
 * `nargs='+'` + `action='append'` 处理：一次可以吃多个值，且可以出现多次。
 */
/**
 * 命令行切词：Windows 的 CommandLine 是一整条字符串，双引号包住的路径不能拆开。
 * 只处理双引号，不处理转义序列——足够解析 ComfyUI 的启动参数。
 */
export function tokenizeCommandLine(text) {
  const tokens = []
  const source = String(text ?? '')
  let current = ''
  let quoted = false
  let started = false
  for (const char of source) {
    if (char === '"') {
      quoted = !quoted
      started = true
      continue
    }
    if (!quoted && (char === ' ' || char === '	')) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

export function parseComfyArgv(argv, { windows = process.platform === 'win32' } = {}) {
  const tokens = Array.isArray(argv)
    ? argv.map((item) => String(item))
    : tokenizeCommandLine(argv)
  const result = {
    script_path: null,
    install_root: null,
    listen: null,
    port: null,
    base_directory: null,
    models_directory: null,
    output_directory: null,
    extra_model_paths_config: [],
    raw_args: tokens.slice(),
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (typeof token !== 'string') continue

    if (result.script_path === null && /(^|[\\/])main\.py$/i.test(token)) {
      result.script_path = token
      result.install_root = dirnameOf(token, windows)
      continue
    }

    const inline = token.startsWith('--') ? token.indexOf('=') : -1
    const flag = inline > 0 ? token.slice(0, inline) : token
    const inlineValue = inline > 0 ? token.slice(inline + 1) : null

    if (ARGV_MULTI_FLAGS.includes(flag)) {
      if (inlineValue !== null) {
        result.extra_model_paths_config.push(inlineValue)
        continue
      }
      let cursor = index + 1
      while (cursor < tokens.length && !tokens[cursor].startsWith('--')) {
        result.extra_model_paths_config.push(tokens[cursor])
        cursor += 1
      }
      index = cursor - 1
      continue
    }

    if (ARGV_VALUE_FLAGS.includes(flag)) {
      const value = inlineValue !== null ? inlineValue : tokens[index + 1]
      if (inlineValue === null) index += 1
      if (typeof value !== 'string' || value.startsWith('--')) continue
      switch (flag) {
        case '--listen':
          result.listen = value
          break
        case '--port': {
          const port = Number.parseInt(value, 10)
          result.port = Number.isInteger(port) && port > 0 && port < 65536 ? port : null
          break
        }
        case '--base-directory':
          result.base_directory = value
          break
        case '--models-directory':
          result.models_directory = value
          break
        case '--output-directory':
          result.output_directory = value
          break
        default:
          break
      }
    }
  }

  return result
}

/** 进程命令行是否像 ComfyUI。要求同时出现 main.py 与 comfy 相关字样。 */
export function looksLikeComfyProcess(commandLine) {
  const text = String(commandLine ?? '')
  if (text === '') return false
  if (!/(^|[\\/\s"])main\.py([\s"]|$)/i.test(text)) return false
  return /comfy/i.test(text)
}

export function parseWindowsProcessJson(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return []
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const out = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const commandLine = typeof row.CommandLine === 'string' ? row.CommandLine : null
    if (!looksLikeComfyProcess(commandLine)) continue
    out.push({
      pid: Number.isInteger(row.ProcessId) ? row.ProcessId : null,
      name: typeof row.Name === 'string' ? row.Name : null,
      command_line: commandLine,
      executable_path: typeof row.ExecutablePath === 'string' ? row.ExecutablePath : null,
    })
  }
  return out
}

export function parsePosixProcessOutput(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!match) continue
    const commandLine = match[3]
    if (!looksLikeComfyProcess(commandLine)) continue
    out.push({
      pid: Number.parseInt(match[1], 10),
      name: match[2],
      command_line: commandLine,
      executable_path: null,
    })
  }
  return out
}

/** 只读的系统进程查询命令。不启动、不停止、不执行 ComfyUI 自身的 Python。 */
export function buildProcessQuery({ platform = process.platform } = {}) {
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      argv: [
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='python.exe' or Name='pythonw.exe' or Name='ComfyUI.exe' or Name='comfyui.exe'\" | Select-Object ProcessId,Name,CommandLine,ExecutablePath | ConvertTo-Json -Compress",
      ],
    }
  }
  return { command: 'ps', argv: ['ps', '-eo', 'pid=,comm=,args='] }
}

/**
 * 采集正在运行的 ComfyUI 进程。没有 subprocess 服务时如实返回不可用，
 * 不退回 node:child_process。
 */
export async function collectProcessCandidates({ subprocess, platform = process.platform, signal } = {}) {
  const diagnostics = []
  if (!subprocess || typeof subprocess.spawn !== 'function') {
    diagnostics.push(
      diagnosticOf(
        COMFY_CODES.CAPABILITY_UNAVAILABLE,
        '当前 Host 没有提供 subprocess 服务，无法通过进程枚举发现 ComfyUI。',
        { suggestedFix: '改用配置文件或手动填写 installRoot。' },
      ),
    )
    return { available: false, candidates: [], diagnostics, scanned_paths: [] }
  }

  const query = buildProcessQuery({ platform })
  let handle
  try {
    handle = subprocess.spawn({
      argv: query.argv,
      cwd: platform === 'win32' ? 'C:\\' : '/',
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: MAX_PROCESS_OUTPUT_BYTES },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: 2000,
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    diagnostics.push(
      diagnosticOf(COMFY_CODES.CAPABILITY_UNAVAILABLE, `无法启动进程查询：${error?.message ?? error}`, {
        suggestedFix: '改用配置文件或手动填写 installRoot。',
      }),
    )
    return { available: false, candidates: [], diagnostics, scanned_paths: [] }
  }

  let text = ''
  try {
    const outcome = await handle.done
    const reader = handle.collected?.stdout
    if (reader && typeof reader.readFrom === 'function') {
      text = reader.readFrom(0)?.text ?? ''
    }
    if (outcome?.exitCode !== 0 && text.trim() === '') {
      diagnostics.push(
        diagnosticOf(COMFY_CODES.CAPABILITY_UNAVAILABLE, `进程查询命令退出码 ${outcome?.exitCode}，没有输出。`, {
          suggestedFix: '改用配置文件或手动填写 installRoot。',
        }),
      )
      return { available: false, candidates: [], diagnostics, scanned_paths: [] }
    }
  } catch (error) {
    diagnostics.push(
      diagnosticOf(COMFY_CODES.CAPABILITY_UNAVAILABLE, `进程查询失败：${error?.message ?? error}`, {
        suggestedFix: '改用配置文件或手动填写 installRoot。',
      }),
    )
    return { available: false, candidates: [], diagnostics, scanned_paths: [] }
  }

  const candidates =
    platform === 'win32' ? parseWindowsProcessJson(text) : parsePosixProcessOutput(text)
  return { available: true, candidates, diagnostics, scanned_paths: [] }
}

/**
 * 枚举本机文件系统盘符。只用于把"固定候选"扩成"每块盘上的固定候选"，
 * 拿到的是一串根路径，不是目录内容。Windows 用 Win32_LogicalDisk 查盘符，
 * 只取 DriveType=3（本地固定磁盘）：网络映射盘上的 ComfyUI 不属于本机安装，
 * 扫描它既慢又会把远端目录当成本地模型来源。其他平台不枚举挂载点——
 * /opt、/usr/local、~ 已经在固定候选里了。
 */
export async function collectDriveRoots({ subprocess, platform = process.platform, signal } = {}) {
  const diagnostics = []
  if (platform !== 'win32') {
    return { available: false, roots: [], diagnostics, skipped_reason: 'not_windows' }
  }
  if (!subprocess || typeof subprocess.spawn !== 'function') {
    diagnostics.push(
      diagnosticOf(COMFY_CODES.CAPABILITY_UNAVAILABLE, '当前 Host 没有提供 subprocess 服务，无法枚举盘符。', {
        suggestedFix: '手动填写 comfyui.installRoot 指向你的 ComfyUI 目录。',
      }),
    )
    return { available: false, roots: [], diagnostics, skipped_reason: 'no_subprocess' }
  }

  let handle
  try {
    handle = subprocess.spawn({
      argv: [
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object -ExpandProperty DeviceID',
      ],
      cwd: 'C:\\',
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 64 * 1024 },
        stderr: { maxBytes: 32 * 1024 },
      },
      graceMs: 2000,
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    diagnostics.push(
      diagnosticOf(COMFY_CODES.CAPABILITY_UNAVAILABLE, `无法枚举盘符：${error?.message ?? error}`, {
        suggestedFix: '手动填写 comfyui.installRoot 指向你的 ComfyUI 目录。',
      }),
    )
    return { available: false, roots: [], diagnostics, skipped_reason: 'spawn_failed' }
  }

  let text = ''
  try {
    await handle.done
    const reader = handle.collected?.stdout
    if (reader && typeof reader.readFrom === 'function') text = reader.readFrom(0)?.text ?? ''
  } catch (error) {
    diagnostics.push(
      diagnosticOf(COMFY_CODES.CAPABILITY_UNAVAILABLE, `枚举盘符失败：${error?.message ?? error}`, {
        suggestedFix: '手动填写 comfyui.installRoot 指向你的 ComfyUI 目录。',
      }),
    )
    return { available: false, roots: [], diagnostics, skipped_reason: 'query_failed' }
  }

  const roots = []
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim()
    // Win32_LogicalDisk 给的是 "C:"，Get-PSDrive 给的是 "C:\"，两种都收。
    // UNC 与 PowerShell 内部路径一律跳过。
    if (!/^[A-Za-z]:(?:[\\/])?$/.test(value)) continue
    const normalized = `${value[0].toUpperCase()}:\\`
    if (roots.includes(normalized)) continue
    roots.push(normalized)
  }
  return { available: true, roots, diagnostics, skipped_reason: null }
}

/**
 * 在若干"看起来像 ComfyUI 的目录"里有界下探，找真正的安装根。
 *
 * 整合启动器把 ComfyUI 放在 <盘>:\ComfyUI\<启动器>\<启动器>\ComfyUI 这种位置，
 * 固定候选只到 <盘>:\ComfyUI 就停了。这里从候选路径往下走，边界是硬的：
 * 深度、目录数、每层条目数全部封顶，模型/输入/输出这类大目录直接跳过，
 * 找到第一个安装根就停，不为了"更完整"把整棵树走完。
 *
 * 不从盘根列目录：Windows 盘根里有 System Volume Information 这类永远读不了的
 * 条目，Host 的 listDir 会整次拒绝，列盘根等于白跑。
 */
export async function probeComfyDirectories(fsAdapter, { seeds = [], platform = process.platform, signal } = {}) {
  const diagnostics = []
  const scanned = []
  const found = []
  const windows = platform === 'win32'
  const join = windows ? joinWin : joinPosix
  const limits = DRIVE_PROBE_LIMITS
  const seen = new Set()
  let visitedDirs = 0
  let truncated = false
  let budgetLimited = false

  for (let index = 0; index < seeds.length; index += 1) {
    if (truncated) break
    const seed = seeds[index]
    const seedKey = String(seed).toLowerCase()
    if (seedKey === '' || seen.has(seedKey)) continue
    seen.add(seedKey)

    // 预算按"剩下的盘"均分：先扫的盘不能把总预算吃光，
    // 否则 D 盘一旦是个大目录树，E、F 盘就完全不会被看一眼。
    const remainingSeeds = seeds.length - index
    const seedBudget = Math.max(1, Math.ceil((limits.maxTotalDirs - visitedDirs) / remainingSeeds))
    const seedStart = visitedDirs

    let seedInfo
    try {
      const target = await fsAdapter.resolve(seed, { signal })
      scanned.push(seed)
      seedInfo = await fsAdapter.stat(target)
    } catch {
      // 候选不存在是常态，不记诊断。
      continue
    }
    if (!seedInfo || seedInfo.type !== 'directory') continue

    // 广度优先：先看浅的，找到就停。
    const queue = [{ path: seed, depth: 0 }]
    while (queue.length > 0) {
      if (visitedDirs >= limits.maxTotalDirs) {
        truncated = true
        break
      }
      if (visitedDirs - seedStart >= seedBudget) {
        // 这块盘分到的份额用完，但总预算还有，后面的盘要继续扫。
        budgetLimited = true
        break
      }
      const current = queue.shift()
      visitedDirs += 1

      const inspected = await inspectInstallRoot(fsAdapter, current.path, { signal, platform })
      scanned.push(...inspected.scanned_paths)
      if (inspected.ok) {
        found.push({ path: current.path, hints: inspected.hints })
        break
      }
      if (current.depth >= limits.maxDepth) continue

      let children
      try {
        const target = await fsAdapter.resolve(current.path, { signal })
        children = await fsAdapter.listDir(target, { signal })
      } catch (error) {
        // 单个子目录读不了不该毁掉整次发现，记诊断继续。
        const mapped = mapFsError(error, { path: current.path, action: '列出子目录' })
        diagnostics.push(mapped.toDiagnostic({ fieldPath: current.path }))
        continue
      }
      let queued = 0
      for (const child of children) {
        if (child.type !== 'directory') continue
        if (PROBE_SKIP_NAMES.includes(child.name.toLowerCase())) continue
        // 种子下面允许一层任意名字（启动器目录常叫 aki-v2 之类），
        // 再深就只认名字里带 comfy 的目录。
        if (current.depth > 0 && !/comfy/i.test(child.name)) continue
        queue.push({ path: join(current.path, child.name), depth: current.depth + 1 })
        queued += 1
        if (queued >= limits.maxEntriesPerDir) break
      }
    }
  }

  if (truncated) {
    diagnostics.push(
      diagnosticOf(COMFY_CODES.SCAN_PARTIAL, `盘符探测达到上限（${limits.maxTotalDirs} 个目录），可能还有没看到的安装。`, {
        suggestedFix: '如果确实装在更深处，请直接填写 comfyui.installRoot。',
      }),
    )
  } else if (budgetLimited) {
    diagnostics.push(
      diagnosticOf(
        COMFY_CODES.SCAN_PARTIAL,
        `盘符探测按每块盘 ${Math.max(1, Math.ceil(limits.maxTotalDirs / Math.max(1, seeds.length)))} 个目录均分预算，部分盘可能还有更深的安装没看到。`,
        { suggestedFix: '如果确实装在更深处，请直接填写 comfyui.installRoot。' },
      ),
    )
  }

  return { found, diagnostics, scanned_paths: scanned, visited_dirs: visitedDirs, truncated }
}

/**
 * 判定一个目录是不是 ComfyUI 安装根。
 * 只 stat 固定几个相对路径，不枚举目录内容。
 */
export async function inspectInstallRoot(fsAdapter, rootPath, { signal, platform = process.platform } = {}) {
  const windows = platform === 'win32'
  const scanned = []
  // 先记下尝试过的位置，再看它能不能解析：发现日志要如实反映"找过哪里"，
  // 不能因为路径不存在就把这次尝试从记录里抹掉。
  scanned.push(rootPath)
  let target
  try {
    target = await fsAdapter.resolve(rootPath, { signal })
  } catch (error) {
    return { ok: false, path: rootPath, reason: 'unresolved', error: mapFsError(error, { path: rootPath, action: '解析安装根' }), scanned_paths: scanned }
  }

  let info
  try {
    info = await fsAdapter.stat(target, { signal })
  } catch (error) {
    return { ok: false, path: rootPath, reason: 'denied', error: mapFsError(error, { path: rootPath, action: '读取安装根' }), scanned_paths: scanned }
  }
  if (!info) return { ok: false, path: rootPath, reason: 'missing', error: null, scanned_paths: scanned }
  if (info.type !== 'directory') return { ok: false, path: rootPath, reason: 'not_directory', error: null, scanned_paths: scanned }

  const present = []
  const missing = []
  for (const marker of INSTALL_MARKERS) {
    const markerPath = windows ? joinWin(rootPath, marker) : joinPosix(rootPath, marker)
    scanned.push(markerPath)
    try {
      const markerTarget = await fsAdapter.resolve(markerPath, { signal })
      const markerInfo = await fsAdapter.stat(markerTarget, { signal })
      if (markerInfo && markerInfo.type === 'file') present.push(marker)
      else missing.push(marker)
    } catch {
      missing.push(marker)
    }
  }

  const hints = []
  for (const hint of INSTALL_HINTS) {
    const hintPath = windows ? joinWin(rootPath, hint) : joinPosix(rootPath, hint)
    scanned.push(hintPath)
    try {
      const hintTarget = await fsAdapter.resolve(hintPath, { signal })
      const hintInfo = await fsAdapter.stat(hintTarget, { signal })
      if (hintInfo) hints.push(hint)
    } catch {
      /* 提示项缺失不影响判定 */
    }
  }

  return {
    ok: missing.length === 0,
    path: rootPath,
    reason: missing.length === 0 ? 'ok' : 'incomplete',
    present,
    missing,
    hints,
    error: null,
    scanned_paths: scanned,
  }
}

/** 读一个 YAML 文件并解析出模型根。文件不存在不算错，权限问题进 diagnostics。 */
export async function readModelPathsYamlFile(
  fsAdapter,
  filePath,
  { YAML, env = {}, homedir = null, windows = true, signal } = {},
) {
  const loaded = await readTextFile(fsAdapter, filePath, { signal })
  if (!loaded.exists || loaded.text === null) {
    return {
      file: filePath,
      exists: loaded.exists,
      roots: [],
      diagnostics: loaded.diagnostics,
      scanned_paths: loaded.scanned_paths,
    }
  }

  const yamlDir = dirnameOf(filePath, windows)
  try {
    const parsed = parseModelPathsYaml(loaded.text, { yamlFile: filePath, yamlDir, env, homedir, windows, YAML })
    return {
      file: filePath,
      exists: true,
      roots: parsed.roots,
      diagnostics: [...loaded.diagnostics, ...(parsed.diagnostics ?? [])],
      scanned_paths: loaded.scanned_paths,
    }
  } catch (error) {
    return {
      file: filePath,
      exists: true,
      roots: [],
      diagnostics: [
        ...loaded.diagnostics,
        diagnosticOf(COMFY_CODES.VALIDATION_FAILED, `${filePath} 解析失败：${error?.message ?? error}`, {
          fieldPath: filePath,
          suggestedFix: '检查 YAML 是否为单文档、顶层是否为映射、是否使用了自定义标签。',
        }),
      ],
      scanned_paths: loaded.scanned_paths,
    }
  }
}

/** 读一个普通文本文件。不存在返回 exists:false，权限问题进 diagnostics，不抛。 */
export async function readTextFile(fsAdapter, filePath, { signal } = {}) {
  const scanned = [filePath]
  let target
  try {
    target = await fsAdapter.resolve(filePath, { signal })
  } catch (error) {
    const mapped = mapFsError(error, { path: filePath, action: '解析文件' })
    // 文件不存在是常态（每个候选都要试一遍），不当成诊断刷屏。
    const diagnostics = mapped.code === COMFY_CODES.PATH_MISSING ? [] : [mapped.toDiagnostic({ fieldPath: filePath })]
    return { file: filePath, exists: false, text: null, diagnostics, scanned_paths: scanned }
  }
  let info
  try {
    info = await fsAdapter.stat(target, { signal })
  } catch (error) {
    const mapped = mapFsError(error, { path: filePath, action: '读取元数据' })
    return { file: filePath, exists: false, text: null, diagnostics: [mapped.toDiagnostic({ fieldPath: filePath })], scanned_paths: scanned }
  }
  if (!info) return { file: filePath, exists: false, text: null, diagnostics: [], scanned_paths: scanned }
  if (info.type !== 'file') {
    return {
      file: filePath,
      exists: false,
      text: null,
      diagnostics: [diagnosticOf(COMFY_CODES.VALIDATION_FAILED, `${filePath} 不是普通文件。`, { fieldPath: filePath })],
      scanned_paths: scanned,
    }
  }
  try {
    const text = await fsAdapter.readTextBounded(target, { signal })
    return { file: filePath, exists: true, text, diagnostics: [], scanned_paths: scanned }
  } catch (error) {
    const mapped = mapFsError(error, { path: filePath, action: '读取文件' })
    return { file: filePath, exists: true, text: null, diagnostics: [mapped.toDiagnostic({ fieldPath: filePath })], scanned_paths: scanned }
  }
}

function rootsFromYamlParsed(parsed, { source, priority, installRoot }) {
  const roots = []
  for (const root of parsed.roots ?? []) {
    if (!root.path) continue
    roots.push({
      path: root.path,
      category: root.category ?? null,
      category_raw: root.category_raw ?? null,
      is_default: root.is_default === true,
      source,
      priority,
      yaml_file: root.yaml_file ?? null,
      install_root: installRoot ?? null,
      unresolved: root.unresolved ?? null,
    })
  }
  return roots
}

function modelRootsForInstall({ installRoot, argv, platform }) {
  const join = platform === 'win32' ? joinWin : joinPosix
  const roots = []
  const push = (path, source, isDefault) => {
    if (!path) return
    if (roots.some((item) => item.path.toLowerCase() === String(path).toLowerCase())) return
    roots.push({ path, category: null, category_raw: null, is_default: isDefault, source, priority: 0, yaml_file: null, install_root: installRoot ?? null })
  }

  if (argv?.models_directory) push(argv.models_directory, 'arg_models_directory', true)
  if (argv?.base_directory) push(join(argv.base_directory, 'models'), 'arg_base_directory', true)
  if (installRoot) push(join(installRoot, 'models'), 'install_models', true)
  return roots
}

/**
 * 主入口：返回候选安装与各自的模型根，不做任何写操作。
 *
 * 参数全部可注入，测试不需要真进程、真网络、真磁盘。
 */
export async function discoverComfyUI({
  fsAdapter,
  platform = process.platform,
  env = {},
  homedir = null,
  YAML = null,
  userSettings = null,
  processResult = null,
  driveRoots = [],
  probeRuntime = null,
  signal,
} = {}) {
  const windows = platform === 'win32'
  const diagnostics = []
  const scannedPaths = []
  const candidates = []
  const seenRoots = new Set()

  const addCandidate = (candidate) => {
    const key = String(candidate.installation_root ?? candidate.runtime_base_url ?? '').toLowerCase()
    if (key === '') return null
    const existing = candidates.find((item) => String(item.installation_root ?? '').toLowerCase() === key)
    if (existing) {
      for (const root of candidate.model_roots) {
        const rootKey = `${root.path.toLowerCase()}`
        if (seenRoots.has(rootKey)) continue
        seenRoots.add(rootKey)
        existing.model_roots.push(root)
      }
      if (candidate.extra_model_paths_config) {
        existing.extra_model_paths_config = [
          ...new Set([...(existing.extra_model_paths_config ?? []), ...candidate.extra_model_paths_config]),
        ]
      }
      if (candidate.runtime_base_url && !existing.runtime_base_url) existing.runtime_base_url = candidate.runtime_base_url
      return existing
    }
    for (const root of candidate.model_roots) seenRoots.add(root.path.toLowerCase())
    candidates.push(candidate)
    return candidate
  }

  // 1) 用户显式配置优先，且不允许被自动发现覆盖。
  if (userSettings?.installRoot) {
    const inspected = await inspectInstallRoot(fsAdapter, userSettings.installRoot, { signal, platform })
    scannedPaths.push(...inspected.scanned_paths)
    if (!inspected.ok && inspected.error) diagnostics.push(inspected.error.toDiagnostic({ fieldPath: 'comfyui.installRoot' }))
    addCandidate({
      id: 'user-install-root',
      installation_root: userSettings.installRoot,
      model_roots: modelRootsForInstall({ installRoot: userSettings.installRoot, argv: null, platform }),
      extra_model_paths_config: [...(userSettings.extraModelPathsConfigFiles ?? [])],
      runtime_base_url: userSettings.baseUrl ?? null,
      discovery_source: DISCOVERY_SOURCES.USER_CONFIG,
      confidence: CONFIDENCE.HIGH,
      status: inspected.ok ? DISCOVERY_STATUS.FOUND : DISCOVERY_STATUS.PARTIAL,
      verified: inspected.ok,
      diagnostics: [],
    })
  }

  // 2) 进程发现：能拿到真实的启动参数、工作目录与端口。
  if (processResult?.available) {
    for (const proc of processResult.candidates ?? []) {
      const argv = parseComfyArgv(proc.command_line ?? '', { windows })
      const installRoot = argv.install_root ?? (proc.executable_path ? dirnameOf(proc.executable_path, windows) : null)
      if (!installRoot) continue
      const inspected = await inspectInstallRoot(fsAdapter, installRoot, { signal, platform })
      scannedPaths.push(...inspected.scanned_paths)
      if (!inspected.ok && inspected.error) diagnostics.push(inspected.error.toDiagnostic())
      // 进程跑的是 ComfyUI 的 main.py，就认它是核心程序——不管是谁拉起来的。
      // 但如果这个 main.py 长在官方 Desktop 的应用包里，只标注、不当成受支持的安装方式。
      const desktopBundle = isDesktopBundlePath(installRoot, { platform })
      const candidateDiagnostics = []
      if (desktopBundle) {
        candidateDiagnostics.push(
          diagnosticOf(
            COMFY_CODES.CAPABILITY_UNAVAILABLE,
            `进程 ${proc.pid ?? 'unknown'} 运行的 main.py 位于官方 ComfyUI Desktop 的应用包内；本项目只适配本地 ComfyUI 核心程序，不把 Desktop 当作受支持的安装方式。`,
            {
              fieldPath: installRoot,
              suggestedFix: '如果要长期使用，请把 comfyui.installRoot 指向你自己安装的 ComfyUI 目录。',
            },
          ),
        )
      }
      addCandidate({
        id: `process-${proc.pid ?? 'unknown'}`,
        pid: proc.pid ?? null,
        installation_root: installRoot,
        model_roots: modelRootsForInstall({ installRoot, argv, platform }),
        extra_model_paths_config: [...new Set(argv.extra_model_paths_config ?? [])],
        runtime_base_url: argv.port ? `http://127.0.0.1:${argv.port}` : null,
        discovery_source: DISCOVERY_SOURCES.PROCESS,
        confidence: inspected.ok ? CONFIDENCE.HIGH : CONFIDENCE.MEDIUM,
        status: inspected.ok ? DISCOVERY_STATUS.FOUND : DISCOVERY_STATUS.PARTIAL,
        verified: inspected.ok,
        desktop_bundle: desktopBundle,
        diagnostics: candidateDiagnostics,
      })
    }
  }

  // 3) 有限候选位置。每个位置只 stat 固定几个相对路径。
  const knownCandidates = knownInstallCandidates({ platform, env, driveRoots })
  for (const candidate of knownCandidates) {
    const inspected = await inspectInstallRoot(fsAdapter, candidate.path, { signal, platform })
    scannedPaths.push(...inspected.scanned_paths)
    if (!inspected.ok) continue
    addCandidate({
      id: `known-${candidates.length + 1}`,
      installation_root: candidate.path,
      model_roots: modelRootsForInstall({ installRoot: candidate.path, argv: null, platform }),
      extra_model_paths_config: [],
      runtime_base_url: null,
      discovery_source: candidate.source,
      confidence: inspected.hints.length > 0 ? CONFIDENCE.HIGH : CONFIDENCE.MEDIUM,
      status: DISCOVERY_STATUS.FOUND,
      verified: true,
      label: candidate.label,
      diagnostics: [],
    })
  }

  // 3b) 有界下探：整合启动器会把 ComfyUI 埋在 <盘>:\ComfyUI\<启动器>\<启动器>\ComfyUI，
  // 固定候选只到 <盘>:\ComfyUI 就停了。从候选路径往下走几层，找到安装根就停。
  const seeds = [
    ...knownCandidates.map((item) => item.path),
    ...(userSettings?.installRoot ? [userSettings.installRoot] : []),
  ]
  if (seeds.length > 0) {
    const probed = await probeComfyDirectories(fsAdapter, { seeds, platform, signal })
    scannedPaths.push(...probed.scanned_paths)
    diagnostics.push(...probed.diagnostics)
    for (const hit of probed.found) {
      addCandidate({
        id: `drive-${candidates.length + 1}`,
        installation_root: hit.path,
        model_roots: modelRootsForInstall({ installRoot: hit.path, argv: null, platform }),
        extra_model_paths_config: [],
        runtime_base_url: null,
        discovery_source: DISCOVERY_SOURCES.KNOWN_LOCATION,
        confidence: hit.hints.length > 0 ? CONFIDENCE.HIGH : CONFIDENCE.MEDIUM,
        status: DISCOVERY_STATUS.FOUND,
        verified: true,
        label: '磁盘上的 ComfyUI 目录',
        diagnostics: [],
      })
    }
  }

  // 4) 每个候选读它自己的 YAML：安装根下的默认 YAML + 显式指定的 YAML。
  for (const candidate of candidates) {
    const files = new Set(candidate.extra_model_paths_config ?? [])
    if (candidate.installation_root) {
      files.add(windows ? joinWin(candidate.installation_root, 'extra_model_paths.yaml') : joinPosix(candidate.installation_root, 'extra_model_paths.yaml'))
    }
    for (const file of files) {
      const parsed = await readModelPathsYamlFile(fsAdapter, file, { YAML, env, homedir, windows, signal })
      scannedPaths.push(...parsed.scanned_paths)
      if (parsed.diagnostics.length > 0) candidate.diagnostics.push(...parsed.diagnostics)
      if (!parsed.exists) continue
      if (!candidate.extra_model_paths_config.includes(file)) candidate.extra_model_paths_config.push(file)
      for (const root of rootsFromYamlParsed(parsed, { source: DISCOVERY_SOURCES.PROCESS, priority: 1, installRoot: candidate.installation_root })) {
        const rootKey = root.path.toLowerCase()
        if (seenRoots.has(rootKey)) continue
        seenRoots.add(rootKey)
        candidate.model_roots.push(root)
      }
    }
  }

  // 5) 用户显式追加的模型根，永远排在候选自己的推导结果之后但保留。
  for (const path of userSettings?.additionalModelRoots ?? []) {
    const primary = candidates[0]
    if (!primary) break
    const key = String(path).toLowerCase()
    if (seenRoots.has(key)) continue
    seenRoots.add(key)
    primary.model_roots.push({
      path,
      category: null,
      category_raw: null,
      is_default: false,
      source: DISCOVERY_SOURCES.USER_CONFIG,
      priority: 0,
      yaml_file: null,
      install_root: primary.installation_root ?? null,
    })
  }

  // 6) 运行状态探测：只探 loopback，失败就是没运行，不当成错误。
  if (typeof probeRuntime === 'function') {
    for (const candidate of candidates) {
      const baseUrl = candidate.runtime_base_url ?? (candidates.length === 1 ? userSettings?.baseUrl ?? null : null)
      if (!baseUrl) {
        candidate.runtime_reachable = null
        continue
      }
      try {
        const probed = await probeRuntime({ baseUrl, signal })
        candidate.runtime_reachable = probed?.ok === true
        if (probed?.ok) {
          candidate.runtime_base_url = baseUrl
          // 能连上只证明"有服务在跑"，证明不了安装根和模型根是对的。
          // 没通过安装根校验的候选保持 partial，不能被一次成功探测洗白。
          if (candidate.verified) candidate.status = DISCOVERY_STATUS.FOUND
        } else if (probed?.error) {
          candidate.diagnostics.push(probed.error)
        }
      } catch (error) {
        candidate.runtime_reachable = false
        candidate.diagnostics.push(
          diagnosticOf(COMFY_CODES.CONNECTION_FAILED, `探测 ${baseUrl} 失败：${error?.message ?? error}`, {
            fieldPath: 'comfyui.baseUrl',
          }),
        )
      }
    }
  }

  for (const candidate of candidates) {
    candidate.model_roots.sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9))
    candidate.models_root = candidate.model_roots.find((root) => root.is_default)?.path ?? candidate.model_roots[0]?.path ?? null
    candidate.runtime_reachable = candidate.runtime_reachable ?? null
    if (candidate.status === DISCOVERY_STATUS.FOUND && candidate.runtime_reachable === false) {
      candidate.status = DISCOVERY_STATUS.NOT_RUNNING
    }
  }

  candidates.sort((a, b) => {
    const pa = SOURCE_PRIORITY[a.discovery_source] ?? 9
    const pb = SOURCE_PRIORITY[b.discovery_source] ?? 9
    if (pa !== pb) return pa - pb
    return String(a.installation_root ?? '').localeCompare(String(b.installation_root ?? ''))
  })

  let status = DISCOVERY_STATUS.NOT_FOUND
  if (candidates.length === 1) status = candidates[0].status
  else if (candidates.length > 1) status = DISCOVERY_STATUS.AMBIGUOUS

  return {
    status,
    candidates,
    selected: candidates.length === 1 ? candidates[0] : null,
    diagnostics,
    scanned_paths: [...new Set(scannedPaths)],
    process_available: processResult?.available === true,
    drive_roots: [...driveRoots],
  }
}
