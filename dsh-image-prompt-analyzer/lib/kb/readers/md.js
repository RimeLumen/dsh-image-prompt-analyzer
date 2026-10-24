
const LIST_MARKER = /^(?:[-*+]\s+|\d+[.)]\s+)/
const FENCE = /^\s{0,3}(```+|~~~+)/

export function readMarkdownLines(text) {
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)
  const rows = []
  let skipped = 0
  let fence = null
  for (const line of lines) {
    const fenceMatch = FENCE.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1][0]
      if (!fence) fence = marker
      else if (fence === marker) fence = null
      continue
    }
    if (fence) continue
    const value = line.trim()
    if (!value) {
      skipped += 1
      continue
    }
    if (value.startsWith('#')) continue
    const withoutMarker = value.replace(LIST_MARKER, '').trim()
    if (!withoutMarker) {
      skipped += 1
      continue
    }
    rows.push(withoutMarker)
  }
  return { rows, skipped }
}
