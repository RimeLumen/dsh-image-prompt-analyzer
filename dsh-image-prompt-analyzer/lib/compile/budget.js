
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
      if (term.category === category && !neverTrim.has(key)) {
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
  if (total <= budget) return { slots: prune(current), dropped, truncated: 0, diagnostics }

  const trimOrder = Array.isArray(tagStandard?.trim_order) ? tagStandard.trim_order : []
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
    const kept = []
    for (let index = terms.length - 1; index >= 0; index -= 1) {
      const term = terms[index]
      const key = normalizeForCompare(term.text, wordStyle)
      if (total > budget && !neverTrim.has(key)) {
        dropped.push({ term, reason: 'budget' })
        total -= 1
      } else {
        kept.push(term)
      }
    }
    kept.reverse()
    current.set('general', kept)
  }

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

  return { slots: prune(current), dropped, truncated, diagnostics }
}
