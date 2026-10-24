
import { PACKAGE_DIR, resolvePluginDirs } from './paths.js'
import { createLogger } from './log.js'
import { SEVERITY, diagnostic, fromException } from './diagnostics.js'
import { createConfigStore, resolvePluginConfig } from './config/index.js'
import { createPanelStore, createPanelRoutes, PANEL_ROUTE_PREFIX } from './panel.js'
import { createProgressStore } from './panel/progress.js'
import { runAnalyzePipeline, runPreviewProfilePipeline, PLUGIN_VERSION } from './pipeline.js'
import { describeVisionBackend, resolveVisionCandidates, VISION_CODES } from './vision/index.js'
import { lazy } from './runtime/lazy.js'
import { createKnowledgeRuntime } from './runtime/knowledge.js'
import { createInputRuntime } from './runtime/input.js'
import { createVisionRuntime } from './runtime/vision.js'
import { createExperienceRuntime } from './runtime/experience.js'

export function createRuntime({ ctx, config = {}, logger: loggerOverride = null } = {}) {
  const dirs = resolvePluginDirs(config)
  const logger = loggerOverride ?? createLogger({ dir: dirs.logDir, name: 'plugin', level: 'info' })

  const pluginConfigResult = resolvePluginConfig(config)
  const pluginConfig = pluginConfigResult.config
  const configDiagnostics = [...pluginConfigResult.diagnostics]

  if (dirs.errors.length > 0) {
    logger.warn(`以下目录配置越出插件包目录，已拒绝并回退为默认值：${dirs.errors.join(', ')}`)
  }
  const configStoreLazy = lazy(() =>
    createConfigStore({ configDir: dirs.configDir, dataDir: dirs.dataDir, logger }),
  )
  let loadedConfigStore = null

  async function ensureConfigStore() {
    const store = await configStoreLazy.get()
    await store.get()
    loadedConfigStore = store
    return store
  }
  const panelStore = createPanelStore({
    maxRecentTasks: pluginConfig.panel?.max_recent_tasks ?? 20,
    logger,
  })
  const panelRoutes = createPanelRoutes({ store: panelStore, getRuntime: () => runtime, logger })

  const progress = createProgressStore()
  const knowledgeLazy = createKnowledgeRuntime({
    ensureConfigStore,
    configDiagnostics,
    logger,
  })
  const { decoderLazy, tempLazy, preparerLazy } = createInputRuntime({ ctx, pluginConfig, dirs, logger })

  async function readImageBytes(path, { signal, maxBytes = null } = {}) {
    if (typeof path !== 'string' || path.trim() === '') {
      throw new Error(`读图片字节需要绝对路径，收到 ${path === null ? 'null' : typeof path}。`)
    }
    const limit = maxBytes ?? pluginConfig.image.max_bytes
    if (ctx?.fs?.resolve && ctx?.fs?.readBytes) {
      const target = await ctx.fs.resolve(path, { signal })
      const bytes = await ctx.fs.readBytes(target, signal, limit)
      return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    }
    const { readFile } = await import('node:fs/promises')
    return readFile(path)
  }

  const visionLazy = createVisionRuntime({
    ctx,
    pluginConfig,
    readImageBytes,
    logger,
  })

  const { saveExperience } = createExperienceRuntime({ knowledgeLazy, readImageBytes, pluginConfig, logger })
  const runtime = {
    ctx,
    dirs,
    logger,
    pluginConfig,
    configDiagnostics,
    packageDir: PACKAGE_DIR,
    pluginVersion: PLUGIN_VERSION,

    getConfigStore: () => ensureConfigStore(),
    getKnowledgeBase: () => knowledgeLazy.get(),
    getDecoder: () => decoderLazy.get(),
    getTemp: () => tempLazy.get(),
    getPreparer: () => preparerLazy.get(),
    getVisionBackend: () => visionLazy.get(),
    readImageBytes,

    panelStore,
    panelRoutes,
    progress,
    panelRoutePrefix: PANEL_ROUTE_PREFIX,

    peekConfigSnapshot() {
      if (!loadedConfigStore) return null
      const snapshot = loadedConfigStore.snapshot()
      return snapshot ? snapshot.activeConfigs : null
    },

    async describeVision() {
      const backend = await visionLazy.get()
      return describeVisionBackend(backend)
    },

    async listVisionCandidates() {
      const visionConfig = pluginConfig.vision ?? {}
      try {
        const plan = await resolveVisionCandidates(ctx, visionConfig, null)
        return {
          current: {
            provider: plan.target.provider,
            model: plan.target.model,
            resolved_via: plan.target.resolved_via,
          },
          candidates: plan.candidates.map((item) => ({ provider: item.provider, model: item.model })),
          diagnostics: plan.diagnostics ?? [],
        }
      } catch (error) {
        return {
          current: null,
          candidates: [],
          diagnostics: [
            typeof error?.toDiagnostic === 'function'
              ? error.toDiagnostic()
              : fromException(error, { error_code: VISION_CODES.MODEL_CATALOG_UNAVAILABLE }),
          ],
        }
      }
    },

    async runAnalyze(args) {
      return runAnalyzePipeline(runtime, args)
    },

    async runPreviewProfile(args) {
      return runPreviewProfilePipeline(runtime, args)
    },

    saveExperience,

    async collectConfigDiagnostics() {
      const all = [...configDiagnostics]
      try {
        const store = await ensureConfigStore()
        const snapshot = await store.inspect()
        all.push(...(snapshot.diagnostics ?? []))
      } catch (error) {
        all.push(
          diagnostic({
            error_code: error?.code ?? 'CONFIG_STORE_UNAVAILABLE',
            severity: SEVERITY.ERROR,
            message: `无法加载配置仓库：${error?.message ?? error}`,
            suggested_fix: error?.suggested_fix ?? '检查 configs/ 目录是否完整。',
          }),
        )
      }
      return all
    },

    async dispose() {
      const pending = knowledgeLazy.peek()
      knowledgeLazy.reset()
      if (!pending) return
      try {
        const { handle } = await pending
        handle.close()
        logger.info('知识库已关闭。')
      } catch (error) {
        logger.warn(`关闭知识库时出错：${error?.message ?? error}`)
      }
    },
  }

  return runtime
}
