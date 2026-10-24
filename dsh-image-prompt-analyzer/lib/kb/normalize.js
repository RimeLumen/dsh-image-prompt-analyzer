
import { createHash } from 'node:crypto'

export function normalizeTagName(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
}

export function normalizeQuery(value) {
  return normalizeTagName(value).replace(/^_+|_+$/g, '')
}

export function toUnderscored(name) {
  return normalizeTagName(name)
}

export const SCORE_TAG_PATTERN = /^score_\d+[a-z]?$/

export function toSpaced(name) {
  const normalized = normalizeTagName(name)
  if (SCORE_TAG_PATTERN.test(normalized)) return normalized
  return normalized.replace(/_/g, ' ')
}

export function splitTagList(value) {
  return String(value ?? '')
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

export function dedupeTags(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    const raw = typeof item === 'string' ? item : item?.name
    if (raw === undefined || raw === null) continue
    const key = normalizeTagName(raw)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

export function contentHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function matchScore(query, candidate) {
  const a = normalizeTagName(query)
  const b = normalizeTagName(candidate)
  if (!a || !b) return 0
  if (a === b) return 1
  if (b.startsWith(a) || a.startsWith(b)) return 0.8
  if (b.includes(a) || a.includes(b)) return 0.6
  return 0
}
