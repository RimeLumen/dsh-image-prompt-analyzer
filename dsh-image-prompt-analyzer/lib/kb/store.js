
import { KB_DB_CODES, KnowledgeBaseError } from './db.js'
import { classifyTag } from './classify.js'
import { internalCategoryForKind } from './kind.js'
import { normalizeTagName } from './normalize.js'
import { META_KEYS } from './schema.js'

function nowIso() {
  return new Date().toISOString()
}

export function upsertTag(handle, record) {
  const name = normalizeTagName(record?.name)
  if (!name) {
    throw new KnowledgeBaseError(KB_DB_CODES.QUERY_FAILED, '标签名为空，拒绝写入。', {
      suggestedFix: '检查数据源返回的记录：name 字段缺失。',
    })
  }
  const sourceId = String(record.source_id ?? 'unknown')
  const canonical = normalizeTagName(record.canonical_name ?? name)
  const nativeCategory = record.native_category ?? null
  const postCount = Number.isFinite(Number(record.post_count)) ? Number(record.post_count) : null
  const zhName = typeof record.zh_name === 'string' && record.zh_name.trim() ? record.zh_name.trim() : null
  const kind = typeof record.kind === 'string' && record.kind.trim() ? record.kind.trim() : 'general'
  const updatedAt = record.updated_at ?? nowIso()

  const row = handle.get(
    `INSERT INTO tags (name, canonical_name, source_id, native_category, post_count, zh_name, kind, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_id, name) DO UPDATE SET
       canonical_name  = excluded.canonical_name,
       native_category = COALESCE(excluded.native_category, tags.native_category),
       post_count      = COALESCE(excluded.post_count, tags.post_count),
       zh_name         = COALESCE(excluded.zh_name, tags.zh_name),
       kind            = CASE WHEN excluded.kind = 'general' THEN tags.kind ELSE excluded.kind END,
       updated_at      = excluded.updated_at
     RETURNING id`,
    name,
    canonical,
    sourceId,
    nativeCategory,
    postCount,
    zhName,
    kind,
    updatedAt,
  )
  return Number(row.id)
}

export function setTagCategory(handle, tagId, category, confidence = null) {
  if (!category) return
  handle.run(
    `INSERT INTO tag_categories (tag_id, category, confidence) VALUES (?, ?, ?)
     ON CONFLICT (tag_id, category) DO UPDATE SET confidence = excluded.confidence`,
    tagId,
    String(category),
    confidence === null || confidence === undefined ? null : Number(confidence),
  )
}

export function upsertTagBatch(handle, records, { classify = true } = {}) {
  let inserted = 0
  let categorized = 0
  handle.transaction(() => {
    for (const record of records) {
      const id = upsertTag(handle, record)
      inserted += 1
      if (!classify) continue
      const explicit = typeof record?.category === 'string' && record.category ? record.category : null
      const fromKind = explicit ? null : internalCategoryForKind(record?.kind, { subcategory: record?.subcategory ?? null })
      const verdict = explicit || fromKind ? null : classifyTag(record)
      const category = explicit ?? fromKind ?? verdict?.category ?? null
      if (category) {
        setTagCategory(handle, id, category, explicit || fromKind ? 1 : verdict.confidence)
        categorized += 1
      }
    }
  })
  return { written: inserted, categorized }
}

export function upsertAliasBatch(handle, records, { sourceId = 'unknown' } = {}) {
  let written = 0
  let placeholders = 0
  handle.transaction(() => {
    for (const record of records) {
      const alias = normalizeTagName(record?.alias)
      const canonical = normalizeTagName(record?.canonical_name)
      if (!alias || !canonical) continue
      const source = String(record.source_id ?? sourceId)
      const updatedAt = record.updated_at ?? nowIso()

      const canonicalRow = handle.get('SELECT id FROM tags WHERE source_id = ? AND name = ?', source, canonical)
      let canonicalId
      if (canonicalRow) {
        canonicalId = Number(canonicalRow.id)
      } else {
        canonicalId = upsertTag(handle, { name: canonical, canonical_name: canonical, source_id: source, updated_at: updatedAt })
        placeholders += 1
      }

      handle.run(
        `INSERT INTO tag_aliases (alias, tag_id, source_id, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (source_id, alias) DO UPDATE SET tag_id = excluded.tag_id, updated_at = excluded.updated_at`,
        alias,
        canonicalId,
        source,
        updatedAt,
      )
      written += 1
    }
  })
  return { written, placeholders }
}

export function upsertImplicationBatch(handle, records, { sourceId = 'unknown' } = {}) {
  let written = 0
  handle.transaction(() => {
    for (const record of records) {
      const antecedent = normalizeTagName(record?.antecedent_name ?? record?.from)
      const implied = normalizeTagName(record?.implied_name ?? record?.to)
      if (!antecedent || !implied) continue
      const source = String(record.source_id ?? sourceId)

      const ensure = (name) => {
        const row = handle.get('SELECT id FROM tags WHERE source_id = ? AND name = ?', source, name)
        if (row) return Number(row.id)
        return upsertTag(handle, { name, canonical_name: name, source_id: source })
      }

      handle.run(
        `INSERT INTO tag_implications (tag_id, implied_tag_id, source_id) VALUES (?, ?, ?)
         ON CONFLICT (tag_id, implied_tag_id) DO UPDATE SET source_id = excluded.source_id`,
        ensure(antecedent),
        ensure(implied),
        source,
      )
      written += 1
    }
  })
  return { written }
}
export function findTag(handle, name, { sourceIds = null } = {}) {
  const normalized = normalizeTagName(name)
  if (!normalized) return null
  const rows = sourceIds && sourceIds.length > 0
    ? handle.all(
        `SELECT * FROM tags WHERE name = ? AND source_id IN (${sourceIds.map(() => '?').join(',')}) ORDER BY post_count DESC NULLS LAST LIMIT 1`,
        normalized,
        ...sourceIds,
      )
    : handle.all('SELECT * FROM tags WHERE name = ? ORDER BY post_count DESC NULLS LAST LIMIT 1', normalized)
  if (rows.length === 0) return null
  return decorateTag(handle, rows[0])
}

export function findTagById(handle, id) {
  const row = handle.get('SELECT * FROM tags WHERE id = ?', Number(id))
  return row ? decorateTag(handle, row) : null
}

export function decorateTags(handle, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return []
  const ids = rows.map((row) => Number(row.id))
  const placeholders = ids.map(() => '?').join(',')
  const byId = new Map()
  for (const item of handle.all(
    `SELECT tag_id, category, confidence FROM tag_categories WHERE tag_id IN (${placeholders})`,
    ...ids,
  )) {
    const tagId = Number(item.tag_id)
    const entry = { category: String(item.category), confidence: item.confidence === null ? null : Number(item.confidence) }
    const list = byId.get(tagId)
    if (list) list.push(entry)
    else byId.set(tagId, [entry])
  }
  return rows.map((row) => tagFromRow(row, byId.get(Number(row.id)) ?? []))
}

function decorateTag(handle, row) {
  return decorateTags(handle, [row])[0]
}

function tagFromRow(row, categories) {
  return {
    id: Number(row.id),
    name: String(row.name),
    canonical_name: String(row.canonical_name),
    source_id: String(row.source_id),
    native_category: row.native_category === null ? null : String(row.native_category),
    post_count: row.post_count === null ? null : Number(row.post_count),
    zh_name: row.zh_name === null || row.zh_name === undefined ? null : String(row.zh_name),
    kind: row.kind === null || row.kind === undefined ? 'general' : String(row.kind),
    updated_at: String(row.updated_at),
    categories,
  }
}

export function searchTagsByPrefix(handle, prefix, { limit = 20, sourceIds = null } = {}) {
  const normalized = normalizeTagName(prefix)
  if (!normalized) return []
  const pattern = `${normalized.replace(/[%_]/g, (char) => `\\${char}`)}%`
  const params = [pattern]
  let sql = 'SELECT * FROM tags WHERE name LIKE ? ESCAPE \'\\\''
  if (sourceIds && sourceIds.length > 0) {
    sql += ` AND source_id IN (${sourceIds.map(() => '?').join(',')})`
    params.push(...sourceIds)
  }
  sql += ' ORDER BY post_count DESC NULLS LAST, name ASC LIMIT ?'
  params.push(Number(limit))
  return decorateTags(handle, handle.all(sql, ...params))
}

export function findAlias(handle, alias, { sourceIds = null } = {}) {
  const normalized = normalizeTagName(alias)
  if (!normalized) return null
  const rows = sourceIds && sourceIds.length > 0
    ? handle.all(
        `SELECT * FROM tag_aliases WHERE alias = ? AND source_id IN (${sourceIds.map(() => '?').join(',')}) LIMIT 1`,
        normalized,
        ...sourceIds,
      )
    : handle.all('SELECT * FROM tag_aliases WHERE alias = ? LIMIT 1', normalized)
  if (rows.length === 0) return null
  const row = rows[0]
  return {
    alias: String(row.alias),
    source_id: String(row.source_id),
    updated_at: String(row.updated_at),
    tag: findTagById(handle, row.tag_id),
  }
}

export function listTagsByCategory(handle, category, { limit = 50, sourceIds = null } = {}) {
  const params = [String(category)]
  let sql = `SELECT t.* FROM tags t JOIN tag_categories c ON c.tag_id = t.id WHERE c.category = ?`
  if (sourceIds && sourceIds.length > 0) {
    sql += ` AND t.source_id IN (${sourceIds.map(() => '?').join(',')})`
    params.push(...sourceIds)
  }
  sql += ' ORDER BY t.post_count DESC NULLS LAST LIMIT ?'
  params.push(Number(limit))
  return handle.all(sql, ...params).map((row) => decorateTag(handle, row))
}

export function implicationsFor(handle, tagId) {
  return handle
    .all(
      `SELECT t.* FROM tag_implications i JOIN tags t ON t.id = i.implied_tag_id WHERE i.tag_id = ? ORDER BY t.post_count DESC NULLS LAST LIMIT 50`,
      Number(tagId),
    )
    .map((row) => decorateTag(handle, row))
}
export function beginSync(handle, sourceId, { cursor = null } = {}) {
  const row = handle.get(
    'INSERT INTO source_sync_log (source_id, started_at, status, cursor) VALUES (?, ?, ?, ?) RETURNING id',
    String(sourceId),
    nowIso(),
    'running',
    cursor,
  )
  return Number(row.id)
}

export function finishSync(handle, syncId, { status = 'ok', records = 0, cursor = null, errorSummary = null } = {}) {
  handle.run(
    'UPDATE source_sync_log SET finished_at = ?, status = ?, records = ?, cursor = ?, error_summary = ? WHERE id = ?',
    nowIso(),
    String(status),
    Number(records),
    cursor,
    errorSummary,
    Number(syncId),
  )
  if (cursor !== null) {
    writeSyncCursor(handle, cursor)
  }
}

export function writeSyncCursor(handle, cursor) {
  handle.run(
    'INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    META_KEYS.LAST_SYNC_CURSOR,
    typeof cursor === 'string' ? cursor : JSON.stringify(cursor),
  )
}

export function readSyncCursor(handle) {
  const row = handle.get('SELECT value FROM schema_meta WHERE key = ?', META_KEYS.LAST_SYNC_CURSOR)
  if (!row) return null
  try {
    return JSON.parse(String(row.value))
  } catch {
    return String(row.value)
  }
}

export function lastSyncFor(handle, sourceId) {
  const row = handle.get('SELECT * FROM source_sync_log WHERE source_id = ? ORDER BY id DESC LIMIT 1', String(sourceId))
  if (!row) return null
  return {
    id: Number(row.id),
    source_id: String(row.source_id),
    started_at: String(row.started_at),
    finished_at: row.finished_at === null ? null : String(row.finished_at),
    status: String(row.status),
    records: row.records === null ? null : Number(row.records),
    cursor: row.cursor === null ? null : String(row.cursor),
    error_summary: row.error_summary === null ? null : String(row.error_summary),
  }
}
export function countTags(handle) {
  const row = handle.get('SELECT COUNT(*) AS n FROM tags')
  return Number(row?.n ?? 0)
}

export function knowledgeStats(handle) {
  const summary = handle.get(
    `SELECT
      (SELECT COUNT(*) FROM tags) AS tags,
      (SELECT COUNT(*) FROM tag_aliases) AS aliases,
      (SELECT COUNT(*) FROM tag_implications) AS implications,
      (SELECT COUNT(*) FROM prompt_experiences) AS experiences,
      (SELECT MAX(updated_at) FROM tags) AS newest`,
  )
  const byCategory = handle
    .all('SELECT category, COUNT(*) AS n FROM tag_categories GROUP BY category ORDER BY n DESC')
    .map((row) => ({ category: String(row.category), count: Number(row.n) }))
  const byNative = handle
    .all('SELECT native_category, COUNT(*) AS n FROM tags GROUP BY native_category ORDER BY n DESC')
    .map((row) => ({ native_category: row.native_category === null ? null : String(row.native_category), count: Number(row.n) }))
  const byKind = handle
    .all('SELECT kind, COUNT(*) AS n FROM tags GROUP BY kind ORDER BY n DESC')
    .map((row) => ({ kind: String(row.kind), count: Number(row.n) }))
  const bySource = handle
    .all('SELECT source_id, COUNT(*) AS n FROM tags GROUP BY source_id ORDER BY n DESC')
    .map((row) => ({ source_id: String(row.source_id), count: Number(row.n) }))
  return {
    tags: Number(summary?.tags ?? 0),
    aliases: Number(summary?.aliases ?? 0),
    implications: Number(summary?.implications ?? 0),
    experiences: Number(summary?.experiences ?? 0),
    by_category: byCategory,
    by_native_category: byNative,
    by_kind: byKind,
    by_source: bySource,
    last_tag_update: summary?.newest === null || summary?.newest === undefined ? null : String(summary.newest),
  }
}
