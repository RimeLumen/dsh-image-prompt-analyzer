
import { SEVERITY, diagnostic } from '../../diagnostics.js'
import { normalizeTagName } from '../normalize.js'
import { KB_HEALTH, LOOKUP_MODES, LOOKUP_REASONS, LOOKUP_SOURCE, LOOKUP_STATUS, makeLookupResult } from './result.js'

const KB_QUERY_CODES = Object.freeze({
  LOOKUP_FAILED: 'KB_LOOKUP_FAILED',
})

// 词库整体不可用时，单次查询的"未命中"要标成"没查过"：
// 词表空着和词表里没有这个词，对提示词的处理方式不一样。
const NOT_QUERIED_REASON = Object.freeze({
  [KB_HEALTH.EMPTY]: LOOKUP_REASONS.KB_EMPTY,
  [KB_HEALTH.SOURCE_MISSING]: LOOKUP_REASONS.NO_LOCAL_SOURCES,
  [KB_HEALTH.UNAVAILABLE]: LOOKUP_REASONS.KB_UNAVAILABLE,
  [KB_HEALTH.LOOKUP_FAILED]: LOOKUP_REASONS.LOOKUP_FAILED,
})

export function createTaskLookup({
  lookupLocal,
  batchLookupLocal = null,
  localSourceIds = [],
  mode = LOOKUP_MODES.LOCAL_ONLY,
  health = null,
} = {}) {
  function beginTask({ signal = null } = {}) {
    const diagnostics = []
    let lookups = 0

    const healthSnapshot = typeof health === 'function' ? health() : null
    const queryable = healthSnapshot === null || healthSnapshot?.state === KB_HEALTH.AVAILABLE
    const notQueriedReason = healthSnapshot === null
      ? LOOKUP_REASONS.KB_UNAVAILABLE
      : NOT_QUERIED_REASON[healthSnapshot.state] ?? LOOKUP_REASONS.KB_UNAVAILABLE

    function lookupLocalSafely(normalized) {
      try {
        return lookupLocal(normalized)
      } catch (error) {
        diagnostics.push(
          diagnostic({
            error_code: KB_QUERY_CODES.LOOKUP_FAILED,
            severity: SEVERITY.WARNING,
            message: `查询 ${normalized} 时读本地库出错：${error?.message ?? error}`,
            suggested_fix: '用 diagnose_knowledge_base 检查数据库文件；这个标签会以未命中的形式保留。',
          }),
        )
        return null
      }
    }

    function notQueriedResult(query, normalized) {
      return makeLookupResult(query, normalized, {
        status: LOOKUP_STATUS.NOT_QUERIED,
        reason: notQueriedReason,
      })
    }

    async function lookup(name) {
      void signal
      const query = String(name ?? '').trim()
      const normalized = normalizeTagName(query)
      if (!normalized) {
        return makeLookupResult(query, normalized, {
          status: LOOKUP_STATUS.MISS,
          reason: LOOKUP_REASONS.EMPTY_QUERY,
        })
      }
      if (!queryable) return notQueriedResult(query, normalized)
      lookups += 1
      const found = lookupLocalSafely(normalized)
      if (found) {
        return makeLookupResult(query, normalized, {
          status: LOOKUP_STATUS.HIT,
          source: found.source ?? LOOKUP_SOURCE.LOCAL,
          tag: found.tag,
          via_alias: found.via_alias,
          alias: found.alias,
          fallback: found.fallback === true,
        })
      }
      return makeLookupResult(query, normalized, {
        status: LOOKUP_STATUS.MISS,
        reason: LOOKUP_REASONS.LOCAL_MISS,
      })
    }

    async function lookupMany(names) {
      const results = []
      const seen = new Map()
      const rawList = [...(names ?? [])]
      if (!queryable) {
        for (const raw of rawList) {
          const normalized = normalizeTagName(raw)
          if (!normalized) continue
          if (seen.has(normalized)) {
            results.push({ ...seen.get(normalized), duplicate_of: raw })
            continue
          }
          const result = notQueriedResult(raw, normalized)
          seen.set(normalized, result)
          results.push(result)
        }
        return results
      }
      if (batchLookupLocal) {
        const batchMap = batchLookupLocal(rawList)
        for (const raw of rawList) {
          const normalized = normalizeTagName(raw)
          if (!normalized) continue
          if (seen.has(normalized)) {
            results.push({ ...seen.get(normalized), duplicate_of: raw })
            continue
          }
          lookups += 1
          const found = batchMap.get(normalized) ?? null
          const result = found
            ? makeLookupResult(raw, normalized, {
                status: LOOKUP_STATUS.HIT,
                source: found.source ?? LOOKUP_SOURCE.LOCAL,
                tag: found.tag,
                via_alias: found.via_alias,
                alias: found.alias,
                fallback: found.fallback === true,
              })
            : makeLookupResult(raw, normalized, { status: LOOKUP_STATUS.MISS, reason: LOOKUP_REASONS.LOCAL_MISS })
          seen.set(normalized, result)
          results.push(result)
        }
        return results
      }
      for (const raw of rawList) {
        const normalized = normalizeTagName(raw)
        if (!normalized) continue
        if (seen.has(normalized)) {
          results.push({ ...seen.get(normalized), duplicate_of: raw })
          continue
        }
        const result = await lookup(raw)
        seen.set(normalized, result)
        results.push(result)
      }
      return results
    }

    return {
      lookup,
      lookupMany,
      get diagnostics() {
        return diagnostics
      },
      health: healthSnapshot,
      stats() {
        return {
          mode,
          lookups,
          queryable,
          local_sources: localSourceIds,
          studio_sources: healthSnapshot?.studio_sources ?? [],
          studio_fallback: healthSnapshot?.studio_fallback === true,
          health: healthSnapshot?.state ?? null,
        }
      },
    }
  }

  return { beginTask }
}
