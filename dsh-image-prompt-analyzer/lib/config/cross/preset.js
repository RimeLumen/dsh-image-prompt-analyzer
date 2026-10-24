
import { CATEGORY_IDS, DEFAULT_POSITIVE_ORDER, MUST_KEEP_CATEGORIES } from '../categories.js'
import { ANALYSIS_WEIGHT_KEYS, ANALYSIS_WEIGHT_SUM_TOLERANCE } from '../../ir/index.js'
import { makeCollectors } from './shared.js'

export function crossValidatePreset(document, { config_file }) {
  const out = []
  const { err, warn } = makeCollectors(out, config_file)

  const mustKeep = Array.isArray(document?.must_keep_categories) ? document.must_keep_categories : null
  if (mustKeep !== null) {
    for (const required of MUST_KEEP_CATEGORIES) {
      if (!mustKeep.includes(required)) {
        err(
          'PRESET_MUST_KEEP_MISSING',
          '/must_keep_categories',
          `must_keep_categories 缺少 ${required}。文档 §6.6 要求即使极简模式也不能删除构图、镜头与主体关系。`,
          `把 ${required} 加进去。`,
        )
      }
    }
    mustKeep.forEach((id, index) => {
      if (!CATEGORY_IDS.has(id)) {
        err('PRESET_UNKNOWN_CATEGORY', `/must_keep_categories/${index}`, `${id} 不是已注册的内部分类。`, `可用取值：${DEFAULT_POSITIVE_ORDER.join(' / ')}。`)
      } else if (id === 'suppression') {
        err('PRESET_MUST_KEEP_SUPPRESSION', `/must_keep_categories/${index}`, `${id} 是抑制/控制分类，不属于正向提示词，不能出现在 must_keep_categories 里。`, '删掉它。')
      }
    })
  }

  const composition = document?.composition_min_importance ?? 0
  const camera = document?.camera_min_importance ?? 0
  const subject = document?.subject_min_importance ?? 0
  const other = document?.other_min_importance ?? 0
  for (const [field, value] of [
    ['composition_min_importance', composition],
    ['camera_min_importance', camera],
    ['subject_min_importance', subject],
  ]) {
    if (value > other) {
      warn(
        'PRESET_PRIORITY_INVERTED',
        `/${field}`,
        `${field} (${value}) 高于 other_min_importance (${other})，会让该类别比一般类别更容易被裁掉，与文档 §3.3 的优先级方向相反。`,
        `把 ${field} 调到不高于 other_min_importance，或调高 other_min_importance。`,
      )
    }
  }

  const threshold = document?.low_confidence_threshold
  if (typeof threshold === 'number' && threshold >= 0.9) {
    warn(
      'PRESET_THRESHOLD_TOO_HIGH',
      '/low_confidence_threshold',
      `low_confidence_threshold = ${threshold} 会让几乎所有特征都被判为低置信度并转入 uncertainties。`,
      '常规取值范围是 0.3–0.6。',
    )
  }

  const overrides = document?.category_priority_overrides
  if (overrides && typeof overrides === 'object') {
    for (const [id, value] of Object.entries(overrides)) {
      if (!CATEGORY_IDS.has(id)) {
        err('PRESET_UNKNOWN_CATEGORY', `/category_priority_overrides/${id}`, `${id} 不是已注册的内部分类。`, `可用取值：${DEFAULT_POSITIVE_ORDER.join(' / ')}。`)
      } else if (id === 'suppression') {
        err('PRESET_OVERRIDE_SUPPRESSION', `/category_priority_overrides/${id}`, `${id} 不属于正向提示词，不能覆写它的排序权重。`, '删掉这一项。')
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        err('PRESET_OVERRIDE_NOT_NUMBER', `/category_priority_overrides/${id}`, `覆写值必须是有限数字，实际是 ${JSON.stringify(value)}。`, '改成一个数字。')
      }
    }
  }

  const weights = document?.analysis_weights
  if (weights && typeof weights === 'object' && !Array.isArray(weights)) {
    const present = ANALYSIS_WEIGHT_KEYS.filter((key) => typeof weights[key] === 'number' && Number.isFinite(weights[key]))
    if (present.length > 0) {
      const sum = present.reduce((acc, key) => acc + weights[key], 0)
      if (Math.abs(sum - 1) > ANALYSIS_WEIGHT_SUM_TOLERANCE) {
        err(
          'PRESET_ANALYSIS_WEIGHT_SUM',
          '/analysis_weights',
          `八项权重合计是 ${Number(sum.toFixed(6))}，文档 §3.3 要求合计 100%。`,
          '按 §3.3 的比例重新分配，使合计等于 1.0；只改一项就要从别处减掉同样的量。',
        )
      }

      const compositionWeight = weights.composition
      if (typeof compositionWeight === 'number') {
        const higher = ANALYSIS_WEIGHT_KEYS.filter((key) => key !== 'composition' && typeof weights[key] === 'number' && weights[key] > compositionWeight)
        if (higher.length > 0) {
          warn(
            'PRESET_ANALYSIS_WEIGHT_PRIORITY_INVERTED',
            '/analysis_weights',
            `${higher.join(' / ')} 的权重高于 composition（${compositionWeight}）。文档 §3.3 把构图列为 P0，并明确"不可让低优先级的细节数量挤掉构图、镜头和关键空间关系"。`,
            '把 composition 调回最高，或确认这份 preset 是刻意反着用的。',
          )
        }
      }
    }
  }

  const nls = document?.natural_language_supplement
  if (document?.detail_density === 'minimal' && nls?.enabled === true && (nls.max_sentences ?? 2) > 1) {
    warn(
      'PRESET_MINIMAL_WITH_NL_SUPPLEMENT',
      '/natural_language_supplement',
      'detail_density 是 minimal，却允许自然语言补充超过 1 句：标签量被压到最简后靠长句补回，反而更难控制。',
      '把 max_sentences 设为 1，或把 detail_density 改成 standard。',
    )
  }

  if (typeof document?.max_positive_terms === 'number' && typeof document?.max_negative_terms === 'number' && document.max_negative_terms > document.max_positive_terms) {
    warn(
      'PRESET_NEGATIVE_MORE_THAN_POSITIVE',
      '/max_negative_terms',
      `max_negative_terms (${document.max_negative_terms}) 大于 max_positive_terms (${document.max_positive_terms})，抑制串比正向串还长。`,
      '确认这是有意为之；文档 §7.2 要求抑制提示词按图给，不是越长越好。',
    )
  }

  return out
}
