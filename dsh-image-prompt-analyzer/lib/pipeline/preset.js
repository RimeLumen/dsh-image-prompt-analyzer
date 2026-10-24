
import { SEVERITY, diagnostic } from '../diagnostics.js'
import { PIPELINE_CODES } from './codes.js'

const DETAIL_LEVELS = Object.freeze(['minimal', 'standard', 'high'])

export function resolvePreset(store, detailLevel, presetRef) {
  const diagnostics = []
  const level = typeof detailLevel === 'string' ? detailLevel.trim() : ''
  const explicit = DETAIL_LEVELS.includes(level)
  if (level && !explicit) {
    diagnostics.push(
      diagnostic({
        error_code: PIPELINE_CODES.DETAIL_LEVEL_INVALID,
        severity: SEVERITY.WARNING,
        field_path: '/detail_level',
        message: `detail_level 取值「${level}」不在允许集合内，已按 standard 处理。`,
        suggested_fix: `可用取值：${DETAIL_LEVELS.join(' / ')}。`,
      }),
    )
  }

  const ref = typeof presetRef === 'string' ? presetRef.trim() : ''
  if (!explicit && ref) {
    const referenced = store.getPreset(ref)
    if (referenced) return { entry: referenced, diagnostics }
    diagnostics.push(
      diagnostic({
        error_code: PIPELINE_CODES.PRESET_REF_NOT_FOUND,
        severity: SEVERITY.WARNING,
        field_path: '/preset_ref',
        message: `profile 声明的 preset_ref「${ref}」找不到，已改按 detail-standard 的约定名去找 preset。`,
        suggested_fix: '修正 profile 的 preset_ref，或恢复对应的 preset 配置。',
      }),
    )
  }

  const effective = explicit ? level : 'standard'

  const direct = store.getPreset(`detail-${effective}`)
  if (direct && direct.config?.detail_density === effective) {
    return { entry: direct, diagnostics }
  }

  const fallbackId = store
    .listPresets()
    .find((item) => item.detail_density === effective)?.config_id
  const scanned = fallbackId ? store.getPreset(fallbackId) : null
  if (scanned) {
    diagnostics.push(
      diagnostic({
        error_code: PIPELINE_CODES.PRESET_FALLBACK,
        severity: SEVERITY.INFO,
        message: `没有 detail-${effective} 这个 preset，已改用同为 ${effective} 密度的 ${scanned.config_id}。`,
      }),
    )
    return { entry: scanned, diagnostics }
  }

  diagnostics.push(
    diagnostic({
      error_code: PIPELINE_CODES.PRESET_NOT_FOUND,
      severity: SEVERITY.ERROR,
      field_path: '/detail_level',
      message: `找不到细节密度为 ${effective} 的提示词 preset，无法确定阈值与配额。`,
      suggested_fix: '恢复 configs/presets/ 下的出厂 preset，或自己加一份 detail_density 相同的配置。',
    }),
  )
  return { entry: null, diagnostics }
}
