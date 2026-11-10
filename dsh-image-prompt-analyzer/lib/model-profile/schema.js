
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
 * `en` 与 `zh-CN` 两种，默认 `en`。
 *
 * 中文不是把英文 Caption 翻一遍得来的。Caption 的每个内容词都得能落到一条 IR
 * 观察上，而 IR 的观察值本来是按 Danbooru 口径产出的英语（`silver hair`、
 * `rainy street`）。所以中文只能从上游解决：选定 `zh-CN` 之后，Stage A / Stage B
 * 的请求里直接要求模型用中文写观察值，IR 里记下 `observation_language`，
 * Caption 再用中文模板把这些中文事实组织成句子。全程没有第二次视觉调用，
 * 也没有任何翻译模型——翻译出来的句子没法逐句回指到观察，那种"看起来像"
 * 的提示词比空着更难查。
 *
 * 反过来，一份英语观察的 IR 要出中文 Caption 是不行的：编译层会明确报
 * `COMPILE_MOSS_CAPTION_LANGUAGE_EMPTY`，提示用户用中文重新分析，而不是悄悄
 * 输出英文、也不是偷偷补一次视觉分析。
 */
export const CAPTION_LANGUAGES = Object.freeze(['en', 'zh-CN'])

/** 没说的时候用哪种。`en` 是 MOSS 官方指南的首选语言，也是既有行为的默认值。 */
export const DEFAULT_CAPTION_LANGUAGE = 'en'

/**
 * 把用户写的语言标签归一成清单里的写法。
 *
 * 只做大小写与常见分隔符的归一（`zh`、`zh_cn`、`zh-Hans`、`ZH-CN` 都归到 `zh-CN`），
 * 认不出来的一律返回 null，由调用方决定是报错还是回落到默认值——这里不替调用方
 * 猜"你是不是想要英文"。
 */
export function normalizeCaptionLanguage(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return null
  const lowered = raw.toLowerCase().replace(/[_\s]+/g, '-')
  if (lowered === 'en' || lowered === 'en-us' || lowered === 'en-gb' || lowered === 'english') return 'en'
  if (
    lowered === 'zh' ||
    lowered === 'zh-cn' ||
    lowered === 'zh-hans' ||
    lowered === 'zh-sg' ||
    lowered === 'chinese' ||
    lowered === 'cn'
  ) {
    return 'zh-CN'
  }
  return null
}

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
