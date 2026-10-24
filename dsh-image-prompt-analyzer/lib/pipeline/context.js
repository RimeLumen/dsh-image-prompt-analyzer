
import { SEVERITY, TASK_STATUS, diagnostic, envelope } from '../diagnostics.js'
import { resolveProfileRequest } from '../config/index.js'
import { PIPELINE_CODES } from './codes.js'
import { resolvePreset } from './preset.js'

export async function acquireKnowledgeBase(runtime) {
  try {
    const { kb, config } = await runtime.getKnowledgeBase()
    return { kb, config, diagnostics: [] }
  } catch (error) {
    return {
      kb: null,
      config: null,
      diagnostics: [
        diagnostic({
          error_code: error?.code ?? PIPELINE_CODES.KNOWLEDGE_BASE_UNAVAILABLE,
          severity: SEVERITY.WARNING,
          message: `标签知识库不可用，本次分析跳过标签查询与别名归一：${error?.message ?? error}`,
          suggested_fix: error?.suggested_fix ?? '运行 diagnose_knowledge_base 查看库文件与数据源状态。',
        }),
      ],
    }
  }
}

export async function resolveAnalysisContext(runtime, args, diagnostics) {
  const store = await runtime.getConfigStore()
  await store.get()
  const configuredProfile = runtime.pluginConfig?.target_profile ?? null
  const profileRequest = resolveProfileRequest(store, {
    profile_id: args.target_profile ?? configuredProfile,
    variant: args.variant,
  })
  diagnostics.push(...profileRequest.diagnostics)
  if (!profileRequest.profile) return null

  const presetResult = resolvePreset(store, args.detail_level, profileRequest.profile.preset_ref)
  diagnostics.push(...presetResult.diagnostics)
  if (!presetResult.entry) return null

  return { store, profileRequest, presetResult }
}

export function failedEnvelope(taskId, diagnostics) {
  return envelope({ task_id: taskId, status: TASK_STATUS.FAILED, diagnostics })
}

export function activeTargets(profileRequest, presetResult) {
  return {
    model_profile: {
      config_id: profileRequest.profile.config_id,
      schema_version: profileRequest.entry?.schema_version ?? null,
      variant: profileRequest.variant,
    },
    preset: { config_id: presetResult.entry.config_id, schema_version: presetResult.entry.schema_version },
  }
}
