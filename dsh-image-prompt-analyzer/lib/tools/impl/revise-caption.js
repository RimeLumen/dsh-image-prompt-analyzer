import { SEVERITY, TASK_STATUS, diagnostic, envelope } from '../../diagnostics.js'
import { reviseCaption, REVISE_CODES } from '../../compile/revise.js'
import { resolveAnalysisContext } from '../../pipeline/context.js'

const TOOL_CODES = Object.freeze({
  PROFILE_REQUIRED: 'REVISE_CAPTION_PROFILE_REQUIRED',
})

const SEVERITY_MAP = {
  [REVISE_CODES.INPUT_REQUIRED]: SEVERITY.ERROR,
  [REVISE_CODES.INSTRUCTION_UNPARSED]: SEVERITY.ERROR,
  [REVISE_CODES.FROM_REQUIRED]: SEVERITY.ERROR,
  [REVISE_CODES.TARGET_ABSENT]: SEVERITY.ERROR,
  [REVISE_CODES.VALUE_ABSENT]: SEVERITY.ERROR,
  [REVISE_CODES.TARGET_AMBIGUOUS]: SEVERITY.ERROR,
  [REVISE_CODES.PROFILE_NOT_CAPTION]: SEVERITY.ERROR,
}

/**
 * 局部修改入口：原文 + 一句修改要求。
 *
 * 与 write_caption 的区别是它有原文。没有原文时，「改了什么」只能靠人对比两段文字，
 * 而「只有一句不同」这种断言根本查不出「外套」被顺手换成了「风衣」。
 * 这个入口只动被点名的那一处，其余字符逐字不动。
 */
export async function runReviseCaption(runtime, args = {}) {
  const diagnostics = []
  const context = await resolveAnalysisContext(runtime, args, diagnostics)
  if (!context) {
    diagnostics.push(
      diagnostic({
        error_code: TOOL_CODES.PROFILE_REQUIRED,
        severity: SEVERITY.ERROR,
        field_path: '/target_profile',
        message: '没有解析出目标模型档案。',
        suggested_fix: '显式传 target_profile（moss），或在插件配置里设默认档案。',
      }),
    )
    return envelope({ status: TASK_STATUS.FAILED, diagnostics })
  }

  const profile = context.profileRequest.profile
  const result = reviseCaption({
    original: args.original,
    instruction: args.instruction,
    profile,
  })

  for (const item of result.diagnostics) {
    diagnostics.push(
      diagnostic({
        error_code: item.code,
        severity: SEVERITY_MAP[item.code] ?? SEVERITY.INFO,
        field_path: item.code === REVISE_CODES.PROFILE_NOT_CAPTION ? '/target_profile' : '/instruction',
        message: item.message,
        suggested_fix: item.suggested_fix ?? null,
      }),
    )
  }

  return envelope({
    status: result.ok ? TASK_STATUS.OK : TASK_STATUS.FAILED,
    diagnostics,
    active_configs: {
      model_profile: { config_id: profile.config_id },
      preset: { config_id: context.presetResult.entry.config_id },
    },
    extra: {
      target_profile: profile.config_id,
      positive: result.text,
      changed: result.changed,
      // 目标不唯一时把候选小句交出去，让调用方决定改哪一个，而不是替它选。
      candidates: result.candidates,
      instruction: result.instruction ?? null,
    },
  })
}
