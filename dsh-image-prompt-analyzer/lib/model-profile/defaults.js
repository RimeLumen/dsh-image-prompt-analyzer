
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

// 默认只把「明显不是全年龄」的评级写进正稿。safe / sensitive 不写：
// 它们既不改变画面，又会占掉一个靠前的槽位，实测会压低出图质量。
export const DEFAULT_RATING_EMIT = Object.freeze(['sensitive', 'nsfw', 'explicit'])

export const DEFAULT_TAG_STANDARD = Object.freeze({
  // 默认用空格而不是下划线：CLIP 分词器把下划线当独立符号，`long_hair` 切出 3 个 token，
  // `long hair` 只切 2 个。标签型底模的 75 token 窗口本来就紧，下划线是纯浪费。
  // 词表里带下划线的写法照样查得到——查表前会归一化。
  word_style: 'spaced',
  slot_order: Object.freeze([]),
  slot_order_presets: Object.freeze([]),
  default_slot_order_preset: null,
  quality_block: Object.freeze([]),
  score_block: Object.freeze({ mode: 'none', terms: Object.freeze([]) }),
  rating_vocab: DEFAULT_RATING_VOCAB,
  // null = 不写默认评级；只在观察里确实出现 nsfw / explicit 时才补。
  rating_default: null,
  rating_emit: DEFAULT_RATING_EMIT,
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
