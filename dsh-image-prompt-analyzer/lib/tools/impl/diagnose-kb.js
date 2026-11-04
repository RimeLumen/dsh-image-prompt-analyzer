
import { SEVERITY, TASK_STATUS, diagnostic, envelope } from '../../diagnostics.js'
import { KB_DB_CODES } from '../../kb/index.js'
import { inspectContent } from './diagnose/content.js'
import { inspectSources } from './diagnose/sources.js'
import { inspectStorage } from './diagnose/storage.js'

export async function runDiagnoseKnowledgeBase(runtime, args = {}) {
  const diagnostics = []
  const onlySource = typeof args.source_id === 'string' && args.source_id.trim() ? args.source_id.trim() : null

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
        message: `知识库无法打开：${error?.message ?? error}`,
        suggested_fix: error?.suggested_fix ?? '检查 storage.database_path 与文件权限。',
      }),
    )
    return envelope({
      status: TASK_STATUS.FAILED,
      diagnostics,
      extra: { database: null, content: null, sources: [] },
    })
  }

  const { handle, config, kb } = bundle

  const storage = inspectStorage(handle)
  diagnostics.push(...storage.diagnostics)

  const content = inspectContent({ handle, config })
  diagnostics.push(...content.diagnostics)

  const sources = inspectSources({ config, onlySource })
  diagnostics.push(...sources.diagnostics)

  const hasError = diagnostics.some((item) => item.severity === SEVERITY.ERROR)
  const hasWarning = diagnostics.some((item) => item.severity === SEVERITY.WARNING)

  return envelope({
    status: hasError ? TASK_STATUS.FAILED : hasWarning ? TASK_STATUS.OK_WITH_WARNINGS : TASK_STATUS.OK,
    diagnostics,
    extra: {
      database: storage.database,
      content: content.content,
      sources: sources.sources,
      lookup_mode: kb.mode,
      local_sources: kb.localSourceIds,
      note: '知识库是纯本地的：本工具不联网，也不读取或上传图片。',
    },
  })
}
