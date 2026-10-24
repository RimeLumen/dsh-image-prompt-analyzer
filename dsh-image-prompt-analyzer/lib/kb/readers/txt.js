
export function readTextLines(text) {
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const rows = []
  let skipped = 0
  for (const line of lines) {
    const value = line.trim()
    if (!value) {
      skipped += 1
      continue
    }
    rows.push(value)
  }
  return { rows, skipped }
}
