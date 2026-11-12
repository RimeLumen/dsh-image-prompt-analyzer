
import { NULL_LOGGER } from '../log.js'
import { findAlias, findTag, decorateTags } from './store.js'
import { normalizeTagName } from './normalize.js'
import { createTaskLookup } from './query/task.js'
import { KB_HEALTH, LOOKUP_MODES, LOOKUP_SOURCE } from './query/result.js'
import { SOURCE_ROLES, isSupplementRole, resolveSourceRoles } from './role.js'

export { SOURCE_ROLES }

export {
  LOOKUP_STATUS,
  LOOKUP_SOURCE,
  LOOKUP_MODES,
  LOOKUP_REASONS,
  LOOKUP_MATCH,
  KB_HEALTH,
  KB_HEALTH_CODES,
} from './query/result.js'

const BATCH_CHUNK = 400

export function createKnowledgeBase({ handle, config = {}, logger = NULL_LOGGER } = {}) {
  const sources = Array.isArray(config.sources) ? config.sources : []
  // 角色而不是类型决定"这个词算不算数"：随包中文对照表是 local_file，
  // 但它只是词典，不该替模型词表判定任何词。
  const roles = resolveSourceRoles(sources, { handle })
  const enabled = sources.filter((source) => source.enabled !== false)
  const localSourceIds = enabled
    .filter((source) => !isSupplementRole(roles.get(String(source.source_id))))
    .map((source) => String(source.source_id))
  const studioSourceIds = enabled
    .filter((source) => isSupplementRole(roles.get(String(source.source_id))))
    .map((source) => String(source.source_id))

  // 补充词典默认只在"检索与解释"里用。要让它参与编译，必须在配置里
  // 显式打开 lookup.studio_fallback —— 这是 P0-4 的硬要求：
  // 接了工作室数据以后，原来的分析结果一个字都不该变。
  const studioFallback = config?.lookup?.studio_fallback === true && studioSourceIds.length > 0

  const mode = studioFallback ? LOOKUP_MODES.LOCAL_WITH_STUDIO : LOOKUP_MODES.LOCAL_ONLY
  const restrictToLocalSources = localSourceIds.length > 0 ? localSourceIds : null
  const restrictToStudioSources = studioSourceIds.length > 0 ? studioSourceIds : null

  /**
   * 词库健康状态：开跑前判一次，用来区分"这个词表里没有"与"根本没有可查的词表"。
   *
   * 旧实现里这两种都是 miss，报告就会把正常 miss 读成"标签都无效"。
   * 这里只读一次 COUNT，不扫表，代价可以忽略。
   */
  let cachedHealth = null
  function health() {
    if (cachedHealth) return cachedHealth
    const base = {
      mode,
      local_sources: localSourceIds,
      studio_sources: studioSourceIds,
      studio_fallback: studioFallback,
      tag_count: 0,
      alias_count: 0,
      studio_tag_count: 0,
      error: null,
    }
    if (localSourceIds.length === 0 && studioSourceIds.length === 0) {
      cachedHealth = { ...base, state: KB_HEALTH.SOURCE_MISSING }
      return cachedHealth
    }
    if (!handle || typeof handle.get !== 'function') {
      cachedHealth = { ...base, state: KB_HEALTH.UNAVAILABLE }
      return cachedHealth
    }
    try {
      let tagCount = 0
      let aliasCount = 0
      if (localSourceIds.length > 0) {
        const placeholders = localSourceIds.map(() => '?').join(',')
        const tagRow = handle.get(`SELECT COUNT(*) AS n FROM tags WHERE source_id IN (${placeholders})`, ...localSourceIds)
        const aliasRow = handle.get(`SELECT COUNT(*) AS n FROM tag_aliases WHERE source_id IN (${placeholders})`, ...localSourceIds)
        tagCount = Number(tagRow?.n ?? 0)
        aliasCount = Number(aliasRow?.n ?? 0)
      }
      let studioTagCount = 0
      if (studioSourceIds.length > 0) {
        const placeholders = studioSourceIds.map(() => '?').join(',')
        const studioRow = handle.get(`SELECT COUNT(*) AS n FROM tags WHERE source_id IN (${placeholders})`, ...studioSourceIds)
        studioTagCount = Number(studioRow?.n ?? 0)
      }
      // 只开补充词典（studioFallback 打开、模型词表为空）时也算"可查"：
      // 这时查询会落到工作室词库上，命中一律标 fallback。若这里判 EMPTY，
      // 任务层会把所有查询标成 not_queried，补充词典就等于白接。
      const usable = tagCount > 0 || (studioFallback && studioTagCount > 0)
      cachedHealth = {
        ...base,
        tag_count: tagCount,
        alias_count: aliasCount,
        studio_tag_count: studioTagCount,
        state: usable ? KB_HEALTH.AVAILABLE : KB_HEALTH.EMPTY,
      }
      return cachedHealth
    } catch (error) {
      cachedHealth = {
        ...base,
        state: KB_HEALTH.LOOKUP_FAILED,
        error: error?.message ?? String(error),
      }
      return cachedHealth
    }
  }

  function lookupIn(sourceIds, name) {
    const tag = findTag(handle, name, { sourceIds })
    // 源库把已废弃的词留在表里但标了 deprecated；它们能解释，不能拿去改提示词。
    if (tag && Number(tag.deprecated ?? 0) === 0) return { tag, via_alias: false, alias: null }
    const alias = findAlias(handle, name, { sourceIds })
    if (alias?.tag && Number(alias.tag.deprecated ?? 0) === 0) return { tag: alias.tag, via_alias: true, alias: alias.alias }
    return null
  }

  function lookupLocal(name) {
    if (localSourceIds.length > 0) {
      const hit = lookupIn(restrictToLocalSources, name)
      if (hit) return { ...hit, source: LOOKUP_SOURCE.LOCAL, fallback: false }
    }
    if (studioFallback) {
      const hit = lookupIn(restrictToStudioSources, name)
      // 补充词典命中一律标 fallback：它解释得清楚，但不能替模型词表背书。
      if (hit) return { ...hit, source: LOOKUP_SOURCE.STUDIO, fallback: true }
    }
    return null
  }

  function batchLookupLocal(rawNames) {
    if (localSourceIds.length === 0 && !studioFallback) return new Map()
    const normalizedSet = new Set()
    for (const raw of rawNames ?? []) {
      const n = normalizeTagName(raw)
      if (n) normalizedSet.add(n)
    }
    const normalized = [...normalizedSet]
    if (normalized.length === 0) return new Map()
    const result = new Map()
    const modelHits = querySources(normalized, restrictToLocalSources)
    for (const [name, hit] of modelHits) {
      result.set(name, { ...hit, source: LOOKUP_SOURCE.LOCAL, fallback: false })
    }
    if (studioFallback) {
      const missing = normalized.filter((name) => !modelHits.has(name))
      if (missing.length > 0) {
        for (const [name, hit] of querySources(missing, restrictToStudioSources)) {
          result.set(name, { ...hit, source: LOOKUP_SOURCE.STUDIO, fallback: true })
        }
      }
    }
    return result
  }

  function querySources(names, sourceIds) {
    const out = new Map()
    if (!sourceIds || sourceIds.length === 0) return out
    const tagRows = []
    for (let i = 0; i < names.length; i += BATCH_CHUNK) {
      const chunk = names.slice(i, i + BATCH_CHUNK)
      const sql = `SELECT * FROM tags WHERE name IN (${chunk.map(() => '?').join(',')}) AND source_id IN (${sourceIds.map(() => '?').join(',')}) AND COALESCE(deprecated, 0) = 0 ORDER BY post_count DESC NULLS LAST`
      tagRows.push(...handle.all(sql, ...chunk, ...sourceIds))
    }

    const tagsByName = new Map()
    for (const row of tagRows) {
      const name = String(row.name)
      if (!tagsByName.has(name)) tagsByName.set(name, row)
    }

    const missing = names.filter((n) => !tagsByName.has(n))
    const aliasTagIds = new Set()
    const aliasByName = new Map()
    if (missing.length > 0) {
      for (let i = 0; i < missing.length; i += BATCH_CHUNK) {
        const chunk = missing.slice(i, i + BATCH_CHUNK)
        const sql = `SELECT * FROM tag_aliases WHERE alias IN (${chunk.map(() => '?').join(',')}) AND source_id IN (${sourceIds.map(() => '?').join(',')})`
        for (const row of handle.all(sql, ...chunk, ...sourceIds)) {
          const aliasName = String(row.alias)
          if (!aliasByName.has(aliasName)) {
            aliasByName.set(aliasName, row)
            aliasTagIds.add(Number(row.tag_id))
          }
        }
      }
    }

    const tagsById = new Map()
    if (aliasTagIds.size > 0) {
      const idList = [...aliasTagIds]
      for (let i = 0; i < idList.length; i += BATCH_CHUNK) {
        const chunk = idList.slice(i, i + BATCH_CHUNK)
        const sql = `SELECT * FROM tags WHERE id IN (${chunk.map(() => '?').join(',')})`
        for (const row of handle.all(sql, ...chunk)) {
          tagsById.set(Number(row.id), row)
        }
      }
    }

    const allRows = [...tagsByName.values(), ...[...aliasByName.values()].map((ar) => tagsById.get(Number(ar.tag_id))).filter(Boolean)]
    if (allRows.length === 0) return out
    const decorated = decorateTags(handle, allRows)
    const decoratedById = new Map(decorated.map((tag) => [Number(tag.id), tag]))

    for (const [name, row] of tagsByName) {
      const tag = decoratedById.get(Number(row.id))
      if (tag) out.set(name, { tag, via_alias: false, alias: null })
    }
    for (const [aliasName, aliasRow] of aliasByName) {
      const tag = decoratedById.get(Number(aliasRow.tag_id))
      if (tag && Number(tag.deprecated ?? 0) === 0) out.set(aliasName, { tag, via_alias: true, alias: aliasName })
    }
    return out
  }

  /**
   * 中文检索：只在补充词典里查。
   *
   * 这是接工作室数据最安全的一种用法——它不改变任何一条提示词的输出，
   * 只是让人能问"这个词中文叫什么""这个中文词对应哪个标签"。
   */
  function searchStudio(query, { limit = 20 } = {}) {
    if (!handle || studioSourceIds.length === 0) return []
    const text = String(query ?? '').trim()
    if (!text) return []
    const like = `%${text.replace(/[%_]/g, (char) => `\\${char}`)}%`
    const placeholders = studioSourceIds.map(() => '?').join(',')
    return decorateTags(
      handle,
      handle.all(
        `SELECT * FROM tags
         WHERE source_id IN (${placeholders})
           AND (zh_name LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')
         ORDER BY deprecated ASC, post_count DESC NULLS LAST
         LIMIT ?`,
        ...studioSourceIds,
        like,
        like,
        Number(limit),
      ),
    )
  }

  void logger
  const taskLookup = createTaskLookup({ mode, localSourceIds, lookupLocal, batchLookupLocal, health })

  /**
   * 丢掉健康状态缓存。
   *
   * health() 会缓存结果，因为它被每个任务调一次、而 COUNT(*) 不该重复跑。
   * 但"缓存"在这里有个副作用：先 diagnose（缓存 empty）再 rebuild（真的写进了十几万行），
   * 同一个进程里后续每个查询都会继续拿到 empty，于是全部退化成
   * not_queried / kb_empty —— 标签版永远用不上词库，直到插件重启。
   * 重建完成后必须显式清一次，这条链才算闭合。
   */
  function refreshHealth() {
    cachedHealth = null
  }

  return {
    beginTask: taskLookup.beginTask,
    mode,
    localSourceIds,
    studioSourceIds,
    studioFallback,
    roles: Object.fromEntries(roles),
    health,
    refreshHealth,
    searchStudio,
  }
}
