
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { PACKAGE_DIR } from './paths.js'

function readPluginVersion() {
  try {
    const raw = readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')
    return JSON.parse(raw).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const PLUGIN_VERSION = readPluginVersion()
