
import { SEVERITY, diagnostic } from '../diagnostics.js'
import { SLOT_NAMES } from '../model-profile/schema.js'

export const BUDGET_CODES = Object.freeze({
  TRUNCATED: 'COMPILE_BUDGET_TRUNCATED',
})

const PROTECTED_SLOTS = Object.freeze(['count', 'quality', 'score', 'rating', 'character', 'series'])

function normalizeForCompare(text, wordStyle) {
  const value = String(text ?? '').trim().toLowerCase()
  return wordStyle === 'spaced' ? value.replace(/_/g, ' ') : value.replace(/ /g, '_')
}

function prune(slots) {
  const out = new Map()
  for (const [slot, terms] of slots) {
    if (Array.isArray(terms) && terms.length > 0) out.set(slot, terms)
  }
  return out
}

function countTerms(slots) {
  let total = 0
  for (const terms of slots.values()) total += terms.length
  return total
}

export function applyBudget({ slots, profile, preset = {} }) {
  const tagStandard = profile?.tag_standard ?? {}
  const diagnostics = []
  const dropped = []

  const baseBudget = Number(tagStandard?.budget?.positive_terms)
  const scale = Number(preset?.budget_scale)
  const budget = Number.isFinite(baseBudget) && baseBudget > 0
    ? Math.max(1, Math.round(baseBudget * (Number.isFinite(scale) && scale > 0 ? scale : 1)))
    : Number.POSITIVE_INFINITY

  const current = new Map()
  for (const [slot, terms] of slots ?? []) {
    if (Array.isArray(terms) && terms.length > 0) current.set(slot, [...terms])
  }

  const wordStyle = tagStandard?.word_style
  const neverTrim = new Set(
    (tagStandard?.never_trim_tags ?? []).map((text) => normalizeForCompare(text, wordStyle)),
  )
  const protectedSlots = new Set(PROTECTED_SLOTS)

  /**
   * 重要度加权：词条排得再对，模型也只是"看见"它；加权重才是让它"优先执行"。
   * 只加权最关键的少数几条（默认重要度 0.9 以上、最多 4 条），
   * 加多了等于全都没加权，权重语法本身也占预算。
   */
  const applyWeights = (target) => {
    const weighting = tagStandard?.weighting ?? {}
    if (weighting?.enabled !== true) return
    const minImportance = Number(weighting.min_importance ?? 0.9)
    const factor = Number(weighting.factor ?? 1.1)
    const maxBoosted = Number(weighting.max_boosted ?? 4)
    if (!Number.isFinite(factor) || factor <= 1) return
    if (!Number.isFinite(maxBoosted) || maxBoosted <= 0) return
    const boost = Number(factor.toFixed(2))
    const picked = [...target.values()]
      .flat()
      .filter((term) => term?.source !== 'profile' && term?.source !== 'user' && (term?.importance ?? 0) >= minImportance)
      .sort((a, b) => (b?.importance ?? 0) - (a?.importance ?? 0))
      .slice(0, Math.floor(maxBoosted))
    for (const term of picked) term.weight = boost
  }

  const finish = (truncated) => {
    const finalSlots = prune(current)
    applyWeights(finalSlots)
    return { slots: finalSlots, dropped, truncated, diagnostics }
  }

  const takeSlot = (slot) => {
    const terms = current.get(slot)
    if (!terms) return 0
    current.delete(slot)
    for (const term of terms) dropped.push({ term, reason: 'budget' })
    return terms.length
  }

  const takeCategory = (category) => {
    const terms = current.get('general')
    if (!terms) return 0
    const kept = []
    let removed = 0
    for (const term of terms) {
      const key = normalizeForCompare(term.text, wordStyle)
      if (term.category === category && !neverTrim.has(key) && !isProtected(term)) {
        dropped.push({ term, reason: 'budget' })
        removed += 1
      } else {
        kept.push(term)
      }
    }
    current.set('general', kept)
    return removed
  }

  let total = countTerms(current)
  if (total <= budget) return finish(0)

  // 第一轮：按重要度从低到高丢 general 槽里的词条。
  // 以前的顺序是先按 trim_order 整类砍（lighting_color 排第一），结果是
  // "光影""构图"这些最影响像不像的观察第一批被删，还原分直接掉到 26%。
  // 现在只要重要度低于 protect_importance 就先走，高重要度观察留到最后。
  const protectImportance = Number(tagStandard?.budget?.protect_importance ?? 0.7)
  const generalSlot = current.get('general')
  if (Array.isArray(generalSlot) && generalSlot.length > 0) {
    const removable = generalSlot
      .filter((term) => (term?.importance ?? 0) < protectImportance)
      .sort((a, b) => (a?.importance ?? 0) - (b?.importance ?? 0))
    const removedTerms = new Set()
    for (const term of removable) {
      if (total <= budget) break
      const key = normalizeForCompare(term?.text, wordStyle)
      if (neverTrim.has(key)) continue
      removedTerms.add(term)
      dropped.push({ term, reason: 'importance' })
      total -= 1
    }
    if (removedTerms.size > 0) {
      current.set('general', generalSlot.filter((term) => !removedTerms.has(term)))
    }
  }
  if (total <= budget) return finish(dropped.length)

  const trimOrder = Array.isArray(tagStandard?.trim_order) ? tagStandard.trim_order : []
  // 保护高重要度：宁可超出预算到 1.25 倍，也不把它们整类砍掉。
  const hardCeiling = Number.isFinite(budget) ? Math.round(budget * 1.25) : Number.POSITIVE_INFINITY
  const isProtected = (term) => (term?.importance ?? 0) >= protectImportance && total <= hardCeiling
  for (const entry of trimOrder) {
    if (total <= budget) break
    if (typeof entry !== 'string') continue
    if (SLOT_NAMES.includes(entry) && entry !== 'general') {
      if (protectedSlots.has(entry)) continue
      const removed = takeSlot(entry)
      if (removed > 0) {
        total -= removed
        continue
      }
    }
    const removed = takeCategory(entry)
    if (removed > 0) total -= removed
  }

  if (total > budget) {
    const terms = current.get('general') ?? []
    // 最后一道裁剪也按重要度来：先删最不重要的，别删到画面里最显眼的东西。
    const order = terms
      .map((term, index) => ({ term, index }))
      .sort((a, b) => (a.term?.importance ?? 0) - (b.term?.importance ?? 0))
    const removed = new Set()
    for (const { term } of order) {
      if (total <= budget) break
      const key = normalizeForCompare(term.text, wordStyle)
      if (neverTrim.has(key) || isProtected(term)) continue
      removed.add(term)
      dropped.push({ term, reason: 'budget' })
      total -= 1
    }
    if (removed.size > 0) current.set('general', terms.filter((term) => !removed.has(term)))
  }

  const finalSlots = prune(current)

  const truncated = dropped.length
  if (truncated > 0) {
    diagnostics.push(
      diagnostic({
        error_code: BUDGET_CODES.TRUNCATED,
        severity: SEVERITY.WARNING,
        message: `正向上限 ${budget} 个词条，按 trim_order 删掉 ${truncated} 个。`,
        suggested_fix: '改用 detail-minimal，或调大该档案的 budget.positive_terms / 该细节档的 budget_scale。',
      }),
    )
  }

  return finish(truncated)
}
