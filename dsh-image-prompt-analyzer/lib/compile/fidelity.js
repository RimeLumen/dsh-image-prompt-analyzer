/**
 * 还原校验：提示词到底有没有把看到的东西写进去。
 *
 * 观察层保证"看得到、写得下"，编译层保证"排得进预算"，
 * 但这两层之间一直没有人对账：一条 confirmed 的高重要度观察，
 * 可能因为分槽、去重或预算被悄悄丢掉，最终提示词里根本没有它，
 * 而用户只会看到"反推得不像"，不知道该怪谁。
 *
 * 这一层只做本地核对，不调用任何模型：
 * 1. 高重要度观察 → 它的原话用词还在不在成品文本里；
 * 2. 主体实体 → 是否至少有一条可见属性（否则等于只写了"1girl"）；
 * 3. 汇总成一个 0–1 的词面保留率，供面板与诊断使用。
 *
 * 口径必须说清楚：**这是词面保留指标，不是语义保留指标，更不是生成效果指标。**
 * 一条观察的原话还在，只能说明字面没丢；它有没有被模型执行、改写后是否等价、
 * 在别的通道里是不是也丢了，这一层都答不了——那要靠事实台账（lib/trace/ledger.js）
 * 和真正的生成对照。所以没有可检查事实时返回 no_data，不返回满分。
 */

import { dimensionsForKey } from '../vision/dimensions.js'
import { isNegatedObservation, isMeasurementPhrase, comparisonValue, MAX_TAG_WORDS } from './terms.js'
import { factId } from '../trace/ledger.js'
import { featureOccurrences } from '../ir/schema.js'

export const FIDELITY_SCHEMA_VERSION = '1.1'

export const FIDELITY_CODES = Object.freeze({
  FEATURE_DROPPED: 'COMPILE_FIDELITY_FEATURE_DROPPED',
  FEATURE_IN_NEGATIVE: 'COMPILE_FIDELITY_FEATURE_IN_NEGATIVE',
  ENTITY_UNOBSERVED: 'COMPILE_FIDELITY_ENTITY_UNOBSERVED',
  LOW_SCORE: 'COMPILE_FIDELITY_LOW_SCORE',
  DIMENSION_EMPTY: 'COMPILE_FIDELITY_DIMENSION_EMPTY',
})

/** 指标口径：词面保留。改这个名字等于改承诺，别随手改。 */
export const METRIC_KIND = 'word_surface_retention'

export const FIDELITY_STATUS = Object.freeze({
  MEASURED: 'measured',
  NO_DATA: 'no_data',
})

export const CHANNEL_KEYS = Object.freeze({
  TAGS: 'tags',
  DESCRIPTION: 'description',
  CANDIDATE: 'candidate',
  // Caption 档只有一个成品：那段描述既是正稿也是描述版。它跟上面三个互斥——
  // 不是并列的第四路，而是换了一套通道定义。
  CAPTION: 'caption',
})

export const CHANNEL_STATUS = Object.freeze({
  MEASURED: 'measured',
  NO_DATA: 'no_data',
  UNKNOWN: 'unknown',
})

/** importance 高于这条线的观察，丢了必须报警：它决定了图"像不像"。 */
const HIGH_IMPORTANCE = 0.7
/** 占画幅超过这个比例的实体，必须有可见属性，不能只出现一个名词。 */
const ENTITY_MIN_AREA = 0.08
/** 实体属性的可信度下限：太虚的观察不算交代过。 */
const ENTITY_MIN_CONFIDENCE = 0.5
/** 还原分低于这条线就整体报一次：说明这一轮提示词丢的东西有点多。 */
const LOW_SCORE = 0.75

const ATTRIBUTE_CATEGORIES = new Set(['appearance', 'clothing', 'pose_action', 'expression'])

/**
 * 不是"可以被描述外观"的实体。
 *
 * 背景、地面、光效这类实体占的画面越大越正常（纯色棚拍背景常常占 80%），
 * 它们的属性落在 background / lighting_color 分类里，而不是挂在实体自己的 features 上。
 * 拿"没有外观/服装/姿态观察"去要求一块背景板，只会产出永远消不掉的假警告。
 */
const NON_ATTRIBUTABLE_KINDS = new Set(['environment', 'effect', 'structure', 'text'])

export function normalizePromptText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[_\u2010-\u2015]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function wordsOf(text) {
  return normalizePromptText(text).split(' ').filter(Boolean)
}

function containsAll(haystack, needle) {
  const hay = normalizePromptText(haystack)
  if (!hay) return false
  const needles = wordsOf(needle)
  if (needles.length === 0) return false
  const hayWords = new Set(hay.split(' '))
  return needles.every((word) => hayWords.has(word))
}

/**
 * 观察值常被编译层拆成多个短语（一个 value 可能拆成两条词条），
 * 逐字全含会误判成"丢了"。这里放宽为"覆盖 80% 的词就算写进去了"。
 */
function coversMost(haystack, needle, min = 0.8) {
  const hay = normalizePromptText(haystack)
  if (!hay) return false
  const needles = wordsOf(needle)
  if (needles.length === 0) return false
  if (needles.length <= 2) return containsAll(haystack, needle)
  const hayWords = new Set(hay.split(' '))
  const hit = needles.filter((word) => hayWords.has(word)).length
  return hit / needles.length >= min
}

/**
 * 一条观察里"可以要求它进提示词"的那部分。
 *
 * 观察值经常是逗号串起来的多个分句，其中一部分本来就没有正向归宿：
 *   - `head tilted down, face in shadow, eyes not visible` —— 最后一句是否定式
 *   - `centered full body portrait, subject occupies 8 percent of frame` —— 后一句是量化陈述
 *
 * 以前 `isNegatedObservation` / `isMeasurementPhrase` 都是拿**整串**判的，于是只要
 * 有一个分句属于上述两类，整条观察就退出对账：`head tilted down`、`face in shadow`、
 * `centered full body portrait` 明明写进了三个成品，却连"进没进"都不再被检查。
 *
 * 后果不是少报一条，而是**分母悄悄变小**：台账里 importance ≥ 0.7 的有 37 条，
 * fidelity 的分母只剩 31 条，于是同一个输出里 "tags 21/31（缺 10）" 与
 * "11 条只进了部分通道（缺 tags 11 条）" 对不上账，读的人无法判断哪句是错的。
 *
 * 这里改成按分句判：剔掉没有正向归宿的分句，剩下的才是要对账的内容。
 * 全被剔光（`not visible in crop`）才算这条观察没有可对账的内容。
 */
function checkablePortion(value) {
  return String(value ?? '')
    .split(/[,;，；、]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !isNegatedObservation(part))
    .filter((part) => !isMeasurementPhrase(part))
    .join(', ')
}

/** dropped 里存的是 term 对象，不是字符串；顺便把丢弃原因取出来。 */
function droppedIndex(dropped) {
  const index = new Map()
  for (const entry of Array.isArray(dropped) ? dropped : []) {
    const text = entry?.term?.text ?? entry?.term
    if (typeof text !== 'string' || text.length === 0) continue
    index.set(normalizePromptText(text), entry?.reason ?? 'dropped')
  }
  return index
}

function boxArea(box) {
  if (!Array.isArray(box) || box.length !== 4) return 0
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1])
}

export function collectIRFeatures(ir) {
  const out = []
  for (const [key, feature] of Object.entries(ir?.composition ?? {})) {
    out.push({ category: 'composition', key, ...feature })
  }
  for (const [key, feature] of Object.entries(ir?.camera ?? {})) {
    out.push({ category: 'camera', key, ...feature })
  }
  const globalFeatures = Array.isArray(ir?.features) ? ir.features : []
  const globalOccurrences = featureOccurrences(globalFeatures)
  globalFeatures.forEach((feature, index) => {
    out.push(globalOccurrences[index] > 0 && feature && typeof feature === 'object' ? { ...feature, occurrence: globalOccurrences[index] } : feature)
  })
  // 实体身上的观察要带 entity_id：台账按 `feature:<category>.<key>@<entity_id>` 认身份，
  // 少了这一段，`clothing.accessory@e6`（佩剑护手）与 `clothing.accessory@e7`（发带）
  // 会塌成同一条 `feature:clothing.accessory`，两个通道的对账数就再也对不上。
  for (const entity of Array.isArray(ir?.entities) ? ir.entities : []) {
    const entityId = entity?.entity_id ?? null
    const entityFeatures = Array.isArray(entity?.features) ? entity.features : []
    const occurrences = featureOccurrences(entityFeatures)
    entityFeatures.forEach((feature, index) => {
      out.push({
        ...feature,
        entity_id: feature?.entity_id ?? entityId,
        ...(occurrences[index] > 0 ? { occurrence: occurrences[index] } : {}),
      })
    })
  }
  return out
}

/**
 * @param {object} args
 * @param {object} args.ir 已 finalize 的 IR
 * @param {object} args.compiled compilePrompt 的返回值
 * @returns {{schema_version: string, checked: number, kept: number, score: number,
 *   high_importance: Array<object>, entity_gaps: Array<object>, problems: Array<object>}}
 */
/**
 * 别名归一后的词对账。
 *
 * 知识库会把 `back_view` 改写成 `from_behind`、`legs_crossed` 改写成 `crossed_legs`。
 * 观察值里保留的是模型原话（"facing away, back view"），提示词里是归一后的词，
 * 逐词比对就永远对不上——一条已经写进提示词的观察被报成"丢了"，还原分白扣。
 * 所以对账时把观察值按同一张别名表改写一遍再比。
 */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function applyAliases(value, aliases) {
  let out = normalizePromptText(value)
  for (const pair of Array.isArray(aliases) ? aliases : []) {
    const from = normalizePromptText(pair?.from)
    const to = normalizePromptText(pair?.to)
    if (!from || !to || from === to) continue
    out = out.replace(new RegExp(`\\b${escapeRegExp(from)}\\b`, 'g'), to)
  }
  return out
}

export function auditFidelity({ ir, compiled, ledger = null } = {}) {
  const positive = String(compiled?.prompts?.positive ?? '')
  const negative = String(compiled?.prompts?.negative ?? '')
  // 长句观察（>6 词）本来就进不了标签流，它的去处是自然语言版。
  // 只拿 positive 对账，会把"已经在句子里说清楚了"的观察算成丢失，白白扣还原分。
  const sentence = String(compiled?.composed?.text ?? '')
  const droppedTerms = droppedIndex(compiled?.dropped)
  const aliases = Array.isArray(compiled?.aliases) ? compiled.aliases : []

  // 词数必须和 normalizePromptText 用同一套切分。
  //
  // 观察原话里的连字符（`slight three-quarter turn`）在对账时会被拆成两个词，
  // 而按空格数词只算一个。两边口径不一致，一条 7 词的长句会被当成 6 词的短标签去
  // 硬比 80% 覆盖，覆盖不到就报"消失且没有 dropped 记录"——用户照着提示去调预算，
  // 怎么调都调不掉，因为问题根本不在预算。
  const isLongPhrase = (value) => wordsOf(value).length > MAX_TAG_WORDS
  // 词表里没有的观察被有意留在标签版外（unknown_tag_policy=description_only），
  // 它们的去处就是描述版。所以短值也要能用句子对账，只是阈值更严：
  // 短片段太容易在长句里"看起来覆盖到了"，0.8 才算真说到。
  const reachedBySentence = (value) => coversMost(sentence, value, isLongPhrase(value) ? 0.6 : 0.8)
  // 原话对不上时，用别名改写后的说法再对一次。
  const reachedByPositive = (value) =>
    coversMost(positive, value) || (aliases.length > 0 && coversMost(positive, applyAliases(value, aliases)))

  const features = collectIRFeatures(ir)
  // 评级是档案的开关决定的（rating_emit），不是"丢了一条观察"。
  // 全年龄图不写 safe 是设计选择，不该在还原分里扣分。
  const isRating = (feature) =>
    String(feature?.category ?? '') === 'quality_style' && String(feature?.key ?? '') === 'rating'
  // 否定式观察（no grain / not discernible）被有意排除在正向词之外，
  // 它们没有"进没进提示词"这回事，不该在还原分里被算成丢失。
  const highImportance = []
  // 重要度达标、却没有计入对账的观察。必须逐条记下来：不记的话，分母会悄无声息地
  // 比台账小，而读者只看得到比例，看不到"有 4 条根本没被检查"。
  const excludedFromAudit = []
  const exclude = (feature, reason) => {
    const occurrence = Number.isInteger(feature?.occurrence) && feature.occurrence > 0 ? feature.occurrence : 0
    excludedFromAudit.push({
      // 身份必须和 `auditedIds` 用同一个函数拼。手拼模板字符串会漏掉 occurrence，
      // 于是同名的第二条、第三条观察在这里拿到与第 0 条一样的 id，两边对不上账。
      fact_id: factId({
        kind: 'feature',
        category: String(feature?.category ?? ''),
        key: String(feature?.key ?? ''),
        entity_id: feature?.entity_id ?? null,
        occurrence,
      }),
      category: String(feature?.category ?? ''),
      key: String(feature?.key ?? ''),
      entity_id: feature?.entity_id ?? null,
      occurrence,
      importance: feature?.importance ?? null,
      status: feature?.status ?? 'confirmed',
      value: String(feature?.value ?? ''),
      reason,
    })
  }
  for (const feature of features) {
    if (isRating(feature)) {
      if ((feature?.importance ?? 0) >= HIGH_IMPORTANCE) exclude(feature, 'rating')
      continue
    }
    // 重要度不达标的观察本来就不该进成品，不在这里记账，否则"未计入"会变成一长串噪声。
    if ((feature?.importance ?? 0) < HIGH_IMPORTANCE) continue
    // 先剔掉没有正向归宿的分句，再判"这条观察还有没有要对账的内容"。
    // 顺序反了就会把 `head tilted down, face in shadow, eyes not visible` 整条丢掉。
    const value = comparisonValue(checkablePortion(feature?.value))
    if (value.trim().length === 0) {
      exclude(feature, 'no_checkable_clause')
      continue
    }
    // 视觉层自己标了 tentative 的观察，不拿它去要求编译层——这是既有约定。
    // 但正因为如此，它会从分母里消失，必须记进 excluded，否则台账 37 条、
    // 分数分母 33 条这件事没人看得出来。
    if ((feature?.status ?? 'confirmed') !== 'confirmed') {
      exclude(feature, `status_${String(feature?.status ?? 'unknown')}`)
      continue
    }
    highImportance.push({
      category: String(feature.category ?? ''),
      key: String(feature.key ?? ''),
      value,
      // entity_id 必须带过去：台账的身份是 `feature:<category>.<key>@<entity_id>`，
      // 在这里丢掉它，实体身上的观察就再也对不上身份，只能被算成"台账里没有"。
      entity_id: feature?.entity_id ?? null,
      // 同名的第二、第三条观察（三条 background.backdrop）靠这个序号才分得开身份。
      occurrence: Number.isInteger(feature?.occurrence) && feature.occurrence > 0 ? feature.occurrence : 0,
    })
  }

  const ledgerChannels = new Map()
  const ledgerById = new Map()
  for (const record of Array.isArray(ledger?.records) ? ledger.records : []) {
    if (typeof record?.fact_id !== 'string') continue
    ledgerById.set(record.fact_id, record)
    ledgerChannels.set(record.fact_id, new Set(Array.isArray(record.channels) ? record.channels : []))
  }
  const identityBasis = ledgerChannels.size > 0
  const identityOf = (feature) =>
    factId({
      kind: 'feature',
      category: String(feature?.category ?? ''),
      key: String(feature?.key ?? ''),
      entity_id: feature?.entity_id ?? null,
      occurrence: Number.isInteger(feature?.occurrence) && feature.occurrence > 0 ? feature.occurrence : 0,
    })

  const lost = []
  // 台账里查不到身份的观察：既不算保留，也不算丢失。单列出来，别让它悄悄落进任何一边。
  const unmatchedIds = []
  let kept = 0
  for (const feature of highImportance) {
    // 有台账时按身份判，不用词面判。
    //
    // 这一支是第 11 轮补的：`lost` 原来无条件走词面比对，于是
    // `camera.angle「from front, slightly from below, full body vertical framing」`
    // 明明台账记着它进了默认描述版和候选描述版，却被报成"没进任何通道、也没丢弃记录"。
    // 词面判据答不了"这条观察进没进这个成品"，它只能答"字面像不像在里面"。
    // 有身份记录时拿它下"丢了"的结论，和拿它下"全保住了"的结论一样错——
    // 后者是第 5 轮堵的洞，前者是这一轮堵的。
    if (identityBasis) {
      const id = identityOf(feature)
      const record = ledgerById.get(id)
      if (!record) {
        unmatchedIds.push(id)
        continue
      }
      // 台账自己已经给过通道清单时，以它为准——它记的是事实。
      // 清单为空且 disposition 说的是 retained / rewritten，那是台账内部不自洽，
      // 按 disposition 走，别在这里替它改判。
      if (Array.isArray(record.channels)) {
        if (record.channels.length > 0) {
          kept += 1
          continue
        }
      } else if (record.disposition === 'retained' || record.disposition === 'rewritten') {
        kept += 1
        continue
      }
      if (record.disposition === 'unknown') {
        unmatchedIds.push(id)
        continue
      }
      const reason = record.dropped_reason ?? droppedTerms.get(normalizePromptText(feature.value)) ?? null
      lost.push({ ...feature, where: reason ? 'dropped' : 'missing', reason })
      continue
    }
    if (reachedByPositive(feature.value)) {
      kept += 1
      continue
    }
    // 长句只在句子里出现是正常归宿，不算丢。
    if (reachedBySentence(feature.value)) {
      kept += 1
      continue
    }
    if (coversMost(negative, feature.value)) {
      lost.push({ ...feature, where: 'negative' })
      continue
    }
    const reason = droppedTerms.get(normalizePromptText(feature.value))
    lost.push({ ...feature, where: reason ? 'dropped' : 'missing', reason: reason ?? null })
  }

  // 穿在身上 / 贴在身上的东西，属性本来就会挂在人身上（材质、褶皱写在人物的
  // clothing / appearance 里）。要求一个裙摆实体自己再带一份观察，是纯噪声。
  const wornTargets = new Set()
  for (const relation of ir?.relations ?? []) {
    if (!['wearing', 'accessory', 'contact'].includes(String(relation?.type ?? ''))) continue
    wornTargets.add(String(relation?.to ?? ''))
  }

  const entityGaps = []
  for (const entity of ir?.entities ?? []) {
    const area = boxArea(entity?.region)
    // 没给框时退化成"图里主体不多就算主要主体"，避免因为缺 region 就整条不检查。
    if (NON_ATTRIBUTABLE_KINDS.has(String(entity?.kind ?? ''))) continue
    const kind = String(entity?.kind ?? '')
    const isActor = kind === 'person' || kind === 'animal' || kind === 'creature'
    if (!isActor && wornTargets.has(String(entity?.entity_id ?? ''))) continue
    const isMain = area >= ENTITY_MIN_AREA || (!Array.isArray(entity?.region) && (ir?.entities?.length ?? 0) <= 2)
    if (!isMain) continue
    const attributed = (entity?.features ?? []).some(
      (feature) =>
        ATTRIBUTE_CATEGORIES.has(String(feature?.category ?? '')) &&
        (feature?.status ?? 'confirmed') === 'confirmed' &&
        (feature?.confidence ?? 0) >= ENTITY_MIN_CONFIDENCE &&
        String(feature?.value ?? '').trim().length > 0,
    )
    if (!attributed) {
      entityGaps.push({
        entity_id: entity?.entity_id ?? null,
        label: entity?.label ?? entity?.kind ?? 'entity',
        area: Number(area.toFixed(4)),
      })
    }
  }

  // 分母是"真正查得到去向的那几条"，不是"台账里重要度达标的那几条"。
  // 两者相等时正常；查不到身份的那些被剔出去，如果剔到一条都不剩，
  // 结果是 null 而不是 0——0 会被读成"全都丢了"，那是一个没有依据的结论。
  const audited = highImportance.length - unmatchedIds.length
  const score = highImportance.length === 0 || audited <= 0
    ? null
    : Number((kept / audited).toFixed(4))

  // 三通道分别对账。
  //
  // 以前只有一条路：观察原话出现在 positive 里就算保住。于是"任一通道出现"被当成
  // "全部保留"，而事实上标签版、默认描述版、候选描述版是三个独立的成品，读者不同、
  // 丢的东西也不同。现在逐通道各算各的，任何一个通道没测出来就标 unknown，
  // 绝不拿别的通道的结果顶替。
  //
  // 判据也分两套，必须说清用的是哪套：
  //   - `ledger_identity`：台账在场时按身份判。台账记的是"这条观察被写进了哪个成品"，
  //     这是事实，不是推断。
  //   - `word_surface`：台账不在场时退回词面比对（观察原话的用词在不在成品文本里）。
  //     它只能回答"字面像不像在里面"，答不了"这条观察到底进没进这个成品"。
  //
  // 为什么必须分开：真跑里词面判据给出 tags 7/31，台账按身份给出 in_tags 33。
  // 差的 26 条里，一部分是长句被规则分流到描述版（词面看不出来它进没进），
  // 一部分是同一句话在成品里换了个说法（词面判"没进"，实际进了）。用词面数
  // 去读"标签版丢了 26 条"是错的，反过来用身份数去读"标签版全都有"也是错的。
  // Caption 档只有一个成品。硬套三通道会得出两个假结论：`candidate` 永远是
  // 「没测出来」（它本来就不该产出），而每条记录都变成「只进了部分通道、缺
  // tags/description/candidate」——那三个通道在 Caption 档里根本不存在。
  // 所以这里换一套通道定义，不是把同一个数字改个说法。
  const captionMode = String(compiled?.register ?? '') === 'caption'
  const channelText = captionMode
    ? { [CHANNEL_KEYS.CAPTION]: positive }
    : {
        [CHANNEL_KEYS.TAGS]: positive,
        [CHANNEL_KEYS.DESCRIPTION]: String(compiled?.prompts?.description ?? '') || sentence,
        [CHANNEL_KEYS.CANDIDATE]: String(compiled?.description_candidate?.text ?? ''),
      }
  const channelTotal = Object.keys(channelText).length
  // 没测出来时也要说清"本来打算用哪套判据"，否则 no_data 的 basis 默认写 word_surface，
  // 会被读成"这条通道是用词面比过的"。
  const basisOf = () => (identityBasis ? 'ledger_identity' : 'word_surface')
  const channels = {}
  for (const [key, text] of Object.entries(channelText)) {
    const haystack = String(text ?? '').trim()
    if (highImportance.length === 0) {
      channels[key] = channelResult({ key, status: CHANNEL_STATUS.NO_DATA, basis: basisOf(), note: '没有可检查的高重要度观察，无从对账。' })
      continue
    }
    if (haystack.length === 0) {
      channels[key] = channelResult({
        key,
        status: CHANNEL_STATUS.NO_DATA,
        checked: highImportance.length,
        basis: basisOf(),
        note: key === CHANNEL_KEYS.CANDIDATE ? '本次编译没有产出候选描述版。' : '这个通道的文本是空的。',
      })
      continue
    }
    if (identityBasis) {
      let kept = 0
      let unmatched = 0
      for (const feature of highImportance) {
        const id = factId({
          kind: 'feature',
          category: String(feature?.category ?? ''),
          key: String(feature?.key ?? ''),
          entity_id: feature?.entity_id ?? null,
          occurrence: Number.isInteger(feature?.occurrence) && feature.occurrence > 0 ? feature.occurrence : 0,
        })
        const set = ledgerChannels.get(id)
        // 台账里没有这条身份 = 不知道，不是"没进"。混进 kept 的分子分母都会骗人。
        if (!set) {
          unmatched += 1
          continue
        }
        if (set.has(key)) kept += 1
      }
      const matched = highImportance.length - unmatched
      channels[key] = channelResult({
        key,
        status: matched > 0 ? CHANNEL_STATUS.MEASURED : CHANNEL_STATUS.UNKNOWN,
        checked: matched,
        kept,
        basis: 'ledger_identity',
        unmatched,
        note:
          matched > 0
            ? `按台账身份判：这条观察是否被写进了这个成品。${unmatched > 0 ? `另有 ${unmatched} 条在台账里找不到身份，未计入。` : ''}`
            : '台账里找不到这些观察的身份，无法判断它们进没进这个通道。',
      })
      continue
    }
    const keptInChannel = highImportance.filter((feature) =>
      key === CHANNEL_KEYS.TAGS ? reachedByPositive(feature.value) : coversMost(haystack, feature.value, isLongPhrase(feature.value) ? 0.6 : 0.8),
    ).length
    channels[key] = channelResult({
      key,
      status: CHANNEL_STATUS.MEASURED,
      checked: highImportance.length,
      kept: keptInChannel,
      basis: 'word_surface',
      note: '词面比对：观察原话（或其别名改写）的用词是否出现在这个通道的文本里。这只说明字面没丢，不说明它被写进了这个成品。',
    })
  }

  // "完整保留"这句话能不能说，由台账决定，不由分数决定。
  //
  // 分数只说明"高重要度观察的原话还能在某个通道里被找到"，它不知道哪条观察
  // 在证据层被改写、哪条在预算里被裁掉。没有台账就没有丢失记录，没有丢失记录时
  // score=1 只能读成"没发现丢失"，不能读成"确认没丢"。
  //
  // 只拿高重要度的事实来判：低重要度的碎片本来就不该进成品，把它们算成"丢失"
  // 会让这句话永远为假，等于变相取消了这个判断。
  const ledgerRecords = Array.isArray(ledger?.records) ? ledger.records : []
  const important = ledgerRecords.filter((record) => Number(record?.importance ?? 0) >= HIGH_IMPORTANCE)
  const importantDropped = important.filter((record) => record?.disposition === 'dropped')
  const importantRewritten = important.filter((record) => record?.disposition === 'rewritten')
  const importantUnknown = important.filter((record) => record?.disposition === 'unknown')
  const unmeasured = Object.values(channels).filter((channel) => channel.status !== CHANNEL_STATUS.MEASURED)

  // 台账的高重要度记录数（`important`）与分数的分母（`highImportance`）不是同一个集合：
  // 前者是"重要度达标的观察"，后者是"其中还有可对账内容、状态也够硬的观察"。
  // 先把分数分母的身份摊出来，后面的通道差才知道每条在不在里面。
  const auditedIds = new Set(
    highImportance.map((feature) =>
      factId({
        kind: 'feature',
        category: feature.category,
        key: feature.key,
        entity_id: feature.entity_id ?? null,
        occurrence: Number.isInteger(feature.occurrence) && feature.occurrence > 0 ? feature.occurrence : 0,
      }),
    ),
  )

  // 通道差：进了至少一个通道、但没进全部。
  //
  // 这不是"丢失"——长句观察本来就只该进描述版，标签版装不下句子。但它也不是
  // "全部保留"：只看标签版的人会以为这条观察不存在。所以既要单独列出来，
  // 又不能混进丢弃计数里。
  const channelGaps = important
    // 上限跟着通道数走，不写死 3：Caption 档只有一个通道，写死会把每一条都
    // 算成「只进了部分通道」。
    .filter((record) => Array.isArray(record?.channels) && record.channels.length > 0 && record.channels.length < channelTotal)
    .map((record) => ({
      fact_id: record.fact_id,
      // 带上原话与重要度：只给 fact_id 的话，读者还得回头查台账才知道少的是哪条观察。
      value: record.text ?? null,
      importance: record.importance ?? null,
      channels: record.channels.slice(),
      missing_channels: Array.isArray(record.missing_channels) ? record.missing_channels.slice() : [],
      // 这条在不在 `score` 的分母里。
      //
      // 台账的高重要度记录数（`important`）与分数的分母（`highImportance`）不是同一个集合：
      // 前者是"重要度达标的观察"，后者是"其中还有可对账内容、状态也够硬的观察"。
      // 不标这一位，读者会拿 `31 - 21 = 10` 去对 `channel_gaps` 的 11 条，怎么算都对不上。
      in_score_denominator: auditedIds.has(record.fact_id),
    }))
  const gapCounts = {}
  for (const gap of channelGaps) {
    for (const missing of gap.missing_channels) gapCounts[missing] = (gapCounts[missing] ?? 0) + 1
  }

  // 两个分母对账。这是本轮要堵的那个洞：
  // 同一个输出里 "tags 21/31（缺 10）" 和 "11 条只进了部分通道（缺 tags 11 条）"
  // 互相矛盾，而两句话各自都是照着自己那份数据算的。不把差额摊开，
  // 读者只能怀疑其中一个是错的。
  const ledgerIds = new Set(important.map((record) => record.fact_id))
  const reconciliation = {
    ledger_important: important.length,
    audited: highImportance.length,
    excluded_from_audit: excludedFromAudit.length,
    // 台账里有、分数分母里没有：这些观察的去向仍然有记录（channel_gaps / lost 照样算它们），
    // 只是"进没进提示词"这一问对它们不成立，或者视觉层自己就没把它们当确定结论。
    in_ledger_not_audited: excludedFromAudit.map((item) => ({ fact_id: item.fact_id, reason: item.reason, importance: item.importance })),
    // 分数分母里有、台账里没有：说明台账漏记了一条该被追踪的观察。这个数必须为 0，
    // 不为 0 就是台账本身有洞，而不是统计口径问题。
    audited_not_in_ledger: [...auditedIds].filter((id) => !ledgerIds.has(id)),
  }

  const claim = (() => {
    // 把挡路的理由全列出来，而不是只报第一条。
    // 只报第一条会让人修完一个又冒一个，还以为问题在变多。
    const blockers = []
    if (!ledger) blockers.push('没有事实台账，无法确认是否发生丢失；分数不能当完整保留的证明')
    if (highImportance.length === 0) blockers.push('没有可检查的事实（no_data）')
    if (ledger && important.length === 0) blockers.push('台账里没有与高重要度观察对上的记录，无法确认去向')
    if (unmeasured.length > 0) {
      blockers.push(`${unmeasured.map((channel) => channel.channel).join('、')} 通道没有测出来（unknown）`)
    }
    if (importantDropped.length > 0) {
      const sample = importantDropped
        .slice(0, 3)
        .map((record) => `${record.fact_id}（${record.dropped_at ?? '未知阶段'}：${record.dropped_reason ?? '未标注'}）`)
      blockers.push(`${importantDropped.length} 条高重要度事实被丢弃：${sample.join('；')}`)
    }
    if (importantRewritten.length > 0) {
      const sample = importantRewritten.slice(0, 3).map((record) => record.fact_id)
      blockers.push(`${importantRewritten.length} 条高重要度事实被改写（${sample.join('、')}），改写不等价于保留`)
    }
    if (importantUnknown.length > 0) blockers.push(`${importantUnknown.length} 条高重要度事实去向未知`)
    if (unmatchedIds.length > 0) {
      // 台账里查不到身份，等于"这条观察有没有进成品"这一问没有答案。
      // 不说出来，`score` 会拿一个缩小的分母给出一个看起来很确定的数。
      blockers.push(`${unmatchedIds.length} 条高重要度观察在台账里查不到身份（${unmatchedIds.slice(0, 3).join('、')}），既不算保留也不算丢失`)
    }
    if (lost.length > 0) {
      // 必须点名。"还有 1 条没进任何通道"这种说法等于把追查工作又推回给人，
      // 而台账本来就知道是哪一条。
      const sample = lost
        .slice(0, 3)
        .map((feature) => `${feature.category ?? '?'}.${feature.key ?? '?'}「${feature.value ?? ''}」（${feature.where === 'negative' ? '进了负向' : feature.where === 'dropped' ? `丢弃：${feature.reason ?? '未标注'}` : '既没进正向也没进丢弃记录'}）`)
      blockers.push(`还有 ${lost.length} 条高重要度观察没进任何通道：${sample.join('；')}`)
    }
    // 通道差在两种结论下都要说：哪怕别的理由已经挡了"完整保留"，读者仍然需要知道
    // 标签版少了多少条——否则他会以为"没被丢弃"就等于"两个版本都有"。
    const gapNote =
      channelGaps.length > 0
        ? `另有 ${channelGaps.length} 条高重要度事实只进了部分通道（${Object.entries(gapCounts)
            .map(([key, count]) => `缺 ${key} ${count} 条`)
            .join('、')}），这不是丢失，但看那个通道的人确实看不到它们`
        : ''
    if (blockers.length > 0) {
      if (gapNote) blockers.push(gapNote)
      return { allowed: false, reason: `${blockers.join('；')}。` }
    }
    return {
      allowed: true,
      // 通道数按实际数报，不写死「三个」：Caption 档只有一个成品，
      // 说成三个通道都测过等于在报告一个不存在的检查。
      reason: `${captionMode ? '这个档案只有一个成品' : '三个通道都测过'}，${important.length} 条高重要度事实在台账里都有去向且没有丢弃或改写${gapNote ? `；${gapNote}` : ''}。`,
    }
  })()

  // 维度级对账：逐条看太碎，想知道的是"哪一层整层没进提示词"。
  //
  // 这里必须和上面用同一份"可对账部分"（`checkablePortion`）：一条观察常常是
  // `clean vector-like edges, no grain, no noise` 这种混合值，编译层只写肯定部分。
  // 拿原话去比，否定尾巴会把覆盖率压到 0.8 以下，于是这一维明明写进了提示词，
  // 却被报成"整层不存在"，还顺手建议用户去调预算——那是把人往错误的方向指。
  const buckets = new Map()
  for (const feature of features) {
    if (isRating(feature)) continue
    if ((feature?.status ?? 'confirmed') === 'unknown') continue
    const value = comparisonValue(checkablePortion(feature?.value))
    if (value.trim().length === 0) continue
    const dims = dimensionsForKey(String(feature?.category ?? ''), String(feature?.key ?? ''))
    const reached = reachedByPositive(value) || coversMost(negative, value) || reachedBySentence(value)
    for (const dim of dims) {
      const bucket = buckets.get(dim.id) ?? { id: dim.id, name: dim.name, observed: 0, kept: 0 }
      bucket.observed += 1
      if (reached) bucket.kept += 1
      buckets.set(dim.id, bucket)
    }
  }
  const dimensions = [...buckets.values()]

  const problems = []
  for (const feature of lost) {
    const isNegative = feature.where === 'negative'
    problems.push({
      error_code: isNegative ? FIDELITY_CODES.FEATURE_IN_NEGATIVE : FIDELITY_CODES.FEATURE_DROPPED,
      severity: 'warning',
      field_path: `/prompts/positive`,
      message: isNegative
        ? `观察「${feature.value}」（${feature.category}.${feature.key}）被写进了负向提示词：它明明是画面里看得到的东西。`
        : feature.where === 'dropped'
          ? `观察「${feature.value}」（${feature.category}.${feature.key}，重要度 ${HIGH_IMPORTANCE}+）在编译阶段被丢掉了（原因：${feature.reason ?? '未标注'}），提示词里没有它。`
          : `观察「${feature.value}」（${feature.category}.${feature.key}，重要度 ${HIGH_IMPORTANCE}+）没有出现在提示词里，也没有进 dropped 记录。`,
      suggested_fix: isNegative
        ? '检查该观察是否与档案的负面词表冲突；确认后从 IR 里删掉这条，或接受它被抑制。'
        : '提高该档案的 general 预算上限（profile.budget），或把这条观察合并进更重要的特征里。',
      feature,
    })
  }
  for (const gap of entityGaps) {
    problems.push({
      error_code: FIDELITY_CODES.ENTITY_UNOBSERVED,
      severity: 'warning',
      field_path: `/entities/${gap.entity_id ?? gap.label}`,
      message: `主体「${gap.label}」占了 ${(gap.area * 100).toFixed(0)}% 的画面，但没有任何外观/服装/姿态观察：提示词里出现它时等于只有一个名词。`,
      suggested_fix: '对这个主体做一次定向复核（外观、服装材质、姿态三选一即可），或补一条 uncertainty 说明为什么看不出来。',
      entity: gap,
    })
  }
  // 整层丢失才报：单条丢了上一段已经报过，这里只说"这一维度在成品里不存在"。
  for (const dimension of dimensions) {
    if (dimension.kept > 0) continue
    problems.push({
      error_code: FIDELITY_CODES.DIMENSION_EMPTY,
      severity: 'warning',
      field_path: `/coverage/${dimension.id}`,
      message: `维度「${dimension.id} ${dimension.name}」的 ${dimension.observed} 条观察一条都没进提示词：这一层在成品里等于不存在。`,
      suggested_fix:
        '先看这一维的观察是否都落在 dropped（预算不够，调大 budget.positive_terms）；否则就是这一维没产出可渲染的词条，回去改观察。',
      dimension,
    })
  }

  if (score !== null && score < LOW_SCORE) {
    problems.push({
      error_code: FIDELITY_CODES.LOW_SCORE,
      severity: 'info',
      field_path: '/prompts/positive',
      message: `词面保留率只有 ${(score * 100).toFixed(0)}%：${highImportance.length} 条高重要度观察里有 ${lost.length} 条的原话没在标签版或描述版里找到。`,
      suggested_fix:
        '看上面逐条的丢弃原因：落在 dropped 说明被预算裁掉了，调大该档案 budget.positive_terms；落在 missing 说明观察没有变成可渲染的词条，需要修编译层。注意这是词面指标，不是"模型是否照着画"的结论。',
    })
  }

  return {
    schema_version: FIDELITY_SCHEMA_VERSION,
    // 口径声明：这是词面保留指标。
    //
    // 需要分清两件事，它们在真跑里给出过差 6 倍的两个数：
    //   - `score`（本指标）：词面。观察原话的用词在不在成品文本里。
    //   - `channels`（逐通道）：台账在场时按身份判，不在场时才退回词面。
    // 所以 `metric` 描述的是 `score`，`channel_basis` 单独说 `channels` 用的是哪套。
    metric: {
      kind: METRIC_KIND,
      label: '词面保留率',
      applies_to: 'score',
      // 第 11 轮改了 `score` 的判据：有台账时按身份，没台账才退回词面。
      // 名字不改（它仍是"保留"而不是"语义等价"），但必须说清它此刻用的是哪套，
      // 否则同一个字段在两次运行里量的是两件不同的事。
      measures: identityBasis
        ? '台账按身份记下这条观察进了哪个成品；这里数的是"至少进了一个成品"的条数比例。'
        : '观察原话（或它的别名改写）里的用词，是否在标签版或描述版的成品文本里出现过。',
      does_not_measure: [
        '模型是否理解并执行了这条观察',
        '改写后说法与原文在语义上是否等价',
        '这条观察是"被写进了某个成品"还是"恰好字面相似"',
      ],
    },
    // 逐通道判据：有台账按身份，没台账只能退回词面。两套数不可互相换算。
    channel_basis: identityBasis ? 'ledger_identity' : 'word_surface',
    // `score` 与 `lost` 用的是同一套判据，必须单独标出来：
    // 以前 `lost` 无条件走词面，于是台账里明明有去向的观察会被报成"既没进通道也没丢弃"。
    lost_basis: identityBasis ? 'ledger_identity' : 'word_surface',
    status: highImportance.length === 0 ? FIDELITY_STATUS.NO_DATA : FIDELITY_STATUS.MEASURED,
    // `score` 的口径必须写在这里：它是"至少在某个通道里出现过"的比例。
    // 换句话说 score=1 只证明"没丢干净"，不证明"三个通道都有"。
    // 想看通道之间差多少，看 `channels`；想引用一句话，只能引用 `retention_claim`。
    score_scope: 'any_channel',
    checked: highImportance.length - unmatchedIds.length,
    kept,
    score,
    // 台账里查不到身份的观察：不计入分子分母，也不当成丢失。单列出来。
    unmatched: unmatchedIds,
    channels,
    // 只进了一部分通道的事实单独列出来：它们既不算丢失，也不算全部保留。
    channel_gaps: channelGaps,
    // 两个分母的差额摊在这里：`ledger_important` 是台账里重要度达标的记录数，
    // `audited` 是真正进了 `score` 分母的数，`excluded_from_audit` 是中间被剔掉的，
    // 逐条带理由。三者的关系是 `ledger_important = audited + excluded_from_audit`。
    // 没有这一块，读者只能拿 `audited - kept` 去对 `channel_gaps.length`，
    // 而这两者本来就不该相等。
    reconciliation,
    retention_claim: claim,
    high_importance: highImportance,
    lost,
    entity_gaps: entityGaps,
    dimensions,
    problems,
  }
}

/** 单个通道的对账结果。没测出来就是 unknown，不填 0 也不填满分。 */
function channelResult({ key, status, checked = 0, kept = 0, note = '', basis = 'word_surface', unmatched = 0 }) {
  return {
    channel: key,
    status,
    basis,
    checked,
    kept,
    unmatched,
    score: status === CHANNEL_STATUS.MEASURED && checked > 0 ? Number((kept / checked).toFixed(4)) : null,
    note,
  }
}