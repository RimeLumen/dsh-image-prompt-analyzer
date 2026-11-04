
import { SEVERITY, TASK_STATUS, diagnostic, envelope } from '../../diagnostics.js'

const VALIDATE_CONFIGS_CODES = Object.freeze({
  NOTHING_VALIDATED: 'CONFIG_NOTHING_VALIDATED',
  ID_NOT_FOUND: 'CONFIG_ID_NOT_FOUND',
})

function escalate(item) {
  return { ...item, severity: SEVERITY.ERROR }
}

export async function runValidateConfigs(runtime, args = {}) {
  const diagnostics = []
  const strict = args.strict_mode === true
  const onlyId = typeof args.config_id === 'string' && args.config_id.trim() ? args.config_id.trim() : null

  diagnostics.push(...runtime.configDiagnostics)

  let snapshot = null
  try {
    const store = await runtime.getConfigStore()
    snapshot = await store.inspect()
  } catch (error) {
    diagnostics.push(
      diagnostic({
        error_code: error?.code ?? 'CONFIG_STORE_UNAVAILABLE',
        severity: SEVERITY.ERROR,
        config_file: null,
        field_path: null,
        message: `无法加载配置仓库：${error?.message ?? error}`,
        suggested_fix: error?.suggested_fix ?? '检查 configs/ 目录是否完整、JSON 是否合法。',
      }),
    )
    return envelope({
      status: TASK_STATUS.FAILED,
      diagnostics,
      extra: { validated: [], plugin_config: describePluginConfig(runtime) },
    })
  }

  const entries = collectEntries(snapshot)
  const rejected = Array.isArray(snapshot?.rejected) ? snapshot.rejected : []
  const validated = []
  const included = new Set()

  for (const entry of entries) {
    if (onlyId && entry.config_id !== onlyId) continue
    validated.push(describeEntry(entry, { strict, diagnostics, included }))
  }
  for (const entry of rejected) {
    if (onlyId && entry.config_id !== onlyId) continue
    validated.push(describeEntry(entry, { strict, diagnostics, included, status: 'rejected' }))
  }

  for (const item of Array.isArray(snapshot?.diagnostics) ? snapshot.diagnostics : []) {
    if (included.has(item)) continue
    included.add(item)
    diagnostics.push(strict ? escalate(item) : item)
  }

  if (entries.length === 0 && rejected.length === 0) {
    diagnostics.push(
      diagnostic({
        error_code: VALIDATE_CONFIGS_CODES.NOTHING_VALIDATED,
        severity: SEVERITY.ERROR,
        config_file: null,
        field_path: null,
        message: '配置目录里一条配置都没有读到——这次调用没有校验任何文件。',
        suggested_fix:
          '确认 patch 行的 configDir 指向包内 configs/，且该目录下存在 knowledge-base.default.json、model-profiles/*.json 与 presets/*.json。',
      }),
    )
  }

  if (onlyId && validated.length === 0) {
    diagnostics.push(
      diagnostic({
        error_code: VALIDATE_CONFIGS_CODES.ID_NOT_FOUND,
        severity: SEVERITY.ERROR,
        message: `没有找到 config_id 为 ${onlyId} 的配置。`,
        suggested_fix: '用不带 config_id 的调用看有哪些配置可用。',
      }),
    )
  }

  const hasError = diagnostics.some((item) => item.severity === SEVERITY.ERROR)
  const hasWarning = diagnostics.some((item) => item.severity === SEVERITY.WARNING)

  return envelope({
    status: hasError ? TASK_STATUS.FAILED : hasWarning ? TASK_STATUS.OK_WITH_WARNINGS : TASK_STATUS.OK,
    diagnostics,
    active_configs: snapshot?.activeConfigs ?? null,
    extra: {
      strict_mode: strict,
      validated,
      plugin_config: describePluginConfig(runtime),
      note: strict
        ? 'strict_mode 已开启：未知字段被当作错误。'
        : '未知字段默认只报警告；需要严格模式请传 strict_mode: true。',
    },
  })
}

function describeEntry(entry, { strict, diagnostics, included, status = null }) {
  const own = []
  for (const item of entry.diagnostics ?? []) {
    if (included.has(item)) continue
    included.add(item)
    const moved = strict ? escalate(item) : item
    diagnostics.push(moved)
    own.push(moved)
  }
  return {
    kind: entry.kind,
    config_id: entry.config_id ?? null,
    schema_version: entry.schema_version ?? null,
    source: entry.source,
    file: entry.relative_file ?? entry.file ?? null,
    problem_count: own.filter((item) => item.severity === SEVERITY.ERROR).length,
    warning_count: own.filter((item) => item.severity === SEVERITY.WARNING).length,
    status: status ?? (own.some((item) => item.severity === SEVERITY.ERROR) ? 'rejected' : 'accepted'),
  }
}

function collectEntries(snapshot) {
  const entries = []
  if (snapshot?.knowledgeBase) entries.push({ kind: 'knowledge-base', ...snapshot.knowledgeBase })
  for (const entry of valuesOf(snapshot?.modelProfiles)) entries.push({ kind: 'model-profile', ...entry })
  for (const entry of valuesOf(snapshot?.presets)) entries.push({ kind: 'preset', ...entry })
  return entries
}

function valuesOf(value) {
  if (value instanceof Map) return [...value.values()]
  return Array.isArray(value) ? value : []
}

function describePluginConfig(runtime) {
  const config = runtime.pluginConfig ?? {}
  const vision = config.vision ?? {}
  const python = config.python ?? {}
  const image = config.image ?? {}
  const privacy = config.privacy ?? {}
  return {
    vision_probe_on_select: vision.probe_on_select ?? null,
    vision_model: vision.model ?? null,
    vision_provider: vision.provider ?? null,
    python_enabled: python.enabled ?? null,
    python_executable: python.executable ?? null,
    image_max_edge: image.max_edge ?? null,
    image_max_pixels: image.max_pixels ?? null,
    raw_enabled: image.raw_enabled ?? null,
    save_experience_default: privacy.save_experience_default ?? null,
  }
}
