/**
 * 事实台账：一条观察从"看到"到"进了哪个通道"的完整去向。
 *
 * 为什么要按身份记，而不是按词面比：旧的对账把观察原话拿去和最终提示词做词集合覆盖，
 * 于是"这条观察是不是还在"变成了一个模糊的相似度问题——`face in shadow` 与
 * `face obscured by shadow` 算不算同一条？改写过两次的还算不算？答案是"看运气"。
 * 更要命的是它只能回答"在不在"，回答不了"在哪一步没的、被谁改成了什么"。
 *
 * 这里的做法是给每条观察一个稳定的身份（IR 里的 category + key + entity_id /
 * relation_id），然后沿着编译链把它一路带下去：
 *
 *   IR 事实 → 词条（terms）→ 解析（resolve）→ 分槽（slot）→ 预算（budget）
 *          → 渲染（render）→ 描述版 → 候选描述版
 *
 * 每一步都按身份 join，不靠词重合反推。词条自己带着 ref 往下走，丢弃记录也带 ref，
 * 所以"它最后去哪了"是一个查表结论，不是一次猜测。
 */

import { featureOccurrences } from '../ir/schema.js'

export const LEDGER_SCHEMA_VERSION = '1.0'

/** 一条观察最终的归宿。四者互斥，且必须有一个。 */
export const CHANNELS = Object.freeze({
  TAGS: 'tags',
  DESCRIPTION: 'description',
  CANDIDATE: 'candidate',
  NONE: 'none',
})

/** 处置方式：保留 / 改写 / 丢弃 / 未到达。 */
export const DISPOSITIONS = Object.freeze({
  // retained 的含义必须说清楚：**进了至少一个通道**，不是"每个通道都有"。
  // 早期版本里这个字段被读成"保住了"，于是 17 条只在描述版出现、标签版完全没有
  // 的观察，在台账上跟三通道齐全的观察长得一模一样。想知道它到底进了哪些通道，
  // 看 `channels`；想知道它缺了哪些，看 `missing_channels`。
  RETAINED: 'retained',
  REWRITTEN: 'rewritten',
  DROPPED: 'dropped',
  UNKNOWN: 'unknown',
})

/** 链上的步骤名。台账里每条改写/丢弃都标它发生在哪一步。 */
export const LEDGER_STAGES = Object.freeze({
  EVIDENCE: 'evidence',
  COLLECT: 'collect',
  SYNTHESIZE: 'synthesize',
  RESOLVE: 'resolve',
  SLOT: 'slot',
  BUDGET: 'budget',
  RENDER: 'render',
})

export function factId({ kind = 'feature', category = '', key = '', entity_id = null, relation_id = null, occurrence = 0 } = {}) {
  if (kind === 'relation') return `relation:${relation_id ?? ''}`
  if (kind === 'entity') return `entity:${entity_id ?? ''}`
  const scope = entity_id ? `@${entity_id}` : ''
  // 同一 `category.key` 的第几条。IR 里 `features` 可以有两条 `appearance.material_texture`
  // （一条皮肤、一条衣料），三条 `background.backdrop`（bright / haze / gradient）。
  // 不带序号它们会塌成同一个身份，台账出现同 id 多行，`explainFact` 只认第一行。
  // 第 0 条不写后缀，这样既有的身份字符串一个都没变。
  const nth = Number.isInteger(occurrence) && occurrence > 0 ? `#${occurrence}` : ''
  return `feature:${category}.${key}${scope}${nth}`
}

/**
 * 把 IR 摊平成一组带身份的事实。
 *
 * 顺序固定（composition → camera → features → entity features → entity labels → relations），
 * 这样两次运行的台账可以直接逐行对比。
 */
export function collectIRFacts(ir) {
  const facts = []
  const push = (input) => {
    const id = factId(input)
    facts.push({
      fact_id: id,
      kind: input.kind ?? 'feature',
      category: String(input.category ?? ''),
      key: String(input.key ?? ''),
      entity_id: input.entity_id ?? null,
      relation_id: input.relation_id ?? null,
      // 同一 `category.key` 的第几条；身份字符串里的 `#n` 就是它。
      occurrence: Number.isInteger(input.occurrence) && input.occurrence > 0 ? input.occurrence : 0,
      // IR 里的观察值字段叫 value，不是 text。这里取错了会让"改前 == 改后"
      // 永远成立，于是证据层的改写一条也测不出来——所以三种写法都认。
      text: String(input.text ?? input.value ?? input.description ?? ''),
      importance: typeof input.importance === 'number' ? input.importance : null,
      confidence: typeof input.confidence === 'number' ? input.confidence : null,
      status: input.status ?? null,
    })
  }

  for (const [key, feature] of Object.entries(ir?.composition ?? {})) {
    push({ kind: 'feature', category: 'composition', key, ...feature })
  }
  for (const [key, feature] of Object.entries(ir?.camera ?? {})) {
    push({ kind: 'feature', category: 'camera', key, ...feature })
  }
  // `features` 与实体上的 `features` 都可能出现同名多条（三条 background.backdrop、
  // 两条 appearance.material_texture）。序号按数组内出现顺序算，与 collectFeatures
  // 用的同一套规则，这样词条的 occurrence 才能对回这里的身份。
  const globalFeatures = Array.isArray(ir?.features) ? ir.features : []
  const globalOccurrences = featureOccurrences(globalFeatures)
  globalFeatures.forEach((feature, index) => {
    push({ kind: 'feature', ...feature, ...(globalOccurrences[index] > 0 ? { occurrence: globalOccurrences[index] } : {}) })
  })
  for (const entity of Array.isArray(ir?.entities) ? ir.entities : []) {
    const entityFeatures = Array.isArray(entity?.features) ? entity.features : []
    const occurrences = featureOccurrences(entityFeatures)
    entityFeatures.forEach((feature, index) => {
      push({
        kind: 'feature',
        entity_id: entity.entity_id ?? null,
        ...feature,
        ...(occurrences[index] > 0 ? { occurrence: occurrences[index] } : {}),
      })
    })
    if (typeof entity?.label === 'string' && entity.label.trim() !== '') {
      push({
        kind: 'entity',
        category: 'entity_label',
        key: 'label',
        entity_id: entity.entity_id ?? null,
        text: entity.label,
        importance: entity.importance ?? null,
        confidence: entity.confidence ?? null,
        status: 'confirmed',
      })
    }
  }
  for (const relation of Array.isArray(ir?.relations) ? ir.relations : []) {
    push({
      kind: 'relation',
      category: 'relation',
      key: String(relation?.type ?? ''),
      relation_id: relation?.relation_id ?? null,
      text: String(relation?.description ?? ''),
      importance: relation?.importance ?? null,
      confidence: relation?.confidence ?? null,
      status: relation?.status ?? null,
      from: relation?.from ?? null,
      to: relation?.to ?? null,
    })
  }
  return facts
}

/**
 * 证据层前后对比：哪条观察被改写、被注入、被删掉。
 *
 * 这是"一条关键观察在哪一步改变"的第一个答案，而且是最硬的那个——
 * 两边都是 IR 快照，按身份对齐，不涉及任何文本相似度。
 */
export function diffEvidenceStage(beforeIR, afterIR) {
  const before = new Map(collectIRFacts(beforeIR).map((fact) => [fact.fact_id, fact]))
  const after = new Map(collectIRFacts(afterIR).map((fact) => [fact.fact_id, fact]))
  const rewritten = []
  const injected = []
  const removed = []
  for (const [id, fact] of after) {
    const old = before.get(id)
    if (!old) {
      injected.push({ fact_id: id, stage: LEDGER_STAGES.EVIDENCE, text: fact.text, category: fact.category, key: fact.key })
      continue
    }
    if (old.text === fact.text) continue
    rewritten.push({
      fact_id: id,
      stage: LEDGER_STAGES.EVIDENCE,
      category: fact.category,
      key: fact.key,
      before: old.text,
      after: fact.text,
      // 证据层自己写的理由就挂在 feature.note 上，直接抄，不要事后猜。
      note: noteOf(afterIR, fact) ?? null,
    })
  }
  for (const [id, fact] of before) {
    if (after.has(id)) continue
    removed.push({ fact_id: id, stage: LEDGER_STAGES.EVIDENCE, text: fact.text, category: fact.category, key: fact.key })
  }
  return { rewritten, injected, removed }
}

function noteOf(ir, fact) {
  const holders = []
  if (fact.category === 'composition' || fact.category === 'camera') {
    holders.push(ir?.[fact.category]?.[fact.key])
  } else if (fact.entity_id) {
    const entity = (ir?.entities ?? []).find((item) => item?.entity_id === fact.entity_id)
    holders.push(...(entity?.features ?? []).filter((f) => f?.category === fact.category && f?.key === fact.key))
  } else {
    holders.push(...(ir?.features ?? []).filter((f) => f?.category === fact.category && f?.key === fact.key))
  }
  for (const holder of holders) {
    if (holder && typeof holder.note === 'string' && holder.note.trim() !== '') return holder.note.trim()
  }
  return null
}

/**
 * 词条的稳定引用。
 *
 * 编译层每一步都在丢 term 对象（分槽只留文本、预算只留文本），一丢身份就没了。
 * 这个函数把身份压成三个字段，跟着丢弃记录一起走，于是"它为什么没进提示词"
 * 变成一次查表，而不是一次文本比对。
 */
export function termRef(term) {
  if (!term || typeof term !== 'object') return null
  return {
    origin: term.origin ?? null,
    category: String(term.category ?? ''),
    key: term.key ?? null,
    entity_id: term.entity_id ?? null,
    // 与 factId 同源的序号：不带它，同名多条观察的词条会全部挂到第 0 条上。
    occurrence: Number.isInteger(term.occurrence) && term.occurrence > 0 ? term.occurrence : 0,
  }
}

/** 词条的 ref 对回 IR 事实的身份。origin 决定它是观察、实体名还是关系合成词。 */
export function refToFactId(ref) {
  if (!ref || typeof ref !== 'object') return null
  if (ref.origin === 'entity') return factId({ kind: 'entity', entity_id: ref.entity_id })
  // 关系带了确切 id 就按 id 走：同一类型可能有多条关系，按类型归并会把
  // "这条关系为什么没合成标签"和"那条关系为什么没合成"混成一条。
  if (ref.relation_id) return factId({ kind: 'relation', relation_id: ref.relation_id })
  if (typeof ref.key === 'string' && ref.key.startsWith('relation:')) {
    // 合成词条只记了关系类型，没有 relation_id：这时不硬猜是哪一条，
    // 标成 relation_type 级别的引用。
    return `relation_type:${ref.key.slice('relation:'.length)}`
  }
  if (typeof ref.key === 'string' && ref.key.startsWith('pose_tag:')) {
    return `pose_tag:${ref.key.slice('pose_tag:'.length)}`
  }
  return factId({
    kind: 'feature',
    category: ref.category,
    key: ref.key ?? '',
    entity_id: ref.entity_id ?? null,
    occurrence: Number.isInteger(ref.occurrence) && ref.occurrence > 0 ? ref.occurrence : 0,
  })
}

/**
 * 建台账。
 *
 * @param {object} args
 * @param {object} args.ir           证据层之后的 IR（最终 IR）
 * @param {object|null} args.irBeforeEvidence 证据层之前的 IR 快照；拿不到就传 null
 * @param {object} args.compiled     compilePrompt 的返回值
 * @param {object|null} args.collected collectTerms 的返回值（含 skipped / negated）
 */
export function buildFactLedger({ ir, irBeforeEvidence = null, compiled = null, collected = null, relationSkips = [], localAbsences = [] } = {}) {
  const facts = collectIRFacts(ir)
  const evidence = irBeforeEvidence ? diffEvidenceStage(irBeforeEvidence, ir) : null

  // ---- 编译链上的索引：全部按身份 join ----
  const termIndex = new Map() // fact_id -> [term]
  const terms = Array.isArray(compiled?.all_terms) ? compiled.all_terms : []
  for (const term of terms) {
    const id = refToFactId(termRef(term))
    if (!id) continue
    if (!termIndex.has(id)) termIndex.set(id, [])
    termIndex.get(id).push(term)
  }

  const droppedIndex = new Map() // fact_id -> [{stage, reason}]
  for (const entry of Array.isArray(compiled?.dropped) ? compiled.dropped : []) {
    const id = entry?.ref ? refToFactId(entry.ref) : null
    if (!id) continue
    if (!droppedIndex.has(id)) droppedIndex.set(id, [])
    droppedIndex.get(id).push({ stage: entry.stage ?? LEDGER_STAGES.RESOLVE, reason: entry.reason ?? 'dropped' })
  }

  const skippedIndex = new Map()
  for (const entry of Array.isArray(collected?.skipped) ? collected.skipped : []) {
    const id = entry?.ref ? refToFactId(entry.ref) : null
    if (!id) continue
    if (!skippedIndex.has(id)) skippedIndex.set(id, [])
    skippedIndex.get(id).push({ stage: LEDGER_STAGES.COLLECT, reason: entry.reason ?? 'skipped' })
  }
  for (const entry of Array.isArray(collected?.negated) ? collected.negated : []) {
    const id = entry?.ref ? refToFactId(entry.ref) : null
    if (!id) continue
    if (!skippedIndex.has(id)) skippedIndex.set(id, [])
    skippedIndex.get(id).push({ stage: LEDGER_STAGES.COLLECT, reason: 'negated' })
  }
  // 关系没合成复合标签，是编译层主动放弃，不是"不知道去哪了"。
  // 不记这一笔，8 条关系就会全部落进 unknown，看上去像台账漏了。
  for (const entry of Array.isArray(relationSkips) ? relationSkips : []) {
    const id = entry?.ref ? refToFactId(entry.ref) : null
    if (!id) continue
    if (!skippedIndex.has(id)) skippedIndex.set(id, [])
    skippedIndex.get(id).push({ stage: LEDGER_STAGES.SYNTHESIZE, reason: entry.reason ?? 'relation_not_synthesized' })
  }

  // ---- 局部复核提过的缺席断言：按身份挂到对应观察上 ----
  //
  // 阶段 B 看的是裁图，它说「这里没有剑」时有两种可能：这句话本来只在这个局部成立
  // （`scope: 'crop'`），或者它想据此断言全图没有（`scope: 'frame'`）。
  // 第 11 轮把这两种都挡在 IR 之外，不让它们覆盖或新增全局结论——但挡下来之后
  // 这些记录就只活在 `reviews[].crop_local` 里，台账一条都不提。
  // 结果是一份看起来干净、却答不了"有没有人质疑过这条观察"的台账：
  // 阶段 B 说过「没有剑」和阶段 B 什么都没说，`unsorted.sword` 这条记录一模一样。
  //
  // 所以这里按身份把它们挂回去。挂不上身份的（说的是全局从来没有的东西）
  // 单独列出来，不硬塞进任何一条。
  const absenceIndex = new Map() // fact_id -> [absence]
  const absenceUnmatched = []
  for (const item of Array.isArray(localAbsences) ? localAbsences : []) {
    const id = factId({
      kind: 'feature',
      category: String(item?.category ?? ''),
      key: String(item?.key ?? ''),
      entity_id: item?.entity_id ?? null,
    })
    const entry = {
      scope: item?.scope === 'frame' ? 'frame' : 'crop',
      value: String(item?.value ?? ''),
      kept_global: item?.kept_global ?? null,
      crop_id: item?.crop_id ?? null,
      region_space: item?.region_space ?? null,
    }
    if (!id) {
      absenceUnmatched.push({ ...entry, fact_id: null })
      continue
    }
    if (!absenceIndex.has(id)) absenceIndex.set(id, [])
    absenceIndex.get(id).push(entry)
  }

  // ---- 通道：标签版按渲染时平行记下的 ref 判，不按文本判 ----
  // segments[].terms 是渲染后的字符串，身份已经丢了；renderPrompt 同时记了一份 refs，
  // 这里用 refs 而不是拿字符串去猜。
  const tagRefs = new Set()
  // 有些词条是编译层主动挡在标签版外面的（带介词的半句话进 tag 只会摊薄别的词）。
  // 这是规则，不是丢失；但台账只说"不在标签版"等于让人回去翻代码找原因。
  const tagExcludedRefs = new Set()
  for (const segment of Array.isArray(compiled?.slots) ? compiled.slots : []) {
    const refs = Array.isArray(segment?.refs) ? segment.refs : []
    for (const ref of refs) {
      const id = refToFactId(ref)
      if (id) tagRefs.add(id)
    }
  }
  for (const term of terms) {
    if (term?.excluded_from_tags !== true) continue
    const id = refToFactId(termRef(term))
    if (id) tagExcludedRefs.add(id)
  }

  // ---- 描述版：clause.tags 就是被写进句子的那串词条文本，按词条自身的 text 精确对齐 ----
  // 注意：这里用的是"我们发出的那个字符串"做 join key，不是把最终提示词拆词做覆盖比对。
  const descriptionTexts = new Set()
  for (const clause of Array.isArray(compiled?.composed?.clauses) ? compiled.composed.clauses : []) {
    for (const tag of Array.isArray(clause?.tags) ? clause.tags : []) {
      if (typeof tag === 'string' && tag.trim() !== '') descriptionTexts.add(tag.trim())
    }
  }
  const descriptionRefs = new Set()
  for (const term of terms) {
    if (!descriptionTexts.has(String(term?.text ?? '').trim())) continue
    const id = refToFactId(termRef(term))
    if (id) descriptionRefs.add(id)
  }

  // ---- 候选描述版：facts 自带 source_refs，本来就是身份，不需要文本对齐 ----
  const candidateRefs = new Set()
  const candidateDropped = new Map()
  const candidate = compiled?.description_candidate ?? null
  for (const fact of Array.isArray(candidate?.facts) ? candidate.facts : []) {
    for (const ref of Array.isArray(fact?.source_refs) ? fact.source_refs : []) {
      const id = candidateRefId(ref)
      if (id) candidateRefs.add(id)
    }
  }
  for (const fact of Array.isArray(candidate?.dropped_facts) ? candidate.dropped_facts : []) {
    for (const ref of Array.isArray(fact?.source_refs) ? fact.source_refs : []) {
      const id = candidateRefId(ref)
      if (id) candidateDropped.set(id, fact?.dropped ?? 'dropped')
    }
  }

  // ---- 逐条成账 ----
  const records = facts.map((fact) => {
    const own = termIndex.get(fact.fact_id) ?? []
    const drops = droppedIndex.get(fact.fact_id) ?? []
    const skips = skippedIndex.get(fact.fact_id) ?? []
    const inTags = tagRefs.has(fact.fact_id)
    const inDescription = descriptionRefs.has(fact.fact_id)
    const inCandidate = candidateRefs.has(fact.fact_id)

    const evidenceChange = evidence?.rewritten.find((item) => item.fact_id === fact.fact_id) ?? null
    const injectedByEvidence = evidence?.injected.some((item) => item.fact_id === fact.fact_id) ?? false

    const channels = []
    if (inTags) channels.push(CHANNELS.TAGS)
    if (inDescription) channels.push(CHANNELS.DESCRIPTION)
    if (inCandidate) channels.push(CHANNELS.CANDIDATE)

    // 缺了哪些通道要单独写出来。
    //
    // `disposition: 'retained'` 只回答"它有没有进某个成品"，回答不了"标签版里有没有"。
    // 真跑里 17 条高重要度观察只在描述版、标签版完全没有，旧字段上它们与三通道齐全的
    // 记录一模一样——这正是"任一通道出现就算全部保留"的漏洞所在。
    // 只有真的进了至少一个通道时，缺的那几个才叫"通道差"；一个都没进的是丢弃或未到达。
    const allChannels = [CHANNELS.TAGS, CHANNELS.DESCRIPTION, CHANNELS.CANDIDATE]
    const missingChannels = channels.length === 0 ? allChannels.slice() : allChannels.filter((item) => !channels.includes(item))

    let disposition
    if (own.length === 0) {
      disposition = skips.length > 0 || drops.length > 0 ? DISPOSITIONS.DROPPED : DISPOSITIONS.UNKNOWN
    } else if (channels.length > 0) {
      disposition = evidenceChange ? DISPOSITIONS.REWRITTEN : DISPOSITIONS.RETAINED
    } else {
      disposition = DISPOSITIONS.DROPPED
    }

    // 缺通道的理由要分两种：一种是我们按规则挡的（不是丢失），一种是真没走到。
    // 混在一起看，17 条"标签版没有"会被当成 17 条事故。
    const channelNotes = {}
    if (!inTags && own.length > 0) {
      channelNotes[CHANNELS.TAGS] = tagExcludedRefs.has(fact.fact_id)
        ? '带介词的半句话，按规则不进标签版'
        : null
    }
    if (!inCandidate && own.length > 0) {
      channelNotes[CHANNELS.CANDIDATE] = candidateDropped.get(fact.fact_id) ?? null
    }

    // 最早一次丢弃就是它"消失的那一步"：后面的步骤只是没机会再处理它。
    const losses = [...skips, ...drops]
    const firstLoss = losses.length > 0 ? losses[0] : null

    // 分句级的丢弃 ≠ 整条观察被丢弃。
    //
    // 一条观察常常是 `smooth skin with soft diffuse shading, rim lit edges,
    // glowing along their edges where backlit` 这种多值串：其中一个分句被挡掉，
    // 其余分句照样进了成品。旧写法把这个分句的丢弃直接写成整条的 `dropped_at`，
    // 于是真跑里出现 7 条自相矛盾的记录——`disposition: retained`、三个通道全进了，
    // 却同时标着「在 collect 阶段被丢弃（原因：negated）」。
    // 读 `dropped_reason` 的人会以为整条丢了，而 `explainFact` 又因为 disposition
    // 不是 dropped 而不打印它——两边都看不到真相。
    //
    // 只有"一个通道都没进"时，`dropped_at` 才配得上"这条观察消失的那一步"。
    //
    // 同一次丢弃在 `dropped` 与 `skipped` 里各有一份（否定式分句两边都会记），
    // 直接相加会把"2 个分句没写进去"报成 4 个。按 (stage, reason) 去重后再数。
    const wholeObservationLost = channels.length === 0
    const uniqueLosses = []
    const seenLosses = new Set()
    for (const item of losses) {
      const stage = item.stage ?? null
      const reason = item.reason ?? 'dropped'
      const signature = `${stage}|${reason}`
      if (seenLosses.has(signature)) continue
      seenLosses.add(signature)
      uniqueLosses.push({ stage, reason })
    }
    const phraseLosses = wholeObservationLost ? [] : uniqueLosses

    return {
      fact_id: fact.fact_id,
      kind: fact.kind,
      category: fact.category,
      key: fact.key,
      entity_id: fact.entity_id,
      relation_id: fact.relation_id,
      // 原文指证据层之后的 IR 值：这才是编译层真正吃进去的那句话。
      text: fact.text,
      original_text: evidenceChange ? evidenceChange.before : fact.text,
      importance: fact.importance,
      confidence: fact.confidence,
      status: fact.status,
      disposition,
      channels,
      missing_channels: missingChannels,
      channel_notes: channelNotes,
      in_tags: inTags,
      in_description: inDescription,
      in_candidate: inCandidate,
      rewritten_at: evidenceChange ? LEDGER_STAGES.EVIDENCE : null,
      rewritten_from: evidenceChange ? evidenceChange.before : null,
      rewritten_to: evidenceChange ? evidenceChange.after : null,
      rewrite_note: evidenceChange ? evidenceChange.note : null,
      injected_by_evidence: injectedByEvidence,
      dropped_at: wholeObservationLost && firstLoss ? firstLoss.stage : null,
      dropped_reason: wholeObservationLost && firstLoss ? firstLoss.reason : null,
      // 分句级丢弃单独记：观察还在，只是其中一句没写进去。
      dropped_phrases: phraseLosses,
      candidate_dropped_reason: candidateDropped.get(fact.fact_id) ?? null,
      // 局部复核有没有质疑过这条观察、质疑成什么样、最后怎么处理。
      // 空数组也是信息：它说明"没人质疑过"，与"质疑过但我们保留了"是两件事。
      local_absences: absenceIndex.get(fact.fact_id) ?? [],
      term_count: own.length,
    }
  })

  // 证据层注入的观察在 IR 里存在、在 before 里不存在：台账要能单独列出来。
  const injectedRecords = (evidence?.injected ?? []).map((item) => ({
    fact_id: item.fact_id,
    stage: LEDGER_STAGES.EVIDENCE,
    text: item.text,
    category: item.category,
    key: item.key,
    note: '证据层按像素判定补写的观察',
  }))

  // 挂不上身份的缺席断言：说的是全局从来没有的东西（或者 key 拼错了）。
  // 单独列出来而不是丢掉——它至少证明"阶段 B 在这一块报过否定"，值得人看一眼。
  const recordIds = new Set(records.map((item) => item.fact_id))
  for (const [id, entries] of absenceIndex) {
    if (recordIds.has(id)) continue
    for (const entry of entries) absenceUnmatched.push({ ...entry, fact_id: id })
  }
  const matchedAbsences = records.reduce((sum, item) => sum + item.local_absences.length, 0)

  const stats = {
    facts: records.length,
    retained: records.filter((item) => item.disposition === DISPOSITIONS.RETAINED).length,
    rewritten: records.filter((item) => item.disposition === DISPOSITIONS.REWRITTEN).length,
    dropped: records.filter((item) => item.disposition === DISPOSITIONS.DROPPED).length,
    unknown: records.filter((item) => item.disposition === DISPOSITIONS.UNKNOWN).length,
    in_tags: records.filter((item) => item.in_tags).length,
    in_description: records.filter((item) => item.in_description).length,
    in_candidate: records.filter((item) => item.in_candidate).length,
    // 三个通道齐全 / 只进了其中一部分。分开数，免得"进了描述版"被当成"都保住了"。
    retained_all_channels: records.filter((item) => item.channels.length === 3).length,
    retained_partial: records.filter((item) => item.channels.length > 0 && item.channels.length < 3).length,
    missing_from_tags: records.filter((item) => item.channels.length > 0 && !item.in_tags).length,
    missing_from_description: records.filter((item) => item.channels.length > 0 && !item.in_description).length,
    missing_from_candidate: records.filter((item) => item.channels.length > 0 && !item.in_candidate).length,
    // 其中"按规则挡在标签版外面"的那部分：不是丢失，是规则。
    tags_excluded_by_rule: records.filter((item) => item.channel_notes?.[CHANNELS.TAGS]).length,
    evidence_rewritten: evidence?.rewritten.length ?? null,
    evidence_injected: evidence?.injected.length ?? null,
    evidence_removed: evidence?.removed.length ?? null,
    evidence_available: evidence !== null,
    // 局部复核报过多少次"这里没有"：按它自己限定的范围分开数，
    // 因为"只在这个裁图里不成立"和"它想断言全图没有"处理方式完全不同。
    local_absences: {
      total: matchedAbsences + absenceUnmatched.length,
      crop_scope: records.reduce((sum, item) => sum + item.local_absences.filter((entry) => entry.scope === 'crop').length, 0)
        + absenceUnmatched.filter((entry) => entry.scope === 'crop').length,
      frame_scope: records.reduce((sum, item) => sum + item.local_absences.filter((entry) => entry.scope === 'frame').length, 0)
        + absenceUnmatched.filter((entry) => entry.scope === 'frame').length,
      matched: matchedAbsences,
      unmatched: absenceUnmatched.length,
    },
  }

  return {
    schema_version: LEDGER_SCHEMA_VERSION,
    // join_basis 必须写出来：读者要能一眼看出这份台账不是靠词重合猜的。
    join_basis: 'ir_identity',
    evidence_available: evidence !== null,
    evidence: evidence ?? {
      rewritten: [],
      injected: [],
      removed: [],
      missing_reason: '没有拿到证据层之前的 IR 快照，无法判断观察在证据层是否被改写',
    },
    injected: injectedRecords,
    // 局部复核的缺席断言：挂上了身份的在各条记录的 `local_absences` 里，
    // 挂不上的在这里。两者都留，不合并成一句"共 N 条"。
    local_absences_unmatched: absenceUnmatched,
    records,
    stats,
  }
}

function candidateRefId(ref) {
  if (!ref || typeof ref !== 'object') return null
  if (ref.kind === 'entity_label') return factId({ kind: 'entity', entity_id: ref.entity_id ?? null })
  if (ref.kind === 'relation') return `relation:${ref.relation_id ?? ''}`
  if (ref.kind === 'feature') {
    return factId({
      kind: 'feature',
      category: String(ref.category ?? ''),
      key: String(ref.key ?? ''),
      entity_id: ref.entity_id ?? null,
      occurrence: Number.isInteger(ref.occurrence) && ref.occurrence > 0 ? ref.occurrence : 0,
    })
  }
  // 老格式：只给了 category / key
  if (typeof ref.category === 'string' && typeof ref.key === 'string') {
    return factId({
      kind: 'feature',
      category: ref.category,
      key: ref.key,
      entity_id: ref.entity_id ?? null,
      occurrence: Number.isInteger(ref.occurrence) && ref.occurrence > 0 ? ref.occurrence : 0,
    })
  }
  return null
}

/**
 * 一条观察的去向说明，给报告与面板直接用。
 * 返回的是句子，不是状态码——"它去哪了"这个问题用户要的是答案，不是枚举。
 */
export function explainFact(record) {
  if (!record) return '台账里没有这条观察。'
  const where = []
  if (record.in_tags) where.push('标签版')
  if (record.in_description) where.push('默认描述版')
  if (record.in_candidate) where.push('候选描述版')
  const parts = []
  if (record.rewritten_at) {
    parts.push(`在${record.rewritten_at}阶段被改写：「${record.rewritten_from}」→「${record.rewritten_to}」`)
  }
  if (record.injected_by_evidence) parts.push('由证据层按像素判定补写')
  // 局部复核质疑过这条观察：必须说出来。
  //
  // 不说的话，"阶段 B 报过『这里没有剑』而我们保留了全局那条"与
  // "阶段 B 根本没提过"在台账里长得一模一样，两条路都读不出发生过什么。
  const absences = Array.isArray(record.local_absences) ? record.local_absences : []
  if (absences.length > 0) {
    const detail = absences.map((item) => {
      const where = item.crop_id ? `（${item.crop_id}）` : ''
      return item.scope === 'frame'
        ? `「${item.value}」${where}——它想据此断言全图没有，已降级成待裁决事实`
        : `「${item.value}」${where}——这句只在那块裁图里成立`
    })
    const kept = absences.map((item) => item.kept_global).find((value) => typeof value === 'string' && value !== '')
    parts.push(`局部复核提过 ${detail.join('；')}，没有据此改动全局${kept ? `（全局仍是「${kept}」）` : ''}`)
  }
  if (record.disposition === DISPOSITIONS.DROPPED) {
    parts.push(`在${record.dropped_at ?? '未知'}阶段被丢弃（原因：${record.dropped_reason ?? '未标注'}）`)
  }
  // 观察还在、但其中几个分句没写进去：这是"部分丢失"，不能并进上面那句，
  // 也不能不说——读者问"这条观察完整吗"时，答案就藏在这里。
  const phraseLosses = Array.isArray(record.dropped_phrases) ? record.dropped_phrases : []
  if (phraseLosses.length > 0) {
    const detail = [...new Set(phraseLosses.map((item) => `${item.stage ?? '未知'}：${item.reason}`))]
    parts.push(`有 ${phraseLosses.length} 个分句没写进去（${detail.join('；')}），观察本身仍在`)
  }
  if (where.length > 0) {
    parts.push(`最终进入：${where.join(' / ')}`)
    // 缺的通道必须说出来。"进了描述版"不等于"标签版也有"，
    // 而读者常常只看一眼"有没有进"，就把两个通道当成一件事。
    const missing = Array.isArray(record.missing_channels) ? record.missing_channels : []
    const labelOf = { tags: '标签版', description: '默认描述版', candidate: '候选描述版' }
    const missed = missing.map((item) => labelOf[item] ?? item)
    if (missed.length > 0 && missed.length < 3) {
      // 缺的理由如果是"我们按规则挡的"，要说出来——否则读者会当成事故去修。
      const notes = record.channel_notes ?? {}
      const why = missing.map((item) => notes[item]).filter((note) => typeof note === 'string' && note !== '')
      const tail = why.length > 0 ? `（${[...new Set(why)].join('；')}）` : ''
      parts.push(`没有进入：${missed.join(' / ')}${tail}`)
    }
  } else {
    parts.push('最终没有进入任何通道')
  }
  return `${record.fact_id}：${parts.join('；')}。`
}
