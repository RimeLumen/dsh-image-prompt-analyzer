
export const LOOKUP_STATUS = Object.freeze({
  HIT: 'hit',
  MISS: 'miss',
  // 没查：没有词库、本地数据源缺失、或读库失败。和 miss 分开，
  // 是因为 miss 的意思是"这个词表里没有"，not_queried 的意思是"我们没问过"。
  // 两者对提示词的后果一样（词条原样保留），但诊断上不能混为一谈。
  NOT_QUERIED: 'not_queried',
})

export const LOOKUP_MATCH = Object.freeze({
  CANONICAL: 'canonical',
  ALIAS: 'alias',
  NONE: 'none',
})

export const LOOKUP_SOURCE = Object.freeze({
  LOCAL: 'local',
  // 工作室补充词典。它和模型词表不是一回事：模型词表决定"这个词能不能进提示词"，
  // 补充词典只解释"这个词是什么意思、中文叫什么"。
  STUDIO: 'studio',
})

export const LOOKUP_MODES = Object.freeze({
  LOCAL_ONLY: 'local_only',
  LOCAL_WITH_STUDIO: 'local_with_studio',
})

export const LOOKUP_REASONS = Object.freeze({
  EMPTY_QUERY: 'empty_query',
  LOCAL_MISS: 'local_miss',
  LOOKUP_FAILED: 'lookup_failed',
  // 词库健康状态派生出来的"没查到"原因：查不到不等于词表没收录。
  KB_EMPTY: 'kb_empty',
  NO_LOCAL_SOURCES: 'no_local_sources',
  KB_UNAVAILABLE: 'kb_unavailable',
  STUDIO_FALLBACK: 'studio_fallback',
})

/**
 * 词库健康状态：一次分析开始时整体判一次，与单次查询结果分开。
 *
 * 这么分是因为"这个词表里没有"（正常 miss）和"词库是空的/没配/读不了"
 * 在旧实现里都是同一个 miss，报告里就会被读成"标签都无效"。
 */
export const KB_HEALTH = Object.freeze({
  AVAILABLE: 'available',
  UNAVAILABLE: 'unavailable',
  EMPTY: 'empty',
  SOURCE_MISSING: 'source_missing',
  LOOKUP_FAILED: 'lookup_failed',
})

export const KB_HEALTH_CODES = Object.freeze({
  UNAVAILABLE: 'KB_UNAVAILABLE',
  EMPTY: 'KB_EMPTY',
  SOURCE_MISSING: 'KB_SOURCE_MISSING',
  LOOKUP_FAILED: 'KB_HEALTH_CHECK_FAILED',
})

export function makeLookupResult(query, normalized, fields) {
  const result = {
    query,
    normalized,
    status: fields.status,
    source: fields.source ?? null,
    reason: fields.reason ?? null,
    tag: fields.tag ?? null,
    via_alias: fields.via_alias ?? false,
    match: fields.match ?? (fields.status === LOOKUP_STATUS.HIT ? (fields.via_alias ? LOOKUP_MATCH.ALIAS : LOOKUP_MATCH.CANONICAL) : LOOKUP_MATCH.NONE),
    // 命中来自哪一份数据源、靠哪条路命中。P0-4 要求每个命中都能答出这两个问题：
    // 同一个词在 illustrious-tags 和 studio 里都有时，报告必须能说清用的是哪一份。
    source_id: fields.tag?.source_id ?? null,
    fallback: fields.fallback === true,
  }
  if (fields.alias !== undefined) result.alias = fields.alias
  if (fields.detail !== undefined) result.detail = fields.detail
  if (fields.error_code !== undefined) result.error_code = fields.error_code
  return result
}
