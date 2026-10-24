
import { isTagKind } from '../model-profile/schema.js'

const NATIVE_KIND_MAP = Object.freeze({
  0: 'general',
  1: 'artist',
  3: 'copyright',
  4: 'character',
  5: 'meta',
})

const NATIVE_CATEGORY_KIND = Object.freeze({
  general: 'general',
  artist: 'artist',
  copyright: 'copyright',
  character: 'character',
  meta: 'meta',
})

export const KIND_RULES = Object.freeze([
  { kind: 'score', pattern: /^score_\d+(_up)?$/ },
  { kind: 'score', pattern: /^(high|great|good|average|bad|low) score$/ },
  { kind: 'quality', pattern: /^(masterpiece|best quality|good quality|average quality|bad quality|worst quality|amazing quality|normal quality|low quality)$/ },
  { kind: 'aesthetic', pattern: /(^|\s)aesthetic$|^very awa$/ },
  { kind: 'rating', pattern: /^rating_[a-z]+$/ },
  { kind: 'rating', pattern: /^(safe|sensitive|questionable|nsfw|explicit|general)$/ },
  { kind: 'year', pattern: /^year \d{4}$/ },
  { kind: 'year', pattern: /^(newest|recent|modern|early|mid|old|oldest)$/ },
  { kind: 'source', pattern: /^source_[a-z]+$/ },
  { kind: 'meta', pattern: /^(absurdres|highres|lowres|high resolution|low resolution|jpeg artifacts)$/ },
  { kind: 'character', pattern: /^[^()]+\([^()]+\)$/ },
  { kind: 'artist', pattern: /^artist:/ },
])

const KIND_INTERNAL_CATEGORY = Object.freeze({
  general: null,
  character: 'character',
  copyright: 'copyright',
  artist: 'artist',
  meta: 'quality_style',
  quality: 'quality_style',
  score: 'quality_style',
  rating: 'quality_style',
  year: 'quality_style',
  aesthetic: 'quality_style',
  source: 'quality_style',
  unknown: null,
})

export function inferTagKind(row) {
  const native = normalizeNativeCategory(row?.native_category)
  if (native && NATIVE_CATEGORY_KIND[native] && native !== 'general') {
    return NATIVE_CATEGORY_KIND[native]
  }

  const text = String(row?.tag ?? '').trim().toLowerCase()
  if (!text) return native === 'general' ? 'general' : 'unknown'
  for (const rule of KIND_RULES) {
    if (rule.pattern.test(text)) return rule.kind
  }
  return 'general'
}

export function internalCategoryForKind(kind, { subcategory = null } = {}) {
  if (!isTagKind(kind)) return null
  if (kind === 'general') {
    const text = typeof subcategory === 'string' ? subcategory.trim().toLowerCase() : ''
    return text ? SUB_CATEGORY_CATEGORY[text] ?? null : null
  }
  return KIND_INTERNAL_CATEGORY[kind] ?? null
}

const SUB_CATEGORY_CATEGORY = Object.freeze({
  人物: 'subject',
  数量: 'subject',
  画质: 'quality_style',
  表情: 'expression',
  服装: 'clothing',
  背景: 'background',
  姿势: 'pose_action',
  动作: 'pose_action',
  构图: 'composition',
  镜头: 'camera',
  光影: 'lighting_color',
  颜色: 'lighting_color',
  画师: 'artist',
  作品: 'copyright',
  角色: 'character',
})

export function normalizeNativeCategory(value) {
  if (value === null || value === undefined) return null
  const text = String(value).trim().toLowerCase()
  if (!text) return null
  if (/^\d+$/.test(text)) return NATIVE_KIND_MAP[Number(text)] ?? null
  return NATIVE_CATEGORY_KIND[text] ? text : null
}
