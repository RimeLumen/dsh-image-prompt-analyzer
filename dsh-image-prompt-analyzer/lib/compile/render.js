
import { formatTag } from './style.js'

export const RENDER_CODES = Object.freeze({
  EMPTY: 'COMPILE_NO_TERMS',
})

export function renderPrompt({ slots, profile }) {
  const segments = []

  for (const [slot, terms] of slots ?? []) {
    if (!Array.isArray(terms) || terms.length === 0) continue
    const rendered = []
    for (const term of terms) {
      const text = term?.source === 'profile' ? String(term.text ?? '') : formatTag(term?.text, profile, { slot })
      if (text.length > 0) rendered.push(text)
    }
    if (rendered.length > 0) segments.push({ slot, terms: rendered })
  }

  const positive = segments.flatMap((segment) => segment.terms).join(', ')
  return { positive, segments }
}
