import { addFeature, addUncertainty } from '../ir/index.js'

/**
 * 像素证据的落实层。
 *
 * 提示词只能"劝"模型别在黑白图上编颜色，劝不住的时候必须有程序兜底：
 * 这里拿解码器算出来的统计量，把已经进 IR 的彩色观察清掉，再把单色结论补上。
 * 这一层是确定性的——不看模型心情，只看 mono_ratio / colorfulness。
 */

export const EVIDENCE_CODES = Object.freeze({
  COLOR_DROPPED: 'VISION_MONOCHROME_COLOR_DROPPED',
  ATMOSPHERE_MISSING: 'VISION_ATMOSPHERE_NOT_OBSERVED',
  ATMOSPHERE_INJECTED: 'VISION_ATMOSPHERE_INJECTED',
  CONTRAST_DROPPED: 'VISION_HARD_CONTRAST_DROPPED',
  BACKGROUND_INJECTED: 'VISION_BACKGROUND_INJECTED',
  BACKGROUND_TRIMMED: 'VISION_BACKGROUND_TRIMMED',
  POSE_CAMERA_AS_POSE: 'VISION_POSE_CAMERA_WORD_AS_ORIENTATION',
  POSE_ORIENTATION_MISSING: 'VISION_POSE_ORIENTATION_MISSING',
  POSE_AXES_THIN: 'VISION_POSE_AXES_THIN',
  FACE_BLACKOUT_DROPPED: 'VISION_FACE_BLACKOUT_DROPPED',
  FACE_SHADOW_INJECTED: 'VISION_FACE_SHADOW_INJECTED',
  HOLDING_WITHOUT_HAND: 'VISION_HOLDING_WITHOUT_HAND',
  HOLDING_RECLASSIFIED: 'VISION_HOLDING_RECLASSIFIED',
  HAND_SIDE_MISSING: 'VISION_HAND_SIDE_MISSING',
  TORSO_ROTATION_UNDERSTATED: 'VISION_TORSO_ROTATION_UNDERSTATED',
  TORSO_SHOULDER_DEPTH_DERIVED: 'VISION_SHOULDER_DEPTH_DERIVED',
  TORSO_FRONT_CLAIM_CONFLICT: 'VISION_TORSO_FRONT_CLAIM_CONFLICT',
  RENDER_MEDIUM_FLATTENED: 'VISION_RENDER_MEDIUM_FLATTENED',
  FACE_OCCLUSION_INJECTED: 'VISION_FACE_OCCLUSION_INJECTED',
  OBSERVATION_FRAGMENT_TRIMMED: 'VISION_OBSERVATION_FRAGMENT_TRIMMED',
})

/** 明确的色相词。刻意不含 rose / coral / peach / cream / mint 这类同名物件词，避免误伤。 */
const HUE_WORDS = Object.freeze([
  'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'brown',
  'cyan', 'magenta', 'teal', 'turquoise', 'indigo', 'violet', 'crimson',
  'scarlet', 'amber', 'azure', 'golden', 'blonde', 'brunette', 'auburn',
  'navy', 'maroon', 'khaki', 'beige', 'sepia', 'vermilion', 'chartreuse',
  'ochre', 'sienna', 'ultramarine', 'mauve', 'fuchsia', 'lilac', 'periwinkle',
])
const HUE_SET = new Set(HUE_WORDS)

/** 色温词在彩色图里合法，在黑白图里等于编造。只对光照/色彩分类生效。 */
const TEMPERATURE_WORDS = Object.freeze(['warm', 'cool', 'warmer', 'cooler', 'golden', 'gold'])
const TEMPERATURE_SET = new Set(TEMPERATURE_WORDS)

/**
 * 色相词在**任何**分类里都是编造，唯独这三个分类例外：
 * 角色名（Red Hood）、作品名、画师名里的颜色词是专有名词的一部分，删了会毁掉识别。
 * 早期只查 4 个分类，于是模型把 `blonde hair` 挂到 subject 或 quality_style 上就绕过了
 * 单色收敛——这是"灰阶图仍然反推出彩色"的一个真实漏洞。
 */
const PROPER_NOUN_CATEGORIES = new Set(['character', 'copyright', 'artist'])

/** 与"朦胧/散射"直接冲突的硬朗描述：像素说柔，就不能写锐。 */
const HARD_CONTRAST_WORDS = Object.freeze([
  'high contrast', 'hard light', 'hard lighting', 'sharp focus', 'sharp edges',
  'crisp', 'clear sky', 'silhouette', 'silhouetted', 'deep black', 'pure black',
  'jet black', 'high key contrast', 'graphic', 'clean lines',
])

const MEDIUM_WORDS = Object.freeze([
  'fog', 'foggy', 'mist', 'misty', 'haze', 'hazy', 'smoke', 'smoky', 'smog',
  'dust', 'dusty', 'vapor', 'vapour', 'steam', 'aerial perspective', 'atmospheric',
])

function tokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[\s,;/_]+/)
    .map((token) => token.replace(/^[^a-z]+|[^a-z]+$/g, ''))
    .filter(Boolean)
}

export function hasHueWord(text) {
  return tokens(text).some((token) => HUE_SET.has(token))
}

export function hasTemperatureWord(text) {
  return tokens(text).some((token) => TEMPERATURE_SET.has(token))
}

export function hasMediumWord(text) {
  const lowered = String(text ?? '').toLowerCase()
  return MEDIUM_WORDS.some((word) => lowered.includes(word))
}

function featureList(ir) {
  const entries = []
  for (const feature of ir.features ?? []) {
    entries.push({ holder: ir.features, feature, entityId: null })
  }
  for (const entity of ir.entities ?? []) {
    for (const feature of entity.features ?? []) {
      entries.push({ holder: entity.features, feature, entityId: entity.entity_id })
    }
  }
  return entries
}

function isOffending(feature, { includeTemperature }) {
  const category = String(feature?.category ?? '')
  const value = String(feature?.value ?? '')
  // 专有名词分类放行：Red Hood 这类角色名不是颜色观察。
  if (PROPER_NOUN_CATEGORIES.has(category)) return false
  if (hasHueWord(value)) return true
  if (includeTemperature && category === 'lighting_color' && hasTemperatureWord(value)) return true
  return false
}

/**
 * 观察值末尾悬空的连接词。
 *
 * 实测模型会写出 `edges glowing where backlit`：`backlit` 随后被光影别名归一拿走，
 * 剩下 `edges glowing where` 这半句话直接进了描述版——生成端读不懂，还把句法带偏成
 * 「穿着…在哪」这种残句。这里只清**句尾**：删掉结尾悬空的连接词与尾部标点，
 * 句中内容一个字不动。刻意不含 at / of / in / on / to / from 这类介词，
 * 因为 `looking at` / `made of` / `leaning on` 是合法收尾，删了就变成残句。
 */
const TRAILING_CONNECTOR_PATTERN =
  /(?:^|[\s,;:])(?:where|which|when|while|with|and|or|but|that|whose|because|though|although|if|so|than)\s*$/i

/**
 * 介词 + 冠词收尾，同样是残句。
 *
 * 上面那条刻意不碰介词，因为 `looking at` / `made of` 是合法收尾。但 `around the`
 * 不是——介词后面只剩冠词，说明它领的名词被别的规则摘走了。实测原句是
 * `light scattering around the silhouette`，`silhouette` 被判成硬光词剔除后
 * 剩下 `light scattering around the`，直接进了描述版。冠词后面没有名词，
 * 这句话在任何语境下都不成立，所以这一条可以放心删。
 */
const TRAILING_PREP_ARTICLE_PATTERN =
  /(?:^|[\s,;:])(?:around|against|behind|beside|besides|above|below|beneath|across|through|throughout|along|over|under|underneath|near|nearer|toward|towards|from|with|within|without|at|in|on|of|to|into|onto|upon|between|among|beyond|past|per|via)\s+(?:the|a|an|this|that|these|those)\s*$/i

function trimTrailingConnector(value) {
  let next = String(value ?? '').trim()
  // 连着写两个（`with and`）要一起清，所以循环到不动为止。
  for (let guard = 0; guard < 8; guard += 1) {
    const trimmed = next
      .replace(TRAILING_PREP_ARTICLE_PATTERN, '')
      .replace(TRAILING_CONNECTOR_PATTERN, '')
      .replace(/[\s,;:]+$/, '')
      .trim()
    if (trimmed === next) break
    next = trimmed
  }
  return next
}

/**
 * 把以悬空连接词结尾的观察值就地截断；截完空了的整条丢掉。
 *
 * 只动 value，不动 key / category / confidence——这不改判观察内容，只把半句话补成整句话。
 */
export function tidyObservationFragments(ir) {
  const trimmed = []
  const dropped = []
  for (const entry of featureList(ir)) {
    const before = String(entry.feature?.value ?? '')
    const after = trimTrailingConnector(before)
    if (after === before) continue
    if (after.length === 0) {
      const index = entry.holder.indexOf(entry.feature)
      if (index >= 0) entry.holder.splice(index, 1)
      dropped.push({ entity_id: entry.entityId, category: entry.feature?.category ?? null, before })
      continue
    }
    entry.feature.value = after
    trimmed.push({ entity_id: entry.entityId, category: entry.feature?.category ?? null, before, after })
  }
  return { applied: trimmed.length > 0 || dropped.length > 0, trimmed, dropped }
}

function alreadyMonochromeTagged(ir) {
  return featureList(ir).some(({ feature }) => {
    const value = String(feature?.value ?? '').toLowerCase()
    return value.includes('greyscale') || value.includes('grayscale') || value.includes('monochrome') || value.includes('black and white')
  })
}

function hasColorUncertainty(ir) {
  return (ir.uncertainties ?? []).some((item) => item?.code === 'color_indeterminable')
}

/**
 * 单色图强制收敛：删掉色相观察、补上单色结论、留下"原色相不可知"的记录。
 * 只在 metrics.verdict.monochrome 为真时动手，判定来自像素统计而不是模型自述。
 */
/**
 * 从实体标签里摘掉色相词，保留剩下的名词。
 *
 * 为什么必须管标签：`lib/compile/terms.js` 会把 entity.label 直接编译成正向词
 * （entity_label 通道）。只清 feature 不清 label，模型把颜色写进对象名
 * （`white dress` / `blue eyes` / `blonde hair`）就绕过了单色收敛，
 * 灰阶图照样反推出彩色提示词。
 */
function stripHueTokens(label) {
  const kept = String(label ?? '')
    .split(/\s+/)
    .filter((token) => {
      const bare = token.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '')
      if (!bare) return false
      return !HUE_SET.has(bare) && !TEMPERATURE_SET.has(bare)
    })
  return kept.join(' ').trim()
}

/**
 * 复合观察里"除颜色之外"的部分能不能留下来。
 *
 * 实测缺陷：`crimson velvet dress with a lace collar and gold embroidery`
 * 因为含一个色相词被整条删除，绒面、领口、刺绣这些跟颜色无关的结构信息一起没了。
 * 单色图里**颜色**不可判，但"绒面""蕾丝领口""刺绣"这些照样看得见。
 *
 * 但也不能无脑保留：`blonde hair` 摘掉 `blonde` 只剩 `hair`，
 * 对 `appearance.hair_color` 这条观察来说等于什么都没说，留着只会变成噪声。
 * 所以只在摘完还剩**至少两个实词**时才保留，否则整条丢。
 */
const FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'with', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'from', 'by', 'for',
  'as', 'that', 'is', 'are', 'this', 'these', 'those', 'its', 'their', 'her', 'his',
  'very', 'slightly', 'mostly', 'some', 'more', 'most', 'than', 'then', 'while', 'where',
])

function contentWords(text) {
  return String(text ?? '')
    .split(/\s+/)
    .map((token) => token.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, ''))
    .filter((token) => token.length > 0 && !FUNCTION_WORDS.has(token))
}

const TRAILING_CLAUSE_CONNECTOR = /\b(?:but|and|or|yet|though|although|while)\b/gi

/**
 * 摘词之后，连接词后面只剩一个实词的尾巴要去掉。
 *
 * `not silhouette but high contrast edges` 摘掉 `high contrast` 剩
 * `not silhouette but edges`——`but edges` 是个没有谓语的残句，
 * 编译出去生成端只会看见一个孤零零的 `edges`。前半句站得住就留前半句。
 */
function dropDanglingTail(value) {
  const text = String(value ?? '').trim()
  const matches = [...text.matchAll(TRAILING_CLAUSE_CONNECTOR)]
  if (matches.length === 0) return text
  const last = matches[matches.length - 1]
  const head = text.slice(0, last.index).trim()
  const tail = text.slice(last.index + last[0].length).trim()
  if (contentWords(tail).length <= 1 && contentWords(head).length >= 2) return head
  return text
}

/**
 * 从观察值里摘掉色相词（必要时连色温词一起摘），保留其余信息。
 *
 * 色温词只在 `lighting_color` 里算编造（跟 `isOffending` 同一口径）：
 * `warm rim light` 在灰阶图上确实无从判断，但 `warm smile` 不是颜色观察。
 */
function stripHueFromValue(value, { includeTemperature }) {
  const kept = String(value ?? '')
    .split(/\s+/)
    .filter((token) => {
      const bare = token.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '')
      if (!bare) return false
      if (HUE_SET.has(bare)) return false
      if (includeTemperature && TEMPERATURE_SET.has(bare)) return false
      return true
    })
  return trimTrailingConnector(kept.join(' ').trim())
}

export function enforceMonochrome(ir, metrics) {
  const verdict = metrics?.verdict ?? {}
  if (verdict.monochrome !== true) return { applied: false, dropped: [], trimmed: [], relabelled: [], injected: false }

  const dropped = []
  const trimmed = []
  for (const entry of featureList(ir)) {
    if (!isOffending(entry.feature, { includeTemperature: true })) continue
    const index = entry.holder.indexOf(entry.feature)
    if (index < 0) continue
    const before = String(entry.feature.value ?? '')
    const includeTemperature = String(entry.feature.category ?? '') === 'lighting_color'
    const remainder = stripHueFromValue(before, { includeTemperature })
    if (contentWords(remainder).length >= 2) {
      // 颜色不可判，但这条观察里的材质/款式/结构照样看得见——只摘颜色，不整条删。
      entry.feature.value = remainder
      trimmed.push({
        entity_id: entry.entityId,
        category: entry.feature.category,
        key: entry.feature.key,
        from: before,
        to: remainder,
      })
      continue
    }
    entry.holder.splice(index, 1)
    dropped.push({
      entity_id: entry.entityId,
      category: entry.feature.category,
      key: entry.feature.key,
      value: entry.feature.value,
    })
  }

  // 实体标签同属"观察结果"，同样可能带颜色。
  const relabelled = []
  for (const entity of ir.entities ?? []) {
    const label = typeof entity.label === 'string' ? entity.label : ''
    if (!hasHueWord(label) && !hasTemperatureWord(label)) continue
    const cleaned = stripHueTokens(label)
    const fallback = String(entity.kind ?? '').trim()
    const next = cleaned.length > 0 ? cleaned : fallback
    if (next.length === 0 || next === label) continue
    relabelled.push({ entity_id: entity.entity_id ?? null, from: label, to: next })
    entity.label = next
    if (Array.isArray(entity.aliases)) {
      entity.aliases = entity.aliases.filter((alias) => !hasHueWord(alias) && !hasTemperatureWord(alias))
    }
  }

  let injected = false
  if (!alreadyMonochromeTagged(ir)) {
    // 一条 feature 只放一个标签：多个标签挤在 value 里会被当成"描述"而不是标签，
    // 编译期就不会进正向词表（looksLikeTag 要求短、无标点）。
    const injections = [
      ['lighting_color', 'color_system', 'greyscale'],
      ['lighting_color', 'color_mode', 'monochrome'],
      ['quality_style', 'color_treatment', 'black and white'],
    ]
    for (const [category, key, value] of injections) {
      addFeature(
        ir,
        category,
        key,
        {
          value,
          confidence: 0.95,
          importance: 0.95,
          status: 'confirmed',
          note: '像素预检：无彩像素占绝大多数，色相不可判定',
        },
        { source: 'global_analysis' },
      )
    }
    injected = true
  }

  if (!hasColorUncertainty(ir)) {
    addUncertainty(ir, {
      code: 'color_indeterminable',
      subject: 'lighting_color.color_system',
      question: '原图是单色/灰度，原始色相无法从画面判定',
      severity: 'low',
    })
  }

  return { applied: true, dropped, trimmed, relabelled, injected }
}

/**
 * 朦胧感强制收敛：像素证明"黑场抬高 + 对比压低 + 边缘发软"时，
 * 画面里不可能同时是"高对比、硬光、锐利轮廓、纯黑"。
 *
 * 为什么要程序兜底而不是只靠提示词：这些词恰恰是模型描述"强逆光人像"时最顺手的一套
 * 默认词（high contrast / backlit / silhouette / sharp focus）。只要它们进了 IR，
 * 编译出来的正稿就会把画面重新拉回硬朗，用户看到的就是"没有灰蒙蒙的感觉"。
 * 这里把它们删掉，并按证据补上散射类描述。
 */
export function enforceDiffusion(ir, metrics) {
  const diffusion = metrics?.diffusion
  if (!diffusion || diffusion.diffuse !== true) {
    return { applied: false, dropped: [], trimmed: [], injected: false, kept_negated: [] }
  }

  const dropped = []
  const trimmed = []
  const keptNegated = []
  for (const entry of featureList(ir)) {
    const value = String(entry.feature?.value ?? '')
    const lowered = value.toLowerCase()
    // 被否定的说法不是冲突词，是**同向证据**。
    // `no pure black` 说的是"画面里没有纯黑"，跟"像素判定偏柔"完全一致；
    // 老实现只看 `includes(word)`，于是把这条观察当冲突整条删掉——删掉的
    // 正是唯一能说明"为什么这张图看起来是灰的"的那句话。
    const present = HARD_CONTRAST_WORDS.filter((word) => lowered.includes(word))
    const hits = present.filter((word) => !isNegatedOccurrence(lowered, word))
    const negatedHits = present.filter((word) => isNegatedOccurrence(lowered, word))
    if (negatedHits.length > 0) {
      keptNegated.push({
        category: entry.feature.category,
        key: entry.feature.key,
        words: negatedHits,
        value,
      })
    }
    if (hits.length === 0) continue

    // 只删冲突词，不整条删特征：`full body silhouette` 里的 full body 是有效景别，
    // 整条丢掉会连构图信息一起损失。删完还剩词就保留，空了才整条删。
    let remainder = value
    for (const hit of hits) remainder = stripNegatedPhrase(remainder, hit)
    remainder = remainder
      .replace(/\s*[,;]\s*(?=[,;])/g, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s,;]+|[\s,;]+$/g, '')
      .trim()
      // 摘词会切断句子：`not silhouette but soft edges` 摘完剩 `but soft edges`，
      // 字头挂着一个连接词，编译出去就是个断句。
      .replace(/^(?:but|and|or|yet|though|although|while)\b[\s,;]*/i, '')
      .trim()

    remainder = dropDanglingTail(remainder)

    const index = entry.holder.indexOf(entry.feature)
    if (index < 0) continue

    // 摘词会留下没有主语的碎句，`dropDanglingTail` 已经把连接词后面的残尾去掉。
    // 这里只管"摘完什么都不剩"：`sharp focus` 这种整条就是冲突词的，删掉才对。
    // 不能按实词个数卡：`high contrast backlit` 摘完剩 `backlit`，
    // 一个词，但它就是这条观察的全部内容，删了等于把光位丢了。
    if (remainder.length === 0) {
      entry.holder.splice(index, 1)
      dropped.push({
        entity_id: entry.entityId,
        category: entry.feature.category,
        key: entry.feature.key,
        value,
      })
      continue
    }

    entry.feature.value = remainder
    entry.feature.note = `${entry.feature.note ? `${entry.feature.note}；` : ''}像素预检：已剔除与低对比证据冲突的词（${hits.join(', ')}）`
    trimmed.push({ category: entry.feature.category, key: entry.feature.key, from: value, to: remainder })
  }

  const hasMedium = featureList(ir).some(({ feature }) => hasMediumWord(feature?.value))
  let injected = false
  if (!hasMedium) {
    // 一条 feature 一个标签：多个词挤在 value 里编译期不会进正向词表。
    const injections = [
      ['lighting_color', 'atmosphere', 'haze'],
      ['lighting_color', 'light_scattering', 'light scattering'],
      ['lighting_color', 'contrast_ratio', 'low contrast'],
    ]
    for (const [category, key, value] of injections) {
      addFeature(
        ir,
        category,
        key,
        {
          value,
          confidence: 0.85,
          importance: 0.9,
          status: 'confirmed',
          note: '像素预检：黑场抬高、对比压低、边缘发软，判定为散射介质',
        },
        { source: 'global_analysis' },
      )
    }
    injected = true
  }

  return { applied: true, dropped, trimmed, injected, kept_negated: keptNegated }
}

/**
 * 背景证据的落实层：把"程序量出来的背景"变成必须出现的控制型标签。
 *
 * 为什么需要兜底：模型对环境的写法永远是形容词（bright background / clean backdrop），
 * 生成端拿这些词压不住画面，四周就会自己长出一片房间、树林或光斑。真正能控住的是
 * white background / simple background / gradient background 这一组标签。
 * 而该写哪一个只有像素知道——所以这里用 background_profile 的结论：
 * 缺了补上，与结论冲突的（纯白场里写 black background）删掉。
 */
export function enforceBackground(ir, metrics) {
  const background = metrics?.background
  if (!background || typeof background !== 'object') {
    return { applied: false, injected: [], trimmed: [], kind: null }
  }
  const kind = String(background.kind ?? 'unknown')
  const tags = Array.isArray(background.tags) ? background.tags.map((tag) => String(tag)) : []
  if (tags.length === 0) return { applied: true, injected: [], trimmed: [], kind }

  // 与实测结论冲突的明度断言：纯白场里写 dark/black backdrop 会把背景重新压黑。
  // 雾光场不是白纸：写成 white background / simple background 会把整片空气抽干，
  // 只剩一张纯色画纸，雾、光斑与地面反射全都没了。这类断言一律按冲突删掉。
  const conflicts =
    kind === 'white' || kind === 'high_key'
      ? ['black background', 'dark background', 'black backdrop', 'dark backdrop']
      : kind === 'hazy'
        ? [
            'white background',
            'white backdrop',
            'bright white background',
            'simple background',
            'plain background',
            'plain backdrop',
            'pure white',
            'black background',
            'dark background',
          ]
        : kind === 'dark'
          ? ['white background', 'white backdrop', 'bright white background']
          : []
  const trimmed = []
  for (const entry of featureList(ir)) {
    if (String(entry.feature?.category ?? '') !== 'background') continue
    const value = String(entry.feature?.value ?? '')
    const lowered = value.toLowerCase()
    const hit = conflicts.find((word) => lowered.includes(word))
    if (!hit) continue
    const index = entry.holder.indexOf(entry.feature)
    if (index < 0) continue
    entry.holder.splice(index, 1)
    trimmed.push({ category: entry.feature.category, key: entry.feature.key, from: value })
  }

  const present = new Set(
    featureList(ir)
      .map(({ feature }) => String(feature?.value ?? '').toLowerCase().trim())
      .concat((ir.entities ?? []).map((entity) => String(entity?.label ?? '').toLowerCase().trim())),
  )
  const injected = []
  for (const tag of tags) {
    if (present.has(tag.toLowerCase())) continue
    addFeature(
      ir,
      'background',
      'backdrop',
      {
        value: tag,
        confidence: 0.95,
        importance: 0.9,
        status: 'confirmed',
        note: '像素预检：按背景取样（顶部横带＋左右竖带）量出的控制型背景标签',
      },
      { source: 'global_analysis' },
    )
    injected.push(tag)
  }

  return { applied: true, injected, trimmed, kind }
}

/**
 * 脸上"纯黑"的断言词。
 *
 * 逆光图的脸几乎一律被写成这几种说法，它们把一个还带明度层次的脸压成一块黑板：
 * 编译出去就是 `face in shadow` / `unreadable face`，生成端照着画一张没有五官的
 * 黑脸。所以这一条必须在 IR 层就拦掉，不能指望提示词劝。
 */
const FACE_BLACKOUT_WORDS = Object.freeze([
  'pure black', 'solid black', 'deep black', 'jet black', 'all black',
  'in shadow', 'in deep shadow', 'in full shadow', 'cast in shadow', 'shadowed out',
  'unreadable', 'featureless', 'no facial features', 'faceless', 'blank face',
  'face obscured', 'obscured face', 'hidden face', 'silhouetted face', 'black silhouette',
  'backlit silhouette', 'silhouette',
])

/** 脸相关的分类：面部特征与表情。剪影词挂在别的分类上（例如 quality_style）不管。 */
const FACE_CATEGORIES = new Set(['expression', 'appearance'])

/**
 * 摘掉断言词之后只剩主语的名词。`pure black face` 清理完剩下 `face`——
 * 这不是观察，是一条空壳，编译出去只会往提示词里塞一个没有信息的词。
 */
const FACE_FILLER = new Set(['face', 'faces', 'facial', 'expression', 'expressions', 'eyes', 'eye'])

function mentionsFace(feature) {
  const text = normalizedText(`${feature?.key ?? ''} ${feature?.value ?? ''}`)
  return /\bface\b|\bfacial\b|\bexpression\b|\beyes\b|\beye\b/.test(text)
}

function isFaceFiller(value) {
  const bare = normalizedText(value).replace(/[,;/]/g, ' ').replace(/\s+/g, ' ').trim()
  if (bare.length === 0) return true
  return bare.split(' ').every((token) => FACE_FILLER.has(token))
}

function stripWords(value, words) {
  let text = String(value ?? '')
  for (const word of words) {
    const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
    text = text.replace(pattern, '')
  }
  return text
    .replace(/\s*[,;/]\s*(?=[,;/])/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;/]+|[\s,;/]+$/g, '')
    .trim()
}

/**
 * 脸部明度落实：程序量了头部**候选区域**的暗部核心，脸没被压成纯黑时，把"纯黑/剪影"的
 * 断言从 IR 里摘掉，并把"脸在暗部"这条观察补进去。
 *
 * 为什么单独一层：`enforceMonochrome` 只管色相，`enforceDiffusion` 只管雾，
 * `checkPoseAxes` 只管姿态——脸的黑度此前完全没人管，模型写多黑就是多黑。
 * 而这一维恰好是"看起来像"最容易骗过观察者的地方：亮背景把整图均值抬到 0.7，
 * 于是脸被当成"亮部"，或者反过来被当成"剪影里的一块黑"。
 *
 * 但这里有一个以前被忽略的前提：**那块区域是不是脸，从来没人确认过。**
 * `face.box` 来自 `python/decode_helper.py` 的 `face_region_profile`，它取的是
 * 显著性框顶部 22%——显著性框标的是"画面里最抢眼的那块"，不是人物分割，更不是脸。
 * 亮度是"五官可辨"的**必要**条件，不是充分条件；拿一个未确认区域的亮度去裁决
 * "facial features still readable"，就是在没有脸部证据时下确定性结论。
 *
 * 所以现在分两条路：
 * - `region_verified === true`（有脸部检测或复核确认）：照旧摘越界断言 + 补"暗但可读"。
 * - 未确认：不下裁决——不动模型自己的观察，只补一条**候选**观察（tentative），
 *   并记一条 uncertainty 要求复核确认脸部区域。宁可留一个待裁决项，不写一个假结论。
 */
const FACE_BANDS = Object.freeze(['blackout', 'near_black', 'shadowed', 'lit'])

export function enforceFaceLuminance(ir, metrics) {
  const face = metrics?.face
  if (!face || typeof face !== 'object') {
    return { applied: false, dropped: [], injected: [], band: null, region_verified: false }
  }
  const band = String(face.band ?? 'unknown')
  const blackout = face.blackout === true
  const core = Number(face.dark_core_luma ?? 0)
  const regionVerified = face.region_verified === true || face.region_source === 'face_detector'

  // band 认不出来说明度量本身不可信：既不解黑，也不补话，只记一条待复核。
  if (!FACE_BANDS.includes(band)) {
    addUncertainty(ir, {
      code: 'insufficient_detail',
      subject: 'expression.face_light',
      question: `像素预检给的头部明度档位是「${band}」，不是可识别的四档之一（blackout/near_black/shadowed/lit）；这次的脸部明度判断没有依据，需要复核脸部区域与暗部亮度`,
      severity: 'medium',
    })
    return {
      applied: false,
      dropped: [],
      injected: [],
      band,
      blackout,
      dark_core_luma: core,
      region_verified: regionVerified,
      band_valid: false,
    }
  }

  // 区域未确认：保留模型自己的观察（不摘任何词），只补候选与待复核项。
  if (!regionVerified) {
    const injected = []
    // 只有"偏暗但不是纯黑"才给候选。纯黑区域不能补 dim face——那是把一块黑说成有层次。
    const candidate = !blackout && core < 0.30 ? 'dim face, low-key light' : null
    const alreadySaid = featureList(ir).some(({ feature }) =>
      normalizedText(feature?.value).includes('dim face'),
    )
    if (candidate && !alreadySaid) {
      addFeature(
        ir,
        'expression',
        'face_light',
        {
          value: candidate,
          confidence: 0.55,
          importance: 0.7,
          status: 'tentative',
          note: `像素预检：候选区域暗部核心亮度 ${core.toFixed(2)}（${band}），偏暗但**没有确认这块区域是脸**，所以只给候选、不裁决五官是否可辨`,
        },
        { source: 'global_analysis' },
      )
      injected.push(candidate)
    }
    // 只有"要裁决的事"才值得记一条待复核：区域偏暗或偏黑时，五官可辨这句话才有风险。
    // 区域明明很亮、也没有纯黑断言时，硬记一条"没确认这是脸"只是给每张图加噪声。
    const needsRuling = blackout || core < 0.30
    if (needsRuling) {
      addUncertainty(ir, {
        code: 'insufficient_detail',
        subject: 'expression.face_light',
        question: `亮度是在候选区域（显著性框顶部 22%）上量的，没有确认它就是脸。需要复核：这块区域是不是脸、脸上最暗处是否还有五官层次；确认之前不许写 facial features readable`,
        severity: 'medium',
      })
    }
    return {
      applied: injected.length > 0,
      dropped: [],
      injected,
      band,
      blackout,
      dark_core_luma: core,
      region_verified: false,
      needs_ruling: needsRuling,
    }
  }

  const dropped = []
  if (!blackout) {
    for (const entry of featureList(ir)) {
      const feature = entry.feature
      const category = String(feature?.category ?? '')
      if (!FACE_CATEGORIES.has(category)) continue
      if (!mentionsFace(feature)) continue
      const value = String(feature?.value ?? '')
      const lowered = normalizedText(value)
      const hit = FACE_BLACKOUT_WORDS.find((word) => lowered.includes(word))
      if (!hit) continue
      const cleaned = stripWords(value, FACE_BLACKOUT_WORDS)
      const index = entry.holder.indexOf(feature)
      if (index < 0) continue
      if (isFaceFiller(cleaned)) {
        entry.holder.splice(index, 1)
        dropped.push({ category, key: feature.key, from: value, to: null, word: hit })
      } else {
        feature.value = cleaned
        dropped.push({ category, key: feature.key, from: value, to: cleaned, word: hit })
      }
    }
  }

  const injected = []
  const hasShadowFact = featureList(ir).some(({ feature }) => {
    const text = normalizedText(`${feature?.value ?? ''}`)
    return mentionsFace(feature) && (text.includes('dim') || text.includes('low key') || text.includes('shaded'))
  })
  // 脸确实处在暗部时，必须有一条"暗但有层次"的正面观察顶着，否则编译层只剩
  // 被删空的 expression 分类，提示词里脸这一块会直接消失。
  if (!blackout && core < 0.30 && !hasShadowFact) {
    const value =
      band === 'lit'
        ? 'faintly lit face, features readable'
        : 'dim face, low-key light, facial features still readable'
    addFeature(
      ir,
      'expression',
      'face_light',
      {
        value,
        confidence: 0.85,
        importance: 0.85,
        status: 'confirmed',
        note: `像素预检：头部暗部核心亮度 ${core.toFixed(2)}（${band}），有明度层次，不是纯黑`,
      },
      { source: 'global_analysis' },
    )
    injected.push(value)
  }

  return { applied: true, dropped, injected, band, blackout, dark_core_luma: core, region_verified: true }
}

/**
 * 雾霾复核：像素说"有散射介质"，但 IR 里一个介质词都没有 → 说明模型漏看了。
 * 这不是覆盖度问题（D4 可能被打了 observed），而是"观察到了光却没看到雾"。
 */
export function checkAtmosphere(ir, metrics) {
  const verdict = metrics?.verdict ?? {}
  if (verdict.hazy !== true) return null
  const values = featureList(ir).map(({ feature }) => feature?.value)
  const scene = ir?.scene?.summary
  const found = [...values, scene].some((text) => hasMediumWord(text))
  if (found) return null
  return {
    error_code: EVIDENCE_CODES.ATMOSPHERE_MISSING,
    severity: 'warning',
    message: '像素预检判定画面存在明显散射介质（雾/霾/烟/水汽），但观察结果里没有任何介质标签。',
    suggested_fix:
      '这通常是把介质写成了"低对比打光"或"柔光"。重新分析时可手动确认是否漏了 fog / mist / haze / aerial perspective。',
  }
}

/**
 * 正面断言：说"身体正对镜头"。
 *
 * 这一组词最危险的地方不在于它错，而在于它是**领起词**：观察者常常先写一句
 * `facing viewer`，再补一句 `left shoulder forward and nearer to the camera`。
 * 两句放在一起时，后半句才是肩线的硬证据（两侧肩一近一远，身体必然转过去了），
 * 但编译后 `facing viewer` 排在前面，生成端只认第一句，人就被摆正了。
 */
const FRONT_CLAIM_WORDS = Object.freeze([
  'facing viewer', 'facing the viewer', 'facing camera', 'facing the camera',
  'facing forward', 'front facing', 'front-facing', 'front view', 'frontal',
  'straight on', 'straight-on', 'head on', 'head-on', 'directly facing',
])

/**
 * 把转体读轻的修饰词。
 *
 * `slight three-quarter turn` 编译出去仍然是"轻微"，生成端按最保守的解释画成正面。
 * 角度要么写出肩线依据，要么就别用"轻微"这类词糊过去。
 */
const ROTATION_HEDGE_WORDS = Object.freeze([
  'slight', 'slightly', 'a bit', 'a little', 'subtle', 'subtly',
  'mild', 'mildly', 'barely', 'somewhat', 'minor',
])

/**
 * 肩哪侧在前、哪侧在后 —— 转体方向的唯一硬证据。
 *
 * 同一个意思有两种写法，真跑里都出现过：
 *   - `left shoulder forward and nearer to the camera`（肩在前，侧名在前）
 *   - `shoulder on the viewer's left side forward and nearer the camera`（侧名在后）
 * 只认前一种，就会把后一种当成"没写肩线"，于是转体被判成"轻微斜转"，
 * 而且改写后原句原样留着，描述版里同一件事说两遍。
 */
const SHOULDER_SIDE_PATTERN =
  /\b(?:(left|right)\s+shoulder|shoulder\s+(?:on|at|to|toward|towards)\s+the\s+(?:viewer['’]?s?\s+|camera['’]?s?\s+)?(left|right)\s+side)\b/

const SHOULDER_NEAR_WORDS = Object.freeze(['forward', 'nearer', 'closer'])
const SHOULDER_FAR_WORDS = Object.freeze(['pulled back', 'back', 'further', 'farther', 'behind'])

/** 只取侧名之后紧跟的那一小段，避免把下一个分句里的 forward 算进来。 */
function shoulderTail(lowered, at) {
  return lowered.slice(at, at + 48).split(/[,;.]/)[0]
}

/**
 * 返回 `{near, far}`：哪侧肩离镜头更近。没有可判定的肩线时返回 null。
 * 只写一侧也算——"某侧肩后拉"意味着另一侧在前。
 */
function shoulderDepthIn(text) {
  const lowered = normalizedText(text)
  const side = lowered.match(SHOULDER_SIDE_PATTERN)
  if (!side) return null
  const which = side[1] ?? side[2]
  if (!which) return null
  const other = which === 'left' ? 'right' : 'left'
  const tail = shoulderTail(lowered, side.index + side[0].length)
  if (SHOULDER_NEAR_WORDS.some((word) => tail.includes(word))) return { near: which, far: other }
  if (SHOULDER_FAR_WORDS.some((word) => tail.includes(word))) return { near: other, far: which }
  return null
}

/**
 * 机位槽里的"正面"说法，按**它说的是哪个轴**分两类。
 *
 * 以前把这两类混成一张表，于是躯干一判成转体，`camera.angle = 'straight-on'`
 * 就被整条删掉。这是把两个独立的轴并成了一个：
 * - 机位轴：镜头从哪看、有没有歪（`straight-on` / `front view` / `from front`）
 * - 躯干轴：人物身体朝哪（`facing viewer` / `front-facing`）
 * 人侧身站着、镜头正对着拍，是最常见的一种拍法，两者同时成立完全正常。
 * 删掉机位词等于凭空丢掉一条已经量出来的观察。
 *
 * 所以：机位轴词一律保留；只有**写错槽**的身体朝向声明才动，而且要留痕。
 */
const CAMERA_AXIS_WORDS = Object.freeze([
  'straight-on', 'straight on', 'front view', 'from front', 'front angle',
])

const SUBJECT_FACING_WORDS = Object.freeze([
  'front-facing', 'front facing', 'facing viewer', 'facing the viewer', 'frontal',
])

function stripPhrase(value, phrase) {
  const pattern = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  return String(value ?? '').replace(pattern, ' ')
}

/**
 * 同上，但把空格、连字符、下划线当成同一个分隔符。
 *
 * 观察层写的是 `straight-on`，词表里写的是 `straight on`，归一化后两者相等，
 * 但拿 `straight on` 去替换 `straight-on` 一个字符都换不掉——留下一个非空的
 * remainder，于是"整条只剩正面词"的判断永远不成立，机位槽永远删不掉。
 */
/**
 * 摘掉与低对比证据冲突的词，**连它的否定前缀一起摘**。
 *
 * 真跑里观察写的是 `low contrast, lifted shadows, washed out blacks, no pure black`。
 * 最后那句与"像素判定画面柔和"并不矛盾（画面里确实没有纯黑），但 `pure black`
 * 本身是 `HARD_CONTRAST_WORDS` 里的词。老实现直接 `replace(hit, ' ')`，
 * 把 `no pure black` 削成悬空的 `no`，编译出去就成了 `…, washed out blacks, no`。
 *
 * 所以命中词的每一处出现都要往前看一眼：被 no/without/not 否定了，就连否定词一起删。
 */
const NEGATION_PREFIX_WORDS = 'no|without|not|zero|free of|absence of|lack of'

function stripNegatedPhrase(value, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s_-]+')
  const negation = `\\b(?:${NEGATION_PREFIX_WORDS})\\s+(?:visible\\s+|apparent\\s+|any\\s+)?`
  return String(value ?? '').replace(new RegExp(`(?:${negation})?${escaped}`, 'gi'), ' ')
}

function stripPhraseLoose(value, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(escaped.replace(/\s+/g, '[\\s_-]+'), 'gi')
  return String(value ?? '').replace(pattern, ' ')
}

/**
 * 与转体冲突的"背对镜头"说法。
 *
 * 模型描述躯干扭转时很爱写 `turned away`（意思是"远侧肩转开了"），
 * 但在提示词里 `turned away` / `facing away` / `from behind` 是**背对镜头**，
 * 与 `body turned three-quarter` 直接打架：生成端只会挑一句执行，
 * 挑中背对就等于把侧身修成了背身，比原来的正对更偏。
 */
const BACK_CLAIM_WORDS = Object.freeze([
  'turned away', 'body turned away', 'torso turned away', 'turning away',
  'back turned', 'back to the camera', 'back to viewer', 'back to the viewer',
  'facing away', 'from behind', 'back view', 'rear view', 'seen from behind',
])

/** 这些词说明该段讲的是头/脸，`head turned away` 是合理信息，不能当躯干背对处理。 */
const HEAD_WORDS = Object.freeze(['head', 'face', 'gaze', 'eyes', 'eye', 'chin', 'jaw', 'profile'])

/**
 * 只在重复"身体转过去了"这一件事、没有别的信息的片段。
 *
 * 真实观察里会出现 `torso turned three quarter`，它和兜底写出的
 * `body turned three-quarter` 是同一句话，两句并列读起来像两个独立动作，
 * 生成端会各取一半。改写后这类片段必须丢掉。
 */
const ROTATION_RESTATEMENT_WORDS = Object.freeze([
  'three quarter', 'three-quarter', 'quarter turn', 'half turned', 'half-turned',
  'body turned', 'torso turned', 'turned to the side', 'torso rotation', 'torso twist',
  'profile', 'sideways', 'side on', 'side-on',
])

/** 判断"只剩转体"时要忽略的词：它们不承载新信息。 */
const ROTATION_RESTATEMENT_FILLER = Object.freeze([
  'body', 'torso', 'upper', 'lower', 'turned', 'turn', 'turning', 'rotation', 'rotate', 'rotated',
  'twist', 'twisted', 'twisting', 'three', 'quarter', 'half', 'angle', 'angled', 'slightly',
  'slight', 'subtle', 'mild', 'minor', 'somewhat', 'away', 'side', 'view', 'position', 'posed',
  'pose', 'is', 'and', 'with', 'in', 'on', 'of', 'to', 'the', 'a', 'left', 'right',
  "viewer's", 'viewer', 'camera', 'camera s', 'toward', 'towards', 'facing',
])

/**
 * "转"不一定写成 three-quarter / profile。
 *
 * 真跑里出现过 `front-facing with slight turn to viewer's left`：前半句断言正对镜头，
 * 后半句又说身子朝观察者左侧转过去，两句互相推翻。因为句子里没有 `three quarter`、
 * 没有 `turned to the side`，词表一条都匹配不上，这条矛盾就原样进了编译。
 * 这里把 turn / rotate / twist 单独认一遍。
 */
const ROTATION_TURN_PATTERN = /\b(?:turn(?:s|ed|ing)?|rotat(?:e|es|ed|ing|ion)|twist(?:s|ed|ing)?)\b/

/**
 * 转体写明朝哪边时可以直接落成 `facing viewer's left`。
 *
 * 这和"哪侧肩更近"不是一回事：肩线远近要靠肩的远近证据推，而"朝观众左边转"
 * 已经把朝向说出来了，照抄即可，不算编。
 */
const TURN_DIRECTION_PATTERN =
  /\b(?:to|toward|towards|facing)\s+(?:the\s+)?(?:viewer['’]?s?\s+|camera['’]?s?\s+)?(left|right)\b/

/** 讲头/脸转、且一句躯干词都没有时，不能当成躯干转体。 */
const BODY_WORDS = Object.freeze(['body', 'torso', 'waist', 'shoulder', 'shoulders', 'hip', 'hips'])

/**
 * 角度本身不是信息：`turned 3/4 toward viewer right` 与 `body turned three-quarter`
 * 说的是同一件事。数字写法的角度（`3/4`、`45 degrees`）也要当填充词忽略，
 * 否则这类片段会被判成"还带着别的信息"而留下来，描述版里就并列两句转体。
 */
const ROTATION_ANGLE_TOKEN = /^(?:\d+(?:[/.]\d+)?|degrees?|deg)$/

function isRotationRestatement(segment) {
  const lowered = normalizedText(segment)
  const claimsRotation =
    ROTATION_RESTATEMENT_WORDS.some((word) => lowered.includes(word)) || ROTATION_TURN_PATTERN.test(lowered)
  if (!claimsRotation) return false
  const rest = lowered
    .split(/\s+/)
    .filter((word) => !ROTATION_RESTATEMENT_FILLER.includes(word) && !ROTATION_ANGLE_TOKEN.test(word))
  return rest.length === 0
}

/**
 * 找出真正在说"躯干背对镜头"的片段。
 *
 * `head turned away` / `face turned away` 讲的是头，属于合法信息，要豁免；
 * 只有讲躯干的 `turned away` 才和转体冲突。
 */
function backClaimIn(value) {
  for (const segment of String(value ?? '').split(/[,;]+/)) {
    const lowered = normalizedText(segment)
    if (lowered.length === 0) continue
    if (HEAD_WORDS.some((word) => lowered.includes(word))) continue
    const hit = BACK_CLAIM_WORDS.find((word) => lowered.includes(word))
    if (hit) return hit
  }
  return null
}

/**
 * 躯干朝向收敛：写了正面断言、又写了肩线远近证据时，按证据改成转体。
 *
 * 为什么必须程序兜底而不是只靠提示词：`facing viewer` + `left shoulder forward` 这
 * 一对是模型描述"侧身站但脸朝镜头"时最顺手的写法，提示词里反复写"只写 facing viewer
 * 会把人摆正"，它仍然会这么写。而这一句直接决定生成端把身体摆正还是转过去，
 * 是"侧身被读成正对"的唯一入口。
 *
 * 判据是纯文本的：同一条观察里既有正面断言，又有"某侧肩更近/更前"的断言，
 * 两者不可能同时成立——肩线一近一远，躯干就已经转过去了。此时删掉正面断言，
 * 把转体与远近肩写成领起句，并把"轻微"这类糊弄词摘掉。
 */
/**
 * 原文自己写明的角度词 → 领起句。只在原文确实写了的时候用。
 * 不在这里的表里的说法（`slight turn`、`a bit to the side`）一律不补角度：
 * "稍微转了一点"和"四分之三侧身"差着一个量级，替观察者补成具体值就是编。
 */
const ANGLE_LEADS = Object.freeze([
  ['three-quarter', 'body turned three-quarter'],
  ['three quarter', 'body turned three-quarter'],
  ['profile', 'body turned to profile'],
])

export function enforceTorsoOrientation(ir) {
  const rewritten = []
  const injected = []
  const unmeasured = []

  for (const entry of featureList(ir)) {
    const feature = entry.feature
    if (String(feature?.category ?? '') !== 'pose_action') continue
    const value = String(feature?.value ?? '')
    if (value.length === 0) continue

    const lowered = normalizedText(value)
    const front = FRONT_CLAIM_WORDS.find((word) => lowered.includes(word)) ?? null
    // "背对镜头"和"正对镜头"一样，都是与肩线远近证据冲突的朝向断言。
    const back = front ? null : backClaimIn(value)
    // 肩线证据只写了一半也算：真跑里模型常写 `left shoulder pulled back` 而不写
    // 哪侧肩更近。左肩后拉就意味着右肩在前，近侧由远侧反推，不能因为没有 "nearer"
    // 这个词就放过整条——那正是"侧身被读成正对"最常漏的一类。
    // 两种语序都认（`left shoulder forward` / `shoulder on the left side forward`）。
    const shoulderDepth = shoulderDepthIn(value)
    // 肩线证据一条都没有时，还剩一类矛盾能靠纯逻辑判掉：同一句里既写 `front-facing`
    // 又写 `three-quarter angle` / `shoulder-hip twist`。正面正对意味着肩线与髋线平行、
    // 左右对称，转体与扭转恰恰否定了这一点，两句话不能同时成立。
    //
    // 真跑里这条矛盾是从局部复核补回来的：`front-facing, slight three-quarter angle,
    // slight shoulder-hip twist` 原样编译出去，生成端只能二选一，通常选更保守的正面，
    // 于是侧身又被读成正对——那是已经修过一轮、又从这里漏回来的退化路径。
    // 转体在这句里被写了两遍（转体角度 + 肩髋扭转），正面只写了一遍，按转体收。
    const rotationWord = ROTATION_RESTATEMENT_WORDS.find((word) => lowered.includes(word)) ?? null
    const turnWord = rotationWord ? null : (lowered.match(ROTATION_TURN_PATTERN)?.[0] ?? null)
    // `head turned to the left` 说的是脸朝向，不是身子转——把它改写成转体会凭空造出侧身。
    const headOnlyTurn =
      !BODY_WORDS.some((word) => lowered.includes(word)) && HEAD_WORDS.some((word) => lowered.includes(word))
    const rotationHit = headOnlyTurn ? null : (rotationWord ?? turnWord)
    if (!shoulderDepth) {
      if (!front || !rotationHit) continue
    }
    // 既没有正面断言也没有背对断言时，只有"写了转体但没写成领起句"才值得规范化。
    // 真跑里出现过 `turned three-quarter, facing left, right shoulder forward and nearer
    // to the camera, left shoulder pulled back` —— 这条本来就读对了，主循环却因为
    // 找不到 facing viewer 而跳过它，随后注入分支又补了一条同义的 torso_rotation，
    // 于是描述版里 `turned three-quarter` 与 `body turned three-quarter` 并列。
    // 已经以领起句开头的，直接放过。
    const alreadyRotated = Boolean(rotationHit)
    if (!front && !back) {
      if (!alreadyRotated || lowered.startsWith('body turned')) continue
    }

    const near = shoulderDepth ? shoulderDepth.near : null
    const far = shoulderDepth ? shoulderDepth.far : null
    // 没有肩线时不能编方向：只能写"转过去了"，不能写"哪侧肩在前"。
    // 但"朝观众左边转"这种话已经把朝向说出来了，照抄成 facing viewer's left 不算编。
    const turnDirection = near ? null : (lowered.match(TURN_DIRECTION_PATTERN)?.[1] ?? null)
    // 曾经在这里用"朝观众左边转 ⇒ 左肩更近"把肩线推出来（derived_shoulder）。
    // 那是编的：肩线远近是**量**出来的（肩宽比、远侧肩被挡、髋线斜度），不是从转向
    // 逻辑演绎出来的。真实画面里人朝左转、右肩却前倾完全可能（扭腰、重心偏移）。
    // 更糟的是它顺手把 `slight turn` 抬成了 `three-quarter`——原文说的是"稍微转了一点"，
    // 改写成四分之三侧身，等于替观察者把没量的角度补成了具体值。
    // 现在只保留"转了"与原文写明的方向，角度与近侧肩都留给复核。
    const reasonKind = near ? 'shoulder_evidence' : 'rotation_conflict'
    // 逐段处理：删掉朝向断言所在的整段，剩下的段落去掉"轻微"类修饰后保留。
    // 肩线远近的段落也要删——lead/tail 已经把它写全了，留着就会在描述里重复两遍，
    // 而重复的"left shoulder forward"读起来像另一个独立的动作，不是同一件事。
    // 只重复"身体转过去了"的片段同样要删，否则 `body turned three-quarter` 与
    // `torso turned three quarter` 并列，生成端会各取一半。
    const segments = value
      .split(/[,;]+/)
      .map((segment) => segment.trim())
      .filter(Boolean)
      .filter((segment) => !FRONT_CLAIM_WORDS.some((word) => normalizedText(segment).includes(word)))
      .filter((segment) => shoulderDepthIn(segment) === null)
      .filter((segment) => !isRotationRestatement(segment))
      .filter((segment) => {
        const loweredSegment = normalizedText(segment)
        // 讲头/脸的 "turned away" 是合法信息，留着；讲躯干的背对必须删掉。
        if (HEAD_WORDS.some((word) => loweredSegment.includes(word))) return true
        return !BACK_CLAIM_WORDS.some((word) => loweredSegment.includes(word))
      })
      .map((segment) => {
        let next = segment
        for (const hedge of ROTATION_HEDGE_WORDS) next = stripPhrase(next, hedge)
        return next.replace(/\s{2,}/g, ' ').replace(/^[\s,;]+|[\s,;]+$/g, '').trim()
      })
      .filter(Boolean)

    // 没有肩线证据时只写"转了"和原文写明的方向；不写角度、不写近侧肩。
    // 角度（three-quarter / profile）与"哪侧肩更近"都是量出来的结论，
    // 原文没给就留空，让不确定性记录去触发复核。
    //
    // 但原文**自己写了**角度词的，照抄不算编：`slight three-quarter angle` 里的
    // three-quarter 是观察者写的，摘掉它反而丢信息。区别在于"没写就不补"。
    const angleLead = near ? null : (ANGLE_LEADS.find(([word]) => lowered.includes(word))?.[1] ?? null)
    const lead = near
      ? `body turned three-quarter, ${near} shoulder forward and nearer to the camera`
      : angleLead
        ? turnDirection
          ? `${angleLead}, facing viewer's ${turnDirection}`
          : angleLead
        : turnDirection
          ? `body turned, facing viewer's ${turnDirection}`
          : 'body turned'
    const next = far ? [lead, ...segments, `${far} shoulder pulled back`].join(', ') : [lead, ...segments].join(', ')

    const index = entry.holder.indexOf(feature)
    if (index < 0) continue
    feature.value = next
    feature.importance = Math.max(Number(feature.importance ?? 0), 0.9)
    const conflict = front ?? back
    const reason =
      reasonKind === 'shoulder_evidence'
        ? conflict
          ? `原文同时写了「${conflict}」与「${near} 侧肩更近」，按肩线证据改判为转体，并摘掉"轻微"类修饰`
          : `原文已写了转体但没写成领起句，按「${near} 侧肩更近」改写为 body turned three-quarter，并摘掉重复的转体说法与"轻微"类修饰`
        : `原文写了转体${turnDirection ? `与方向（朝观众${turnDirection}侧）` : ''}，但没有肩线远近证据：只保留"转了"与已写明的方向，角度与近侧肩交给复核`
    feature.note = `${feature.note ? `${feature.note}；` : ''}证据层：${reason}`
    if (!near) {
      // 转了但没量出角度与近侧肩。这是"无法裁决"，不是"可以随便填一个"：
      // 记一条不确定性并写明需要复核什么，让局部复核去量肩宽比与肩线远近。
      addUncertainty(ir, {
        code: 'insufficient_detail',
        subject: 'pose_action.torso_orientation',
        question: `躯干转了，但哪侧肩更近、转了多少度没量出来（原文：${value}）；需要复核两侧肩的可见宽度比与髋线斜度`,
        severity: 'medium',
      })
      unmeasured.push({ from: value, to: next, turn_direction: turnDirection })
    }
    rewritten.push({ from: value, to: next, front_claim: front, back_claim: back, near_shoulder: near, reason_kind: reasonKind })
  }

  // 转体证据已经有了，但没有任何一条观察把它写成领起句：补一条高重要度的独立观察，
  // 让它排在描述版靠前的位置，而不是被埋在几十个词之后。
  const hasRotationLead = featureList(ir).some(({ feature }) => {
    if (String(feature?.category ?? '') !== 'pose_action') return false
    return normalizedText(feature?.value).startsWith('body turned')
  })
  if (!hasRotationLead && rewritten.length === 0) {
    const shoulderEntry = featureList(ir).find(({ feature }) => {
      if (String(feature?.category ?? '') !== 'pose_action') return false
      const lowered = normalizedText(feature?.value)
      return shoulderDepthIn(lowered) !== null
    })
    if (shoulderEntry) {
      // 只写了"某侧肩后拉"时，近侧就是另一侧。
      const { near, far } = shoulderDepthIn(shoulderEntry.feature?.value)
      const value = `body turned three-quarter, ${near} shoulder forward and nearer to the camera, ${far} shoulder pulled back`
      addFeature(
        ir,
        'pose_action',
        'torso_rotation',
        {
          value,
          confidence: 0.8,
          importance: 0.92,
          status: 'confirmed',
          note: '证据层：观察里已写明两侧肩的远近，据此补出转体朝向',
        },
        { source: 'global_analysis' },
      )
      injected.push(value)
    }
  }

  // 转体成立之后，其它观察里只重复"身体转过去了"这一件事的条目要删掉。
  // 真跑里出现过 `body turned three-quarter` 与 `three quarter view` 并列：
  // 两句都是转体，生成端会各取一半；而且 `three_quarter_view` 在知识库里是 0 作品数的死标签。
  const deduped = []
  if (rewritten.length > 0 || injected.length > 0) {
    for (const entry of featureList(ir)) {
      const feature = entry.feature
      if (String(feature?.category ?? '') !== 'pose_action') continue
      const value = String(feature?.value ?? '')
      if (value.length === 0) continue
      // 自己刚写的那条转体领起句不能删。
      if (normalizedText(value).startsWith('body turned')) continue
      if (!isRotationRestatement(value)) continue
      const index = entry.holder.indexOf(feature)
      if (index < 0) continue
      entry.holder.splice(index, 1)
      deduped.push({ category: 'pose_action', key: String(feature.key ?? ''), from: value })
    }
  }

  // 转体成立之后，机位槽里的**身体朝向声明**要处理，但机位轴词一条都不许动。
  //
  // 这两件事以前是混着办的：只要机位槽里出现"正面"类词，就把整条机位删掉。
  // 结果 `camera.angle = 'straight-on, eye level, full body'` 被削成
  // `eye level, full body`——镜头从哪看这条观察没了。而 `straight-on` 说的是
  // 镜头没歪，跟人物身体朝哪是两个轴：侧身站、正对着拍，本来可以同时成立。
  //
  // 现在：机位轴词（CAMERA_AXIS_WORDS）保留并留痕；只有写错槽的身体朝向声明
  // （SUBJECT_FACING_WORDS）才摘，且摘完记一条 uncertainty，说明原处写了什么、
  // 为什么摘、该由复核确认哪一侧。
  //
  // 注意：camera / composition 是 IR 里的具名段（`ir.camera[key]`），不在 features 数组里，
  // 所以必须单独走一遍，否则真跑的 camera 槽根本碰不到。
  const cameraCleaned = []
  const cameraKept = []
  if (rewritten.length > 0 || injected.length > 0) {
    for (const section of ['camera', 'composition']) {
      const named = ir[section]
      if (!named || typeof named !== 'object') continue
      for (const [key, feature] of Object.entries(named)) {
        if (!feature || typeof feature !== 'object') continue
        const value = String(feature.value ?? '')
        const lowered = normalizedText(value)
        const axisHits = CAMERA_AXIS_WORDS.filter((word) => lowered.includes(word))
        const facingHits = SUBJECT_FACING_WORDS.filter((word) => lowered.includes(word))
        if (axisHits.length === 0 && facingHits.length === 0) continue

        if (axisHits.length > 0) {
          // 机位轴词：保留原值，只补一句说明它跟躯干转体不是一回事。
          cameraKept.push({ category: section, key, value, words: axisHits })
        }
        if (facingHits.length === 0) continue

        let remainder = value
        for (const hit of facingHits) remainder = stripPhraseLoose(remainder, hit)
        remainder = remainder
          .replace(/\s*[,;]\s*(?=[,;])/g, '')
          .replace(/\s{2,}/g, ' ')
          .replace(/^[\s,;]+|[\s,;]+$/g, '')
          .trim()

        if (remainder.length === 0) {
          delete named[key]
        } else {
          feature.value = remainder
          feature.note = `${feature.note ? `${feature.note}；` : ''}证据层：机位槽里写的是身体朝向（${facingHits.join(', ')}），不是机位；躯干已判为转体，这处说法自相矛盾，摘掉后交给复核`
        }
        cameraCleaned.push({ category: section, key, from: value, to: remainder, words: facingHits })
        // 摘掉不等于问题解决：原处到底是不是"身体正对"，得复核来定。
        addUncertainty(ir, {
          code: 'unsupported_observation',
          subject: `${section}.${key}`,
          question: `机位槽里写了「${facingHits.join(', ')}」，这是身体朝向的说法；躯干已判为转体，两处冲突，需要复核人物正面朝向与镜头轴向各自的结论`,
          severity: 'low',
        })
      }
    }
  }

  return {
    applied: rewritten.length > 0 || injected.length > 0 || cameraCleaned.length > 0 || deduped.length > 0,
    rewritten,
    injected,
    deduped,
    camera_cleaned: cameraCleaned,
    camera_kept: cameraKept,
    unmeasured,
  }
}

/**
 * 平涂渲染词：把画面断言成"线稿 + 平涂"的那一组。
 *
 * 它们本身不是错的——很多图确实长这样。问题在于像素证据已经量出"黑场抬高、对比压低、
 * 边缘发软"（散射介质），此时还写 `anime digital illustration` / `cel shading`，
 * 等于用题材词把柔焦厚涂的质感重新压成硬边平涂，生成端照着平涂画。
 */
const FLAT_RENDER_WORDS = Object.freeze([
  'anime digital illustration', 'anime illustration', 'anime coloring', 'anime style',
  'cel shading', 'cel-shaded', 'cel shaded', 'flat color', 'flat colors', 'flat coloring',
  'flat shading', 'flat lighting', 'lineart', 'line art', 'clean lineart',
  'cartoon', 'comic style', '2d animation', 'vector art', 'pixel art', 'flat design',
])

/** 软质感词：散射证据成立时该有的那一组。 */
const SOFT_RENDER_WORDS = Object.freeze([
  'painterly', 'soft focus', 'diffused', 'airbrushed', 'atmospheric perspective',
  'no visible lineart', 'no lineart', 'without lineart', 'lineart free',
])

/**
 * 媒介证据：说明"用什么做的"。
 *
 * 与锐度词分开列，是因为这两件事经常不一致，而且**必须分开判断**：
 * 照片可以失焦（软、低对比），厚涂也可以硬边（清晰、高对比）。
 * 以前把"软"直接当"绘画"的证据，`photographic, camera lens bokeh` 会被塞进 `painterly`。
 */
const PHOTO_MEDIUM_WORDS = Object.freeze([
  'photographic', 'photograph', 'photo', 'camera lens', 'lens bokeh', 'bokeh',
  'dslr', 'shot on film', 'film grain', '35mm', 'rendered in 3d', '3d render',
  'cgi', 'octane render', 'unreal engine', 'raytracing', 'ray tracing',
])

const PAINT_MEDIUM_WORDS = Object.freeze([
  'oil painting', 'oil on canvas', 'watercolor', 'watercolour', 'gouache', 'acrylic',
  'ink wash', 'charcoal', 'pastel drawing', 'brush strokes', 'brushwork',
  'impasto', 'thick paint', 'painted in', 'digital painting', 'matte painting',
])

/**
 * 被否定的平涂词不算平涂断言。
 *
 * `no visible lineart` 是**柔**的证据（没有线稿＝不是线稿平涂），
 * 但字面上含 `lineart`，会被平涂词表当成"写了平涂"摘掉，
 * 于是观察被削成 `no visible` 这种残句，再被否定式过滤器整条丢掉——
 * 一条正确的观察被自己的兜底打没了。判据是看它前面有没有否定词。
 */
const NEGATED_FLAT_PATTERN = /\b(?:no|without|not|zero|free of)\s+(?:visible\s+|apparent\s+|any\s+)?$/

function isNegatedOccurrence(lowered, word) {
  let index = lowered.indexOf(word)
  if (index < 0) return false
  // 只有"每一处出现都被否定"才算否定；有一处是肯定断言就仍是平涂词。
  while (index >= 0) {
    const head = lowered.slice(Math.max(0, index - 24), index)
    if (!NEGATED_FLAT_PATTERN.test(head)) return false
    index = lowered.indexOf(word, index + word.length)
  }
  return true
}

/**
 * 题材词冒充媒介结论的那一组。
 *
 * `fantasy character design` / `concept art` 说的是"画的是什么、给谁看的"，
 * 不是"用什么画的"。它们出现在 D2 的媒介槽里，等于把媒介问题绕过去了——
 * 生成端读到 `character design` 就按设定图（平涂、硬边、三视图感）画，
 * 而像素证据说的明明是柔焦厚涂。像素已证明画面是柔的时候，这类词要摘掉，
 * 让媒介结论只剩真正的介质词。
 */
const TOPIC_STYLE_WORDS = Object.freeze([
  'fantasy character design', 'character design', 'character sheet', 'concept art',
  'game art', 'fantasy art', 'illustration style',
])

/**
 * 上面那张表是"见过就写下来"的补丁，只能盖住见过的写法。实测又冒出来
 * `fantasy costume design`——换个名词就整条穿过去了。这里按**结构**认：
 * 「（限定词）+ 题材名词 + design/art/sheet」，只要落在 D2 的媒介槽里就一律算题材词，
 * 不必逐个枚举名词。`concept art` 这类没带题材名词的也照认。
 */
const TOPIC_STYLE_PATTERN =
  /\b(?:(?:fantasy|game|anime|manga|comic|costume|outfit|character|creature|monster|mecha|sci[\s-]?fi|concept|environment|prop)\s+){1,2}(?:design|designs|art|sheet|sheets|illustration|concept)\b/

function topicStyleHits(lowered) {
  const hits = TOPIC_STYLE_WORDS.filter((word) => lowered.includes(word))
  const match = lowered.match(TOPIC_STYLE_PATTERN)
  if (!match) return hits
  const text = match[0].trim()
  // 表里已经覆盖的写法不要重复摘，否则同一段文字被削两遍、留下空档。
  const covered = hits.some((word) => text.includes(word) || word.includes(text))
  return covered ? hits : [...hits, text]
}

/**
 * 渲染介质收敛：像素证明画面是柔的，就不许用平涂词把质感压回去。
 *
 * 与 `enforceDiffusion` 的分工：那一层管"高对比/硬光/锐利轮廓"这类**光影**冲突词，
 * 这一层管"平涂/线稿/卡通"这类**渲染介质**冲突词。两者都是同一类失败——
 * 用户看到的是"提示词里写的是柔焦，生成出来是硬边平涂"。
 */
export function enforceRenderMedium(ir, metrics) {
  const diffusion = metrics?.diffusion
  const soft = diffusion?.diffuse === true || metrics?.verdict?.hazy === true
  if (!soft) return { applied: false, dropped: [], trimmed: [], injected: [], topic_dropped: [] }

  const dropped = []
  const trimmed = []
  const topicDropped = []
  const RENDER_CATEGORIES = new Set(['quality_style', 'appearance'])
  for (const entry of featureList(ir)) {
    if (!RENDER_CATEGORIES.has(String(entry.feature?.category ?? ''))) continue
    const value = String(entry.feature?.value ?? '')
    const lowered = normalizedText(value)
    // 被否定的平涂词不算平涂断言：`no visible lineart` 是"柔"的证据。
    // 它字面上含 lineart，若不排除就会被摘成 `no visible` 残句，
    // 再被编译层的否定式过滤器整条丢掉——正确观察被自己的兜底打没了。
    const hits = FLAT_RENDER_WORDS.filter(
      (word) => lowered.includes(word) && !isNegatedOccurrence(lowered, word),
    )
    const topicHits = topicStyleHits(lowered)
    if (hits.length === 0 && topicHits.length === 0) continue

    let remainder = value
    for (const hit of [...hits, ...topicHits]) remainder = stripPhrase(remainder, hit)
    remainder = remainder
      .replace(/\s*[,;]\s*(?=[,;])/g, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s,;]+|[\s,;]+$/g, '')
      .trim()

    const index = entry.holder.indexOf(entry.feature)
    if (index < 0) continue

    if (remainder.length === 0) {
      entry.holder.splice(index, 1)
      dropped.push({ category: entry.feature.category, key: entry.feature.key, value })
      if (topicHits.length > 0) {
        topicDropped.push({ category: entry.feature.category, key: entry.feature.key, from: value, words: topicHits })
      }
      continue
    }
    entry.feature.value = remainder
    const notes = []
    if (hits.length > 0) notes.push(`剔除与散射介质证据冲突的平涂渲染词（${hits.join(', ')}）`)
    if (topicHits.length > 0) notes.push(`摘掉冒充媒介结论的题材词（${topicHits.join(', ')}）`)
    entry.feature.note = `${entry.feature.note ? `${entry.feature.note}；` : ''}像素预检：${notes.join('，')}`
    trimmed.push({ category: entry.feature.category, key: entry.feature.key, from: value, to: remainder })
    if (topicHits.length > 0) {
      topicDropped.push({ category: entry.feature.category, key: entry.feature.key, from: value, words: topicHits })
    }
  }

  const present = new Set(featureList(ir).map(({ feature }) => normalizedText(feature?.value)))
  const injected = []
  // 已经写了柔质感词就不再补：这些补丁是为了把被平涂词压掉的**锐度**信息补回来，
  // 不是每次都要出现。
  const alreadySoft = [...present].some((value) => SOFT_RENDER_WORDS.some((word) => value.includes(word)))

  // 关键：软边与低对比只证明**锐度/对比度**，不证明**媒介**。
  // 照片也能软（失焦、镜头虚化、柔光镜），厚涂也能硬。以前这里无条件补
  // `painterly` + `soft focus`，于是 `photographic, camera lens bokeh` 这种明明
  // 写着照片的观察被硬塞了 `painterly`——用户看到的是"照片被画成了插画"。
  // 现在只补锐度那一轴；媒介那一轴必须另有证据才敢写。
  const photographicEvidence = [...present].some((value) =>
    PHOTO_MEDIUM_WORDS.some((word) => value.includes(word)),
  )
  const painterlyEvidence = [...present].some((value) =>
    PAINT_MEDIUM_WORDS.some((word) => value.includes(word)),
  )
  const mediumSettled = photographicEvidence || painterlyEvidence

  const additions = alreadySoft ? [] : [['focus', 'soft focus']]
  for (const [key, value] of additions) {
    if (present.has(normalizedText(value))) continue
    addFeature(
      ir,
      'quality_style',
      key,
      {
        value,
        confidence: 0.8,
        importance: 0.88,
        status: 'confirmed',
        note: '像素预检：黑场抬高、对比压低、边缘发软——这是锐度证据，说明不是硬边锐利，不等于"这是绘画"',
      },
      { source: 'global_analysis' },
    )
    injected.push(value)
  }

  // 媒介这一轴没证据就不写。软边既可能是照片虚化，也可能是厚涂；
  // 两边都不写，交给复核，比写错一个介质强。
  if (!mediumSettled) {
    addUncertainty(ir, {
      code: 'lens_effect_ambiguous',
      subject: 'quality_style.render_medium',
      question:
        '画面偏软、对比偏低，但软边只说明锐度，说明不了媒介：可能是照片虚化/柔光，也可能是厚涂。需要复核笔触、噪点颗粒、边缘形态来判定介质',
      severity: 'medium',
    })
  }

  return {
    applied: dropped.length > 0 || trimmed.length > 0 || injected.length > 0,
    dropped,
    trimmed,
    injected,
    topic_dropped: topicDropped,
    medium_settled: mediumSettled,
    photographic_evidence: photographicEvidence,
    painterly_evidence: painterlyEvidence,
  }
}

/**
 * 遮挡式观察：眼睛看不清。
 *
 * 编译层会把这些写成否定式（`eyes not visible`）的观察整条剔除——理由是对的：
 * 正向词里写"没有 X"会召唤 X。但脸这一块的特殊之处在于，剔掉之后**没有任何
 * 肯定式说法顶上来**，提示词里就只剩 `face in shadow` 一条弱词，生成端把脸画得清清楚楚。
 * 知识库里本来就有 `eyes in shadow`（1358）与 `face in shadow`（683）这两个肯定式标签。
 *
 * 但"看不清"有好几种**互不相同**的原因，把它们全换成"在阴影里"是错的：
 * - 阴影：脸落在暗部 → `eyes in shadow` / `face in shadow` 成立
 * - 物体遮挡：墨镜、头发、手、面纱、眼罩 → 光线完全可能很足，说"在阴影里"是假话
 * - 画幅裁切：眼睛在画面外 → 与这张图的光照毫无关系
 * 所以先认原因，再决定能不能说"在阴影里"；认不出或不是阴影的，只记不确定性，
 * 不拿一个错误的光照结论去顶替遮挡结论。
 */
const EYE_OCCLUSION_PATTERN = /\beyes?\b[^.;]{0,40}\b(?:not visible|not discernible|not readable|unreadable|hidden|obscured|in shadow|shadowed|indiscernible)\b/

/** 只有这些词才说明"看不清"的原因是暗，够格写 in shadow。 */
const SHADOW_CAUSE_WORDS = Object.freeze([
  'in shadow', 'shadowed', 'deep shadow', 'in darkness', 'underlit',
  'shaded', 'darkened', 'silhouetted', 'against the light',
])

/** 物体挡住眼睛：光可能很足，不能据此断言阴影。 */
const OBJECT_CAUSE_WORDS = Object.freeze([
  'sunglasses', 'glasses', 'goggles', 'visor', 'eyepatch', 'eye patch', 'blindfold',
  'mask', 'veil', 'hood', 'hat brim', 'brim', 'hair', 'fringe', 'bangs', 'strand',
  'hand', 'fingers', 'arm', 'glove', 'fan', 'sleeve', 'cloth', 'fabric', 'prop',
])

/** 眼睛不在画面里：这是画幅问题，不是光照问题，也不是"看不到所以画得清楚"。 */
const CROP_CAUSE_WORDS = Object.freeze([
  'crop', 'cropped', 'out of frame', 'off frame', 'frame edge', 'edge of the frame',
  'cut off', 'edge of the image', 'off-screen', 'offscreen', 'outside the frame',
])

function occlusionCauses(lowered) {
  const causes = []
  if (SHADOW_CAUSE_WORDS.some((word) => lowered.includes(word))) causes.push('shadow')
  if (OBJECT_CAUSE_WORDS.some((word) => lowered.includes(word))) causes.push('object')
  if (CROP_CAUSE_WORDS.some((word) => lowered.includes(word))) causes.push('crop')
  return causes
}

export function enforceFaceOcclusion(ir) {
  const entries = featureList(ir)
  const hits = []
  for (const { feature } of entries) {
    if (!FACE_CATEGORIES.has(String(feature?.category ?? ''))) continue
    const lowered = normalizedText(feature?.value)
    if (!EYE_OCCLUSION_PATTERN.test(lowered)) continue
    hits.push({ feature, lowered, value: String(feature?.value ?? '') })
  }
  if (hits.length === 0) return { applied: false, injected: [], causes: [], shadow_evidence: false }

  const causes = [...new Set(hits.flatMap((hit) => occlusionCauses(hit.lowered)))]
  const shadowEvidence = causes.includes('shadow')

  // 观察值常常是逗号分隔的复合串（`head tilted down, face in shadow, eyes not visible`）。
  // 用整串全等去比，会把里面已经写过的 `face in shadow` 判成"没写过"，于是又补一条
  // 同义观察——IR 里就同时存在"原句里那一半"和"补出来的整条"，同一条断言算了两遍。
  // 这里改成"脸这一类的观察里是否已经出现过这个说法"，不再要求整串相等。
  const faceValues = entries
    .filter(({ feature }) => FACE_CATEGORIES.has(String(feature?.category ?? '')))
    .map(({ feature }) => normalizedText(feature?.value))
  const alreadySaid = (value) => {
    const target = normalizedText(value)
    return faceValues.some((existing) => existing.includes(target))
  }

  const injected = []
  if (shadowEvidence) {
    for (const value of ['eyes in shadow', 'face in shadow']) {
      if (alreadySaid(value)) continue
      addFeature(
        ir,
        'expression',
        value === 'eyes in shadow' ? 'eye_light' : 'face_light',
        {
          value,
          confidence: 0.82,
          importance: 0.9,
          status: 'confirmed',
          note: '证据层：观察写的是"眼睛在阴影里看不清"，换成肯定式标签，避免被否定式剔除后脸这一块失去约束',
        },
        { source: 'global_analysis' },
      )
      injected.push(value)
    }
  }

  // 不是阴影造成的遮挡，不许用阴影词顶替。把真正的原因记成待复核项，
  // 让复核去看清到底是墨镜、头发还是裁切——这一步不产生任何光照断言。
  for (const hit of hits) {
    const own = occlusionCauses(hit.lowered)
    if (own.includes('shadow')) continue
    const code = own.includes('crop') ? 'out_of_frame' : 'occluded_region'
    const what = own.includes('crop')
      ? '眼睛不在画幅内'
      : own.includes('object')
        ? '眼睛被物体挡住'
        : '眼睛看不清，但原因没写清楚'
    addUncertainty(ir, {
      code,
      subject: 'expression.eye_light',
      question: `${what}（原文：${hit.value}）。这不是光照结论，别写成 in shadow；需要复核遮挡物是什么、光线落在脸上的哪一侧`,
      severity: 'medium',
    })
  }

  return { applied: injected.length > 0, injected, causes, shadow_evidence: shadowEvidence }
}

/**
 * 机位词：描述"镜头在哪"。它们**不是**躯干朝向，但模型经常把 `straight-on` /
 * `from_front` 直接当成"身体正面朝镜头"，于是侧身站立被写成正身。
 */
const CAMERA_POSITION_WORDS = Object.freeze([
  'straight on', 'straight-on', 'from front', 'from-front', 'front view', 'frontal',
  'from side', 'from-side', 'side view', 'profile view',
  'from behind', 'from-behind', 'back view', 'rear view',
  'three quarter view', 'three-quarter view', 'dutch angle', 'high angle', 'low angle',
])

const ORIENTATION_WORDS = Object.freeze([
  'facing viewer', 'facing the viewer', 'facing camera', 'facing away', 'facing left',
  'facing right', 'facing sideways', 'turned toward viewer', 'turned away',
  'body turned', 'torso turned', 'turned to the side', 'body facing',
  // `front-facing` 归一后是 `front facing`，它已经把这个轴线说清楚了；
  // 漏掉这一条会让「写了正面朝向」的观察反过来被报成"缺少躯干朝向"。
  'front facing',
])

const TWIST_WORDS = Object.freeze([
  'contrapposto', 'torso twist', 'twisted torso', 'twisted waist', 'hip tilt',
  'shoulder hip offset', 'leaning back', 'leaning forward', 'arched back',
  'hips tilted', 's curve', 's-curve',
])

const STANCE_WORDS = Object.freeze([
  'standing on one leg', 'on one leg', 'weight on', 'crossed legs', 'kneeling',
  'sitting', 'squatting', 'walking', 'running', 'stepping', 'leg up', 'leg raised',
  'tiptoes', 'flat feet', 'feet apart', 'feet together', 'lunging', 'crouching',
])

const HAND_WORDS = Object.freeze([
  'arm outstretched', 'outstretched arm', 'reaching', 'hand on own chest', 'hands on hips',
  'hands in pockets', 'hand up', 'waving', 'pointing', 'holding', 'gripping', 'clenched',
  'spread fingers', 'fingers spread', 'fingers curled', 'open hand', 'fist', 'palm',
])

function normalizedText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 手在哪一侧。写动作时必须点明左右手，否则两条手部观察会互相顶掉：
 * 一条写"一只手抚胸"、一条写"一只手向前伸"，编译出来只剩一只手的位置。
 *
 * 注意 "one hand" / "either hand" 不算：它们恰恰是没点明左右的那种写法。
 */
const HAND_SIDE_WORDS = Object.freeze([
  'left hand', 'right hand', 'both hands',
  'her left', 'her right', 'his left', 'his right', 'their left', 'their right',
  'left arm', 'right arm', 'both arms',
])

/**
 * "被带着"而不是"被握着"的措辞：佩在腰间、挂在髋侧、收在鞘里。
 *
 * 这是反推里最常见的一处动作错读——武器是穿在身上的装备，模型却写成手握，
 * 于是提示词给出 `holding sword`，生成端把剑塞进手里，整张图的姿态全变。
 */
const CARRIED_NOT_HELD_WORDS = Object.freeze([
  'sheathed', 'scabbard', 'holstered', 'holster', 'hilt visible', 'at her hip', 'at his hip',
  'at the hip', 'on her hip', 'on his hip', 'at waist', 'at the waist', 'on the belt',
  'on her belt', 'on his belt', 'hanging at', 'slung', 'tucked into the belt', 'belt loop',
  'worn at', 'worn on', 'side of her hip', 'side of his hip',
])

/**
 * 武器类名词：这类东西最容易被读成"握在手里"。
 *
 * 剑、刀、枪的重量和长度决定了它一旦握在手上，那只手就没有别的去向；反过来说，
 * 手的动作在别处（抚胸、前伸、拨发）而画面里仍能看见刀柄，它就是佩挂着的。
 * `contact` 关系踩的正是这个坑：看到刀柄贴着身体，就写成 touching short sword。
 */
const WEAPON_HINT_WORDS = Object.freeze([
  'sword', 'blade', 'dagger', 'katana', 'saber', 'sabre', 'rapier', 'knife', 'scabbard',
  'sheath', 'spear', 'lance', 'axe', 'halberd', 'staff', 'rifle', 'pistol', 'gun', 'holster',
])

/**
 * 转体声称：观察者说自己看见了侧转 / 斜四分之三 / 侧对。
 *
 * 单独列出来，是因为这一句最容易被"差不多"糊过去——写了 `slight three-quarter turn`，
 * 编译出来的标签是 `three_quarter_view`，可画面里的侧转其实接近侧身。转体一旦被读轻，
 * 整张图的姿态就正过来了，飘带的走向、腰线的位置、剑露在哪一侧全部跟着错。
 */
const ROTATION_CLAIM_WORDS = Object.freeze([
  'three quarter', 'three-quarter', 'profile', 'sideways', 'side on', 'side-on',
  'body turned', 'torso turned', 'turned to the side', 'half turned', 'half-turned', 'quarter turn',
])

/**
 * 肩深词：两侧肩谁离镜头更近。
 *
 * 这是判断转体角度的唯一硬证据。肩线是身体上最宽的一条横线，只要它不和画面横轴平行，
 * 就一定有一侧肩更近、一侧更远；把这层写出来，"轻微的斜四分之三"和"接近侧身"就不会
 * 再混成同一句话。
 */
const SHOULDER_DEPTH_WORDS = Object.freeze([
  'near shoulder', 'far shoulder', 'nearer shoulder', 'shoulder nearer',
  'left shoulder forward', 'right shoulder forward', 'left shoulder back', 'right shoulder back',
  'left shoulder closer', 'right shoulder closer', 'one shoulder closer',
  'left side toward', 'right side toward', 'left side away', 'right side away',
  'closer to the camera', 'closer to camera', 'farther from the camera', 'farther from camera',
  'near side', 'far side',
])

function relationTextOf(relation) {
  return normalizedText(`${relation?.type ?? ''} ${relation?.description ?? ''}`)
}

/**
 * 把"握着/碰着"的措辞换掉，而不是在后面加注。
 *
 * 加注会留下 `touching short sword（佩在腰间，不在手里）`——前半句仍是英文动作词，
 * 一旦这条关系被别处拿去拼句子，剑又回到手里。这里直接把动作词换成佩挂的说法，
 * 原判塞进括号留作诊断线索。
 */
function carriedDescription(description, note, phrase = '佩在身上，不在手里') {
  const text = String(description ?? '').trim()
  if (!text) return `${phrase}（${note}）`
  return `${phrase}（${note}；原文：${text}）`
}

function containsAny(text, words) {
  return words.some((word) => text.includes(word))
}

function poseTextOf(ir) {
  const parts = []
  for (const { feature } of featureList(ir)) {
    if (feature?.category !== 'pose_action') continue
    parts.push(feature.key, feature.value)
  }
  return normalizedText(parts.filter(Boolean).join(' ; '))
}

function poseValuesOf(ir) {
  const parts = []
  for (const { feature } of featureList(ir)) {
    if (feature?.category !== 'pose_action') continue
    if (feature?.value) parts.push(feature.value)
  }
  return parts.map((value) => normalizedText(value))
}

/**
 * 躯干到底转了没有。
 *
 * `head turned to viewer` 说的是脸朝哪边，不是身子转过去；把它算成转体会让
 * 体检报告"写了转体却没交代肩线"，凭空多出一条要复核的问题。只有句子讲躯干词、
 * 或者完全没提头/脸时，才算躯干转。
 */
function torsoRotationClaim(text) {
  const lowered = normalizedText(text)
  const claims = containsAny(lowered, ROTATION_CLAIM_WORDS) || ROTATION_TURN_PATTERN.test(lowered)
  if (!claims) return false
  const hasHead = HEAD_WORDS.some((word) => lowered.includes(word))
  const hasBody = BODY_WORDS.some((word) => lowered.includes(word))
  return hasBody || !hasHead
}

function cameraTextOf(ir) {
  const camera = ir?.camera ?? {}
  const parts = []
  for (const [key, entry] of Object.entries(camera)) {
    parts.push(key, entry?.value)
  }
  return normalizedText(parts.filter(Boolean).join(' ; '))
}

/**
 * 装备与手的一致性：`holding` 关系必须说得出"哪只手"，佩在腰上的东西不能算握着。
 *
 * 为什么单独查：关系是编译层唯一会直接变成 `holding_sword` 这类复合标签的东西。
 * 观察层写错一次，正向词就多一个把剑塞进手里的标签，而且它比姿态描述更强势——
 * 生成端会优先满足"手上有东西"。这一层做两件事：
 *   1. 关系描述里没有任何左右手词 → 无法确认手真的碰到了它，降级为 accessory；
 *   2. 描述或实体特征里出现鞘/腰/髋/带 → 它是穿在身上的，改判 accessory 并写明位置。
 */
export function checkEquipmentHandling(ir) {
  const relations = Array.isArray(ir?.relations) ? ir.relations : []
  const reclassified = []
  const withoutHand = []
  if (relations.length === 0) return { applied: false, reclassified, withoutHand }

  const pose = poseTextOf(ir)
  const handsBusyElsewhere =
    /hand on (?:own |her |his |their )?chest|hand on (?:own )?heart|arm outstretched|reaching toward/.test(pose) &&
    !HAND_SIDE_WORDS.some((word) => pose.includes(word))

  for (const relation of relations) {
    const type = String(relation?.type ?? '')
    if (type !== 'holding' && type !== 'contact') continue
    const target = (ir.entities ?? []).find((entity) => entity.entity_id === relation.to)
    const targetText = normalizedText(
      [target?.label, ...(target?.features ?? []).map((feature) => feature.value)].filter(Boolean).join(' ; '),
    )
    // `contact` 只在宾语是武器时才查：碰手、碰肩、倚着墙这些都是真接触，
    // 会被误判成佩挂。武器不一样——它贴着身体出现，几乎只能说明它是挂在身上的。
    if (type === 'contact' && !containsAny(targetText, WEAPON_HINT_WORDS)) continue
    const own = relationTextOf(relation)
    const carriedWord = CARRIED_NOT_HELD_WORDS.find((word) => own.includes(word) || targetText.includes(word))
    const hasHand = HAND_SIDE_WORDS.some((word) => own.includes(word))

    // 说清了是哪只手在握 → 这条关系成立，位置词（at her hip 之类）只说明握在哪。
    if (hasHand) continue

    // 佩挂：描述自己说了鞘/腰/带，或对象实体被描述成挂在髋侧。
    if (carriedWord) {
      relation.type = 'accessory'
      relation.description = carriedDescription(relation.description, `原判：${carriedWord}`, '佩在腰间，不在手里')
      reclassified.push({ to: relation.to, reason: 'carried_not_held', word: carriedWord, from: type })
      continue
    }

    // 没写哪只手，而且姿态里两只手都已经有别的去处 → 这条"握着"没有落脚点。
    if (handsBusyElsewhere) {
      relation.type = 'accessory'
      relation.description = carriedDescription(relation.description, '双手另有动作')
      reclassified.push({ to: relation.to, reason: 'hands_occupied', word: null, from: type })
      continue
    }

    withoutHand.push({ to: relation.to, description: relation.description })
  }

  return { applied: true, reclassified, withoutHand }
}

/**
 * 动作轴线体检：躯干朝向 / 肩髋扭转 / 重心腿 / 双手端点 / 手指状态。
 * 返回缺口清单，供定向复核与诊断共用。
 */
export function poseAxes(ir) {
  const pose = poseTextOf(ir)
  const camera = cameraTextOf(ir)
  const hits = {
    orientation: containsAny(pose, ORIENTATION_WORDS),
    twist: containsAny(pose, TWIST_WORDS),
    stance: containsAny(pose, STANCE_WORDS),
    hands: containsAny(pose, HAND_WORDS),
  }
  // 双手是两条独立的端点。"一只手抚胸、另一只手向前伸"如果两条都不点明左右，
  // 编译时就只剩一个手部标签，另一只手直接消失——这是姿势被读错的主要途径。
  const handSide = containsAny(pose, HAND_SIDE_WORDS)
  // 肩线写法的语序有两种，词表只能兜住常见的那一种；剩下两种语序交给
  // shoulderDepthIn 逐条判（`shoulder on the viewer's left side forward` 不在词表里）。
  const shoulderDepth = containsAny(pose, SHOULDER_DEPTH_WORDS) || poseValuesOf(ir).some((value) => shoulderDepthIn(value) !== null)
  // 逐条判断而不是整段判断：`facing right with head turned to viewer` 里头的
  // `turned` 讲的是脸，不是躯干；整段一起看会把它算成"写了转体却没交代肩线"。
  const rotationClaim = poseValuesOf(ir).some((value) => torsoRotationClaim(value))
  // 机位词出现在动作观察里，且没有任何朝向词 —— 典型症状：用 straight-on 冒充正身。
  const cameraAsPose =
    containsAny(pose, CAMERA_POSITION_WORDS) &&
    !hits.orientation

  const gaps = []
  if (pose.length === 0) gaps.push('torso_orientation', 'twist', 'stance', 'hands')
  else {
    if (!hits.orientation) gaps.push('torso_orientation')
    if (!hits.twist) gaps.push('twist')
    if (!hits.stance) gaps.push('stance')
    if (!hits.hands) gaps.push('hands')
  }

  return {
    pose_text: pose,
    camera_text: camera,
    camera: containsAny(camera, CAMERA_POSITION_WORDS) ? 'positioned' : null,
    camera_as_pose: cameraAsPose,
    axes: hits,
    hand_side: handSide,
    shoulder_depth: shoulderDepth,
    rotation_claim: rotationClaim,
    rotation_understated: rotationClaim && !shoulderDepth,
    gaps,
  }
}

export function checkPoseAxes(ir) {
  const report = poseAxes(ir)
  const problems = []
  if (report.camera_as_pose) {
    problems.push({
      error_code: EVIDENCE_CODES.POSE_CAMERA_AS_POSE,
      severity: 'warning',
      message: `动作观察里出现机位词（${report.pose_text.slice(0, 60)}），但没有任何躯干朝向描述：机位不等于朝向。`,
      suggested_fix:
        '把 straight-on / from_front 留给 camera，动作改写成 facing viewer / facing left / facing right / turned 3/4，并补肩髋关系。',
    })
  }
  if (report.gaps.includes('torso_orientation') && !report.camera_as_pose) {
    problems.push({
      error_code: EVIDENCE_CODES.POSE_ORIENTATION_MISSING,
      severity: 'warning',
      message: '动作观察缺少躯干朝向：看不出身体是正面、侧面还是转身中。',
      suggested_fix: '补 facing viewer / facing left / facing right / turned，并说明头部相对躯干是否偏转。',
    })
  }
  if (report.gaps.length >= 3) {
    problems.push({
      error_code: EVIDENCE_CODES.POSE_AXES_THIN,
      severity: 'warning',
      message: `动作轴线只剩 ${4 - report.gaps.length}/4 项（缺 ${report.gaps.join(' / ')}）：这条动作不足以还原姿势。`,
      suggested_fix: '按躯干朝向 → 肩髋扭转 → 重心腿 → 双手端点 → 手指状态逐项补，缺一项写一条 uncertainty。',
    })
  }
  if (report.rotation_understated) {
    problems.push({
      error_code: EVIDENCE_CODES.TORSO_ROTATION_UNDERSTATED,
      severity: 'warning',
      message:
        '写了转体（three-quarter / profile / turned），但没有交代两侧肩的远近：转体角度只靠一句"轻微斜转"撑着，编译后会把侧身读成正对。',
      suggested_fix:
        '补哪侧肩离镜头更近（left shoulder forward and nearer to the camera / right shoulder pulled back），再补胯线是否与肩线同向；两肩一样宽一样清楚就直接写 facing viewer，不要留"轻微"。',
    })
  }
  if (report.axes.hands && !report.hand_side) {
    problems.push({
      error_code: EVIDENCE_CODES.HAND_SIDE_MISSING,
      severity: 'warning',
      message: '手部动作没有点明左右：两只手的去向分不开，编译后只会剩下一个手部标签。',
      suggested_fix:
        '按"左手…／右手…"分别写（left hand on own chest / right arm reaching toward viewer），两只手各一条，不要把两只手压成一句 hands。',
    })
  }
  return { report, problems }
}
