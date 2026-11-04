import { createRuntime } from './lib/runtime.js'
import { registerAllTools } from './lib/tools/index.js'

export const name = '@RimeLumen/dsh-image-prompt-analyzer'

export const inject = [
  'tools',
  'llm',
  'attachments',
  'subprocess',
  'fs',
  'web',
  'timer',
  'systemPrompt',
  'credentials',
]

export function apply(ctx, config = {}) {
  const runtime = createRuntime({ ctx, config })
  const { logger, dirs } = runtime

  logger.info(`插件激活：configDir=${dirs.configDir} dataDir=${dirs.dataDir}`)

  ctx.effect(() => {
    const disposers = registerAllTools(ctx, runtime)
    logger.info(
      `已注册 ${disposers.length} 个工具：analyze_image_prompt / validate_configs / diagnose_knowledge_base / preview_model_profile / manage_experiences`,
    )

    let disposed = false
    const preloadTimer = setTimeout(async () => {
      if (disposed) return
      const started = Date.now()
      const results = await Promise.allSettled([
        runtime.getConfigStore(),
        runtime.getKnowledgeBase(),
        runtime.listVisionCandidates(),
      ])
      if (disposed) return
      const ok = results.filter((r) => r.status === 'fulfilled').length
      logger.info(`后台预加载完成（${ok}/3 就绪，耗时 ${Date.now() - started}ms）`)
    }, 2000)

    return () => {
      disposed = true
      clearTimeout(preloadTimer)
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch (error) {
          logger.warn('卸载工具时出错', error)
        }
      }
      Promise.resolve(runtime.dispose()).catch((error) => {
        logger.warn(`释放运行时资源时出错：${error?.message ?? error}`)
      })
      logger.info('插件卸载：工具已全部注销')
    }
  })

  ctx.inject(['webServer'], (scope) => {
    if (runtime.pluginConfig?.panel?.enabled === false) {
      logger.info('panel.enabled 是 false，只读结果面板不注册（工具不受影响）。')
      return
    }
    const panel = runtime.panelRoutes.register(scope)
    for (const item of panel.diagnostics) {
      logger.warn(`${item.error_code}: ${item.message}`)
    }
    scope.effect(() => () => {
      if (!panel.disposer) return
      try {
        panel.disposer()
      } catch (error) {
        logger.warn('注销结果面板路由时出错', error)
      }
    })
  })
}
