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
import { CAPTION_LANGUAGES } from '../model-profile/schema.js'
import { isNegatedObservation, isPlaceholderObservation } from './terms.js'
import { normalizePromptText } from './fidelity.js'

export const MOSS_SCHEMA_VERSION = '1.0'

/** 编译结果的 register 值：`tag` = 标签流，`clause` = 成分句，`caption` = 完整 Caption。 */
export const MOSS_REGISTER = 'caption'

export const MOSS_CODES = Object.freeze({
  CAPTION_EMPTY: 'COMPILE_MOSS_CAPTION_EMPTY',
  CAPTION_UNGROUNDED: 'COMPILE_MOSS_CAPTION_UNGROUNDED',
  CAPTION_LANGUAGE_UNSUPPORTED: 'COMPILE_MOSS_CAPTION_LANGUAGE_UNSUPPORTED',
  NEGATIVE_SFW_ADDED: 'COMPILE_MOSS_NEGATIVE_SFW_ADDED',
  NEGATIVE_CONTRADICTION_REMOVED: 'COMPILE_MOSS_NEGATIVE_CONTRADICTION_REMOVED',
  NEGATIVE_TRUNCATED: 'COMPILE_MOSS_NEGATIVE_TRUNCATED',
})

/**
 * 能可靠产出的 Caption 语言。
 *
 * 只有英语。不是没做，是做不了：IR 的观察值全部是英语（视觉阶段就是这么被要求的），
 * 本地 `res/` 里只有两份 Danbooru 标签表，没有任何中英对照资源。想输出中文，只有
 * 两条路——再加一次 LLM 翻译，或者逐词替换——前者违反"不增加 AI 调用"，后者会把
 * `silver hair` 拼成「银头发」这种既不是中文也不是英语的东西。两条都不做。
 *
 * 留着这个常量是为了让"要中文"这件事**明确失败**，而不是悄悄给一段英文。
 * 清单本体放在 `model-profile/schema.js`：档案校验也要用它，档案层不该反过来依赖编译器。
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

function wordsOf(value) {
  return normalizePromptText(value).split(' ').filter(Boolean)
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

function personPhrase(entity) {
  if (!entity || typeof entity !== 'object') return null
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
function dropContained(list) {
  const kept = []
  for (const fact of list) {
    const words = new Set(wordsOf(fact.text))
    if (words.size < 2) {
      kept.push(fact)
      continue
    }
    const swallowed = kept.some((other) => {
      const otherWords = new Set(wordsOf(other.text))
      if (otherWords.size <= words.size) return false
      return [...words].every((word) => otherWords.has(word))
    })
    if (!swallowed) kept.push(fact)
  }
  return kept.filter((fact) => {
    const words = new Set(wordsOf(fact.text))
    if (words.size < 2) return true
    return !kept.some((other) => {
      if (other === fact) return false
      const otherWords = new Set(wordsOf(other.text))
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
export function verifyCaptionGrounding({ text, facts } = {}) {
  const factWords = new Set()
  const factForms = new Set()
  for (const fact of Array.isArray(facts) ? facts : []) {
    for (const word of wordsOf(fact?.text)) {
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
  const wantedLanguage = String(language ?? profile?.tag_standard?.caption_language ?? 'en').trim() || 'en'

  if (!MOSS_CAPTION_LANGUAGES.includes(wantedLanguage)) {
    diagnostics.push(
      diagnostic({
        error_code: MOSS_CODES.CAPTION_LANGUAGE_UNSUPPORTED,
        severity: SEVERITY.ERROR,
        field_path: '/tag_standard/caption_language',
        message: `Caption 只有英语可用，请求的语言是 ${wantedLanguage}。`,
        suggested_fix:
          'IR 的观察值全是英语，本地也没有中英对照资源；要出中文只能再加一次翻译调用，那是本插件明确不做的。把 caption_language 设回 en。',
      }),
    )
    return {
      schema_version: MOSS_SCHEMA_VERSION,
      register: MOSS_REGISTER,
      profile: profile?.config_id ?? null,
      language: wantedLanguage,
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
  const primary = rankFacts(persons.map((entity) => ({ text: '', importance: entity?.importance ?? 0, entity })))[0]?.entity ?? persons[0] ?? null
  const subject = personPhrase(primary)
  const possessive = subject?.possessive ?? 'their'
  const pronoun = subject?.pronoun ?? 'they'

  const pick = (category) => {
    const list = rankFacts(byCategory.get(category) ?? [])
    // 多人画面里，别人的外观不该被写成主体的外观。
    const scoped = subject?.entity_id
      ? list.filter((fact) => !fact.entity_id || fact.entity_id === subject.entity_id)
      : list
    return dropContained(scoped).slice(0, budget.perSection)
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
  } else {
    const firstEntity = (Array.isArray(ir?.entities) ? ir.entities : [])[0] ?? null
    const label = typeof firstEntity?.label === 'string' ? withArticle(firstEntity.label) : ''
    const backdrop = pick('background')[0] ?? null
    if (label) take('subject', `The image shows ${label}.`, [], subjectRefs)
    else if (backdrop) take('subject', `The image shows ${withArticle(backdrop.text)}.`, [backdrop])
  }

  // ② 表情（跟主体同句太挤，单独一句）
  const expression = pick('expression')
  if (expression.length > 0 && (subject || lead)) {
    take('expression', `${capitalize(pronoun)} has ${joinList(expression.map((fact) => withArticle(fact.text)))}.`, expression)
  }

  // ③ 姿态与动作
  const pose = pick('pose_action').filter((fact) => !fact.relation_id)
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

  // ④ 空间关系：谁握着什么、谁在谁身后。关系描述本身就是一句完整的话，别拆成两个名词。
  const relations = rankFacts(pool.filter((fact) => fact.relation_id)).slice(0, budget.perSection)
  for (const fact of relations) {
    const value = fact.text
    const clause = bodyPartClause(value, possessive)
    if (clause) {
      take('relation', clause, [fact])
      continue
    }
    if (GERUND_START.test(value)) {
      take('relation', `${capitalize(pronoun)} is ${value}.`, [fact])
      continue
    }
    take('relation', `${capitalize(value)}.`, [fact])
  }

  // ⑤ 构图与镜头
  // 取景词（upper body / portrait / cowboy shot）本来就是修饰同一个取景框的定语，
  // 用 and 串起来会变成「一个上半身和一个肖像」。连写再补一次冠词才读得通。
  const framing = pick('composition')
  if (framing.length > 0) {
    const phrase = withArticle(framing.map((fact) => fact.text).join(' '))
    take('composition', `The framing is ${phrase}.`, framing)
  }
  const camera = pick('camera')
  if (camera.length > 0) {
    take('camera', `The camera angle is ${joinList(camera.map((fact) => fact.text))}.`, camera)
  }

  // ⑥ 环境
  const background = pick('background')
  if (background.length > 0) {
    take('background', `The background is ${joinList(background.map((fact) => withArticle(fact.text)))}.`, background)
  }

  // ⑦ 光照与色彩：写成「被什么光照亮」而不是「光照是 overcast daylight」——
  // 后者是标签换个说法，前者才是描述。
  const lighting = pick('lighting_color')
  if (lighting.length > 0) {
    take('lighting', `The scene is lit by ${joinList(lighting.map((fact) => fact.text))}.`, lighting)
  }

  // ⑧ 风格：质量词与评级词不进 Caption——它们不描述画面，只描述"这张图有多好"。
  if (budget.style) {
    const style = pick('quality_style').filter((fact) => !QUALITY_WORD.test(fact.text) && !RATING_WORD.test(fact.text))
    if (style.length > 0) {
      take('style', `The style is ${joinList(style.map((fact) => fact.text))}.`, style)
    }
  }

  // ⑨ 画面文字：逐字保留原语言。
  if (budget.text) {
    for (const entry of collectImageText(ir).slice(0, budget.perSection)) {
      take('text', `The image contains the text "${entry.value}".`, entry.facts)
    }
  }

  const text = sentences.join(' ')
  // 主体短语本身也是依据：`1girl` 是 IR 的计数标签，写成 `a girl` 只换了词形，
  // 不算补内容。把 lead 一并交给核对，免得每个 Caption 都挂一条假警报。
  const groundingFacts = lead ? [...used, { text: lead }] : used
  const grounding = verifyCaptionGrounding({ text, facts: groundingFacts })
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
        message: `Caption 里有 ${grounding.unsupported.length} 个词不在任何 IR 事实里（${grounding.unsupported.slice(0, 12).join(', ')}）。`,
        suggested_fix: '若这些词是内容词，说明模板补了画面里没有的东西；若是语法骨架，把它加进 CAPTION_SCAFFOLDING。',
      }),
    )
  }

  return {
    schema_version: MOSS_SCHEMA_VERSION,
    register: MOSS_REGISTER,
    profile: profile?.config_id ?? null,
    language: wantedLanguage,
    ok,
    text,
    clauses,
    facts_used: used,
    facts_dropped: dropped,
    grounding,
    stats: {
      facts: pool.length,
      used: used.length,
      dropped: dropped.length,
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
