
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
 * `caption` 是第三条路：不走 compose.js 的成分句模板，而是走 lib/compile/moss.js，
 * 按「主体 → 外观 → 动作 → 空间关系 → 构图 → 环境 → 光照 → 风格」写一整段连贯描述。
 * 它给 MOSS-Image 这类读得懂空间关系的模型用；与 prose 的区别不是长短，是组织方式：
 * prose 是标签串成的句子，caption 是对画面内容的描述。
 *
 * `hybrid` 保留只是兼容旧档案：插件现在同时输出「纯标签版 + 描述版」，
 * 不存在把两者揉进一条提示词的档位，它等价于 spaced。
 */
export const WORD_STYLES = Object.freeze(['underscored', 'spaced', 'prose', 'caption', 'hybrid'])

export const CONFIDENCE_LEVELS = Object.freeze(['A', 'B', 'C'])

/**
 * Caption 档案能写哪种语言。
 *
 * 只有英语。不是因为不想支持中文，是因为数据不够：Caption 的每个词都得能落到
 * 一条 IR 观察上，而 IR 里的观察值（`silver hair`、`rainy street`）是英语——
 * 这是视觉阶段按 Danbooru 口径产出的，不是随手写的常量。要中文只有两条路：
 * 加一次 LLM 翻译（多一次模型调用，且译文不再逐词可溯源），或者维护一张
 * 中英对照表（`res/` 里只有两份 Danbooru 标签表，没有这种东西）。
 * 两条都不做，所以这里只有 en，写别的语言会编译失败而不是悄悄输出英文。
 */
export const CAPTION_LANGUAGES = Object.freeze(['en'])

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
