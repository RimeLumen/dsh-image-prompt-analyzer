import { existsSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'

import { PACKAGE_DIR, resolveWithin } from '../paths.js'
import { SEVERITY, diagnostic } from '../diagnostics.js'
import {
  createKnowledgeBase,
  openKnowledgeDatabase,
  readSourceMeta,
  STUDIO_SOURCE_TYPE,
} from '../kb/index.js'
import { lazy } from './lazy.js'

const RUNTIME_CODES = Object.freeze({
  STUDIO_SOURCE_MISSING: 'KB_STUDIO_SOURCE_MISSING',
})

/**
 * 这个源在本地库里有没有可用数据。
 *
 * 有 source_meta 记录、或者表里真有它名下的标签，都算"已经搬进来了"。
 * 判断只看本地库，不看源文件在不在——迁移完就该能脱开源目录活着。
 */
export function hasImportedSnapshot(handle, sourceId) {
  if (!handle || typeof handle.get !== 'function') return false
  try {
    const meta = readSourceMeta(handle, sourceId)
    if (meta && Number(meta.row_count ?? 0) > 0) return true
  } catch {
    // source_meta 表可能还不存在（老库），退回数标签。
  }
  try {
    const row = handle.get('SELECT COUNT(*) AS n FROM tags WHERE source_id = ?', sourceId)
    return Number(row?.n ?? 0) > 0
  } catch {
    return false
  }
}

/**
 * 工作室词库是外部文件：换机器、挪目录、还没导出，都会让路径指空。
 *
 * 但只要数据已经导入过一次，本地快照就是完整可用的——这时候不该再拿"源文件不见了"
 * 去打扰日常使用。只有"还没导入过、路径又指空"才值得提示，因为那才是真的没有中文。
 */
export function studioSourceDiagnostics(kbConfig, { handle = null } = {}) {
  const sources = Array.isArray(kbConfig?.sources) ? kbConfig.sources : []
  const out = []
  for (const source of sources) {
    if (source?.type !== STUDIO_SOURCE_TYPE) continue
    if (source?.enabled === false) continue
    const sourceId = String(source?.source_id ?? '')
    if (hasImportedSnapshot(handle, sourceId)) continue

    const declared = typeof source?.path === 'string' ? source.path.trim() : ''
    if (declared === '') {
      out.push(
        diagnostic({
          error_code: RUNTIME_CODES.STUDIO_SOURCE_MISSING,
          severity: SEVERITY.WARNING,
          config_file: 'knowledge-base',
          field_path: `/sources/${sourceId}/path`,
          message: `数据源 ${sourceId || '(未命名)'} 是工作室词库，还没有导入过，也没有填 path。本次分析只用模型词表。`,
          suggested_fix: '把 path 指向本机的 tags.sqlite 再导入一次；不打算用就把这条数据源的 enabled 改成 false。',
        }),
      )
      continue
    }
    const absolute = isAbsolute(declared) ? declared : resolveWithin(PACKAGE_DIR, declared)
    if (absolute === null || !existsSync(absolute)) {
      out.push(
        diagnostic({
          error_code: RUNTIME_CODES.STUDIO_SOURCE_MISSING,
          severity: SEVERITY.WARNING,
          config_file: 'knowledge-base',
          field_path: `/sources/${sourceId}/path`,
          message: `工作室词库还没有导入过，源文件现在也不在：${declared}。本次分析只用模型词表，标签照常保留。`,
          suggested_fix: '导入一次之后就不再依赖这个文件了；要现在导入，用 scripts/import-tags.mjs 指向该文件。',
        }),
      )
    }
  }
  return out
}

/**
 * 知识库文件位置。
 *
 * 相对路径按**用户数据目录**解析——插件包升级会整包替换，放在包里等于每次升级都丢词库。
 * 绝对路径直接用，用户可以自己指定到别处。
 */
export function resolveDatabasePath(storage, dataDir) {
  const raw = String(storage?.database_path ?? 'knowledge.sqlite3').trim()
  if (raw === '') return null
  if (isAbsolute(raw)) return resolve(raw)
  const abs = resolve(dataDir, raw)
  const rel = abs.slice(resolve(dataDir).length)
  if (rel.startsWith(`${sep}..`) || rel === '..') return null
  return abs
}

export function createKnowledgeRuntime({ ensureConfigStore, configDiagnostics, logger, dataDir }) {
  return lazy(async () => {
    const store = await ensureConfigStore()
    const kbConfig = store.getKnowledgeBaseDocument()
    if (!kbConfig) {
      const error = new Error('没有可用的 knowledge-base 配置，无法打开标签知识库。')
      error.code = 'KNOWLEDGE_BASE_CONFIG_MISSING'
      error.suggested_fix = '确认 configs/knowledge-base.default.json 能通过 validate_configs 校验。'
      throw error
    }

    const dbPath = resolveDatabasePath(kbConfig.storage, dataDir)
    if (dbPath === null) {
      const error = new Error(`知识库路径越出用户数据目录：${kbConfig.storage?.database_path}`)
      error.code = 'CONFIG_PATH_ESCAPES_PLUGIN_DIR'
      error.suggested_fix = '把 storage.database_path 改成数据目录内的相对路径，例如 knowledge.sqlite3。'
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
    configDiagnostics.push(...studioSourceDiagnostics(kbConfig, { handle }))
    return { kb, handle, config: kbConfig }
  })
}
