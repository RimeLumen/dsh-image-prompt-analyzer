
export function applyWordStyle(text, wordStyle) {
  const value = String(text ?? '').trim()
  if (!value) return ''
  if (wordStyle === 'spaced') return value.replace(/_/g, ' ')
  if (wordStyle === 'underscored') return value.replace(/ /g, '_')
  return value
}

export function formatTag(text, profile, { slot = null, series = null } = {}) {
  const tagStandard = profile?.tag_standard ?? {}
  const raw = String(text ?? '').trim()
  if (!raw) return ''
  if (slot === 'score') return raw

  const wordStyle = tagStandard.word_style
  const styled = applyWordStyle(raw, wordStyle)

  if (slot === 'artist') {
    const template = String(tagStandard.artist_format ?? '{name}') || '{name}'
    const formatted = template.replaceAll('{name}', styled)
    const prefix = String(tagStandard.artist_prefix ?? '')
    return prefix && !formatted.startsWith(prefix) ? `${prefix}${formatted}` : formatted
  }

  if (slot === 'character') {
    const template = String(tagStandard.character_format ?? '{name}') || '{name}'
    const seriesText = typeof series === 'string' && series.trim().length > 0 ? applyWordStyle(series, wordStyle) : ''
    let out = seriesText.length > 0
      ? template.replaceAll('{name}', styled).replaceAll('{series}', seriesText)
      : template
          .replace(/\s*\(\s*\{series\}\s*\)/g, '')
          .replace(/\s*\{series\}/g, '')
          .replaceAll('{name}', styled)
    out = out.replace(/[_\s]+$/, '')
    return out
  }

  return styled
}
