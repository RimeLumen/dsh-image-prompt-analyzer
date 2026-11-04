
const MAX_TEXT = 8000

const DONE_TTL_MS = 10 * 60 * 1000

export function createProgressStore({ maxText = MAX_TEXT } = {}) {
  const entries = new Map()

  function push(key, text) {
    const now = Date.now()
    const entry = entries.get(key) ?? { text: '', done: false, updatedAt: now }
    entry.text = (entry.text + String(text ?? '')).slice(-maxText)
    entry.updatedAt = now
    entries.set(key, entry)
    sweep()
    return entry
  }

  function finish(key) {
    const entry = entries.get(key)
    if (entry) {
      entry.done = true
      entry.updatedAt = Date.now()
    } else {
      entries.set(String(key), { text: '', done: true, updatedAt: Date.now() })
    }
    sweep()
  }

  function get(key) {
    return entries.get(String(key)) ?? null
  }

  function sweep() {
    const deadline = Date.now() - DONE_TTL_MS
    for (const [key, entry] of entries) {
      if (entry.done && entry.updatedAt < deadline) entries.delete(key)
    }
  }

  return { push, finish, get }
}
