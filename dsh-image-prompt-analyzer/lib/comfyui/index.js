
import { diagnostic, SEVERITY } from '../diagnostics.js'
import { COMFY_CODES, ComfyError, SUGGESTED_FIX } from './errors.js'
import { createFsAdapter } from './fs-adapter.js'
import { deriveScanRoots, joinLikePython, parseModelPathsYaml } from './paths.js'
import { createCatalogCache, scanModelRoots } from './catalog.js'
import { createComfyClient } from './client.js'
import { reconcileModels } from './reconcile.js'
import { inspectWorkflow } from './workflow.js'
import { applyWorkflowPatch, planWorkflowPatch, stableFingerprint } from './patch.js'
import { createRunRegistry, imageViewUrl, queryRun, submitPrompt } from './runs.js'

export { COMFY_CODES, ComfyError, SUGGESTED_FIX }
export { createFsAdapter } from './fs-adapter.js'
export { parseModelPathsYaml, deriveScanRoots, joinLikePython } from './paths.js'
export { scanModelRoots, createCatalogCache } from './catalog.js'
export { createComfyClient } from './client.js'
export { reconcileModels, filterByStates, MODEL_STATES } from './reconcile.js'
export { inspectWorkflow, detectWorkflowFormat, inspectApiPrompt } from './workflow.js'
export { planWorkflowPatch, applyWorkflowPatch, diffPatch } from './patch.js'
export { submitPrompt, queryRun, RUN_STATES, isValidPromptId, createRunRegistry, imageViewUrl } from './runs.js'

export const DEFAULT_COMFY_BASE_URL = 'http://127.0.0.1:8188'
export const DEFAULT_COMFY_TIMEOUT_MS = 30000
export const COMFY_TIMEOUT_RANGE = Object.freeze({ min: 1000, max: 600000 })

const KNOWN_KEYS = Object.freeze([
  'enabled',
  'baseUrl',
  'installRoot',
  'extraModelPathsConfigFiles',
  'additionalModelRoots',
  'requestTimeoutMs',
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
    enabled: false,
    baseUrl: DEFAULT_COMFY_BASE_URL,
    installRoot: null,
    extraModelPathsConfigFiles: [],
    additionalModelRoots: [],
    requestTimeoutMs: DEFAULT_COMFY_TIMEOUT_MS,
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
 * ComfyUI 运行时骨架。
 *
 * 这个工厂是纯的：不读文件、不发请求、不注册监听器、不排定时器。
 * initialize() 只是把状态从 idle 推到 ready，真正的扫描与通信属于后续版本。
 */
export function createComfyRuntime({ ctx = null, pluginConfig = {}, logger = null, fetchImpl = null } = {}) {
  const settings = Object.freeze({
    enabled: Boolean(pluginConfig?.comfyui?.enabled) && !pluginConfig?.comfyui?.disabled_reason,
    baseUrl: pluginConfig?.comfyui?.baseUrl ?? DEFAULT_COMFY_BASE_URL,
    installRoot: pluginConfig?.comfyui?.installRoot ?? null,
    extraModelPathsConfigFiles: Object.freeze([
      ...(pluginConfig?.comfyui?.extraModelPathsConfigFiles ?? []),
    ]),
    additionalModelRoots: Object.freeze([...(pluginConfig?.comfyui?.additionalModelRoots ?? [])]),
    requestTimeoutMs: pluginConfig?.comfyui?.requestTimeoutMs ?? DEFAULT_COMFY_TIMEOUT_MS,
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
  function ensureEnabled(action) {
    ensureLive(action)
    if (!settings.enabled) {
      throw new ComfyError(
        COMFY_CODES.CAPABILITY_UNAVAILABLE,
        `ComfyUI 集成未启用，${action} 未执行。`,
        settings.disabledReason
          ? `comfyui.baseUrl 配置被拒绝（${settings.disabledReason}），先修正配置再启用。`
          : '在插件配置里把 comfyui.enabled 设为 true，并填好 installRoot 或 baseUrl。',
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
          env: typeof process !== 'undefined' ? process.env : {},
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

  function getClient() {
    ensureEnabled('访问 ComfyUI')
    if (!client) {
      client = createComfyClient({
        baseUrl: settings.baseUrl,
        timeoutMs: settings.requestTimeoutMs,
        ...(fetchImpl ? { fetchImpl } : {}),
      })
    }
    return client
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
    scanModels,
    getClient,
    inspectWorkflow,
    planWorkflowPatch,
    applyWorkflowPatch,
    stableFingerprint,
    reconcileModels,

    async status({ signal = null } = {}) {
      ensureEnabled('检查连接状态')
      const stats = await getClient().getSystemStats({ signal })
      return {
        base_url: settings.baseUrl,
        system: stats.system ?? null,
        devices: Array.isArray(stats.devices) ? stats.devices : [],
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

    /**
     * 取回输出图并交给 Host 的 attachments 服务落盘。
     * 只用 /view 的参数取字节，绝不把 ComfyUI 报的文件名当本地路径去读。
     */
    async collectImages({ run, limit = 8, signal = null } = {}) {
      const images = Array.isArray(run?.images) ? run.images.slice(0, limit) : []
      if (images.length === 0) return { attachments: [], images: [], diagnostics: [] }
      const service = getAttachments()
      if (!service) {
        return {
          attachments: [],
          images: images.map((image) => ({ ...image, url: imageViewUrl(getClient(), image) })),
          diagnostics: [
            new ComfyError(
              COMFY_CODES.OUTPUT_UNAVAILABLE,
              '当前 Host 没有 attachments 服务，取回的图片无法作为附件返回。',
              '只把图片 URL 交给用户，或改用支持附件的运行环境。',
            ).toDiagnostic({ configFile: 'plugin config', fieldPath: '/comfyui' }),
          ],
        }
      }
      const attachments = []
      const diagnostics = []
      for (const image of images) {
        try {
          const fetched = await getClient().fetchImage(image, { signal })
          const ref = await service.saveImage({
            data: fetched.bytes,
            mediaType: fetched.mediaType,
            name: image.filename,
          })
          attachments.push({
            attachment_id: ref.attachmentId,
            media_type: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            name: ref.name ?? image.filename,
          })
        } catch (error) {
          const mapped =
            error instanceof ComfyError
              ? error
              : new ComfyError(COMFY_CODES.OUTPUT_UNAVAILABLE, `取图失败：${error?.message ?? error}`)
          diagnostics.push(mapped.toDiagnostic({ configFile: 'plugin config', fieldPath: '/comfyui' }))
        }
      }
      return { attachments, images, diagnostics }
    },

    describe() {
      return {
        phase,
        enabled: settings.enabled,
        base_url: settings.baseUrl,
        install_root: settings.installRoot,
        extra_model_paths_config_files: [...settings.extraModelPathsConfigFiles],
        additional_model_roots: [...settings.additionalModelRoots],
        request_timeout_ms: settings.requestTimeoutMs,
        disabled_reason: settings.disabledReason,
        initialize_count: initializeCount,
        ready_at: readyAt,
        cached_model_count: catalogCache.size,
        implemented: Object.freeze({
          model_scan: true,
          model_catalog: true,
          workflow_read: true,
          workflow_patch: true,
          submit: true,
          query: true,
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
      return true
    },
  }
}
