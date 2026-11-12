
import { SEVERITY, diagnostic, newTaskId } from '../diagnostics.js'
import { PIPELINE_CODES } from './codes.js'
import { acquireKnowledgeBase, failedEnvelope, resolveAnalysisContext } from './context.js'
import { resolveObservationLanguage } from './language.js'
import {
  buildAnalysisEnvelope,
  compileStage,
  prepareInputStage,
  runVisionStage,
  saveExperienceStage,
  traceStage,
} from './stages.js'

/**
 * `layout` 参数的归一化。
 *
 * 三种写法都接受：`true`（用默认格式）、`false`/缺省（不要）、或一个对象。
 * 对象只认白名单五个键——多出来的键不往编译层传，免得它变成一条隐形的第二套配置。
 */
function normalizeLayoutArg(layout) {
  if (layout === true) {
    return { coord_space: 'abs', bbox_format: 'xyxy', canvas_width: null, canvas_height: null, max_elements: null }
  }
  if (!layout || typeof layout !== 'object') return null
  return {
    coord_space: layout.coord_space ?? 'abs',
    bbox_format: layout.bbox_format ?? 'xyxy',
    canvas_width: layout.canvas_width ?? null,
    canvas_height: layout.canvas_height ?? null,
    max_elements: layout.max_elements ?? null,
  }
}

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

  // 语言必须在视觉分析之前定下来：它决定观察值用哪种语言写。
  // 分析完再改，IR 里根本没有那种语言的事实，只能重新分析——所以这里算错一次，
  // 后面每一步都是错的，宁可现在就停下。
  const language = resolveObservationLanguage({
    profile: profileRequest.profile,
    requested: args.caption_language ?? null,
  })
  diagnostics.push(...language.diagnostics)
  if (!language.ok) return failedEnvelope(taskId, diagnostics)

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
      observationLanguage: language.language,
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
      // 可选 JSON Layout：只有 caption 档案 + 用户明确要才生效。
      // 传 true 或对象都行；对象可带 coord_space / bbox_format / canvas_width / canvas_height / max_elements。
      layout: normalizeLayoutArg(args.layout),
      // 与视觉阶段同一个值：编译层据此选模板，也据此判断"这份 IR 出得了这种语言吗"。
      captionLanguage: language.language,
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

    // 留痕放在最后：所有阶段产物此时都已就位，写盘失败不影响本次结果。
    traceStage({ runtime, taskId, analysis, compiled, profileRequest, presetResult, snapshot, knowledge, diagnostics })

    return buildAnalysisEnvelope({
      taskId,
      diagnostics,
      profileRequest,
      include_ir: args.include_ir !== false,
      include_explanations: args.explain_terms === true,
      presetResult,
      snapshot,
      analysis,
      compiled,
      knowledge,
      experience,
    })
  } finally {
    try {
      await preparer.finish(prepared.tempDir)
    } catch (error) {
      logger?.warn?.(`清理临时目录失败：${error?.message ?? error}`)
    }
  }
}
