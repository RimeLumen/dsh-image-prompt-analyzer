
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { SEVERITY, diagnostic } from '../diagnostics.js'
import { MIGRATE_CODES } from '../config/migrate.js'
import { NULL_LOGGER } from '../log.js'
import { KB_DDL, KB_MIGRATION_1_TO_2, KB_POST_MIGRATION_INDEXES, KB_SCHEMA_VERSION, META_KEYS } from './schema.js'

export const KB_DB_CODES = Object.freeze({
  SQLITE_UNAVAILABLE: 'KB_SQLITE_UNAVAILABLE',
  OPEN_FAILED: 'KB_OPEN_FAILED',
  DIR_UNWRITABLE: 'KB_DIR_UNWRITABLE',
  SCHEMA_VERSION_MISMATCH: 'KB_SCHEMA_VERSION_MISMATCH',
  SCHEMA_APPLY_FAILED: 'KB_SCHEMA_APPLY_FAILED',
  QUERY_FAILED: 'KB_QUERY_FAILED',
})

export class KnowledgeBaseError extends Error {
  constructor(code, message, { detail = null, suggestedFix = null, configFile = null, fieldPath = null } = {}) {
    super(message)
    this.name = 'KnowledgeBaseError'
    this.code = code
    this.detail = detail
    this.suggested_fix = suggestedFix
    this.config_file = configFile
    this.field_path = fieldPath
  }

  toDiagnostic({ configFile = null, fieldPath = null } = {}) {
    return diagnostic({
      error_code: this.code,
      severity: SEVERITY.ERROR,
      config_file: configFile ?? this.config_file,
      field_path: fieldPath ?? this.field_path,
      message: this.detail ? `${this.message}（${this.detail}）` : this.message,
      suggested_fix: this.suggested_fix,
    })
  }
}

let sqliteModulePromise = null

async function loadSqlite() {
  if (!sqliteModulePromise) {
    sqliteModulePromise = import('node:sqlite').catch((error) => {
      sqliteModulePromise = null
      throw new KnowledgeBaseError(
        KB_DB_CODES.SQLITE_UNAVAILABLE,
        `本机的 Node 没有提供 node:sqlite：${error?.message ?? error}`,
        { suggestedFix: '升级到带 node:sqlite 的 Node（本插件开发于 Node 24），或改用其它存储方案。' },
      )
    })
  }
  return sqliteModulePromise
}

function createHandle(raw, { path, readonly, logger = null }) {
  const statements = new Map()
  let transactionDepth = 0

  function prepare(sql) {
    let statement = statements.get(sql)
    if (!statement) {
      statement = raw.prepare(sql)
      statements.set(sql, statement)
    }
    return statement
  }

  const handle = {
    path,
    readonly,
    raw,

    run(sql, ...params) {
      return prepare(sql).run(...params)
    },
    get(sql, ...params) {
      return prepare(sql).get(...params)
    },
    all(sql, ...params) {
      return prepare(sql).all(...params)
    },
    iterate(sql, ...params) {
      return prepare(sql).iterate(...params)
    },
    exec(sql) {
      return raw.exec(sql)
    },

    transaction(fn) {
      if (transactionDepth > 0) return fn(handle)
      raw.exec('BEGIN')
      transactionDepth += 1
      try {
        const result = fn(handle)
        raw.exec('COMMIT')
        return result
      } catch (error) {
        try {
          raw.exec('ROLLBACK')
        } catch (rollbackError) {
          logger?.warn(`回滚失败：${rollbackError?.message ?? rollbackError}`)
        }
        throw error
      } finally {
        transactionDepth -= 1
      }
    },

    close() {
      statements.clear()
      try {
        raw.close()
      } catch (error) {
        logger?.warn(`关闭数据库失败：${error?.message ?? error}`)
      }
    },
  }

  return handle
}

export async function openKnowledgeDatabase({
  path,
  createIfMissing = true,
  readonly = false,
  logger = NULL_LOGGER,
} = {}) {
  if (!path || typeof path !== 'string') {
    throw new KnowledgeBaseError(KB_DB_CODES.OPEN_FAILED, '数据库路径为空。', {
      suggestedFix: '检查 knowledge-base 配置的 storage.database_path。',
    })
  }

  const exists = existsSync(path)
  if (!exists && !createIfMissing && !readonly) {
    throw new KnowledgeBaseError(KB_DB_CODES.OPEN_FAILED, `数据库文件不存在：${path}`, {
      suggestedFix: '把 storage.create_if_missing 设为 true，或先运行 scripts/import-tags.mjs 导入标签。',
    })
  }
  if (!exists && readonly) {
    throw new KnowledgeBaseError(KB_DB_CODES.OPEN_FAILED, `数据库文件不存在：${path}`, {
      suggestedFix: '先运行 scripts/import-tags.mjs（无参数按配置里的本地源全量重建）建库。',
    })
  }

  const dir = dirname(path)
  if (!exists && createIfMissing) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch (error) {
      throw new KnowledgeBaseError(KB_DB_CODES.DIR_UNWRITABLE, `无法创建数据库目录 ${dir}：${error?.message ?? error}`, {
        suggestedFix: '确认插件数据目录可写，或把 storage.database_path 指到可写位置。',
      })
    }
  }

  const { DatabaseSync } = await loadSqlite()

  let raw
  try {
    raw = new DatabaseSync(path, readonly ? { readOnly: true } : {})
  } catch (error) {
    throw new KnowledgeBaseError(KB_DB_CODES.OPEN_FAILED, `打开数据库失败：${error?.message ?? error}`, {
      detail: error?.code ?? null,
      suggestedFix: '确认文件不是被其它进程独占，且确实是 SQLite 文件。',
    })
  }

  const handle = createHandle(raw, { path, readonly, logger })

  if (!readonly) {
    try {
      raw.exec(KB_DDL)
    } catch (error) {
      handle.close()
      throw new KnowledgeBaseError(KB_DB_CODES.SCHEMA_APPLY_FAILED, `建表失败：${error?.message ?? error}`, {
        detail: error?.code ?? null,
        suggestedFix: '删掉损坏的数据库文件重新建库；若是版本升级导致，按知识库迁移流程处理。',
      })
    }
    handle.migrationDiagnostics = ensureSchemaVersion(handle, { logger })
  }

  return handle
}

function ensureSchemaVersion(handle, { logger }) {
  const existing = readMeta(handle, META_KEYS.SCHEMA_VERSION)
  if (existing === null) {
    writeMeta(handle, META_KEYS.SCHEMA_VERSION, KB_SCHEMA_VERSION)
    writeMeta(handle, META_KEYS.CREATED_AT, new Date().toISOString())
    handle.exec(KB_POST_MIGRATION_INDEXES)
    logger.info(`知识库已初始化，表结构版本 ${KB_SCHEMA_VERSION}。`)
    return []
  }
  if (existing === KB_SCHEMA_VERSION) return []
  if (existing === '1.0') {
    try {
      handle.transaction(() => {
        handle.exec(KB_MIGRATION_1_TO_2)
        writeMeta(handle, META_KEYS.SCHEMA_VERSION, KB_SCHEMA_VERSION)
      })
    } catch (error) {
      handle.close()
      throw new KnowledgeBaseError(KB_DB_CODES.SCHEMA_APPLY_FAILED, `知识库结构 1.0 → 2.0 迁移失败：${error?.message ?? error}`, {
        detail: error?.code ?? null,
        suggestedFix: '备份 data/knowledge.sqlite3 后删库重建（数据库已被回滚为 1.0）。',
      })
    }
    logger.info('知识库表结构已从 1.0 迁移到 2.0。')
    return [
      diagnostic({
        error_code: MIGRATE_CODES.SCHEMA_VERSION_MIGRATED,
        severity: SEVERITY.INFO,
        field_path: 'schema_meta.kb_schema_version',
        message: '知识库表结构 1.0 已迁移到 2.0：tags 新增 zh_name/kind，prompt_experiences 新增 target_profile/slots_snapshot。',
        suggested_fix: null,
      }),
    ]
  }
  handle.close()
  throw new KnowledgeBaseError(
    KB_DB_CODES.SCHEMA_VERSION_MISMATCH,
    `数据库表结构版本是 ${existing}，本插件需要 ${KB_SCHEMA_VERSION}。`,
    {
      detail: `db=${existing} plugin=${KB_SCHEMA_VERSION}`,
      suggestedFix: '这个库来自更新或更旧的插件版本；备份后删库重建，再用 rebuild_knowledge_base 重新导入。',
    },
  )
}

export function readMeta(handle, key) {
  try {
    const row = handle.get('SELECT value FROM schema_meta WHERE key = ?', key)
    return row ? String(row.value) : null
  } catch {
    return null
  }
}

export function writeMeta(handle, key, value) {
  handle.run('INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, String(value))
}

export async function openMemoryDatabase() {
  const { DatabaseSync } = await loadSqlite()
  const raw = new DatabaseSync(':memory:')
  raw.exec(KB_DDL)
  const handle = createHandle(raw, { path: ':memory:', readonly: false })
  writeMeta(handle, META_KEYS.SCHEMA_VERSION, KB_SCHEMA_VERSION)
  writeMeta(handle, META_KEYS.CREATED_AT, new Date().toISOString())
  return handle
}

export function probeWritable(handle) {
  if (handle.readonly) return { writable: false, reason: '以只读方式打开' }
  try {
    handle.exec('BEGIN')
    handle.run('INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', '__probe__', new Date().toISOString())
    handle.run('DELETE FROM schema_meta WHERE key = ?', '__probe__')
    handle.exec('COMMIT')
    return { writable: true, reason: null }
  } catch (error) {
    try {
      handle.exec('ROLLBACK')
    } catch {
    }
    return { writable: false, reason: error?.message ?? String(error) }
  }
}

export function listTables(handle) {
  try {
    return handle
      .all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .map((row) => String(row.name))
  } catch {
    return []
  }
}

export { KB_SCHEMA_VERSION }
