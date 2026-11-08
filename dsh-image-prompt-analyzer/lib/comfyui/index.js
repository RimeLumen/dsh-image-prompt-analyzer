
import { diagnostic, SEVERITY } from '../diagnostics.js'
import { COMFY_CODES, ComfyError, SUGGESTED_FIX } from './errors.js'
import { createFsAdapter } from './fs-adapter.js'
import { deriveScanRoots, joinLikePython, parseModelPathsYaml } from './paths.js'
import { createCatalogCache, scanModelRoots } from './catalog.js'
import { createComfyClient } from './client.js'
import { DISCOVERY_STATUS, collectDriveRoots, collectProcessCandidates, discoverComfyUI } from './discovery.js'
import { reconcileModels } from './reconcile.js'
import { sniffImage } from './image-info.js'
import { inspectWorkflow, requireApiPrompt } from './workflow.js'
import { applyWorkflowPatch, planWorkflowPatch, stableFingerprint } from './patch.js'
import { listWorkflows, matchWorkflows, resolveWorkflowByName, workflowRoots } from './workflows.js'
import { createObjectInfoCache, fetchNodeInfos, projectNodeInfo } from './object-info.js'
import { buildWorkflow as buildApiWorkflow, classesInPrompt, validateBuiltWorkflow } from './build.js'
import { createRunRegistry, imageViewUrl, isSafeOutputRef, queryRun, submitPrompt } from './runs.js'
import {
  LAUNCHER_ACTIONS,
  LAUNCHER_ACTION_VALUES,
  findLauncherCandidates,
  openWithShell,
  startBackend,
} from './launcher.js'

export { COMFY_CODES, ComfyError, SUGGESTED_FIX }
export { createFsAdapter } from './fs-adapter.js'
export { parseModelPathsYaml, deriveScanRoots, joinLikePython } from './paths.js'
export { scanModelRoots, createCatalogCache } from './catalog.js'
export { createComfyClient } from './client.js'
export { reconcileModels, filterByStates, MODEL_STATES } from './reconcile.js'
export { inspectWorkflow, detectWorkflowFormat, inspectApiPrompt } from './workflow.js'
export { planWorkflowPatch, applyWorkflowPatch, diffPatch } from './patch.js'
export { listWorkflows, resolveWorkflowByName, workflowRoots, matchWorkflows, looseWorkflowKey } from './workflows.js'
export { createObjectInfoCache, projectNodeInfo, optionsForInput, suggestOptions, MAX_OPTIONS_SHOWN } from './object-info.js'
export { buildWorkflow, validateBuiltWorkflow, classesInPrompt, BUILD_DEFAULTS, BUILD_LOADERS } from './build.js'
export { submitPrompt, queryRun, RUN_STATES, isValidPromptId, createRunRegistry, imageViewUrl, describeExecution, buildExecutionSuccess, isSafeOutputRef, isSafeOutputSubfolder } from './runs.js'
export { sniffImage, IMAGE_MEDIA_TYPES } from './image-info.js'
export {
  LAUNCHER_ACTIONS,
  LAUNCHER_ACTION_VALUES,
  LAUNCHER_FILES,
  PYTHON_CANDIDATES,
  findLauncherCandidates,
  findPython,
  joinPath,
  parentPath,
  openWithShell,
  startBackend,
} from './launcher.js'

export const DEFAULT_COMFY_BASE_URL = 'http://127.0.0.1:8188'
/** 装完即用：默认打开，默认自动发现。显式写 false 才会关掉。 */
export const DEFAULT_COMFY_ENABLED = true
export const DEFAULT_COMFY_AUTO_DETECT = true
export const DEFAULT_COMFY_TIMEOUT_MS = 30000
export const COMFY_TIMEOUT_RANGE = Object.freeze({ min: 1000, max: 600000 })
/** /object_info 的进程内缓存时长。节点定义只在装/卸自定义节点时变，五分钟够稳。 */
export const DEFAULT_OBJECT_INFO_TTL_MS = 5 * 60 * 1000
export const OBJECT_INFO_TTL_RANGE = Object.freeze({ min: 1000, max: 24 * 60 * 60 * 1000 })

const KNOWN_KEYS = Object.freeze([
  'enabled',
  'autoDetect',
  'baseUrl',
  'installRoot',
  'extraModelPathsConfigFiles',
  'additionalModelRoots',
  'workflowDirs',
  'requestTimeoutMs',
  'objectInfoTtlMs',
])

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

function configIssue(code, fieldPath, message, configFile) {
  return diagnostic({
    error_code: code,
    severity: SEVERITY.ERROR,
    config_file: configFile,
    field_path: fieldPath,
    message,
    suggested_fix: SUGGESTED_FIX[code] ?? '检查 comfyui 段配置。',
  })
}

/** 绝对路径判断只看写法，不碰文件系统：盘符、UNC、POSIX 根三种。 */
export function isAbsoluteFsPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  if (value.startsWith('/')) return true
  if (value.startsWith('\\\\')) return true
  return /^[A-Za-z]:[\\/]/.test(value)
}

/**
 * 纯函数：把 comfyui 段规范化并校验。不读文件、不发请求、不建定时器。
 * 校验失败的字段回退成默认值，让后续的数值区间守卫不会对同一个字段重复报错。
 */
export function normalizeComfySettings(raw, { configFile = 'plugin config' } = {}) {
  const diagnostics = []
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const settings = {
    enabled: DEFAULT_COMFY_ENABLED,
    autoDetect: DEFAULT_COMFY_AUTO_DETECT,
    baseUrl: DEFAULT_COMFY_BASE_URL,
    installRoot: null,
    extraModelPathsConfigFiles: [],
    additionalModelRoots: [],
    workflowDirs: [],
    requestTimeoutMs: DEFAULT_COMFY_TIMEOUT_MS,
    objectInfoTtlMs: DEFAULT_OBJECT_INFO_TTL_MS,
  }

  for (const key of Object.keys(input)) {
    if (KNOWN_KEYS.includes(key)) continue
    diagnostics.push(
      configIssue(
        COMFY_CODES.VALIDATION_FAILED,
        `/comfyui/${key}`,
        `comfyui 段不认识字段 ${key}，它会被忽略（schema 是 additionalProperties: false）。`,
        configFile,
      ),
    )
  }

  if (input.enabled !== undefined) {
    if (typeof input.enabled === 'boolean') settings.enabled = input.enabled
    else
      diagnostics.push(
        configIssue(
          COMFY_CODES.VALIDATION_FAILED,
          '/comfyui/enabled',
          `enabled 必须是布尔值，收到 ${JSON.stringify(input.enabled)}。`,
          configFile,
        ),
      )
  }

  if (input.autoDetect !== undefined) {
    if (typeof input.autoDetect === 'boolean') settings.autoDetect = input.autoDetect
    else
      diagnostics.push(
        configIssue(
          COMFY_CODES.VALIDATION_FAILED,
          '/comfyui/autoDetect',
          `autoDetect 必须是布尔值，收到 ${JSON.stringify(input.autoDetect)}。`,
          configFile,
        ),
      )
  }

  // 用户明确写了 baseUrl 却被拒时，必须连带把功能关掉：
  // 否则"远程地址被拒 → 回退 127.0.0.1 → enabled 仍是 true"会悄悄连上本机服务。
  let baseUrlRejection = null
  if (input.baseUrl !== undefined && input.baseUrl !== null) {
    const parsed = parseLoopbackBaseUrl(input.baseUrl)
    if (parsed.ok) settings.baseUrl = parsed.value
    else {
      baseUrlRejection = parsed.code
      diagnostics.push(
        configIssue(parsed.code, '/comfyui/baseUrl', parsed.message, configFile),
      )
    }
  }

  if (input.installRoot !== undefined && input.installRoot !== null) {
    if (isAbsoluteFsPath(input.installRoot)) settings.installRoot = input.installRoot
    else
      diagnostics.push(
        configIssue(
          COMFY_CODES.PATH_UNRESOLVED,
          '/comfyui/installRoot',
          `installRoot 必须是绝对路径，收到 ${JSON.stringify(input.installRoot)}。`,
          configFile,
        ),
      )
  }

  for (const [field, list] of [
    ['extraModelPathsConfigFiles', input.extraModelPathsConfigFiles],
    ['additionalModelRoots', input.additionalModelRoots],
    ['workflowDirs', input.workflowDirs],
  ]) {
    if (list === undefined || list === null) continue
    if (!Array.isArray(list)) {
      diagnostics.push(
        configIssue(
          COMFY_CODES.VALIDATION_FAILED,
          `/comfyui/${field}`,
          `${field} 必须是字符串数组，收到 ${typeof list}。`,
          configFile,
        ),
      )
      continue
    }
    const accepted = []
    for (const [index, item] of list.entries()) {
      if (isAbsoluteFsPath(item)) {
        accepted.push(item)
        continue
      }
      diagnostics.push(
        configIssue(
          COMFY_CODES.PATH_UNRESOLVED,
          `/comfyui/${field}/${index}`,
          `${field}[${index}] 必须是绝对路径，收到 ${JSON.stringify(item)}。`,
          configFile,
        ),
      )
    }
    settings[field] = accepted
  }

  if (input.requestTimeoutMs !== undefined) {
    if (typeof input.requestTimeoutMs === 'number' && Number.isFinite(input.requestTimeoutMs)) {
      settings.requestTimeoutMs = input.requestTimeoutMs
    } else {
      diagnostics.push(
        configIssue(
          COMFY_CODES.VALIDATION_FAILED,
          '/comfyui/requestTimeoutMs',
          `requestTimeoutMs 必须是数字，收到 ${JSON.stringify(input.requestTimeoutMs)}。`,
          configFile,
        ),
      )
    }
  }

  if (input.objectInfoTtlMs !== undefined) {
    if (typeof input.objectInfoTtlMs === 'number' && Number.isFinite(input.objectInfoTtlMs)) {
      settings.objectInfoTtlMs = input.objectInfoTtlMs
    } else {
      diagnostics.push(
        configIssue(
          COMFY_CODES.VALIDATION_FAILED,
          '/comfyui/objectInfoTtlMs',
          `objectInfoTtlMs 必须是数字，收到 ${JSON.stringify(input.objectInfoTtlMs)}。`,
          configFile,
        ),
      )
    }
  }

  // 被拒的 baseUrl 不能让功能继续开着：任何"回退成默认值后照常连"的路径都是隐患。
  if (baseUrlRejection) {
    settings.enabled = false
    settings.disabled_reason = baseUrlRejection
  }
  return { settings, diagnostics }
}

/** 只接受 http(s) + 回环主机 + 不带凭据 + 不带查询/锚点。 */
export function parseLoopbackBaseUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, code: COMFY_CODES.VALIDATION_FAILED, message: 'baseUrl 必须是非空字符串。' }
  }
  let url
  try {
    url = new URL(raw.trim())
  } catch {
    return { ok: false, code: COMFY_CODES.VALIDATION_FAILED, message: `baseUrl 不是合法 URL：${raw}。` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      code: COMFY_CODES.VALIDATION_FAILED,
      message: `baseUrl 只支持 http/https，收到 ${url.protocol}。`,
    }
  }
  if (url.username || url.password) {
    return {
      ok: false,
      code: COMFY_CODES.VALIDATION_FAILED,
      message: 'baseUrl 里不能内嵌用户名或密码；本版本只连本机、不需要鉴权。',
    }
  }
  if (url.search || url.hash) {
    return {
      ok: false,
      code: COMFY_CODES.VALIDATION_FAILED,
      message: 'baseUrl 不能带查询串或锚点。',
    }
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!LOOPBACK_HOSTS.has(host)) {
    return {
      ok: false,
      code: COMFY_CODES.TARGET_NOT_LOCAL,
      message: `baseUrl 指向 ${host}，不是本机回环地址；本版本不做远程 ComfyUI。`,
    }
  }
  const path = url.pathname.replace(/\/+$/, '')
  return { ok: true, value: `${url.protocol}//${url.host}${path}` }
}

/**
 * 按 Host 声明的图片上限检查一张已经取回的图。
 *
 * 只用文件头读出来的真实格式与尺寸，HTTP 的 Content-Type 不作数。
 * 返回一个 ComfyError 说明第一处不合格，全部合格返回 null。
 */
function imageLimitProblem({ image, actual, declaredMediaType, byteLength, totalBytes, imageLimits }) {
  if (!actual) {
    return new ComfyError(
      COMFY_CODES.OUTPUT_UNAVAILABLE,
      `取回的 ${image.filename} 不是可识别的 PNG/JPEG/WebP/GIF（HTTP 声明 ${declaredMediaType || '无类型'}），没有落盘。`,
      '确认输出节点保存的是图片；必要时改用 SaveImage。',
    )
  }
  if (!imageLimits) return null
  const allowed = Array.isArray(imageLimits.mediaTypes) ? imageLimits.mediaTypes : []
  if (allowed.length > 0 && !allowed.includes(actual.mediaType)) {
    return new ComfyError(
      COMFY_CODES.OUTPUT_UNAVAILABLE,
      `Host 不接受 ${actual.mediaType}，这张图无法作为附件返回。`,
      '改用输出 PNG 的工作流，或只在对话里给出图片 URL。',
    )
  }
  if (typeof imageLimits.maxImageBytes === 'number' && byteLength > imageLimits.maxImageBytes) {
    return new ComfyError(
      COMFY_CODES.OUTPUT_UNAVAILABLE,
      `图片 ${byteLength} 字节，超过 Host 单图上限 ${imageLimits.maxImageBytes} 字节。`,
      '降低分辨率或换更小的输出格式。',
    )
  }
  const pixels = actual.width * actual.height
  if (typeof imageLimits.maxImagePixels === 'number' && pixels > imageLimits.maxImagePixels) {
    return new ComfyError(
      COMFY_CODES.OUTPUT_UNAVAILABLE,
      `图片 ${actual.width}×${actual.height} 共 ${pixels} 像素，超过 Host 上限 ${imageLimits.maxImagePixels} 像素。`,
      '降低分辨率，或分批取回更小的图。',
    )
  }
  const longEdge = Math.max(actual.width, actual.height)
  if (typeof imageLimits.maxImageDimension === 'number' && longEdge > imageLimits.maxImageDimension) {
    return new ComfyError(
      COMFY_CODES.OUTPUT_UNAVAILABLE,
      `图片长边 ${longEdge} 像素，超过 Host 上限 ${imageLimits.maxImageDimension} 像素。`,
      '降低分辨率，或换一个更小的输出尺寸。',
    )
  }
  if (
    typeof imageLimits.maxMessageImageBytes === 'number' &&
    totalBytes + byteLength > imageLimits.maxMessageImageBytes
  ) {
    return new ComfyError(
      COMFY_CODES.OUTPUT_UNAVAILABLE,
      `这张图会让本条消息的图片总大小超过 Host 上限（${imageLimits.maxMessageImageBytes} 字节）。`,
      '减少 batch 数量，或分批取回。',
    )
  }
  return null
}

/**
 * 拼 /view 链接；引用不合法就返回 null，不把整次调用拖挂。
 */
function safeViewUrl(client, image) {
  try {
    return imageViewUrl(client, image)
  } catch {
    return null
  }
}

/**
 * ComfyUI 运行时骨架。
 *
 * 这个工厂是纯的：不读文件、不发请求、不注册监听器、不排定时器。
 * initialize() 只是把状态从 idle 推到 ready，真正的扫描与通信属于后续版本。
 */
export function createComfyRuntime({
  ctx = null,
  pluginConfig = {},
  logger = null,
  fetchImpl = null,
  env = null,
  platform = null,
  subprocess = null,
} = {}) {
  const envVars = env ?? (typeof process !== 'undefined' ? process.env : {})
  const platformName = platform ?? (typeof process !== 'undefined' ? process.platform : 'win32')
  const settings = Object.freeze({
    // 未配置时默认打开；只有显式 false 或 baseUrl 被拒才算关闭。
    enabled:
      (pluginConfig?.comfyui?.enabled ?? DEFAULT_COMFY_ENABLED) === true &&
      !pluginConfig?.comfyui?.disabled_reason,
    autoDetect: (pluginConfig?.comfyui?.autoDetect ?? DEFAULT_COMFY_AUTO_DETECT) === true,
    baseUrl: pluginConfig?.comfyui?.baseUrl ?? DEFAULT_COMFY_BASE_URL,
    installRoot: pluginConfig?.comfyui?.installRoot ?? null,
    extraModelPathsConfigFiles: Object.freeze([
      ...(pluginConfig?.comfyui?.extraModelPathsConfigFiles ?? []),
    ]),
    additionalModelRoots: Object.freeze([...(pluginConfig?.comfyui?.additionalModelRoots ?? [])]),
    // 工作流默认只在 ComfyUI 自己的目录里找；额外目录要用户显式写出来。
    // 这里不接受"扫全盘"，配置里写什么就只看什么。
    workflowDirs: Object.freeze([...(pluginConfig?.comfyui?.workflowDirs ?? [])]),
    requestTimeoutMs: pluginConfig?.comfyui?.requestTimeoutMs ?? DEFAULT_COMFY_TIMEOUT_MS,
    objectInfoTtlMs: pluginConfig?.comfyui?.objectInfoTtlMs ?? DEFAULT_OBJECT_INFO_TTL_MS,
    disabledReason: pluginConfig?.comfyui?.disabled_reason ?? null,
  })

  let phase = 'idle'
  let initializeCount = 0
  let readyAt = null
  let client = null
  let yamlModule = null
  let fsAdapter = null

  /**
   * attachments 是可选 Service：没装的环境里 ctx.get 返回 undefined，
   * 不能当成"附件已保存"。
   */
  function getAttachments() {
    if (!ctx) return null
    try {
      if (typeof ctx.get === 'function') return ctx.get('attachments') ?? null
    } catch {
      return null
    }
    return ctx.attachments ?? null
  }

  const catalogCache = createCatalogCache()
  const runRegistry = createRunRegistry()
  // 节点定义缓存。键里绑着 baseUrl：换实例就整体作废，不拿旧定义去校验新节点。
  const objectInfoCache = createObjectInfoCache({
    ttlMs: settings.objectInfoTtlMs,
    now: () => Date.now(),
  })
  let discoveryCache = null
  // 唯一被真实 HTTP 调用验证过的地址。只有拿到 200 才写，连接失败就清掉，
  // 这样"配置里写着 8188"和"8188 上真有服务"不会混成同一件事。
  let verifiedBaseUrl = null
  // 只记住"本插件自己启动的那个后端"。用户自己开的 ComfyUI 从不进这里，
  // 所以 dispose 时能精确地只结束我们启动的进程，绝不误杀用户的实例。
  let backendProcess = null
  let lastLaunch = null

  // 适配器也要惰性：构造它就要读 ctx.fs，而"只是被取用一下"不该算作访问文件系统。
  function getFs() {
    if (!fsAdapter) fsAdapter = createFsAdapter(ctx)
    return fsAdapter
  }

  function ensureLive(action) {
    if (phase === 'disposed') {
      throw new ComfyError(
        COMFY_CODES.CAPABILITY_UNAVAILABLE,
        `ComfyUI 运行时已释放，不能再执行 ${action}。`,
      )
    }
  }

  /** 关闭状态下任何工具都不得产生本地扫描或网络访问。 */
  function ensureEnabled(action = '该操作') {
    // 任何调用方漏传时都要有可读的动作名，绝不把 undefined 拼进用户可见的消息。
    const label =
      typeof action === 'string' && action.trim() !== '' && action !== 'undefined'
        ? action.trim()
        : '该操作'
    ensureLive(label)
    if (!settings.enabled) {
      throw new ComfyError(
        COMFY_CODES.CAPABILITY_UNAVAILABLE,
        `ComfyUI 集成未启用，${label} 未执行。`,
        settings.disabledReason
          ? `comfyui.baseUrl 配置被拒绝（${settings.disabledReason}），先修正配置再启用。`
          : 'ComfyUI 集成被 comfyui.enabled: false 显式关闭；要启用就删掉这一行，或填好 installRoot / baseUrl 后设为 true。',
      )
    }
  }

  async function loadYaml() {
    if (yamlModule) return yamlModule
    const loaded = await import('yaml')
    yamlModule = loaded.default ?? loaded
    return yamlModule
  }

  async function readYamlFile(filePath, { signal = null, required = false } = {}) {
    const fs = getFs()
    try {
      const target = await fs.resolve(filePath, { signal })
      const info = await fs.stat(target, { signal })
      if (!info || info.type !== 'file') {
        if (required) {
          throw new ComfyError(COMFY_CODES.PATH_MISSING, `YAML 文件不存在：${filePath}`)
        }
        return null
      }
      const text = await fs.readTextBounded(target, { signal })
      return { filePath, text }
    } catch (error) {
      if (!required && error?.code === COMFY_CODES.PATH_MISSING) return null
      throw error
    }
  }

  /** 只发一个 GET /system_stats 判断地址是否活着；失败就是没运行，不抛给调用方。 */
  async function probeRuntimeBaseUrl({ baseUrl, signal = null }) {
    let probeClient
    try {
      probeClient = createComfyClient({
        baseUrl,
        timeoutMs: Math.min(settings.requestTimeoutMs, 3000),
        ...(fetchImpl ? { fetchImpl } : {}),
        ...(env ? { env } : {}),
      })
    } catch (error) {
      return {
        ok: false,
        error: {
          error_code: error?.code ?? COMFY_CODES.CONNECTION_FAILED,
          message: `${baseUrl} 无法探测：${error?.message ?? error}`,
        },
      }
    }
    try {
      await probeClient.getSystemStats({ signal })
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        error: {
          error_code: error?.code ?? COMFY_CODES.CONNECTION_FAILED,
          message: `${baseUrl} 未响应：${error?.message ?? error}`,
        },
      }
    }
  }

  /** 家目录只从环境变量推，不去查系统账户数据库。 */
  function homeDir() {
    if (platformName === 'win32') {
      if (envVars.USERPROFILE) return envVars.USERPROFILE
      if (envVars.HOMEDRIVE && envVars.HOMEPATH) return `${envVars.HOMEDRIVE}${envVars.HOMEPATH}`
      return null
    }
    return envVars.HOME ?? null
  }

  /**
   * 自动发现。惰性：只有被调用时才碰 fs 与进程表，插件加载阶段什么都不做。
   * 结果缓存在进程内存里，refresh 才会重来。
   */
  async function discover({ refresh = false, probe = true, signal = null } = {}) {
    ensureEnabled('自动发现 ComfyUI')
    if (!settings.autoDetect) {
      return {
        status: DISCOVERY_STATUS.NOT_FOUND,
        auto_detect: false,
        candidates: [],
        selected: null,
        diagnostics: [],
        scanned_paths: [],
        process_available: false,
      }
    }
    if (!refresh && discoveryCache) return discoveryCache

    const fs = getFs()
    const YAML = await loadYaml()
    const subprocessService =
      subprocess ?? (typeof ctx?.get === 'function' ? (ctx.get('subprocess') ?? null) : null)
    const processResult = await collectProcessCandidates({
      subprocess: subprocessService,
      platform: platformName,
      ...(signal ? { signal } : {}),
    })

    // 整合启动器（绘世、aki 之类）会把 ComfyUI 埋在任意盘的深层目录里，
    // 固定候选碰不到。先拿到盘符列表，交给发现流程做有界探测。
    const driveResult = await collectDriveRoots({
      subprocess: subprocessService,
      platform: platformName,
      ...(signal ? { signal } : {}),
    })

    const result = await discoverComfyUI({
      fsAdapter: fs,
      platform: platformName,
      env: envVars,
      homedir: homeDir(),
      YAML,
      userSettings: {
        installRoot: settings.installRoot,
        extraModelPathsConfigFiles: [...settings.extraModelPathsConfigFiles],
        additionalModelRoots: [...settings.additionalModelRoots],
        baseUrl: settings.baseUrl,
      },
      processResult,
      driveRoots: driveResult.roots,
      probeRuntime: probe ? probeRuntimeBaseUrl : null,
      ...(signal ? { signal } : {}),
    })

    result.auto_detect = true
    result.diagnostics = [
      ...processResult.diagnostics,
      ...driveResult.diagnostics,
      ...result.diagnostics,
    ]
    discoveryCache = result
    return result
  }

  /**
   * 收集允许扫描的根。只来自四类来源：installRoot/models、installRoot 下的
   * 默认 extra_model_paths.yaml、用户显式指定的 YAML、用户显式指定的额外根。
   */
  async function collectModelRoots({ signal = null } = {}) {
    const diagnostics = []
    const roots = deriveScanRoots(settings)
    const yamlFiles = []

    if (settings.installRoot) {
      yamlFiles.push({ path: joinLikePython(settings.installRoot, 'extra_model_paths.yaml'), required: false })
    }
    for (const file of settings.extraModelPathsConfigFiles) {
      yamlFiles.push({ path: file, required: true })
    }

    const YAML = await loadYaml()
    for (const item of yamlFiles) {
      try {
        const loaded = await readYamlFile(item.path, { signal, required: item.required })
        if (!loaded) continue
        const yamlDir = loaded.filePath.replace(/[\\/][^\\/]+$/, '')
        const parsed = parseModelPathsYaml(loaded.text, {
          yamlFile: loaded.filePath,
          yamlDir,
          env: envVars,
          homedir: null,
          windows: true,
          YAML,
        })
        diagnostics.push(...parsed.diagnostics)
        for (const root of parsed.roots) {
          if (root.unresolved) {
            diagnostics.push({
              error_code: COMFY_CODES.PATH_UNRESOLVED,
              field_path: `${loaded.filePath}#${root.category_raw}`,
              message: `${root.category_raw} 的路径无法解析（${root.unresolved}）：${root.path_raw}`,
              suggested_fix: '把环境变量换成字面路径，或在启动插件的环境里提供该变量。',
            })
            continue
          }
          roots.push({ ...root, priority: root.is_default ? 1 : 0 })
        }
      } catch (error) {
        diagnostics.push({
          error_code: error?.code ?? COMFY_CODES.VALIDATION_FAILED,
          field_path: item.path,
          message: `读取 ${item.path} 失败：${error?.message ?? error}`,
          suggested_fix: error?.suggested_fix ?? '检查该 YAML 是否可读、格式是否正确。',
        })
      }
    }

    // 自动发现出来的模型根：只有开了 autoDetect 才参与，且不探测网络，
    // 保证离线扫描不依赖 ComfyUI 是否在运行。
    if (settings.autoDetect) {
      try {
        const found = await discover({ probe: false, signal })
        for (const candidate of found.candidates) {
          for (const root of candidate.model_roots) {
            if (!root.path) continue
            const key = String(root.path).toLowerCase()
            if (roots.some((item) => String(item.path).toLowerCase() === key)) continue
            roots.push({
              path: root.path,
              category: root.category ?? null,
              category_raw: root.category_raw ?? null,
              is_default: root.is_default === true,
              yaml_file: root.yaml_file ?? null,
              unresolved: null,
              source: 'discovery',
              priority: root.is_default ? 1 : 0,
            })
          }
        }
        for (const item of found.diagnostics ?? []) {
          if (item?.error_code) diagnostics.push(item)
        }
      } catch (error) {
        diagnostics.push({
          error_code: error?.code ?? COMFY_CODES.CAPABILITY_UNAVAILABLE,
          field_path: 'comfyui.autoDetect',
          message: `自动发现失败：${error?.message ?? error}`,
          suggested_fix: error?.suggested_fix ?? '手动填写 comfyui.installRoot 或 additionalModelRoots。',
        })
      }
    }

    return { roots, diagnostics }
  }

  async function scanModels({ signal = null, refresh = false } = {}) {
    ensureEnabled('扫描模型目录')
    if (!refresh) {
      const cached = catalogCache.get()
      if (cached) return cached
    }
    const { roots, diagnostics } = await collectModelRoots({ signal })
    const scanned = await scanModelRoots(getFs(), roots, { signal })
    const result = {
      entries: scanned.entries,
      categories: scanned.categories,
      diagnostics: [...diagnostics, ...scanned.diagnostics],
      partial: scanned.partial,
      cancelled: scanned.cancelled,
      roots: roots.map((root) => ({
        path: root.path,
        source: root.source ?? 'yaml',
        category: root.category ?? null,
      })),
    }
    if (!scanned.partial && !scanned.cancelled) catalogCache.set(result)
    return result
  }

  /**
   * 实际要连的地址，按可信度从高到低取：
   * 1. 已经用一次真实 HTTP 调用验证过的地址；
   * 2. 自动发现选出的唯一候选报的端口（多候选时 selected 为 null，不会乱选）；
   * 3. 配置里的 baseUrl。
   * 三者都必须是 loopback，最终由 client 的 assertLoopbackUrl 兜底。
   */
  function effectiveBaseUrl() {
    if (verifiedBaseUrl) return verifiedBaseUrl
    const selected = discoveryCache?.selected
    if (settings.autoDetect && selected?.runtime_base_url) return selected.runtime_base_url
    return settings.baseUrl
  }

  function baseUrlSource() {
    if (verifiedBaseUrl) return 'verified'
    const selected = discoveryCache?.selected
    if (settings.autoDetect && selected?.runtime_base_url) return 'discovery_candidate'
    return 'config'
  }

  function getClient() {
    ensureEnabled('访问 ComfyUI')
    const baseUrl = effectiveBaseUrl()
    if (!client || client.baseUrl !== baseUrl) {
      client = createComfyClient({
        baseUrl,
        timeoutMs: settings.requestTimeoutMs,
        ...(fetchImpl ? { fetchImpl } : {}),
        ...(env ? { env } : {}),
      })
    }
    return client
  }

  // 页面的 CSP 是 default-src 'self'：浏览器拿不到跨源的 http://127.0.0.1:8188/view。
  // 生成图又不在会话事件里，宿主的附件授权也不会放行，所以从页面自己的源转发一次。
  const IMAGE_ROUTE_PATH = '/comfyui/image'
  let imageRouteDispose = null
  let imageRouteFailure = null

  async function serveProxiedImage(req, res) {
    const fail = (status, text) => {
      res.statusCode = status
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end(text)
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, '只支持 GET。')
    let url = null
    try {
      url = new URL(req.url ?? '', 'http://127.0.0.1')
    } catch {
      return fail(400, '请求地址无法解析。')
    }
    const image = {
      filename: url.searchParams.get('filename') ?? '',
      subfolder: url.searchParams.get('subfolder') ?? '',
      type: url.searchParams.get('type') ?? 'output',
    }
    // 转发的是 ComfyUI 的输出引用，不是任意路径：文件名、子目录、类型都按 /view 的规矩验。
    if (!isSafeOutputRef(image)) return fail(400, '输出引用不合法。')
    let fetched = null
    try {
      fetched = await getClient().fetchImage(image)
    } catch {
      return fail(502, '取不到这张图。')
    }
    res.statusCode = 200
    res.setHeader('content-type', fetched.mediaType)
    res.setHeader('content-length', String(fetched.bytes.length))
    res.setHeader('cache-control', 'private, max-age=300')
    res.end(req.method === 'HEAD' ? undefined : fetched.bytes)
  }

  /** 宿主没有 webServer（或路径已被占用）时返回 false，调用方退回直接地址。 */
  function ensureImageRoute() {
    if (imageRouteDispose) return true
    if (imageRouteFailure) return false
    if (!ctx || typeof ctx.get !== 'function') {
      imageRouteFailure = '没有可用的宿主上下文。'
      return false
    }
    let webServer = null
    try {
      webServer = ctx.get('webServer') ?? null
    } catch {
      webServer = null
    }
    if (!webServer || typeof webServer.register !== 'function') {
      imageRouteFailure = '宿主没有提供 webServer 服务。'
      return false
    }
    try {
      imageRouteDispose = webServer.register({
        kind: 'prefix',
        path: IMAGE_ROUTE_PATH,
        handler: serveProxiedImage,
      })
    } catch (error) {
      imageRouteFailure = error instanceof Error ? error.message : String(error)
      return false
    }
    return true
  }

  /** 浏览器卡片用的同源地址；路由注册不上就返回 null，由调用方退回 ComfyUI 原始地址。 */
  function imageProxyUrl(image) {
    if (!isSafeOutputRef(image)) return null
    if (!ensureImageRoute()) return null
    const query = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder ?? '',
      type: image.type ?? 'output',
    })
    return `${IMAGE_ROUTE_PATH}?${query.toString()}`
  }

  function getSubprocess() {
    if (subprocess) return subprocess
    if (!ctx || typeof ctx.get !== 'function') return null
    try {
      return ctx.get('subprocess') ?? null
    } catch {
      return null
    }
  }

  /** 启动类动作要有安装目录：显式配置优先，其次是唯一的自动发现候选。 */
  async function resolveLaunchRoot({ signal = null } = {}) {
    if (settings.installRoot) return settings.installRoot
    const found = await discover({ probe: false, signal })
    const root = found?.selected?.installation_root ?? null
    if (!root) {
      throw new ComfyError(
        COMFY_CODES.PATH_MISSING,
        found?.candidates?.length > 1
          ? `发现了 ${found.candidates.length} 个 ComfyUI 候选，无法确定要启动哪一个。`
          : '没有确定 ComfyUI 安装目录：comfyui.installRoot 没填，自动发现也没有唯一候选。',
        '把 comfyui.installRoot 指向含 main.py 的那一层，再重试。',
      )
    }
    return root
  }

  /** 端口只从已经过回环校验的地址里取，不接受调用方指定。 */
  function portOf(baseUrl) {
    const parsed = new URL(baseUrl)
    return Number(parsed.port || 80)
  }

  /**
   * 已知的 ComfyUI 安装目录。只认"已经确定过的"：
   * 配置里写死的，或者之前一次发现/连接已经确认过的。
   * 这里绝不为了列工作流去扫盘——列个工作流名称不值得把整块盘走一遍。
   */
  function knownInstallRoot() {
    return settings.installRoot ?? discoveryCache?.selected?.installation_root ?? null
  }

  function workflowRootsOf() {
    return workflowRoots({
      installRoot: knownInstallRoot(),
      workflowDirs: settings.workflowDirs,
    })
  }

  /** 文件名只允许是名字：带分隔符就能跳出工作流目录。 */
  function normalizeWorkflowFileName(raw) {
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (value === '') {
      throw new ComfyError(COMFY_CODES.VALIDATION_FAILED, '保存工作流需要 name。')
    }
    if (/[\\/:*?"<>|\u0000-\u001f]/u.test(value) || value === '.' || value === '..') {
      throw new ComfyError(
        COMFY_CODES.VALIDATION_FAILED,
        `文件名只能是名字本身，不能含路径分隔符或特殊字符：${value}`,
        '例如 "my_flux_workflow"，不要写目录。目录用 directory 参数指定。',
      )
    }
    return /\.json$/iu.test(value) ? value : `${value}.json`
  }

  function samePath(a, b) {
    const left = String(a ?? '').replace(/[\\/]+$/u, '').replace(/\\/gu, '/').toLowerCase()
    const right = String(b ?? '').replace(/[\\/]+$/u, '').replace(/\\/gu, '/').toLowerCase()
    return left !== '' && left === right
  }

  /**
   * 按名称找本地工作流。
   * 返回的是文件元数据，不是文件内容；读文件是下一步的事，
   * 因为"找到了"和"读得出来"是两种失败，混在一起就说不清了。
   */
  async function listLocalWorkflows({ signal = null, query = null, limit = null } = {}) {
    const roots = workflowRootsOf()
    const listing = await listWorkflows(getFs(), roots, { signal })
    let items = listing.items
    let matchLevel = null
    if (typeof query === 'string' && query.trim() !== '') {
      const matched = matchWorkflows(items, query)
      items = matched.matches
      matchLevel = matched.level
    }
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
      items = items.slice(0, limit)
    }
    return {
      items,
      roots: listing.roots,
      diagnostics: listing.diagnostics,
      partial: listing.partial,
      skipped: listing.skipped,
      total: listing.items.length,
      install_root: knownInstallRoot(),
      match_level: matchLevel,
    }
  }

  async function resolveLocalWorkflow(name, { signal = null } = {}) {
    return resolveWorkflowByName(getFs(), workflowRootsOf(), name, { signal })
  }

  /**
   * 只问当前这次操作真正用得上的节点定义。
   * 命中缓存就不发请求；未知节点也缓存，免得同一个不存在的节点反复问。
   */
  async function getNodeInfos(classTypes, { signal = null, refresh = false } = {}) {
    return fetchNodeInfos({
      client: getClient(),
      cache: objectInfoCache,
      classTypes,
      signal,
      refresh,
    })
  }

  /**
   * 另存为新文件。三条硬规矩：只写在已配置的工作流根里、只新建不覆盖、
   * 文件名不许带路径分隔符——不然用户传个 ../.. 就能写到根外面去。
   */
  async function saveLocalWorkflow({ workflow, name, directory = null, signal = null } = {}) {
    const fsAdapter = getFs()
    if (!fsAdapter.writable) {
      throw new ComfyError(COMFY_CODES.CAPABILITY_UNAVAILABLE, '当前 profile 的 fs 服务不支持写入，无法保存工作流。')
    }
    const fileName = normalizeWorkflowFileName(name)
    const prompt = requireApiPrompt(workflow)

    const roots = workflowRootsOf()
    let chosen = null
    if (typeof directory === 'string' && directory.trim() !== '') {
      const wanted = directory.trim()
      const hit = roots.find((root) => samePath(root.path, wanted))
      if (!hit) {
        throw new ComfyError(
          COMFY_CODES.PATH_DENIED,
          `只能保存到已配置的工作流目录，${wanted} 不在其中。`,
          '先在 comfyui.workflowDirs 里登记这个目录，或省略 directory 用默认目录。',
        )
      }
      chosen = hit
    } else {
      for (const root of roots) {
        const target = await fsAdapter.resolve(root.path, { signal }).catch(() => null)
        if (!target) continue
        const info = await fsAdapter.stat(target, { signal }).catch(() => null)
        if (info?.type === 'directory') {
          chosen = root
          break
        }
      }
      if (!chosen) {
        throw new ComfyError(
          COMFY_CODES.PATH_MISSING,
          '没有可用的工作流目录：默认目录不存在，配置里也没有能写的 workflowDirs。',
          '先在 ComfyUI 里保存过一次工作流，或把目录登记到 comfyui.workflowDirs。',
        )
      }
    }

    const dirTarget = await fsAdapter.resolve(chosen.path, { signal })
    const filePath = `${chosen.path.replace(/[\\/]+$/u, '')}${chosen.path.includes('\\') && !chosen.path.includes('/') ? '\\' : '/'}${fileName}`
    const fileTarget = await fsAdapter.resolve(filePath, { signal })
    if (!fsAdapter.contains(dirTarget, fileTarget)) {
      throw new ComfyError(COMFY_CODES.PATH_DENIED, `解析后的目标不在工作流目录里：${filePath}`)
    }
    const body = `${JSON.stringify(prompt, null, 2)}\n`
    await fsAdapter.writeTextNew(fileTarget, body, { signal })
    return {
      saved: true,
      name: fileName,
      path: filePath,
      directory: chosen.path,
      root_source: chosen.root_source ?? chosen.source ?? null,
      bytes: Buffer.byteLength(body, 'utf8'),
      node_count: Object.keys(prompt).length,
    }
  }

  /** 搭一份基础 API 工作流，并拿真实节点定义逐项校验。 */
  async function buildLocalWorkflow(input = {}, { signal = null, refresh = false } = {}) {
    const built = buildApiWorkflow(input)
    const classes = classesInPrompt(built.prompt)
    const infos = await getNodeInfos(classes, { signal, refresh })
    const validation = validateBuiltWorkflow({
      prompt: built.prompt,
      // byClass 是 Map，validateBuiltWorkflow 按对象取键；不转一次会一个都查不到，
      // 结果每个节点都被判成"拿不到节点定义"，而 missing 又是空的，很难看出问题。
      objectInfoByClass: Object.fromEntries(infos.byClass),
      requireObjectInfo: true,
    })
    return { ...built, classes, validation, missing: infos.missing, failures: infos.failures }
  }

  return {
    get enabled() {
      return settings.enabled && phase !== 'disposed'
    },
    settings,
    get phase() {
      return phase
    },
    get fsAdapter() {
      return getFs()
    },
    get runs() {
      return runRegistry
    },

    /** 幂等：重复调用只推进一次状态，且不产生任何副作用。 */
    async initialize() {
      ensureLive('initialize')
      if (phase === 'ready') return this.describe()
      initializeCount += 1
      readyAt = Date.now()
      phase = 'ready'
      logger?.debug?.(`ComfyUI 运行时已就绪（enabled=${settings.enabled}，第 ${initializeCount} 次初始化）。`)
      return this.describe()
    },

    collectModelRoots,
    ensureEnabled,
    discover,
    scanModels,
    getClient,
    getNodeInfos,
    get objectInfoCache() {
      return objectInfoCache
    },
    listLocalWorkflows,
    resolveLocalWorkflow,
    buildLocalWorkflow,
    saveLocalWorkflow,
    inspectWorkflow,
    planWorkflowPatch,
    applyWorkflowPatch,
    stableFingerprint,
    reconcileModels,

    async status({ signal = null } = {}) {
      ensureEnabled('检查连接状态')
      const activeClient = getClient()
      const baseUrl = activeClient.baseUrl
      try {
        const stats = await activeClient.getSystemStats({ signal })
        // 这一步是唯一能把"配置里写了这个地址"升级成"这个地址上真有 ComfyUI"的地方。
        verifiedBaseUrl = baseUrl
        // 探测到的那个安装如果正是这个地址在跑，就把地址记回候选里；
        // 候选本来只描述磁盘，没验证过就写地址等于替用户猜端口。
        if (discoveryCache?.selected && !discoveryCache.selected.runtime_base_url) {
          discoveryCache.selected.runtime_base_url = baseUrl
          discoveryCache.selected.runtime_reachable = true
        }
        return {
          base_url: baseUrl,
          base_url_source: 'verified',
          configured_base_url: settings.baseUrl,
          system: stats.system ?? null,
          devices: Array.isArray(stats.devices) ? stats.devices : [],
        }
      } catch (error) {
        if (verifiedBaseUrl === baseUrl) verifiedBaseUrl = null
        if (discoveryCache?.selected?.runtime_base_url === baseUrl) {
          discoveryCache.selected.runtime_base_url = null
          discoveryCache.selected.runtime_reachable = false
        }
        throw error
      }
    },

    async submit({ prompt, signal = null }) {
      ensureEnabled('提交工作流')
      const run = await submitPrompt({ client: getClient(), prompt, signal })
      runRegistry.create(run)
      return run
    },

    async queryJob({ runId, promptId = null, signal = null }) {
      ensureEnabled('查询任务')
      const existing = runId ? runRegistry.get(runId) : null
      const run = existing ?? { run_id: promptId, prompt_id: promptId, state: 'accepted' }
      const next = await queryRun({ client: getClient(), run, signal })
      if (runId) runRegistry.update(runId, next)
      return next
    },

    imageViewUrl(image) {
      return imageViewUrl(getClient(), image)
    },

    imageProxyUrl,

    /**
     * 启动或打开本机 ComfyUI。四个动作都是固定枚举，不接受命令字符串。
     * 只有显式调用这个工具才会启动进程：加载、status、扫描都不会。
     */
    async start({ action, signal = null } = {}) {
      ensureEnabled('启动或打开 ComfyUI')
      const service = getSubprocess()

      if (action === LAUNCHER_ACTIONS.OPEN_INSTALL_FOLDER) {
        const root = await resolveLaunchRoot({ signal })
        const target = await getFs().resolve(root, { signal })
        const info = await getFs().stat(target, { signal })
        if (!info || info.type !== 'directory') {
          throw new ComfyError(COMFY_CODES.PATH_MISSING, `安装目录 ${root} 现在不是一个可读目录。`)
        }
        const opened = await openWithShell({
          subprocess: service,
          platform: platformName,
          target: root,
          kind: 'folder',
          signal,
        })
        return { action, install_root: root, ...opened }
      }

      if (action === LAUNCHER_ACTIONS.OPEN_LAUNCHER) {
        const root = await resolveLaunchRoot({ signal })
        const found = await findLauncherCandidates(getFs(), root, { platform: platformName, signal })
        if (found.candidates.length === 0) {
          throw new ComfyError(
            COMFY_CODES.CAPABILITY_UNAVAILABLE,
            `在 ${root} 与它的上一级目录里没找到已知的启动器文件。`,
            `找过这些路径：${found.scanned_paths.join('、')}。可以改用 start_backend 直接启动后端。`,
          )
        }
        // 多个启动器就让用户挑：猜错会拉起一个不是他想用的配置。
        if (found.candidates.length > 1) {
          throw new ComfyError(
            COMFY_CODES.BINDING_AMBIGUOUS,
            `找到 ${found.candidates.length} 个可能的启动器：${found.candidates.map((item) => item.path).join('、')}。`,
            '插件不替你挑启动器；只留一个，或用 start_backend 直接启动后端。',
          )
        }
        const launcher = found.candidates[0]
        const opened = await openWithShell({
          subprocess: service,
          platform: platformName,
          target: launcher.path,
          kind: 'file',
          signal,
        })
        return { action, install_root: root, launcher: launcher.path, ...opened }
      }

      if (action === LAUNCHER_ACTIONS.OPEN_WEB_UI) {
        const url = effectiveBaseUrl()
        const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
        // 这个地址最终会交给系统浏览器，所以在这里再确认一次它指向本机。
        if (!LOOPBACK_HOSTS.has(host)) {
          throw new ComfyError(COMFY_CODES.TARGET_NOT_LOCAL, `拒绝打开非本机地址 ${url}。`)
        }
        const opened = await openWithShell({
          subprocess: service,
          platform: platformName,
          target: url,
          kind: 'url',
          signal,
        })
        return { action, base_url: url, ...opened }
      }

      if (action === LAUNCHER_ACTIONS.START_BACKEND) {
        const url = effectiveBaseUrl()
        // 已经有实例在响应就不要起第二个：除了端口冲突，用户可能正用着别人的。
        try {
          await getClient().getSystemStats({ signal })
          return {
            action,
            started: false,
            reason: 'already_running',
            base_url: url,
            message: `${url} 上已经有 ComfyUI 在响应，没有重复启动。`,
          }
        } catch {
          // 连不上才继续启动；这里的失败不是错误，是"该启动了"。
        }
        const root = await resolveLaunchRoot({ signal })
        const started = await startBackend({
          subprocess: service,
          fsAdapter: getFs(),
          installRoot: root,
          port: portOf(url),
          platform: platformName,
          signal,
        })
        backendProcess = started.handle
        lastLaunch = { action, at: Date.now(), install_root: root, base_url: url }
        return {
          action,
          started: true,
          install_root: root,
          python: started.python,
          argv: started.argv,
          cwd: started.cwd,
          port: started.port,
          base_url: url,
          message: '后端已启动。它由本插件托管，插件卸载或 Host 退出时会随之结束。',
        }
      }

      throw new ComfyError(
        COMFY_CODES.VALIDATION_FAILED,
        `不认识的启动动作 ${JSON.stringify(action ?? null)}。`,
        `可选值：${LAUNCHER_ACTION_VALUES.join(' / ')}。`,
      )
    },

    /**
     * 取回输出图并交给 Host 的 attachments 服务落盘。
     * 只用 /view 的参数取字节，绝不把 ComfyUI 报的文件名当本地路径去读。
     *
     * 分两段走：第一段把这一批全部取回并逐张校验，任何一张不合格就整批不保存；
     * 第二段才调 saveImage。这样不会出现"存了前两张，第三张超限"的半批状态。
     */
    async collectImages({ run, limit = 8, signal = null } = {}) {
      const allImages = Array.isArray(run?.images) ? run.images : []
      const images = allImages.slice(0, limit)
      if (images.length === 0) return { attachments: [], images: [], diagnostics: [], partial_saved: false }

      const rejectBatch = (error) => ({
        attachments: [],
        images,
        diagnostics: [error.toDiagnostic({ configFile: 'plugin config', fieldPath: '/comfyui' })],
        partial_saved: false,
      })

      const service = getAttachments()
      if (!service) {
        const client = getClient()
        return {
          attachments: [],
          images: images.map((image) => ({ ...image, url: safeViewUrl(client, image) })),
          diagnostics: [
            new ComfyError(
              COMFY_CODES.OUTPUT_UNAVAILABLE,
              '当前 Host 没有 attachments 服务，取回的图片无法作为附件返回。',
              '只把图片 URL 交给用户，或改用支持附件的运行环境。',
            ).toDiagnostic({ configFile: 'plugin config', fieldPath: '/comfyui' }),
          ],
          partial_saved: false,
        }
      }

      const imageLimits = service.imageLimits ?? null

      // 数量超限整批拒绝：悄悄截断成前几张，用户会以为任务只出了这么多图。
      if (
        typeof imageLimits?.maxImagesPerMessage === 'number' &&
        images.length > imageLimits.maxImagesPerMessage
      ) {
        return rejectBatch(
          new ComfyError(
            COMFY_CODES.OUTPUT_UNAVAILABLE,
            `本次输出 ${images.length} 张，超过 Host 单条消息上限 ${imageLimits.maxImagesPerMessage} 张，整批都没有取回。`,
            '减少 batch 数量，或分批取回。',
          ),
        )
      }

      // 第一段：全部取回并校验。这一阶段不碰 Host 的附件存储。
      const prepared = []
      let totalBytes = 0
      for (const image of images) {
        if (!isSafeOutputRef(image)) {
          return rejectBatch(
            new ComfyError(
              COMFY_CODES.OUTPUT_UNAVAILABLE,
              `输出引用不合法（文件名 ${JSON.stringify(image?.filename ?? null)}，子目录 ${JSON.stringify(image?.subfolder ?? '')}，类型 ${JSON.stringify(image?.type ?? 'output')}），没有取回。`,
              '确认 SaveImage 的输出记录；带路径片段的名字一律不拼进 /view。',
            ),
          )
        }
        let fetched
        try {
          fetched = await getClient().fetchImage(image, { signal })
        } catch (error) {
          const mapped =
            error instanceof ComfyError
              ? error
              : new ComfyError(COMFY_CODES.OUTPUT_UNAVAILABLE, `取图失败：${error?.message ?? error}`)
          return rejectBatch(mapped)
        }
        const byteLength = fetched.bytes?.byteLength ?? 0
        const actual = sniffImage(fetched.bytes)
        const problem = imageLimitProblem({
          image,
          actual,
          declaredMediaType: fetched.mediaType,
          byteLength,
          totalBytes,
          imageLimits,
        })
        if (problem) return rejectBatch(problem)
        prepared.push({ image, bytes: fetched.bytes, actual, byteLength })
        totalBytes += byteLength
      }

      // 第二段：保存。走到这里，每一张都确认过能交给 Host。
      const attachments = []
      const diagnostics = []
      for (const item of prepared) {
        let ref
        try {
          ref = await service.saveImage({
            data: item.bytes,
            mediaType: item.actual.mediaType,
            name: item.image.filename,
          })
        } catch (error) {
          // 图已经生成好了，只是没交到 Host 手里。别把这件事说成生图失败。
          diagnostics.push(
            new ComfyError(
              COMFY_CODES.OUTPUT_UNAVAILABLE,
              `图片已生成，但保存为附件失败：${error?.message ?? error}。已保存的 ${attachments.length} 张保留，其余未保存；Host 的附件服务没有删除接口，回滚不了。`,
              '图片本身没问题；重试一次取图，或只在对话里给出 /view 链接。',
            ).toDiagnostic({ configFile: 'plugin config', fieldPath: '/comfyui' }),
          )
          return { attachments, images, diagnostics, partial_saved: attachments.length > 0 }
        }
        attachments.push({
          attachment_id: ref.attachmentId,
          media_type: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          name: ref.name ?? item.image.filename,
        })
      }
      return { attachments, images, diagnostics, partial_saved: false }
    },

    describe() {
      return {
        phase,
        enabled: settings.enabled,
        auto_detect: settings.autoDetect,
        base_url: settings.baseUrl,
        effective_base_url: effectiveBaseUrl(),
        base_url_source: baseUrlSource(),
        verified_base_url: verifiedBaseUrl,
        install_root: settings.installRoot,
        extra_model_paths_config_files: [...settings.extraModelPathsConfigFiles],
        additional_model_roots: [...settings.additionalModelRoots],
        request_timeout_ms: settings.requestTimeoutMs,
        disabled_reason: settings.disabledReason,
        initialize_count: initializeCount,
        ready_at: readyAt,
        cached_model_count: catalogCache.size,
        discovery: discoveryCache
          ? {
              status: discoveryCache.status,
              candidate_count: discoveryCache.candidates.length,
              selected_installation_root: discoveryCache.selected?.installation_root ?? null,
              selected_models_root: discoveryCache.selected?.models_root ?? null,
              selected_source: discoveryCache.selected?.discovery_source ?? null,
              drive_roots: discoveryCache.drive_roots ?? [],
            }
          : null,
        launch: {
          actions: [...LAUNCHER_ACTION_VALUES],
          // 只统计本插件启动的进程；用户自己开的实例不在这里，也不会被我们结束。
          backend_started: backendProcess !== null,
          last: lastLaunch,
        },
        implemented: Object.freeze({
          model_scan: true,
          model_catalog: true,
          workflow_read: true,
          workflow_patch: true,
          submit: true,
          query: true,
          launch: true,
        }),
      }
    },

    /** 同步、幂等：第二次调用返回 false，不抛错。 */
    dispose() {
      if (phase === 'disposed') return false
      phase = 'disposed'
      readyAt = null
      client = null
      catalogCache.clear()
      runRegistry.clear()
      // 节点定义缓存也是进程内状态，卸载后不该留着。
      objectInfoCache.invalidate()
      discoveryCache = null
      verifiedBaseUrl = null
      // 只结束本插件启动的后端。terminate 对已退出的进程会抛，按"已经不在"处理。
      if (backendProcess) {
        try {
          backendProcess.terminate()
        } catch {
          // 进程早就退出了，没什么要做的。
        }
        backendProcess = null
      }
      lastLaunch = null
      // 路由是本插件挂上去的，卸载时要还回去，否则下一次加载会因为路径重复注册而失败。
      if (imageRouteDispose) {
        try {
          imageRouteDispose()
        } catch {
          // 宿主已经拆掉了，没有要做的。
        }
        imageRouteDispose = null
      }
      imageRouteFailure = null
      return true
    },
  }
}
