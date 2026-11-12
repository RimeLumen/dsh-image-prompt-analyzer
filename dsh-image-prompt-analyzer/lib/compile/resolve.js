
import { SEVERITY, diagnostic } from '../diagnostics.js'
import { CATEGORY_IDS, layerOf } from '../config/index.js'
import { normalizeTagName } from '../kb/index.js'

export const RESOLVE_CODES = Object.freeze({
  NO_KNOWLEDGE_BASE: 'COMPILE_KNOWLEDGE_BASE_UNAVAILABLE',
  UNKNOWN_TAG: 'COMPILE_UNKNOWN_TAG',
  SOURCE_UNAVAILABLE: 'COMPILE_KNOWLEDGE_SOURCE_UNAVAILABLE',
  ALIAS_NORMALIZED: 'COMPILE_ALIAS_NORMALIZED',
  ALIAS_BLOCKED: 'COMPILE_ALIAS_BLOCKED',
  META_TAG_DROPPED: 'COMPILE_META_TAG_DROPPED',
  TAG_ONLY_EXCLUDED: 'COMPILE_TAG_VOCABULARY_EXCLUDED',
  LOSSY_PROJECTION: 'COMPILE_LOSSY_PROJECTION',
  UNVERIFIED_IN_TAGS: 'COMPILE_UNVERIFIED_PHRASE_IN_TAGS',
  // 工作室补充词典认出了这个词，但它不在这个模型的词表里。
  // 这条只解释、不背书：词照样按"未验证"处理。
  STUDIO_HINT: 'COMPILE_STUDIO_SUPPLEMENT_HINT',
})

/**
 * 词表里查不到的观察怎么处理。
 *
 * `keep_as_description`（旧行为）把它们留在标签流里，于是 `right arm outstretched
 * toward viewer` 这种句子碎片会混进 tag 版，把真正标签词的权重摊薄——目标模型只看
 * 得懂词表里的词，读不懂的片段只会占位置。
 *
 * `description_only` 把它们从标签流里摘出来，交给描述版（composed）表达。动作、朝向
 * 这类本来就难用单个 tag 写清的东西，在描述版里反而更准。
 */

/**
 * 标签表里的“元标签”桶：Danbooru / Animagine 把成百上千个“不建议使用”的词
 * 统一挂成 bad_tag、useless_tags 这些桶的别名。它们本身不是画面特征，一旦被
 * 归一或保留进正向，等于告诉模型“这是一张劣质标签图”，只会污染画面。
 */
export const NON_EMITTABLE_TAGS = Object.freeze(new Set(['bad_tag', 'useless_tags']))

/**
 * 一个观察"长得像不像标签"。
 *
 * 词表查不到不等于不能用：`hips tilted`、`arm bent` 这类 2–3 词的短语，SDXL 系模型
 * 是当标签读的，写进 tag 版不会摊薄别的词。真正毁句子的是
 * `arm outstretched toward viewer` 这种带介词、像半句话的长片段。
 * 所以这里只挡"长句/散文"，不挡"短而具体的短语"——否则一张信息量很大的图会被
 * 摘得只剩二十来个词，而用户要的是两个完整的版本，不是一个残缺一个完整。
 */
const TAG_MAX_WORDS = 3
const TAG_FUNCTION_WORDS = new Set([
  'the', 'a', 'an', 'of', 'on', 'in', 'at', 'with', 'from', 'to', 'and', 'or',
  'is', 'are', 'was', 'were', 'be', 'been', 'by', 'for', 'into', 'onto', 'over',
  'under', 'near', 'across', 'along', 'through', 'while', 'as', 'than', 'that',
  'this', 'these', 'those', 'his', 'her', 'its', 'their', 'which', 'who',
])

export function isTagShaped(text) {
  const words = String(text ?? '')
    .replace(/_/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0 || words.length > TAG_MAX_WORDS) return false
  return !words.some((word) => TAG_FUNCTION_WORDS.has(word.toLowerCase()))
}

/**
 * 形态提示：只说"这串字在标签版里读起来像什么"，不说"它对不对"。
 *
 * 词数、介词、下划线都只是排版层面的信号。它们能提示"这串字塞进逗号分隔的标签流会
 * 被读成半句话"，但既不能证明一条观察有效，也不能证明它无效——`hand_on_own_chest`
 * 含介词却是真实存在的热门标签，`sword sheathed at hip` 是完整观察但不是标签。
 */
export function describeFormat(text) {
  const words = String(text ?? '')
    .replace(/_/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const functionWords = words.filter((word) => TAG_FUNCTION_WORDS.has(word.toLowerCase()))
  return {
    words: words.length,
    underscores: /_/.test(String(text ?? '')),
    function_words: [...new Set(functionWords.map((word) => word.toLowerCase()))],
    tag_shaped: isTagShaped(text),
  }
}

function shouldDropUnknown(term, profile, kbStatus) {
  const mapping = profile?.tag_mapping ?? {}
  if (mapping.preserve_unknown_observations === false) return true
  if ((mapping.unknown_tag_policy ?? 'keep_as_description') !== 'drop') return false
  return kbStatus === 'miss' || kbStatus === 'skipped' || kbStatus === 'not_queried'
}

/**
 * 单个词条的来源分类。只回答"这个写法从哪来"，不回答"它管不管用"。
 *
 * 这两件事以前混在一起：词库没命中就被当成词条无效，于是未验证的自然语言短语
 * 被当成噪声。可它只是"没有官方出处"，不是"模型读不懂"。
 */
const TAG_SOURCES = Object.freeze({
  KB_CANONICAL: 'kb_canonical',
  KB_ALIAS: 'kb_alias',
  PROFILE: 'profile',
  RELATION: 'relation',
  UNVERIFIED_PHRASE: 'unverified_phrase',
})

export { TAG_SOURCES }

function tagSourceOf(term, kbStatus) {
  if (term?.source === 'profile' || term?.source === 'user') return TAG_SOURCES.PROFILE
  if (term?.origin === 'relation') return TAG_SOURCES.RELATION
  if (kbStatus === 'hit') {
    return term?.kb?.via_alias ? TAG_SOURCES.KB_ALIAS : TAG_SOURCES.KB_CANONICAL
  }
  return TAG_SOURCES.UNVERIFIED_PHRASE
}

/**
 * 词库健康状态的一句话说明。
 *
 * 四种"查不到"要分开讲：词表里没有这个词（正常）、词表是空的、目标数据源没配、
 * 读库失败。旧实现把它们都说成"知识库不认这个标签"，报告里就变成了"标签无效"。
 */
function knowledgeHealthMessage(health) {
  const sources = Array.isArray(health?.local_sources) ? health.local_sources : []
  const sourceList = sources.length > 0 ? sources.join('、') : '（无）'
  if (health?.state === 'empty') {
    return `知识库可用但目标数据源是空的：${sourceList} 里没有任何标签。本次分析没有做归一与分类补全；这不代表这些观察无效。`
  }
  if (health?.state === 'source_missing') {
    return '知识库里没有启用的本地数据源，本次分析没有做标签归一与分类补全。标签按观察原样保留。'
  }
  if (health?.state === 'lookup_failed') {
    return `读取知识库时出错（${health?.error ?? '未知错误'}），本次分析没有做标签归一与分类补全。`
  }
  return `知识库不可用（状态 ${health?.state ?? 'unknown'}），本次分析没有做标签归一与分类补全。`
}

export async function resolveTerms(terms, { kb = null, profile = {}, signal = null } = {}) {
  const diagnostics = []
  const stats = {
    looked_up: 0,
    hits: 0,
    misses: 0,
    unavailable: 0,
    aliases_normalized: 0,
    aliases_blocked: 0,
    dropped_meta: 0,
    categories_adopted: 0,
    dropped_unknown: 0,
    description_routed: 0,
    description_only: 0,
    lossy_projections: 0,
    unmapped: 0,
    studio_hints: 0,
    tag_sources: { kb_canonical: 0, kb_alias: 0, profile: 0, relation: 0, unverified_phrase: 0 },
    kb_health: null,
  }

  const mapping = profile?.tag_mapping ?? {}
  const categoryOverrides = normalizeOverrides(mapping.category_overrides)
  const excluded = new Set(Array.isArray(mapping.excluded_categories) ? mapping.excluded_categories : [])
  const normalizeAliases = mapping.normalize_aliases !== false
  const projections = normalizeProjections(mapping.lossy_projections)

  const lookupTargets = terms.filter((term) => term.text && !term.description)
  const byText = new Map()
  let kbHealth = null
  if (kb && lookupTargets.length > 0) {
    const task = kb.beginTask({ signal })
    kbHealth = task.health ?? null
    const results = await task.lookupMany([...new Set(lookupTargets.map((term) => term.text))])
    for (const result of results) {
      if (!result?.normalized) continue
      byText.set(result.normalized, result)
      if (result.status === 'hit') stats.hits += 1
      else if (result.status === 'miss') stats.misses += 1
      else stats.unavailable += 1
    }
    stats.looked_up = results.length
    for (const item of task.diagnostics ?? []) diagnostics.push(item)
    if (kbHealth && kbHealth.state !== 'available') {
      diagnostics.push(
        diagnostic({
          error_code: RESOLVE_CODES.SOURCE_UNAVAILABLE,
          severity: SEVERITY.WARNING,
          message: knowledgeHealthMessage(kbHealth),
          suggested_fix: '用 diagnose_knowledge_base 检查数据库与数据源；离线标签索引可以用 scripts/import-tags.mjs 导入。',
        }),
      )
    }
  } else if (lookupTargets.length > 0) {
    kbHealth = { state: 'unavailable', local_sources: [], tag_count: 0, alias_count: 0 }
    diagnostics.push(
      diagnostic({
        error_code: RESOLVE_CODES.NO_KNOWLEDGE_BASE,
        severity: SEVERITY.WARNING,
        message: '知识库不可用，本次分析没有做标签归一、别名转换与分类补全，标签按视觉模型给的原样保留。',
        suggested_fix: '用 diagnose_knowledge_base 检查数据库与数据源；离线标签索引可以用 scripts/import-tags.mjs 导入。',
      }),
    )
  }

  const kept = []
  for (const term of terms) {
    if (!term.text) {
      if (term.description) stats.description_routed += 1
      kept.push(term)
      continue
    }

    const result = byText.get(term.text) ?? null
    // 工作室补充词典命中不算"这个模型的词表里有这个词"。它解释得清楚，
    // 但不替模型词表背书：对编译来说等同 miss，只是额外记一条提示。
    // 这样开了 studio 之后，只要没显式打开 fallback，分析结果一个字都不变。
    const studioHint = result?.status === 'hit' && result.source === 'studio' ? result : null
    // 三种"没命中"必须分开：miss = 问过词表，词表里没有这个词；
    // not_queried = 我们没问（没词库、词库空、数据源没配、读库失败）。
    // 旧实现把两者都写成 skipped，于是"词库没装"和"词表没收录"在报告里长得一样。
    const kbStatus = studioHint ? 'miss' : (result?.status ?? 'not_queried')
    term.kb = result
      ? {
          status: kbStatus,
          source: result.source ?? null,
          source_id: result.source_id ?? result.tag?.source_id ?? null,
          tag_id: result.tag?.id ?? null,
          // 补充词典命中的分类不参与补全：那是别人的分类体系，不是这个模型的词表分类。
          canonical_name: studioHint ? null : (result.tag?.name ?? null),
          native_category: studioHint ? null : (result.tag?.native_category ?? null),
          categories: studioHint || !Array.isArray(result.tag?.categories) ? [] : result.tag.categories,
          via_alias: studioHint ? false : result.via_alias === true,
          stale: result.stale === true,
          fallback: studioHint !== null,
          reason: studioHint ? 'studio_fallback' : (result.reason ?? null),
        }
      : {
          status: 'not_queried',
          source: null,
          source_id: null,
          tag_id: null,
          canonical_name: null,
          native_category: null,
          categories: [],
          via_alias: false,
          stale: false,
          fallback: false,
          reason: kb ? 'not_looked_up' : 'no_knowledge_base',
        }

    if (studioHint) {
      const zhName = studioHint.tag?.zh_name ?? null
      const deprecated = Number(studioHint.tag?.deprecated ?? 0) === 1
      term.kb.studio = {
        tag_id: studioHint.tag?.id ?? null,
        // 命中的是哪一路数据源（studio-tags 之类）。解释要能指回具体来源，
        // 否则"补充词典认出了它"这句话无法核对。
        source_id: studioHint.source_id ?? studioHint.tag?.source_id ?? null,
        via_alias: studioHint.via_alias === true,
        name: studioHint.tag?.name ?? null,
        zh_name: zhName,
        native_category: studioHint.tag?.native_category ?? null,
        tag_group: studioHint.tag?.tag_group ?? null,
        translation_status: studioHint.tag?.translation_status ?? null,
        deprecated,
      }
      stats.studio_hints += 1
      diagnostics.push(
        diagnostic({
          error_code: RESOLVE_CODES.STUDIO_HINT,
          severity: SEVERITY.INFO,
          message: `工作室词典认出了 ${term.text}${zhName ? `（${zhName}）` : ''}${deprecated ? '，但该词条在源库里已标记为废弃' : ''}。它不在当前模型的词表里，仍按未验证写法处理。`,
          suggested_fix: null,
        }),
      )
    }

    if (kbStatus === 'hit' && normalizeAliases && term.kb.canonical_name && term.kb.canonical_name !== term.text) {
      if (NON_EMITTABLE_TAGS.has(normalizeTagName(term.kb.canonical_name))) {
        // 原词是能用的画面词，只是被塞进了 bad_tag 这种汇总桶的别名里。改名会把正向写坏，
        // 所以保留原词，只记一条诊断。
        stats.aliases_blocked += 1
        diagnostics.push(
          diagnostic({
            error_code: RESOLVE_CODES.ALIAS_BLOCKED,
            severity: SEVERITY.INFO,
            message: `标签 ${term.text} 在知识库里被归到 ${term.kb.canonical_name}（“不建议使用”汇总桶），保留原词，不按别名改名。`,
          }),
        )
      } else {
        term.notes.push(`别名归一：${term.text} → ${term.kb.canonical_name}`)
        // 记下原名：还原分对账要拿观察里的原话去比提示词里的新词，没有这张表就永远对不上。
        term.alias_from = term.text
        term.text = term.kb.canonical_name
        stats.aliases_normalized += 1
        diagnostics.push(
          diagnostic({
            error_code: RESOLVE_CODES.ALIAS_NORMALIZED,
            severity: SEVERITY.INFO,
            message: `标签 ${result.query ?? ''} 已按知识库归一为 ${term.kb.canonical_name}。`,
          }),
        )
      }
    }

    if (NON_EMITTABLE_TAGS.has(normalizeTagName(term.text))) {
      term.dropped = 'meta_tag'
      stats.dropped_meta += 1
      diagnostics.push(
        diagnostic({
          error_code: RESOLVE_CODES.META_TAG_DROPPED,
          severity: SEVERITY.INFO,
          message: `${term.text} 是标签表里的元标签桶，不是画面特征，未写入提示词。`,
        }),
      )
      kept.push(term)
      continue
    }

    const adopted = adoptCategory(term, categoryOverrides)
    if (adopted) stats.categories_adopted += 1

    // 来源分类：只记"这个写法从哪来"。它和"这个写法管不管用"是两件事，
    // 所以这里不参与任何取舍，只落一个可追溯的字段。
    term.tag_source = tagSourceOf(term, kbStatus)
    stats.tag_sources[term.tag_source] = (stats.tag_sources[term.tag_source] ?? 0) + 1

    // 有损投影：声明过的映射才会生效，且必须记下丢掉了什么。
    // 没有可靠映射时保持 unmapped —— 宁可让完整观察留在描述版，也不许静默替换。
    const projection = projectionFor(term.text, projections)
    if (projection) {
      term.notes.push(`有损投影：${term.text} → ${projection.to}（未表达：${projection.dropped.join('、') || '无'}）`)
      term.lossy_projection = {
        from: term.text,
        to: projection.to,
        dropped: projection.dropped,
        source: projection.source,
      }
      // 注意：不写 alias_from。alias_from 表示"同一事实的另一个名字"，
      // 有损投影丢掉了一部分事实，混进去会让还原对账误以为信息没丢。
      term.text = normalizeTagName(projection.to)
      stats.lossy_projections += 1
      diagnostics.push(
        diagnostic({
          error_code: RESOLVE_CODES.LOSSY_PROJECTION,
          severity: SEVERITY.INFO,
          message: `观察 ${projection.from} 只被投影成 ${projection.to}，未表达：${projection.dropped.join('、') || '无'}。完整观察仍在描述版。`,
        }),
      )
    } else if (kbStatus !== 'hit' && !isTagShaped(term.text)) {
      // 没有可靠映射、又不是标签形态：保留完整描述并明确标记未映射。
      term.unmapped = true
      stats.unmapped += 1
    }

    if (kbStatus !== 'hit') {
      term.unknown = true
      if (shouldDropUnknown(term, profile, kbStatus)) {
        term.dropped = 'unknown_tag'
        stats.dropped_unknown += 1
        kept.push(term)
        continue
      }
      // 形态判断只是格式提示，不是有效性证明：它只说"这串字塞进逗号分隔的标签流
      // 会被读成半句话"，不说"这条观察没用"。
      //
      // 分流的范围保持冻结基线的口径：只有真的问过词表、而词表里没有这个词时，
      // 才把它从标签流里摘到描述版。词库不可用时（`kb === null`）不摘——那种情况下
      // 我们没有依据判断"词表不认"，摘掉等于凭猜测丢信息。这条口径没变，变的是
      // 现在会把这种状态如实记下来（见下面的 UNVERIFIED_IN_TAGS 与 kb_health）。
      if ((mapping.unknown_tag_policy ?? 'keep_as_description') === 'description_only' && kb !== null && !isTagShaped(term.text)) {
        // 只从标签流里摘掉，不丢弃：描述版还要靠它表达动作与朝向。
        term.excluded_from_tags = true
        term.format_hint = { reason: 'phrase_not_tag_shaped', ...describeFormat(term.text) }
        stats.description_only += 1
        kept.push(term)
        continue
      }
      if (kbStatus === 'miss' && (mapping.unknown_tag_policy ?? 'keep_as_description') === 'warn') {
        diagnostics.push(
          diagnostic({
            error_code: RESOLVE_CODES.UNKNOWN_TAG,
            severity: SEVERITY.WARNING,
            message: `知识库不认这个标签：${term.text}（分类 ${term.category}）。已保留原文，但它的写法与权重都没有依据。`,
            suggested_fix: '确认这是不是 Danbooru 上真实存在的标签；也可以把它加进本地标签索引。',
          }),
        )
      }
      if (kbStatus === 'unavailable') {
        diagnostics.push(
          diagnostic({
            error_code: RESOLVE_CODES.SOURCE_UNAVAILABLE,
            severity: SEVERITY.WARNING,
            message: `标签 ${term.text} 没能查到：数据源没有答上来（不是"不存在"）。已按原文保留。`,
            suggested_fix: '检查网络与数据源配置；离线标签索引不依赖网络。',
          }),
        )
      }
    } else {
      term.unknown = false
    }

    if (excluded.has(term.category)) {
      term.dropped = 'excluded_category'
    }

    kept.push(term)
  }

  // 词库不可用时，长句按冻结基线口径留在标签版里。这不是"它是规范标签"，
  // 只是"我们没有依据把它摘走"。这条诊断把话说清楚：它是未验证短语，不是官方标签。
  const unverifiedInTags = kept.filter(
    (term) =>
      term.tag_source === TAG_SOURCES.UNVERIFIED_PHRASE &&
      !term.dropped &&
      term.excluded_from_tags !== true &&
      !isTagShaped(term.text),
  )
  stats.unverified_in_tags = unverifiedInTags.length
  if (unverifiedInTags.length > 0) {
    diagnostics.push(
      diagnostic({
        error_code: RESOLVE_CODES.UNVERIFIED_IN_TAGS,
        severity: SEVERITY.INFO,
        message: `标签版里有 ${unverifiedInTags.length} 条带介词的短语没有词库出处（${unverifiedInTags
          .slice(0, 6)
          .map((term) => term.text)
          .join('、')}${unverifiedInTags.length > 6 ? ' 等' : ''}）。它们只是未验证的自然语言短语，不是规范标签。`,
        suggested_fix: '想让标签版只留词表认得的词，就导入离线标签索引；想保留这些说法，描述版已经完整表达了同一批观察。',
      }),
    )
  }

  stats.kb_health = kbHealth ? { ...kbHealth } : null
  return { terms: kept, diagnostics, stats }
}

function normalizeOverrides(overrides) {
  const out = new Map()
  if (!overrides || typeof overrides !== 'object') return out
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== 'string' || value.length === 0) continue
    out.set(normalizeTagName(key), value)
  }
  return out
}

/**
 * 有损投影表：只接受显式声明、且标明来源的映射。
 *
 * 为什么不自动生成：编辑距离、共享名词、检索相似度都能把 `sword sheathed at hip`
 * 连到 `sword`，但这一步会把"佩在髋侧"整条丢掉，而它正是还原这张图最要紧的信息。
 * 所以没有可靠映射时保持未映射，把完整观察留给描述版。
 */
function normalizeProjections(declared) {
  const out = new Map()
  if (!Array.isArray(declared)) return out
  for (const rule of declared) {
    const from = normalizeTagName(rule?.from)
    const to = normalizeTagName(rule?.to)
    if (!from || !to) continue
    const source = String(rule?.source ?? 'unverified')
    // 与 rewrite 层同一套纪律：未验证的映射不生效。
    if (source !== 'official' && source !== 'manual') continue
    if (out.has(from)) continue
    const dropped = Array.isArray(rule?.dropped) ? rule.dropped.map((item) => String(item).trim()).filter(Boolean) : []
    out.set(from, { to, dropped, source })
  }
  return out
}

function projectionFor(text, projections) {
  if (!projections || projections.size === 0) return null
  return projections.get(normalizeTagName(text)) ?? null
}

function adoptCategory(term, overrides) {
  const override = overrides.get(term.text)
  if (override) {
    if (term.category !== override) {
      term.category = override
      term.layer = layerOf(override)
      term.notes.push(`分类被 profile 的 category_overrides 指定为 ${override}`)
      return true
    }
    return false
  }
  if (term.category === 'unsorted' && term.kb?.categories?.length > 0) {
    const found = pickKbCategory(term.kb.categories)
    if (found) {
      term.category = found
      term.layer = layerOf(found)
      term.notes.push(`分类由知识库补全为 ${found}`)
      return true
    }
  }
  return false
}

// 知识库的 categories 是 [{ category, confidence }]，不是字符串数组。
// 早先这里直接把元素当字符串赋给 term.category，结果 term.category 变成对象，
// 而 compose 层拿它当 Map 键和字符串比对（all(groups, ['appearance','unsorted'])），
// 于是这些词一条分组都匹配不上，等于从标签版和描述版里同时消失——佩剑就是这样丢的。
function pickKbCategory(categories) {
  for (const entry of categories) {
    const id = typeof entry === 'string' ? entry : entry?.category
    if (id && id !== 'unsorted' && CATEGORY_IDS.has(id)) return id
  }
  return null
}
