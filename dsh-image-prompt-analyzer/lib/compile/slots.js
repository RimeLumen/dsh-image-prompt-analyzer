
import { SEVERITY, diagnostic } from '../diagnostics.js'
import { normalizeTagName } from '../kb/index.js'

export const SLOT_CODES = Object.freeze({
  UNMAPPED: 'COMPILE_SLOT_UNMAPPED',
  FORBIDDEN_DROPPED: 'COMPILE_FORBIDDEN_DROPPED',
})

const COUNT_PATTERN = /^(?:\d+\+?(?:girl|boy|other)s?|solo|no_humans)$/

const FIXED_BLOCK_FIELDS = Object.freeze([
  ['quality', 'quality_block'],
  ['score', 'score_block'],
  ['year', 'year_block'],
  ['aesthetic', 'aesthetic_block'],
  ['source', 'source_block'],
  ['meta', 'meta_block'],
])

function termKey(text) {
  return normalizeTagName(text).replace(/ /g, '_')
}

function fixedBlockTerms(tagStandard, field) {
  const value = tagStandard?.[field]
  if (Array.isArray(value)) return value
  if (value && Array.isArray(value.terms)) return value.terms
  return []
}

function blockTerms(texts, category) {
  return texts
    .filter((text) => typeof text === 'string' && text.trim().length > 0)
    .map((text) => makeFixedTerm(text, category))
}

function makeFixedTerm(text, category) {
  return {
    text: String(text).trim().toLowerCase(),
    raw_value: text,
    category,
    layer: 0,
    key: null,
    origin: 'profile',
    entity_id: null,
    source: 'profile',
    confidence: null,
    importance: null,
    status: 'confirmed',
    region: null,
    description: null,
    kb: null,
    display: null,
    weight: null,
    notes: [],
  }
}

export function effectiveSlotOrder(profile) {
  const tagStandard = profile?.tag_standard ?? {}
  const presetId = tagStandard.default_slot_order_preset
  if (typeof presetId === 'string' && presetId.length > 0) {
    const presets = Array.isArray(tagStandard.slot_order_presets) ? tagStandard.slot_order_presets : []
    const preset = presets.find((item) => item?.id === presetId)
    if (preset && Array.isArray(preset.order)) return [...preset.order]
  }
  return Array.isArray(tagStandard.slot_order) ? [...tagStandard.slot_order] : []
}

function slotOf(term) {
  const text = termKey(term?.text ?? '')
  if (COUNT_PATTERN.test(text)) return 'count'
  if (term?.category === 'character') return 'character'
  if (term?.category === 'copyright') return 'series'
  if (term?.category === 'artist') return 'artist'
  return null
}

export function assignSlots(terms, profile) {
  const tagStandard = profile?.tag_standard ?? {}
  const order = effectiveSlotOrder(profile)
  const orderSet = new Set(order)
  const diagnostics = []
  const dropped = []

  const slots = new Map()
  const push = (slot, term) => {
    if (!slots.has(slot)) slots.set(slot, [])
    slots.get(slot).push(term)
  }
  const pushMany = (slot, items) => {
    for (const item of items) if (item.text.length > 0) push(slot, item)
  }

  for (const [slot, field] of FIXED_BLOCK_FIELDS) {
    pushMany(slot, blockTerms(fixedBlockTerms(tagStandard, field), 'quality_style'))
  }
  for (const item of slots.get('score') ?? []) item.category = 'score'

  const ratingVocab = tagStandard.rating_vocab ?? {}
  const ratingKeys = new Set(Object.keys(ratingVocab).map((key) => termKey(key)))
  const ratingObservation = (Array.isArray(terms) ? terms : []).find(
    (term) =>
      term &&
      typeof term.text === 'string' &&
      term.text.length > 0 &&
      !term.description &&
      (term.category === 'quality_style' || term.category === 'rating' || term.category == null) &&
      ratingKeys.has(termKey(term.text)),
  )
  const ratingSource = ratingObservation ? ratingObservation.text : tagStandard.rating_default
  if (typeof ratingSource === 'string' && ratingSource.length > 0) {
    const vocabKey = ratingVocab[ratingSource] ?? ratingVocab[termKey(ratingSource)]
    const mapped = typeof vocabKey === 'string' ? vocabKey : ratingSource
    push('rating', makeFixedTerm(mapped, 'quality_style'))
  }

  const fixedTexts = new Map()
  for (const [slot, items] of slots) {
    for (const item of items) fixedTexts.set(termKey(item.text), slot)
  }
  const forbidden = new Set((tagStandard.forbidden_tags ?? []).map((text) => termKey(String(text))))

  const seen = new Map()
  for (const term of Array.isArray(terms) ? terms : []) {
    if (!term || typeof term.text !== 'string' || term.text.length === 0) continue
    if (term.description) continue
    const key = termKey(term.text)

    if (forbidden.has(key)) {
      dropped.push({ term, reason: 'forbidden' })
      diagnostics.push(
        diagnostic({
          error_code: SLOT_CODES.FORBIDDEN_DROPPED,
          severity: SEVERITY.INFO,
          message: `档案禁止出现标签「${term.text}」，已从编译结果里删掉。`,
          suggested_fix: '如果这个标签确实必要，换一个档案或删掉该档案的 forbidden_tags 条目。',
        }),
      )
      continue
    }
    if (/^score_\d/.test(key) || term.category === 'score') {
      dropped.push({ term, reason: 'duplicate' })
      continue
    }
    if (ratingKeys.has(key)) {
      dropped.push({ term, reason: 'duplicate' })
      continue
    }
    if (fixedTexts.has(key)) {
      dropped.push({ term, reason: 'duplicate' })
      continue
    }

    const previous = seen.get(key)
    if (previous) {
      if ((term.importance ?? 0) > (previous.importance ?? 0)) previous.importance = term.importance
      continue
    }
    seen.set(key, term)

    const slot = slotOf(term)
    if (slot) push(slot, term)
    else push('general', term)
  }

  for (const [slot, items] of [...slots]) {
    if (slot === 'general' || orderSet.has(slot)) continue
    for (const item of items) push('general', item)
    slots.delete(slot)
    diagnostics.push(
      diagnostic({
        error_code: SLOT_CODES.UNMAPPED,
        severity: SEVERITY.INFO,
        message: `档案「${profile?.config_id ?? '未知'}」没有 ${slot} 槽位，该槽词条并入 general。`,
        suggested_fix: `在 slot_order 里加上 ${slot}，或删掉这些词条。`,
      }),
    )
  }

  const generalOrder = Array.isArray(tagStandard.general_order) ? tagStandard.general_order : []
  const orderIndex = new Map(generalOrder.map((category, index) => [category, index]))
  const general = slots.get('general')
  if (general) {
    general.sort((a, b) => {
      const indexA = orderIndex.has(a.category) ? orderIndex.get(a.category) : generalOrder.length
      const indexB = orderIndex.has(b.category) ? orderIndex.get(b.category) : generalOrder.length
      if (indexA !== indexB) return indexA - indexB
      const importanceA = typeof a.importance === 'number' ? a.importance : -1
      const importanceB = typeof b.importance === 'number' ? b.importance : -1
      if (importanceA !== importanceB) return importanceB - importanceA
      const sourceA = String(a.source ?? '')
      const sourceB = String(b.source ?? '')
      if (sourceA !== sourceB) return sourceA < sourceB ? -1 : 1
      return String(a.text).localeCompare(String(b.text))
    })
  }

  const ordered = new Map()
  for (const slot of order) {
    if (slots.has(slot)) ordered.set(slot, slots.get(slot))
  }
  if (slots.has('general') && !ordered.has('general')) ordered.set('general', slots.get('general'))

  return { slots: ordered, dropped, diagnostics }
}
