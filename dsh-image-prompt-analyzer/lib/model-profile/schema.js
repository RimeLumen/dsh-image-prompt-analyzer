
import { CATEGORY_IDS, INTERNAL_CATEGORIES } from '../config/categories.js'

export const MODEL_PROFILE_SCHEMA_VERSION = '2.0'

export const SLOT_NAMES = Object.freeze([
  'count',
  'character',
  'series',
  'rating',
  'general',
  'artist',
  'quality',
  'score',
  'year',
  'aesthetic',
  'source',
  'meta',
])

export const TAG_KINDS = Object.freeze([
  'count',
  'character',
  'copyright',
  'rating',
  'general',
  'artist',
  'quality',
  'score',
  'year',
  'aesthetic',
  'source',
  'meta',
  'unknown',
])

export const SLOT_TO_KIND = Object.freeze({
  count: 'count',
  character: 'character',
  series: 'copyright',
  rating: 'rating',
  general: 'general',
  artist: 'artist',
  quality: 'quality',
  score: 'score',
  year: 'year',
  aesthetic: 'aesthetic',
  source: 'source',
  meta: 'meta',
})

export const WORD_STYLES = Object.freeze(['underscored', 'spaced'])

export const CONFIDENCE_LEVELS = Object.freeze(['A', 'B', 'C'])

export const GENERAL_CATEGORY_IDS = Object.freeze(
  INTERNAL_CATEGORIES.filter((c) => CATEGORY_IDS.has(c.category_id))
    .map((c) => c.category_id)
    .filter((id) => id !== 'suppression' && id !== 'control' && id !== 'unsorted'),
)

const SLOT_SET = new Set(SLOT_NAMES)
const KIND_SET = new Set(TAG_KINDS)

export function isSlotName(value) {
  return typeof value === 'string' && SLOT_SET.has(value)
}

export function isTagKind(value) {
  return typeof value === 'string' && KIND_SET.has(value)
}
