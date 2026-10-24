
import { PACKAGE_DIR, resolveWithin } from '../paths.js'
import { createKnowledgeBase, openKnowledgeDatabase } from '../kb/index.js'
import { lazy } from './lazy.js'

export function createKnowledgeRuntime({ ensureConfigStore, configDiagnostics, logger }) {
  return lazy(async () => {
    const store = await ensureConfigStore()
    const kbConfig = store.getKnowledgeBaseDocument()
    if (!kbConfig) {
      const error = new Error('没有可用的 knowledge-base 配置，无法打开标签知识库。')
      error.code = 'KNOWLEDGE_BASE_CONFIG_MISSING'
      error.suggested_fix = '确认 configs/knowledge-base.default.json 能通过 validate_configs 校验。'
      throw error
    }

    const rawPath = String(kbConfig.storage?.database_path ?? 'data/knowledge.sqlite3')
    const dbPath = resolveWithin(PACKAGE_DIR, rawPath, 'data/knowledge.sqlite3')
    if (dbPath === null) {
      const error = new Error(`知识库路径越出插件目录：${rawPath}`)
      error.code = 'CONFIG_PATH_ESCAPES_PLUGIN_DIR'
      error.suggested_fix = '把 storage.database_path 改成插件目录内的相对路径，例如 data/knowledge.sqlite3。'
      throw error
    }

    const handle = await openKnowledgeDatabase({
      path: dbPath,
      createIfMissing: kbConfig.storage?.create_if_missing !== false,
      logger,
    })

    if (Array.isArray(handle.migrationDiagnostics) && handle.migrationDiagnostics.length > 0) {
      configDiagnostics.push(...handle.migrationDiagnostics)
    }

    const kb = createKnowledgeBase({ handle, config: kbConfig, logger })
    return { kb, handle, config: kbConfig }
  })
}
