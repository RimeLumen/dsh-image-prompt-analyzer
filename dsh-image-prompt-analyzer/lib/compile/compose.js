/**
 * 组合层：先有标签，再把标签拼成"提示词语言"。
 *
 * 这里做两件事，区别很重要：
 *
 * 1. `synthesizeRelationTerms` —— 把 IR 里已经分析出来的关系（holding / wearing / gaze …）
 *    压成**目标模型词表里真实存在的复合标签**，例如 `holding_umbrella`、`wearing_black_coat`。
 *    它输出的仍然是标签，只是从"一个名词"升级成"带着关系的标签"，因此可以安全地走
 *    slot → budget → render 这条既有链路，不会与档案的词表约定打架。
 *
 * 2. `composeFromIR` —— 面向自然语言优先的模型（Flux / MJ / GPT-Image）把标签串成分句。
 *    连接词只允许取自固定模板，内容词必须来自标签本身；`verifyGrounding` 会把不属于
 *    标签、也不属于连接词的词抓出来，避免"补全想象"混进提示词。
 *
 * 为什么不给 Animagine 用第 2 条：官方 Model Card 的 Limitations 明确写着
 * "Limited to tag-based text prompts; natural language input may not be effective"。
 * 它对纯标签最敏感，所以那条路径只该吃更规整的标签（即第 1 条）。
 */

import { defaultImportanceForCategory } from '../ir/index.js'
import { looksLikeTag, makeTerm, MAX_TAG_WORDS } from './terms.js'
import { normalizeTagName } from '../kb/index.js'
import { applyWordStyle } from './style.js'

export const COMPOSE_SCHEMA_VERSION = '1.0'

export const COMPOSE_CODES = Object.freeze({
  SYNTHESIZED_COMPOUND: 'COMPILE_SYNTHESIZED_COMPOUND',
  RELATION_NOT_COMPOSED: 'COMPILE_RELATION_NOT_COMPOSED',
  RELATION_COMPOUND_SKIPPED_ZH: 'COMPILE_RELATION_COMPOUND_SKIPPED_ZH',
  UNGROUNDED_PROSE: 'COMPOSE_UNGROUNDED_PROSE',
  NEGATED_OBSERVATION_DROPPED: 'COMPILE_NEGATED_OBSERVATION_DROPPED',
  CHARACTER_INJECTED: 'COMPILE_CHARACTER_INJECTED',
})

/** 关系类型 → 复合标签动词。没列出的关系不合成，避免造出不存在的词。 */
export const RELATION_COMPOUNDS = Object.freeze({
  holding: { verb: 'holding', category: 'pose_action' },
  wearing: { verb: 'wearing', category: 'clothing' },
  accessory: { verb: 'wearing', category: 'clothing' },
  gaze: { verb: 'looking_at', category: 'pose_action' },
  contact: { verb: 'touching', category: 'pose_action' },
})

export const MAX_COMPOUNDS = 6

/** 自然语言组合时允许出现的连接词与功能词；除此之外的词都必须能在标签里找到。 */
export const FUNCTION_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'with',
  'in',
  'on',
  'at',
  'of',
  'by',
  'from',
  'to',
  'into',
  'over',
  'under',
  'behind',
  'beside',
  'near',
  'through',
  'toward',
  'towards',
  'wearing',
  'holding',
  'lit',
  'shot',
  'seen',
  'viewed',
  'standing',
  'sitting',
  'seen',
  'while',
  'against',
])

const WORD_SPLIT = /[^a-z0-9]+/

/**
 * 计数词（1girl / 2boys / solo / multiple_girls）不是"被穿戴/被握持"的东西。
 * 它们属于主体计数，合成到关系里就变成 `wearing_1girl` 这种不存在的词。
 */
const COUNT_TAG_PATTERN = /^(?:\d+\+?(?:girl|boy|other)s?|solo|multiple_(?:girls|boys|others)|no_humans)$/

/**
 * 背景/地面/空气类名词不是被"穿"的东西。
 *
 * 模型常把画面底色、地板、背景板写进 clothing 分类（`smooth dark surface`），
 * 于是自然语言版出现 `wearing smooth dark surface` —— 生成时会把地板当布料画在身上。
 * 这类词留在 general 里描述环境没问题，但不能被 wearing 动词领走。
 */
const GROUND_NOUN_PATTERN = /\b(?:surface|floor|ground|backdrop|background|wall|sky|air|field|void|space|plane|gradient|glow|blur)\b/

function isGroundNoun(text) {
  return GROUND_NOUN_PATTERN.test(String(text ?? '').toLowerCase().replace(/_/g, ' '))
}

/**
 * 光影/材质类描述混进 clothing 分类时，同样不能被 wearing 领走。
 *
 * 实测会写出 `wearing glowing where backlit` —— 模型把"薄纱在逆光下发亮"挂到了
 * 服装分类上，于是自然语言版变成"穿着…发光"，生成端会给你一件发光衣服。
 * 判据不看分类看措辞：只要说的是"怎么被照亮"而不是"是什么东西"，就不加动词。
 */
const LIGHTING_PHRASE_PATTERN =
  /\b(?:lit|lighting|backlit|backlight|glowing|glow|illuminated|rim|halo|shadow|highlight|shading|specular|translucent|transparent|semi-gloss|matte|finish|tone|toned|contrast|bright|dark(?:est)?|soft|diffuse)\b/

/** 只要句子里真的点了衣物名词，就仍然算"穿着"，不能因为带了高光描述就被踢出 wearing。 */
const GARMENT_NOUN_PATTERN =
  /\b(?:dress|skirt|bodice|corset|boots?|shoes?|heels?|stockings?|thighhighs?|gloves?|cape|cloak|veil|ribbon|bra|panties|shirt|jacket|coat|armor|bikini|swimsuit|leotard|sleeves?|collar|belt|buckle|straps?|apron|hood|hat|tiara|crown|necklace|earrings?|choker|garter|ornament|hairband|bow)\b/

function isLightingPhrase(text) {
  const plain = String(text ?? '').toLowerCase().replace(/_/g, ' ')
  if (GARMENT_NOUN_PATTERN.test(plain)) return false
  return LIGHTING_PHRASE_PATTERN.test(plain)
}

/**
 * `wearing` 只领得动真正的衣物名词。
 *
 * 上面两条判据只管"不是地面、不是光照"，管不住另一类：观察层按 D6 写出来的
 * **服装结构描述**——`uneven diagonal hems` / `seam lines along the waist` /
 * `darker than the surrounding fabric` / `sitting below the skirt hem`。
 * 它们挂在 clothing 分类下完全正确，但都不是"一件被穿的东西"，于是自然语言版
 * 变成 `wearing uneven diagonal hems`、`wearing darker than the surrounding fabric`
 * ——读起来像在穿一条"比周围布料更深的衣服"。这类条目留在 detail 组描述细节就行。
 */
const WEARABLE_HEAD_PATTERN =
  /\b(?:dress(?:es)?|skirts?|overskirts?|underskirts?|bodices?|corsets?|boots?|shoes?|heels?|sandals?|stockings?|thighhighs?|socks?|gloves?|capes?|cloaks?|veil|ribbons?|bra|panties|shirts?|blouses?|jackets?|coats?|armor|bikinis?|swimsuits?|leotards?|sleeves?|collars?|belts?|buckles?|straps?|aprons?|hoods?|hats?|tiaras?|crowns?|necklaces?|earrings?|chokers?|garters?|ornaments?|hairbands?|bows?|tunic|robe|kimono|gown|pants|trousers|shorts|legwear|armlet|armband)\b/

/** 以分词或介词开头的短语不是名词短语，`wearing` 也领不动（`sitting below the skirt hem`）。 */
const NON_WEARABLE_OPENER_PATTERN =
  /^(?:[a-z]+ing\b|in\b|at\b|on\b|with\b|below\b|above\b|under\b|over\b|from\b|to\b|of\b|by\b|and\b|or\b|but\b|covers?\b|hangs?\b)/

/**
 * 短语的**头一个名词**是武器/道具时，整条不是"穿在身上的东西"。
 *
 * `sword worn at waist with strap` 里有 `strap`，光看"能不能命中衣物名词"会判成
 * 可穿，于是写出 `wearing sword worn at waist with strap` —— 佩剑被说成穿在身上的
 * 一件衣服。判定要看头一个实词，不能满句找。
 */
const PROP_HEAD_NOUN_PATTERN =
  /^(?:(?:a|an|the|his|her|its|their)\s+)?(?:sword|weapons?|blades?|hilt|hilted|scabbard|dagger|knife|spear|lance|staff|wand|pole|shield|bow|gun|pistol|rifle|book|lantern|umbrella|chain|mask)\b/

function isWearablePhrase(text) {
  const plain = String(text ?? '').toLowerCase().replace(/_/g, ' ')
  if (PROP_HEAD_NOUN_PATTERN.test(plain)) return false
  if (!WEARABLE_HEAD_PATTERN.test(plain)) return false
  return !NON_WEARABLE_OPENER_PATTERN.test(plain)
}

/** 场地/介质名词：这些才是 `in` 领得动的环境。 */
const IN_PLACE_NOUNS = Object.freeze([
  'background', 'backgrounds', 'void', 'space', 'room', 'field', 'air', 'atmosphere',
  'environment', 'scene', 'haze', 'fog', 'mist', 'smoke', 'shadow', 'shadows', 'darkness',
  'light', 'glow', 'gradient', 'backdrop', 'distance',
])

/** 承面名词：地板、地面、台面这些不是"在里面"的东西。 */
const ON_SURFACE_NOUNS = Object.freeze([
  'floor', 'ground', 'surface', 'pavement', 'platform', 'stage', 'wall', 'walls',
  'ceiling', 'plane', 'water', 'table',
])

/**
 * 环境句的介词：按句首那条观察的名词决定，判不出来就不加。
 *
 * 实测写出过 `in floor fading into glow` —— 地板不是"在里面"的东西，无脑给整组
 * 加 `in` 会造出这种读不通的句子。而 `floor fading into glow` 本身已经是完整的
 * 环境描述，不加介词反而更准确，所以承面名词直接返回空串。
 * 名词不一定在第一个词（`bright background`），所以看前几个词里出现的实词。
 */
function settingPrefix(list) {
  const head = String(list?.[0] ?? '').toLowerCase().replace(/_/g, ' ').trim()
  if (!head) return ''
  const tokens = head.split(/\s+/).filter(Boolean).slice(0, 4)
  if (tokens.some((token) => ON_SURFACE_NOUNS.includes(token))) return ''
  if (tokens.some((token) => IN_PLACE_NOUNS.includes(token))) return 'in'
  return ''
}

/**
 * 摘词之后留在句中的空连接词。
 *
 * 实测写出过 `ankle-height boots with and buckles`：中间那个名词被上游按词表剔掉，
 * `with` 与 `and` 就贴到一起，读起来像漏字。这类残迹不是观察内容，纯属语法噪声，
 * 在进句子之前就抹掉。
 */
const DANGLING_CONNECTOR_PATTERNS = Object.freeze([
  /\b(with|without|of|in|on|at|from|to|by|across|under|beneath|against)\s+(?:and|or)\b/gi,
  /\b(and|or)\s+(?:and|or)\b/gi,
])

function repairConnectors(text) {
  let out = String(text ?? '')
  for (const pattern of DANGLING_CONNECTOR_PATTERNS) out = out.replace(pattern, '$1')
  return out.replace(/\s+/g, ' ').trim()
}

/** 条目文本按需修连词：没坏的原样返回，保住下划线写法的标签名。 */
function repairEntryText(text) {
  const raw = String(text ?? '')
  const plain = raw.replace(/_/g, ' ')
  const dangling = DANGLING_CONNECTOR_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(plain)
  })
  return dangling ? repairConnectors(plain) : raw
}

/**
 * `lit by` 只领得动真正的光源。
 *
 * 光影分组（lighting_color）里混着两类东西：一类是发光体（`strong backlight`、
 * `diffuse single source`、`bloom around the light source`），一类是**画质属性**
 * （`greyscale`、`low contrast`、`lifted shadows`、`washed out blacks`）。
 * 一律加动词就写出 `lit by greyscale`、`lit by washed out blacks` —— 像是被"灰阶"
 * 照亮。属性词单独成句，不加动词。
 */
const LIGHT_SOURCE_PATTERN =
  /\b(?:backlit|backlight(?:ing)?|rim[-\s]?lit|rim light|key light|fill light|side light|top light|light source|single source|spotlight|sunlight|moonlight|lamplight|window light|candlelight|neon|glow|bloom|halo|flare|beams?|rays?)\b/

/** 出现这些词说明说的是"画面看起来怎么样"，不是"光从哪来"。 */
const LIGHT_QUALITY_PATTERN =
  /\b(?:scattering|haze|hazy|contrast|tonal|tones?|toned|greyscale|greys|grays|blacks?|shadows?|range|scale|values?|accents?|tint|surface|focus|rolloff|gradient|reflection|glossy|veil)\b/

function isLightSourcePhrase(text) {
  const plain = String(text ?? '').toLowerCase().replace(/_/g, ' ')
  if (!LIGHT_SOURCE_PATTERN.test(plain)) return false
  return !LIGHT_QUALITY_PATTERN.test(plain)
}

/**
 * 关系宾语能不能被这个动词领走。
 *
 * 人不是物品（`wearing woman`）、计数词不是物品（`wearing 1girl`），
 * 而"被穿"的宾语还必须在观察里真的出现过服装类特征 —— 只有背景/材质特征的实体
 * （地板、光斑）不该被 wearing 领走。
 */
function relationObjectRejection(rule, entity) {
  if (entity?.kind === 'person') return 'object_is_person'
  if (rule?.category !== 'clothing') return null
  // 武器/道具不能"穿"。剑实体的特征里常带一条被归进 clothing 的 `weapon`，
  // 于是下面的 `object_not_wearable` 拦不住，关系合成会写出 `wearing_sword`
  // ——词表里没有这个词，读的人只会把佩在腰侧的剑当成一件衣服。
  const objectLabel = String(entity?.label ?? '').toLowerCase().replace(/_/g, ' ').trim()
  if (objectLabel && PROP_HEAD_NOUN_PATTERN.test(objectLabel)) return 'object_is_prop'
  const features = Array.isArray(entity?.features) ? entity.features : []
  if (features.length === 0) return null
  const wearable = features.some((feature) => String(feature?.category ?? '') === 'clothing')
  return wearable ? null : 'object_not_wearable'
}

// 关系模板里用到的动词（holding / wearing / looking at / touching）属于句法连接词，
// 不是观察内容：它们不该在 grounding 校验里被当成"越权词"抓出来。
for (const rule of Object.values(RELATION_COMPOUNDS)) {
  for (const word of String(rule.verb ?? '').split(WORD_SPLIT)) {
    if (word.length > 0) FUNCTION_WORDS.add(word)
  }
}

function words(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(WORD_SPLIT)
    .filter(Boolean)
}

function entityById(ir) {
  const map = new Map()
  for (const entity of Array.isArray(ir?.entities) ? ir.entities : []) {
    if (entity?.entity_id) map.set(entity.entity_id, entity)
  }
  return map
}

// 强关系：主体真的"穿着/握着"某物。弱关系（接触、注视）在同一对主体上再合成一次，
// 就会得到 wearing_boots + touching_boots 这种互相打架的一对标签。
const STRONG_RELATIONS = new Set(['holding', 'wearing', 'accessory'])
const WEAK_RELATIONS = new Set(['contact', 'gaze'])

function hasStrongerRelation(relations, relation) {
  return relations.some(
    (other) =>
      other !== relation &&
      other?.from === relation?.from &&
      other?.to === relation?.to &&
      STRONG_RELATIONS.has(other?.type),
  )
}

function labelTag(entity) {
  const label = typeof entity?.label === 'string' ? entity.label.trim() : ''
  if (!label || !looksLikeTag(label)) return null
  const tag = normalizeTagName(label)
  if (!tag) return null
  // 计数词不是物品：`wearing_1girl` 这种复合标签在词表里不存在，只会污染正向词。
  if (COUNT_TAG_PATTERN.test(tag)) return null
  const parts = tag.split('_').filter(Boolean)
  // 只接单词名词：Danbooru 的动词复合标签是 holding_umbrella 这种形状，
  // 强行拼 holding_transparent_umbrella 会造出词表里没有的词，宁可放弃合成。
  if (parts.length !== 1) return null
  return tag
}

/**
 * 把实体关系压成复合标签。只有满足下面全部条件才合成：
 * 关系类型在白名单里、两端实体都有可用标签、目标标签是 1–2 个词、结果不与已有标签重复。
 */
export function synthesizeRelationTerms(ir, { terms = [], language = 'en' } = {}) {
  const entities = entityById(ir)
  const existing = new Set(
    (Array.isArray(terms) ? terms : []).map((term) => normalizeTagName(term?.text ?? '')).filter(Boolean),
  )
  const produced = []
  const skipped = []
  const seen = new Set()
  const relations = Array.isArray(ir?.relations) ? ir.relations : []

  // 每条被放弃的关系都要带上自己的身份：台账要能回答"这条关系为什么没进提示词"，
  // 只记 type 的话同一类型有多条关系时就分不清是哪一条没的。
  const skipFor = (relation, detail) => ({
    ...detail,
    type: relation?.type ?? null,
    relation_id: relation?.relation_id ?? null,
    ref: {
      origin: 'relation',
      category: 'relation',
      key: `relation:${relation?.type ?? ''}`,
      relation_id: relation?.relation_id ?? null,
      entity_id: relation?.from ?? null,
    },
  })

  // 复合标签的模板本身是英文：`holding_umbrella` 这种形状来自 Danbooru 的动词前缀。
  // 拿中文物体标签去套，只会拼出 `holding_黑伞`——两种语言缝在一起，任何词表里都不存在。
  // 所以中文观察下干脆不合成：关系已经由 Caption 里的中文句子承担，标签通道不需要它。
  if (language === 'zh-CN') {
    return { terms: [], skipped: relations.map((relation) => skipFor(relation, { reason: 'non_english_compound' })) }
  }

  for (const relation of relations) {
    const rule = RELATION_COMPOUNDS[relation?.type]
    if (!rule) {
      skipped.push(skipFor(relation, { reason: 'unsupported_type' }))
      continue
    }
    // 弱关系让位给强关系：已经 wearing_boots 了，就不该再合成 touching_boots。
    if (WEAK_RELATIONS.has(relation.type) && hasStrongerRelation(relations, relation)) {
      skipped.push(skipFor(relation, { reason: 'weaker_relation' }))
      continue
    }
    const from = entities.get(relation?.from)
    const to = entities.get(relation?.to)
    if (!from || !to) {
      skipped.push(skipFor(relation, { reason: 'unknown_entity' }))
      continue
    }
    // 人不是"物品"：`wearing_woman` / `holding_girl` 这类合成词在词表里不存在。
    // 人和人之间的关系（拥抱、对视）该由 pose_action 的观察句承担，不该塞进复合标签。
    const rejection = relationObjectRejection(rule, to)
    if (rejection) {
      skipped.push(skipFor(relation, { reason: rejection, entity_id: to.entity_id ?? null }))
      continue
    }
    const objectTag = labelTag(to)
    if (!objectTag) {
      skipped.push(skipFor(relation, { reason: 'unusable_object_label', entity_id: to.entity_id ?? null }))
      continue
    }

    const text = `${rule.verb}_${objectTag}`
    const parts = text.split('_').filter(Boolean)
    if (parts.length > MAX_TAG_WORDS) {
      skipped.push(skipFor(relation, { reason: 'too_many_words', text }))
      continue
    }
    if (existing.has(text) || seen.has(text)) {
      skipped.push(skipFor(relation, { reason: 'duplicate', text }))
      continue
    }
    if (produced.length >= MAX_COMPOUNDS) {
      skipped.push(skipFor(relation, { reason: 'limit', text }))
      continue
    }

    seen.add(text)
    const confidence = typeof relation?.confidence === 'number' ? relation.confidence : 0.7
    produced.push(
      makeTerm({
        text,
        raw_value: text,
        category: rule.category,
        key: `relation:${relation.type}`,
        origin: 'composition',
        entity_id: from.entity_id ?? null,
        source: 'global_analysis',
        confidence,
        importance: Math.min(defaultImportanceForCategory(rule.category), confidence) * 0.9,
        status: confidence >= 0.7 ? 'confirmed' : 'tentative',
        // 关系自带的说明文字是"为什么这么连"的注解，不是"这个词太长当不了标签"的标记。
        // 塞进 description 会让 assignSlots 把 wearing_dress 这类合法复合标签当成句子丢掉。
        detail: relation?.description ?? null,
        description: null,
      }),
    )
  }

  return { terms: produced, skipped }
}

const SLOT_AS_CATEGORY = new Map([
  ['count', 'count'],
  ['character', 'character'],
  ['series', 'series'],
  ['subject', 'subject'],
  ['clothing', 'clothing'],
  ['appearance', 'appearance'],
  ['pose_action', 'pose_action'],
  ['expression', 'expression'],
  ['background', 'background'],
  ['lighting', 'lighting_color'],
  ['quality', 'quality'],
  ['score', 'quality'],
  ['rating', 'quality'],
])

/** 把已分槽的 term 摊平：槽位只作兜底，词自带 category 时以 category 为准。 */
function toPairs(slots) {
  if (Array.isArray(slots)) return slots
  if (slots instanceof Map) return [...slots.entries()]
  if (Array.isArray(slots?.slots)) return slots.slots
  return []
}

function entriesFromSlots(slots) {
  const out = []
  for (const entry of toPairs(slots)) {
    const [slot, terms] = Array.isArray(entry) ? entry : [entry?.slot, entry?.terms]
    for (const term of Array.isArray(terms) ? terms : []) {
      const text = typeof term === 'string' ? term : term?.text
      if (typeof text !== 'string' || !text.trim()) continue
      const category = (typeof term === 'object' && term?.category) || SLOT_AS_CATEGORY.get(slot) || 'unsorted'
      out.push({ text: repairEntryText(text.trim()), category, slot })
    }
  }
  return out
}

function groupEntries(entries, allowedTexts) {
  const groups = new Map()
  for (const entry of entries) {
    // extra 是"进不了标签、只能进句子"的描述性观察：它本来就不在渲染结果里，
    // 用 allowedTexts 过滤它等于把长句观察又丢一次。
    if (allowedTexts && entry.extra !== true && !allowedTexts.has(normalizeTagName(stripWeights(entry.text)))) continue
    if (!groups.has(entry.category)) groups.set(entry.category, [])
    const list = groups.get(entry.category)
    if (!list.includes(entry.text)) list.push(entry.text)
  }
  return groups
}

function all(groups, categories) {
  const out = []
  for (const category of categories) {
    for (const text of groups.get(category) ?? []) {
      if (!out.includes(text)) out.push(text)
    }
  }
  return out
}

/** 一句话最多背 6 个短语，超了就另起一句：既不丢词，也不写出读不下去的长句。 */
function chunk(list, size = 6) {
  const out = []
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size))
  return out
}

const VERB_COMPOUND = /^(holding|wearing|looking_at|touching)_/

/** 去掉权重语法：(from_below:1.1) → from_below。成分句里权重没有意义。 */
function stripWeights(text) {
  return String(text ?? '').replace(/\(([^()]+):(\d+(?:\.\d+)?)\)/g, '$1')
}

function spaced(text) {
  return repairConnectors(stripWeights(text).replace(/_/g, ' '))
}

/**
 * 判断"包含"时不参与比较的词。
 *
 * `face in shadow` 与 `face obscured by shadow` 说的是同一件事，但前者多了个 `in`、
 * 后者多了个 `by`，按字面比永远比不上。介词、冠词、连接词不承载观察内容，
 * 拿掉之后再比词集，才是在比"这两句到底说没说同一件事"。
 */
const CONTENT_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'from', 'by',
  'with', 'without', 'for', 'as', 'into', 'onto', 'over', 'under', 'near',
  'where', 'which', 'that', 'its', 'it', 'her', 'his', 'their',
])

export function contentWords(text) {
  return new Set(
    spaced(text)
      .toLowerCase()
      .split(/[^a-z0-9'-]+/)
      .filter((word) => word.length > 0 && !CONTENT_STOPWORDS.has(word)),
  )
}

/**
 * 一个短语是不是另一个短语的碎片：内容词被完全包含，且对方更长。
 *
 * 导出给测试用——"正稿里每条标签都要出现在句子里"这条铁律现在允许一种例外：
 * 标签是句子里某个更长短语的碎片。判定必须与去重时用的是同一套逻辑，
 * 否则测试和实现会各说各话。
 */
export function isFragmentOf(short, long) {
  const own = contentWords(short)
  if (own.size < 2) return false
  const theirs = contentWords(long)
  if (theirs.size <= own.size) return false
  for (const word of own) if (!theirs.has(word)) return false
  return true
}

/**
 * 同一句里被更长短语完全包含的碎片。
 *
 * `1girl, light toned, long light toned hair` 这种写法里，`light toned` 一个字的
 * 新信息都没有——后半句已经把它说完了。生成端读到的是同一件事的两次陈述，
 * 各读一半，反而把"头发是浅色的"这条摊薄；它还白占了上下文。
 *
 * 只在**同一句内**比：跨句的包含（`full body` 与 `full body vertical framing`）
 * 分别属于主体与取景两件事，各自都有存在理由，不能在这里动。
 *
 * 只有一个内容词的短语不参与判定（`sword`、`glowing`、`haze`）：它们不是谁的碎片，
 * 是独立实体或独立属性，删掉就真的丢了观察。
 */
function dropContainedFragments(texts) {
  if (texts.length < 2) return texts
  return texts.filter((text, index) => {
    const absorbed = texts.some((other, otherIndex) => {
      if (otherIndex === index) return false
      return isFragmentOf(text, other)
    })
    return !absorbed
  })
}

/**
 * 面向自然语言优先模型的成分句。
 * 铁律：进入正稿的每一条标签都必须出现在句子里——宁可句子长，也不许悄悄丢词。
 */
export function composeClauses({ ir, terms, slots, entries: presetEntries = null, allowedTexts = null, extras = [] } = {}) {
  const base = Array.isArray(presetEntries) ? presetEntries : toPairs(slots).length > 0 ? entriesFromSlots(slots) : Array.isArray(terms) ? terms : []
  // 描述性观察（>6 词的长句）进不了标签流，但它们是句子里最有信息量的部分，
  // 必须补进来——否则用户看到的自然语言版会缺掉"动作/介质"这些最需要句子表达的内容。
  const extraEntries = (Array.isArray(extras) ? extras : [])
    .map((entry) => {
      const text = typeof entry === 'string' ? entry : entry?.text
      if (typeof text !== 'string' || !text.trim()) return null
      const category = (typeof entry === 'object' && entry?.category) || 'unsorted'
      return { text: repairEntryText(text.trim()), category, slot: null, extra: true }
    })
    .filter(Boolean)
  const entries = extraEntries.length > 0 ? [...base, ...extraEntries] : base
  const groups = groupEntries(entries, allowedTexts)
  const clauses = []
  const entities = entityById(ir)

  const compounds = new Set()
  for (const [, list] of groups) {
    for (const text of list) if (VERB_COMPOUND.test(text)) compounds.add(normalizeTagName(text))
  }

  const spoken = new Set()
  // 关系句与 clothing 段经常是同一件衣服：关系的 label 是短名（corset-like bodice），
  // clothing 段是带定语的长写法（fitted corset-like bodice）。两句都留着等于把
  // 同一件衣服说两遍，生成端各读一半，反而把"穿的是什么"摊薄。
  const clothingPlain = all(groups, ['clothing'])
    .filter((text) => !VERB_COMPOUND.test(text))
    .map((text) => normalizeTagName(text).replace(/_/g, ' '))
  const coveredByClothing = (label) => {
    const plain = label.replace(/_/g, ' ')
    if (!plain) return false
    return clothingPlain.some((text) => text === plain || text.includes(plain))
  }
  const relationClauses = []
  for (const relation of Array.isArray(ir?.relations) ? ir.relations : []) {
    const rule = RELATION_COMPOUNDS[relation?.type]
    if (!rule) continue
    const to = entities.get(relation?.to)
    const label = typeof to?.label === 'string' ? normalizeTagName(to.label) : ''
    if (!label) continue
    if (relationObjectRejection(rule, to)) continue
    if (COUNT_TAG_PATTERN.test(label)) continue
    if (!looksLikeTag(label)) continue
    if (label.split('_').filter(Boolean).length > 2) continue
    if (allowedTexts && !allowedTexts.has(label)) continue
    spoken.add(label)
    if (compounds.has(`${rule.verb}_${label}`)) continue
    if (rule.verb === 'wearing' && coveredByClothing(label)) continue
    relationClauses.push({ role: 'relation', text: `${rule.verb} ${spaced(label)}`, tags: [label] })
  }

  const push = (role, texts, decorate = (list) => list.map(spaced).join(', ')) => {
    // 先把同句内被更长短语包含的碎片摘掉，再切块：切块之后两半分别成句，
    // 就再也看不出谁是谁的碎片了。
    const clean = dropContainedFragments(texts.filter((text) => text.length > 0))
    if (clean.length === 0) return
    for (const part of chunk(clean)) clauses.push({ role, text: decorate(part), tags: part })
  }

  push('subject', all(groups, ['count', 'character', 'series', 'subject']))
  // 分级词（safe / sensitive）紧跟主体，是检索式提示词的惯例位置。
  push('rating', all(groups, ['rating']))
  push('action', all(groups, ['pose_action']))
  push('expression', all(groups, ['expression']))
  clauses.push(...relationClauses)

  const clothingTerms = all(groups, ['clothing']).filter((text) => !VERB_COMPOUND.test(text))
  // 分错类的"服装"：地板/背景板/空气被写进 clothing 时不能加 wearing 动词，
  // 但要留在句子里（它是画面的真实观察），所以降级到 detail 组。
  // 服装**结构**描述同理（`seam lines along the waist` 不是一件衣服），一并降级。
  const wearable = clothingTerms.filter(
    (text) => !isGroundNoun(text) && !isLightingPhrase(text) && isWearablePhrase(text),
  )
  const misplacedClothing = clothingTerms.filter((text) => !wearable.includes(text))
  push('clothing', wearable, (list) => `wearing ${list.map(spaced).join(', ')}`)

  const props = all(groups, ['appearance', 'unsorted']).filter((text) => !VERB_COMPOUND.test(text))
  push('detail', [...props, ...misplacedClothing].filter((text) => !spoken.has(normalizeTagName(text))))

  push('setting', all(groups, ['background']), (list) => {
    const prefix = settingPrefix(list)
    const body = list.map(spaced).join(', ')
    return prefix ? `${prefix} ${body}` : body
  })
  const lightingTerms = all(groups, ['lighting_color'])
  const lightSources = lightingTerms.filter((text) => isLightSourcePhrase(text))
  const lightQualities = lightingTerms.filter((text) => !lightSources.includes(text))
  push('lighting', lightSources, (list) => `lit by ${list.map(spaced).join(', ')}`)
  push('lighting', lightQualities)

  push('camera', all(groups, ['camera', 'composition']), (list) =>
    list.map((tag) => (tag.startsWith('from_') ? `shot ${spaced(tag)}` : spaced(tag))).join(', '),
  )

  // 风格与技术特征、质量词合并成最后一组：质量词本来就不用单独成句。
  push('style', all(groups, ['quality_style', 'quality', 'score', 'meta']))

  return dedupeClauses(clauses)
}

/**
 * 成分句去重。
 *
 * 同一条观察经常在两处出现：`standing in an abstract bright void`（主体句）与
 * `in abstract bright void`（环境句），`off-shoulder corset bodice with straps` 与
 * `off-shoulder corset bodice`，`long translucent veil ribbons with cross motifs` 出现在
 * 服装句与细节句。自然语言里重复同一件事不会加强约束，只会让句子读起来像口吃，
 * 还白占上下文——所以"被更长句完整包含"的短句直接删掉，同句内被包含的标签也删掉。
 */
function dedupeClauses(clauses) {
  const normalized = clauses.map((clause) => ({
    clause,
    text: String(clause?.text ?? '').toLowerCase().replace(/\s+/g, ' ').trim(),
  }))
  const kept = []
  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index]
    const covered = normalized.some((other, otherIndex) => {
      if (otherIndex === index) return false
      if (other.text === current.text) return otherIndex < index
      if (other.text.length <= current.text.length) return false
      return other.text.includes(current.text)
    })
    if (!covered) kept.push(current.clause)
  }
  return kept
}

export function renderClauseText(clauses) {
  return (Array.isArray(clauses) ? clauses : [])
    .map((clause) => String(clause?.text ?? '').trim())
    .filter(Boolean)
    .join(', ')
}

/** 找出既不属于标签、也不属于连接词的"凭空多出来的词"。 */
export function verifyGrounding({ text, tags } = {}) {
  const vocabulary = new Set()
  for (const tag of Array.isArray(tags) ? tags : []) {
    for (const word of words(String(tag ?? '').replace(/_/g, ' '))) vocabulary.add(word)
  }
  const ungrounded = []
  for (const word of words(String(text ?? '').replace(/_/g, ' '))) {
    if (word.length < 2) continue
    if (FUNCTION_WORDS.has(word)) continue
    if (vocabulary.has(word)) continue
    if (!ungrounded.includes(word)) ungrounded.push(word)
  }
  return { ok: ungrounded.length === 0, ungrounded }
}

function isTagOnlyProfile(profile) {
  const wordStyle = profile?.tag_standard?.word_style
  return wordStyle === 'underscored' || wordStyle === 'spaced'
}

/**
 * 混合模式：标签负责“命中”，句子负责“说清楚”。
 *
 * - 标签：计数、角色、作品、画师、分级、质量词，以及两词以内的原子属性
 *   （`1girl` / `silver hair` / `black coat`）——这些是 Danbooru 语料里最稳的写法。
 * - 句子：动作、构图、光影、色彩、长材质描述——这些用标签写会碎成一堆名词，
 *   只有连成句子才能表达关系。
 *
 * 质量词永远收尾，主体永远开头：两端的顺序对 SDXL 系模型的注意力最敏感。
 */
export function composeFromIR({ ir = null, profile = {}, terms = [], slots = [], segments = [], extras = [] } = {}) {
  const allowedTexts = new Set()
  const list = Array.isArray(segments) ? segments : []
  for (const segment of list) {
    for (const text of Array.isArray(segment?.terms) ? segment.terms : []) {
      if (typeof text === 'string' && text.trim()) allowedTexts.add(normalizeTagName(stripWeights(text)))
    }
  }
  // 只要走过渲染，就以渲染结果为准：被预算裁掉的标签不该在句子里复活。
  const source = list.length > 0 ? allowedTexts : null
  const clauses = composeClauses({ ir, terms, slots, allowedTexts: source, extras })
  const text = renderClauseText(clauses)
  // clause.tags 内部是归一化写法（下划线），对外要按档案的 word_style 落字：
  // 标签型底模的分词器把下划线当独立符号，多出来的 token 全是浪费。
  const tagStyle = profile?.tag_standard?.word_style
  const tags = [...new Set(clauses.flatMap((clause) => clause.tags))].map((tag) => applyWordStyle(tag, tagStyle))
  const grounding = verifyGrounding({ text, tags })

  return {
    schema_version: COMPOSE_SCHEMA_VERSION,
    register: 'clause',
    tags,
    clauses,
    text,
    grounding,
    prose_supported: !isTagOnlyProfile(profile),
    note: isTagOnlyProfile(profile)
      ? '目标模型是标签型（Animagine / Illustrious 这类）。官方 Model Card 明确说自然语言输入效果有限，所以给它的正稿仍然是标签；这段成分句只作阅读与改写参考。'
      : null,
  }
}