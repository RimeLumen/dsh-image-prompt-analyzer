import { SEVERITY, diagnostic, envelope, newTaskId } from '../diagnostics.js'
import { PLUGIN_VERSION } from '../version.js'
import { activeTargets, acquireKnowledgeBase, failedEnvelope, resolveAnalysisContext } from './context.js'
import { compileStage, prepareInputStage } from './stages.js'
import { diffPromptTerms, mergeRevisitIR } from '../ir/merge.js'
import { resolveRevisitBoxes, runRevisitVision } from '../vision/revisit.js'
import { REVISIT_CODES } from './codes.js'

/**
 * 二次分析（递进式）。复用已经上传的那张图，不再收一次图片：
 * 只取用户选的框 → 逐块追问 → 把新事实并进旧 IR → 重新编译同一份档案。
 */
export async function runRevisitPipeline(runtime, args = {}) {
  const taskId = String(args.task_id ?? '').trim() || newTaskId()
  const diagnostics = []
  const logger = runtime.logger

  const previousIR = args.previous_ir && typeof args.previous_ir === 'object' ? args.previous_ir : null
  if (!previousIR) {
    return failedEnvelope(taskId, [
      diagnostic({
        error_code: REVISIT_CODES.NO_PREVIOUS_IR,
        severity: SEVERITY.ERROR,
        message: '找不到这张图的首次分析结果，无法做二次分析。',
        suggested_fix: '先正常分析一次，再从结果卡片里选择二次分析方式；面板只保留本次运行期的结果。',
      }),
    ])
  }

  const mode = String(args.mode ?? '').trim()
  const boxes = resolveRevisitBoxes({ mode, boxes: args.boxes })
  if (boxes.length === 0) {
    return failedEnvelope(taskId, [
      diagnostic({
        error_code: REVISIT_CODES.NO_BOXES,
        severity: SEVERITY.ERROR,
        field_path: '/boxes',
        message: '没有可用的复核区域。',
        suggested_fix: '4/9 宫格会自动切块；自由框选至少要画一个不小于画面 4%×4% 的框。',
      }),
    ])
  }

  const imagePath = String(args.image_path ?? '').trim()
  if (imagePath === '') {
    return failedEnvelope(taskId, [
      diagnostic({
        error_code: REVISIT_CODES.IMAGE_PATH_REQUIRED,
        severity: SEVERITY.ERROR,
        field_path: '/image_path',
        message: '二次分析需要原始图片路径（面板会从首次分析自动带上）。',
        suggested_fix: '在结果卡片里点二次分析，不要从命令行手拼请求。',
      }),
    ])
  }

  const context = await resolveAnalysisContext(runtime, args, diagnostics)
  if (!context) return failedEnvelope(taskId, diagnostics)
  const { profileRequest, presetResult } = context
  const snapshot = await context.store.inspect()

  const prepared = await prepareInputStage(runtime, { imagePath, taskId, diagnostics })
  if (!prepared) return failedEnvelope(taskId, diagnostics)

  const preparer = await runtime.getPreparer()
  try {
    const knowledge = await acquireKnowledgeBase(runtime)
    diagnostics.push(...knowledge.diagnostics)

    const backend = await runtime.getVisionBackend()
    const visionConfig = runtime.pluginConfig?.vision ?? {}
    const revisit = await runRevisitVision({
      prepared,
      preparer,
      backend,
      boxes,
      previousPrompt: String(args.previous_prompt ?? ''),
      previousSummary: String(previousIR?.scene?.summary ?? ''),
      visionConfig,
      logger,
      diagnostics,
      onProgress:
        typeof args.progress_key === 'string' && args.progress_key.trim() && runtime.progress
          ? (kind, text) => runtime.progress.push(args.progress_key, text)
          : null,
    })

    if (revisit.observations.length === 0) {
      diagnostics.push(
        diagnostic({
          error_code: REVISIT_CODES.NO_OBSERVATIONS,
          severity: SEVERITY.WARNING,
          message: `二次分析看了 ${boxes.length} 块，但没有得到任何可用观察；原提示词保持不变。`,
          suggested_fix: '换更大的框，或者只在确实有细节的区域框选；整块纯色/纯虚化的区域没有可补的信息。',
        }),
      )
    }

    const { ir, diff } = mergeRevisitIR(previousIR, revisit.observations, { boxes, mode })
    const compiled = await compileStage({
      runtime,
      ir,
      profile: profileRequest.profile,
      preset: presetResult.entry.config,
      kb: knowledge.kb,
      includeNegative: args.include_negative !== false,
      diagnostics,
    })

    const termDiff = diffPromptTerms(
      [...(args.previous_terms ?? [])],
      compiled.slots.flatMap((segment) => segment.terms ?? []),
    )
    diff.terms = termDiff

    const entry = runtime.panelStore?.record?.({
      taskId,
      image: ir.image,
      target: compiled.target_profile,
      positive: compiled.prompts.positive,
      negative: compiled.prompts.negative,
      composed: compiled.composed?.text ?? null,
      qualityPrefix: compiled.quality_block,
      positiveTerms: compiled.slots.flatMap((segment) => segment.terms),
      negativeTerms: compiled.prompts.negative ? compiled.prompts.negative.split(',').map((item) => item.trim()) : [],
      lowConfidence: [],
      dropped: compiled.dropped,
      factLedger: compiled.fact_ledger ?? null,
      ir,
      stats: { compile: compiled.stats },
      knowledgeBaseUsed: knowledge.kb !== null,
      savedExperienceId: null,
      warnings: diagnostics.filter((item) => item.severity === SEVERITY.WARNING).map((item) => item.error_code),
    })
    if (entry) {
      // record() 会重建 entry，原图与档案信息得自己搬过去，否则下一轮二次分析就没图可用了。
      const previousReuse = runtime.panelStore?.get?.(taskId)?.reuse ?? null
      entry.reuse = previousReuse ?? {
        image_path: imagePath,
        target_profile: args.target_profile ?? null,
        detail_level: args.detail_level ?? null,
        include_negative: args.include_negative !== false,
      }
      entry.revisit = { mode, boxes, diff: diff.summary, term_diff: termDiff, stats: revisit.stats }
      entry.positive_prompt_previous = String(args.previous_prompt ?? '') || entry.positive_prompt_previous || null
    }

    return envelope({
      task_id: taskId,
      diagnostics,
      active_configs: {
        knowledge_base: snapshot.knowledgeBase
          ? { config_id: snapshot.knowledgeBase.config_id, schema_version: snapshot.knowledgeBase.schema_version }
          : null,
        ...activeTargets(profileRequest, presetResult),
      },
      extra: {
        result: {
          task_id: taskId,
          plugin_version: PLUGIN_VERSION,
          pass: 'revisit',
          mode,
          boxes,
          target_profile: compiled.target_profile,
          detail_level: compiled.detail_level,
          image: ir.image,
          prompts: compiled.prompts,
          previous_positive: String(args.previous_prompt ?? '') || null,
          composed: compiled.composed ?? null,
          slots: compiled.slots,
          quality_block: compiled.quality_block,
          keywords: compiled.keywords ?? [],
          diff,
          dropped: compiled.dropped,
          knowledge_base_used: knowledge.kb !== null,
          ...(args.include_ir === false ? {} : { ir }),
          stats: { revisit: revisit.stats, compile: compiled.stats },
        },
      },
    })
  } finally {
    try {
      await preparer.finish(prepared.tempDir)
    } catch (error) {
      logger?.warn?.(`清理临时目录失败：${error?.message ?? error}`)
    }
  }
}