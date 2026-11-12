import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createConfigStore } from '../lib/config/loader.js'
import { runValidateConfigs } from '../lib/tools/impl/validate-configs.js'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const dataDir = mkdtempSync(join(tmpdir(), 'dsh-validate-'))
const store = createConfigStore({ configDir: join(PACKAGE_DIR, 'configs'), dataDir, logger: null })
await store.get()

const result = await runValidateConfigs(
  { getConfigStore: async () => store, configDiagnostics: [], logger: null },
  {},
)

const errors = result.diagnostics.filter((item) => item.severity === 'error')
const warnings = result.diagnostics.filter((item) => item.severity === 'warning')
console.log('status:', result.status)
console.log('errors:', errors.length, errors.map((item) => `${item.config_file}:${item.field_path}:${item.error_code}`))
console.log('warnings:', warnings.length, warnings.map((item) => `${item.config_file}:${item.field_path}:${item.error_code}`))
rmSync(dataDir, { recursive: true, force: true })
