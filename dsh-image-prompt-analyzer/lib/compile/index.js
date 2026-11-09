
import { SEVERITY, diagnostic } from '../diagnostics.js'
import { importanceOverridesFromWeights } from '../ir/index.js'
import { collectTerms } from './terms.js'
import { applyRewrites } from './rewrite.js'
import { resolveTerms, RESOLVE_CODES } from './resolve.js'
import { assignSlots } from './slots.js'
import { applyBudget } from './budget.js'
import { renderPrompt } from './render.js'
import { buildSuppression, dropHeldWeaponClaims, SUPPRESS_CODES } from './suppress.js'
import { extractKeywords } from './keywords.js'
import { COMPOSE_CODES, COMPOSE_SCHEMA_VERSION, composeFromIR, synthesizeRelationTerms } from './compose.js'
import { auditFidelity } from './fidelity.js'
import {
  DESCRIBE_CODES,
  DESCRIBE_SCHEMA_VERSION,
  attachSourceRefs,
  collectDescriptionFacts,
  verifyDescriptionGrounding,
} from './describe.js'
import { buildControlAdvice, controlDiagnostics, delegatePoseTerms, normalizeControlMode } from './control.js'
import { MOSS_CODES, MOSS_NEGATIVE_BASE, MOSS_REGISTER, buildMossNegative, composeMossCaption, verifyCaptionGrounding } from './moss.js'
import {
  MOSS_LAYOUT_SCHEMA_VERSION,
  buildMossLayout,
  validateMossLayout,
} from './moss-layout.js'
import { termRef, buildFactLedger } from '../trace/ledger.js'

/**
 * 用户直接给出的角色名。
 *
 * 角色识别永远是猜：模型认错了会把一张原创图写成某部作品的角色，而且这种
 * 错误读者一眼看不出来。所以我们不做识别，只在用户明说了名字时把它接进
 * 角色槽位——声明是事实，识别是推断。
 *
 * 接受的写法：`dorothy (nikke)`、`dorothy_(nikke)`、`Dorothy`。带逗号的
 * （多人）直接不收：一个槽位塞两个人名会让 tag 语义塌掉。
 */
export function normalizeCharacterHint(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return null
  if (/[,，、]/.test(raw)) return null
  const text = raw.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
  if (text.length === 0 || text.length > 80) return null
  return text
}

export { extractKeywords, KEYWORDS_SCHEMA_VERSION, DEFAULT_KEYWORD_LIMIT } from './keywords.js'
export {
  COMPOSE_CODES,
  COMPOSE_SCHEMA_VERSION,
  FUNCTION_WORDS,
  MAX_COMPOUNDS,
  RELATION_COMPOUNDS,
  composeClauses,
  composeFromIR,
  renderClauseText,
  synthesizeRelationTerms,
  verifyGrounding,
} from './compose.js'

export { collectTerms, looksLikeTag, toDescriptionText, makeTerm, TERM_ORIGINS, MAX_TAG_WORDS, isScoreTag } from './terms.js'
export { applyRewrites, ACTIVE_REWRITE_SOURCES, REWRITE_CODES } from './rewrite.js'
export { resolveTerms, RESOLVE_CODES } from './resolve.js'
export { assignSlots, effectiveSlotOrder, SLOT_CODES } from './slots.js'
export { applyBudget, BUDGET_CODES } from './budget.js'
export { renderPrompt, RENDER_CODES } from './render.js'
export {
  buildSuppression,
  countPersons,
  SCENE_SUPPRESSION_RULES,
  STRUCTURAL_ERROR_TERMS,
  SUPPRESS_CODES,
} from './suppress.js'
export { formatTag, applyWordStyle } from './style.js'
export {
  MOSS_CODES,
  MOSS_NEGATIVE_BASE,
  MOSS_REGISTER,
  MOSS_SCHEMA_VERSION,
  MOSS_CAPTION_LANGUAGES,
  buildMossNegative,
  composeMossCaption,
  verifyCaptionGrounding,
} from './moss.js'
export {
  MOSS_LAYOUT_SCHEMA_VERSION,
  MOSS_LAYOUT_CODES,
  MOSS_BBOX_COORD_SPACES,
  MOSS_BBOX_FORMATS,
  buildMossLayout,
  validateMossLayout,
  serializeMossLayout,
  toPixelBox,
  toModelBox,
} from './moss-layout.js'
export {
  auditFidelity,
  FIDELITY_CODES,
  FIDELITY_SCHEMA_VERSION,
  FIDELITY_STATUS,
  CHANNEL_KEYS,
  CHANNEL_STATUS,
  METRIC_KIND,
} from './fidelity.js'

export const COMPILE_CODES = Object.freeze({
  NO_TERMS: 'COMPILE_NO_TERMS',
})

export const COMPILE_SCHEMA_VERSION = '2.0'

function termText(term) {
  return String(term?.display ?? term?.text ?? term?.description ?? '').trim()
}

function specReason(reason) {
  if (reason === 'budget') return 'budget'
  if (reason === 'forbidden' || reason === 'excluded_category') return 'forbidden'
  // 评级被档案的 rating_emit 挡下，是策略选择，不是观察和别的标签撞车。
  if (reason === 'rating_suppressed') return 'rating_suppressed'
  // 否定式观察不是"和别的标签撞车"，是主动剔除，单独归类便于分诊。
  if (reason === 'negated') return 'negated'
  // 超长观察是一句话，不是标签：它进不了标签流，但会进自然语言版。
  // 混进 conflict 会让人以为"撞车了"，实际是"它本来就不该是标签"。
  if (reason === 'description') return 'description'
  // 元标签桶（bad_tag / useless_tags）本来就不该进正向，与撞车无关。
  if (reason === 'meta_tag') return 'meta_tag'
  return 'conflict'
}

export async function compilePrompt({
  ir,
  profile = {},
  preset = {},
  kb = null,
  includeNegative = true,
  detailLevel = null,
  character = null,
  poseControl = null,
  signal = null,
  // 证据层之前的 IR 快照。只用于台账里"这条观察在证据层被改写了吗"，
  // 不参与编译：传 null 就如实记成 unavailable，不假装完整。
  irBeforeEvidence = null,
  // 局部复核报过的缺席断言（`applyLocalReview` 返回的 `crop_local`）。
  // 它们不进提示词，但要进台账：不然"阶段 B 说过这里没有剑、我们没采纳"
  // 和"阶段 B 什么都没说"在记录里一模一样。
  localAbsences = [],
  // 可选 JSON Layout（只有 caption 档案用得上）。null / false = 不要。
  // 传对象时读 coord_space / bbox_format / canvas_width / canvas_height / max_elements。
  // Layout 是同一份 IR 的另一种排布，不是第二个档案，也不是第二次视觉分析。
  layout = null,
} = {}) {
  const diagnostics = []

  // 姿势归属：默认提示词负责。用户明说要接骨架/控制网时才让位，并把建议一并给出。
  const controlRequest = normalizeControlMode(poseControl)
  const controlAdvice = buildControlAdvice({ ir, mode: controlRequest.mode, profile })
  diagnostics.push(...controlDiagnostics({ ...controlRequest, advice: controlAdvice }))

  const priorityOverrides = importanceOverridesFromWeights(preset?.analysis_weights)
  const collected = collectTerms(ir, { priorityOverrides })

  // 先有标签，再有"带关系的标签"：把 holding / wearing 这类关系压成复合标签。
  const compounds = synthesizeRelationTerms(ir, { terms: collected.terms })
  if (compounds.terms.length > 0) {
    diagnostics.push(
      diagnostic({
        error_code: COMPOSE_CODES.SYNTHESIZED_COMPOUND,
        severity: SEVERITY.INFO,
        message: `把 ${compounds.terms.length} 条实体关系合成了复合标签：${compounds.terms.map((term) => term.text).join(', ')}`,
        suggested_fix: '这些词按目标模型词表约定拼写；若知识库显示目标词表没有该复合格，档案层可以关掉关系合成。',
      }),
    )
  }
  const unusable = compounds.skipped.filter((entry) => entry.reason === 'unusable_object_label')
  if (unusable.length > 0) {
    diagnostics.push(
      diagnostic({
        error_code: COMPOSE_CODES.RELATION_NOT_COMPOSED,
        severity: SEVERITY.INFO,
        message: `${unusable.length} 条关系没有合成标签：关系另一端没有可用的 1–2 词标签。`,
        suggested_fix: '给实体补一个可检索的短 label（例如 umbrella），关系就能参与合成。',
      }),
    )
  }

  if (collected.negated.length > 0) {
    const sample = collected.negated.slice(0, 4).map((entry) => entry.value).join(' / ')
    diagnostics.push(
      diagnostic({
        error_code: COMPOSE_CODES.NEGATED_OBSERVATION_DROPPED,
        severity: SEVERITY.INFO,
        message: `剔除 ${collected.negated.length} 条否定式观察，未写入正向词（${sample}）。正向提示词只能表达"有什么"，写"没有 X"反而会召唤 X。`,
        suggested_fix: '这是期望行为。若某个"没有 X"对画面很关键，把它写成肯定式（例如 clear air / plain background / silhouette）。',
      }),
    )
  }

  const rewritten = applyRewrites([...collected.terms, ...compounds.terms], profile)
  diagnostics.push(...rewritten.diagnostics)

  const resolved = await resolveTerms(rewritten.terms, { kb, profile, signal })
  diagnostics.push(...resolved.diagnostics)

  // 每条丢弃记录都带 ref 与 stage：ref 是这条观察在 IR 里的身份，stage 是它消失的那一步。
  // 少了这两个字段，对账就只能拿原话去最终文本里找词——那是猜测，不是记录。
  const dropped = collected.negated.map((entry) => ({
    term: entry.value,
    reason: 'negated',
    stage: 'collect',
    ref: entry.ref ?? null,
  }))
  // 别名表：观察原话 → 归一后的词。还原分对账要用它，否则被改名的标签会被算成丢失。
  const aliases = []
  for (const term of resolved.terms) {
    if (!term?.alias_from || !term?.text || term.alias_from === term.text) continue
    aliases.push({ from: term.alias_from, to: term.text })
  }
  const candidates = []
  for (const term of resolved.terms) {
    if (term.dropped) {
      dropped.push({ term: termText(term), reason: specReason(term.dropped), stage: 'resolve', ref: termRef(term) })
      continue
    }
    candidates.push(term)
  }

  // 角色名只由用户声明，不由视觉模型识别（见 normalizeCharacterHint 注释）。
  const characterTag = normalizeCharacterHint(character)
  const usable = characterTag
    ? [
        {
          text: characterTag,
          category: 'character',
          importance: 0.8,
          confidence: 1,
          weight: null,
          source: 'user',
        },
        ...candidates.filter((term) => term?.category !== 'character'),
      ]
    : candidates
  if (characterTag) {
    diagnostics.push(
      diagnostic({
        error_code: COMPOSE_CODES.CHARACTER_INJECTED,
        severity: SEVERITY.INFO,
        message: `已把你给出的角色名 ${characterTag} 写进角色槽位。`,
        suggested_fix: '这是显式声明，不是识别：不给角色名就不会写，也不做任何猜测。',
      }),
    )
  }

  // 佩在身上的武器不能在正向里被写成"握着"：负向压制挡的是模型自己的先验，
  // 挡不住正向里已经写出来的那句 holding。两版都要清，否则描述版还留着握手。
  const heldWeapon = dropHeldWeaponClaims(usable, ir)
  if (heldWeapon.dropped.length > 0) {
    diagnostics.push(
      diagnostic({
        error_code: SUPPRESS_CODES.POSITIVE_CONTRADICTION_DROPPED,
        severity: SEVERITY.INFO,
        message: `武器是佩挂而非手持，已从正向词里删掉 ${heldWeapon.dropped.length} 条"握着武器"的写法（${heldWeapon.dropped.map((term) => term.text).join(' / ')}）。`,
        suggested_fix: '这是期望行为。原图真的是握剑时，IR 里那条关系会是 holding，这段就不会触发。',
      }),
    )
  }
  const positiveTerms = heldWeapon.terms

  // 标签版只收"长得像标签"的观察：词表认得的短标签，或 1–3 词的短语。
  // 半句话（`arm outstretched toward viewer`）留给描述版——它进 tag 只会摊薄别的词。
  const tagTerms = positiveTerms.filter((term) => term?.excluded_from_tags !== true)
  const vocabularyExcluded = positiveTerms.length - tagTerms.length
  if (vocabularyExcluded > 0) {
    const sample = positiveTerms
      .filter((term) => term?.excluded_from_tags === true)
      .slice(0, 3)
      .map((term) => term.text)
      .join(' / ')
    diagnostics.push(
      diagnostic({
        error_code: RESOLVE_CODES.TAG_ONLY_EXCLUDED,
        severity: SEVERITY.INFO,
        message: `标签版只收短标签：${vocabularyExcluded} 条带介词的半句话已移到描述版（${sample}…）。`,
        suggested_fix: '这是期望行为：句子碎片进 tag 只会摊薄真标签词的权重，描述版里它们用完整句子表达。',
      }),
    )
  }

  // 交给控制网之后，姿态词不再进标签版：骨架已经在管这件事，词只会跟它抢。
  // 描述版照旧收着——那是给人看的回查依据，不是给模型的指令。
  const delegated = delegatePoseTerms(tagTerms, controlAdvice?.mode ?? null)

  const assigned = assignSlots(delegated.terms, profile)
  diagnostics.push(...assigned.diagnostics)
  for (const entry of assigned.dropped) dropped.push({ term: termText(entry.term), reason: specReason(entry.reason), stage: 'slot', ref: termRef(entry.term) })

  const budgeted = applyBudget({ slots: assigned.slots, profile, preset })
  diagnostics.push(...budgeted.diagnostics)
  for (const entry of budgeted.dropped) dropped.push({ term: termText(entry.term), reason: specReason(entry.reason), stage: 'budget', ref: termRef(entry.term) })

  const rendered = renderPrompt({ slots: budgeted.slots, profile })
  diagnostics.push(...(rendered.diagnostics ?? []))

  const allPositiveTerms = rendered.segments.flatMap((segment) => segment.terms)
  // caption 档案（MOSS-Image）的负向要等 Caption 出来才能定：它得知道正文里已经写了什么，
  // 才能把自相矛盾的负向词让开。所以这类档案先跳过 buildSuppression，末尾单独编。
  const wordStyle = profile?.tag_standard?.word_style
  const captionMode = wordStyle === 'caption'
  const suppression = includeNegative && !captionMode
    ? buildSuppression({ ir, profile, positiveTerms: allPositiveTerms })
    : { terms: [], diagnostics: [], stats: {} }
  diagnostics.push(...suppression.diagnostics)
  let negativePrompt = suppression.terms.map((term) => term.text).join(', ')

  if (rendered.positive === '') {
    diagnostics.push(
      diagnostic({
        error_code: COMPILE_CODES.NO_TERMS,
        severity: SEVERITY.WARNING,
        message: '正向提示词是空的：IR 里没有可用的观察，或者全部被裁掉了。',
        suggested_fix: '检查视觉分析结果与档案的槽位/预算配置。',
      }),
    )
  }

  const qualitySegment = rendered.segments.find((segment) => segment.slot === 'quality')

  // renderPrompt 只留下渲染后的字符串，关键词排序需要原始 term 元数据，所以在这里建索引。
  const termIndex = new Map()
  for (const entry of budgeted.slots ?? []) {
    const terms = Array.isArray(entry) ? entry[1] : entry?.terms
    for (const term of Array.isArray(terms) ? terms : []) {
      if (typeof term?.text !== 'string' || !term.text.trim()) continue
      termIndex.set(term.text.trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' '), term)
    }
  }
  const keywords = extractKeywords(rendered.segments, {
    limit: preset?.keyword_limit ?? undefined,
    termIndex,
  })

  // 超过标签长度上限的观察不是标签，是句子材料：它们进不了正向标签流（会被
  // assignSlots 当 description 丢掉），但自然语言版/混合版缺了它们就没了动作与介质。
  // 两种观察进不了正向标签流，但描述版缺了它们就没了动作与介质：
  //   1) 超过标签长度上限的长句（term.description）
  //   2) 词表里没有、被刻意摘出标签版的观察（term.excluded_from_tags）
  // 标签版求"模型认得"，描述版求"说得清楚"，两者的收录标准不一样。
  const descriptionTerms = positiveTerms.filter((term) => term?.description || term?.excluded_from_tags === true)

  // IR 事实这一层三种写法都要用：候选描述版拿它当唯一输入，caption 档案拿它写完整
  // 描述，台账拿它对齐来源。所以它无条件计算。
  const described = collectDescriptionFacts(ir)
  for (const item of described.diagnostics) diagnostics.push(item)

  // 冻结基线：描述版仍按原来的 leftovers 通道生成，输出与改动前逐字一致。
  // 下面另起一条从 IR 事实直接取内容的候选通道，两者并存，默认不被替换。
  //
  // caption 档案两条都不要：它自己从 IR 事实按语义顺序写完整描述，成分句算完就被
  // 丢掉。这里直接不算——省掉一次全量分句，trace 里也不再留一份没人读的文本。
  const composed = captionMode
    ? null
    : composeFromIR({
        ir,
        profile,
        terms: positiveTerms,
        slots: budgeted.slots,
        segments: rendered.segments,
        extras: descriptionTerms,
      })

  // 候选描述版：输入换成 IR 事实（features / entities / relations），取舍依据是
  // 观察本身的不确定性、重复、矛盾与表达预算，**不看词库命中**。
  // 这里刻意不传 slots / segments：它们是标签版的产物，一进来候选版就会跟着词库状态漂。
  // 传空之后候选版只有一条输入源——IR 事实，于是同一份 IR 在完整词库、缺条目词库、
  // 空库、无词库四种情况下拿到的是同一份文本。
  const descriptionCandidate = captionMode
    ? null
    : composeFromIR({
        ir,
        profile,
        terms: [],
        slots: [],
        segments: [],
        extras: described.facts,
      })
  const candidateClauses = descriptionCandidate
    ? attachSourceRefs(descriptionCandidate.clauses, described.facts)
    : []
  const candidateGrounding = descriptionCandidate
    ? verifyDescriptionGrounding({ text: descriptionCandidate.text, facts: described.facts })
    : { ok: true, basis: 'ir_facts', unsupported: [], checked_words: 0 }
  const baselineClauses = composed ? attachSourceRefs(composed.clauses, described.facts) : []

  if (composed && !composed.grounding.ok) {
    diagnostics.push(
      diagnostic({
        error_code: COMPOSE_CODES.UNGROUNDED_PROSE,
        severity: SEVERITY.WARNING,
        message: `成分句里出现了标签之外的词：${composed.grounding.ungrounded.join(', ')}。这说明拼接模板补了想象。`,
        suggested_fix: '检查 compose.js 的分句模板，内容词必须来自标签本身。',
      }),
    )
  }
  if (!candidateGrounding.ok) {
    // 不再拿"标签词表"当词汇表：描述版写得比词表全属正常。这里只标待验证，不判错。
    diagnostics.push(
      diagnostic({
        error_code: DESCRIBE_CODES.UNMAPPED_KEPT,
        severity: SEVERITY.INFO,
        message: `候选描述版有 ${candidateGrounding.unsupported.length} 个词没有对应的 IR 事实（${candidateGrounding.unsupported.slice(0, 12).join(', ')}），按待验证保留。`,
        suggested_fix: '若这些词确实来自画面，检查对应维度是否漏了观察；否则它们可能是模板补的连接词。',
      }),
    )
  }

  // caption 档案（MOSS-Image）：走 moss.js，把同一批 IR 事实按语义顺序写成一段连贯描述。
  // 注意它吃的是 `described.facts`——和候选描述版同源，所以既没有第二次视觉调用，
  // 也不是把别的档案的成品再翻译一遍：三条通道各自从 IR 编译，彼此不嵌套。
  const caption = captionMode
    ? composeMossCaption({ ir, profile, facts: described.facts, detailLevel, character: characterTag })
    : null
  if (caption) {
    diagnostics.push(...caption.diagnostics)
    const mossNegative = buildMossNegative({
      ir,
      profile,
      includeNegative,
      positiveText: caption.text,
    })
    diagnostics.push(...mossNegative.diagnostics)
    negativePrompt = mossNegative.text
    caption.negative = mossNegative
  }

  // prose 档案（Flux / MJ / GPT-Image 一类）：正稿直接用成分句。标签版仍然留在 slots 里，
  // 既能回查“这句话是从哪些标签来的”，也方便用户切回标签档时直接复用。
  // 两版并列，各自完整：
  //   标签版（positive）只放词表认得的标签——句子混进去会摊薄真标签的权重；
  //   描述版（description）用完整句子，专收动作、介质、关系这类标签表达不了的东西。
  // 以前 hybrid 档案把两者揉成一段，代价是标签被稀释、句子也读不全，已废弃。
  const proseText = composed ? composed.text : ''
  const prosePositive = wordStyle === 'prose' && proseText.length > 0
  const captionPositive = captionMode && (caption?.text.length ?? 0) > 0
  const descriptionText = proseText
  // Caption 档案编不出 Caption 就是失败，不是"退回标签版"。
  // 退回标签等于偷偷换了一个模型写法：用户点的是 MOSS，拿到的却是 Illustrious 的词串，
  // 而提示词本身看不出被换过。宁可交一个空的、带 ERROR 的结果，也不交一个像样的错东西。
  const captionFailed = captionMode && !captionPositive
  const positive = captionMode
    ? captionPositive
      ? caption.text
      : ''
    : prosePositive
      ? descriptionText
      : rendered.positive
  const register = captionMode ? 'caption' : prosePositive ? 'clause' : 'tag'

  // 可选 JSON Layout：只有 caption 档案、只有用户明确要、只有 Caption 本身成功时才编。
  // 失败的 Layout 不替换正稿——Caption 已经是能用的东西，不该被一个可选的附属格式拖坏。
  const layoutRequested = captionPositive && layout !== null && layout !== undefined && layout !== false
  const layoutResult = layoutRequested
    ? buildMossLayout({
        ir,
        profile,
        caption: caption.text,
        canvasWidth: Number.isInteger(layout?.canvas_width) ? layout.canvas_width : null,
        canvasHeight: Number.isInteger(layout?.canvas_height) ? layout.canvas_height : null,
        maxElements: Number.isInteger(layout?.max_elements) ? layout.max_elements : undefined,
        coordSpace: typeof layout?.coord_space === 'string' ? layout.coord_space : 'abs',
        bboxFormat: typeof layout?.bbox_format === 'string' ? layout.bbox_format : 'xyxy',
      })
    : null
  if (layoutResult) diagnostics.push(...layoutResult.diagnostics)
  const layoutPositive = layoutResult?.ok === true && layoutResult.text.length > 0

  const result = {
    schema_version: COMPILE_SCHEMA_VERSION,
    target_profile: profile?.config_id ?? null,
    detail_level: detailLevel ?? preset?.config_id ?? null,
    prompts: {
      // 明确要了 Layout 且 Layout 编出来了，正稿就是那串 JSON；否则仍是 Caption。
      positive: layoutPositive ? layoutResult.text : positive,
      // caption 档案的「描述」就是这段 Caption 本身：它已经是完整描述，
      // 再放一份成分句只会让下游分不清哪一份才是正稿。
      description: captionMode ? (captionPositive ? caption.text : '') : descriptionText,
      negative: negativePrompt,
    },
    register,
    // Layout 的完整产出。null = 这次没要，不是"要了但失败"——后者 ok:false 且有诊断。
    layout: layoutResult
      ? {
          schema_version: MOSS_LAYOUT_SCHEMA_VERSION,
          ok: layoutResult.ok,
          coord_space: layoutResult.layout?.bbox_coord_space ?? null,
          bbox_format: layoutResult.layout?.bbox_format ?? null,
          json: layoutResult.layout,
          text: layoutResult.text,
          validation: layoutResult.layout ? validateMossLayout(layoutResult.layout) : null,
          stats: layoutResult.stats,
        }
      : null,
    // Caption 的完整产出（含依据引用、丢弃事实、语法校验）。标签版仍在 slots 里可回查。
    caption: caption
      ? {
          schema_version: caption.schema_version,
          ok: caption.ok,
          language: caption.language,
          text: caption.text,
          clauses: caption.clauses,
          grounding: caption.grounding,
          facts_used: caption.facts_used,
          facts_dropped: caption.facts_dropped,
          // Caption 一句都写不出来时，最该回答的是"观察都去哪了"。
          // `facts_dropped` 只记"进了池子但没排上"的；被否定式、占位符、
          // 非英文、量测规则挡在池子外面的那些，只有这份计数说得清。
          observation_stats: described.stats,
          stats: caption.stats,
          negative: caption.negative
            ? { text: caption.negative.text, terms: caption.negative.terms, stats: caption.negative.stats }
            : null,
        }
      : null,
    slots: rendered.segments,
    quality_block: qualitySegment ? qualitySegment.terms.slice() : [],
    keywords: keywords.map((row) => row.text),
    keywords_detail: keywords,
    composed,
    // 描述版的另一条通路：直接取 IR 事实，与词库命中无关。
    // 它是候选，不替换 prompts.description —— 冻结基线的输出保持逐字不变。
    description_candidate: descriptionCandidate
      ? {
          schema_version: DESCRIBE_SCHEMA_VERSION,
          text: descriptionCandidate.text,
          clauses: candidateClauses,
          grounding: candidateGrounding,
          facts: described.facts,
          dropped_facts: described.dropped_facts,
          stats: described.stats,
        }
      : null,
    // 基线描述版每句话来自哪些 IR 事实（只记支持关系，不判对错）。
    description_source_refs: baselineClauses.map((clause) => ({
      role: clause.role,
      text: clause.text,
      source_refs: clause.source_refs,
    })),
    // 词库健康状态：可用 / 不可用 / 空库 / 目标数据源缺失 / 查询失败。
    kb_health: resolved.stats?.kb_health ?? null,
    aliases,
    dropped,
    pose_control: controlAdvice,
    diagnostics,
    stats: {
      terms: rendered.segments.reduce((sum, segment) => sum + segment.terms.length, 0),
      slots: rendered.segments.length,
      truncated: budgeted.truncated,
      relation_compounds: compounds.terms.length,
      composed_clauses: composed ? composed.clauses.length : 0,
      composed_ungrounded: composed ? composed.grounding.ungrounded.length : 0,
      vocabulary_excluded: vocabularyExcluded,
      pose_delegated: delegated.removed.length,
      description_chars: descriptionText.length,
      // 来源分类与效果分开记：这些数字只说"写法从哪来"，不是质量分。
      tag_sources: resolved.stats?.tag_sources ?? null,
      lossy_projections: resolved.stats?.lossy_projections ?? 0,
      unmapped: resolved.stats?.unmapped ?? 0,
      description_candidate_chars: descriptionCandidate ? descriptionCandidate.text.length : null,
      description_candidate_facts: described.facts.length,
      description_candidate_unsupported: candidateGrounding.unsupported.length,
      // Caption 通道的规模与依据缺口。没有 caption 档案时是 null，不是 0——
      // 0 会被读成"编了但一个字都没写出来"。
      caption_chars: caption ? caption.text.length : null,
      caption_ok: captionMode ? !captionFailed : null,
      caption_sentences: caption ? caption.stats.sentences : null,
      caption_facts_used: caption ? caption.stats.used : null,
      caption_facts_dropped: caption ? caption.stats.dropped : null,
      caption_unsupported: caption ? caption.grounding.unsupported.length : null,
      caption_negative_terms: caption?.negative ? caption.negative.stats.terms : null,
      // Layout 同理：没要就是 null。要了但失败有 ok:false，不能和"没要"混成同一个值。
      layout_items: layoutResult?.layout ? layoutResult.stats.items : null,
      layout_objects: layoutResult?.layout ? layoutResult.stats.objects : null,
      layout_texts: layoutResult?.layout ? layoutResult.stats.texts : null,
      layout_skipped: layoutResult ? layoutResult.stats.skipped : null,
    },
  }
  // 事实台账：每条观察从 IR 一路走到哪个通道。join 全按身份（category + key + entity_id），
  // 不靠拿原话去最终文本里找词。它回答的是"在哪一步没的"，不是"看起来像不像还在"。
  result.fact_ledger = buildFactLedger({
    ir,
    irBeforeEvidence,
    compiled: { ...result, all_terms: termRecords(positiveTerms) },
    collected,
    relationSkips: compounds.skipped,
    localAbsences,
  })

  // 还原校验放在最后：它要看台账才知道"没有丢失记录"这句话能不能说。
  result.fidelity = auditFidelity({ ir, compiled: result, ledger: result.fact_ledger })

  return result
}

/** 台账用的词条身份清单。只留 join 需要的字段，不把整个 term 塞进去。 */
function termRecords(terms) {
  return (Array.isArray(terms) ? terms : []).map((term) => ({
    text: term?.text ?? '',
    origin: term?.origin ?? null,
    category: String(term?.category ?? ''),
    key: term?.key ?? null,
    entity_id: term?.entity_id ?? null,
    // 同一 category.key 的第几条。三条 background.backdrop 只有第 0 条不带后缀，
    // 这里不传，另外两条在台账里就永远对不上自己的身份。
    occurrence: Number.isInteger(term?.occurrence) && term.occurrence > 0 ? term.occurrence : 0,
    // 带介词的半句话按规则不进标签版。这条理由要跟着词条走，否则台账只能
    // 报"不在标签版"，报不出"为什么不在"——那还是得靠人去翻代码。
    excluded_from_tags: term?.excluded_from_tags === true,
  }))
}
