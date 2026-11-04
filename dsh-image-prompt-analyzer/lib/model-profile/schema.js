
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

/**
 * 词形约定。`prose` 不是“另一种分隔符”，而是“把标签串成自然语言”：
 * 走 lib/compile/compose.js 的成分句，给 Flux / MJ / GPT-Image 这类吃句子的模型用。
 * 标签型模型（Animagine / Illustrious 这类）用 spaced：CLIP 的分词器把下划线当独立符号，
 * `long_hair` 切出 3 个 token，`long hair` 只切 2 个，75 token 的窗口经不起这种浪费。
 * `underscored` 只为兼容旧档案保留，新档案不要再选。
 *
 * `hybrid` 保留只是兼容旧档案：插件现在同时输出「纯标签版 + 描述版」，
 * 不存在把两者揉进一条提示词的档位，它等价于 spaced。
 */
export const WORD_STYLES = Object.freeze(['underscored', 'spaced', 'prose', 'hybrid'])

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
