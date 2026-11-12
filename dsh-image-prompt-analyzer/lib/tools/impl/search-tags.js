import { SEVERITY, TASK_STATUS, diagnostic, envelope } from '../../diagnostics.js'
import { SEARCH_CODES, SEARCH_DEPRECATED, searchKnowledge } from '../../kb/search.js'
import { findStudioCategoriesByName } from '../../kb/store.js'
import { searchTree, treePath } from '../../kb/tree.js'
import { studioTreeFor } from './studio-source.js'

const SEARCH_TOOL_CODES = Object.freeze({
  QUERY_REQUIRED: 'KB_SEARCH_QUERY_REQUIRED',
  KNOWLEDGE_UNAVAILABLE: 'KB_SEARCH_KNOWLEDGE_UNAVAILABLE',
  TREE_UNAVAILABLE: 'KB_SEARCH_TREE_UNAVAILABLE',
  NO_RESULTS: 'KB_SEARCH_NO_RESULTS',
  CATEGORY_NOT_FOUND: 'KB_SEARCH_CATEGORY_NOT_FOUND',
  PROFILE_VOCAB_UNKNOWN: 'KB_SEARCH_PROFILE_VOCAB_UNKNOWN',
})

/**
 * 档案 → 模型词表。
 *
 * 这里故意只做"源名里带哪个家族"的粗匹配：词表本身不声明自己服务哪个档案，
 * 硬写死一张 source_id 映射表会在换词表时悄悄失效。匹配不到就退回全部模型词表并说一声，
 * 而不是给一个空结果让人以为"这个词不存在"。
 */
const PROFILE_VOCAB_HINTS = Object.freeze({
  anima: ['anima', 'animagine'],
  animagine: ['anima', 'animagine'],
  illustrious: ['illustrious'],
  moss: [],
})

function sourcesForProfile(profile, sourceIds) {
  if (!profile) return { ids: sourceIds, matched: true, tokens: [] }
  const key = String(profile).trim().toLowerCase()
  const tokens = PROFILE_VOCAB_HINTS[key]
  if (!tokens) return { ids: sourceIds, matched: false, tokens: [] }
  if (tokens.length === 0) return { ids: [], matched: true, tokens }
  const matched = sourceIds.filter((id) => tokens.some((token) => String(id).toLowerCase().includes(token)))
  return matched.length > 0 ? { ids: matched, matched: true, tokens } : { ids: sourceIds, matched: false, tokens }
}

function compactHit(hit) {
  const tag = hit.tag
  return {
    tag: tag.name,
    zh_name: tag.zh_name,
    aliases: tag.aliases ?? [],
    source: hit.source,
    source_id: tag.source_id,
    match: hit.match,
    matched_field: hit.matched_field,
    native_category: tag.native_category,
    kind: tag.kind,
    post_count: tag.post_count,
    tag_group: tag.tag_group,
    translation_status: tag.translation_status,
    deprecated: Number(tag.deprecated ?? 0) === 1,
    model_overlap: tag.model_overlap === true,
    model_sources: tag.model_sources ?? [],
    studio_categories: (tag.studio_categories ?? []).map((item) => item.name).filter(Boolean),
  }
}

function countBy(results, key) {
  const out = {}
  for (const item of results) out[item[key]] = (out[item[key]] ?? 0) + 1
  return out
}

export async function runSearchTags(runtime, args = {}) {
  const diagnostics = []
  const query = String(args.query ?? '').trim()
  const scope = ['tags', 'tree', 'both'].includes(args.scope) ? args.scope : 'tags'
  if (query === '') {
    return envelope({
      status: TASK_STATUS.FAILED,
      diagnostics: [
        diagnostic({
          error_code: SEARCH_TOOL_CODES.QUERY_REQUIRED,
          severity: SEVERITY.ERROR,
          field_path: '/query',
          message: '没有给出检索词。',
          suggested_fix: '传一个中文或英文关键词，例如「女仆」或 maid。',
        }),
      ],
    })
  }

  // 三种 scope 都要打开本地知识库：tree 也要拿句柄，分类树在库里不在文件里。
  let bundle = null
  {
    try {
      bundle = await runtime.getKnowledgeBase()
    } catch (error) {
      diagnostics.push(
        diagnostic({
          error_code: error?.code ?? SEARCH_TOOL_CODES.KNOWLEDGE_UNAVAILABLE,
          severity: SEVERITY.ERROR,
          message: `标签知识库不可用，无法检索：${error?.message ?? error}`,
          suggested_fix: error?.suggested_fix ?? '运行 diagnose_knowledge_base 查看库文件与数据源状态。',
        }),
      )
    }
  }

  const extra = { query, scope, results: [], total: 0, by_source: {}, by_match: {}, mode: null, tree: null }
  // scope=tree 只翻分支，不查词表：这里故意不进检索分支。
  if (bundle && scope !== 'tree') {
    const { kb, handle } = bundle

    // 分类过滤：传名字就按名字找分支（同名的可能有几个），传 ID 就直接用。
    const requestedCategory = args.category === undefined || args.category === null ? null : String(args.category).trim()
    let categoryFilter = null
    const categoryInfo = { requested: requestedCategory, matched: [] }
    if (requestedCategory !== null && requestedCategory !== '' && kb.studioSourceIds.length > 0) {
      const matched = []
      for (const sourceId of kb.studioSourceIds) {
        const byId = findStudioCategoriesByName(handle, sourceId, requestedCategory, { limit: 1 }).filter(
          (item) => item.studio_id === requestedCategory,
        )
        const rows = byId.length > 0 ? byId : findStudioCategoriesByName(handle, sourceId, requestedCategory, { limit: 20 })
        for (const row of rows) matched.push({ ...row, source_id: sourceId })
      }
      if (matched.length === 0) {
        diagnostics.push(
          diagnostic({
            error_code: SEARCH_TOOL_CODES.CATEGORY_NOT_FOUND,
            severity: SEVERITY.WARNING,
            field_path: '/category',
            message: `没有找到名为「${requestedCategory}」的工作室分类，本次不按分类过滤。`,
            suggested_fix: '用 scope:"tree" 先看分类树里有哪些分支名，或直接传分类 ID。',
          }),
        )
      } else {
        categoryFilter = { sourceIds: kb.studioSourceIds, studioIds: matched.map((item) => item.studio_id) }
        categoryInfo.matched = matched.map((item) => ({
          studio_id: item.studio_id,
          name: item.name,
          depth: item.depth,
          tag_count: item.tag_count,
        }))
      }
    }

    // 档案过滤只收窄模型词表那一侧：补充词典不区分档案，它解释的是词本身。
    const profile = args.profile === undefined || args.profile === null ? null : String(args.profile).trim()
    const profileVocab = sourcesForProfile(profile, kb.localSourceIds)
    if (profile && !profileVocab.matched) {
      diagnostics.push(
        diagnostic({
          error_code: SEARCH_TOOL_CODES.PROFILE_VOCAB_UNKNOWN,
          severity: SEVERITY.INFO,
          field_path: '/profile',
          message: `没有认出档案「${profile}」对应的模型词表，本次模型词表侧不过滤。`,
          suggested_fix: '可用的档案名见 configs/model-profiles；词表按数据源名里的家族名匹配。',
        }),
      )
    }

    const deprecatedMode = [SEARCH_DEPRECATED.EXCLUDE, SEARCH_DEPRECATED.ONLY, SEARCH_DEPRECATED.INCLUDE].includes(args.deprecated)
      ? args.deprecated
      : args.include_deprecated === true
        ? SEARCH_DEPRECATED.INCLUDE
        : SEARCH_DEPRECATED.EXCLUDE

    const search = searchKnowledge(handle, {
      query,
      limit: args.limit ?? 10,
      modelSourceIds: profileVocab.ids,
      studioSourceIds: kb.studioSourceIds,
      deprecated: deprecatedMode,
      translationStatus: args.translation_status ?? null,
      studioCategory: categoryFilter,
    })
    if (search.error === SEARCH_CODES.EMPTY_QUERY) {
      diagnostics.push(
        diagnostic({
          error_code: SEARCH_CODES.EMPTY_QUERY,
          severity: SEVERITY.ERROR,
          field_path: '/query',
          message: '检索词归一化后为空。',
          suggested_fix: '换成包含字母、数字或汉字的词。',
        }),
      )
    } else if (search.error === SEARCH_CODES.NO_SOURCES) {
      diagnostics.push(
        diagnostic({
          error_code: SEARCH_CODES.NO_SOURCES,
          severity: SEVERITY.WARNING,
          message: '没有启用的数据源，本次检索没有可查的词表。',
          suggested_fix: '在 knowledge-base 配置里启用至少一个 local_file 或 studio_sqlite 数据源。',
        }),
      )
    } else if (search.error === SEARCH_CODES.QUERY_FAILED) {
      diagnostics.push(
        diagnostic({
          error_code: SEARCH_CODES.QUERY_FAILED,
          severity: SEVERITY.ERROR,
          message: `检索失败：${search.error_detail ?? ''}`,
          suggested_fix: '运行 diagnose_knowledge_base 确认库结构完整。',
        }),
      )
    }

    extra.results = search.results.map(compactHit)
    extra.total = search.total
    extra.truncated = search.truncated
    extra.mode = kb.mode
    extra.by_source = countBy(extra.results, 'source')
    extra.by_match = countBy(extra.results, 'match')
    extra.model_sources = kb.localSourceIds
    extra.studio_sources = kb.studioSourceIds
    extra.studio_fallback = kb.studioFallback === true
    extra.deprecated = deprecatedMode
    extra.category = categoryInfo
    extra.profile = profile ? { requested: profile, model_sources: profileVocab.ids, matched: profileVocab.matched } : null
    extra.overlap_count = extra.results.filter((item) => item.model_overlap).length
    if (extra.results.length === 0 && diagnostics.length === 0) {
      // 查不到不是错误：换一种说法就能查到的情况占多数。
      diagnostics.push(
        diagnostic({
          error_code: SEARCH_TOOL_CODES.NO_RESULTS,
          severity: SEVERITY.INFO,
          message: `没有查到含「${query}」的词。`,
          suggested_fix: '换一个更短的关键词，或改用英文标签名；也可以先看分类树里有哪些分支。',
        }),
      )
    }
  }

  if (scope !== 'tags') {
    // 分类树读的是本地知识库里已经导入的层级，不读工作室目录。
    // 迁移导入过一次之后，原目录在不在都不影响这里。
    const tree = studioTreeFor(bundle?.config ?? null, runtime.logger, { handle: bundle?.handle ?? null })
    if (!tree.ok) {
      diagnostics.push(
        diagnostic({
          error_code: SEARCH_TOOL_CODES.TREE_UNAVAILABLE,
          severity: SEVERITY.INFO,
          message: '本地知识库里还没有工作室分类树，本次只返回标签检索结果。',
          suggested_fix:
            '把工作室词库导入一次就有了：knowledge-base 配置里加一个 studio_sqlite 源（path 指向 tags.sqlite），然后运行 rebuild_knowledge_base。导入之后原目录可以不再需要。',
        }),
      )
      extra.tree = { ok: false, revision: null, stats: null, hits: [] }
    } else {
      const hits = searchTree(tree, query, { limit: args.limit ?? 10 })
      extra.tree = {
        ok: true,
        source: tree.source ?? null,
        revision: tree.revision,
        stats: tree.stats,
        root: tree.rootId ? { id: tree.rootId, name: tree.nodes.get(tree.rootId)?.name ?? null } : null,
        hits,
      }
      // 命中的分支补一条完整路径，省掉调用方再问一次"这个节点在哪一层"。
      extra.tree.hits = hits.map((hit) => ({ ...hit, path: treePath(tree, hit.id).map((item) => item.name) }))
    }
  }

  return envelope({ diagnostics, extra })
}
