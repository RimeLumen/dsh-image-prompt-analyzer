
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

function isWithin(base, child) {
  const rel = relative(base, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

export function resolveWithin(base, value, fallback) {
  const raw = typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const candidate = raw.trim()
  if (isAbsolute(candidate)) return null
  const abs = resolve(base, candidate)
  if (!isWithin(base, abs)) return null
  return abs
}

export function resolvePluginDirs(config = {}) {
  const errors = []
  const pick = (key, fallback) => {
    const value = resolveWithin(PACKAGE_DIR, config?.[key], fallback)
    if (value === null) errors.push(key)
    return value
  }
  return {
    configDir: pick('configDir', './configs'),
    dataDir: pick('dataDir', './data'),
    logDir: pick('logDir', './logs'),
    errors,
  }
}
