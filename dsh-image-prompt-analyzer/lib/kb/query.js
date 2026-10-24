
import { NULL_LOGGER } from '../log.js'
import { findAlias, findTag, decorateTags } from './store.js'
import { normalizeTagName } from './normalize.js'
import { createTaskLookup } from './query/task.js'
import { LOOKUP_MODES } from './query/result.js'

export { LOOKUP_STATUS, LOOKUP_SOURCE, LOOKUP_MODES, LOOKUP_REASONS } from './query/result.js'

const BATCH_CHUNK = 400

export function createKnowledgeBase({ handle, config = {}, logger = NULL_LOGGER } = {}) {
  const sources = Array.isArray(config.sources) ? config.sources : []
  const localSourceIds = sources
    .filter((source) => source.enabled !== false && (source.type === 'local_file' || source.type === 'local_sqlite'))
    .map((source) => String(source.source_id))

  const mode = LOOKUP_MODES.LOCAL_ONLY
  const restrictToLocalSources = localSourceIds.length > 0 ? localSourceIds : null

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
  const taskLookup = createTaskLookup({ mode, localSourceIds, lookupLocal, batchLookupLocal })

  return {
    beginTask: taskLookup.beginTask,
    mode,
    localSourceIds,
  }
}
