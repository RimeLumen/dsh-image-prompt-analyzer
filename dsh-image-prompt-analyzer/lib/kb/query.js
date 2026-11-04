
import { NULL_LOGGER } from '../log.js'
import { findAlias, findTag, decorateTags } from './store.js'
import { normalizeTagName } from './normalize.js'
import { createTaskLookup } from './query/task.js'
import { KB_HEALTH, LOOKUP_MODES } from './query/result.js'

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
  const localSourceIds = sources
    .filter((source) => source.enabled !== false && (source.type === 'local_file' || source.type === 'local_sqlite'))
    .map((source) => String(source.source_id))

  const mode = LOOKUP_MODES.LOCAL_ONLY
  const restrictToLocalSources = localSourceIds.length > 0 ? localSourceIds : null

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
      tag_count: 0,
      alias_count: 0,
      error: null,
    }
    if (localSourceIds.length === 0) {
      cachedHealth = { ...base, state: KB_HEALTH.SOURCE_MISSING }
      return cachedHealth
    }
    if (!handle || typeof handle.get !== 'function') {
      cachedHealth = { ...base, state: KB_HEALTH.UNAVAILABLE }
      return cachedHealth
    }
    try {
      const placeholders = localSourceIds.map(() => '?').join(',')
      const tagRow = handle.get(`SELECT COUNT(*) AS n FROM tags WHERE source_id IN (${placeholders})`, ...localSourceIds)
      const aliasRow = handle.get(`SELECT COUNT(*) AS n FROM tag_aliases WHERE source_id IN (${placeholders})`, ...localSourceIds)
      const tagCount = Number(tagRow?.n ?? 0)
      const aliasCount = Number(aliasRow?.n ?? 0)
      cachedHealth = {
        ...base,
        tag_count: tagCount,
        alias_count: aliasCount,
        state: tagCount > 0 ? KB_HEALTH.AVAILABLE : KB_HEALTH.EMPTY,
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

  function lookupLocal(name) {
    if (localSourceIds.length === 0) return null
    const tag = findTag(handle, name, { sourceIds: restrictToLocalSources })
    if (tag) return { tag, via_alias: false, alias: null }
    const alias = findAlias(handle, name, { sourceIds: restrictToLocalSources })
    if (alias?.tag) return { tag: alias.tag, via_alias: true, alias: alias.alias }
    return null
  }

  function batchLookupLocal(rawNames) {
    if (localSourceIds.length === 0) return new Map()
    const normalizedSet = new Set()
    for (const raw of rawNames ?? []) {
      const n = normalizeTagName(raw)
      if (n) normalizedSet.add(n)
    }
    const normalized = [...normalizedSet]
    if (normalized.length === 0) return new Map()
    const result = new Map()
    const srcFilter = restrictToLocalSources && restrictToLocalSources.length > 0 ? restrictToLocalSources : null

    const tagRows = []
    for (let i = 0; i < normalized.length; i += BATCH_CHUNK) {
      const chunk = normalized.slice(i, i + BATCH_CHUNK)
      let sql = `SELECT * FROM tags WHERE name IN (${chunk.map(() => '?').join(',')})`
      const params = [...chunk]
      if (srcFilter) {
        sql += ` AND source_id IN (${srcFilter.map(() => '?').join(',')})`
        params.push(...srcFilter)
      }
      sql += ' ORDER BY post_count DESC NULLS LAST'
      tagRows.push(...handle.all(sql, ...params))
    }

    const tagsByName = new Map()
    for (const row of tagRows) {
      const name = String(row.name)
      if (!tagsByName.has(name)) tagsByName.set(name, row)
    }

    const missing = normalized.filter((n) => !tagsByName.has(n))
    const aliasTagIds = new Set()
    const aliasByName = new Map()
    if (missing.length > 0) {
      for (let i = 0; i < missing.length; i += BATCH_CHUNK) {
        const chunk = missing.slice(i, i + BATCH_CHUNK)
        let sql = `SELECT * FROM tag_aliases WHERE alias IN (${chunk.map(() => '?').join(',')})`
        const params = [...chunk]
        if (srcFilter) {
          sql += ` AND source_id IN (${srcFilter.map(() => '?').join(',')})`
          params.push(...srcFilter)
        }
        for (const row of handle.all(sql, ...params)) {
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
    if (allRows.length === 0) return result
    const decorated = decorateTags(handle, allRows)
    const decoratedById = new Map(decorated.map((tag) => [Number(tag.id), tag]))

    for (const [name, row] of tagsByName) {
      const tag = decoratedById.get(Number(row.id))
      if (tag) result.set(name, { tag, via_alias: false, alias: null })
    }
    for (const [aliasName, aliasRow] of aliasByName) {
      const tag = decoratedById.get(Number(aliasRow.tag_id))
      if (tag) result.set(aliasName, { tag, via_alias: true, alias: aliasName })
    }
    return result
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
    health,
    refreshHealth,
  }
}
