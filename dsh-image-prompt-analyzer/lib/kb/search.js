import { decorateTags } from './store.js'
import { normalizeTagName } from './normalize.js'

/**
 * 标签检索：给"我想找这类词"用，不判定、不编译。
 *
 * 两种源分开标注：`model` 是模型词表（能不能进提示词由它决定），
 * `studio` 是补充词典（解释得清楚，但不替模型词表背书）。
 * 每条结果都带命中方式与命中字段——"为什么这条排在前面"必须能从结果里读出来，
 * 不能靠模型猜。
 */
export const SEARCH_MATCH = Object.freeze({
  EXACT: 'exact',
  ALIAS: 'alias',
  PREFIX: 'prefix',
  CONTAINS: 'contains',
})

export const SEARCH_CODES = Object.freeze({
  EMPTY_QUERY: 'KB_SEARCH_EMPTY_QUERY',
  NO_SOURCES: 'KB_SEARCH_NO_SOURCES',
  QUERY_FAILED: 'KB_SEARCH_QUERY_FAILED',
})

/**
 * 排序权重。
 *
 * 精确命中一律压过前缀命中，前缀一律压过包含：检索结果的第一条必须能解释
 * "为什么它排第一"。中文名比英文名低 4 分，是因为同一批数据里英文名是原始词、
 * 中文名是译名，撞名时以原始词为准。
 */
export const SEARCH_SCORE = Object.freeze({
  exact_name: 100,
  exact_zh: 96,
  exact_alias: 92,
  prefix_name: 72,
  prefix_zh: 68,
  prefix_alias: 62,
  contains_name: 44,
  contains_zh: 38,
  contains_alias: 32,
})

export const MAX_SEARCH_LIMIT = 50

/**
 * 弃用词的处理方式。
 *
 * 默认 `exclude`：源库说它废弃了，就不该出现在"找一个词"的结果里。
 * `only` 是给"我手上这串词为什么模型不认"用的——只翻废弃区。
 */
export const SEARCH_DEPRECATED = Object.freeze({
  EXCLUDE: 'exclude',
  ONLY: 'only',
  INCLUDE: 'include',
})

function escapeLike(text) {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`)
}

function deprecatedClause(mode) {
  if (mode === SEARCH_DEPRECATED.INCLUDE) return ''
  if (mode === SEARCH_DEPRECATED.ONLY) return 'AND COALESCE(t.deprecated, 0) = 1'
  return 'AND COALESCE(t.deprecated, 0) = 0'
}

function classify(query, normalized, row, alias) {
  const name = String(row.name ?? '')
  const zh = String(row.zh_name ?? '')
  if (alias) {
    if (alias === query || alias === normalized) return { match: SEARCH_MATCH.ALIAS, field: 'alias', score: SEARCH_SCORE.exact_alias, text: alias }
    if (alias.startsWith(normalized)) return { match: SEARCH_MATCH.PREFIX, field: 'alias', score: SEARCH_SCORE.prefix_alias, text: alias }
    return { match: SEARCH_MATCH.CONTAINS, field: 'alias', score: SEARCH_SCORE.contains_alias, text: alias }
  }
  if (name === normalized) return { match: SEARCH_MATCH.EXACT, field: 'name', score: SEARCH_SCORE.exact_name, text: name }
  if (zh !== '' && zh === query) return { match: SEARCH_MATCH.EXACT, field: 'zh_name', score: SEARCH_SCORE.exact_zh, text: zh }
  if (name.startsWith(normalized)) return { match: SEARCH_MATCH.PREFIX, field: 'name', score: SEARCH_SCORE.prefix_name, text: name }
  if (zh !== '' && zh.startsWith(query)) return { match: SEARCH_MATCH.PREFIX, field: 'zh_name', score: SEARCH_SCORE.prefix_zh, text: zh }
  if (name.includes(normalized)) return { match: SEARCH_MATCH.CONTAINS, field: 'name', score: SEARCH_SCORE.contains_name, text: name }
  if (zh !== '' && zh.includes(query)) return { match: SEARCH_MATCH.CONTAINS, field: 'zh_name', score: SEARCH_SCORE.contains_zh, text: zh }
  return { match: SEARCH_MATCH.CONTAINS, field: 'name', score: SEARCH_SCORE.contains_name, text: name }
}

function searchGroup(handle, { query, normalized, sourceIds, kind, deprecatedMode, translationStatus, studioCategory, limit }) {
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) return []
  const like = `%${escapeLike(query)}%`
  const placeholders = sourceIds.map(() => '?').join(',')
  const dep = deprecatedClause(deprecatedMode)

  const extra = []
  const extraParams = []
  const statuses = Array.isArray(translationStatus) ? translationStatus : translationStatus ? [translationStatus] : []
  if (statuses.length > 0) {
    extra.push(`AND t.translation_status IN (${statuses.map(() => '?').join(',')})`)
    extraParams.push(...statuses.map((item) => String(item)))
  }
  if (studioCategory && studioCategory.studioIds?.length > 0) {
    const catSources = studioCategory.sourceIds ?? []
    if (catSources.length > 0) {
      extra.push(
        `AND t.name IN (SELECT tag_name FROM studio_category_tags
                          WHERE source_id IN (${catSources.map(() => '?').join(',')})
                            AND studio_id IN (${studioCategory.studioIds.map(() => '?').join(',')}))`,
      )
      extraParams.push(...catSources.map((item) => String(item)), ...studioCategory.studioIds.map((item) => String(item)))
    }
  }
  const extraSql = extra.join('\n        ')

  const rows = handle.all(
    `SELECT * FROM tags t
      WHERE t.source_id IN (${placeholders})
        ${dep}
        ${extraSql}
        AND (t.name LIKE ? ESCAPE '\\' OR COALESCE(t.zh_name, '') LIKE ? ESCAPE '\\')
      ORDER BY t.post_count DESC NULLS LAST
      LIMIT ?`,
    ...sourceIds,
    ...extraParams,
    like,
    like,
    limit * 4,
  )

  const aliasRows = handle.all(
    `SELECT a.alias AS alias, t.* FROM tag_aliases a
       JOIN tags t ON t.id = a.tag_id
      WHERE a.source_id IN (${placeholders})
        ${dep}
        ${extraSql}
        AND a.alias LIKE ? ESCAPE '\\'
      ORDER BY t.post_count DESC NULLS LAST
      LIMIT ?`,
    ...sourceIds,
    ...extraParams,
    like,
    limit * 4,
  )

  const byId = new Map()
  for (const row of rows) {
    const hit = classify(query, normalized, row, null)
    byId.set(Number(row.id), { row, hit, alias: null })
  }
  for (const row of aliasRows) {
    const alias = String(row.alias ?? '')
    const hit = classify(query, normalized, row, alias)
    const id = Number(row.id)
    const existing = byId.get(id)
    if (existing && existing.hit.score >= hit.score) continue
    byId.set(id, { row, hit, alias })
  }

  const decorated = decorateTags(handle, [...byId.values()].map((entry) => entry.row))
  const decoratedById = new Map(decorated.map((tag) => [Number(tag.id), tag]))

  const out = []
  for (const entry of byId.values()) {
    const tag = decoratedById.get(Number(entry.row.id))
    if (!tag) continue
    out.push({
      tag,
      source: kind,
      match: entry.hit.match,
      matched_field: entry.hit.field,
      matched_text: entry.hit.text,
      score: entry.hit.score,
    })
  }
  return out
}

/**
 * 给结果补三样东西：别名、模型词表重叠、工作室分类。
 *
 * 重叠不是"这条能不能用"，而是"模型词表里有没有同名同拼写的词"——
 * 有，说明这条是模型认识的词；没有，说明它只是词典里的解释性条目。
 */
function decorateResults(handle, results, { modelSourceIds, studioSourceIds }) {
  if (results.length === 0) return results
  const ids = [...new Set(results.map((entry) => Number(entry.tag.id)).filter(Number.isFinite))]
  const names = [...new Set(results.map((entry) => String(entry.tag.name)))]
  const idMarks = ids.map(() => '?').join(',')
  const nameMarks = names.map(() => '?').join(',')

  const aliasById = new Map()
  if (ids.length > 0) {
    for (const row of handle.all(
      `SELECT tag_id, alias FROM tag_aliases WHERE tag_id IN (${idMarks}) ORDER BY alias ASC`,
      ...ids,
    )) {
      const key = Number(row.tag_id)
      if (!aliasById.has(key)) aliasById.set(key, [])
      aliasById.get(key).push(String(row.alias))
    }
  }

  const overlapByName = new Map()
  if (modelSourceIds.length > 0 && names.length > 0) {
    for (const row of handle.all(
      `SELECT name, source_id FROM tags
        WHERE name IN (${nameMarks})
          AND source_id IN (${modelSourceIds.map(() => '?').join(',')})`,
      ...names,
      ...modelSourceIds,
    )) {
      const key = String(row.name)
      if (!overlapByName.has(key)) overlapByName.set(key, [])
      overlapByName.get(key).push(String(row.source_id))
    }
  }

  const categoryByName = new Map()
  if (studioSourceIds.length > 0 && names.length > 0) {
    for (const row of handle.all(
      `SELECT l.tag_name AS tag_name, l.studio_id AS studio_id, c.name AS name, c.depth AS depth
         FROM studio_category_tags l
         LEFT JOIN studio_categories c ON c.source_id = l.source_id AND c.studio_id = l.studio_id
        WHERE l.source_id IN (${studioSourceIds.map(() => '?').join(',')})
          AND l.tag_name IN (${nameMarks})
        ORDER BY c.depth ASC, c.name ASC`,
      ...studioSourceIds,
      ...names,
    )) {
      const key = String(row.tag_name)
      if (!categoryByName.has(key)) categoryByName.set(key, [])
      categoryByName.get(key).push({
        studio_id: String(row.studio_id),
        name: row.name === null || row.name === undefined ? null : String(row.name),
        depth: row.depth === null || row.depth === undefined ? null : Number(row.depth),
      })
    }
  }

  return results.map((entry) => {
    const name = String(entry.tag.name)
    const sources = overlapByName.get(name) ?? []
    return {
      ...entry,
      tag: {
        ...entry.tag,
        aliases: aliasById.get(Number(entry.tag.id)) ?? [],
        model_overlap: sources.length > 0,
        model_sources: sources,
        studio_categories: categoryByName.get(name) ?? [],
      },
    }
  })
}

/**
 * 补充词典内部去重：同一个词只在一条补充源里留一条。
 *
 * 随包中文对照表（studio-zh）与用户导入的工作室词库（studio-tags）会有
 * 两万多条同名条目。它们回答的是同一个问题——"这个词怎么解释"——所以
 * 重复出现只是噪音。保留配置里靠前的那个源：默认配置把导入源排在随包表
 * 前面，导入过就以导入的为准，没导入就只剩随包表。
 *
 * 模型词表那一侧不参与去重：模型词表命中与补充词典命中回答的是不同问题
 * （"模型认不认"与"工作室怎么解释"），两条都要留着。
 */
function dedupeSupplement(results, studioSourceIds) {
  const priority = new Map(studioSourceIds.map((id, index) => [String(id), index]))
  const rankOf = (entry) => priority.get(String(entry.tag.source_id)) ?? Number.MAX_SAFE_INTEGER
  const slots = new Map()
  const out = []
  for (const entry of results) {
    if (entry.source !== 'studio') {
      out.push(entry)
      continue
    }
    const key = String(entry.tag.name)
    const slot = slots.get(key)
    if (slot === undefined) {
      slots.set(key, out.length)
      out.push(entry)
      continue
    }
    if (rankOf(entry) < rankOf(out[slot])) out[slot] = entry
  }
  return out
}

/**
 * 在模型词表与补充词典里同时检索。
 *
 * 同一标签在两种源里各有一条时都保留：它们回答的是不同问题
 * （"模型认不认"与"工作室怎么解释"），合并成一条会把这个区别吃掉。
 */
export function searchKnowledge(
  handle,
  {
    query = '',
    limit = 10,
    modelSourceIds = [],
    studioSourceIds = [],
    includeDeprecated = false,
    deprecated = null,
    translationStatus = null,
    studioCategory = null,
  } = {},
) {
  const text = String(query ?? '').trim()
  const capped = Math.min(MAX_SEARCH_LIMIT, Math.max(1, Number(limit) || 10))
  const deprecatedMode = deprecated ?? (includeDeprecated ? SEARCH_DEPRECATED.INCLUDE : SEARCH_DEPRECATED.EXCLUDE)
  if (text === '') return { query: text, normalized: '', results: [], total: 0, truncated: false, error: SEARCH_CODES.EMPTY_QUERY }
  if (!handle || typeof handle.all !== 'function') {
    return { query: text, normalized: '', results: [], total: 0, truncated: false, error: SEARCH_CODES.NO_SOURCES }
  }
  if (modelSourceIds.length === 0 && studioSourceIds.length === 0) {
    return { query: text, normalized: '', results: [], total: 0, truncated: false, error: SEARCH_CODES.NO_SOURCES }
  }

  const normalized = normalizeTagName(text)
  const groupArgs = { query: text, normalized, deprecatedMode, translationStatus, studioCategory, limit: capped }
  let results = []
  try {
    results = [
      ...searchGroup(handle, { ...groupArgs, sourceIds: modelSourceIds, kind: 'model' }),
      ...searchGroup(handle, { ...groupArgs, sourceIds: studioSourceIds, kind: 'studio' }),
    ]
  } catch (error) {
    return {
      query: text,
      normalized,
      results: [],
      total: 0,
      truncated: false,
      error: SEARCH_CODES.QUERY_FAILED,
      error_detail: error?.message ?? String(error),
    }
  }

  results.sort(
    (a, b) => b.score - a.score || Number(b.tag.post_count ?? 0) - Number(a.tag.post_count ?? 0) || String(a.tag.name).localeCompare(String(b.tag.name)),
  )
  const total = dedupeSupplement(results, studioSourceIds).length
  const page = decorateResults(handle, dedupeSupplement(results, studioSourceIds).slice(0, capped), { modelSourceIds, studioSourceIds })
  return { query: text, normalized, results: page, total, truncated: total > capped, error: null, deprecated: deprecatedMode }
}
