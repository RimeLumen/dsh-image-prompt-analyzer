
import { collectFeatures, defaultImportanceForCategory } from '../ir/index.js'
import { CATEGORY_IDS, layerOf } from '../config/index.js'
import { normalizeTagName, SCORE_TAG_PATTERN } from '../kb/index.js'

export const TERM_ORIGINS = Object.freeze({ FEATURE: 'feature', ENTITY: 'entity' })

export const MAX_TAG_WORDS = 6

const SENTENCE_PUNCTUATION = /[.!?;:。！？；：]/

export function looksLikeTag(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return true
  if (typeof value === 'boolean') return false
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (text.length === 0 || text.length > 80) return false
  if (SENTENCE_PUNCTUATION.test(text)) return false
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length > MAX_TAG_WORDS) return false
  return true
}

export function toDescriptionText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value
      .map((item) => toDescriptionText(item))
      .filter((item) => item.length > 0)
      .join(' / ')
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function makeTerm(input = {}) {
  const category = CATEGORY_IDS.has(input.category) ? input.category : 'unsorted'
  return {
    text: input.text ?? '',
    raw_value: input.raw_value ?? null,
    category,
    layer: layerOf(category),
    key: input.key ?? null,
    origin: input.origin ?? TERM_ORIGINS.FEATURE,
    entity_id: input.entity_id ?? null,
    source: input.source ?? 'global_analysis',
    confidence: typeof input.confidence === 'number' ? input.confidence : null,
    importance:
      typeof input.importance === 'number' ? input.importance : defaultImportanceForCategory(category),
    status: input.status ?? 'tentative',
    region: Array.isArray(input.region) ? input.region : null,
    description: input.description ?? null,
    kb: null,
    display: null,
    weight: null,
    notes: [],
  }
}

export function collectTerms(ir, { priorityOverrides = {} } = {}) {
  const terms = []
  const skipped = []

  const importanceFor = (category, given) => {
    if (typeof given === 'number') return given
    if (typeof priorityOverrides?.[category] === 'number') return priorityOverrides[category]
    return defaultImportanceForCategory(category)
  }

  const featureFields = (feature, category, key) => ({
    category,
    key,
    origin: TERM_ORIGINS.FEATURE,
    entity_id: feature?.entity_id ?? null,
    source: feature?.source,
    confidence: feature?.confidence,
    importance: importanceFor(category, feature?.importance),
    status: feature?.status,
    region: feature?.region,
  })

  const entityFields = (entity, category) => ({
    category,
    key: 'entity_label',
    origin: TERM_ORIGINS.ENTITY,
    entity_id: entity?.entity_id ?? null,
    source: 'global_analysis',
    confidence: entity?.confidence,
    importance: importanceFor(category, entity?.importance),
    region: entity?.region,
  })

  for (const feature of collectFeatures(ir)) {
    const category = CATEGORY_IDS.has(feature?.category) ? feature.category : 'unsorted'
    const value = feature?.value
    const key = typeof feature?.key === 'string' ? feature.key : null

    if (typeof value === 'boolean') {
      skipped.push({ reason: 'non_text_value', category, key })
      continue
    }

    if (!looksLikeTag(value)) {
      const text = toDescriptionText(value)
      if (text.length === 0) {
        skipped.push({ reason: 'empty_value', category, key })
        continue
      }
      terms.push(
        makeTerm({
          text: '',
          raw_value: value,
          description: text,
          ...featureFields(feature, category, key),
        }),
      )
      continue
    }

    const text = normalizeTagName(value)
    if (text.length === 0) {
      skipped.push({ reason: 'empty_after_normalize', category, key })
      continue
    }
    terms.push(
      makeTerm({
        text,
        raw_value: value,
        ...featureFields(feature, category, key),
      }),
    )
  }

  for (const entity of Array.isArray(ir?.entities) ? ir.entities : []) {
    const label = typeof entity?.label === 'string' ? entity.label.trim() : ''
    if (label.length === 0) {
      skipped.push({ reason: 'entity_without_label', category: 'subject', entity_id: entity?.entity_id ?? null })
      continue
    }
    const category = ['person', 'animal', 'creature'].includes(entity?.kind) ? 'subject' : 'unsorted'
    if (!looksLikeTag(label)) {
      terms.push(
        makeTerm({
          text: '',
          raw_value: label,
          description: label,
          ...entityFields(entity, category),
        }),
      )
      continue
    }
    terms.push(
      makeTerm({
        text: normalizeTagName(label),
        raw_value: label,
        ...entityFields(entity, category),
      }),
    )
  }

  return { terms, skipped }
}

export function isScoreTag(text) {
  return SCORE_TAG_PATTERN.test(normalizeTagName(text))
}
