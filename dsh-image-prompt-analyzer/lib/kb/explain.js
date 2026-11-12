import { findAlias, findTag, findTagByZh } from './store.js'
import { normalizeTagName } from './normalize.js'

/**
 * 标签解释：回答"这个词是什么"。
 *
 * 与编译链路的区别是这里**不判定**：模型词表与补充词典各查一遍，各给各的答案。
 * 同一个词在两边都存在时也分开列——"模型认不认"与"工作室怎么解释"是两个问题，
 * 合成一条会把区别吃掉，而用户恰恰是来问这个区别的。
 *
 * 废弃词照样能解释（源库把废弃词留在表里就是为了让人看懂它），但会标 `deprecated`，
 * 并附一条说明：能解释，不能拿去改提示词。
 */
export const EXPLAIN_CODES = Object.freeze({
  EMPTY: 'KB_EXPLAIN_EMPTY_TERM',
  NO_SOURCES: 'KB_EXPLAIN_NO_SOURCES',
  MISS: 'KB_EXPLAIN_MISS',
  DEPRECATED_ONLY: 'KB_EXPLAIN_DEPRECATED_ONLY',
})

export const EXPLAIN_SOURCE = Object.freeze({ MODEL: 'model', STUDIO: 'studio' })

function aliasesForTag(handle, tagId) {
  if (!handle || typeof handle.all !== 'function') return []
  const rows = handle.all('SELECT alias, source_id FROM tag_aliases WHERE tag_id = ? ORDER BY alias', Number(tagId))
  return rows.map((row) => ({ alias: String(row.alias), source_id: String(row.source_id) }))
}

/** 只留解释用得上的字段：完整行里有 categories 这类给编译器用的结构，对话里用不到。 */
export function describeTag(tag, { aliases = [] } = {}) {
  if (!tag) return null
  return {
    name: tag.name,
    canonical_name: tag.canonical_name,
    zh_name: tag.zh_name,
    source_id: tag.source_id,
    native_category: tag.native_category,
    kind: tag.kind,
    post_count: tag.post_count,
    tag_group: tag.tag_group,
    translation_status: tag.translation_status,
    deprecated: Number(tag.deprecated ?? 0) === 1,
    categories: Array.isArray(tag.categories) ? tag.categories.map((entry) => entry.category) : [],
    aliases: aliases.map((entry) => entry.alias),
  }
}

/**
 * 三种命中方式，按"这个词到底指谁"的可信度排序：
 *
 * 1. `name` —— 英文标签名，唯一身份，最可信。
 * 2. `alias` —— 源库声明的别名，仍属于这条标签。
 * 3. `zh_name` —— 中文译名。它不是身份，只是译名，所以放在最后，
 *    而且只有在精确相等时才算——中文近义词太多，模糊匹配会把用户带偏。
 *
 * 命中 zh_name 时回报的仍是英文 `name`：用户拿中文来找词，
 * 要的是"这词进提示词该写什么"，不是"再确认一遍中文"。
 */
function lookupIn(handle, sourceIds, normalized, raw) {
  const tag = findTag(handle, normalized, { sourceIds })
  if (tag) return { tag, via: 'name', alias: null }
  const alias = findAlias(handle, normalized, { sourceIds })
  if (alias?.tag) return { tag: alias.tag, via: 'alias', alias: alias.alias }
  const byZh = findTagByZh(handle, raw, { sourceIds })
  if (byZh) return { tag: byZh, via: 'zh_name', alias: null }
  return null
}

export function explainTerm(
  handle,
  term,
  { modelSourceIds = [], studioSourceIds = [] } = {},
) {
  const text = String(term ?? '').trim()
  const normalized = normalizeTagName(text)
  const base = { query: text, normalized, found: false, hits: [], codes: [], notes: [] }

  if (text === '') return { ...base, codes: [EXPLAIN_CODES.EMPTY] }
  if (!handle || typeof handle.get !== 'function') return { ...base, codes: [EXPLAIN_CODES.NO_SOURCES] }
  if (modelSourceIds.length === 0 && studioSourceIds.length === 0) {
    return { ...base, codes: [EXPLAIN_CODES.NO_SOURCES], notes: ['没有启用的数据源，本次不查词表。'] }
  }

  const groups = [
    { source: EXPLAIN_SOURCE.MODEL, ids: modelSourceIds },
    { source: EXPLAIN_SOURCE.STUDIO, ids: studioSourceIds },
  ]

  for (const group of groups) {
    if (!Array.isArray(group.ids) || group.ids.length === 0) continue
    const hit = lookupIn(handle, group.ids, normalized, text)
    if (!hit) continue
    base.hits.push({
      source: group.source,
      via: hit.via,
      alias: hit.alias,
      tag: describeTag(hit.tag, { aliases: aliasesForTag(handle, hit.tag.id) }),
    })
  }

  base.found = base.hits.length > 0
  if (!base.found) {
    base.codes.push(EXPLAIN_CODES.MISS)
    return base
  }

  const live = base.hits.filter((hit) => hit.tag.deprecated !== true)
  if (live.length === 0) {
    base.codes.push(EXPLAIN_CODES.DEPRECATED_ONLY)
    base.notes.push('这个词在源库里已标记废弃：可以解释，但不该再写进提示词。')
  }
  return base
}
