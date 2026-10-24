
import { SEVERITY, diagnostic } from '../../../diagnostics.js'
import { KB_DB_CODES, knowledgeStats, lastSyncFor } from '../../../kb/index.js'
import { DIAGNOSE_CODES } from './codes.js'

function latestImport(handle, config) {
  let newest = null
  for (const source of config.sources ?? []) {
    if (source.enabled === false) continue
    const log = lastSyncFor(handle, source.source_id)
    if (log === null) continue
    if (newest === null || String(log.finished_at ?? log.started_at) > String(newest.finished_at ?? newest.started_at)) {
      newest = log
    }
  }
  return newest
}

export function inspectContent({ handle, config }) {
  const diagnostics = []
  let content = null

  try {
    const stats = knowledgeStats(handle)
    const imported = latestImport(handle, config)
    content = {
      ...stats,
      last_import:
        imported === null
          ? null
          : {
              source_id: imported.source_id,
              status: imported.status,
              records: imported.records,
              finished_at: imported.finished_at,
            },
    }

    if (stats.tags === 0) {
      diagnostics.push(
        diagnostic({
          error_code: DIAGNOSE_CODES.EMPTY,
          severity: SEVERITY.WARNING,
          message: '本地标签库是空的，编译时没有别名归一与分类补全可用。',
          suggested_fix: '检查 configs/knowledge-base.default.json 里 sources[].path 指向的文件，然后运行 rebuild_knowledge_base（或 scripts/import-tags.mjs）。',
        }),
      )
    }

    const knownCategories = new Set((config.categories ?? []).map((entry) => String(entry.category_id)))
    const strayCategories = stats.by_category
      .map((row) => row.category)
      .filter((category) => !knownCategories.has(category))
    if (strayCategories.length > 0) {
      diagnostics.push(
        diagnostic({
          error_code: DIAGNOSE_CODES.STRAY_CATEGORY,
          severity: SEVERITY.WARNING,
          field_path: '/categories',
          message: `索引里出现了配置未声明的内部分类：${strayCategories.join(', ')}。`,
          suggested_fix: '这些标签在编译时可能落不到正确的排序位置；在 categories[] 里补上，或重建索引。',
        }),
      )
    }
  } catch (error) {
    diagnostics.push(
      diagnostic({
        error_code: KB_DB_CODES.QUERY_FAILED,
        severity: SEVERITY.ERROR,
        message: `读取知识库统计失败：${error?.message ?? error}`,
        suggested_fix: '表结构可能不完整；尝试重建数据库文件。',
      }),
    )
  }

  return { content, diagnostics }
}
