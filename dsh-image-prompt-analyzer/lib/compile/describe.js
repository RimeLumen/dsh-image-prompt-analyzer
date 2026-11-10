/**
 * 描述版的输入层：从 IR 事实直接取内容，而不是从"标签版过滤后剩下的词条"取。
 *
 * 为什么要单独一层：
 *   标签版的取舍标准是"模型认不认得这个词"，描述版的取舍标准应该是"这条观察有没有
 *   依据、重不重复、矛不矛盾、超没超表达预算"。以前描述版拿的是标签流的 leftovers
 *   （`term.description || term.excluded_from_tags`），于是词库一换，描述版跟着变——
 *   可描述版的效果恰恰与词库无关。这里把输入换成 IR 事实，两件事就解耦了。
 *
 * 本模块只产出事实与来源引用，不排版、不改写句子；排版仍交给 compose.js 的现有模板，
 * 所以表达形态与冻结基线一致。
 */

import { isMeasurementPhrase, isNegatedObservation, isPlaceholderObservation } from './terms.js'
import { normalizePromptText } from './fidelity.js'
import { featureOccurrences } from '../ir/schema.js'

export const DESCRIBE_SCHEMA_VERSION = '1.0'

export const DESCRIBE_CODES = Object.freeze({
  FACT_UNCERTAIN: 'COMPILE_DESCRIBE_FACT_UNCERTAIN',
  FACT_CONTRADICTED: 'COMPILE_DESCRIBE_FACT_CONTRADICTED',
  FACT_BUDGET_TRIMMED: 'COMPILE_DESCRIBE_FACT_BUDGET_TRIMMED',
  FACT_NON_ENGLISH: 'COMPILE_DESCRIBE_FACT_NON_ENGLISH',
  UNMAPPED_KEPT: 'COMPILE_DESCRIBE_UNMAPPED_KEPT',
})

/** 明确写着"正对镜头"的说法。 */
const FRONTAL_CLAIM = /\b(?:facing\s+(?:the\s+)?(?:viewer|camera)|front[\s-]?facing|facing\s+(?:forward|front)|from\s+(?:the\s+)?front|straight[\s-]?on|head[\s-]?on)\b/i

/** 明确写着"转过一定角度"的说法。 */
const ROTATION_CLAIM = /\b(?:turned|three[\s-]quarter|three[\s-]quarter\s+view|torso\s+twist|body\s+twist|in\s+profile|side\s+view|facing\s+(?:left|right|away)|from\s+(?:the\s+)?side)\b/i

/** 观察里"这不是画面内容"的占位说法。 */
const NON_VISUAL_PATTERN = /^(?:not\s+visible|out\s+of\s+(?:frame|shot)|invisible|unknown)\b/i

/**
 * 非英文观察（IR 的 `relations[].description` 在中文语向下是中文）。
 *
 * 提示词是英文的：把「佩在髋侧，双手均未握柄」原样拼进去，生成端只会拿到一串
 * 它不认识的字符，既占了预算又把邻近的英文词稀释掉。这类观察不进描述版，
 * 但它表达的方位信息在实体特征里已经有英文对应（`sword sheathed at hip`），
 * 所以丢掉的是写法，不是事实。
 */
const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/

/** 一条观察里的多值分隔符（与 terms.js 的 splitDescriptionPhrases 同口径）。 */
const PART_SPLIT = /[,;，；、]+/

/**
 * 分词。
 *
 * 英文按空格切就够了；中文不行——`银灰色长发, 浅色调` 整句只有一个空格切出来的词，
 * 于是"换个词序说同一件事"判不出重复，"这条有没有被别的说法涵盖"永远为假，
 * 去重与矛盾判断会一起失效。所以中文按**二字组**切：`银灰色长发` →
 * `银灰/灰色/色长/长发`。二字组是中文里最小的稳定搭配单位，切得比单字准、
 * 比整句细，够用来判"这两句是不是在说同一件事"。
 */
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]+/g

function bigrams(run) {
  const chars = [...run]
  if (chars.length <= 2) return [run]
  const grams = []
  for (let index = 0; index < chars.length - 1; index += 1) grams.push(chars[index] + chars[index + 1])
  return grams
}

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

function covers(needle, haystack, min = 0.8, language = 'en') {
  const need = wordsOf(needle, language)
  if (need.length === 0) return false
  const hay = new Set(wordsOf(haystack, language))
  const hit = need.filter((word) => hay.has(word)).length
  return hit / need.length >= min
}

/** 词序无关的词集合键：`very long flowing hair, light toned` 与 `very long light toned hair` 同键。 */
function wordKey(value, language = 'en') {
  return [...new Set(wordsOf(value, language))].sort().join(' ')
}

/**
 * 从 IR 收集描述版事实。
 *
 * @param {object} ir 已 finalize 的 IR
 * @param {{maxFacts?: number, maxChars?: number}} options
 */
export function collectDescriptionFacts(ir, { maxFacts = 160, maxChars = 4000, language = null } = {}) {
  const facts = []
  const diagnostics = []
  // 语言跟着 IR 走：中文模式下观察值本身就是中文，这里不能再用"含中文就丢"的规则
  // 把它们全筛掉——那等于中文 Caption 没有输入。
  const lang = language ?? ir?.observation_language ?? 'en'
  const stats = {
    scanned: 0,
    kept: 0,
    duplicate: 0,
    negated: 0,
    placeholder: 0,
    non_english: 0,
    measurement: 0,
    uncertain: 0,
    contradicted: 0,
    budget: 0,
    chars: 0,
  }

  const seen = new Set()

  /**
   * 同一个 feature 的 value 被逗号拆开之后，各条分句的"合起来"是什么。
   *
   * `very long flowing hair, light toned` 拆成两条是对的（矛盾判断要按分句做），
   * 但别处再来一条 `very long light toned hair` 时，它跟这两条各看都不重复，
   * 于是同一件事在描述版里说两遍。这里记住"这两条原本是一句"，
   * 让后来那条整体重复能被认出来。
   */
  const groups = new Map()

  const wordsIn = (key) => new Set(key.split(' ').filter(Boolean))

  /**
   * 同一件事换个词序说两遍不该在描述版里各占一次预算。
   *
   * 判据只看词集合的包含关系，不看词库。只在短的那条够长（≥3 词）时才判重复——
   * `bright background` 这种短事实是独立观察，不能被 `hazy bright background` 吞掉。
   */
  const contains = (longerKey, shorterKey) => {
    const short = wordsIn(shorterKey)
    if (short.size < 3) return false
    const long = wordsIn(longerKey)
    return [...short].every((word) => long.has(word))
  }

  /**
   * 这条观察能不能进描述版；不能的话属于哪种原因。
   *
   * 返回原因字符串而不是布尔，是因为"没进描述版"的几种情况在交付里要分开说：
   * 中文关系句丢掉的是写法（方位另有英文事实），否定式丢掉的是"没有"这种说法，
   * 量测丢掉的是数字——混成一个"被过滤"就说不清损失了什么。
   */
  const rejectReason = (text) => {
    if (lang !== 'zh-CN' && CJK_PATTERN.test(text)) return 'non_english'
    if (isNegatedObservation(text) || NON_VISUAL_PATTERN.test(text)) return 'negated'
    if (isPlaceholderObservation(text)) return 'placeholder'
    if (isMeasurementPhrase(text)) return 'measurement'
    return null
  }

  const dropKeys = (keys) => {
    for (const key of keys) {
      const at = facts.findIndex((fact) => fact.key === key)
      if (at >= 0) {
        facts.splice(at, 1)
        seen.delete(key)
        stats.duplicate += 1
      }
    }
  }

  const recordFact = (text, meta, groupKey = null) => {
    const key = wordKey(text, lang)
    if (!key) return
    if (seen.has(key)) {
      stats.duplicate += 1
      const existing = facts.find((fact) => fact.key === key)
      if (existing) {
        for (const ref of meta.source_refs ?? []) {
          if (!existing.source_refs.some((item) => JSON.stringify(item) === JSON.stringify(ref))) existing.source_refs.push(ref)
        }
      }
      return
    }
    // 已有一句把这条说全了（`very long flowing hair, light toned` 之于 `light toned`）。
    if (facts.some((fact) => contains(fact.key, key))) {
      stats.duplicate += 1
      return
    }
    // 已有一组分句合起来把这条说全了（`very long flowing hair` + `light toned`
    // 之于后来的 `very long light toned hair`）。同一组里的分句不能互相当成重复——
    // 它们是同一句话的不同部分。
    for (const [compound, keys] of groups) {
      if (compound === groupKey) continue
      if (!contains(compound, key)) continue
      if (keys.has(key)) continue
      stats.duplicate += 1
      return
    }
    // 反过来：这条把已有的短事实或整组分句说全了，把旧的并进来。
    for (let i = facts.length - 1; i >= 0; i -= 1) {
      if (contains(key, facts[i].key)) dropKeys([facts[i].key])
    }
    for (const [compound, keys] of [...groups]) {
      if (!contains(key, compound)) continue
      dropKeys([...keys])
      groups.delete(compound)
    }
    seen.add(key)
    facts.push({
      text,
      key,
      normalized: normalizePromptText(text),
      category: meta.category ?? 'unsorted',
      slot: meta.slot ?? null,
      entity_id: meta.entity_id ?? null,
      relation_id: meta.relation_id ?? null,
      status: meta.status ?? 'confirmed',
      confidence: typeof meta.confidence === 'number' ? meta.confidence : null,
      importance: typeof meta.importance === 'number' ? meta.importance : null,
      source_refs: Array.isArray(meta.source_refs) ? meta.source_refs.slice() : [],
    })
    stats.kept += 1
    if (groupKey && groupKey !== key) {
      const keys = groups.get(groupKey) ?? new Set()
      keys.add(key)
      groups.set(groupKey, keys)
    }
  }

  const pushOne = (text, meta) => {
    const reason = rejectReason(text)
    if (reason) {
      stats[reason] += 1
      return
    }
    recordFact(text, meta)
  }

  /**
   * 一个 feature 的 value 常是逗号分隔的多条观察
   * （`hazy bright background, glowing gradient from top to bottom, no visible structures`）。
   * 整串当一条看，否定式就藏在中段看不见（`no visible structures` 于是漏进描述版）；
   * `facing viewer, slight torso twist` 整串当一条看，矛盾判断也会跟着失效
   * （这串里既有正对又有转体，按整串比就只剩转体，正对那半截混了进来）。
   * 所以按分隔符拆开逐条过，同时把"它们原本是一句"记下来交给去重。
   */
  const push = (rawText, meta) => {
    const raw = String(rawText ?? '').trim()
    if (!raw) return
    stats.scanned += 1
    const parts = raw.split(PART_SPLIT).map((part) => part.trim()).filter(Boolean)
    if (parts.length <= 1) {
      pushOne(raw, meta)
      return
    }
    // 先筛掉不该进描述版的分句，再用"留下来的分句"算这一组的键。
    //
    // 拿整串算键会出事：`head tilted down, face in shadow, eyes not visible` 里
    // `eyes not visible` 是否定式、不进描述版，但整串的词集合里仍然有 eyes/in/shadow，
    // 于是后面那条真正的观察 `eyes in shadow` 被判成"这一组已经说全了"而静默丢掉。
    // 一个被否定的分句替另一条观察做了担保——这不是去重，是吞掉。
    const accepted = []
    for (const part of parts) {
      const reason = rejectReason(part)
      if (reason) {
        stats[reason] += 1
        continue
      }
      accepted.push(part)
    }
    if (accepted.length === 0) return
    // 只剩一条时它自己就是那条观察，不需要再登记一个"组"。
    const groupKey = accepted.length > 1 ? wordKey(accepted.join(', '), lang) : null
    for (const part of accepted) recordFact(part, meta, groupKey)
  }

  const pushFeature = (feature, { category, key, entity_id = null }) => {
    const value = feature?.value
    if (typeof value !== 'string' || value.length === 0) return
    push(value, {
      category,
      entity_id,
      status: feature?.status,
      confidence: feature?.confidence,
      importance: feature?.importance,
      source_refs: [
        {
          kind: entity_id ? 'entity_feature' : 'feature',
          category,
          key,
          entity_id,
          // 同一 `category.key` 的第几条。三条 background.backdrop 各是各的观察，
          // 不带序号它们会挂到同一个身份上，台账就分不清是哪一条进了候选版。
          occurrence: Number.isInteger(feature?.occurrence) && feature.occurrence > 0 ? feature.occurrence : 0,
        },
      ],
    })
  }

  // 具名段（composition / camera）与 features 数组在 IR 里是两种存法，都要取。
  for (const [section, group] of [
    ['composition', ir?.composition],
    ['camera', ir?.camera],
  ]) {
    for (const [key, feature] of Object.entries(group ?? {})) {
      pushFeature(feature, { category: section, key })
    }
  }
  // 同名多条观察要带序号，否则三条 background.backdrop 会挂到同一个身份上。
  const globalFeatures = Array.isArray(ir?.features) ? ir.features : []
  const globalOccurrences = featureOccurrences(globalFeatures)
  globalFeatures.forEach((feature, index) => {
    if (!feature || typeof feature !== 'object') return
    pushFeature(
      { ...feature, occurrence: globalOccurrences[index] },
      { category: feature.category ?? 'unsorted', key: feature.key ?? null, entity_id: feature.entity_id ?? null },
    )
  })

  for (const entity of Array.isArray(ir?.entities) ? ir.entities : []) {
    if (!entity || typeof entity !== 'object') continue
    // IR 里实体的身份字段叫 `entity_id`，不是 `id`。写成 `entity.id` 会让每一条
    // 实体观察的 source_refs 都丢掉所属实体，台账只能把它们算成"不在候选版里"——
    // 明明写进去了，记录上却是没进去。
    const entityId = entity.entity_id ?? entity.id ?? null
    const label = typeof entity.label === 'string' ? entity.label.trim() : ''
    // 单词标签（`sword`、`bodice`）本来就属于标签版；描述版收的是说得清的短语。
    if (label && label.split(/\s+/).filter(Boolean).length > 1 && entity.kind !== 'person') {
      push(label, {
        category: entity.category ?? 'unsorted',
        entity_id: entityId,
        status: entity.status,
        confidence: entity.confidence,
        source_refs: [{ kind: 'entity_label', entity_id: entityId, entity_kind: entity.kind ?? null }],
      })
    }
    const entityFeatures = Array.isArray(entity.features) ? entity.features : []
    const occurrences = featureOccurrences(entityFeatures)
    entityFeatures.forEach((feature, index) => {
      if (!feature || typeof feature !== 'object') return
      pushFeature(
        { ...feature, occurrence: occurrences[index] },
        {
          category: feature.category ?? entity.category ?? 'unsorted',
          key: feature.key ?? null,
          entity_id: feature.entity_id ?? entityId,
        },
      )
    })
  }

  for (const relation of Array.isArray(ir?.relations) ? ir.relations : []) {
    if (!relation || typeof relation !== 'object') continue
    const description = typeof relation.description === 'string' ? relation.description.trim() : ''
    if (!description) continue
    // IR 里关系的主键叫 `relation_id`。写成 `relation.id` 会让每条关系观察的
    // source_refs 都丢掉身份，台账只能把它记成 `relation:null`——而 IR 那边记的是
    // `relation:rel_1`，两边永远对不上，关系就成了"没有依据"的孤儿。
    const relationId = relation.relation_id ?? relation.id ?? null
    // 关系提到的那两个实体也算"依据"：`right hand holds the umbrella handle`
    // 这句话之所以能说，是因为画里真有一个 umbrella。只挂 relation ref 的话，
    // 那个道具实体在台账上会显示成"没被写进任何成品"，而它明明被写进去了。
    const refs = [{ kind: 'relation', relation_id: relationId, relation_type: relation.type ?? null }]
    for (const entityId of [relation.from, relation.to]) {
      if (typeof entityId === 'string' && entityId !== '') {
        refs.push({ kind: 'entity_label', entity_id: entityId, entity_kind: null })
      }
    }
    push(description, {
      category: relation.category ?? 'pose_action',
      status: relation.status,
      confidence: relation.confidence,
      relation_id: relationId,
      source_refs: refs,
    })
  }

  // 不确定性：observation 自己标了 unknown、置信度又很低，就别当作事实写进描述。
  // 只是 tentative / 置信度中等的照留——它们是"看到了但没把握"，删掉反而丢信息。
  for (const fact of facts) {
    if (fact.status === 'unknown' && (fact.confidence ?? 1) < 0.35) fact.dropped = 'uncertain'
  }

  // 矛盾：同一批观察里既写"正对镜头"又写"转过角度"，保留转体那条。
  // 转体是更具体的断言，正对往往是被"人形物体默认朝前"的先验写出来的。
  const rotationFacts = facts.filter((fact) => fact.dropped !== 'uncertain' && ROTATION_CLAIM.test(fact.text))
  if (rotationFacts.length > 0) {
    for (const fact of facts) {
      if (fact.dropped) continue
      if (!FRONTAL_CLAIM.test(fact.text)) continue
      if (ROTATION_CLAIM.test(fact.text)) continue
      fact.dropped = 'contradicted'
      fact.contradicted_by = rotationFacts[0].source_refs[0] ?? null
    }
  }

  const kept = []
  let chars = 0
  for (const fact of facts) {
    if (fact.dropped === 'uncertain') {
      stats.uncertain += 1
      continue
    }
    if (fact.dropped === 'contradicted') {
      stats.contradicted += 1
      continue
    }
    if (kept.length >= maxFacts || chars + fact.text.length > maxChars) {
      stats.budget += 1
      continue
    }
    kept.push(fact)
    chars += fact.text.length + 2
  }
  stats.chars = chars
  stats.kept = kept.length

  if (stats.contradicted > 0) {
    diagnostics.push({
      error_code: DESCRIBE_CODES.FACT_CONTRADICTED,
      severity: 'info',
      message: `描述版输入里删掉了 ${stats.contradicted} 条"正对镜头"的说法：同一批观察里另有转体断言，两者不可能同时成立。`,
    })
  }
  if (stats.budget > 0) {
    diagnostics.push({
      error_code: DESCRIBE_CODES.FACT_BUDGET_TRIMMED,
      severity: 'info',
      message: `描述版输入按表达预算裁掉了 ${stats.budget} 条观察（上限 ${maxFacts} 条 / ${maxChars} 字符）。被裁的不代表无效，只是描述版容量有限。`,
    })
  }
  if (stats.non_english > 0) {
    diagnostics.push({
      error_code: DESCRIBE_CODES.FACT_NON_ENGLISH,
      severity: 'info',
      message: `描述版输入里有 ${stats.non_english} 条中文（或日文假名）观察没有收进来：提示词是英文的，原样拼进去生成端读不懂。这类观察的方位信息在实体特征里有英文对应。`,
    })
  }

  return { schema_version: DESCRIBE_SCHEMA_VERSION, language: lang, facts: kept, dropped_facts: facts.filter((fact) => fact.dropped), diagnostics, stats }
}

/**
 * 给每个分句标上它来自哪些事实。
 *
 * 只做支持关系核对：分句里的词是否被某条事实覆盖。它回答"这句话是从哪来的"，
 * 不回答"这句话对不对"——对错要靠生成实验，不能拿同一模型的自评冒充。
 */
export function attachSourceRefs(clauses, facts, { language = 'en' } = {}) {
  const list = Array.isArray(clauses) ? clauses : []
  const pool = Array.isArray(facts) ? facts : []
  return list.map((clause) => {
    const text = String(clause?.text ?? '')
    const refs = []
    const supported = []
    for (const fact of pool) {
      if (!covers(fact.text, text, 0.75, language)) continue
      supported.push(fact.text)
      for (const ref of fact.source_refs ?? []) {
        if (!refs.some((item) => JSON.stringify(item) === JSON.stringify(ref))) refs.push(ref)
      }
    }
    return { ...clause, source_refs: refs, supported_by: supported }
  })
}

/**
 * 描述接地检查：词汇表是 IR 事实，不是标签词表。
 *
 * 旧检查要求描述里的实词都出现在标签词表里。可标签词表是本地 CSV 的子集，描述版写
 * 得比词表全很正常——于是"说得更清楚"会被判成"编造"。这里改成对准事实：
 * 每个内容词至少要被一条 IR 事实覆盖；覆盖不到的不判错，只标出来待验证。
 */
export function verifyDescriptionGrounding({ text, facts, language = 'en' } = {}) {
  const pool = Array.isArray(facts) ? facts : []
  const factWords = new Set()
  for (const fact of pool) for (const word of wordsOf(fact.text, language)) factWords.add(word)
  const clauseWords = wordsOf(text, language)
  const unsupported = []
  for (const word of clauseWords) {
    if (word.length < 2) continue
    if (factWords.has(word)) continue
    if (FUNCTION_WORDS.has(word)) continue
    if (!unsupported.includes(word)) unsupported.push(word)
  }
  return {
    ok: unsupported.length === 0,
    basis: 'ir_facts',
    unsupported,
    checked_words: clauseWords.length,
  }
}

const FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'on', 'in', 'at', 'with', 'from', 'to', 'by',
  'into', 'over', 'under', 'behind', 'beside', 'near', 'through', 'toward', 'towards',
  'wearing', 'holding', 'looking', 'touching', 'lit', 'shot', 'seen', 'viewed',
  'standing', 'sitting', 'while', 'against', 'his', 'her', 'its', 'their', 'is', 'are',
])
