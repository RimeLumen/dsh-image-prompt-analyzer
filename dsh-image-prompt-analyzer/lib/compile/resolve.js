
import { SEVERITY, diagnostic } from '../diagnostics.js'
import { layerOf } from '../config/index.js'
import { normalizeTagName } from '../kb/index.js'

export const RESOLVE_CODES = Object.freeze({
  NO_KNOWLEDGE_BASE: 'COMPILE_KNOWLEDGE_BASE_UNAVAILABLE',
  UNKNOWN_TAG: 'COMPILE_UNKNOWN_TAG',
  SOURCE_UNAVAILABLE: 'COMPILE_KNOWLEDGE_SOURCE_UNAVAILABLE',
  ALIAS_NORMALIZED: 'COMPILE_ALIAS_NORMALIZED',
})

function shouldDropUnknown(term, profile, kbStatus) {
  const mapping = profile?.tag_mapping ?? {}
  if (mapping.preserve_unknown_observations === false) return true
  if ((mapping.unknown_tag_policy ?? 'keep_as_description') !== 'drop') return false
  return kbStatus === 'miss' || kbStatus === 'skipped'
}

export async function resolveTerms(terms, { kb = null, profile = {}, signal = null } = {}) {
  const diagnostics = []
  const stats = {
    looked_up: 0,
    hits: 0,
    misses: 0,
    unavailable: 0,
    aliases_normalized: 0,
    categories_adopted: 0,
    dropped_unknown: 0,
    description_routed: 0,
  }

  const mapping = profile?.tag_mapping ?? {}
  const categoryOverrides = normalizeOverrides(mapping.category_overrides)
  const excluded = new Set(Array.isArray(mapping.excluded_categories) ? mapping.excluded_categories : [])
  const normalizeAliases = mapping.normalize_aliases !== false

  const lookupTargets = terms.filter((term) => term.text && !term.description)
  const byText = new Map()
  if (kb && lookupTargets.length > 0) {
    const task = kb.beginTask({ signal })
    const results = await task.lookupMany([...new Set(lookupTargets.map((term) => term.text))])
    for (const result of results) {
      if (!result?.normalized) continue
      byText.set(result.normalized, result)
      if (result.status === 'hit') stats.hits += 1
      else if (result.status === 'miss') stats.misses += 1
      else stats.unavailable += 1
    }
    stats.looked_up = results.length
    for (const item of task.diagnostics ?? []) diagnostics.push(item)
  } else if (lookupTargets.length > 0) {
    diagnostics.push(
      diagnostic({
        error_code: RESOLVE_CODES.NO_KNOWLEDGE_BASE,
        severity: SEVERITY.WARNING,
        message: '知识库不可用，本次分析没有做标签归一、别名转换与分类补全，标签按视觉模型给的原样保留。',
        suggested_fix: '用 diagnose_knowledge_base 检查数据库与数据源；离线标签索引可以用 scripts/import-tags.mjs 导入。',
      }),
    )
  }

  const kept = []
  for (const term of terms) {
    if (!term.text) {
      if (term.description) stats.description_routed += 1
      kept.push(term)
      continue
    }

    const result = byText.get(term.text) ?? null
    const kbStatus = kb ? (result?.status ?? 'skipped') : 'skipped'
    term.kb = result
      ? {
          status: result.status,
          source: result.source ?? null,
          tag_id: result.tag?.id ?? null,
          canonical_name: result.tag?.name ?? null,
          native_category: result.tag?.native_category ?? null,
          categories: Array.isArray(result.tag?.categories) ? result.tag.categories : [],
          via_alias: result.via_alias === true,
          stale: result.stale === true,
          reason: result.reason ?? null,
        }
      : { status: 'skipped', source: null, tag_id: null, canonical_name: null, native_category: null, categories: [], via_alias: false, stale: false, reason: kb ? null : 'no_knowledge_base' }

    if (kbStatus === 'hit' && normalizeAliases && term.kb.canonical_name && term.kb.canonical_name !== term.text) {
      term.notes.push(`别名归一：${term.text} → ${term.kb.canonical_name}`)
      term.text = term.kb.canonical_name
      stats.aliases_normalized += 1
      diagnostics.push(
        diagnostic({
          error_code: RESOLVE_CODES.ALIAS_NORMALIZED,
          severity: SEVERITY.INFO,
          message: `标签 ${result.query ?? ''} 已按知识库归一为 ${term.kb.canonical_name}。`,
        }),
      )
    }

    const adopted = adoptCategory(term, categoryOverrides)
    if (adopted) stats.categories_adopted += 1

    if (kbStatus !== 'hit') {
      term.unknown = true
      if (shouldDropUnknown(term, profile, kbStatus)) {
        term.dropped = 'unknown_tag'
        stats.dropped_unknown += 1
        kept.push(term)
        continue
      }
      if (kbStatus === 'miss' && (mapping.unknown_tag_policy ?? 'keep_as_description') === 'warn') {
        diagnostics.push(
          diagnostic({
            error_code: RESOLVE_CODES.UNKNOWN_TAG,
            severity: SEVERITY.WARNING,
            message: `知识库不认这个标签：${term.text}（分类 ${term.category}）。已保留原文，但它的写法与权重都没有依据。`,
            suggested_fix: '确认这是不是 Danbooru 上真实存在的标签；也可以把它加进本地标签索引。',
          }),
        )
      }
      if (kbStatus === 'unavailable') {
        diagnostics.push(
          diagnostic({
            error_code: RESOLVE_CODES.SOURCE_UNAVAILABLE,
            severity: SEVERITY.WARNING,
            message: `标签 ${term.text} 没能查到：数据源没有答上来（不是"不存在"）。已按原文保留。`,
            suggested_fix: '检查网络与数据源配置；离线标签索引不依赖网络。',
          }),
        )
      }
    } else {
      term.unknown = false
    }

    if (excluded.has(term.category)) {
      term.dropped = 'excluded_category'
    }

    kept.push(term)
  }

  return { terms: kept, diagnostics, stats }
}

function normalizeOverrides(overrides) {
  const out = new Map()
  if (!overrides || typeof overrides !== 'object') return out
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== 'string' || value.length === 0) continue
    out.set(normalizeTagName(key), value)
  }
  return out
}

function adoptCategory(term, overrides) {
  const override = overrides.get(term.text)
  if (override) {
    if (term.category !== override) {
      term.category = override
      term.layer = layerOf(override)
      term.notes.push(`分类被 profile 的 category_overrides 指定为 ${override}`)
      return true
    }
    return false
  }
  if (term.category === 'unsorted' && term.kb?.categories?.length > 0) {
    const found = term.kb.categories.find((id) => id && id !== 'unsorted')
    if (found) {
      term.category = found
      term.layer = layerOf(found)
      term.notes.push(`分类由知识库补全为 ${found}`)
      return true
    }
  }
  return false
}
