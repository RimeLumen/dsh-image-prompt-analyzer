
import { COMFY_CODES, ComfyError } from './errors.js'

/**
 * 启动器的动作是固定枚举。这里根本没有"接收一条命令"的参数，
 * 所以"禁止任意 Shell"不是靠过滤字符串实现的，是靠接口形状。
 */
export const LAUNCHER_ACTIONS = Object.freeze({
  OPEN_LAUNCHER: 'open_launcher',
  START_BACKEND: 'start_backend',
  OPEN_INSTALL_FOLDER: 'open_install_folder',
  OPEN_WEB_UI: 'open_web_ui',
})

export const LAUNCHER_ACTION_VALUES = Object.freeze(Object.values(LAUNCHER_ACTIONS))

/** 整合包与手动安装里常见的启动器文件名。只按名字 stat，不遍历目录。 */
export const LAUNCHER_FILES = Object.freeze({
  win32: Object.freeze([
    'A绘世启动器.exe',
    '绘世启动器.exe',
    'ComfyUI.exe',
    'run_nvidia_gpu.bat',
    'run_cpu.bat',
    'run.bat',
  ]),
  posix: Object.freeze(['run_nvidia_gpu.sh', 'run_cpu.sh', 'run.sh']),
})

/** 便携版与 venv 里 python 解释器的常见位置。同样只 stat 固定几个相对路径。 */
export const PYTHON_CANDIDATES = Object.freeze({
  win32: Object.freeze([
    'python_embeded/python.exe',
    'python/python.exe',
    'venv/Scripts/python.exe',
    '.venv/Scripts/python.exe',
  ]),
  posix: Object.freeze(['python_embeded/bin/python', 'venv/bin/python', '.venv/bin/python']),
})

/** 打开文件夹/URL 这类动作本身几毫秒就返回；超时只说明"它还在跑"，不算失败。 */
export const SHELL_OPEN_TIMEOUT_MS = 2500
/** 后端日志会被收集到内存里，给一个够看启动错误的上限。 */
export const MAX_BACKEND_OUTPUT_BYTES = 256 * 1024

function flavorOf(platform) {
  return platform === 'win32' ? 'win32' : 'posix'
}

export function separatorOf(platform) {
  return platform === 'win32' ? '\\' : '/'
}

/** 拼接安装根下的相对路径。用户给的根可能带尾分隔符，统一去掉再接。 */
export function joinPath(root, relative, platform = process.platform) {
  const sep = separatorOf(platform)
  const base = String(root).replace(/[\\/]+$/, '')
  const rest = String(relative)
    .split(/[\\/]+/)
    .filter((part) => part !== '')
    .join(sep)
  return rest === '' ? base : `${base}${sep}${rest}`
}

/**
 * 取上一级目录。整合包把 ComfyUI 埋在内层，启动器通常在外层，
 * 所以找启动器要往上一级看一层——但也只看一层，不往上爬。
 */
export function parentPath(value, platform = process.platform) {
  const sep = separatorOf(platform)
  const trimmed = String(value).replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (index < 0) return null
  const parent = trimmed.slice(0, index)
  if (parent === '') return sep
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}${sep}`
  return parent
}

async function statKind(fsAdapter, path, { signal } = {}) {
  const target = await fsAdapter.resolve(path, { signal })
  const info = await fsAdapter.stat(target, { signal })
  return info?.type ?? null
}

/**
 * 在安装根和它的上一级里找已知启动器。找不到是常态，不抛错。
 * 返回全部命中项，让调用方决定"零个"和"多个"分别怎么报。
 */
export async function findLauncherCandidates(fsAdapter, installRoot, { platform = process.platform, signal } = {}) {
  const names = LAUNCHER_FILES[flavorOf(platform)]
  const roots = [installRoot]
  const parent = parentPath(installRoot, platform)
  if (parent && parent !== installRoot) roots.push(parent)

  const scanned = []
  const candidates = []
  for (const root of roots) {
    for (const name of names) {
      const path = joinPath(root, name, platform)
      scanned.push(path)
      try {
        if ((await statKind(fsAdapter, path, { signal })) === 'file') {
          candidates.push({ path, name, directory: root })
        }
      } catch {
        // 这个位置没有这个文件，或者没权限看：都只说明"这里没有"，不是错误。
      }
    }
  }
  return { candidates, scanned_paths: scanned }
}

/**
 * 便携版 python 的位置。找不到返回 null，让调用方给出扫描过的路径。
 * 整合包把 python 放在安装根的上一级（`<包>/python/python.exe`，安装根是
 * `<包>/ComfyUI`），所以和启动器一样往上一级再找一遍。
 */
export async function findPython(fsAdapter, installRoot, { platform = process.platform, signal } = {}) {
  const scanned = []
  const roots = [installRoot]
  const parent = parentPath(installRoot, platform)
  if (parent && parent !== installRoot) roots.push(parent)

  for (const root of roots) {
    for (const relative of PYTHON_CANDIDATES[flavorOf(platform)]) {
      const path = joinPath(root, relative, platform)
      scanned.push(path)
      try {
        if ((await statKind(fsAdapter, path, { signal })) === 'file') return { path, scanned_paths: scanned }
      } catch {
        // 同上：没有就是没有。
      }
    }
  }
  return { path: null, scanned_paths: scanned }
}

function requireSubprocess(subprocess, action) {
  if (!subprocess || typeof subprocess.spawn !== 'function') {
    throw new ComfyError(
      COMFY_CODES.CAPABILITY_UNAVAILABLE,
      `当前 Host 没有提供 subprocess 服务，无法${action}。`,
      '这个 profile 没挂载 subprocess；手动启动 ComfyUI，或用 comfyui_status 查看连接状态。',
    )
  }
  return subprocess
}

async function waitForLaunch(handle, ms) {
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timeout' }), ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  const settled = Promise.resolve(handle.done).then(
    (outcome) => ({ status: 'exited', outcome }),
    (error) => ({ status: 'error', error }),
  )
  try {
    return await Promise.race([settled, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 用系统的默认关联打开一个文件夹、文件或 URL。
 * Windows 走 explorer.exe / rundll32.exe：这两个都是固定可执行文件 + 一个目标参数，
 * 目标不会被当成命令行再解析一遍，所以路径里有空格、括号也不会变形。
 */
export async function openWithShell({ subprocess, platform = process.platform, target, kind = 'file', signal } = {}) {
  const service = requireSubprocess(subprocess, '打开文件夹或链接')
  const windows = platform === 'win32'
  const argv = windows
    ? kind === 'url'
      ? ['rundll32.exe', 'url.dll,FileProtocolHandler', target]
      : ['explorer.exe', target]
    : ['xdg-open', target]

  let handle
  try {
    handle = service.spawn({
      argv,
      cwd: windows ? 'C:\\' : '/',
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 8192 },
        stderr: { maxBytes: 8192 },
      },
      graceMs: 1500,
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    throw new ComfyError(
      COMFY_CODES.CAPABILITY_UNAVAILABLE,
      `无法调用 ${argv[0]} 打开 ${target}：${error?.message ?? error}`,
      '手动打开这个位置；插件不会改用别的命令再试一次。',
    )
  }

  const result = await waitForLaunch(handle, SHELL_OPEN_TIMEOUT_MS)
  return {
    target,
    kind,
    command: argv[0],
    // 超时不等于失败：explorer.exe 有时会把父进程挂着不退。
    exited: result.status === 'exited',
    exit_code: result.status === 'exited' ? (result.outcome?.exitCode ?? null) : null,
    timed_out: result.status === 'timeout',
    error: result.status === 'error' ? String(result.error?.message ?? result.error) : null,
  }
}

/**
 * 直接启动后端：<python> main.py --listen 127.0.0.1 --port <port>。
 *
 * 参数是写死的，端口来自已经校验过的回环 baseUrl。--listen 127.0.0.1 是刻意加的：
 * 这个插件只跟本机回环通信，没有理由把服务暴露到局域网。
 *
 * 这个进程由 Host 的 subprocess 服务托管，所以插件卸载 / Host 退出会把它结束。
 * 反过来，用户自己启动的 ComfyUI 不归这里管，插件永远不会去动它。
 */
export async function startBackend({
  subprocess,
  fsAdapter,
  installRoot,
  port,
  platform = process.platform,
  signal,
} = {}) {
  const service = requireSubprocess(subprocess, '启动 ComfyUI 后端')

  const mainPy = joinPath(installRoot, 'main.py', platform)
  let mainKind = null
  try {
    mainKind = await statKind(fsAdapter, mainPy, { signal })
  } catch (error) {
    if (error?.code === COMFY_CODES.PATH_MISSING) mainKind = null
    else throw error
  }
  if (mainKind !== 'file') {
    throw new ComfyError(
      COMFY_CODES.PATH_MISSING,
      `${installRoot} 下没有 main.py，这里不是 ComfyUI 安装目录。`,
      '把 comfyui.installRoot 指向含 main.py 的那一层。',
    )
  }

  const python = await findPython(fsAdapter, installRoot, { platform, signal })
  if (!python.path) {
    throw new ComfyError(
      COMFY_CODES.CAPABILITY_UNAVAILABLE,
      `在 ${installRoot} 下没找到 python 解释器，没法直接启动后端。`,
      `找过这些位置：${python.scanned_paths.join('、')}。整合包请用"打开启动器"，或手动启动。`,
    )
  }

  const argv = [python.path, 'main.py', '--listen', '127.0.0.1', '--port', String(port)]
  let handle
  try {
    handle = service.spawn({
      argv,
      cwd: installRoot,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: MAX_BACKEND_OUTPUT_BYTES },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: 3000,
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    throw new ComfyError(
      COMFY_CODES.CAPABILITY_UNAVAILABLE,
      `启动 ComfyUI 后端失败：${error?.message ?? error}`,
      '手动在安装目录里运行启动脚本，再用 comfyui_status 确认连接。',
    )
  }

  return { handle, argv, cwd: installRoot, python: python.path, port }
}
