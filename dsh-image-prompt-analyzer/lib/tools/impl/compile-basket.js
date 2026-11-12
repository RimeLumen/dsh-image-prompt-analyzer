import { SEVERITY, TASK_STATUS, diagnostic, envelope } from '../../diagnostics.js'
import { compilePrompt } from '../../compile/index.js'
import { normalizeBasket, basketToIr, BASKET_CODES, BASKET_MAX_TERMS } from '../../compile/basket.js'
import { findTagByZh } from '../../kb/index.js'
import { acquireKnowledgeBase, resolveAnalysisContext } from '../../pipeline/context.js'

const BASKET_TOOL_CODES = Object.freeze({
  TAGS_REQUIRED: 'COMPILE_BASKET_TAGS_REQUIRED',
  PROFILE_REQUIRED: 'COMPILE_BASKET_PROFILE_REQUIRED',
  DIAGNOSTICS_TRUNCATED: 'COMPILE_BASKET_DIAGNOSTICS_TRUNCATED',
  CAPTION_NEEDS_FACTS: 'COMPILE_BASKET_CAPTION_NEEDS_FACTS',
})

const MAX_DIAGNOSTICS = 30

function compactDropped(dropped) {
  return (Array.isArray(dropped) ? dropped : []).slice(0, 40).map((item) => ({
    text: item.text ?? item.value ?? null,
    reason: item.reason ?? null,
    slot: item.slot ?? null,
  }))
}

function termStatus(results) {
  return results.map((result) => ({
    text: result.query,
    normalized: result.normalized,
    status: result.status,
    source: result.source ?? null,
    source_id: result.source_id ?? null,
    via_alias: result.via_alias === true,
    canonical_name: result.tag?.canonical_name ?? null,
    zh_name: result.tag?.zh_name ?? null,
    deprecated: result.tag ? Number(result.tag.deprecated ?? 0) === 1 : null,
  }))
}

/**
 * 把词篮里的词换成词表里的英文标签名。
 *
 * 词篮是用户亲手写的，所以这里跟"分析结果"走两套规矩：分析时工作室命中只当线索
 * （编译器不认它，输出一个字都不变），但用户自己敲了「女仆」，他要的就是 `maid`。
 * 所以只要查得到，就把中文换成英文名再进编译——否则中文会原样写进正向提示词，
 * 那不是"补充词典"，那是把词库当摆设。
 *
 * 换名只看是否命中：模型词表命中换，补充词典命中且开了 fallback 也换（任务层已按开关过滤）。
 * 换不动的保持原样，由编译链路照常报 miss。
 */
function normalizeEntries(entries, results, { handle = null, kb = null } = {}) {
  const byText = new Map()
  for (const result of results) {
    if (result.status !== 'hit' || !result.tag) continue
    byText.set(result.query, result.tag)
  }

  // 任务层只查英文名与别名，不查中文名——中文名不是标签身份。
  // 但词篮是用户拿中文写的，所以这里补一次按中文名的精确匹配。
  // 开关照旧：fallback 关着就只允许模型词表（那两份 CSV 没有中文名，等于不生效）。
  const zhSourceIds = kb?.studioFallback
    ? [...(kb.localSourceIds ?? []), ...(kb.studioSourceIds ?? [])]
    : [...(kb?.localSourceIds ?? [])]

  const renamed = []
  for (const entry of entries) {
    let name = byText.get(entry.text)?.name ?? null
    if (!name && handle && zhSourceIds.length > 0) {
      const byZh = findTagByZh(handle, entry.text, { sourceIds: zhSourceIds })
      if (byZh) name = byZh.name
    }
    if (typeof name === 'string' && name !== '' && name !== entry.text) {
      renamed.push({ text: name, category: entry.category, from: entry.text })
    } else {
      renamed.push({ text: entry.text, category: entry.category, from: null })
    }
  }
  return renamed
}

export async function runCompileBasket(runtime, args = {}) {
  const diagnostics = []
  const basket = normalizeBasket(args.tags)

  if (basket.entries.length === 0) {
    return envelope({
      status: TASK_STATUS.FAILED,
      diagnostics: [
        diagnostic({
          error_code: BASKET_TOOL_CODES.TAGS_REQUIRED,
          severity: SEVERITY.ERROR,
          field_path: '/tags',
          message: '词篮是空的。',
          suggested_fix: `传一个标签数组，最多 ${BASKET_MAX_TERMS} 条，例如 ["1girl","long_hair","maid"]。`,
        }),
      ],
    })
  }

  const context = await resolveAnalysisContext(runtime, args, diagnostics)
  if (!context) {
    diagnostics.push(
      diagnostic({
        error_code: BASKET_TOOL_CODES.PROFILE_REQUIRED,
        severity: SEVERITY.ERROR,
        field_path: '/target_profile',
        message: '没有解析出目标模型档案。',
        suggested_fix: '显式传 target_profile（illustrious / anima / moss），或在插件配置里设默认档案。',
      }),
    )
    return envelope({ status: TASK_STATUS.FAILED, diagnostics })
  }

  if (basket.dropped.length > 0) {
    diagnostics.push(
      diagnostic({
        error_code: BASKET_CODES.DROPPED,
        severity: SEVERITY.INFO,
        field_path: '/tags',
        message: `词篮里有 ${basket.dropped.length} 条被丢弃（空词或重复）。`,
        suggested_fix: '重复的词只保留一条；空字符串不会进提示词。',
      }),
    )
  }
  if (basket.truncated) {
    diagnostics.push(
      diagnostic({
        error_code: BASKET_CODES.TOO_MANY,
        severity: SEVERITY.WARNING,
        field_path: '/tags',
        message: `词篮超过 ${BASKET_MAX_TERMS} 条，只取前 ${basket.entries.length} 条。`,
        suggested_fix: '分批编译，或先删掉明显重复与近义的词。',
      }),
    )
  }

  const knowledge = await acquireKnowledgeBase(runtime)
  diagnostics.push(...knowledge.diagnostics)

  // 中文名查询要直接摸句柄（任务层只认英文名与别名）。取不到就算了：
  // 那意味着库打不开，编译照样能跑，只是中文词换不成英文。
  let handle = null
  if (knowledge.kb) {
    try {
      handle = (await runtime.getKnowledgeBase())?.handle ?? null
    } catch {
      handle = null
    }
  }

  let terms = []
  let entries = basket.entries
  if (knowledge.kb) {
    const task = knowledge.kb.beginTask({ signal: args.signal ?? null })
    const results = await task.lookupMany(basket.entries.map((entry) => entry.text))
    terms = termStatus(results)
    entries = normalizeEntries(basket.entries, results, { handle, kb: knowledge.kb })
    // 用户敲的和最终写进提示词的可能不是一个词：两条都留着，否则
    // 「女仆 → miss」会让人以为这个词没进提示词，实际它是以 maid 进去的。
    const emitted = new Map(entries.filter((entry) => entry.from !== null).map((entry) => [entry.from, entry.text]))
    terms = terms.map((term) => ({ ...term, emitted: emitted.get(term.text) ?? term.text }))
  }

  const ir = basketToIr(entries)
  const compiled = await compilePrompt({
    ir,
    profile: context.profileRequest.profile,
    preset: context.presetResult.entry.config,
    kb: knowledge.kb,
    includeNegative: args.include_negative !== false,
    detailLevel: args.detail_level ?? null,
    character: args.character ?? null,
    poseControl: args.pose_control ?? null,
  })

  // 编译链路的诊断可能几十条；这里截断，但明确写出截了多少条，
  // 免得读的人以为"就这么几条"。
  const allDiagnostics = [...diagnostics, ...compiled.diagnostics]

  // Caption 档案不吃标签流：词篮里只有标签名，没有「主体在做什么、画面怎么摆」这类
  // 自然语言事实，所以 MOSS 必然报 CAPTION_EMPTY。编译层那句话是给图片反推写的
  // （"检查视觉分析是否产出了主体…"），在这里会把人往错的方向带，所以补一句工具层的。
  if (
    compiled.register === 'caption' &&
    allDiagnostics.some((item) => item.error_code === 'COMPILE_MOSS_CAPTION_EMPTY')
  ) {
    allDiagnostics.push(
      diagnostic({
        error_code: BASKET_TOOL_CODES.CAPTION_NEEDS_FACTS,
        severity: SEVERITY.INFO,
        field_path: '/tags',
        message: `词篮是标签流，${context.profileRequest.profile.config_id} 是 Caption 档案：没有自然语言事实可写，所以编不出 Caption。`,
        suggested_fix: '换用标签流档案（illustrious / anima）编译词篮；要 MOSS 的 Caption，用 analyze_image_prompt 反推一张图，Caption 由视觉分析的事实写出来。',
      }),
    )
  }

  const kept = allDiagnostics.slice(0, MAX_DIAGNOSTICS)
  const omitted = allDiagnostics.length - kept.length
  if (omitted > 0) {
    kept.push(
      diagnostic({
        error_code: BASKET_TOOL_CODES.DIAGNOSTICS_TRUNCATED,
        severity: SEVERITY.INFO,
        message: `另有 ${omitted} 条编译诊断未列出。`,
        suggested_fix: '要逐条追查，用 analyze_image_prompt 的 trace 或 scripts/inspect-prompt.mjs。',
      }),
    )
  }

  return envelope({
    diagnostics: kept,
    active_configs: {
      model_profile: { config_id: context.profileRequest.profile.config_id },
      preset: { config_id: context.presetResult.entry.config_id },
    },
    extra: {
      target_profile: context.profileRequest.profile.config_id,
      word_style: context.profileRequest.profile.tag_standard?.word_style ?? null,
      register: compiled.register,
      positive: compiled.prompts.positive,
      negative: compiled.prompts.negative,
      description: compiled.prompts.description,
      slots: (compiled.slots ?? []).map((segment) => ({ slot: segment.slot, terms: segment.terms })),
      dropped: compactDropped(compiled.dropped),
      terms,
      aliases: compiled.aliases ?? [],
      kb_health: compiled.kb_health ?? null,
      basket: {
        requested: Array.isArray(args.tags) ? args.tags.length : 0,
        accepted: basket.entries.length,
        dropped: basket.dropped,
        truncated: basket.truncated,
        // 中文换成英文名的那几条：用户敲的是「女仆」，进提示词的是 maid。
        // 列出来是为了让人一眼看出提示词里的词不是自己写的那几个。
        renamed: entries.filter((entry) => entry.from !== null).map((entry) => ({ from: entry.from, to: entry.text })),
      },
      stats: {
        terms: compiled.stats?.terms ?? 0,
        slots: compiled.stats?.slots ?? 0,
        truncated: compiled.stats?.truncated ?? false,
        unmapped: compiled.stats?.unmapped ?? 0,
        lossy_projections: compiled.stats?.lossy_projections ?? 0,
      },
    },
  })
}
