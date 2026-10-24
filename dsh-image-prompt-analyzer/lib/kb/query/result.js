
export const LOOKUP_STATUS = Object.freeze({
  HIT: 'hit',
  MISS: 'miss',
})

export const LOOKUP_SOURCE = Object.freeze({
  LOCAL: 'local',
})

export const LOOKUP_MODES = Object.freeze({
  LOCAL_ONLY: 'local_only',
})

export const LOOKUP_REASONS = Object.freeze({
  EMPTY_QUERY: 'empty_query',
  LOCAL_MISS: 'local_miss',
  LOOKUP_FAILED: 'lookup_failed',
})

export function makeLookupResult(query, normalized, fields) {
  const result = {
    query,
    normalized,
    status: fields.status,
    source: fields.source ?? null,
    reason: fields.reason ?? null,
    tag: fields.tag ?? null,
    via_alias: fields.via_alias ?? false,
  }
  if (fields.alias !== undefined) result.alias = fields.alias
  if (fields.detail !== undefined) result.detail = fields.detail
  if (fields.error_code !== undefined) result.error_code = fields.error_code
  return result
}
