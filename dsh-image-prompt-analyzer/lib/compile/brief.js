/**
 * 自然语言需求 → Caption 草稿。
 *
 * 这是「编写」入口，不是「反推」入口，两者的事实来源不同：
 *   - 反推：事实来自图片观察，插件按 IR 组装句子，不许增写画面里没有的东西；
 *   - 编写：事实来自用户这句话本身。用户说的就是内容，插件不替他添人物、改关系，
 *     也不把他的话拆成标签再拼回去——那正是「右手握着伞」「行李箱在脚边」这类
 *     归属信息在转成标签时被丢掉的地方。
 *
 * 所以这一层做的事很少，但每件都必须做：认出语言、挡住 Layout JSON 与标签流、
 * 摘掉官方明确说不要的冗余质量词、按档案给负向词。它不是提示词增强器，
 * 不改写用户的句子，也不翻译。
 */

export const BRIEF_SCHEMA_VERSION = '1.0'

export const BRIEF_CODES = Object.freeze({
  BRIEF_REQUIRED: 'BRIEF_TEXT_REQUIRED',
  BRIEF_EMPTY: 'BRIEF_TEXT_EMPTY',
  BRIEF_PROFILE_NOT_CAPTION: 'BRIEF_PROFILE_NOT_CAPTION',
  BRIEF_LAYOUT_REJECTED: 'BRIEF_LAYOUT_REJECTED',
  BRIEF_LOOKS_LIKE_TAGS: 'BRIEF_LOOKS_LIKE_TAGS',
  BRIEF_QUALITY_WORDS_REMOVED: 'BRIEF_QUALITY_WORDS_REMOVED',
  BRIEF_LANGUAGE_DETECTED: 'BRIEF_LANGUAGE_DETECTED',
  BRIEF_LANGUAGE_MISMATCH: 'BRIEF_LANGUAGE_MISMATCH',
  BRIEF_LANGUAGE_DIFFERS_FROM_PROFILE: 'BRIEF_LANGUAGE_DIFFERS_FROM_PROFILE',
  BRIEF_LANGUAGE_UNSUPPORTED: 'BRIEF_LANGUAGE_UNSUPPORTED',
  BRIEF_VERY_LONG: 'BRIEF_VERY_LONG',
})

/** MOSS-Image 的 USERGUIDE 写明支持英文与中文（推荐英文，训练数据更多）。 */
export const BRIEF_LANGUAGES = Object.freeze(['en', 'zh-CN'])

/** 官方 SKILL.md 明确要求「避免冗余的质量词」，这些词不描述画面，只描述"这张图多好"。 */
const QUALITY_PHRASES = Object.freeze([
  'masterpiece',
  'best quality',
  'high quality',
  'highest quality',
  'ultra detailed',
  'extremely detailed',
  'highly detailed',
  'high resolution',
  'highres',
  'absurdres',
  'award winning',
  'official art',
  '8k',
  '4k',
  'uhd',
  'hdr',
])

const QUALITY_PATTERN = new RegExp(
  `(?:^|[,、，;；。])\\s*(${QUALITY_PHRASES.map((phrase) => phrase.replace(/\s+/g, '\\s+')).join('|')}|score[_ ]?\\d+(?:_up)?)\\s*(?=$|[,、，;；。.])`,
  'gi',
)

const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/**
 * 一句话在哪结束：中文句读、英文句点（后面跟空格或结尾）、换行都算。
 *
 * 英文句点要带前瞻条件，否则 `1.5m` 会被切成 `1.` 与 `5m`，
 * 尺寸被拆开之后读起来像两个不相干的数字。
 */
function splitSentences(text) {
  return String(text ?? '')
    .split(/(?<=[。！？!?；;])|(?<=\.)(?=\s)|[\r\n]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/**
 * 语言只看有没有汉字，不做别的判断。
 *
 * 不用"拉丁字母比例"来判英文：模型名、数字、标点会把比例拉偏，
 * 而一段中文里夹几个英文单词是常态。有汉字就是中文，没有就是英文。
 */
export function detectBriefLanguage(text) {
  const value = String(text ?? '')
  if (value.trim() === '') return null
  return CJK_PATTERN.test(value) ? 'zh-CN' : 'en'
}

/**
 * 输入像不像一串标签。
 *
 * 判据是"分句短、逗号多、几乎没有句子结构"：`1girl, long hair, school uniform`
 * 会被判成标签流；而「一名女性穿着深蓝色长外套，站在车站雨棚下。」不会——
 * 它的分句够长，也有句号。
 */
function looksLikeTagList(text) {
  const value = String(text ?? '').trim()
  if (value === '') return false
  if (/[。！？!?]/.test(value)) return false
  const parts = value.split(/[,，、]/).map((part) => part.trim()).filter(Boolean)
  if (parts.length < 3) return false
  const averageWords = parts.reduce((sum, part) => sum + part.split(/\s+/).filter(Boolean).length, 0) / parts.length
  return averageWords <= 3
}

/** 需求里塞了一段 Layout JSON：默认正向提示词不要这个东西。 */
function looksLikeLayoutJson(text) {
  const value = String(text ?? '').trim()
  if (!value.startsWith('{')) return false
  return /"(bbox|items|bbox_coord_space|bbox_format)"\s*:/.test(value)
}

function stripQualityWords(text) {
  const removed = []
  const cleaned = String(text ?? '').replace(QUALITY_PATTERN, (match, phrase) => {
    removed.push(phrase.trim())
    return ''
  })
  return { text: cleaned, removed }
}

function tidy(text) {
  let out = String(text ?? '').replace(/[ \t]+/g, ' ')
  // 中文标点两边不留空格；英文逗号后留一个空格，否则 `a,b` 会粘在一起。
  out = out.replace(/\s*([，。；：！？、])\s*/g, '$1')
  out = out.replace(/\s*([,;:])\s*/g, '$1 ')
  out = out.replace(/\s+([.?!])/g, '$1')
  out = out.replace(/([，,])\s*([，,])+/g, '$1')
  out = out.replace(/^[\s，,。；;.]+/, '')
  return out.trim()
}

/**
 * 把用户的需求排成一段 Caption。
 *
 * 不做的事：不翻译、不补人物、不补关系、不把句子改写成"更像提示词"的样子。
 * 用户写的是中文就交中文，写的是英文就交英文——MOSS 官方说明两种都支持，
 * 而翻译会把「她的右手」翻丢成「一只手」。
 */
export function composeCaptionFromBrief({ brief, profile, language = null, includeNegative = true } = {}) {
  const diagnostics = []
  const raw = typeof brief === 'string' ? brief : ''
  const wordStyle = profile?.tag_standard?.word_style ?? null

  if (raw.trim() === '') {
    diagnostics.push({
      code: BRIEF_CODES.BRIEF_REQUIRED,
      severity: 'error',
      message: '没有拿到画面需求文本。',
      suggested_fix: '传 brief：一段中文或英文的画面描述，例如「一名女性穿着深蓝色长外套，站在车站雨棚下」。',
    })
    return { ok: false, text: '', language: null, negative: null, stats: { chars: 0, sentences: 0 }, diagnostics }
  }

  if (wordStyle !== 'caption') {
    diagnostics.push({
      code: BRIEF_CODES.BRIEF_PROFILE_NOT_CAPTION,
      severity: 'error',
      message: `档案 ${profile?.config_id ?? '(unknown)'} 不是 Caption 档案（word_style=${wordStyle ?? 'null'}），自然语言需求写不出它的正向提示词。`,
      suggested_fix: '这个入口只服务 Caption 档案（moss）。标签流档案请用 compile_tag_basket，把需求拆成词再编译。',
    })
    return { ok: false, text: '', language: null, negative: null, stats: { chars: 0, sentences: 0 }, diagnostics }
  }

  if (looksLikeLayoutJson(raw)) {
    diagnostics.push({
      code: BRIEF_CODES.BRIEF_LAYOUT_REJECTED,
      severity: 'error',
      message: '需求里是一段 Layout JSON。默认正向提示词只放 Caption，不放坐标与 JSON 字段。',
      suggested_fix: '把画面需求写成一句话描述交进来；要精确排布，走分析链路的 layout 参数（那条路会按画布尺寸生成合法坐标）。',
    })
    return { ok: false, text: '', language: null, negative: null, stats: { chars: 0, sentences: 0 }, diagnostics }
  }

  if (looksLikeTagList(raw)) {
    diagnostics.push({
      code: BRIEF_CODES.BRIEF_LOOKS_LIKE_TAGS,
      severity: 'info',
      message: '这段输入更像一串标签，而不是一句画面描述。',
      suggested_fix: '标签流请用 compile_tag_basket；这个入口按原样输出，不会替你补主谓、补归属。',
    })
  }

  const detected = detectBriefLanguage(raw)
  let wanted = detected
  if (typeof language === 'string' && language.trim() !== '') {
    const asked = language.trim()
    if (!BRIEF_LANGUAGES.includes(asked)) {
      diagnostics.push({
        code: BRIEF_CODES.BRIEF_LANGUAGE_UNSUPPORTED,
        severity: 'warning',
        message: `不支持的语言：${asked}。目前只声明英文与中文。`,
        suggested_fix: `language 取 ${BRIEF_LANGUAGES.join(' / ')}，或省略让它按需求文本自动判断。`,
      })
    } else if (asked !== detected) {
      // 不翻译。把中文需求标成英文再输出，等于交一段"说是英文其实是中文"的东西。
      diagnostics.push({
        code: BRIEF_CODES.BRIEF_LANGUAGE_MISMATCH,
        severity: 'warning',
        message: `需求文本是 ${detected}，但要求按 ${asked} 输出。插件不翻译，按原文 ${detected} 输出。`,
        suggested_fix: '要英文 Caption，就直接用英文写需求；中文需求交中文 Caption，MOSS 官方说明中文同样受支持。',
      })
      wanted = detected
    } else {
      wanted = asked
    }
  }
  if (detected) {
    diagnostics.push({
      code: BRIEF_CODES.BRIEF_LANGUAGE_DETECTED,
      severity: 'info',
      message: `语言按需求文本判定为 ${detected}。`,
    })
  }

  const profileLanguage = profile?.tag_standard?.caption_language ?? null
  if (profileLanguage && wanted && profileLanguage !== wanted) {
    // 只是"档案默认语言不是这一种"，不是错误：官方两种都支持。
    // 用单独的 code，免得和"你要求英文但写的是中文"混成同一件事。
    diagnostics.push({
      code: BRIEF_CODES.BRIEF_LANGUAGE_DIFFERS_FROM_PROFILE,
      severity: 'info',
      message: `档案默认 Caption 语言是 ${profileLanguage}，这份需求是 ${wanted}；按需求语言输出，不翻译。`,
      suggested_fix: `要统一成 ${profileLanguage}，把需求本身写成 ${profileLanguage === 'zh-CN' ? '中文' : '英文'}。`,
    })
  }

  const stripped = stripQualityWords(raw)
  if (stripped.removed.length > 0) {
    diagnostics.push({
      code: BRIEF_CODES.BRIEF_QUALITY_WORDS_REMOVED,
      severity: 'info',
      message: `摘掉了 ${stripped.removed.length} 个冗余质量词：${stripped.removed.join(', ')}。`,
      suggested_fix: '官方 SKILL.md 要求避免冗余质量词；质量靠采样参数，不靠形容词。',
    })
  }

  const sentences = splitSentences(stripped.text)
  const text = tidy(sentences.join(wanted === 'zh-CN' ? '' : ' '))
  if (text === '') {
    diagnostics.push({
      code: BRIEF_CODES.BRIEF_EMPTY,
      severity: 'error',
      message: '摘掉质量词之后，需求里没有剩下画面内容。',
      suggested_fix: '补上主体、动作或场景，例如「一名女性站在雨棚下，右手握着一把收拢的伞」。',
    })
    return { ok: false, text: '', language: wanted, negative: null, stats: { chars: 0, sentences: 0 }, diagnostics }
  }

  if (text.length > 4000) {
    diagnostics.push({
      code: BRIEF_CODES.BRIEF_VERY_LONG,
      severity: 'warning',
      message: `需求有 ${text.length} 个字符，超过 MOSS 官方标称的 4K token 上限附近。`,
      suggested_fix: '删掉重复的环境描述，保留主体、动作、归属与光线。',
    })
  }

  const negative = includeNegative === false ? null : buildBriefNegative({ profile, positiveText: text })

  return {
    ok: true,
    schema_version: BRIEF_SCHEMA_VERSION,
    register: 'caption',
    language: wanted,
    text,
    sentences,
    negative,
    // 这个入口只产 Caption。写成字段而不是让调用方从别的字段推断：
    // 官方 SKILL.md 说只有 caption 或 compiled Layout 该进正向提示词，
    // 那"这次没有标签流、也没有 Layout"就该是一句能读的话。
    emitted: { register: 'caption', tags: false, layout: false },
    stats: {
      chars: text.length,
      sentences: sentences.length,
      removed_quality_words: stripped.removed.length,
    },
    diagnostics,
  }
}

/**
 * 负向词只取档案声明的那几条（MOSS 是四条官方基线）。
 * 正向里已经说过的词从负向里去掉——一边要伞、一边写 no umbrella 是自相矛盾。
 */
function buildBriefNegative({ profile, positiveText }) {
  const declared = profile?.tag_standard?.negative?.terms
  const terms = (Array.isArray(declared) ? declared : []).filter((term) => typeof term === 'string' && term.trim() !== '')
  if (terms.length === 0) return { text: '', terms: [], removed: [] }
  const lower = String(positiveText ?? '').toLowerCase()
  const kept = []
  const removed = []
  for (const term of terms) {
    const bare = term.toLowerCase().replace(/^no\s+/, '')
    if (lower.includes(bare)) {
      removed.push(term)
      continue
    }
    kept.push(term)
  }
  return { text: kept.join(', '), terms: kept, removed }
}
