
import { PLUGIN_VERSION } from '../version.js'
import { SEVERITY, diagnostic, envelope, topStackFrame } from '../diagnostics.js'
import { IR_SCHEMA_VERSION } from '../ir/index.js'
import { analyzeVision } from '../vision/index.js'
import { compilePrompt } from '../compile/index.js'
import { EXPERIENCE_CODES } from '../experience/index.js'
import { PIPELINE_CODES } from './codes.js'
import { activeTargets } from './context.js'

export async function prepareInputStage(runtime, { imagePath, taskId, diagnostics }) {
  const preparer = await runtime.getPreparer()
  let prepared
  try {
    prepared = await preparer.prepare({ imagePath, taskLabel: taskId })
  } catch (error) {
    diagnostics.push(
      typeof error?.toDiagnostic === 'function'
        ? error.toDiagnostic()
        : diagnostic({
            error_code: error?.code ?? PIPELINE_CODES.IMAGE_PREPARE_FAILED,
            severity: SEVERITY.ERROR,
            message: `图片准备失败：${error?.message ?? error}`,
            suggested_fix: '确认路径存在、格式受支持、文件未损坏。',
          }),
    )
    return null
  }
  for (const warning of prepared.warnings) {
    diagnostics.push(
      diagnostic({
        error_code: PIPELINE_CODES.IMAGE_PREPARE_WARNING,
        severity: SEVERITY.WARNING,
        message: String(warning),
        suggested_fix: '这一步不影响本次分析：能用的部分已经照常产出。若想看到完整效果，换一张尺寸与框选更规整的图，或不要在这个阶段传裁剪区。',
      }),
    )
  }
  return prepared
}

export async function runVisionStage({
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
}) {
  const logger = runtime.logger
  const provenance = {
    task_id: taskId,
    plugin_version: PLUGIN_VERSION,
    model_profile: profileRequest.profile.config_id,
    model_profile_variant: profileRequest.variant,
    preset: presetResult.entry.config_id,
    knowledge_base: snapshot.knowledgeBase?.config_id ?? null,
    ir_schema_version: IR_SCHEMA_VERSION,
  }

  try {
    const visionConfig = { ...runtime.pluginConfig.vision }
    if (typeof args?.vision_provider === 'string' && args.vision_provider.trim()) {
      visionConfig.provider = args.vision_provider
    }
    if (typeof args?.vision_model === 'string' && args.vision_model.trim()) {
      visionConfig.model = args.vision_model
    }
    const onDelta =
      typeof args?.progress_key === 'string' && args.progress_key.trim() && runtime.progress
        ? (kind, text) => runtime.progress.push(args.progress_key, text)
        : null
    const analysis = await analyzeVision({
      backend,
      preparer,
      prepared,
      visionConfig,
      provenance,
      locale: 'zh',
      signal: args.signal ?? null,
      logger,
      onDelta,
    })
    diagnostics.push(...analysis.diagnostics)
    return analysis
  } catch (error) {
    const frame = topStackFrame(error)
    const target = error?.vision_target
    const usedModel =
      target?.provider && target?.model ? `（实际使用的模型：${target.provider}/${target.model}）` : ''
    diagnostics.push(
      typeof error?.toDiagnostic === 'function'
        ? error.toDiagnostic()
        : diagnostic({
            error_code: error?.code ?? PIPELINE_CODES.VISION_FAILED,
            severity: SEVERITY.ERROR,
            message: `视觉分析失败：${error?.message ?? error}${usedModel}`,
            suggested_fix: `运行 validate_configs 检查 vision 配置；确认所选模型支持图片输入。${
              frame ? `若以上都正常，这是插件没预期到的错误，出错位置：${frame}。` : ''
            }`,
          }),
    )
    return null
  }
}

export async function compileStage({ runtime, ir, profile, preset, kb, includeNegative, diagnostics }) {
  const compiled = await compilePrompt({
    ir,
    profile,
    preset,
    kb,
    includeNegative,
  })
  diagnostics.push(...compiled.diagnostics)
  return compiled
}

function profileSummary(profile) {
  return {
    config_id: profile?.config_id ?? null,
    display_name: profile?.display_name ?? profile?.config_id ?? null,
    schema_version: profile?.schema_version ?? null,
  }
}

export async function saveExperienceStage({
  runtime,
  taskId,
  prepared,
  ir,
  compiled,
  profile,
  preset,
  snapshot,
  args,
  diagnostics,
}) {
  const requested =
    args.save_experience === true ||
    (args.save_experience === undefined && runtime.pluginConfig?.privacy?.save_experience_default === true)
  if (!requested) return null

  if (typeof runtime.saveExperience !== 'function') {
    diagnostics.push(
      diagnostic({
        error_code: PIPELINE_CODES.EXPERIENCE_NOT_SAVED,
        severity: SEVERITY.WARNING,
        message: '要求保存经验，但经验模块尚未接线，本次没有落盘。',
        suggested_fix: '本次结果仍然有效；等经验模块可用后再保存。',
      }),
    )
    return null
  }

  try {
    const experience = await runtime.saveExperience({
      taskId,
      prepared,
      sourcePath: prepared.sourcePath,
      ir,
      compiled,
      profile,
      preset,
      pluginVersion: PLUGIN_VERSION,
      knowledgeBase: snapshot.knowledgeBase ?? null,
    })
    if (experience?.diagnostics) diagnostics.push(...experience.diagnostics)
    return experience
  } catch (error) {
    diagnostics.push(
      diagnostic({
        error_code: EXPERIENCE_CODES.SAVE_FAILED,
        severity: SEVERITY.WARNING,
        message: `经验保存失败：${error?.message ?? error}`,
        suggested_fix: '分析结果本身有效。检查知识库文件是否可写。',
      }),
    )
    return null
  }
}

export function recordPanelStage({ runtime, taskId, analysis, compiled, profile, knowledge, experience, diagnostics }) {
  if (!runtime.panelStore) return
  try {
    runtime.panelStore.record({
      taskId,
      image: analysis.ir.image,
      target: profileSummary(profile),
      positive: compiled.prompts.positive,
      negative: compiled.prompts.negative,
      qualityPrefix: compiled.quality_block,
      positiveTerms: compiled.slots.flatMap((segment) => segment.terms),
      negativeTerms: compiled.prompts.negative ? compiled.prompts.negative.split(',').map((item) => item.trim()) : [],
      lowConfidence: [],
      dropped: compiled.dropped,
      ir: analysis.ir,
      stats: { ...analysis.stats, compile: compiled.stats },
      knowledgeBaseUsed: knowledge.kb !== null,
      savedExperienceId: experience?.id ?? null,
      warnings: diagnostics.filter((item) => item.severity === SEVERITY.WARNING).map((item) => item.error_code),
    })
  } catch (error) {
    runtime.logger?.warn?.(`写入结果面板失败：${error?.message ?? error}`)
  }
}

export function buildAnalysisEnvelope({
  taskId,
  diagnostics,
  profileRequest,
  presetResult,
  snapshot,
  analysis,
  compiled,
  knowledge,
  experience,
  include_ir = true,
}) {
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
        target_profile: compiled.target_profile,
        detail_level: compiled.detail_level,
        image: analysis.ir.image,
        prompts: compiled.prompts,
        slots: compiled.slots,
        quality_block: compiled.quality_block,
        dropped: compiled.dropped,
        knowledge_base_used: knowledge.kb !== null,
        experience,
        ...(include_ir ? { ir: analysis.ir } : {}),
        stats: { ...analysis.stats, compile: compiled.stats },
      },
    },
  })
}
