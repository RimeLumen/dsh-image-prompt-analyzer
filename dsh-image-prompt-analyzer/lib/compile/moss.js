/**
 * MOSS-Image（OpenMOSS）的自然语言 Caption 编译。
 *
 * 为什么单独一层，而不是复用 Anima 的 `prose`：
 *   Anima 走的是 `compose.js` 的成分句——它把标签串按「计数 / 主体 / 服装 / 动作」的
 *   模板拼起来，目标读者是 Flux / MJ / GPT-Image 那类「一句话越像标签越好」的写法。
 *   MOSS 的官方用户指南要的是另一件事：**对最终画面内容的连贯描述**，而不是标签串。
 *   它读得懂空间关系（谁在谁左边、手搭在椅背上、前景花枝遮住主体），也读得懂构图与
 *   光照；把这些拆成互不相关的逗号词，等于把 MOSS 唯一比 CLIP 强的能力扔掉。
 *   所以这里另起一条编译器：输入仍是现有 IR 事实（不重新看图、不重新分析），
 *   输出按「主体 → 外观 → 服装 → 动作表情 → 空间关系 → 构图镜头 → 环境 → 光照 →
 *   风格」的语义顺序组织的完整 Caption。
 *
 * 两条硬约束：
 *   1. 只用 IR 里有依据的内容。句子里的连接词可以补，内容词不能补——补一个
 *      "soft morning light" 就是幻觉，而幻觉在提示词里比省略更难查。
 *   2. 画面里的文字逐字保留原语言。`describe.js` 为了让英文句子干净会剔掉 CJK 观察，
 *      但画面上的招牌、对白框属于**内容**，翻译它就等于改画面，所以这里绕过那层过滤
 *      直接从 IR 取原文。
 */

import { SEVERITY, diagnostic } from '../diagnostics.js'
import { CAPTION_LANGUAGES, DEFAULT_CAPTION_LANGUAGE, normalizeCaptionLanguage } from '../model-profile/schema.js'
import { isNegatedObservation, isPlaceholderObservation } from './terms.js'
import { normalizePromptText } from './fidelity.js'

export const MOSS_SCHEMA_VERSION = '1.0'

/** 编译结果的 register 值：`tag` = 标签流，`clause` = 成分句，`caption` = 完整 Caption。 */
export const MOSS_REGISTER = 'caption'

export const MOSS_CODES = Object.freeze({
  CAPTION_EMPTY: 'COMPILE_MOSS_CAPTION_EMPTY',
  CAPTION_UNGROUNDED: 'COMPILE_MOSS_CAPTION_UNGROUNDED',
  CAPTION_LANGUAGE_UNSUPPORTED: 'COMPILE_MOSS_CAPTION_LANGUAGE_UNSUPPORTED',
  // 要的语言与 IR 里已有的观察语言不一致：不是模板问题，是这份 IR 根本没有那种语言的事实。
  CAPTION_LANGUAGE_EMPTY: 'COMPILE_MOSS_CAPTION_LANGUAGE_EMPTY',
  NEGATIVE_SFW_ADDED: 'COMPILE_MOSS_NEGATIVE_SFW_ADDED',
  NEGATIVE_CONTRADICTION_REMOVED: 'COMPILE_MOSS_NEGATIVE_CONTRADICTION_REMOVED',
  NEGATIVE_TRUNCATED: 'COMPILE_MOSS_NEGATIVE_TRUNCATED',
  // 句子预算或配置真的挡住了某些人物/关系：这份 Caption 不是完整的描述。
  CAPTION_TRUNCATED: 'COMPILE_MOSS_CAPTION_TRUNCATED',
  // 某个人在 IR 里没有任何外观与服装观察，写不进 Caption。这是事实缺失，不是省略。
  CAPTION_PERSON_UNDESCRIBED: 'COMPILE_MOSS_CAPTION_PERSON_UNDESCRIBED',
})

/**
 * 能可靠产出的 Caption 语言。
 *
 * 两种：`en` 与 `zh-CN`。中文不是把英文 Caption 翻一遍翻出来的——那需要额外一次
 * 模型调用，而且译文回指不到任何一条观察。这里的做法是把语言一路推到最上游：
 * 视觉阶段直接用中文写观察值（`scene.summary`、`features[].value`、`relations[].description`），
 * IR 记下 `observation_language`，编译阶段按同一种语言组织句子。
 * 所以「中文 Caption 有依据」与「英文 Caption 有依据」是同一件事，只是字不同。
 *
 * 语言对不上时（英语 IR 要中文，或反过来）明确报 `CAPTION_LANGUAGE_EMPTY` 而不是
 * 交一段编出来的文本——清单本体放在 `model-profile/schema.js`，档案校验也要用它。
 */
export const MOSS_CAPTION_LANGUAGES = CAPTION_LANGUAGES

/**
 * 官方指南给的负向基线。
 *
 * 只有四条，和 ComfyUI 官方模板一致。Illustrious 那种几十条 Danbooru 负向
 * 不能搬过来：MOSS 吃的是自然语言，一长串标签式负向既不在它的训练分布里，
 * 又会把「这次真正要排除的那一件事」稀释掉。
 */
export const MOSS_NEGATIVE_BASE = Object.freeze([
  'worst quality',
  'bad anatomy',
  'watermark',
  'jpeg artifact',
])

/**
 * Caption 的语法骨架词。
 *
 * 这些词描述的是"这张图怎么呈现"，不是"图里有什么"：`image` / `subject` /
 * `background` / `camera` 都是取景框，不是画面对象。它们进不了 `facts`，
 * 但少了它们句子就散架。除这一组之外，任何内容词都必须来自 IR 事实。
 */
const CAPTION_SCAFFOLDING = new Set([
  'image', 'picture', 'photo', 'scene', 'frame', 'subject', 'figure', 'character',
  'foreground', 'background', 'midground', 'viewer', 'camera', 'composition', 'angle',
  'view', 'perspective', 'distance',
  'framing', 'shot', 'pose', 'lighting', 'light', 'lighting', 'shadow', 'shadows',
  'color', 'colors', 'colour', 'colours', 'tone', 'tones', 'palette', 'style',
  'text', 'texture', 'material', 'detail', 'details', 'area', 'part', 'side',
  'left', 'right', 'top', 'bottom', 'center', 'centre', 'front', 'middle',
  'upper', 'lower', 'full', 'close', 'wide', 'main', 'primary', 'overall',
  'appears', 'appear', 'shown', 'shows', 'show', 'depicted', 'visible', 'present',
  'positioned', 'placed', 'set', 'seen', 'viewed', 'looks', 'look', 'contains',
  'lit', 'lighted', 'illuminated',
  'contains', 'is', 'are', 'was', 'were', 'has', 'have', 'stands', 'stand',
  'sits', 'sit', 'wears', 'wear', 'wearing', 'holds', 'hold', 'holding',
  'she', 'he', 'they', 'her', 'his', 'their', 'its', 'it',
  'a', 'an', 'the', 'and', 'or', 'of', 'on', 'in', 'at', 'with', 'without',
  'from', 'to', 'by', 'into', 'over', 'under', 'behind', 'beside', 'near',
  'through', 'toward', 'towards', 'across', 'along', 'around', 'between',
  'above', 'below', 'beneath', 'within', 'against', 'while', 'as', 'than',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'both', 'several', 'some', 'this', 'that', 'these', 'those', 'very', 'also',
  'only', 'slightly', 'partly', 'fully', 'mostly', 'together',
  // 「画面里还有另一个人」这类引出句的骨架词。它们不描述画面内容，
  // 是模板为了把人分开说的连接词——不该被算成"凭空补的内容"。
  'there', 'another', 'other', 'rest', 'each', 'person', 'people',
])

const NUMBER_WORDS = Object.freeze(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'])

const DETERMINER_START = /^(?:a|an|the|this|that|these|those|his|her|their|its|some|several|many|two|three|four|five|one|both)\b/i
const PREPOSITION_START = /^(?:from|in|on|at|to|with|without|behind|above|below|near|under|over|across|along|through|by|toward|towards|inside|outside|beside|between|around|against|beneath|within)\b/i
const GERUND_START = /^(?:standing|sitting|kneeling|leaning|walking|running|lying|crouching|floating|squatting|turning|facing|looking|holding|reaching|resting|stretching|waiting|reading|sleeping)\b/i
const BODY_PART_CLAUSE = /^(left|right|both)\s+(arm|arms|hand|hands|leg|legs|knee|knees|foot|feet|shoulder|shoulders|head|torso|hip|hips|palm|palms|finger|fingers|elbow|elbows|wrist|wrists)\s+([a-z]+)\b/i
const PARTICIPLE = /^(?:raised|lowered|extended|bent|tilted|resting|placed|spread|held|tucked|crossed|outstretched|lifted|open|closed|curled|hanging|pointing|touching|covered|wrapped|folded|stretched|relaxed|pressed|clasped)$/i
const QUALITY_WORD = /^(?:masterpiece|best quality|high quality|good quality|normal quality|low quality|worst quality|highres|lowres|absurdres|very aesthetic|aesthetic|high score|low score|bad score|average score|great score|score[ _]?\d.*)$/i
const RATING_WORD = /^(?:safe|general|sensitive|nsfw|explicit|questionable)$/i
const TEXT_CATEGORIES = new Set(['text'])
const TEXT_KEYS = new Set(['text', 'lettering', 'sign_text', 'caption_text', 'logo_text'])

/** 中文的二字组切分：`银灰色长发` → `银灰/灰色/色长/长发`。 */
const CJK_RUN = /[㐀-䶿一-鿿豈-﫿぀-ヿ]+/g

function bigrams(run) {
  const chars = [...run]
  if (chars.length <= 2) return [run]
  const grams = []
  for (let index = 0; index < chars.length - 1; index += 1) grams.push(chars[index] + chars[index + 1])
  return grams
}

/**
 * 分词。英文按空格切；中文按二字组切——整句当一个词的话，
 * `dropContained` 判不出重复，`verifyCaptionGrounding` 也判不出覆盖。
 */
function wordsOf(value, language = 'en') {
  const text = normalizePromptText(value)
  if (language !== 'zh-CN') return text.split(' ').filter(Boolean)
  const tokens = []
  for (const chunk of text.split(' ').filter(Boolean)) {
    let rest = chunk
    for (const run of chunk.match(CJK_RUN) ?? []) {
      tokens.push(...bigrams(run))
      rest = rest.replace(run, ' ')
    }
    tokens.push(...rest.split(' ').filter(Boolean))
  }
  return tokens
}

function capitalize(value) {
  const text = String(value ?? '')
  if (text.length === 0) return text
  return text[0].toUpperCase() + text.slice(1)
}

function article(word) {
  return /^[aeiou]/i.test(String(word ?? '')) ? 'an' : 'a'
}

/**
 * 给裸名词短语补冠词。
 *
 * `white blouse` 要写成 `a white blouse`，但 `blue jeans`（复数）、`silver hair`
 * （不可数）、`from below`（介词短语）都不能加——加错了比不加更难读。判据只看词形，
 * 不猜语义：有冠词/介词开头的不动，首词以 s 结尾的不动，专有名词不动。
 */
function withArticle(phrase) {
  const text = String(phrase ?? '').trim()
  if (text.length === 0) return text
  if (DETERMINER_START.test(text) || PREPOSITION_START.test(text)) return text
  const first = text.split(/\s+/)[0]
  if (/s$/i.test(first)) return text
  if (/^[A-Z]/.test(first)) return text
  return `${article(first)} ${text}`
}

/** 中文列举：`A、B和C`。中文不用逗号分隔并列项，用顿号。 */
function joinListZh(items) {
  const list = (Array.isArray(items) ? items : []).map((item) => stripTail(item)).filter(Boolean)
  if (list.length === 0) return ''
  if (list.length === 1) return list[0]
  if (list.length === 2) return `${list[0]}和${list[1]}`
  return `${list.slice(0, -1).join('、')}和${list[list.length - 1]}`
}

/** 去掉观察值自带的句末标点：模板自己会补一个，留着就变成「……。。」。 */
function stripTail(value) {
  return String(value ?? '').trim().replace(/[。．.，,；;！!？?]+$/u, '')
}

function joinList(items, conjunction = 'and') {
  const list = (Array.isArray(items) ? items : []).map((item) => String(item ?? '').trim()).filter(Boolean)
  if (list.length === 0) return ''
  if (list.length === 1) return list[0]
  if (list.length === 2) return `${list[0]} ${conjunction} ${list[1]}`
  return `${list.slice(0, -1).join(', ')}, ${conjunction} ${list[list.length - 1]}`
}

/**
 * 肢体短语转成完整分句。
 *
 * `right hand holds the umbrella handle` → `Her right hand holds the umbrella handle.`
 * `left arm raised toward the viewer palm open` → `Her left arm is raised toward the viewer palm open.`
 *
 * 只在动词是分词时补 `is`：`holds` 是限定动词，补了就成了 `is holds`。
 */
function bodyPartClause(text, possessive = 'her') {
  const value = String(text ?? '').trim()
  const match = BODY_PART_CLAUSE.exec(value)
  if (!match) return null
  const [, side, part, verb] = match
  const rest = value.slice(match[0].length - verb.length)
  const head = `${capitalize(possessive)} ${side} ${part}`
  return PARTICIPLE.test(verb) ? `${head} is ${rest}.` : `${head} ${rest}.`
}

const ZH_NUMERALS = Object.freeze(['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十'])

/**
 * 中文主体短语。
 *
 * 中文的实体标签本身就是中文（视觉阶段按 zh-CN 写下来的），所以这里不做词形变换：
 * 标签已经是「一个女孩」「银发少女」，原样用。只在标签没写人数、而 `count` 说了
 * 不止一个时补一个数量词——补的是语法，不是内容。
 */
function personPhraseZh(entity) {
  const label = String(entity?.label ?? '').trim()
  if (label === '') return null
  const count = Number.isInteger(entity?.count) && entity.count > 0 ? entity.count : 1
  const numbered = /^(\d+)\s*(.+)$/.exec(label)
  const total = numbered ? Number(numbered[1]) : count
  const bare = (numbered ? numbered[2] : label).trim()
  const startsWithNumeral = /^[零一两二三四五六七八九十]/.test(bare)
  const phrase = total > 1 && !startsWithNumeral ? `${ZH_NUMERALS[total] ?? total}${bare}` : bare
  const feminine = /女|妹|姐|妈|婆|娘/.test(bare)
  const masculine = /男|弟|哥|爸|爹|少年/.test(bare)
  const plural = total > 1
  return {
    phrase,
    label,
    noun: bare,
    total,
    pronoun: plural ? '她们' : feminine ? '她' : masculine ? '他' : '它',
    possessive: plural ? '她们的' : feminine ? '她的' : masculine ? '他的' : '它的',
    plural,
    entity_id: entity?.entity_id ?? entity?.id ?? null,
  }
}

function personPhrase(entity, language = 'en') {
  if (!entity || typeof entity !== 'object') return null
  if (language === 'zh-CN') return personPhraseZh(entity)
  const label = String(entity.label ?? '').trim()
  const count = Number.isInteger(entity.count) && entity.count > 0 ? entity.count : 1
  const match = /^(?:(\d+)\s*)?(girls?|boys?|women?|men?|persons?|people|figures?|others?)$/i.exec(label)
  const raw = match ? match[2].toLowerCase() : label.replace(/\s+/g, ' ').toLowerCase()
  const singular = raw.replace(/s$/, '')
  const total = match && match[1] ? Number(match[1]) : count
  const plural = total > 1
  const noun = plural ? pluralize(singular) : singular
  const amount = plural ? NUMBER_WORDS[total] ?? String(total) : 'a'
  const phrase = `${amount} ${noun}`.trim()
  const feminine = /^(girl|woman)$/.test(singular)
  const masculine = /^(boy|man)$/.test(singular)
  return {
    phrase,
    // 原始标签要留着：台账按 `subject.count` = `1girl` 这个身份记事实，
    // 只有原文能对上它。`phrase` 是给读者看的，不能拿去 join。
    label,
    noun: singular,
    total,
    pronoun: feminine ? 'she' : masculine ? 'he' : 'they',
    possessive: feminine ? 'her' : masculine ? 'his' : 'their',
    plural,
    entity_id: entity.entity_id ?? entity.id ?? null,
  }
}

function pluralize(noun) {
  if (noun === 'woman') return 'women'
  if (noun === 'man') return 'men'
  if (noun === 'person') return 'people'
  if (noun.endsWith('s')) return noun
  return `${noun}s`
}

/** 发色/发型类观察：只有这一种外观能拿来指人，且必须是全场独一份的。 */
const HAIR_CLAIM = /\bhair\b|头发|长发|短发|发型/i

/** 关系句开头就是一个代词时，补主语会变成「她她握着伞」，得先把它换掉。 */
const LEADING_PRONOUN_EN = /^(she|he|they|her|his|their)\b/i
const LEADING_PRONOUN_ZH = /^(她们|他们|她|他)/

/**
 * 把一条发色观察变成能放在名词前的形容语。
 *
 * 英文只认 `X hair` 与 `X-haired` 两种写法，取 `hair` 前面最后一个词当颜色：
 * `long silver hair` → `silver-haired`。取最后一个词而不是整段，是因为
 * `long` 说的是长度、`silver` 才是能区分两个人的那一项。
 */
function hairDescriptorFrom(text, language) {
  const value = stripTail(text)
  if (value === '') return null
  if (language === 'zh-CN') return value
  if (/-haired$/i.test(value)) return value.toLowerCase()
  const match = /^(.*?)\s*hair$/i.exec(value)
  if (!match) return null
  const words = match[1].split(/\s+/).filter(Boolean)
  const color = words[words.length - 1] ?? ''
  if (color === '') return null
  return `${color.toLowerCase()}-haired`
}

/**
 * 画面里不止一个人时，谁都得有一个稳定的叫法。
 *
 * 只用两类依据：实体自己的标签（`woman`）与它自己的外观观察（`silver hair`）。
 * 发色只有在**全场独一份**时才拿来指人——两个人都写着 `silver hair` 时，
 * 「银发的那位」照样指不清是谁。没有可用特征时退回「另一位」，
 * 不为了消歧去编发色、服装或左右位置。
 */
function buildPersonRefs({ persons, factsByEntity, language = 'en' }) {
  const base = (Array.isArray(persons) ? persons : []).map((entity) => {
    const id = entity?.entity_id ?? entity?.id ?? null
    const phrase = personPhrase(entity, language)
    const looks = factsByEntity.get(id)?.appearance ?? []
    const hairFact = looks.find((fact) => HAIR_CLAIM.test(String(fact?.text ?? ''))) ?? null
    return {
      id,
      phrase,
      hairText: hairFact ? hairFact.text : null,
      hair: hairFact ? hairDescriptorFrom(hairFact.text, language) : null,
    }
  })
  const hairCount = new Map()
  for (const entry of base) {
    if (entry.hair) hairCount.set(entry.hair, (hairCount.get(entry.hair) ?? 0) + 1)
  }
  return base.map((entry, index) => {
    const unique = entry.hair !== null && hairCount.get(entry.hair) === 1
    const noun = String(entry.phrase?.noun ?? '')
    const bare = stripZhNumerals(noun)
    const head = bare === '' ? (language === 'zh-CN' ? '人' : 'person') : bare
    // 没有可用特征时，第二个人不能也叫「那个女人」——两个人同名等于没有指称。
    // 主体用 `the woman`，其余按顺序退成 `the other woman`。
    const isPrimary = index === 0
    const label = language === 'zh-CN'
      ? (unique ? `${entry.hair}的${head}` : isPrimary ? head : `另一名${head}`)
      : (unique ? `the ${entry.hair} ${head}` : isPrimary ? `the ${head}` : `the other ${head}`)
    const otherLabel = language === 'zh-CN'
      ? (unique ? `${entry.hair}的${head}` : `另一名${head}`)
      : (unique ? `the ${entry.hair} ${head}` : `the other ${head}`)
    return {
      id: entry.id,
      noun,
      unique,
      hair: unique ? entry.hair : null,
      hairText: entry.hairText,
      label,
      otherLabel,
      // 中文不用所有格标记：`银发女人右手握着伞` 比 `银发女人的右手握着伞` 更像描述。
      possessive: language === 'zh-CN' ? label : `${label}'s`,
      intro: language === 'zh-CN' ? `另一名${head}` : `another ${head}`,
      pronoun: entry.phrase?.pronoun ?? (language === 'zh-CN' ? '她' : 'she'),
      possessivePronoun: entry.phrase?.possessive ?? (language === 'zh-CN' ? '她的' : 'her'),
    }
  })
}

/**
 * 把句子里的代词换成确定指称。
 *
 * 只在"画面里不止一个人"时调用：一个人时「她」不会指错，换成
 * 「那个黑发女人」反而啰嗦。换的只是代词，不动句子里的任何内容词——
 * 这一步只负责说清原来那句话指的是谁，不重新分配归属。
 */
function replacePronouns(text, ref, language) {
  const value = String(text ?? '')
  if (!ref || typeof ref.label !== 'string' || ref.label === '') return value
  if (language === 'zh-CN') {
    return value
      .replace(/(她们|他们|她|他)的/g, `${ref.label}的`)
      .replace(/(她们|他们|她|他)(?![的们])/g, ref.label)
  }
  return value
    .replace(/\b(her|his|their)\b/gi, ref.possessive)
    .replace(/\b(she|he|they)\b/gi, ref.label)
}

/**
 * 两端都是人时，只明确"给谁"：`to her` / `给她的` 里的代词是接收方，
 * 换成接收方的指称；其余代词仍属施动方。执行者与接收者互换是最不能犯的错。
 */
function replaceDirectedPronoun(text, ref, language) {
  const value = String(text ?? '')
  if (!ref || typeof ref.label !== 'string' || ref.label === '') return value
  if (language === 'zh-CN') {
    return value.replace(/(给|向|朝|递给|交给)(她|他)(?!们)/g, `$1${ref.label}`)
  }
  return value.replace(/\b(to|toward|towards)\s+(her|him)\b/gi, `$1 ${ref.label}`)
}

/**
 * 中文里"放在脚边""挂在肩上"这类说法把人省掉了，中文读者默认那是前一句的主语。
 * 多人画面里这个默认会指错人。这里把关系的另一端补成所有格，只补"谁的"，
 * 不动物件的归属——归属本来就是 IR 里那条关系说的。
 */
const ZH_SPATIAL_NOUN = /([^的])(脚边|脚旁|腿边|身边|身旁|手边|手里|手中|怀里|面前|身后|旁边|肩上|膝上|头顶|脖子上|手腕上)/

function attachZhPossessor(text, label) {
  const value = String(text ?? '')
  if (!label) return value
  // 指称本身可能已经带「的」（`黑色短发的女人`），再拼一个所有格会变成
  // 「黑色短发的女人的脚边」。所有格位置上把内层的「的」去掉更顺。
  const bare = String(label).replace(/的/g, '')
  return value.replace(ZH_SPATIAL_NOUN, `$1${bare}的$2`)
}

/**
 * 一条关系里的代词各指谁。
 *
 * 顺序不能换：先钉死方向性代词（`to her` / `给她的` 指的是接收方），
 * 再让剩下的代词落到施动方身上。反过来做会把「递给她」改成「递给施动方」，
 * 执行者与接收者对调——那不是消歧，是把归属写反。
 *
 * 施动方是东西时（`棕色行李箱位于 P1 脚边`），句子里的人物代词只能指另一端：
 * 箱子没有「脚边」，那个「她」只能是关系指向的人。
 */
function resolveRelationPronouns(text, { fromRef = null, toRef = null, fromIsThing = false, language = 'en' } = {}) {
  let value = String(text ?? '')
  // 两端都是人时只钉接收方。句子的主语已经是施动方的名字，句中的「她的」不会指错；
  // 再替换一遍只会写成「黑发女人把黑发女人的扇子递给银发女人」——同一句里
  // 重复两次同一个指称，比原来的代词更难读。
  if (fromRef && toRef && fromRef.id !== toRef.id) return replaceDirectedPronoun(value, toRef, language)
  const owner = fromIsThing ? toRef : fromRef
  if (!owner) return value
  return replacePronouns(value, owner, language)
}

function stripZhNumerals(text) {
  return String(text ?? '')
    .replace(/^[零一两二三四五六七八九十]+\s*[个名位]?/, '')
    .trim()
}

function rankFacts(list) {
  return list
    .map((fact, index) => ({ fact, index }))
    .sort((a, b) => {
      const importance = (b.fact?.importance ?? 0) - (a.fact?.importance ?? 0)
      if (importance !== 0) return importance
      const confidence = (b.fact?.confidence ?? 0) - (a.fact?.confidence ?? 0)
      if (confidence !== 0) return confidence
      return a.index - b.index
    })
    .map((entry) => entry.fact)
}

/**
 * 同一件事说了两遍只留一次：`long hair` 被 `long silver hair` 包含时后者留下。
 * 只看词集合的包含关系，不猜语义；短于两词的不参与，否则 `smile` 会吞掉 `slight smile`。
 */
function dropContained(list, language = 'en') {
  const kept = []
  for (const fact of list) {
    const words = new Set(wordsOf(fact.text, language))
    if (words.size < 2) {
      kept.push(fact)
      continue
    }
    const swallowed = kept.some((other) => {
      const otherWords = new Set(wordsOf(other.text, language))
      if (otherWords.size <= words.size) return false
      return [...words].every((word) => otherWords.has(word))
    })
    if (!swallowed) kept.push(fact)
  }
  return kept.filter((fact) => {
    const words = new Set(wordsOf(fact.text, language))
    if (words.size < 2) return true
    return !kept.some((other) => {
      if (other === fact) return false
      const otherWords = new Set(wordsOf(other.text, language))
      if (otherWords.size < words.size) return false
      if (otherWords.size === words.size) return false
      return [...words].every((word) => otherWords.has(word))
    })
  })
}

function dedupeRefs(refs) {
  const seen = new Set()
  const out = []
  for (const ref of Array.isArray(refs) ? refs : []) {
    if (!ref || typeof ref !== 'object') continue
    const key = JSON.stringify(ref)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}

function detailBudget(detailLevel) {
  // 句子上限按「事实类别」而不是「事实条数」放宽：一条光照、一条背景各占一句，
  // 上限卡太紧就会先砍掉排在后面的环境与光照——那恰恰是 Caption 比标签强的地方。
  if (detailLevel === 'minimal') return { perSection: 1, maxSentences: 6, style: false, text: true }
  if (detailLevel === 'high') return { perSection: 6, maxSentences: 24, style: true, text: true }
  return { perSection: 3, maxSentences: 14, style: true, text: true }
}

/**
 * 画面里的文字：逐字取原文，不翻译、不转小写、不剔 CJK。
 * 它们不是"观察值"，是画面内容本身。
 */
function collectImageText(ir) {
  const out = []
  const visit = (feature, entityId) => {
    if (!feature || typeof feature !== 'object') return
    const category = String(feature.category ?? '')
    const key = String(feature.key ?? '')
    if (!TEXT_CATEGORIES.has(category) && !TEXT_KEYS.has(key)) return
    const value = typeof feature.value === 'string' ? feature.value.trim() : ''
    if (value.length === 0) return
    if (isNegatedObservation(value) || isPlaceholderObservation(value)) return
    if (out.some((entry) => entry.value === value)) return
    out.push({
      value,
      entity_id: entityId,
      facts: [
        {
          text: value,
          category: category || 'text',
          entity_id: entityId,
          source_refs: [
            {
              kind: entityId ? 'entity_feature' : 'feature',
              category: category || 'text',
              key,
              entity_id: entityId,
              occurrence: Number.isInteger(feature.occurrence) && feature.occurrence > 0 ? feature.occurrence : 0,
            },
          ],
        },
      ],
    })
  }
  for (const feature of Array.isArray(ir?.features) ? ir.features : []) visit(feature, null)
  for (const entity of Array.isArray(ir?.entities) ? ir.entities : []) {
    const entityId = entity?.entity_id ?? entity?.id ?? null
    for (const feature of Array.isArray(entity?.features) ? entity.features : []) visit(feature, entityId)
  }
  return out
}

/**
 * 词形归一：只处理会改变"这个词是不是同一个词"的部分。
 *
 * 三种误报在这里被消掉：
 *   1. 单复数——`hand` / `hands`，`girl` / `girls`。IR 写 `silver hair`，模板写
 *      `with silver hair` 没问题，但关系句会把 `holds` 写成 `holding`，事实里却是
 *      `right hand holds the umbrella handle`。
 *   2. 连字符与下划线——`silver-haired`、`long_hair`。`normalizePromptText` 已经把
 *      这两类拆成空格，所以复合词天然按词分别核对，不需要额外规则。
 *   3. 所有格——`girl's` 被切成 `girl` + `s`，`s` 只有一字母会被长度过滤掉。
 *
 * 不做词干还原（`holding` → `hold`）：那需要词典，猜错的方向是把"没写的东西"
 * 判成"写过"，而这里的错判必须是保守的——宁可多报一个待验证词，也不能放过幻觉。
 */
function stemWord(word) {
  const value = String(word ?? '')
  if (value.length <= 3) return value
  // 只认规则明确的几种，且不把 `s` 结尾的词当动词再拆一层。
  // `blouses` 走 `s` 规则得到 `blouse`；`boxes` 走 `es` 规则得到 `box`。
  // 先试 `es` 再试 `s`：`es` 那条更窄，命中就说明确实是 s/x/z/ch/sh 结尾。
  if (value.endsWith('ies')) return `${value.slice(0, -3)}y`
  if (value.endsWith('es') && /(?:s|x|z|ch|sh)$/.test(value.slice(0, -2))) return value.slice(0, -2)
  if (value.endsWith('s') && !value.endsWith('ss')) return value.slice(0, -1)
  return value
}

/**
 * 一个词的全部可接受形态：原形、去复数、去 `es`、`ies` 还原。
 *
 * 逐条比对而不是只取一个 stem，是因为 `blouses` 既可能来自 `blouse`（加 s）
 * 也可能被 `es` 规则误拆成 `blous`。多给几个候选，任何一条命中就放行，
 * 但候选本身仍然由事实词生成——不会因此放过一个 IR 里没有的词。
 */
function wordForms(word) {
  const value = String(word ?? '')
  const forms = new Set([value, stemWord(value)])
  if (value.endsWith('es')) forms.add(value.slice(0, -2))
  if (value.endsWith('s') && !value.endsWith('ss')) forms.add(value.slice(0, -1))
  if (value.endsWith('ies')) forms.add(`${value.slice(0, -3)}y`)
  return forms
}

/**
 * Caption 的依据校验。
 *
 * 与 `describe.js` 的区别：那边按"观察原话的用词"核对，这边额外放行语法骨架词
 * （见 CAPTION_SCAFFOLDING）。骨架词只描述取景框与句法，不指认任何画面对象，
 * 所以它们不是"补出来的内容"。任何其他词都必须能在用到的 IR 事实里找到。
 *
 * 白名单刻意窄：只有句法词、取景框词、代词、介词、冠词、数词。形容词、颜色、
 * 材质、物体名一律不进去——那些正是幻觉最容易藏身的地方。
 */
/**
 * 中文 Caption 的骨架字。
 *
 * 中文没有"空格分词"，按词核对会把模板补的每一个虚词都报成幻觉；反过来放宽成
 * "整句对得上某条事实"又等于不查。所以换一个粒度：**逐字**核对。
 * 句子里每个汉字，要么出现在这一句自己挂着的 IR 事实里，要么属于下面这组句法字。
 *
 * 这组字只承担句子结构（的、了、是、在、里、方面、构图……），不指认任何画面对象：
 * 颜色、材质、物体名一个都不在里面。所以它不会替模板放行任何补出来的内容。
 */
const ZH_SCAFFOLD_CHARS = new Set(
  [...'的了着和与及是在有里中上下面方面构图镜头角度背景光线风格文字姿态表情主体场景画面张这那一个她们他它穿着为被把都也很非常朝位于还另名画面边'],
)

/**
 * 中文接地：按**句子挂着的来源**核对，不按词表。
 *
 * 两句硬条件：
 *   1. 每句都必须挂着 IR 来源（observation / relation / entity_label 的 ref）。
 *      挂不上来源的句子，无论写得多通顺，都是模板自己编的。
 *   2. 句子里每个汉字都要么来自本句挂的那几条事实，要么是骨架字。
 *      这一条挡住了"内容词被偷偷补进去"——补进去的字一定不在本句的事实里。
 */
function verifyCaptionGroundingZh({ text, clauses, extraLabels = [] }) {
  const list = Array.isArray(clauses) && clauses.length > 0
    ? clauses
    : String(text ?? '')
        .split('。')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => ({ text: `${part}。`, tags: [], source_refs: [] }))
  const labelChars = new Set()
  for (const label of extraLabels) for (const char of String(label ?? '')) if (/\p{Script=Han}/u.test(char)) labelChars.add(char)

  const unsupported = []
  let checked = 0
  for (const clause of list) {
    const body = String(clause?.text ?? '')
    if (body === '') continue
    const refs = Array.isArray(clause?.source_refs) ? clause.source_refs : []
    const tags = Array.isArray(clause?.tags) ? clause.tags : []
    if (refs.length === 0 && tags.length === 0) {
      unsupported.push(body)
      continue
    }
    const allowed = new Set(labelChars)
    for (const tag of tags) for (const char of String(tag ?? '')) if (/\p{Script=Han}/u.test(char)) allowed.add(char)
    for (const char of body) {
      if (!/\p{Script=Han}/u.test(char)) continue
      checked += 1
      if (allowed.has(char)) continue
      if (ZH_SCAFFOLD_CHARS.has(char)) continue
      if (!unsupported.includes(char)) unsupported.push(char)
    }
  }
  return { ok: unsupported.length === 0, basis: 'clause_sources', unsupported, checked_words: checked }
}

export function verifyCaptionGrounding({ text, facts, clauses = null, language = 'en', extraLabels = [] } = {}) {
  if (language === 'zh-CN') return verifyCaptionGroundingZh({ text, clauses, extraLabels })
  const factWords = new Set()
  const factForms = new Set()
  for (const fact of Array.isArray(facts) ? facts : []) {
    for (const word of wordsOf(fact?.text)) {
      factWords.add(word)
      for (const form of wordForms(word)) factForms.add(form)
    }
  }
  // 指称是模板造的，但它是从事实推出来的（`silver hair` → `silver-haired woman`）。
  // 不把指称里的词登记进来，台账会把「那位银发的女人」报成凭空补的描述。
  for (const label of Array.isArray(extraLabels) ? extraLabels : []) {
    for (const word of wordsOf(label)) {
      factWords.add(word)
      for (const form of wordForms(word)) factForms.add(form)
    }
  }
  const unsupported = []
  let checked = 0
  for (const word of wordsOf(text)) {
    if (word.length < 2) continue
    checked += 1
    if (factWords.has(word)) continue
    if ([...wordForms(word)].some((form) => factForms.has(form))) continue
    if (CAPTION_SCAFFOLDING.has(word)) continue
    if (!unsupported.includes(word)) unsupported.push(word)
  }
  return { ok: unsupported.length === 0, basis: 'ir_facts', unsupported, checked_words: checked }
}

/**
 * 编不出 Caption 时的返回。
 *
 * 与"空 Caption 但结构完整"是同一件事：register 仍是 caption，text 是空串，
 * 调用方看 `ok` 就知道这次没结果。不退回标签流——那会让 MOSS 拿到一串它读不懂的词。
 */
function emptyCaption({ profile, language, facts, diagnostics }) {
  return {
    schema_version: MOSS_SCHEMA_VERSION,
    register: MOSS_REGISTER,
    profile: profile?.config_id ?? null,
    language,
    ok: false,
    text: '',
    clauses: [],
    facts_used: [],
    facts_dropped: Array.isArray(facts) ? facts : [],
    grounding: { ok: false, basis: 'ir_facts', unsupported: [], checked_words: 0 },
    stats: { facts: 0, used: 0, dropped: 0, sentences: 0, clauses: 0, chars: 0 },
    diagnostics,
  }
}

/**
 * 把 IR 事实编译成一段 MOSS Caption。
 *
 * @param {object} options
 * @param {object} options.ir 已 finalize 的 IR
 * @param {object} options.profile 目标档案（只读 word_style 与 display_name）
 * @param {Array} options.facts `collectDescriptionFacts` 产出的事实（已去重、已剔否定式）
 * @param {string|null} options.detailLevel minimal / standard / high
 * @param {string|null} options.character 用户显式声明的角色名
 * @param {string|null} options.language 目标语言；只有 `en` 有可靠数据来源
 */
export function composeMossCaption({ ir = null, profile = {}, facts = [], detailLevel = null, character = null, language = null } = {}) {
  const diagnostics = []
  const budget = detailBudget(detailLevel)
  const rawLanguage = String(language ?? profile?.tag_standard?.caption_language ?? DEFAULT_CAPTION_LANGUAGE).trim() || DEFAULT_CAPTION_LANGUAGE
  const wantedLanguage = normalizeCaptionLanguage(rawLanguage)

  if (wantedLanguage === null) {
    diagnostics.push(
      diagnostic({
        error_code: MOSS_CODES.CAPTION_LANGUAGE_UNSUPPORTED,
        severity: SEVERITY.ERROR,
        field_path: '/tag_standard/caption_language',
        message: `Caption 只支持 en / zh-CN，收到 ${JSON.stringify(rawLanguage)}。`,
        suggested_fix: '把 caption_language 改成 en 或 zh-CN。这个值在视觉分析开始前就要定，改完要重新分析那张图。',
      }),
    )
    return emptyCaption({ profile, language: rawLanguage, facts, diagnostics })
  }

  const zh = wantedLanguage === 'zh-CN'
  const irLanguage = String(ir?.observation_language ?? 'en')
  // 语言对不上就明确失败，不翻译、不补写。
  //
  // 中文 Caption 的前提是 IR 的观察值本来就是中文——那是视觉阶段按 zh-CN 直接写下来的。
  // 拿一份英语 IR 要中文，唯一可行的办法是翻译，而翻译出来的句子回指不到任何一条观察，
  // 正是这个档案最不该交的东西。反过来（中文 IR 要英文）同样没有英文事实可用。
  if (zh !== (irLanguage === 'zh-CN')) {
    diagnostics.push(
      diagnostic({
        error_code: MOSS_CODES.CAPTION_LANGUAGE_EMPTY,
        severity: SEVERITY.ERROR,
        field_path: '/caption_language',
        message: zh
          ? `要中文 Caption，但这份 IR 的观察值是${irLanguage === 'en' ? '英文' : irLanguage}：里面一条中文事实都没有，写不出中文句子。`
          : `要英文 Caption，但这份 IR 的观察值是${irLanguage}：里面没有可用的英文事实。`,
        suggested_fix: zh
          ? '用 caption_language=zh-CN 重新分析这张图。语言必须在分析开始前定下来，事后改语言只能重跑——本插件不会把英文 Caption 翻译成中文。'
          : '把 caption_language 设回 zh-CN，或重新用 en 分析这张图。',
      }),
    )
    return emptyCaption({ profile, language: wantedLanguage, facts, diagnostics })
  }

  const pool = (Array.isArray(facts) ? facts : [])
    .filter((fact) => fact && typeof fact.text === 'string' && fact.text.trim().length > 0 && !fact.dropped)
    .map((fact) => ({ ...fact, text: fact.text.trim() }))

  const byCategory = new Map()
  for (const fact of pool) {
    const key = String(fact.category ?? 'unsorted')
    if (!byCategory.has(key)) byCategory.set(key, [])
    byCategory.get(key).push(fact)
  }

  const sentences = []
  const clauses = []
  const used = []

  // `extraRefs` 给"这句话的依据不是某条事实、而是一个实体标签"的情况用：
  // 主体那句里的 `a girl` 来自 entity.label，标签本身就是观察，但没有对应的
  // fact 对象可挂。不传这一项，台账只能把它记成"没有依据"。
  const take = (role, text, factList = [], extraRefs = []) => {
    const body = String(text ?? '').trim()
    if (body.length === 0) return false
    if (sentences.length >= budget.maxSentences) return false
    sentences.push(body)
    clauses.push({
      role,
      text: body,
      tags: factList.map((fact) => fact.text),
      source_refs: dedupeRefs([...factList.flatMap((fact) => fact.source_refs ?? []), ...extraRefs]),
    })
    for (const fact of factList) if (!used.includes(fact)) used.push(fact)
    return true
  }

  const persons = (Array.isArray(ir?.entities) ? ir.entities : []).filter((entity) => entity?.kind === 'person')
  const rankedPersons = rankFacts(
    persons.map((entity) => ({ text: '', importance: entity?.importance ?? 0, entity })),
  ).map((entry) => entry.entity)
  const primary = rankedPersons[0] ?? null
  const subject = personPhrase(primary, wantedLanguage)
  const possessive = subject?.possessive ?? (zh ? '她的' : 'their')
  const pronoun = subject?.pronoun ?? (zh ? '她' : 'they')

  const pick = (category) => {
    const list = rankFacts(byCategory.get(category) ?? [])
    // 多人画面里，别人的外观不该被写成主体的外观。
    const scoped = subject?.entity_id
      ? list.filter((fact) => !fact.entity_id || fact.entity_id === subject.entity_id)
      : list
    return dropContained(scoped, wantedLanguage).slice(0, budget.perSection)
  }

  // 每个人自己的外观/服装观察。指称要用的"独一份发色"只能从这些观察里来。
  const factsByEntity = new Map()
  for (const fact of pool) {
    if (!fact.entity_id) continue
    const entry = factsByEntity.get(fact.entity_id) ?? { appearance: [], clothing: [] }
    if (fact.category === 'appearance' || fact.category === 'clothing') {
      entry[fact.category].push(fact)
    }
    factsByEntity.set(fact.entity_id, entry)
  }
  const personRefs = buildPersonRefs({ persons: rankedPersons, factsByEntity, language: wantedLanguage })
  const refById = new Map(personRefs.filter((ref) => ref.id).map((ref) => [ref.id, ref]))
  const multiPerson = personRefs.length > 1
  // 主体之外的人：关系句里必须能指名，否则「另一个女人的右手握着伞」会被写成
  // 「她右手握着伞」——把别人的动作算到主体头上，这是描述版最严重的错法。
  const others = personRefs.filter((ref) => ref.id && ref.id !== subject?.entity_id)
  // 一个人都没有可用特征、也没有任何关系时，它确实写不进 Caption；但那不是
  // "省略"，得说出来，不能让它静默消失。
  const omitted = { persons: [], relations: [], persons_without_facts: [] }

  const pickFor = (entityId, category) => {
    const list = (byCategory.get(category) ?? []).filter((fact) => fact.entity_id === entityId)
    return dropContained(rankFacts(list), wantedLanguage).slice(0, budget.perSection)
  }

  // ① 整体画面与主体
  const appearance = pick('appearance')
  const clothing = pick('clothing')
  const lead = typeof character === 'string' && character.trim().length > 0
    ? character.trim().replace(/_/g, ' ')
    : subject?.phrase ?? ''
  // 主体这句话的来源要跟着走。`a girl` 不是凭空来的：它来自实体标签，标签本身
  // 就是 IR 里的一条观察。不把这条 ref 挂上去，台账会报"这句话没有依据"。
  //
  // `subject.count` 那条顶层观察（`1girl`）也要认：实体标签常常只写 `girl`，
  // 人数在另一条观察里。两边按"人数 + 名词"对齐，不按整串字面比——
  // 字面比会让 `1girl` 与 `girl` 对不上，明明是同一件事。
  const subjectFacts = (() => {
    const total = subject?.total ?? 1
    const noun = String(subject?.noun ?? '').toLowerCase()
    if (noun === '') return []
    return pool.filter((fact) => {
      if (String(fact.category ?? '') !== 'subject') return false
      if (fact.entity_id && subject?.entity_id && fact.entity_id !== subject.entity_id) return false
      const match = /^(\d+)?\s*([a-z]+)$/i.exec(String(fact.text ?? '').trim())
      if (!match) return false
      const count = match[1] ? Number(match[1]) : 1
      const word = match[2].toLowerCase().replace(/s$/, '')
      return count === total && word === noun.replace(/s$/, '')
    })
  })()
  const subjectRefs = subject?.entity_id
    ? [{ kind: 'entity_label', entity_id: subject.entity_id, entity_kind: 'person' }]
    : []
  if (lead) {
    if (zh) {
      // 中文不补冠词，也不加 `with`：外观与服装用「有着」「穿着」并进同一句。
      // 不写成「画面中少女」——那不是句子，是标签换了标点。
      const bits = []
      if (appearance.length > 0) bits.push(`有着${joinListZh(appearance.map((fact) => fact.text))}`)
      if (clothing.length > 0) bits.push(`穿着${joinListZh(clothing.map((fact) => fact.text))}`)
      take(
        'subject',
        `画面中的主体是${lead}${bits.length > 0 ? `，${bits.join('，')}` : ''}。`,
        [...appearance, ...clothing, ...subjectFacts],
        subjectRefs,
      )
    } else {
      // `with ...` 直接挂在名词后面，不加逗号：`a girl, with silver hair` 会把外观写成插入语，
      // 读起来像另一个人。服装另起一段才用逗号。
      const bits = []
      if (appearance.length > 0) bits.push(`with ${joinList(appearance.map((fact) => fact.text))}`)
      if (clothing.length > 0) bits.push(`wearing ${joinList(clothing.map((fact) => withArticle(fact.text)))}`)
      const head = bits.length > 0 ? `${lead} ${bits[0]}` : lead
      const tail = bits.slice(1).join(', ')
      take(
        'subject',
        `The image shows ${head}${tail.length > 0 ? `, ${tail}` : ''}.`,
        [...appearance, ...clothing, ...subjectFacts],
        subjectRefs,
      )
    }
  } else {
    const firstEntity = (Array.isArray(ir?.entities) ? ir.entities : [])[0] ?? null
    const label = typeof firstEntity?.label === 'string' ? (zh ? firstEntity.label : withArticle(firstEntity.label)) : ''
    const backdrop = pick('background')[0] ?? null
    if (label) take('subject', zh ? `画面中${label}。` : `The image shows ${label}.`, [], subjectRefs)
    else if (backdrop) take('subject', zh ? `画面中${backdrop.text}。` : `The image shows ${withArticle(backdrop.text)}.`, [backdrop])
  }

  // ② 画面里的其他人
  // 主体句刻意只写主体的外观。但别人不是不存在：他们的外观、穿着不写出来，
  // 后面关系句里的「另一名女性」就没有出处，读者不知道那是谁。这里给他们各自一句。
  //
  // 不再有「最多两个人」的上限：上限是上一版的实现细节，第四个人被它静默吞掉了。
  // 真正写不下时由 `take()` 记账，最后在 `omitted` 与诊断里报出来。
  for (const entry of others) {
    const look = pickFor(entry.id, 'appearance')
    const wear = pickFor(entry.id, 'clothing')
    if (look.length === 0 && wear.length === 0) {
      omitted.persons_without_facts.push({ id: entry.id, label: entry.label })
      continue
    }    const bits = []
    if (look.length > 0) bits.push(zh ? `有着${joinListZh(look.map((fact) => fact.text))}` : `with ${joinList(look.map((fact) => fact.text))}`)
    if (wear.length > 0) bits.push(zh ? `穿着${joinListZh(wear.map((fact) => fact.text))}` : `wearing ${joinList(wear.map((fact) => withArticle(fact.text)))}`)
    const taken = take(
      'other_subject',
      zh
        ? `画面里还有${entry.intro}，${bits.join('，')}。`
        : `There is also ${entry.intro} ${bits.join(', ')}.`,
      [...look, ...wear],
      [{ kind: 'entity_label', entity_id: entry.id, entity_kind: 'person' }],
    )
    if (!taken) omitted.persons.push(entry.label)
  }

  // ③ 表情（跟主体同句太挤，单独一句）
  const expression = pick('expression')
  if (expression.length > 0 && (subject || lead)) {
    take(
      'expression',
      zh
        ? `${pronoun}的表情是${joinListZh(expression.map((fact) => fact.text))}。`
        : `${capitalize(pronoun)} has ${joinList(expression.map((fact) => withArticle(fact.text)))}.`,
      expression,
    )
  }

  // ④ 姿态与动作
  const pose = pick('pose_action').filter((fact) => !fact.relation_id)
  if (zh) {
    // 中文不逐条起句：三条姿态各起一句「姿态方面，……」读起来是清单，不是描述。
    // 合成一句、用逗号推进，才像人在说画面。
    const values = pose.map((fact) => stripTail(fact.text)).filter(Boolean)
    if (values.length > 0) take('pose_action', `${pronoun}${values.join('，')}。`, pose)
  } else {
    for (const fact of pose) {
      const value = fact.text
      if (GERUND_START.test(value)) {
        take('pose_action', `${capitalize(pronoun)} is ${value}.`, [fact])
        continue
      }
      const clause = bodyPartClause(value, possessive)
      if (clause) {
        take('pose_action', clause, [fact])
        continue
      }
      take('pose_action', `The pose is ${value}.`, [fact])
    }
  }

  // ⑤ 空间关系：谁握着什么、谁在谁身后。关系描述本身就是一句完整的话，别拆成两个名词。
  //
  // 一条关系有两个端点，两个都要用上：
  //   - 施动方是人（`P2 的右手拿着白伞`）→ 用施动方的指称补主语；
  //   - 施动方是东西（`棕色行李箱位于 P1 脚边`）→ 不补人物主语，但句子里的
  //     「她」必须落到关系另一端的那个人身上，否则读者不知道是谁的脚边。
  // 只按 `from` 决定称呼，就是上一版把「行李箱在她脚边」写成一团的原因。
  const relationFacts = rankFacts(pool.filter((fact) => fact.relation_id))
  // 关系不按 perSection 截：一个人一件事，四个人就是四条，那是画面的骨架。
  // 截到三条会让第四个人的动作凭空消失。真正的上限是整段的句子预算，
  // 由 `take()` 把关，写不下的逐条记进 `omitted.relations`。
  const relations = relationFacts
  const primaryRef = personRefs[0] ?? null
  for (const fact of relations) {
    const fromRef = fact.entity_id ? refById.get(fact.entity_id) ?? null : null
    const toRef = fact.target_entity_id ? refById.get(fact.target_entity_id) ?? null : null
    const fromIsThing = fact.entity_id !== null && fact.entity_kind !== null && fact.entity_kind !== 'person'
    // 代词归属：施动方是人就指施动方；施动方是东西时只能指另一端的那个。
    const pronounOwner = fromRef ?? (fromIsThing ? toRef : null)
    let value = zh ? stripTail(fact.text) : fact.text
    if (multiPerson) value = resolveRelationPronouns(value, { fromRef, toRef, fromIsThing, language: wantedLanguage })
    // 中文关系句常把人省成"放在脚边"，多人时得补出是谁的脚边。
    if (zh && multiPerson && fromIsThing && toRef) value = attachZhPossessor(value, toRef.label)
    // 补主语用谁的指称：施动方是人就用它的；施动方是东西时用主体——
    // 但那种情况根本不补人物主语（见下面的 `fromIsThing` 分支）。
    // 画面里只有一个人时不需要点名：主体段刚介绍过她，这里用「她的」才像人写的。
    const label = multiPerson ? (fromRef ? fromRef.label : primaryRef?.label ?? null) : null
    const head = zh ? label : label ? `${label}'s` : possessive
    // 描述本身以代词开头时补主语会变成「她她握着伞」：先把代词换成指称，
    // 换完还以代词开头（单人画面）就整句直接用。
    if ((LEADING_PRONOUN_EN.test(value) || LEADING_PRONOUN_ZH.test(value)) && multiPerson && pronounOwner) {
      value = replacePronouns(value, pronounOwner, wantedLanguage)
    }
    const stillPronoun = LEADING_PRONOUN_EN.test(value) || LEADING_PRONOUN_ZH.test(value)
    let sentence
    if (stillPronoun || fromIsThing) {
      sentence = zh ? `${value}。` : `${capitalize(value)}.`
    } else if (zh) {
      // 关系描述本身已经是完整动作（「右手握着伞柄」），补主语才成句。
      sentence = `${head ?? pronoun}${value}。`
    } else {
      const clause = bodyPartClause(value, head ?? possessive)
      if (clause) sentence = clause
      else if (GERUND_START.test(value)) sentence = `${capitalize(label ?? pronoun)} is ${value}.`
      else sentence = label ? `${capitalize(label)} ${value}.` : `${capitalize(value)}.`
    }
    const taken = take('relation', sentence, [fact])
    if (!taken) omitted.relations.push(fact.text)
  }

  // 没有外观也没有服装的人，只要在关系里出现过（谁把东西递给谁），就已经被写进
  // 画面了——那不算省略。剩下的才是真的没东西可写。
  const relationEntityIds = new Set()
  for (const fact of relationFacts) {
    if (fact.entity_id) relationEntityIds.add(fact.entity_id)
    if (fact.target_entity_id) relationEntityIds.add(fact.target_entity_id)
  }
  omitted.persons_without_facts = omitted.persons_without_facts
    .filter((entry) => !relationEntityIds.has(entry.id))
    .map((entry) => entry.label)

  // ⑥ 构图与镜头
  // 取景词（upper body / portrait / cowboy shot）本来就是修饰同一个取景框的定语，
  // 用 and 串起来会变成「一个上半身和一个肖像」。连写再补一次冠词才读得通。
  const framing = pick('composition')
  if (framing.length > 0) {
    if (zh) {
      take('composition', `构图是${joinListZh(framing.map((fact) => fact.text))}。`, framing)
    } else {
      const phrase = withArticle(framing.map((fact) => fact.text).join(' '))
      take('composition', `The framing is ${phrase}.`, framing)
    }
  }
  const camera = pick('camera')
  if (camera.length > 0) {
    take(
      'camera',
      zh
        ? `镜头角度是${joinListZh(camera.map((fact) => fact.text))}。`
        : `The camera angle is ${joinList(camera.map((fact) => fact.text))}.`,
      camera,
    )
  }

  // ⑦ 环境
  const background = pick('background')
  if (background.length > 0) {
    take(
      'background',
      zh
        ? `背景是${joinListZh(background.map((fact) => fact.text))}。`
        : `The background is ${joinList(background.map((fact) => withArticle(fact.text)))}.`,
      background,
    )
  }

  // ⑧ 光照与色彩：写成「被什么光照亮」而不是「光照是 overcast daylight」——
  // 后者是标签换个说法，前者才是描述。
  const lighting = pick('lighting_color')
  if (lighting.length > 0) {
    take(
      'lighting',
      zh
        ? `光线是${joinListZh(lighting.map((fact) => fact.text))}。`
        : `The scene is lit by ${joinList(lighting.map((fact) => fact.text))}.`,
      lighting,
    )
  }

  // ⑨ 风格：质量词与评级词不进 Caption——它们不描述画面，只描述"这张图有多好"。
  if (budget.style) {
    const style = pick('quality_style').filter((fact) => !QUALITY_WORD.test(fact.text) && !RATING_WORD.test(fact.text))
    if (style.length > 0) {
      take(
        'style',
        zh
          ? `风格是${joinListZh(style.map((fact) => fact.text))}。`
          : `The style is ${joinList(style.map((fact) => fact.text))}.`,
        style,
      )
    }
  }

  // ⑩ 画面文字：逐字保留原语言。
  if (budget.text) {
    for (const entry of collectImageText(ir).slice(0, budget.perSection)) {
      take('text', zh ? `画面里有文字「${entry.value}」。` : `The image contains the text "${entry.value}".`, entry.facts)
    }
  }

  const text = sentences.join(zh ? '' : ' ')
  // 主体短语本身也是依据：`1girl` 是 IR 的计数标签，写成 `a girl` 只换了词形，
  // 不算补内容。把 lead 一并交给核对，免得每个 Caption 都挂一条假警报。
  const groundingFacts = lead ? [...used, { text: lead }] : used
  // 指称是模板造的词（`the silver-haired woman` / `another man`），但每个词都回指着
  // 一条实体标签或外观观察。不列进来，台账会把"银发的那位"当成凭空补的描述。
  const refLabels = personRefs
    .flatMap((ref) => [ref.label, ref.noun, ref.hair].filter(Boolean))
    .map((item) => String(item))
  const grounding = verifyCaptionGrounding({
    text,
    facts: groundingFacts,
    clauses,
    language: wantedLanguage,
    extraLabels: lead ? [lead, ...refLabels] : refLabels,
  })
  const dropped = pool.filter((fact) => !used.includes(fact))
  const ok = text.length > 0

  if (!ok) {
    // 硬失败，不是降级：MOSS 档案的正稿只能是一段 Caption。退回标签流会让调用方
    // 以为拿到了 MOSS 能用的东西，实际送进去的是一串 Danbooru 词——那既不描述画面，
    // 也不在 MOSS 的训练分布里。宁可不给，也不给一个看起来成功的错东西。
    diagnostics.push(
      diagnostic({
        error_code: MOSS_CODES.CAPTION_EMPTY,
        severity: SEVERITY.ERROR,
        message: 'IR 里没有能写进 Caption 的事实，本次 MOSS 编译失败，没有生成任何提示词。',
        suggested_fix:
          '检查视觉分析是否产出了主体、构图、背景等观察，或 IR 里的观察是否全被否定式/占位符/测量值过滤掉了。',
      }),
    )
  } else if (!grounding.ok) {
    diagnostics.push(
      diagnostic({
        error_code: MOSS_CODES.CAPTION_UNGROUNDED,
        severity: SEVERITY.INFO,
        message: `Caption 里有 ${grounding.unsupported.length} 处内容对不上它的 IR 来源（${grounding.unsupported.slice(0, 12).join(' / ')}）。`,
        suggested_fix: '若这些是内容词，说明模板补了画面里没有的东西；若是语法骨架，把它加进对应的骨架表。',
      }),
    )
  }

  // 写不下的东西必须说出来。句子预算把某个人、某条关系挡在外面时，报「完整」
  // 就是在骗调用方：它会拿一份缺人缺关系的 Caption 当成完整描述。
  const complete = omitted.persons.length === 0 && omitted.relations.length === 0
  if (ok && !complete) {
    diagnostics.push(
      diagnostic({
        error_code: MOSS_CODES.CAPTION_TRUNCATED,
        severity: SEVERITY.WARNING,
        message: `Caption 未写全：省略 ${omitted.persons.length} 个人物、${omitted.relations.length} 条关系（句子上限 ${budget.maxSentences}）。`,
        suggested_fix: '把 detail_level 调高再编译，或减少画面里的实体与关系。',
      }),
    )
  }
  if (ok && omitted.persons_without_facts.length > 0) {
    diagnostics.push(
      diagnostic({
        error_code: MOSS_CODES.CAPTION_PERSON_UNDESCRIBED,
        severity: SEVERITY.INFO,
        message: `${omitted.persons_without_facts.length} 个人物在 IR 里没有任何外观或服装观察，写不进 Caption（${omitted.persons_without_facts.join(' / ')}）。`,
        suggested_fix: '这是观察缺失，不是描述遗漏。补上这些人的外观/服装观察才会写出来，不要为了凑齐人数去编造发色或服装。',
      }),
    )
  }

  return {
    schema_version: MOSS_SCHEMA_VERSION,
    register: MOSS_REGISTER,
    profile: profile?.config_id ?? null,
    language: wantedLanguage,
    ok,
    complete,
    omitted,
    person_refs: personRefs.map((ref) => ({
      id: ref.id,
      label: ref.label,
      unique_feature: ref.unique ? ref.hair : null,
    })),
    text,
    clauses,
    facts_used: used,
    facts_dropped: dropped,
    grounding,
    stats: {
      facts: pool.length,
      used: used.length,
      dropped: dropped.length,
      persons: personRefs.length,
      sentences: sentences.length,
      clauses: clauses.length,
      chars: text.length,
    },
    diagnostics,
  }
}

/** IR 里有没有"用户明确要求全年龄"的评级。只有用户声明才算，模型自己判的 safe 不算。 */
function sfwRequested(ir) {
  const check = (feature) => {
    if (!feature || typeof feature !== 'object') return false
    if (String(feature.category ?? '') !== 'quality_style') return false
    if (String(feature.key ?? '') !== 'rating') return false
    if (String(feature.source ?? '') !== 'user_correction') return false
    return /^(safe|general|sfw|all[-_ ]?ages)$/i.test(String(feature.value ?? '').trim())
  }
  if ((Array.isArray(ir?.features) ? ir.features : []).some(check)) return true
  for (const entity of Array.isArray(ir?.entities) ? ir.entities : []) {
    if ((Array.isArray(entity?.features) ? entity.features : []).some(check)) return true
  }
  return false
}

/**
 * MOSS 的负向编译。
 *
 * 只做三件事：拿档案里的短基线、在"用户明确要全年龄"时补 `nsfw`、把跟正文打架的条目让开。
 * 不套 Illustrious 的大段 Danbooru 负向，也不为了"看起来完整"往上涨条数。
 */
export function buildMossNegative({ ir = null, profile = {}, includeNegative = true, positiveText = '' } = {}) {
  const negative = profile?.tag_standard?.negative ?? {}
  const declared = Array.isArray(negative.terms) && negative.terms.length > 0 ? negative.terms : MOSS_NEGATIVE_BASE
  const maxTerms = Number.isInteger(negative.max_terms) && negative.max_terms > 0 ? negative.max_terms : 6
  const diagnostics = []
  const stats = { base: 0, sfw: 0, removed_contradictions: 0, truncated: 0, terms: 0 }
  const terms = []

  if (includeNegative === false) {
    return { text: '', terms, stats, diagnostics }
  }

  const seen = new Set()
  const push = (text, source) => {
    const value = String(text ?? '').trim()
    if (value.length === 0) return false
    const key = normalizePromptText(value)
    if (seen.has(key)) return false
    seen.add(key)
    terms.push({ text: value, source })
    return true
  }

  for (const text of declared) {
    if (push(text, 'profile')) stats.base += 1
  }
  if (sfwRequested(ir)) {
    if (push('nsfw', 'sfw')) {
      stats.sfw += 1
      diagnostics.push(
        diagnostic({
          error_code: MOSS_CODES.NEGATIVE_SFW_ADDED,
          severity: SEVERITY.INFO,
          message: 'IR 里有你声明的全年龄评级，负向已补上 nsfw。',
          suggested_fix: '这是显式要求才有的行为：模型自己判的 safe 不会触发它。',
        }),
      )
    }
  }

  // 正文已经写了的东西不能同时出现在负向里：MOSS 对自相矛盾的输入很敏感。
  const positive = new Set(wordsOf(positiveText))
  if (positive.size > 0) {
    for (let index = terms.length - 1; index >= 0; index -= 1) {
      const words = wordsOf(terms[index].text)
      if (words.length === 0) continue
      if (!words.every((word) => positive.has(word))) continue
      // 先取出来再删：splice 之后 terms[index] 已经是下一条，消息会写成空字符串。
      const removed = terms[index]
      terms.splice(index, 1)
      stats.removed_contradictions += 1
      diagnostics.push(
        diagnostic({
          error_code: MOSS_CODES.NEGATIVE_CONTRADICTION_REMOVED,
          severity: SEVERITY.INFO,
          message: `正文里已经写了「${removed.text}」，负向里的同名词已让开。`,
        }),
      )
    }
  }

  if (terms.length > maxTerms) {
    const droppedTerms = terms.splice(maxTerms)
    stats.truncated = droppedTerms.length
    diagnostics.push(
      diagnostic({
        error_code: MOSS_CODES.NEGATIVE_TRUNCATED,
        severity: SEVERITY.INFO,
        message: `负向超过 ${maxTerms} 条上限，丢弃 ${droppedTerms.length} 条：${droppedTerms.map((term) => term.text).join(', ')}。`,
        suggested_fix: 'MOSS 的负向保持短更好用；要加条目就说明这一条在排除什么。',
      }),
    )
  }

  stats.terms = terms.length
  return {
    text: terms.map((term) => term.text).join(', '),
    terms,
    stats,
    diagnostics,
  }
}
