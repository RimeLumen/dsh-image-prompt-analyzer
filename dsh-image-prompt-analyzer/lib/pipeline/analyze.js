
import { SEVERITY, diagnostic, newTaskId } from '../diagnostics.js'
import { PIPELINE_CODES } from './codes.js'
import { acquireKnowledgeBase, failedEnvelope, resolveAnalysisContext } from './context.js'
import {
  buildAnalysisEnvelope,
  compileStage,
  prepareInputStage,
  recordPanelStage,
  runVisionStage,
  saveExperienceStage,
  traceStage,
} from './stages.js'

export async function runAnalyzePipeline(runtime, args = {}) {
  const taskId = newTaskId()
  const diagnostics = []
  const logger = runtime.logger

  const imagePath = String(args.image_path ?? '').trim()
  if (imagePath === '') {
    return failedEnvelope(taskId, [
      diagnostic({
        error_code: PIPELINE_CODES.IMAGE_PATH_REQUIRED,
        severity: SEVERITY.ERROR,
        field_path: '/image_path',
        message: '没有给出 image_path。',
        suggested_fix: '传入一张本地图片的路径（PNG / JPG / JPEG / WEBP / BMP）。',
      }),
    ])
  }

  const includeNegative = args.include_negative !== false

  const context = await resolveAnalysisContext(runtime, args, diagnostics)
  if (!context) return failedEnvelope(taskId, diagnostics)
  const { store, profileRequest, presetResult } = context
  const snapshot = await store.inspect()

  const prepared = await prepareInputStage(runtime, { imagePath, taskId, diagnostics })
  if (!prepared) return failedEnvelope(taskId, diagnostics)

  const preparer = await runtime.getPreparer()
  try {
    const knowledge = await acquireKnowledgeBase(runtime)
    diagnostics.push(...knowledge.diagnostics)

    const backend = await runtime.getVisionBackend()
    const analysis = await runVisionStage({
      runtime,
      backend,
      preparer,
      prepared,
      profileRequest,
      presetResult,
      snapshot,
      taskId,
      args,
      diagnostics,
    })
    if (!analysis) return failedEnvelope(taskId, diagnostics)

    const compiled = await compileStage({
      runtime,
      ir: analysis.ir,
      // 证据层之前的 IR 要跟着走：台账靠它判断"这条观察是在证据层被改写的吗"。
      irBeforeEvidence: analysis.ir_before_evidence ?? null,
      profile: profileRequest.profile,
      preset: presetResult.entry.config,
      kb: knowledge.kb,
      includeNegative,
      character: args.character ?? null,
      poseControl: args.pose_control ?? null,
      // 局部复核的缺席断言：不进提示词，但要进台账。
      // 不传的话，"阶段 B 说过这里没有剑、我们没采纳"与"阶段 B 什么都没说"
      // 在事实台账里长得一模一样。
      localAbsences: (analysis.stats?.reviews ?? []).flatMap((review) => review?.crop_local ?? []),
      diagnostics,
    })

    const experience = await saveExperienceStage({
      runtime,
      taskId,
      prepared,
      ir: analysis.ir,
      compiled,
      profile: profileRequest.profile,
      preset: presetResult.entry.config,
      snapshot,
      args,
      diagnostics,
    })

    recordPanelStage({ runtime, taskId, analysis, compiled, profile: profileRequest.profile, knowledge, experience, diagnostics })

    // 留痕放在最后：所有阶段产物此时都已就位，写盘失败不影响本次结果。
    const trace = traceStage({ runtime, taskId, analysis, compiled, profileRequest, presetResult, snapshot, knowledge })

    return buildAnalysisEnvelope({
      taskId,
      diagnostics,
      profileRequest,
      include_ir: args.include_ir !== false,
      presetResult,
      snapshot,
      analysis,
      compiled,
      knowledge,
      experience,
      trace,
    })
  } finally {
    try {
      await preparer.finish(prepared.tempDir)
    } catch (error) {
      logger?.warn?.(`清理临时目录失败：${error?.message ?? error}`)
    }
  }
}
