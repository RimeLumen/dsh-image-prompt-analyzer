
import { SEVERITY, TASK_STATUS, diagnostic, envelope } from '../../diagnostics.js'
import { KB_DB_CODES, REBUILD_CODES, rebuildLocalSource } from '../../kb/index.js'

const DEFAULT_LIMIT = 500

const MAX_LIMIT = 20000

function clampLimit(value) {
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_LIMIT
  return Math.min(value, MAX_LIMIT)
}

export async function runRebuildKnowledgeBase(runtime, args = {}) {
  const diagnostics = []
  const dryRun = args.dry_run === true
  const limit = clampLimit(args.limit)
  const requested = Array.isArray(args.sources)
    ? args.sources.filter((name) => typeof name === 'string' && name.trim() !== '').map((name) => name.trim())
    : null

  let bundle
  try {
    bundle = await runtime.getKnowledgeBase()
  } catch (error) {
    diagnostics.push(
      diagnostic({
        error_code: error?.code ?? KB_DB_CODES.OPEN_FAILED,
        severity: SEVERITY.ERROR,
        config_file: 'knowledge-base',
        field_path: '/storage/database_path',
        message: `知识库无法打开，重建中止：${error?.message ?? error}`,
        suggested_fix: error?.suggested_fix ?? '先用 diagnose_knowledge_base 看存储段，再修 storage.database_path。',
      }),
    )
    return envelope({
      status: TASK_STATUS.FAILED,
      diagnostics,
      extra: defaultExtra({ dryRun, limit }),
    })
  }

  const { handle, config } = bundle
  const enabledSources = (Array.isArray(config.sources) ? config.sources : []).filter((source) => source.enabled !== false)
  const selected = requested === null
    ? enabledSources
    : enabledSources.filter((source) => requested.includes(String(source.source_id)))
  const rebuildable = selected.filter((source) => String(source.type) === 'local_file')

  if (rebuildable.length === 0) {
    diagnostics.push(
      diagnostic({
        error_code: REBUILD_CODES.NO_SOURCE,
        severity: SEVERITY.ERROR,
        config_file: 'knowledge-base',
        field_path: '/sources',
        message: requested === null
          ? '配置里没有启用任何 local_file 数据源，没有可重建的内容。'
          : `指定的数据源 ${requested.join(', ')} 里没有已启用的 local_file 数据源。`,
        suggested_fix: '在 configs/knowledge-base.default.json 的 sources[] 里加一条 type: "local_file"、enabled: true 的本地文件源。',
      }),
    )
    return envelope({
      status: TASK_STATUS.FAILED,
      diagnostics,
      extra: defaultExtra({ dryRun, limit }),
    })
  }

  const reports = []
  const targets = rebuildable.slice(0, limit)
  for (const source of targets) {
    const startedAt = Date.now()
    try {
      const result = await rebuildLocalSource({
        handle,
        sourceConfig: source,
        logger: runtime.logger,
        limit: null,
        dryRun,
        categories: config.categories ?? null,
      })
      diagnostics.push(...result.diagnostics)
      reports.push({
        source_id: String(source.source_id),
        ok: true,
        rows: dryRun ? result.would_import : result.imported,
        skipped: result.skipped,
        removed: result.removed ?? 0,
        duration_ms: Date.now() - startedAt,
        diagnostics: result.diagnostics,
      })
    } catch (error) {
      const item = {
        error_code: error?.code ?? 'KB_REBUILD_FAILED',
        severity: SEVERITY.ERROR,
        config_file: 'knowledge-base',
        field_path: `/sources/${source.source_id}`,
        message: `数据源 ${source.source_id} 重建失败：${error?.message ?? error}`,
        suggested_fix: error?.suggested_fix ?? '检查该数据源的文件是否存在、格式是否与扩展名一致。',
      }
      diagnostics.push(diagnostic(item))
      reports.push({
        source_id: String(source.source_id),
        ok: false,
        rows: 0,
        skipped: 0,
        removed: 0,
        duration_ms: Date.now() - startedAt,
        diagnostics: [item],
      })
    }
  }

  const totals = {
    sources: reports.length,
    succeeded: reports.filter((item) => item.ok).length,
    failed: reports.filter((item) => !item.ok).length,
    rows: reports.reduce((sum, item) => sum + item.rows, 0),
    skipped: reports.reduce((sum, item) => sum + item.skipped, 0),
    removed: reports.reduce((sum, item) => sum + item.removed, 0),
    duration_ms: reports.reduce((sum, item) => sum + item.duration_ms, 0),
  }

  const hasError = diagnostics.some((item) => item.severity === SEVERITY.ERROR)
  const hasWarning = diagnostics.some((item) => item.severity === SEVERITY.WARNING)
  const status = hasError
    ? (totals.succeeded > 0 ? TASK_STATUS.PARTIAL : TASK_STATUS.FAILED)
    : hasWarning
      ? TASK_STATUS.OK_WITH_WARNINGS
      : TASK_STATUS.OK

  return envelope({
    status,
    diagnostics,
    extra: {
      ...defaultExtra({ dryRun, limit }),
      sources: reports,
      totals,
    },
  })
}

function defaultExtra({ dryRun, limit }) {
  return {
    dry_run: dryRun,
    limit,
    sources: [],
    totals: { sources: 0, succeeded: 0, failed: 0, rows: 0, skipped: 0, removed: 0, duration_ms: 0 },
  }
}
