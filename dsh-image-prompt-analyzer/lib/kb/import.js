
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import { SEVERITY, diagnostic } from '../diagnostics.js'
import { NULL_LOGGER } from '../log.js'
import { PACKAGE_DIR, resolveWithin } from '../paths.js'
import { KnowledgeBaseError, openKnowledgeDatabase } from './db.js'
import { inferTagKind, normalizeNativeCategory } from './kind.js'
import { normalizeTagName } from './normalize.js'
import { READER_CODES } from './readers/codes.js'
import { readLocalFile } from './readers/index.js'
import {
  beginSync,
  finishSync,
  upsertAliasBatch,
  upsertTagBatch,
} from './store.js'

export const IMPORT_CODES = Object.freeze({
  UNKNOWN_SOURCE_TYPE: 'KB_IMPORT_UNKNOWN_SOURCE_TYPE',
  FILE_MISSING: 'KB_IMPORT_FILE_MISSING',
  EMPTY: 'KB_IMPORT_EMPTY',
  SQLITE_SCHEMA: 'KB_IMPORT_SQLITE_SCHEMA',
  JSONL_SYNTAX: 'KB_IMPORT_JSONL_SYNTAX',
  SKIPPED_ROWS: 'KB_IMPORT_SKIPPED_ROWS',
  FILE_TOO_LARGE: 'KB_IMPORT_FILE_TOO_LARGE',
})

export const REBUILD_CODES = Object.freeze({
  NO_SOURCE: 'KB_REBUILD_NO_SOURCE',
})

export const SOURCE_TYPES = Object.freeze(['local_file', 'local_sqlite', 'experience_store'])

export const IMPORT_FORMATS = Object.freeze(['csv', 'xlsx', 'docx', 'pdf', 'txt', 'md'])

const MAX_FILE_BYTES = 64 * 1024 * 1024

const BATCH_SIZE = 1000

const DEFAULT_COLUMNS = Object.freeze({
  tag: 0,
  native_category: 1,
  post_count: 2,
  aliases: 3,
  zh_name: 4,
  category: 5,
  subcategory: 6,
})

const DANBOORU_NATIVE_CATEGORY_BY_ID = Object.freeze({
  0: 'general',
  1: 'artist',
  3: 'copyright',
  4: 'character',
  5: 'meta',
})

const HEADER_SYNONYMS = Object.freeze({
  tag: ['tag', '标签', '名称', 'name'],
  aliases: ['aliases', 'alias', '别名'],
  zh_name: ['zh', 'zh_name', '中文', '中文名', '翻译'],
  category: ['category', '大类', '分类'],
  subcategory: ['subcategory', '子类'],
  native_category: ['native_category', '类别', 'danbooru_category'],
  post_count: ['post_count', 'count', '作品数', '帖子数'],
})

function resolveSourcePath(sourceConfig) {
  const raw = sourceConfig?.path
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const trimmed = raw.trim()
  if (isAbsolute(trimmed)) return trimmed
  return resolveWithin(PACKAGE_DIR, trimmed, null)
}

function assertFileSize(filePath) {
  let stats
  try {
    stats = statSync(filePath)
  } catch {
    return
  }
  if (stats.size > MAX_FILE_BYTES) {
    throw new KnowledgeBaseError(
      IMPORT_CODES.FILE_TOO_LARGE,
      `数据源文件 ${Math.round(stats.size / 1024 / 1024)}MB，超过 64MB 上限。`,
      {
        fieldPath: '/path',
        suggestedFix: '先在表格软件里拆分文件，或改用 CSV + limit 分段导入。',
      },
    )
  }
}

function toNativeCategory(value, nativeCategoryMap = null) {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (text === '') return null
  if (/^\d+$/.test(text)) {
    const mapped = nativeCategoryMap?.[text]
    return mapped ? normalizeNativeCategory(mapped) : (DANBOORU_NATIVE_CATEGORY_BY_ID[Number(text)] ?? null)
  }
  return normalizeNativeCategory(text)
}

function toAliases(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return []
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text)
        if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean)
      } catch {
      }
    }
    return text.split(',').map((item) => item.trim()).filter(Boolean)
  }
  return []
}

const WORD_STYLE_SPACED = (text) => String(text).replace(/_/g, ' ')

function declaredCategorySet(categories) {
  if (!Array.isArray(categories)) return null
  const ids = categories
    .map((item) => (typeof item === 'string' ? item : item?.category_id))
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim())
  return ids.length > 0 ? new Set(ids) : null
}

export function tagRecordFromRow(row, { sourceId, nativeCategoryMap = null, allowedCategories = null } = {}) {
  let rawTag = null
  let aliases = []
  let zhName = null
  let nativeCategory = null
  let category = null
  let subcategory = null
  let postCount = null

  if (typeof row === 'string') {
    rawTag = row
  } else if (Array.isArray(row)) {
    rawTag = row[DEFAULT_COLUMNS.tag]
    nativeCategory = toNativeCategory(row[DEFAULT_COLUMNS.native_category], nativeCategoryMap)
    postCount = Number(row[DEFAULT_COLUMNS.post_count])
    aliases = toAliases(row[DEFAULT_COLUMNS.aliases])
    zhName = row[DEFAULT_COLUMNS.zh_name] ?? null
    category = row[DEFAULT_COLUMNS.category] ?? null
    subcategory = row[DEFAULT_COLUMNS.subcategory] ?? null
  } else if (row && typeof row === 'object') {
    rawTag = row.tag ?? row.name ?? row.canonical_name ?? null
    aliases = toAliases(row.aliases ?? row.alias)
    zhName = row.zh_name ?? row.zh ?? null
    nativeCategory = toNativeCategory(row.native_category ?? row.category_id ?? row.category, nativeCategoryMap)
    category = row.category ?? null
    subcategory = row.subcategory ?? null
    postCount = Number(row.post_count ?? row.count)
  }

  if (allowedCategories && category && !allowedCategories.has(String(category).trim())) category = null

  const name = normalizeTagName(rawTag)
  if (!name) return null
  const trimmedZh = typeof zhName === 'string' && zhName.trim() ? zhName.trim() : null
  return {
    name,
    canonical_name: name,
    source_id: sourceId,
    native_category: nativeCategory,
    post_count: Number.isFinite(postCount) ? postCount : null,
    zh_name: trimmedZh,
    kind: inferTagKind({ tag: name, native_category: nativeCategory, category, subcategory }),
    category,
    subcategory,
    aliases: aliases
      .map((alias) => normalizeTagName(alias))
      .filter((alias) => alias && alias !== name),
  }
}

export function tagRecordsFromRows(rows, { sourceId, nativeCategoryMap = null, allowedCategories = null } = {}) {
  const records = []
  let skipped = 0
  for (const row of Array.isArray(rows) ? rows : []) {
    const record = tagRecordFromRow(row, { sourceId, nativeCategoryMap, allowedCategories })
    if (!record) {
      skipped += 1
      continue
    }
    records.push(record)
  }
  return { records, skipped }
}

function looksLikeHeader(cells) {
  const names = cells.map((cell) => String(cell).trim().toLowerCase())
  let hits = 0
  for (const synonyms of Object.values(HEADER_SYNONYMS)) {
    if (names.some((name) => synonyms.includes(name))) hits += 1
  }
  return hits >= 2
}

function recordsFromMatrixRows(rows, { sourceConfig, sourceId, allowedCategories = null }) {
  let data = rows
  if (data.length > 0 && looksLikeHeader(data[0]) && sourceConfig?.has_header !== false) {
    data = data.slice(1)
  }
  const columnMap = sourceConfig?.column_map ?? null
  const mapped = data.map((cells) => {
    if (!Array.isArray(cells) || !columnMap) return cells
    const row = []
    for (const field of Object.keys(DEFAULT_COLUMNS)) {
      const ref = columnMap[field]
      row[DEFAULT_COLUMNS[field]] = ref === undefined || ref === null ? undefined : cells[Number(ref)]
    }
    return row
  })
  return tagRecordsFromRows(mapped, {
    sourceId,
    nativeCategoryMap: sourceConfig?.native_category_map ?? null,
    allowedCategories,
  })
}

function writeRecordsInBatches(handle, records, { sourceId, logger }) {
  let imported = 0
  let aliases = 0
  const total = records.length
  let nextMilestone = Math.max(1, Math.floor(total / 10))
  for (let offset = 0; offset < total; offset += BATCH_SIZE) {
    const batch = records.slice(offset, offset + BATCH_SIZE)
    const result = upsertTagBatch(handle, batch)
    imported += result.written
    const aliasRecords = []
    for (const record of batch) {
      for (const alias of record.aliases ?? []) {
        aliasRecords.push({ alias, canonical_name: record.name, source_id: sourceId })
      }
    }
    if (aliasRecords.length > 0) {
      aliases += upsertAliasBatch(handle, aliasRecords, { sourceId }).written
    }
    if (imported >= nextMilestone || offset + BATCH_SIZE >= total) {
      logger.info?.(`导入进度：${imported}/${total} 行（${Math.round((imported / total) * 100)}%）`)
      nextMilestone = imported + Math.max(1, Math.floor(total / 10))
    }
  }
  return { imported, aliases }
}

function clearSourceRows(handle, sourceId) {
  const ids = handle.all('SELECT id FROM tags WHERE source_id = ?', sourceId).map((row) => Number(row.id))
  for (const id of ids) {
    handle.run('DELETE FROM tag_categories WHERE tag_id = ?', id)
    handle.run('DELETE FROM tag_implications WHERE tag_id = ? OR implied_tag_id = ?', id, id)
    handle.run('UPDATE experience_tags SET tag_id = NULL WHERE tag_id = ?', id)
  }
  handle.run('DELETE FROM tag_aliases WHERE source_id = ?', sourceId)
  const removed = handle.run('DELETE FROM tags WHERE source_id = ?', sourceId)
  return Number(removed?.changes ?? ids.length)
}

export async function rebuildLocalSource({ handle, sourceConfig, readText, logger = NULL_LOGGER, limit = null, dryRun = false, categories = null } = {}) {
  const sourceId = String(sourceConfig?.source_id ?? 'unknown')
  const type = String(sourceConfig?.type ?? '')
  if (type !== 'local_file') {
    throw new KnowledgeBaseError(IMPORT_CODES.UNKNOWN_SOURCE_TYPE, `重建知识库只支持 local_file 类型的数据源，收到 ${type || '(空)'}。`, {
      configFile: 'knowledge-base',
      fieldPath: `/sources/${sourceId}/type`,
      suggestedFix: '把该数据源改成 type: "local_file"，或用 scripts/import-tags.mjs 单独导入。',
    })
  }

  if (dryRun) {
    return importLocalFileSource({ handle, sourceConfig, readText, logger, limit, dryRun: true, categories })
  }

  const full = limit === null || limit === undefined
  const syncId = beginSync(handle, sourceId)
  try {
    const result = await importLocalFileSource({ handle, sourceConfig, readText, logger, limit, replace: full, categories })
    finishSync(handle, syncId, { status: 'ok', records: result.imported + result.aliases, errorSummary: null })
    return result
  } catch (error) {
    try {
      finishSync(handle, syncId, { status: 'failed', records: 0, errorSummary: error?.message ?? String(error) })
    } catch (syncError) {
      logger.warn(`记录重建失败状态时出错：${syncError?.message ?? syncError}`)
    }
    throw error
  }
}

export async function readLocalSqliteTags({ path, sourceId, logger = NULL_LOGGER, limit = null }) {
  const handle = await openKnowledgeDatabase({ path, readonly: true, createIfMissing: false, logger })
  try {
    const columns = handle.all('PRAGMA table_info(tags)')
    if (!columns || columns.length === 0) {
      throw new KnowledgeBaseError(IMPORT_CODES.SQLITE_SCHEMA, `外部数据库里没有 tags 表：${path}`, {
        suggestedFix: '外部 SQLite 数据源需要一张 tags 表，至少包含 name 列。',
      })
    }
    const names = columns.map((column) => String(column.name))
    if (!names.includes('name')) {
      throw new KnowledgeBaseError(IMPORT_CODES.SQLITE_SCHEMA, `外部数据库的 tags 表没有 name 列（实际列：${names.join(', ')}）。`, {
        suggestedFix: '把标签名列命名为 name，或先导出成 CSV 再导入。',
      })
    }
    const select = ['name']
    if (names.includes('category')) select.push('category')
    if (names.includes('post_count')) select.push('post_count')
    if (names.includes('zh_name')) select.push('zh_name')
    const sql = `SELECT ${select.join(', ')} FROM tags${Number.isFinite(limit) && limit > 0 ? ` LIMIT ${Number(limit)}` : ''}`
    const rows = handle.all(sql)
    return rows
      .map((row) => tagRecordFromRow({ tag: row.name, native_category: row.category, post_count: row.post_count, zh_name: row.zh_name }, { sourceId }))
      .filter(Boolean)
  } finally {
    handle.close()
  }
}

export function parseJsonLines(text, { tolerant = false, configFile = null } = {}) {
  const records = []
  const errors = []
  const lines = String(text ?? '').split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) continue
    try {
      records.push(JSON.parse(line))
    } catch (error) {
      if (!tolerant) {
        throw new KnowledgeBaseError(IMPORT_CODES.JSONL_SYNTAX, `第 ${index + 1} 行不是合法 JSON：${error?.message ?? error}`, {
          configFile,
          suggestedFix: 'JSONL 要求每行一个完整 JSON 对象；确认导出过程没有被中断在半行。',
        })
      }
      errors.push({ line: index + 1, message: String(error?.message ?? error) })
    }
  }
  if (records.length === 0) {
    throw new KnowledgeBaseError(IMPORT_CODES.EMPTY, '这份 JSONL 里没有任何可用记录。', {
      configFile,
      suggestedFix: '确认文件不是空的，也不是只有空行。',
    })
  }
  return { records, skipped_lines: errors }
}

export async function importLocalFileSource({ handle, sourceConfig, readText, logger = NULL_LOGGER, limit = null, dryRun = false, replace = false, categories = null } = {}) {
  const sourceId = String(sourceConfig?.source_id ?? 'unknown')
  const diagnostics = []
  const filePath = resolveSourcePath(sourceConfig)
  if (!filePath) {
    throw new KnowledgeBaseError(IMPORT_CODES.FILE_MISSING, `数据源 ${sourceId} 的 path 无法解析：${sourceConfig?.path ?? '(空)'}`, {
      configFile: 'knowledge-base',
      fieldPath: `/sources/${sourceId}/path`,
      suggestedFix: '填插件目录内的相对路径，例如 res/danbooru_all.csv；路径不能是绝对路径、也不能逃出插件目录。',
    })
  }
  assertFileSize(filePath)

  const effectiveLimit = Number.isFinite(limit) && limit > 0 ? limit : null
  const result = await readLocalFile({
    path: filePath,
    format: sourceConfig?.format ?? null,
    readText,
    hasHeader: sourceConfig?.has_header ?? 'auto',
    delimiter: sourceConfig?.delimiter ?? ',',
    columnMap: sourceConfig?.column_map ?? null,
  })
  diagnostics.push(...result.diagnostics)
  if (!result.ok) {
    const first = result.diagnostics.find((item) => item.severity === SEVERITY.ERROR) ?? result.diagnostics[0]
    throw new KnowledgeBaseError(first?.error_code ?? READER_CODES.FILE_UNREADABLE, first?.message ?? `读取 ${filePath} 失败。`, {
      detail: first?.message ?? null,
      configFile: 'knowledge-base',
      fieldPath: `/sources/${sourceId}/path`,
      suggestedFix: first?.suggested_fix ?? '确认文件存在、格式与扩展名一致、且未被其它程序占用。',
    })
  }

  const isMatrix = sourceConfig?.format === 'xlsx' || (Array.isArray(result.rows[0]) && result.rows[0].length > 0)
  const allowedCategories = declaredCategorySet(categories)
  const converted = isMatrix
    ? recordsFromMatrixRows(result.rows, { sourceConfig, sourceId, allowedCategories })
    : tagRecordsFromRows(result.rows, {
        sourceId,
        nativeCategoryMap: sourceConfig?.native_category_map ?? null,
        allowedCategories,
      })
  const skipped = result.skipped + converted.skipped
  if (skipped > 0) {
    diagnostics.push(
      diagnostic({
        error_code: IMPORT_CODES.SKIPPED_ROWS,
        severity: SEVERITY.WARNING,
        config_file: 'knowledge-base',
        field_path: `/sources/${sourceId}`,
        message: `数据源 ${sourceId} 有 ${skipped} 行无法解析或缺少标签名，已跳过。`,
        suggested_fix: '查看这些行的 tag 列是否为空；确认列映射没有整体错位。',
      }),
    )
  }

  const limited = effectiveLimit !== null ? converted.records.slice(0, effectiveLimit) : converted.records
  if (dryRun) {
    const aliasCount = limited.reduce((sum, record) => sum + (Array.isArray(record.aliases) ? record.aliases.length : 0), 0)
    return {
      source_id: sourceId,
      kind: 'tags',
      format: sourceConfig?.format ?? null,
      path: sourceConfig?.path ?? null,
      imported: 0,
      would_import: limited.length,
      aliases: aliasCount,
      skipped,
      limited: effectiveLimit !== null && converted.records.length > effectiveLimit ? converted.records.length - effectiveLimit : 0,
      diagnostics,
    }
  }

  const written = handle.transaction(() => {
    const removed = replace ? clearSourceRows(handle, sourceId) : 0
    const result = writeRecordsInBatches(handle, limited, { sourceId, logger })
    return { ...result, removed }
  })
  return {
    source_id: sourceId,
    kind: 'tags',
    format: sourceConfig?.format ?? null,
    path: sourceConfig?.path ?? null,
    imported: written.imported,
    aliases: written.aliases,
    removed: written.removed,
    skipped,
    limited: effectiveLimit !== null && converted.records.length > effectiveLimit ? converted.records.length - effectiveLimit : 0,
    diagnostics,
  }
}

export async function importLocalSource({ handle, sourceConfig, readText, logger = NULL_LOGGER, limit = null, categories = null } = {}) {
  const type = String(sourceConfig?.type ?? '')
  const sourceId = String(sourceConfig?.source_id ?? 'unknown')
  const diagnostics = []

  if (!SOURCE_TYPES.includes(type)) {
    throw new KnowledgeBaseError(IMPORT_CODES.UNKNOWN_SOURCE_TYPE, `不支持的数据源类型：${type || '(空)'}`, {
      configFile: 'knowledge-base',
      fieldPath: `/sources/${sourceId}/type`,
      suggestedFix: `可用类型：${SOURCE_TYPES.join(' / ')}。`,
    })
  }

  const syncId = beginSync(handle, sourceId)
  const summary = { source_id: sourceId, kind: null, imported: 0, aliases: 0, skipped: 0, limited: 0 }

  try {
    if (type === 'local_file') {
      const result = await importLocalFileSource({ handle, sourceConfig, readText, logger, limit, categories })
      Object.assign(summary, {
        kind: result.kind,
        format: result.format,
        path: result.path,
        imported: result.imported,
        aliases: result.aliases,
        skipped: result.skipped,
        limited: result.limited,
      })
      diagnostics.push(...result.diagnostics)
    } else if (type === 'local_sqlite') {
      const filePath = resolveSourcePath(sourceConfig)
      if (!filePath) {
        throw new KnowledgeBaseError(IMPORT_CODES.FILE_MISSING, `数据源 ${sourceId} 的 path 无法解析。`, {
          fieldPath: `/sources/${sourceId}/path`,
          suggestedFix: '填插件目录内的相对路径，例如 data/kb/tags.sqlite3。',
        })
      }
      const records = await readLocalSqliteTags({ path: filePath, sourceId, logger, limit })
      const written = writeRecordsInBatches(handle, records, { sourceId, logger })
      summary.kind = 'tags'
      summary.imported = written.imported
      summary.aliases = written.aliases
    } else {
      let text
      try {
        text = typeof readText === 'function' ? await readText(sourceConfig.path) : await (await import('node:fs/promises')).readFile(sourceConfig.path, 'utf8')
      } catch (error) {
        throw new KnowledgeBaseError(READER_CODES.FILE_UNREADABLE, `读取 ${sourceConfig.path} 失败：${error?.message ?? error}`, {
          fieldPath: `/sources/${sourceId}/path`,
          suggestedFix: '确认经验库导出文件存在且可读。',
        })
      }
      const parsed = parseJsonLines(text, { tolerant: true })
      if (parsed.skipped_lines.length > 0) {
        summary.skipped = parsed.skipped_lines.length
        diagnostics.push(
          diagnostic({
            error_code: IMPORT_CODES.SKIPPED_ROWS,
            severity: SEVERITY.WARNING,
            field_path: `/sources/${sourceId}`,
            message: `经验文件有 ${parsed.skipped_lines.length} 行无法解析，已跳过（首行 ${parsed.skipped_lines[0].line}）。`,
            suggested_fix: '这些行不会进入经验库；如果它们本该有效，请检查导出文件是否完整。',
          }),
        )
      }
      summary.kind = 'experiences'
      summary.experiences = parsed.records
      summary.imported = 0
    }

    finishSync(handle, syncId, {
      status: 'ok',
      records: summary.imported + summary.aliases,
      errorSummary: null,
    })
    return { ...summary, diagnostics }
  } catch (error) {
    const message = error?.message ?? String(error)
    try {
      finishSync(handle, syncId, { status: 'failed', records: 0, errorSummary: message })
    } catch (syncError) {
      logger.warn(`记录同步失败状态时出错：${syncError?.message ?? syncError}`)
    }
    throw error
  }
}

export async function importAllLocalSources({ handle, config, readText, logger = NULL_LOGGER, limit = null } = {}) {
  const categories = config?.categories ?? null
  const sources = (Array.isArray(config?.sources) ? config.sources : []).filter(
    (source) => source.enabled !== false,
  )
  const results = []
  const diagnostics = []
  for (const source of sources) {
    try {
      const result = await importLocalSource({ handle, sourceConfig: source, readText, logger, limit, categories })
      results.push(result)
      diagnostics.push(...result.diagnostics)
    } catch (error) {
      const isKbError = error instanceof KnowledgeBaseError
      diagnostics.push(
        diagnostic({
          error_code: isKbError ? error.code : READER_CODES.FILE_UNREADABLE,
          severity: SEVERITY.ERROR,
          config_file: 'knowledge-base',
          field_path: `/sources/${source.source_id}`,
          message: `数据源 ${source.source_id} 导入失败：${error?.message ?? error}`,
          suggested_fix: error?.suggested_fix ?? '检查该数据源的 path 与文件格式。',
        }),
      )
      results.push({ source_id: source.source_id, kind: null, imported: 0, aliases: 0, skipped: 0, diagnostics: [] })
    }
  }
  return { results, diagnostics }
}
