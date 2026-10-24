
import { SEVERITY, diagnostic, envelope, newTaskId } from '../diagnostics.js'
import { FEATURE_SOURCES, IR_SCHEMA_VERSION } from '../ir/index.js'
import { compilePrompt } from '../compile/index.js'
import { PIPELINE_CODES } from './codes.js'
import { activeTargets, failedEnvelope, resolveAnalysisContext } from './context.js'

export function demoIR() {
  return {
    schema_version: IR_SCHEMA_VERSION,
    task_id: 'preview-demo',
    created_at: new Date(0).toISOString(),
    image: { width: 1024, height: 1536, aspect_ratio: '2:3', has_alpha: false, src_format: 'PNG', decoded_via: 'demo', scale: 1 },
    scene: { summary: '这是 preview_model_profile 的演示输入，不是任何真实图片的分析结果。' },
    composition: {
      shot_type: { value: 'upper body', confidence: 0.9, importance: 1, status: 'confirmed' },
      framing: { value: 'portrait', confidence: 0.8, importance: 0.9, status: 'confirmed' },
    },
    camera: {
      angle: { value: 'from above', confidence: 0.7, importance: 0.83, status: 'confirmed' },
    },
    entities: [
      {
        entity_id: 'e1',
        kind: 'person',
        label: '1girl',
        count: 1,
        confidence: 0.95,
        importance: 0.5,
        features: [
          { category: 'appearance', key: 'hair', value: 'long hair', confidence: 0.9, importance: 0.27, status: 'confirmed', source: FEATURE_SOURCES.GLOBAL },
          { category: 'expression', key: 'expression', value: 'smile', confidence: 0.6, importance: 0.1, status: 'tentative', source: FEATURE_SOURCES.GLOBAL },
        ],
      },
    ],
    relations: [],
    features: [
      { category: 'clothing', key: 'outfit', value: 'school uniform', confidence: 0.8, importance: 0.27, status: 'confirmed', source: FEATURE_SOURCES.GLOBAL },
      { category: 'background', key: 'setting', value: 'classroom', confidence: 0.7, importance: 0.17, status: 'confirmed', source: FEATURE_SOURCES.GLOBAL },
      { category: 'lighting_color', key: 'light', value: 'backlighting', confidence: 0.6, importance: 0.13, status: 'tentative', source: FEATURE_SOURCES.GLOBAL },
      { category: 'quality_style', key: 'style', value: 'masterpiece', confidence: 0.9, importance: 0.1, status: 'confirmed', source: FEATURE_SOURCES.GLOBAL },
      { category: 'artist', key: 'artist', value: 'some_artist', confidence: 0.8, importance: 0.1, status: 'confirmed', source: FEATURE_SOURCES.LOCAL },
      { category: 'quality_style', key: 'rating', value: 'safe', confidence: 0.9, importance: 0.1, status: 'confirmed', source: FEATURE_SOURCES.USER },
    ],
    uncertainties: [],
    provenance: { note: 'demo' },
  }
}

export async function runPreviewProfilePipeline(runtime, args = {}) {
  const taskId = newTaskId()
  const diagnostics = []
  const context = await resolveAnalysisContext(runtime, args, diagnostics)
  if (!context) return failedEnvelope(taskId, diagnostics)
  const { profileRequest, presetResult } = context

  const provided = args.sample_ir && typeof args.sample_ir === 'object' ? args.sample_ir : null
  const ir = provided ?? demoIR()
  if (!provided) {
    diagnostics.push(
      diagnostic({
        error_code: PIPELINE_CODES.PREVIEW_DEMO_IR,
        severity: SEVERITY.INFO,
        message: '没有提供 sample_ir，本次预览用内置演示 IR，输出的提示词不是任何真实图片的结果。',
        suggested_fix: '要预览真实效果，把 analyze_image_prompt 返回的 result.ir 传进 sample_ir。',
      }),
    )
  }

  diagnostics.push(
    diagnostic({
      error_code: PIPELINE_CODES.PREVIEW_SKIPS_KNOWLEDGE_BASE,
      severity: SEVERITY.INFO,
      message: '预览不查标签知识库（这是配置诊断，不该因为本地数据库不可用而失败），因此看不到别名归一与分类补全的效果。',
    }),
  )

  const compiled = await compilePrompt({
    ir,
    profile: profileRequest.profile,
    preset: presetResult.entry.config,
    kb: null,
    includeNegative: args.include_negative !== false,
  })
  diagnostics.push(...compiled.diagnostics)

  return envelope({
    task_id: taskId,
    diagnostics,
    active_configs: activeTargets(profileRequest, presetResult),
    extra: {
      result: {
        target_profile: compiled.target_profile,
        detail_level: compiled.detail_level,
        used_demo_ir: !provided,
        prompts: compiled.prompts,
        slots: compiled.slots,
        quality_block: compiled.quality_block,
        dropped: compiled.dropped,
        stats: compiled.stats,
      },
    },
  })
}
