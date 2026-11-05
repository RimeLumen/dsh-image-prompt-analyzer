
import { PLUGIN_VERSION } from '../version.js'
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SEVERITY, diagnostic, envelope, topStackFrame } from '../diagnostics.js'
import { IR_SCHEMA_VERSION } from '../ir/index.js'
import { analyzeVision } from '../vision/index.js'
import { COMPILE_SCHEMA_VERSION, auditFidelity, compilePrompt } from '../compile/index.js'
import { EXPERIENCE_CODES } from '../experience/index.js'
import { TRACE_STAGES, TRACE_SCHEMA_VERSION, createStageTrace } from '../trace/stages.js'
import { LEDGER_SCHEMA_VERSION } from '../trace/ledger.js'
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
    const analysis = await analyzeVision({
      backend,
      preparer,
      prepared,
      visionConfig,
      provenance,
      locale: 'zh',
      signal: args.signal ?? null,
      logger,
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

/**
 * 把一次分析的各阶段产物写到 data/traces/<task_id>/ 下。
 *
 * 目的只有一个：让"这条观察在哪一步改变或消失"可以事后查证，而不是靠看成品猜。
 * 抓不到的东西一律走 missing 并写清原因——用空对象冒充 captured 会让下一次分析
 * 以为阶段产物齐全，比没有更糟。
 *
 * 它不参与提示词生成，写盘失败也绝不能把分析搞挂。
 */
export function traceStage({ runtime, taskId, analysis, compiled, profileRequest, presetResult, snapshot, knowledge }) {
  const settings = runtime.pluginConfig?.trace ?? {}
  if (settings.enabled === false) return null
  const baseDir = runtime.dirs?.dataDir
  if (!baseDir) return null

  const trace = createStageTrace({ taskId, enabled: true })

  trace.capture(TRACE_STAGES.VERSION, {
    trace_schema_version: TRACE_SCHEMA_VERSION,
    ledger_schema_version: LEDGER_SCHEMA_VERSION,
    plugin_version: PLUGIN_VERSION,
    ir_schema_version: IR_SCHEMA_VERSION,
    compile_schema_version: COMPILE_SCHEMA_VERSION,
    task_id: taskId,
    captured_at: new Date().toISOString(),
  })

  trace.capture(TRACE_STAGES.CONFIG, {
    target_profile: {
      config_id: profileRequest?.profile?.config_id ?? null,
      display_name: profileRequest?.profile?.display_name ?? null,
      schema_version: profileRequest?.profile?.schema_version ?? null,
      // 提示词写给哪个 checkpoint 决定了一切，但插件不知道它——如实记 null。
      checkpoint: null,
      checkpoint_status: 'unknown',
    },
    preset: {
      config_id: presetResult?.entry?.id ?? presetResult?.entry?.config_id ?? null,
      schema_version: presetResult?.entry?.config?.schema_version ?? null,
      config: presetResult?.entry?.config ?? null,
    },
    knowledge_base: knowledge?.kb
      ? { used: true, config_id: snapshot?.knowledgeBase?.config_id ?? null, schema_version: snapshot?.knowledgeBase?.schema_version ?? null }
      : { used: false, config_id: null, schema_version: null },
    vision: {
      backend: analysis?.ir?.provenance?.vision_backend ?? null,
      provider: analysis?.ir?.provenance?.provider ?? null,
      model: analysis?.ir?.provenance?.model ?? null,
    },
  })

  const raw = Array.isArray(analysis?.raw_responses) ? analysis.raw_responses : []
  const stageARaw = raw.filter((item) => item.stage === 'A')
  const stageBRaw = raw.filter((item) => item.stage === 'B')
  if (stageARaw.length > 0) {
    trace.capture(TRACE_STAGES.STAGE_A_RAW, stageARaw)
  } else {
    trace.missing(TRACE_STAGES.STAGE_A_RAW, '分析没有返回阶段 A 的原始响应（可能是离线重编译，或分析在阶段 A 之前就失败了）。')
  }
  if (stageBRaw.length > 0) {
    trace.capture(TRACE_STAGES.STAGE_B_RAW, stageBRaw)
  } else {
    trace.missing(
      TRACE_STAGES.STAGE_B_RAW,
      Number(analysis?.stats?.reviews_run ?? 0) === 0
        ? '本次没有触发局部复核，因此不存在阶段 B 响应（不是被丢弃）。'
        : '触发了局部复核，但响应没有留下来。',
    )
  }

  if (analysis?.ir_before_evidence) {
    trace.capture(TRACE_STAGES.IR_PRE_EVIDENCE, analysis.ir_before_evidence)
  } else {
    trace.missing(TRACE_STAGES.IR_PRE_EVIDENCE, '证据层之前的 IR 快照没有保留（旧版本代码不产出它）。')
  }
  if (analysis?.ir) {
    trace.capture(TRACE_STAGES.IR_POST_EVIDENCE, analysis.ir)
  } else {
    trace.missing(TRACE_STAGES.IR_POST_EVIDENCE, '没有 IR，分析未完成。')
  }

  if (compiled?.prompts) {
    trace.capture(TRACE_STAGES.PROMPTS, {
      positive: compiled.prompts.positive ?? null,
      description: compiled.prompts.description ?? null,
      negative: compiled.prompts.negative ?? null,
      composed: compiled.composed?.text ?? null,
      description_candidate: compiled.description_candidate?.text ?? null,
    })
  } else {
    trace.missing(TRACE_STAGES.PROMPTS, '编译没有产出提示词。')
  }

  if (compiled?.fact_ledger) {
    trace.capture(TRACE_STAGES.FACT_LEDGER, compiled.fact_ledger)
  } else {
    trace.missing(TRACE_STAGES.FACT_LEDGER, '没有事实台账，无法回答某条观察在哪一步改变或消失。')
  }

  const rootDir = join(baseDir, 'traces')
  const flushed = trace.flush({ rootDir })
  if (flushed) pruneTraces(rootDir, Number(settings.max_tasks ?? 10))
  return flushed ? flushed.summary : null
}

/** 只留最近 N 次留痕，别让 data/traces 无限长大。 */
function pruneTraces(rootDir, maxTasks) {
  try {
    const dirs = readdirSync(rootDir)
      .map((name) => ({ name, path: join(rootDir, name) }))
      .filter((entry) => {
        try {
          return statSync(entry.path).isDirectory()
        } catch {
          return false
        }
      })
      .map((entry) => {
        try {
          return { ...entry, mtime: statSync(entry.path).mtimeMs }
        } catch {
          return { ...entry, mtime: 0 }
        }
      })
      .sort((a, b) => b.mtime - a.mtime)
    for (const stale of dirs.slice(Math.max(1, maxTasks))) {
      try {
        rmSync(stale.path, { recursive: true, force: true })
      } catch {
        // 清不掉就算了：留着旧留痕不影响正确性。
      }
    }
  } catch {
    // 目录都读不了就没有可清理的。
  }
}

export async function compileStage({ runtime, ir, irBeforeEvidence = null, profile, preset, kb, includeNegative, character = null, poseControl = null, localAbsences = [], diagnostics }) {
  const compiled = await compilePrompt({
    ir,
    irBeforeEvidence,
    profile,
    preset,
    kb,
    includeNegative,
    character,
    poseControl,
    // 局部复核的缺席断言跟着进编译：它们不进提示词，只进台账。
    localAbsences,
  })
  diagnostics.push(...compiled.diagnostics)

  // 对账：编译完再回头确认一遍"看到的"有没有真的落进提示词。
  // 这一步不花钱，却能抓住"预算把关键观察挤掉了"这类静默损失。
  //
  // 注意不要在这里重算一遍 fidelity：compilePrompt 已经带着事实台账算过了，
  // 重算会得到一个没有台账的版本，于是 retention_claim 永远说不清"有没有丢失记录"。
  const fidelity = compiled.fidelity ?? auditFidelity({ ir, compiled, ledger: compiled.fact_ledger ?? null })
  diagnostics.push(...fidelity.problems.map((problem) => diagnostic(problem)))
  compiled.fidelity = fidelity
  return compiled
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
  trace = null,
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
        composed: compiled.composed ?? null,
        slots: compiled.slots,
        quality_block: compiled.quality_block,
        pose_control: compiled.pose_control ?? null,
        keywords: compiled.keywords ?? [],
        coverage: analysis.coverage ?? null,
        fidelity: compiled.fidelity ?? null,
        // 事实台账：每条观察的来源、被谁改写、在哪一步丢掉、最终进了哪个通道。
        // 它和 fidelity 是两个东西：fidelity 只答"原话还在不在"，台账答"在哪一步变的"。
        fact_ledger: compiled.fact_ledger ?? null,
        // 阶段产物清单：哪几段抓到了、哪几段拿不到以及为什么。
        trace: trace ?? null,
        dropped: compiled.dropped,
        knowledge_base_used: knowledge.kb !== null,
        experience,
        ...(include_ir ? { ir: analysis.ir } : {}),
        stats: { ...analysis.stats, compile: compiled.stats },
      },
    },
  })
}
