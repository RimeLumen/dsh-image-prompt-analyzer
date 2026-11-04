
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

function toLine(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function createLogger({ dir, name = 'plugin', level = 'info' } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info
  let file = null

  if (typeof dir === 'string' && dir.length > 0) {
    try {
      mkdirSync(dir, { recursive: true })
      file = join(dir, `${name}.log`)
    } catch {
      file = null
    }
  }

  const write = (levelName, args) => {
    if ((LEVELS[levelName] ?? 0) < threshold) return
    if (file === null) return
    const stamp = new Date().toISOString()
    const body = args.map(toLine).join(' ')
    try {
      appendFileSync(file, `${stamp} [${levelName}] ${body}\n`, 'utf8')
    } catch {
    }
  }

  return {
    file,
    debug: (...args) => write('debug', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
  }
}

export const NULL_LOGGER = {
  file: null,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
