
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
  // deprecated 只有"来源明说了"才算数。CSV 词表没有这一列，它不该把
  // 一个已经标记废弃的词洗回可用状态——所以这里额外带一个声明标志进 upsert。
  const deprecatedDeclared = record.deprecated === undefined || record.deprecated === null ? 0 : 1
  const deprecated = deprecatedDeclared === 1 ? (Number(record.deprecated) === 1 ? 1 : 0) : 0
  const tagGroup = typeof record.tag_group === 'string' && record.tag_group.trim() ? record.tag_group.trim() : null
  const translationStatus = typeof record.translation_status === 'string' && record.translation_status.trim()
    ? record.translation_status.trim()
    : null

  const row = handle.get(
    `INSERT INTO tags (name, canonical_name, source_id, native_category, post_count, zh_name, kind, updated_at, deprecated, tag_group, translation_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_id, name) DO UPDATE SET
       canonical_name     = excluded.canonical_name,
       native_category    = COALESCE(excluded.native_category, tags.native_category),
       post_count         = COALESCE(excluded.post_count, tags.post_count),
       zh_name            = COALESCE(excluded.zh_name, tags.zh_name),
       kind               = CASE WHEN excluded.kind = 'general' THEN tags.kind ELSE excluded.kind END,
       updated_at         = excluded.updated_at,
       deprecated         = CASE WHEN ? = 1 THEN excluded.deprecated ELSE tags.deprecated END,
       tag_group          = COALESCE(excluded.tag_group, tags.tag_group),
       translation_status = COALESCE(excluded.translation_status, tags.translation_status)
     RETURNING id`,
    name,
    canonical,
    sourceId,
    nativeCategory,
    postCount,
    zhName,
    kind,
    updatedAt,
    deprecated,
    tagGroup,
    translationStatus,
    deprecatedDeclared,
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

/**
 * 按中文名查标签。
 *
 * 中文名不是标签身份的一部分：`女仆` 与 `maid` 是同一条标签的两种写法，
 * 真正进提示词的永远是英文 name。所以这个查询只在"用户拿中文来找词"时用，
 * 命中的结果仍带着英文 name，调用方据此渲染。
 *
 * 只认精确匹配：中文名是人工审过的译名，模糊匹配会命中一堆近义词，
 * 而用户要的是"这个词对应哪条标签"，不是"哪些词像它"。
 */
export function findTagByZh(handle, zh, { sourceIds = null, includeDeprecated = false } = {}) {
  const text = String(zh ?? '').trim()
  if (text === '') return null
  const params = [text]
  let sql = 'SELECT * FROM tags WHERE zh_name = ?'
  if (sourceIds && sourceIds.length > 0) {
    sql += ` AND source_id IN (${sourceIds.map(() => '?').join(',')})`
    params.push(...sourceIds)
  }
  if (!includeDeprecated) sql += ' AND COALESCE(deprecated, 0) = 0'
  sql += ' ORDER BY post_count DESC NULLS LAST, name ASC LIMIT 1'
  const rows = handle.all(sql, ...params)
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
    deprecated: row.deprecated === null || row.deprecated === undefined ? 0 : Number(row.deprecated),
    tag_group: row.tag_group === null || row.tag_group === undefined ? null : String(row.tag_group),
    translation_status: row.translation_status === null || row.translation_status === undefined
      ? null
      : String(row.translation_status),
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

function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined) return fallback
  try {
    const parsed = JSON.parse(String(value))
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

/**
 * 记下"这个数据源上次导入时是什么样"。
 *
 * fingerprint 是源文件 sha256，它是幂等判断的唯一依据：指纹没变就跳过，
 * 不看时间戳、不看文件大小——时间戳会因为拷贝而变，大小会因为无关改动而变。
 */
export function upsertSourceMeta(handle, meta = {}) {
  const sourceId = String(meta.source_id ?? 'unknown')
  handle.run(
    `INSERT INTO source_meta (
      source_id, kind, role, adapter, adapter_version, declared_path, resolved_path,
      fingerprint, bytes, schema_hash, row_count, deprecated_count, imported_row_count,
      translation_status_counts, tag_group_counts, imported_at, coverage, extra
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source_id) DO UPDATE SET
      kind = excluded.kind,
      role = excluded.role,
      adapter = excluded.adapter,
      adapter_version = excluded.adapter_version,
      declared_path = excluded.declared_path,
      resolved_path = excluded.resolved_path,
      fingerprint = excluded.fingerprint,
      bytes = excluded.bytes,
      schema_hash = excluded.schema_hash,
      row_count = excluded.row_count,
      deprecated_count = excluded.deprecated_count,
      imported_row_count = excluded.imported_row_count,
      translation_status_counts = excluded.translation_status_counts,
      tag_group_counts = excluded.tag_group_counts,
      imported_at = excluded.imported_at,
      coverage = excluded.coverage,
      extra = excluded.extra`,
    sourceId,
    meta.kind ?? null,
    meta.role ?? null,
    meta.adapter ?? null,
    meta.adapter_version ?? null,
    meta.declared_path ?? null,
    meta.resolved_path ?? null,
    meta.fingerprint ?? null,
    meta.bytes ?? null,
    meta.schema_hash ?? null,
    meta.row_count ?? null,
    meta.deprecated_count ?? null,
    meta.imported_row_count ?? null,
    meta.translation_status_counts ? JSON.stringify(meta.translation_status_counts) : null,
    meta.tag_group_counts ? JSON.stringify(meta.tag_group_counts) : null,
    meta.imported_at ?? nowIso(),
    meta.coverage ? JSON.stringify(meta.coverage) : null,
    meta.extra ? JSON.stringify(meta.extra) : null,
  )
  return readSourceMeta(handle, sourceId)
}

export function readSourceMeta(handle, sourceId) {
  const row = handle.get('SELECT * FROM source_meta WHERE source_id = ?', String(sourceId))
  if (!row) return null
  return {
    source_id: String(row.source_id),
    kind: row.kind === null ? null : String(row.kind),
    role: row.role === null || row.role === undefined ? null : String(row.role),
    adapter: row.adapter === null ? null : String(row.adapter),
    adapter_version: row.adapter_version === null ? null : String(row.adapter_version),
    declared_path: row.declared_path === null ? null : String(row.declared_path),
    resolved_path: row.resolved_path === null ? null : String(row.resolved_path),
    fingerprint: row.fingerprint === null ? null : String(row.fingerprint),
    bytes: row.bytes === null ? null : Number(row.bytes),
    schema_hash: row.schema_hash === null ? null : String(row.schema_hash),
    row_count: row.row_count === null ? null : Number(row.row_count),
    deprecated_count: row.deprecated_count === null ? null : Number(row.deprecated_count),
    imported_row_count: row.imported_row_count === null ? null : Number(row.imported_row_count),
    translation_status_counts: parseJsonColumn(row.translation_status_counts, []),
    tag_group_counts: parseJsonColumn(row.tag_group_counts, []),
    imported_at: row.imported_at === null ? null : String(row.imported_at),
    coverage: parseJsonColumn(row.coverage, null),
    extra: parseJsonColumn(row.extra, null),
  }
}

export function listSourceMetas(handle) {
  return handle.all('SELECT source_id FROM source_meta ORDER BY source_id ASC').map((row) => readSourceMeta(handle, row.source_id))
}

/**
 * 源库自带的用户分组（工作室那 1208 个中文分组）。
 *
 * 它们不进 tag_categories：那是插件的 15 个内部分类，混进来会污染槽位判断。
 * 单独存一份，只用于"这个词属于哪些分组"的展示与检索。
 */
export function replaceSourceUserCategories(handle, sourceId, categories = []) {
  handle.run('DELETE FROM source_user_categories WHERE source_id = ?', String(sourceId))
  let written = 0
  for (const category of categories) {
    const name = String(category?.name ?? '').trim()
    if (!name) continue
    handle.run(
      `INSERT INTO source_user_categories (source_id, name, sort_order, tag_count, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (source_id, name) DO UPDATE SET
         sort_order = excluded.sort_order,
         tag_count = excluded.tag_count,
         updated_at = excluded.updated_at`,
      String(sourceId),
      name,
      Number(category?.sort_order ?? 0),
      Number(category?.tag_count ?? 0),
      nowIso(),
    )
    written += 1
  }
  return written
}

export function listSourceUserCategories(handle, sourceId, { limit = 500 } = {}) {
  return handle
    .all(
      'SELECT name, sort_order, tag_count FROM source_user_categories WHERE source_id = ? ORDER BY sort_order ASC, name ASC LIMIT ?',
      String(sourceId),
      Number(limit),
    )
    .map((row) => ({ name: String(row.name), sort_order: Number(row.sort_order ?? 0), tag_count: Number(row.tag_count ?? 0) }))
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

/**
 * 写入工作室分类树与标签归属（整源替换，调用方负责包事务）。
 *
 * 两张表都不参与编译：`tag_categories` 决定一个词进哪个槽位，
 * 这里的分类只决定"在浏览树里挂在哪个分支下"，两套编号互不干涉。
 */
export function replaceStudioCategories(handle, sourceId, { categories = [], links = [] } = {}) {
  const id = String(sourceId)
  handle.run('DELETE FROM studio_categories WHERE source_id = ?', id)
  handle.run('DELETE FROM studio_category_tags WHERE source_id = ?', id)

  const now = nowIso()
  let categoryCount = 0
  for (const category of categories) {
    const studioId = String(category?.studio_id ?? '').trim()
    const name = String(category?.name ?? '').trim()
    if (!studioId || !name) continue
    handle.run(
      `INSERT INTO studio_categories (source_id, studio_id, name, parent_id, sort_order, depth, tag_count, origin, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_id, studio_id) DO UPDATE SET
         name = excluded.name,
         parent_id = excluded.parent_id,
         sort_order = excluded.sort_order,
         depth = excluded.depth,
         tag_count = excluded.tag_count,
         origin = excluded.origin,
         updated_at = excluded.updated_at`,
      id,
      studioId,
      name,
      category?.parent_id === null || category?.parent_id === undefined ? null : String(category.parent_id),
      Number(category?.sort_order ?? 0),
      Number(category?.depth ?? 0),
      Number(category?.tag_count ?? 0),
      category?.origin === null || category?.origin === undefined ? null : String(category.origin),
      now,
    )
    categoryCount += 1
  }

  let linkCount = 0
  for (const link of links) {
    const studioId = String(link?.studio_id ?? '').trim()
    const tagName = String(link?.tag_name ?? '').trim()
    if (!studioId || !tagName) continue
    handle.run(
      `INSERT INTO studio_category_tags (source_id, studio_id, tag_name, studio_tag_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (source_id, studio_id, tag_name) DO NOTHING`,
      id,
      studioId,
      tagName,
      link?.studio_tag_id === null || link?.studio_tag_id === undefined ? null : String(link.studio_tag_id),
    )
    linkCount += 1
  }

  return { categories: categoryCount, links: linkCount }
}

export function countStudioCategories(handle, sourceId) {
  const row = handle.get(
    `SELECT (SELECT COUNT(*) FROM studio_categories WHERE source_id = ?) AS categories,
            (SELECT COUNT(*) FROM studio_category_tags WHERE source_id = ?) AS links`,
    String(sourceId),
    String(sourceId),
  )
  return { categories: Number(row?.categories ?? 0), links: Number(row?.links ?? 0) }
}

/**
 * 把所有工作室源的分类行一次读出来，用于在内存里拼整棵树。
 *
 * 与 `listStudioCategories` 的区别是不按 source 与 parent 过滤：迁移导入之后树已经
 * 完整落在库里，运行时拼树只需要一遍全表扫描，不必再碰工作室目录。
 */
export function listAllStudioCategories(handle, { limit = 20000 } = {}) {
  return handle
    .all(
      `SELECT source_id, studio_id, name, parent_id, sort_order, depth, tag_count, origin
         FROM studio_categories
        ORDER BY depth ASC, sort_order ASC, name ASC
        LIMIT ?`,
      Number(limit),
    )
    .map((row) => ({
      source_id: String(row.source_id),
      studio_id: String(row.studio_id),
      name: String(row.name),
      parent_id: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id),
      sort_order: Number(row.sort_order ?? 0),
      depth: Number(row.depth ?? 0),
      tag_count: Number(row.tag_count ?? 0),
      origin: row.origin === null || row.origin === undefined ? null : String(row.origin),
    }))
}

export function countAllStudioCategories(handle) {
  const row = handle.get(
    `SELECT (SELECT COUNT(*) FROM studio_categories) AS categories,
            (SELECT COUNT(*) FROM studio_category_tags) AS links`,
  )
  return { categories: Number(row?.categories ?? 0), links: Number(row?.links ?? 0) }
}

/**
 * 列出分类树的一层。
 *
 * `parentId` 省略 = 整棵树（按深度、排序、名字排好）；传 `null` = 只要根；传具体 ID = 只要它的直接子节点。
 */
export function listStudioCategories(handle, sourceId, { parentId, limit = 2000 } = {}) {
  const id = String(sourceId)
  const params = [id]
  let where = 'source_id = ?'
  if (parentId === null) {
    where += ' AND parent_id IS NULL'
  } else if (parentId !== undefined) {
    where += ' AND parent_id = ?'
    params.push(String(parentId))
  }
  params.push(Number(limit))
  return handle
    .all(
      `SELECT studio_id, name, parent_id, sort_order, depth, tag_count, origin
         FROM studio_categories
        WHERE ${where}
        ORDER BY depth ASC, sort_order ASC, name ASC
        LIMIT ?`,
      ...params,
    )
    .map((row) => ({
      studio_id: String(row.studio_id),
      name: String(row.name),
      parent_id: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id),
      sort_order: Number(row.sort_order ?? 0),
      depth: Number(row.depth ?? 0),
      tag_count: Number(row.tag_count ?? 0),
      origin: row.origin === null || row.origin === undefined ? null : String(row.origin),
    }))
}

/**
 * 从根一路走到某个分类，返回 [{studio_id, name}]。
 *
 * 断链（父节点不在表里）就地停下，不抛错——分类树是用来浏览的，不是用来做完整性证明的。
 */
export function studioCategoryPath(handle, sourceId, studioId, { maxDepth = 32 } = {}) {
  const id = String(sourceId)
  const chain = []
  let cursor = String(studioId)
  for (let step = 0; step < maxDepth; step += 1) {
    const row = handle.get(
      'SELECT studio_id, name, parent_id FROM studio_categories WHERE source_id = ? AND studio_id = ?',
      id,
      cursor,
    )
    if (!row) break
    chain.unshift({ studio_id: String(row.studio_id), name: String(row.name) })
    if (row.parent_id === null || row.parent_id === undefined) break
    cursor = String(row.parent_id)
  }
  return chain
}

export function findStudioCategoriesByName(handle, sourceId, query, { limit = 20 } = {}) {
  const text = String(query ?? '').trim()
  if (!text) return []
  // LIKE 的通配符要转义，否则搜 "50%" 会变成模糊匹配。转义符用 !，SQL 里对应 ESCAPE '!'。
  const escaped = text.replace(/[!%_]/g, (char) => `!${char}`)
  return handle
    .all(
      `SELECT studio_id, name, parent_id, sort_order, depth, tag_count, origin
         FROM studio_categories
        WHERE source_id = ?
          AND name LIKE ? ESCAPE '!'
        ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END, depth ASC, tag_count DESC, name ASC
        LIMIT ?`,
      String(sourceId),
      `%${escaped}%`,
      text,
      Number(limit),
    )
    .map((row) => ({
      studio_id: String(row.studio_id),
      name: String(row.name),
      parent_id: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id),
      depth: Number(row.depth ?? 0),
      tag_count: Number(row.tag_count ?? 0),
    }))
}

export function studioCategoryTagNames(handle, sourceId, studioId, { limit = 500 } = {}) {
  return handle
    .all(
      `SELECT tag_name FROM studio_category_tags
        WHERE source_id = ? AND studio_id = ?
        ORDER BY tag_name ASC
        LIMIT ?`,
      String(sourceId),
      String(studioId),
      Number(limit),
    )
    .map((row) => String(row.tag_name))
}

export function studioCategoriesForTag(handle, sourceId, tagName) {
  return handle
    .all(
      `SELECT l.studio_id AS studio_id, c.name AS name, c.depth AS depth
         FROM studio_category_tags l
         LEFT JOIN studio_categories c ON c.source_id = l.source_id AND c.studio_id = l.studio_id
        WHERE l.source_id = ? AND l.tag_name = ?
        ORDER BY c.depth ASC, c.name ASC`,
      String(sourceId),
      String(tagName),
    )
    .map((row) => ({
      studio_id: String(row.studio_id),
      name: row.name === null || row.name === undefined ? null : String(row.name),
      depth: row.depth === null || row.depth === undefined ? null : Number(row.depth),
    }))
}
