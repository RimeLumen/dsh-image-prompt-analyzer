
import { SEVERITY, diagnostic } from '../../diagnostics.js'
import { normalizeTagName } from '../normalize.js'
import { LOOKUP_MODES, LOOKUP_REASONS, LOOKUP_SOURCE, LOOKUP_STATUS, makeLookupResult } from './result.js'

const KB_QUERY_CODES = Object.freeze({
  LOOKUP_FAILED: 'KB_LOOKUP_FAILED',
})

export function createTaskLookup({ lookupLocal, batchLookupLocal = null, localSourceIds = [], mode = LOOKUP_MODES.LOCAL_ONLY }) {
  function beginTask({ signal = null } = {}) {
    const diagnostics = []
    let lookups = 0

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
      lookups += 1
      const found = lookupLocalSafely(normalized)
      if (found) {
        return makeLookupResult(query, normalized, {
          status: LOOKUP_STATUS.HIT,
          source: LOOKUP_SOURCE.LOCAL,
          tag: found.tag,
          via_alias: found.via_alias,
          alias: found.alias,
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
                source: LOOKUP_SOURCE.LOCAL,
                tag: found.tag,
                via_alias: found.via_alias,
                alias: found.alias,
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
      stats() {
        return {
          mode,
          lookups,
          local_sources: localSourceIds,
        }
      },
    }
  }

  return { beginTask }
}
