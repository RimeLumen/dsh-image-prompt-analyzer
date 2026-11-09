
import {
  CAPTION_LANGUAGES,
  CONFIDENCE_LEVELS,
  GENERAL_CATEGORY_IDS,
  MODEL_PROFILE_SCHEMA_VERSION,
  SLOT_NAMES,
  WORD_STYLES,
  isSlotName,
} from './schema.js'
import { errorGroupFor } from '../diagnostics.js'

export const MODEL_PROFILE_CODES = Object.freeze({
  SCHEMA_VERSION_UNSUPPORTED: 'MODEL_PROFILE_SCHEMA_VERSION_UNSUPPORTED',
  GENERATION_FORBIDDEN: 'MODEL_PROFILE_GENERATION_FORBIDDEN',
  SLOT_UNKNOWN: 'MODEL_PROFILE_SLOT_UNKNOWN',
  SLOT_DUPLICATE: 'MODEL_PROFILE_SLOT_DUPLICATE',
  SLOT_MISSING_REQUIRED: 'MODEL_PROFILE_SLOT_MISSING_REQUIRED',
  SLOT_ORDER_PRESET_UNKNOWN: 'MODEL_PROFILE_SLOT_ORDER_PRESET_UNKNOWN',
  SLOT_ORDER_CONFLICT: 'MODEL_PROFILE_SLOT_ORDER_CONFLICT',
})

export const TAG_STANDARD_CODES = Object.freeze({
  WORD_STYLE_INVALID: 'TAG_STANDARD_WORD_STYLE_INVALID',
  FORBIDDEN_CONFLICT: 'TAG_STANDARD_FORBIDDEN_CONFLICT',
  RATING_VOCAB_INCOMPLETE: 'TAG_STANDARD_RATING_VOCAB_INCOMPLETE',
  RATING_EMIT_INVALID: 'TAG_STANDARD_RATING_EMIT_INVALID',
  BUDGET_INVALID: 'TAG_STANDARD_BUDGET_INVALID',
  TRIM_ORDER_UNKNOWN_SLOT: 'TAG_STANDARD_TRIM_ORDER_UNKNOWN_SLOT',
  DATA_SOURCE_MISSING: 'TAG_STANDARD_DATA_SOURCE_MISSING',
  CONFIDENCE_INVALID: 'TAG_STANDARD_CONFIDENCE_INVALID',
  CAPTION_LANGUAGE_UNSUPPORTED: 'TAG_STANDARD_CAPTION_LANGUAGE_UNSUPPORTED',
})

const REQUIRED_SLOTS = Object.freeze(['general'])

function diagnostic(configFile, code, fieldPath, message, suggestedFix) {
  return {
    error_code: code,
    error_group: errorGroupFor(code),
    severity: 'error',
    config_file: configFile,
    field_path: fieldPath,
    message,
    suggested_fix: suggestedFix,
  }
}

function normalizeTag(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function validateSlotOrder(order, fieldPath, configFile, diagnostics) {
  let clean = true
  if (!Array.isArray(order) || order.length === 0) {
    diagnostics.push(
      diagnostic(
        configFile,
        MODEL_PROFILE_CODES.SLOT_UNKNOWN,
        fieldPath,
        '槽位顺序必须是非空数组。',
        `可用的槽位名：${[...SLOT_NAMES].join('、')}。`,
      ),
    )
    return { order: [], clean: false }
  }
  const seen = new Set()
  order.forEach((slot, index) => {
    if (!isSlotName(slot)) {
      clean = false
      diagnostics.push(
        diagnostic(
          configFile,
          MODEL_PROFILE_CODES.SLOT_UNKNOWN,
          `${fieldPath}/${index}`,
          `“${slot}”不是槽位名。`,
          `只允许 ${SLOT_NAMES.join('、')}；内部分类 ID 只能写进 general_order / trim_order。`,
        ),
      )
      return
    }
    if (seen.has(slot)) {
      clean = false
      diagnostics.push(
        diagnostic(
          configFile,
          MODEL_PROFILE_CODES.SLOT_DUPLICATE,
          `${fieldPath}/${index}`,
          `槽位“${slot}”重复出现。`,
          '每个槽位在一条顺序里只能出现一次。',
        ),
      )
      return
    }
    seen.add(slot)
  })
  return { order, clean }
}

export function validateModelProfile(doc, { configFile = null } = {}) {
  const diagnostics = []
  const root = doc && typeof doc === 'object' ? doc : {}
  const tagStandard = root.tag_standard && typeof root.tag_standard === 'object' ? root.tag_standard : {}

  if (root.schema_version !== MODEL_PROFILE_SCHEMA_VERSION) {
    diagnostics.push(
      diagnostic(
        configFile,
        MODEL_PROFILE_CODES.SCHEMA_VERSION_UNSUPPORTED,
        '/schema_version',
        `档案 schema 版本必须是 "${MODEL_PROFILE_SCHEMA_VERSION}"，当前是 ${JSON.stringify(root.schema_version)}。`,
        '迁移到 2.0；旧版 1.0 档案在 M7 之后不再支持。',
      ),
    )
  }

  if (Object.hasOwn(root, 'generation') || Object.hasOwn(tagStandard, 'generation')) {
    diagnostics.push(
      diagnostic(
        configFile,
        MODEL_PROFILE_CODES.GENERATION_FORBIDDEN,
        Object.hasOwn(tagStandard, 'generation') ? '/tag_standard/generation' : '/generation',
        '档案里不允许出现 generation（steps/CFG/采样器/分辨率）。',
        '本插件只做提示词逆向，不参与出图；生成参数请写在 README 的参考表，不要写进档案。',
      ),
    )
  }

  if (!WORD_STYLES.includes(tagStandard.word_style)) {
    diagnostics.push(
      diagnostic(
        configFile,
        TAG_STANDARD_CODES.WORD_STYLE_INVALID,
        '/tag_standard/word_style',
        `word_style 必须是 ${WORD_STYLES.join(' 或 ')}，当前是 ${JSON.stringify(tagStandard.word_style)}。`,
        '按目标模型词表约定选：标签型模型用 spaced（Illustrious / Animagine 都是，下划线会多花 token），吃自然语言的模型用 prose，Caption 型模型用 caption。',
      ),
    )
  }

  // Caption 档案可以声明自己只写哪种语言。写错语言不是小事：编译器会直接拒绝出稿，
  // 但如果档案里把语言码拼错了，用户拿到的是一句"这个语言不支持"，看不出是自己拼错。
  if (tagStandard.caption_language !== undefined && tagStandard.caption_language !== null) {
    const language = String(tagStandard.caption_language).trim()
    if (language !== '' && !CAPTION_LANGUAGES.includes(language)) {
      diagnostics.push(
        diagnostic(
          configFile,
          TAG_STANDARD_CODES.CAPTION_LANGUAGE_UNSUPPORTED,
          '/tag_standard/caption_language',
          `caption_language 目前只支持 ${CAPTION_LANGUAGES.join(' / ')}，当前是 ${JSON.stringify(tagStandard.caption_language)}。`,
          'Caption 直接从 IR 观察值编译，而 IR 里的观察值是英语；要中文必须另加一层翻译，那是另一次模型调用，不在本插件范围内。',
        ),
      )
    }
  }

  const presets = asArray(tagStandard.slot_order_presets)
  const presetById = new Map()
  const presetOrders = new Map()
  presets.forEach((preset, index) => {
    const base = `/tag_standard/slot_order_presets/${index}`
    if (!preset || typeof preset.id !== 'string' || preset.id.trim() === '') {
      diagnostics.push(
        diagnostic(
          configFile,
          MODEL_PROFILE_CODES.SLOT_ORDER_PRESET_UNKNOWN,
          `${base}/id`,
          '槽位顺序 preset 缺少非空 id。',
          '给 preset 一个稳定 id，例如 count_first / quality_first。',
        ),
      )
    } else if (presetById.has(preset.id)) {
      diagnostics.push(
        diagnostic(
          configFile,
          MODEL_PROFILE_CODES.SLOT_ORDER_PRESET_UNKNOWN,
          `${base}/id`,
          `preset id“${preset.id}”重复。`,
          'preset 的 id 在档案内必须唯一。',
        ),
      )
    } else {
      presetById.set(preset.id, preset)
    }

    const checked = validateSlotOrder(preset?.order, `${base}/order`, configFile, diagnostics)
    if (preset?.id && checked.clean) presetOrders.set(preset.id, checked.order)

    if (preset && Object.hasOwn(preset, 'confidence')) {
      if (!CONFIDENCE_LEVELS.includes(preset.confidence)) {
        diagnostics.push(
          diagnostic(
            configFile,
            TAG_STANDARD_CODES.CONFIDENCE_INVALID,
            `${base}/confidence`,
            `preset 的 confidence 必须是 ${CONFIDENCE_LEVELS.join('/')}，当前是 ${JSON.stringify(preset.confidence)}。`,
            '按出处分级：A 一手官方原文、B 官方指南或社区文档、C 社区经验。',
          ),
        )
      }
      if (typeof preset.source !== 'string' || preset.source.trim() === '') {
        diagnostics.push(
          diagnostic(
            configFile,
            TAG_STANDARD_CODES.DATA_SOURCE_MISSING,
            `${base}/source`,
            'preset 标了 confidence 却没有写 source。',
            '补上原始发布方（论文/模型卡/指南的标题或编号），否则无法复核。',
          ),
        )
      }
    }
  })

  const directOrder = validateSlotOrder(tagStandard.slot_order, '/tag_standard/slot_order', configFile, diagnostics)
  let effectiveOrder = directOrder.order

  const defaultPresetId = tagStandard.default_slot_order_preset
  if (defaultPresetId !== null && defaultPresetId !== undefined) {
    const preset = typeof defaultPresetId === 'string' ? presetById.get(defaultPresetId) : null
    if (!preset) {
      diagnostics.push(
        diagnostic(
          configFile,
          MODEL_PROFILE_CODES.SLOT_ORDER_PRESET_UNKNOWN,
          '/tag_standard/default_slot_order_preset',
          `默认 preset“${String(defaultPresetId)}”不存在。`,
          `可用的 preset：${[...presetById.keys()].join('、') || '（无）'}。`,
        ),
      )
    } else {
      const presetOrder = presetOrders.get(defaultPresetId) ?? asArray(preset.order)
      const same = directOrder.order.length === presetOrder.length && directOrder.order.every((slot, i) => slot === presetOrder[i])
      if (!same) {
        diagnostics.push(
          diagnostic(
            configFile,
            MODEL_PROFILE_CODES.SLOT_ORDER_CONFLICT,
            '/tag_standard/slot_order',
            `slot_order 与默认 preset“${defaultPresetId}”的 order 不一致。`,
            '两处必须完全一致（避免两处真相）；或把 default_slot_order_preset 设为 null 只用 slot_order。',
          ),
        )
      }
      if (presetOrders.has(defaultPresetId)) effectiveOrder = presetOrders.get(defaultPresetId)
    }
  }

  for (const required of REQUIRED_SLOTS) {
    if (!effectiveOrder.includes(required)) {
      diagnostics.push(
        diagnostic(
          configFile,
          MODEL_PROFILE_CODES.SLOT_MISSING_REQUIRED,
          '/tag_standard/slot_order',
          `槽位顺序缺少必填槽“${required}”。`,
          'general 承载其余全部词条，任何档案都必须有它。',
        ),
      )
    }
  }

  const trimOrder = tagStandard.trim_order
  if (!Array.isArray(trimOrder)) {
    diagnostics.push(
      diagnostic(
        configFile,
        TAG_STANDARD_CODES.TRIM_ORDER_UNKNOWN_SLOT,
        '/tag_standard/trim_order',
        'trim_order 必须是数组。',
        '按“先删的写在最前”排列槽位名或内部分类 ID；预算不足时按此顺序删除。',
      ),
    )
  } else {
    trimOrder.forEach((entry, index) => {
      if (!isSlotName(entry) && !GENERAL_CATEGORY_IDS.includes(entry)) {
        diagnostics.push(
          diagnostic(
            configFile,
            TAG_STANDARD_CODES.TRIM_ORDER_UNKNOWN_SLOT,
            `/tag_standard/trim_order/${index}`,
            `“${entry}”既不是槽位名也不是内部分类 ID。`,
            '槽位名只能来自 SLOT_NAMES；分类 ID 只能来自 lib/config/categories.js。',
          ),
        )
      }
    })
  }

  const generalOrder = tagStandard.general_order
  if (generalOrder !== undefined && !Array.isArray(generalOrder)) {
    diagnostics.push(
      diagnostic(
        configFile,
        MODEL_PROFILE_CODES.SLOT_UNKNOWN,
        '/tag_standard/general_order',
        'general_order 必须是数组。',
        '它只接受内部分析分类 ID（composition/clothing/...），不接受槽位名。',
      ),
    )
  } else if (Array.isArray(generalOrder)) {
    generalOrder.forEach((categoryId, index) => {
      if (!GENERAL_CATEGORY_IDS.includes(categoryId)) {
        diagnostics.push(
          diagnostic(
            configFile,
            MODEL_PROFILE_CODES.SLOT_UNKNOWN,
            `/tag_standard/general_order/${index}`,
            `“${categoryId}”不是可排序的内部分类 ID。`,
            `可用：${GENERAL_CATEGORY_IDS.join('、')}。`,
          ),
        )
      }
    })
  }

  const forbidden = new Set(asArray(tagStandard.forbidden_tags).map(normalizeTag).filter(Boolean))
  const fixedBlocks = [
    ...asArray(tagStandard.quality_block),
    ...asArray(tagStandard.score_block?.terms),
    ...asArray(tagStandard.year_block),
    ...asArray(tagStandard.aesthetic_block),
    ...asArray(tagStandard.source_block),
    ...asArray(tagStandard.meta_block),
  ].map(normalizeTag)
  for (const term of fixedBlocks) {
    if (forbidden.has(term)) {
      diagnostics.push(
        diagnostic(
          configFile,
          TAG_STANDARD_CODES.FORBIDDEN_CONFLICT,
          '/tag_standard/forbidden_tags',
          `禁用词“${term}”同时出现在固定词块里。`,
          '删除其中一处：禁用词由编译器统一拦截，固定块再写一遍会自相矛盾。',
        ),
      )
      break
    }
  }
  for (const term of asArray(tagStandard.never_trim_tags).map(normalizeTag)) {
    if (forbidden.has(term)) {
      diagnostics.push(
        diagnostic(
          configFile,
          TAG_STANDARD_CODES.FORBIDDEN_CONFLICT,
          '/tag_standard/never_trim_tags',
          `“${term}”既在 never_trim_tags 又在 forbidden_tags。`,
          '永不删除与禁用是矛盾的两条规则，二选一。',
        ),
      )
      break
    }
  }

  const ratingVocab = tagStandard.rating_vocab
  const ratingKeys = ['safe', 'sensitive', 'nsfw', 'explicit']
  const ratingComplete =
    ratingVocab && typeof ratingVocab === 'object' && ratingKeys.every((key) => typeof ratingVocab[key] === 'string' && ratingVocab[key].trim() !== '')
  if (!ratingComplete) {
    diagnostics.push(
      diagnostic(
        configFile,
        TAG_STANDARD_CODES.RATING_VOCAB_INCOMPLETE,
        '/tag_standard/rating_vocab',
        '评级词表必须给 safe/sensitive/nsfw/explicit 四个映射。',
        '按目标模型的评级词汇补全（Illustrious: safe/sensitive/nsfw/explicit；Animagine 用同一个 rating 前缀）。',
      ),
    )
  }

  // rating_default 允许 null / ""：表示「不写默认评级」。写 safe 会占掉一个靠前槽位却不改变画面，
  // 实测压低出图质量，所以默认不写；只有观察里确实出现 nsfw / explicit 才补。
  const ratingDefault = tagStandard.rating_default
  if (!(ratingDefault === null || ratingDefault === undefined || (typeof ratingDefault === 'string' && ratingDefault.trim() === '') || typeof ratingDefault === 'string')) {
    diagnostics.push(
      diagnostic(
        configFile,
        TAG_STANDARD_CODES.RATING_EMIT_INVALID,
        '/tag_standard/rating_default',
        'rating_default 必须是字符串，或 null / ""（表示不写默认评级）。',
        '成人内容为主的档案建议设成 null，让评级只由画面内容决定。',
      ),
    )
  }
  if (ratingDefault !== null && ratingDefault !== undefined && typeof ratingDefault === 'string' && ratingDefault.trim() !== '') {
    const key = normalizeTag(ratingDefault)
    if (ratingVocab && typeof ratingVocab === 'object' && !Object.keys(ratingVocab).some((name) => normalizeTag(name) === key)) {
      diagnostics.push(
        diagnostic(
          configFile,
          TAG_STANDARD_CODES.RATING_EMIT_INVALID,
          '/tag_standard/rating_default',
          `rating_default「${ratingDefault}」不在 rating_vocab 的键里。`,
          '改成 rating_vocab 的某个键，或设成 null 表示不写默认评级。',
        ),
      )
    }
  }

  // rating_emit 白名单：只有这些评级会被写进正稿。默认 ['nsfw','explicit']。
  const ratingEmit = tagStandard.rating_emit
  const emitOk =
    ratingEmit === undefined ||
    (Array.isArray(ratingEmit) &&
      ratingEmit.every((item) => typeof item === 'string' && item.trim() !== '') &&
      (ratingEmit.length === 0 || (ratingVocab && typeof ratingVocab === 'object')))
  if (!emitOk) {
    diagnostics.push(
      diagnostic(
        configFile,
        TAG_STANDARD_CODES.RATING_EMIT_INVALID,
        '/tag_standard/rating_emit',
        'rating_emit 必须是字符串数组（可为空数组），元素取自 rating_vocab。',
        "默认 ['nsfw','explicit']；不想输出任何评级就写 []。",
      ),
    )
  } else if (Array.isArray(ratingEmit) && ratingEmit.length > 0 && ratingVocab && typeof ratingVocab === 'object') {
    const vocabKeys = new Set(Object.keys(ratingVocab).map((name) => normalizeTag(name)))
    for (const item of ratingEmit) {
      if (!vocabKeys.has(normalizeTag(item))) {
        diagnostics.push(
          diagnostic(
            configFile,
            TAG_STANDARD_CODES.RATING_EMIT_INVALID,
            '/tag_standard/rating_emit',
            `rating_emit 里的「${item}」不在 rating_vocab 的键里。`,
            '只写 rating_vocab 里定义过的评级名。',
          ),
        )
        break
      }
    }
  }

  const budget = tagStandard.budget
  const positiveTerms = budget?.positive_terms
  const negativeTerms = budget?.negative_terms
  const positiveTokens = budget?.positive_tokens
  // positive_terms = null 表示「不设正向词数上限」：反推的目标是还原，不是凑长度，
  // 观察有多少就写多少（见 compile/budget.js 对 null 的处理）。
  const positiveOk = positiveTerms === null || (Number.isInteger(positiveTerms) && positiveTerms > 0)
  const budgetOk =
    positiveOk &&
    Number.isInteger(negativeTerms) &&
    negativeTerms > 0 &&
    (positiveTerms === null || negativeTerms <= positiveTerms) &&
    (positiveTokens === null || positiveTokens === undefined || (Number.isInteger(positiveTokens) && positiveTokens > 0))
  if (!budgetOk) {
    diagnostics.push(
      diagnostic(
        configFile,
        TAG_STANDARD_CODES.BUDGET_INVALID,
        '/tag_standard/budget',
        '预算必须满足：positive_terms 为正整数或 null（null = 不设上限）、negative_terms 正整数且不超过 positive_terms、positive_tokens 为 null 或正整数。',
        '参考 spec 附录 A 的各档案预算；不要靠裁剪掩盖错误的预算配置。',
      ),
    )
  }

  const sourceConfidence = tagStandard.source_confidence
  if (!sourceConfidence || typeof sourceConfidence !== 'object') {
    diagnostics.push(
      diagnostic(
        configFile,
        TAG_STANDARD_CODES.DATA_SOURCE_MISSING,
        '/tag_standard/source_confidence',
        '档案缺少 source_confidence（出处与置信度）。',
        '补成 { level: "A|B|C", source: "原始发布方", note: "可选" }。',
      ),
    )
    diagnostics.push(
      diagnostic(
        configFile,
        TAG_STANDARD_CODES.CONFIDENCE_INVALID,
        '/tag_standard/source_confidence/level',
        `source_confidence.level 必须是 ${CONFIDENCE_LEVELS.join('/')}。`,
        'A 一手官方原文、B 官方指南或社区文档、C 社区经验；它描述出处可信度，不等于官方推荐做法。',
      ),
    )
  } else {
    if (typeof sourceConfidence.source !== 'string' || sourceConfidence.source.trim() === '') {
      diagnostics.push(
        diagnostic(
          configFile,
          TAG_STANDARD_CODES.DATA_SOURCE_MISSING,
          '/tag_standard/source_confidence/source',
          'source_confidence 缺少 source。',
          '写原始发布方（论文编号、模型卡标题、指南链接标题），写“社区”也要能定位。',
        ),
      )
    }
    if (!CONFIDENCE_LEVELS.includes(sourceConfidence.level)) {
      diagnostics.push(
        diagnostic(
          configFile,
          TAG_STANDARD_CODES.CONFIDENCE_INVALID,
          '/tag_standard/source_confidence/level',
          `source_confidence.level 必须是 ${CONFIDENCE_LEVELS.join('/')}，当前是 ${JSON.stringify(sourceConfidence.level)}。`,
          '按出处分级；同一模型存在多套“官方”说法时，各自标注、并列保留。',
        ),
      )
    }
  }

  return { ok: diagnostics.length === 0, diagnostics }
}
