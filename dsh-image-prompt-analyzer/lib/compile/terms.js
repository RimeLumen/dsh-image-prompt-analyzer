
import { collectFeatures, defaultImportanceForCategory } from '../ir/index.js'
import { CATEGORY_IDS, layerOf } from '../config/index.js'
import { normalizeTagName, SCORE_TAG_PATTERN } from '../kb/index.js'
import { synthesizePoseTags } from './pose-tags.js'

export const TERM_ORIGINS = Object.freeze({ FEATURE: 'feature', ENTITY: 'entity' })

export const MAX_TAG_WORDS = 6

const SENTENCE_PUNCTUATION = /[.!?;:。！？；：]/

/**
 * 逗号（含中文逗号、顿号）说明这个 value 里塞了不止一个观察。
 *
 * 一条标签里带逗号从来不是合法语法：它会被压成 `1girl,_back_to_viewer` 这种伪标签，
 * 既丢了后面那半截的语义，又让去重认不出来（`1girl` 于是重复出现两次）。
 * 这里判成“不像标签”，交给 splitDescriptionPhrases 拆开。
 */
const MULTI_VALUE_PUNCTUATION = /[,，、]/

export function looksLikeTag(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return true
  if (typeof value === 'boolean') return false
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (text.length === 0 || text.length > 80) return false
  if (SENTENCE_PUNCTUATION.test(text)) return false
  if (MULTI_VALUE_PUNCTUATION.test(text)) return false
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length > MAX_TAG_WORDS) return false
  return true
}

/**
 * 否定式观察不能进正向词。
 *
 * 扩散模型读不懂"没有"：正向提示词里的 `no grain` / `no fog` / `fingers not discernible`
 * 会被当成"grain / fog / discernible fingers"的强提示——越写越有。而模型在描述
 * 剪影、纯色背景、干净线条时恰恰最爱写这类句子，于是"干净的图"反而被写上噪点、
 * 被写上雾。这不是某张图的问题，是所有"主体干净/空气干净/细节不可辨"的图共有的缺陷。
 *
 * 处理原则：正向词只承载"有什么"。确实要排除的东西属于 negative 通道，不在这里凭空生成
 * （我们无法确定目标词表是否接受反向对应词），所以这里只做剔除，并留下诊断说明剔了什么。
 */
const NEGATION_PATTERNS = Object.freeze([
  /^(?:no|not|none|nothing|without|zero|lacks?|lacking|free of|absence of|devoid of)(?:\s|$)/i,
  /(?:^|\s)(?:not|no longer)\s+(?:visible|discernible|present|detectable|apparent|legible|readable)(?:\s|$)/i,
  /(?:^|\s)(?:is|are|was|were)\s+(?:absent|missing|invisible|indiscernible)(?:\s|$)/i,
  /(?:cannot|can't)\s+(?:be\s+)?\s*(?:seen|discerned|determined)(?:\s|$)/i,
])

/**
 * 中文的否定式。
 *
 * 中文模式里观察值由模型直接写中文，英文正则一条都命中不了，于是「画面里没有剑」
 * 会被当成一条普通观察收进 IR，再被 Caption 原样写成「画面里没有剑」——
 * 提示词里出现否定句是最坏的一种幻觉：模型会把「剑」画出来。
 *
 * 只认明确的否定句式，不认「空」「无」这类单字（「空旷」不是否定）。
 */
const NEGATION_PATTERNS_ZH = Object.freeze([
  /^(?:没有|没看到|看不到|看不见|未见|不存在|缺少|缺少了|不含|不包含|未出现)/,
  /(?:画面|图中|图里|照片里|镜头里)(?:中|内|里)?(?:没有|没看到|看不到|看不见|未见|不存在)/,
  // 「画面里没有人群」「远处看不到人」两种语序都要认：否定词可能跟在方位词后，
  // 也可能被地点状语隔开。少了这一条，`画面里没有人群` 会被当成一条普通背景观察。
  /(?:没有|没看到|看不到|看不见|未见|不存在)(?:任何|什么)?(?:人|人群|人影|观众|旁人)/,
  /(?:被|给)?(?:裁掉|切掉|裁出画面|挡在画面外|在画面之外|在画外|不在画面内?)/,
  /(?:不可见|看不清|无法看清|无法辨认|辨认不出)/,
])

/**
 * "不知道"不是观察。
 *
 * 模型拿不准时会写 unknown / indeterminate / not sure / n/a，这些词一旦进正向词，
 * 就等于在提示词里写了一串无意义的占位符（还会把预算挤掉）。它们该出现在
 * uncertainties 里，不该出现在 feature.value 里。
 */
const PLACEHOLDER_TOKENS = new Set([
  'unknown', 'unsure', 'unclear', 'indeterminate', 'indeterminable', 'undetermined',
  'unidentified', 'unspecified', 'na', 'none', 'null', 'tbd', 'ambiguous', 'uncertain',
])

/** 中文占位词。模型写「未知」「看不清」和写 unknown 是一回事，都该进 uncertainties。 */
const PLACEHOLDER_TOKENS_ZH = new Set([
  '未知', '不详', '不确定', '无法确定', '看不出来', '看不清', '难以判断', '无法判断',
  '不明确', '待定', '无法辨认', '模糊不清', '不明',
])

export function isPlaceholderObservation(text) {
  const value = String(text ?? '').trim().toLowerCase()
  if (value.length === 0) return true
  if (PLACEHOLDER_TOKENS_ZH.has(value.replace(/[。．.，,、；;！!？?\s]/g, ''))) return true
  // "n/a"、"n.a."、"unknown." 这类写法先归一成字母串再比。
  if (PLACEHOLDER_TOKENS.has(value.replace(/[^a-z]/g, ''))) return true
  const parts = value.split(/[^a-z0-9]+/).filter(Boolean)
  if (parts.length === 0) return false
  // 整条就是占位符，或"某物 type indeterminate"这种以占位符收尾的短语。
  if (parts.every((part) => PLACEHOLDER_TOKENS.has(part))) return true
  const last = parts[parts.length - 1]
  return PLACEHOLDER_TOKENS.has(last) && parts.length <= 3
}

/** Danbooru 里确实存在的"no X"标签，不能当否定式删掉。 */
const NEGATION_ALLOWLIST = new Set(['no humans'])

export function isNegatedObservation(text) {
  const value = String(text ?? '').trim()
  if (value.length === 0) return false
  const lowered = value.toLowerCase()
  if (NEGATION_ALLOWLIST.has(lowered)) return false
  if (NEGATION_PATTERNS.some((pattern) => pattern.test(value))) return true
  return NEGATION_PATTERNS_ZH.some((pattern) => pattern.test(value))
}

export function toDescriptionText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value
      .map((item) => toDescriptionText(item))
      .filter((item) => item.length > 0)
      .join(' / ')
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * 模型有时候会写出"centered composition, full body, symmetric backlight halo"这种
 * 多短语描述。以前这类值会被塞进 description 字段，然后在分槽阶段被静默跳过——
 * 用户看到的就是"观察明明有，提示词里却没有"。
 *
 * 这里把它拆成若干可渲染的短语：按逗号/分号切开，去掉括号补充，各自限长。
 * 词库认不认识这些短语都无所谓，原样保留才能保住画面细节。
 *
 * 限长不能靠 `slice(0, maxWords)` 硬砍：一句
 * "figure rendered as a uniform near-black solid fill with no internal modelling"
 * 砍到 9 个词，尾巴会留在 "with" 上，前半句成了半截话、后半句整个丢掉。
 * 所以先在连接词前切段，再按词数打包，硬切只当兜底。
 */
/**
 * 分数要先还原成词，再参与切分。
 *
 * 模型描述姿态最常写 "turned 3/4 toward the right"（四分之三侧身）。斜杠在我们的分隔符里，
 * 直接切会切成 "turned 3" 和 "4 toward the right" 两个残片——数字进提示词毫无意义，
 * 方向也被劈成两半。这类写法是通用句式，不是某张图的偶然，所以在这里统一还原。
 */
const FRACTION_WORDS = Object.freeze({
  '1/4': 'quarter',
  '1/2': 'half',
  '3/4': 'three-quarter',
  '1/3': 'one-third',
  '2/3': 'two-thirds',
  '1/8': 'one-eighth',
})

function expandFractions(text) {
  return String(text ?? '').replace(/(\d)\s*\/\s*(\d)/g, (whole, a, b) => {
    const known = FRACTION_WORDS[`${a}/${b}`]
    if (known) return ` ${known} `
    // 不认识的分数（比如 5/6）与其把数字塞进提示词，不如整段丢掉：
    // 后面 trimEdgeWords 会把悬空的 "of the frame" 削成 "frame"，信息不丢、噪声也没了。
    return ' '
  })
}

/**
 * 对账用的归一：和编译层把观察变成标签时用同一套改写。
 *
 * `turned 3/4` 在正向词里写成 `turned three-quarter`，如果对账拿原话去比，
 * 一条明明写进去了的姿态会被报成"消失且没有 dropped 记录"，
 * 用户按提示去调预算也调不好——因为问题根本不在预算。
 */
export function comparisonValue(value) {
  return stripOrdinalPrefix(expandFractions(String(value ?? '')))
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim()
}

/** 纯数字/纯符号的碎片不是标签：`turned 3` 里的 3、单独一个 "-" 都该丢掉。 */
function isNumberFragment(phrase) {
  return !/[a-z]/i.test(phrase)
}

/**
 * 孤立数字不是观察。
 *
 * 模型写角度/比例时会留下裸数字（`turned 3`、`4 toward the right`、`70 %`），这些数字进了
 * 正向词既不会被词表认识，还会占掉预算。带字母的编号（`1girl`、`2boys`、`4k`）要保留，
 * 所以只剔"整词就是数字"的那些。
 */
function stripBareDigits(words) {
  return words.filter((word) => !/^\d{1,4}$/.test(word) && /[a-z0-9]/i.test(word))
}

/**
 * 序数枚举不是标签的一部分。
 *
 * 模型写"画面层次"时爱用 `first read is the black figure mass, second the hair streamer,
 * third the veils`，也爱把序数甩在句尾：`near black figure read first, hair strands second,
 * veil third`。序数只是它在列表里的位置，进了正向词就变成无意义的前缀/后缀
 * （`hair strands second` 既不是词表里的标签，也会让同一件事的两次描述去不了重）。
 * 这里把序数连同 "read is" 这类引导语削掉，只留被描述的东西本身。
 *
 * `first person view` / `third eye` 是词表里的正经标签，不能被当成序数削掉。
 */
const ORDINAL_PREFIX =
  /^(?:first|second|third|fourth|fifth|sixth|1st|2nd|3rd|4th|5th|6th)\b(?:\s+(?:read|reads|reading|thing|layer|element|level))?\s*(?:is|are|was|were)?\s*/i
const ORDINAL_SUFFIX =
  /(?:\s+(?:read|reads|reading))?\s+(?:first|second|third|fourth|fifth|sixth|1st|2nd|3rd|4th|5th|6th)$/i

/** 序数词本身就是词的一部分的真标签，不能削。 */
const ORDINAL_KEEP = /^(?:first|1st)[- ]person|^third[- ]eye/i

/** 削完序数后只清理残留的冠词/物主词——不能整用 EDGE_FUNCTION_WORDS，
 *  那会把 `near black figure` 的 "near" 也削掉，意思就从"近黑"变成"黑"。 */
const LEADING_DETERMINERS = new Set(['the', 'a', 'an', 'its', 'her', 'his', 'their', 'this', 'that'])

export function stripOrdinalPrefix(text) {
  const value = String(text ?? '').trim()
  if (value.length === 0) return value
  if (ORDINAL_KEEP.test(value)) return value
  let out = value
  const prefix = out.match(ORDINAL_PREFIX)
  if (prefix) out = out.slice(prefix[0].length)
  // 句尾的序数（`veil third`）同样只是列表位置，削掉后还剩词就继续削。
  for (let guard = 0; guard < 2; guard += 1) {
    const suffix = out.match(ORDINAL_SUFFIX)
    if (!suffix) break
    const cut = out.slice(0, suffix.index).trim()
    if (cut.length === 0) {
      out = ''
      break
    }
    out = cut
  }
  let words = out.split(/\s+/).filter(Boolean)
  while (words.length > 1 && LEADING_DETERMINERS.has(words[0].toLowerCase())) words = words.slice(1)
  if (words.length === 0 || (words.length === 1 && LEADING_DETERMINERS.has(words[0].toLowerCase()))) return ''
  return words.join(' ')
}

/**
 * 关系词：它们必须有一个先行词才成句。
 *
 * 实测掉出过 `edges where backlit`。源观察是
 * `sheer translucent fabric panels glowing along their edges where backlit`：
 * `packWords` 在 `along` 处切开，`trimEdgeTokens` 又把续接段的 `along their` 当虚词削掉，
 * 剩下 `edges where backlit` —— `where` 指代的 `glowing along their` 已经不在这一段里，
 * 于是它成了一个没有从句的相对副词。
 *
 * 这类残句不是"压缩得短"，是语法上就不成立：它没有可归属的内容，
 * 而 `edges` 单独一个词又是纯骨架词（见 PHRASE_ANCHOR_WORDS），留着只是噪声。
 */
const RELATIVE_CLAUSE_WORDS = new Set([
  'where', 'when', 'whenever', 'wherever', 'whereby', 'whose', 'whilst', 'which', 'that', 'who',
])

/** 从一个词序列里找第一个"不是首词"的关系词，返回它之前的部分。 */
function cutAtRelativeClause(words) {
  const index = words.findIndex((word, i) => i > 0 && RELATIVE_CLAUSE_WORDS.has(String(word).toLowerCase()))
  if (index < 0) return { words, cut: false }
  return { words: words.slice(0, index), cut: true }
}

/** 只剩一个骨架词时，它不成短语。 */
function isBareAnchor(text) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean)
  return words.length === 1 && PHRASE_ANCHOR_WORDS.has(words[0].toLowerCase())
}

export function splitDescriptionPhrases(text, { limit = 6, maxWords = 9, onDrop = null } = {}) {
  const parts = expandFractions(text)
    // 冒号是模型写“总述：分述”的常见格式（`three flat layers: figure, floor, reflection`）。
    // 冒号本身不是标签语法，留着会把一个标签变成半句标题 + 半句残片。
    .split(/[,;:，；：、/|]+/)
    .map((part) =>
      part
        .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, ' ')
        .replace(/[（()）【】\[\]]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((part) => part.length > 0)
    .map((part) => stripOrdinalPrefix(part))
    .filter((part) => part.length > 0)
  const phrases = []
  for (const part of parts) {
    const words = stripBareDigits(part.split(' ').filter(Boolean))
    for (const chunk of packWords(words, maxWords)) {
      const head = trimEdgeWords(chunk).join(' ')
      if (head.length === 0) continue
      // 关系从句没有先行词时截掉从句；截完只剩骨架词就整条丢掉并记账。
      const relative = cutAtRelativeClause(head.split(' '))
      const trimmed = relative.cut ? trimEdgeWords(relative.words).join(' ') : head
      if (relative.cut && (trimmed.length === 0 || isBareAnchor(trimmed))) {
        if (typeof onDrop === 'function') onDrop({ text: head, reason: 'dangling_relative_clause', kept: trimmed })
        continue
      }
      if (trimmed.length === 0 || isNumberFragment(trimmed) || phrases.includes(trimmed)) continue
      phrases.push(trimmed)
      if (phrases.length >= limit) break
    }
    if (phrases.length >= limit) break
  }
  return phrases
}

/**
 * 只有方向词的观察是碎片，不是标签。
 *
 * 模型写朝向时常写 "3/4 to the right, left hand holding the sword" 这种句子，
 * 断句之后会掉出一个孤零零的 `left`。它在词表里不是一个能生成东西的标签，
 * 只会白占预算；而真正表达朝向的短语（`facing left` / `turned to the right`）本身完整，
 * 不依赖这个碎片。所以整条短语只剩方向词时直接剔掉。
 */
const DIRECTION_WORDS = new Set([
  'left', 'right', 'up', 'down', 'front', 'back', 'above', 'below', 'side',
  'center', 'centre', 'middle', 'top', 'bottom', 'forward', 'backward', 'sideways',
  'here', 'there', 'near', 'far', 'inner', 'outer',
])

export function isFragmentObservation(value) {
  if (typeof value !== 'string') return false
  const words = value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return false
  return words.every((word) => DIRECTION_WORDS.has(word))
}

/**
 * 量化陈述不是标签。
 *
 * 模型描述构图时会写 `headroom 7 percent`、`symmetry 0.89`、`subject occupies 8 percent of frame area`
 * 这类带数字的测量句。数字进了标签流会被"裸数字清洗"剔掉，剩下的 `headroom percent`
 * 就成了没有指代的残句 —— 既不进词表，又占预算，还让对账以为这条观察已经落地。
 * 这类句子的信息属于"构图比例"，正确的去处是 description（自然语言版）与像素预检，
 * 不是正向标签。所以整条短语按 measurement 丢掉，而不是把数字抠掉留个空壳。
 *
 * 有数字但没有单位、且不是测量词的照旧保留：`1girl`、`2boys`、`3d`、`4k`、`year 2024` 都是正经标签。
 */
const MEASUREMENT_UNIT = /\d+(?:\.\d+)?\s*(?:%|percent\b|per\s+cent\b|degrees?\b|deg\b|px\b)|\bpercent\b|\bper\s+cent\b/i
const MEASUREMENT_NOUN =
  /^(?:symmetry|headroom|margins?|ratio|offset|proportion|proportions|share|area|score|percentage|(?:subject\s+)?bbox|(?:subject\s+)?bounding\s+box|coordinates?|coords?)\b/i
/**
 * 归一化坐标串：`0.16-0.72 x 0.07-1.00`。
 * 模型报主体框时会写这种纯数字对，没有单位也没有测量词，
 * 但它是量测不是外观描述 —— 进正向词只会变成一串读不懂的数字。
 */
const MEASUREMENT_RANGE = /\b\d+(?:\.\d+)?\s*[-\u2013]\s*\d+(?:\.\d+)?\s*[x\u00d7]\s*\d+(?:\.\d+)?\s*[-\u2013]\s*\d+(?:\.\d+)?/i

export function isMeasurementPhrase(value) {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (text.length === 0) return false
  if (MEASUREMENT_UNIT.test(text)) return true
  if (MEASUREMENT_RANGE.test(text)) return true
  // 以小数开头的写法（`0.89 symmetry`、`0.5 offset`）同样是量测：
  // 词表里没有以小数点开头的标签，进了正向只会变成一串读不懂的数字。
  if (/^\d*\.\d+\b/.test(text)) return true
  // 句中夹着小数的量测（`minimum luminance 0.24`、`most pixels above 0.78 luminance`）：
  // 0–1 之间的裸小数在标签流里没有意义，只可能来自测量。`2.5d` 这类真标签以整数开头，不会被误伤。
  if (/\b0?\.\d+\b/.test(text)) return true
  if (!/\d/.test(text)) {
    // 数字已经被上游剔掉的残句：只剩测量词本身（`headroom percent` / `symmetry`）。
    return /^(?:symmetry|headroom|margins?|ratio|offset|proportion|percentage|area|score)(?:\s+(?:percent|%|ratio|value|number))?$/i.test(
      text,
    )
  }
  return MEASUREMENT_NOUN.test(text)
}

/** 断句用的连接词：在它们前面切开，比在词中间砍断更像人话。 */
const CLAUSE_BREAKERS = new Set([
  'with', 'without', 'in', 'into', 'on', 'onto', 'at', 'of', 'by', 'from', 'over',
  'across', 'under', 'beneath', 'against', 'while', 'and', 'but', 'as', 'around',
  'through', 'behind', 'beside', 'near', 'toward', 'towards', 'between',
  // 方位介词同样是断句点：`bright void above a reflective floor` 若不在这里切开，
  // 超长时会在词中间硬断，掉出 `... above a reflective` 这种半截短语。
  'above', 'below', 'along', 'inside', 'outside', 'beyond', 'upon', 'within', 'past', 'via',
])

/** 只起语法作用、单独留下就是废话的词。 */
const EDGE_FUNCTION_WORDS = new Set([
  ...CLAUSE_BREAKERS,
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'being', 'been',
  'its', 'it', 'her', 'his', 'their', 'that', 'which', 'who', 'whom',
  'to', 'for', 'than', 'then', 'very', 'slightly', 'mostly', 'almost', 'both',
])

function trimEdgeWords(words) {
  return trimEdgeTokens(words)
}

/**
 * 剥重复词时不许动的"锚词"。
 *
 * 剥词的目的是"同一件事说两遍"，但实现只按词面匹配：只要某个词单独成了一条
 * 标签，长短语里的同名 token 就一起被剥掉。于是真跑里出现了
 * `right shoulder forward and nearer to the camera` → `right forward and nearer to the camera`、
 * `left shoulder pulled back` → `left pulled back`、`thick luminous haze` → `thick luminous`。
 * 剥完的短语不成话，生成端读不出"哪侧肩在前"，侧身这条就白观察了。
 *
 * 身体部位与画面介质名词是短语的骨架：单独成标签时它们本来就没什么信息量
 * （`shoulder`、`head` 这种裸词进正向只是噪声），该丢的是裸词，不是短语里的锚。
 */
const PHRASE_ANCHOR_WORDS = new Set([
  // 身体与朝向
  'head', 'face', 'neck', 'chin', 'jaw', 'shoulder', 'shoulders', 'torso', 'waist',
  'chest', 'back', 'hip', 'hips', 'arm', 'arms', 'hand', 'hands', 'finger', 'fingers',
  'leg', 'legs', 'thigh', 'thighs', 'knee', 'knees', 'elbow', 'wrist', 'ankle', 'foot', 'feet',
  'eye', 'eyes', 'mouth', 'hair', 'profile', 'posture',
  // 画面介质与环境
  'haze', 'light', 'glow', 'shadow', 'highlight', 'background', 'void', 'figure',
  'veil', 'air', 'outline', 'edge', 'edges', 'floor', 'reflection', 'gradient', 'tone',
])

/** 削掉首尾只起语法作用的词（空格写法与下划线写法共用）。 */
function trimEdgeTokens(words) {
  let start = 0
  let end = words.length
  while (start < end && EDGE_FUNCTION_WORDS.has(words[start].toLowerCase())) start += 1
  while (end > start && EDGE_FUNCTION_WORDS.has(words[end - 1].toLowerCase())) end -= 1
  return words.slice(start, end)
}

function packWords(words, maxWords) {
  const segments = []
  let current = []
  for (const word of words) {
    if (current.length > 0 && CLAUSE_BREAKERS.has(word.toLowerCase())) {
      segments.push(current)
      current = []
    }
    current.push(word)
  }
  if (current.length > 0) segments.push(current)

  const chunks = []
  let packed = []
  for (const segment of segments) {
    if (packed.length > 0 && packed.length + segment.length > maxWords) {
      chunks.push(packed)
      packed = []
    }
    if (segment.length > maxWords) {
      // 均分而不是“先切满再收尾”：7 个词按 6 切会掉出 1 个词的残片（`floor`），
      // 前一段还会停在形容词上（`... above a reflective`）。均分成 4+3 两边都完整。
      const count = Math.ceil(segment.length / maxWords)
      const size = Math.ceil(segment.length / count)
      for (let index = 0; index < segment.length; index += size) {
        chunks.push(segment.slice(index, index + size))
      }
      continue
    }
    packed.push(...segment)
  }
  if (packed.length > 0) chunks.push(packed)
  return chunks
}

export function makeTerm(input = {}) {
  const category = CATEGORY_IDS.has(input.category) ? input.category : 'unsorted'
  return {
    text: input.text ?? '',
    raw_value: input.raw_value ?? null,
    category,
    layer: layerOf(category),
    key: input.key ?? null,
    origin: input.origin ?? TERM_ORIGINS.FEATURE,
    entity_id: input.entity_id ?? null,
    // 同一 `category.key` 的第几条。身份撞车时靠它区分，缺省 0（即不写后缀）。
    occurrence: Number.isInteger(input.occurrence) && input.occurrence > 0 ? input.occurrence : 0,
    source: input.source ?? 'global_analysis',
    confidence: typeof input.confidence === 'number' ? input.confidence : null,
    importance:
      typeof input.importance === 'number' ? input.importance : defaultImportanceForCategory(category),
    status: input.status ?? 'tentative',
    region: Array.isArray(input.region) ? input.region : null,
    description: input.description ?? null,
    detail: input.detail ?? null,
    kb: null,
    display: null,
    weight: null,
    notes: [],
  }
}

/**
 * 一个 value 里塞了多个观察时，当成一句话拆分。
 *
 * 逗号是最典型的分隔（"sheer chiffon veil, matte fabric bodice"），
 * 超长（> MAX_TAG_WORDS 词）也说明它不是在描述一个标签，而是一句描述。
 * 不拆的话整句会被压成一条带下划线的伪标签，模型既读不懂也学不到。
 */
export function shouldSplitValue(value) {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (text.length === 0) return false
  if (/[,;；，、]/.test(text)) return true
  return text.split(/\s+/).filter(Boolean).length > MAX_TAG_WORDS
}

export function collectTerms(ir, { priorityOverrides = {} } = {}) {
  const terms = []
  const skipped = []
  const negated = []

  const importanceFor = (category, given) => {
    if (typeof given === 'number') return given
    if (typeof priorityOverrides?.[category] === 'number') return priorityOverrides[category]
    return defaultImportanceForCategory(category)
  }

  const featureFields = (feature, category, key) => ({
    category,
    key,
    origin: TERM_ORIGINS.FEATURE,
    entity_id: feature?.entity_id ?? null,
    occurrence: feature?.occurrence ?? 0,
    source: feature?.source,
    confidence: feature?.confidence,
    importance: importanceFor(category, feature?.importance),
    status: feature?.status,
    region: feature?.region,
  })

  const entityFields = (entity, category) => ({
    category,
    key: 'entity_label',
    origin: TERM_ORIGINS.ENTITY,
    entity_id: entity?.entity_id ?? null,
    source: 'global_analysis',
    confidence: entity?.confidence,
    importance: importanceFor(category, entity?.importance),
    region: entity?.region,
  })

  for (const feature of collectFeatures(ir)) {
    const category = CATEGORY_IDS.has(feature?.category) ? feature.category : 'unsorted'
    const rawValue = feature?.value
    // 序数前缀只削掉“列表位置”，原始值仍留在 raw_value 里给对账与诊断用。
    const value = typeof rawValue === 'string' ? stripOrdinalPrefix(rawValue) : rawValue
    const key = typeof feature?.key === 'string' ? feature.key : null
    // 同一 `category.key` 的第几条。丢弃记录也要带上它，否则三条同名观察里
    // "哪一条被挡掉了"只能记成"这三条里有一条被挡掉了"。
    const occurrence = Number.isInteger(feature?.occurrence) && feature.occurrence > 0 ? feature.occurrence : 0

    if (typeof value === 'boolean') {
      skipped.push({ reason: 'non_text_value', category, key, occurrence })
      continue
    }

    if (!looksLikeTag(value) || shouldSplitValue(value)) {
      const text = toDescriptionText(value)
      if (text.length === 0) {
        skipped.push({ reason: 'empty_value', category, key, occurrence })
        continue
      }
      // 描述性观察不丢：拆成短语分别作为词条，原句留在 detail 里备查。
      // 拆的时候可能掉出没有先行词的关系从句（`edges where backlit`），
      // 这类残句必须留一条记录，否则"少了一句"就只能靠拿原话去成品里找词来猜。
      const phrases = splitDescriptionPhrases(text, {
        onDrop: (item) => skipped.push({ reason: item.reason, category, key, occurrence, value: item.text, kept: item.kept }),
      })
      if (phrases.length === 0) {
        skipped.push({ reason: 'description_without_phrase', category, key, occurrence })
        continue
      }
      const kept = phrases.filter(
        (phrase) =>
          !isNegatedObservation(phrase) &&
          !isPlaceholderObservation(phrase) &&
          !isFragmentObservation(phrase) &&
          !isMeasurementPhrase(phrase),
      )
      for (const phrase of phrases) {
        if (isNegatedObservation(phrase)) negated.push({ category, key, occurrence, value: phrase })
        else if (isFragmentObservation(phrase)) skipped.push({ reason: 'fragment', category, key, occurrence })
        else if (isMeasurementPhrase(phrase)) skipped.push({ reason: 'measurement', category, key, occurrence, value: phrase })
      }
      if (kept.length === 0) continue
      for (const phrase of kept) {
        const wordCount = phrase.split(' ').filter(Boolean).length
        terms.push(
          makeTerm({
            text: normalizeTagName(phrase),
            raw_value: rawValue,
            detail: text,
            // 超过标签长度上限的短语不是标签，是一句描述：留在 detail 里给自然语言版用，
            // 但不许它进正向标签流——它读不懂，还会把真正管用的短标签挤出预算。
            description: wordCount > MAX_TAG_WORDS ? phrase : null,
            ...featureFields(feature, category, key),
          }),
        )
      }
      continue
    }

    if (isNegatedObservation(value)) {
      negated.push({ category, key, occurrence, value: String(value).trim() })
      continue
    }
    if (isPlaceholderObservation(value)) {
      skipped.push({ reason: 'placeholder_value', category, key, occurrence })
      continue
    }
    if (isFragmentObservation(value)) {
      skipped.push({ reason: 'fragment', category, key, occurrence })
      continue
    }
    if (isMeasurementPhrase(value)) {
      skipped.push({ reason: 'measurement', category, key, occurrence, value: String(value).trim() })
      continue
    }

    const text = normalizeTagName(value)
    if (text.length === 0) {
      skipped.push({ reason: 'empty_after_normalize', category, key, occurrence })
      continue
    }
    terms.push(
      makeTerm({
        text,
        raw_value: rawValue,
        ...featureFields(feature, category, key),
      }),
    )
  }

  const relatedIds = new Set()
  for (const relation of Array.isArray(ir?.relations) ? ir.relations : []) {
    if (relation?.from) relatedIds.add(relation.from)
    if (relation?.to) relatedIds.add(relation.to)
  }

  for (const entity of Array.isArray(ir?.entities) ? ir.entities : []) {
    const rawLabel = typeof entity?.label === 'string' ? entity.label.trim() : ''
    const label = stripOrdinalPrefix(rawLabel)
    if (label.length === 0) {
      skipped.push({ reason: 'entity_without_label', category: 'subject', entity_id: entity?.entity_id ?? null })
      continue
    }
    // 一个既没有任何属性、也没有参与任何关系的物件，标签只是模型凭先验补的“应该有的东西”
    // （鞋子、蝴蝶结）。它进正向就成了无依据的杜撰，还常常把画面带到另一条路上。
    // 主体类实体例外：`1girl` 这种计数标签本身就是画面事实。
    const kind = String(entity?.kind ?? '')
    const hasFeatures = Array.isArray(entity?.features) && entity.features.length > 0
    const isSubjectKind = ['person', 'animal', 'creature'].includes(kind)
    if (!hasFeatures && !relatedIds.has(entity?.entity_id) && !isSubjectKind) {
      skipped.push({ reason: 'entity_unsupported', category: 'unsorted', entity_id: entity?.entity_id ?? null })
      continue
    }
    const category = ['person', 'animal', 'creature'].includes(entity?.kind) ? 'subject' : 'unsorted'
    if (!looksLikeTag(label)) {
      const phrases = splitDescriptionPhrases(label, { limit: 2, maxWords: 6 })
      for (const phrase of phrases) {
        terms.push(
          makeTerm({
            text: normalizeTagName(phrase),
            raw_value: rawLabel,
            detail: label,
            ...entityFields(entity, category),
          }),
        )
      }
      if (phrases.length === 0) skipped.push({ reason: 'entity_label_unusable', category, entity_id: entity?.entity_id ?? null })
      continue
    }
    terms.push(
      makeTerm({
        text: normalizeTagName(label),
        raw_value: rawLabel,
        ...entityFields(entity, category),
      }),
    )
  }

  // 姿态合成：描述型观察 → 带方向的标签。
  // 放在去重之前，这样"标签版已经有这个标签"时会被 duplicate_text 吃掉，
  // 不会出现 outstretched_arm 与 outstretched_arm 各写一遍。
  const poseTags = synthesizePoseTags(ir, {
    existingTexts: terms.map((term) => term.text),
  })
  for (const pose of poseTags) {
    terms.push(
      makeTerm({
        text: pose.tag,
        raw_value: pose.source_text,
        category: pose.category,
        key: pose.key,
        entity_id: pose.entity_id,
        source: 'global_analysis',
        confidence: pose.confidence,
        importance: typeof pose.importance === 'number' ? pose.importance : 0.6,
        status: 'confirmed',
        region: pose.region,
      }),
    )
  }

  // 同一个词出现两次没有意义：`1girl` 既在 count 槽也在 general 槽时，
  // 正向词里会连写两遍，模型读到的权重也被重复加了一遍。
  const seen = new Set()
  const unique = []
  for (const term of terms) {
    const key = term.text
    if (seen.has(key)) {
      skipped.push({ reason: 'duplicate_text', category: term.category, key: term.key, entity_id: term.entity_id, origin: term.origin })
      continue
    }
    seen.add(key)
    unique.push(term)
  }

  // 短语里夹带已经单独出现过的词（`1girl, full body standing figure` 里又有 full body），
  // 等于把同一件事说两遍、把权重叠两遍。只在短语有 3 个词以上时剥，
  // 免得把 `black hair` 这种两词标签拆散。
  const standalone = new Set(unique.filter((term) => !term.text.includes('_')).map((term) => term.text))
  const pruned = []
  for (const term of unique) {
    if (!term.text.includes('_')) {
      pruned.push(term)
      continue
    }
    const tokens = term.text.split('_').filter(Boolean)
    if (tokens.length < 3) {
      pruned.push(term)
      continue
    }
    const keptTokens = tokens.filter((token) => !standalone.has(token) || PHRASE_ANCHOR_WORDS.has(token))
    if (keptTokens.length === tokens.length) {
      pruned.push(term)
      continue
    }
    // 剥完可能把短语削出悬空的功能词（`luminous bright field behind the figure` 去掉 figure
    // 就剩 `... behind the`），这种半截话进了正向只会被模型当成噪声。削到实词为止。
    const edgeTrimmed = trimEdgeTokens(keptTokens)
    if (edgeTrimmed.length === 0) {
      skipped.push({ reason: 'redundant_phrase', category: term.category, key: term.key, entity_id: term.entity_id, origin: term.origin })
      continue
    }
    if (edgeTrimmed.length === 1 && keptTokens.length > 1) {
      // 只剩一个词，短语已经不成短语；让它退回单词形态，由去重和槽位再判断。
      pruned.push({ ...term, text: edgeTrimmed[0] })
      continue
    }
    pruned.push({ ...term, text: edgeTrimmed.join('_') })
  }

  // 丢弃记录带上身份：否则"这条观察为什么没进提示词"只能靠拿原话去最终文本里找词，
  // 那是相似度猜测，不是记录。ref 与 makeTerm 里的字段同源，台账据此做身份 join。
  const withRef = (entry) => {
    if (!entry || typeof entry !== 'object' || entry.ref) return entry
    const entityId = entry.entity_id ?? null
    return {
      ...entry,
      ref: {
        origin: entry.origin ?? (entityId && !entry.key ? 'entity' : 'feature'),
        category: String(entry.category ?? ''),
        key: entry.key ?? null,
        entity_id: entityId,
        // 与 makeTerm 同源：同一 `category.key` 的第几条，缺省 0。
        occurrence: Number.isInteger(entry.occurrence) && entry.occurrence > 0 ? entry.occurrence : 0,
      },
    }
  }

  return { terms: pruned, skipped: skipped.map(withRef), negated: negated.map(withRef), poseTags }
}

export function isScoreTag(text) {
  return SCORE_TAG_PATTERN.test(normalizeTagName(text))
}
