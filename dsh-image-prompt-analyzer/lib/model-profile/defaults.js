
export const BASE_NEVER_TRIM_TAGS = Object.freeze([
  '1girl',
  '1boy',
  'solo',
  'sitting',
  'full body',
  'medium shot',
  'from above',
])

export const BASE_TRIM_ORDER = Object.freeze([
  'year',
  'aesthetic',
  'meta',
  'lighting_color',
  'background',
  'clothing',
  'expression',
  'pose_action',
  'appearance',
  'composition',
])

export const DEFAULT_BUDGET = Object.freeze({
  positive_terms: 60,
  negative_terms: 30,
  positive_tokens: null,
})

export const DEFAULT_RATING_VOCAB = Object.freeze({
  safe: 'safe',
  sensitive: 'sensitive',
  nsfw: 'nsfw',
  explicit: 'explicit',
})

export const DEFAULT_TAG_STANDARD = Object.freeze({
  word_style: 'underscored',
  slot_order: Object.freeze([]),
  slot_order_presets: Object.freeze([]),
  default_slot_order_preset: null,
  quality_block: Object.freeze([]),
  score_block: Object.freeze({ mode: 'none', terms: Object.freeze([]) }),
  rating_vocab: DEFAULT_RATING_VOCAB,
  rating_default: 'safe',
  year_block: Object.freeze([]),
  aesthetic_block: Object.freeze([]),
  source_block: Object.freeze([]),
  meta_block: Object.freeze([]),
  forbidden_tags: Object.freeze([]),
  negative: Object.freeze({ required: false, terms: Object.freeze([]), max_terms: 30, options: Object.freeze([]) }),
  budget: DEFAULT_BUDGET,
  trim_order: BASE_TRIM_ORDER,
  general_order: Object.freeze([]),
  character_format: '{name} ({series})',
  artist_format: '{name}',
  artist_prefix: '',
  tag_rewrites: Object.freeze([]),
  never_trim_tags: BASE_NEVER_TRIM_TAGS,
  source_confidence: null,
})

function mergeObject(base, override) {
  return { ...base, ...(override && typeof override === 'object' && !Array.isArray(override) ? override : {}) }
}

export function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') return raw
  const tagStandard = raw.tag_standard && typeof raw.tag_standard === 'object' ? raw.tag_standard : {}
  const merged = {
    ...DEFAULT_TAG_STANDARD,
    ...tagStandard,
    score_block: mergeObject(DEFAULT_TAG_STANDARD.score_block, tagStandard.score_block),
    rating_vocab: mergeObject(DEFAULT_RATING_VOCAB, tagStandard.rating_vocab),
    negative: mergeObject(DEFAULT_TAG_STANDARD.negative, tagStandard.negative),
    budget: mergeObject(DEFAULT_BUDGET, tagStandard.budget),
  }
  return { ...raw, tag_standard: merged }
}
