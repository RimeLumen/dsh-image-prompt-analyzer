/**
 * 观察语言的归一。
 *
 * 这一步必须在**视觉分析之前**做完，而且要只做一次：视觉阶段拿它决定
 * "观察值用哪种语言写"，编译阶段拿它决定"用哪种语言的模板组织句子"。
 * 两边读到的必须是同一个值——中途再各算一遍，只要有一处回落到默认值，
 * 就会出现"中文观察 + 英文模板"或反过来，两种都是坏结果。
 *
 * 优先级：任务参数 > 档案声明 > 默认（en）。
 * 任务参数只对 Caption 档案生效：Anima / Illustrious 那类标签档的观察值必须是
 * 英文标签，给它们开中文等于把整条词表链路废掉，所以传了也只忽略并留一条诊断，
 * 不静默改写用户的档案。
 */

import { SEVERITY, diagnostic } from '../diagnostics.js'
import { DEFAULT_CAPTION_LANGUAGE, normalizeCaptionLanguage } from '../model-profile/schema.js'
import { PIPELINE_CODES } from './codes.js'

/** 只有这种写法的档案会产出完整 Caption，也只有它能切语言。 */
function isCaptionProfile(profile) {
  return profile?.tag_standard?.word_style === 'caption'
}

/**
 * @param {object} options
 * @param {object|null} options.profile 已解析的档案对象（`profileRequest.profile`）
 * @param {string|null} options.requested 任务级参数 `caption_language`
 * @returns {{language: string, ok: boolean, source: string, diagnostics: object[]}}
 */
export function resolveObservationLanguage({ profile = null, requested = null } = {}) {
  const diagnostics = []
  const profileLanguage = normalizeCaptionLanguage(profile?.tag_standard?.caption_language) ?? DEFAULT_CAPTION_LANGUAGE
  const rawRequested = requested === null || requested === undefined ? '' : String(requested).trim()
  const requestedLanguage = rawRequested === '' ? null : normalizeCaptionLanguage(rawRequested)

  if (rawRequested !== '' && requestedLanguage === null) {
    diagnostics.push(
      diagnostic({
        error_code: PIPELINE_CODES.CAPTION_LANGUAGE_UNSUPPORTED,
        severity: SEVERITY.ERROR,
        message: `caption_language 只支持 en / zh-CN，收到 ${JSON.stringify(requested)}。`,
        suggested_fix: '改成 en 或 zh-CN 再跑一次。这个值必须在视觉分析开始前定下来，跑完再改只能重新分析。',
      }),
    )
    return { language: DEFAULT_CAPTION_LANGUAGE, ok: false, source: 'invalid', diagnostics }
  }

  if (!isCaptionProfile(profile)) {
    if (requestedLanguage && requestedLanguage !== DEFAULT_CAPTION_LANGUAGE) {
      diagnostics.push(
        diagnostic({
          error_code: PIPELINE_CODES.CAPTION_LANGUAGE_IGNORED,
          severity: SEVERITY.WARNING,
          message: `caption_language=${requestedLanguage} 被忽略：当前档案 ${profile?.config_id ?? '(未知)'} 不是 Caption 档，观察值仍是英文标签。`,
          suggested_fix: '中文 Caption 只有 Caption 档（MOSS-Image）能出。要用中文就换到 moss 档案，不要给标签档开中文——标签档的观察值必须是英文词。',
        }),
      )
    }
    return { language: DEFAULT_CAPTION_LANGUAGE, ok: true, source: 'non_caption_profile', diagnostics }
  }

  if (requestedLanguage) {
    return { language: requestedLanguage, ok: true, source: 'task_argument', diagnostics }
  }
  return { language: profileLanguage, ok: true, source: 'profile', diagnostics }
}
