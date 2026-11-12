import { SEVERITY, TASK_STATUS, diagnostic, envelope } from '../../diagnostics.js'
import { composeCaptionFromBrief, BRIEF_CODES } from '../../compile/brief.js'
import { resolveAnalysisContext } from '../../pipeline/context.js'

const TOOL_CODES = Object.freeze({
  PROFILE_REQUIRED: 'WRITE_CAPTION_PROFILE_REQUIRED',
  DIAGNOSTICS_TRUNCATED: 'WRITE_CAPTION_DIAGNOSTICS_TRUNCATED',
})

const MAX_DIAGNOSTICS = 20

const SEVERITY_MAP = {
  error: SEVERITY.ERROR,
  warning: SEVERITY.WARNING,
  info: SEVERITY.INFO,
}

/**
 * 基于自然语言需求的编写入口。
 *
 * 与 compile_tag_basket 的分工：那个吃标签、走词表解析与槽位渲染；
 * 这个吃一句话，原样交出一段 Caption。两条路都不提交生图任务。
 */
export async function runWriteCaption(runtime, args = {}) {
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
  const composed = composeCaptionFromBrief({
    brief: args.brief,
    profile,
    language: args.language ?? null,
    includeNegative: args.include_negative !== false,
  })

  for (const item of composed.diagnostics) {
    diagnostics.push(
      diagnostic({
        error_code: item.code,
        severity: SEVERITY_MAP[item.severity] ?? SEVERITY.INFO,
        field_path: item.code === BRIEF_CODES.BRIEF_PROFILE_NOT_CAPTION ? '/target_profile' : '/brief',
        message: item.message,
        suggested_fix: item.suggested_fix ?? null,
      }),
    )
  }

  const kept = diagnostics.slice(0, MAX_DIAGNOSTICS)
  const omitted = diagnostics.length - kept.length
  if (omitted > 0) {
    kept.push(
      diagnostic({
        error_code: TOOL_CODES.DIAGNOSTICS_TRUNCATED,
        severity: SEVERITY.INFO,
        message: `另有 ${omitted} 条诊断未列出。`,
      }),
    )
  }

  return envelope({
    status: composed.ok ? TASK_STATUS.OK : TASK_STATUS.FAILED,
    diagnostics: kept,
    active_configs: {
      model_profile: { config_id: profile.config_id },
      preset: { config_id: context.presetResult.entry.config_id },
    },
    extra: {
      target_profile: profile.config_id,
      word_style: profile.tag_standard?.word_style ?? null,
      register: composed.ok ? composed.register : null,
      positive: composed.text,
      negative: composed.negative?.text ?? null,
      language: composed.language,
      sentences: composed.sentences ?? [],
      // 负向里被摘掉的词：正向已经写了这个物件，负向再写 no X 就是自相矛盾。
      negative_removed: composed.negative?.removed ?? [],
      brief: {
        chars: composed.stats?.chars ?? 0,
        sentences: composed.stats?.sentences ?? 0,
        removed_quality_words: composed.stats?.removed_quality_words ?? 0,
        // 这一项永远是 false：编写入口不产出标签流，也不产出 Layout JSON。
        emitted_tags: false,
        emitted_layout: false,
      },
    },
  })
}
