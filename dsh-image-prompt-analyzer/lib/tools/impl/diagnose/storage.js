
import { SEVERITY, diagnostic } from '../../../diagnostics.js'
import { KB_DB_CODES, KB_SCHEMA_VERSION, META_KEYS, probeWritable, readMeta } from '../../../kb/index.js'
import { DIAGNOSE_CODES } from './codes.js'

export function inspectStorage(handle) {
  const diagnostics = []
  const writable = probeWritable(handle)
  const storedVersion = readMeta(handle, META_KEYS.SCHEMA_VERSION)
  const createdAt = readMeta(handle, META_KEYS.CREATED_AT)

  const database = {
    path: handle.path,
    readonly: handle.readonly,
    writable: writable.writable,
    writable_reason: writable.reason ?? null,
    schema_version_expected: KB_SCHEMA_VERSION,
    schema_version_stored: storedVersion,
    schema_version_ok: storedVersion === KB_SCHEMA_VERSION,
    created_at: createdAt,
  }

  if (!writable.writable) {
    diagnostics.push(
      diagnostic({
        error_code: DIAGNOSE_CODES.DATABASE_NOT_WRITABLE,
        severity: SEVERITY.WARNING,
        config_file: 'knowledge-base',
        field_path: '/storage/database_path',
        message: `知识库不可写：${writable.reason ?? '原因未知'}`,
        suggested_fix: 'rebuild_knowledge_base 会失败，查询仍可用。检查文件权限或 storage.database_path。',
      }),
    )
  }

  if (storedVersion !== KB_SCHEMA_VERSION) {
    diagnostics.push(
      diagnostic({
        error_code: KB_DB_CODES.SCHEMA_VERSION_MISMATCH,
        severity: SEVERITY.ERROR,
        config_file: 'knowledge-base',
        field_path: '/storage/database_path',
        message: `数据库表结构版本是 ${storedVersion ?? '(未登记)'}，本插件需要 ${KB_SCHEMA_VERSION}。`,
        suggested_fix: '备份数据库文件后删掉重建，再运行 rebuild_knowledge_base 重新导入；插件只自动迁移 1.0 → 2.0。',
      }),
    )
  }

  return { database, diagnostics }
}
