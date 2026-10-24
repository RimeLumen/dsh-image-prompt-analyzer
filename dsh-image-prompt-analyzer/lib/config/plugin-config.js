
import { diagnostic, SEVERITY } from '../diagnostics.js'
import { MIGRATE_CODES } from './migrate.js'

const PLUGIN_CONFIG_CODES = Object.freeze({
  SECRET_IN_CONFIG: 'PLUGIN_CONFIG_SECRET_IN_CONFIG',
  VALUE_OUT_OF_RANGE: 'PLUGIN_CONFIG_VALUE_OUT_OF_RANGE',
  PIXEL_LIMIT_INCONSISTENT: 'PLUGIN_CONFIG_PIXEL_LIMIT_INCONSISTENT',
  PYTHON_DISABLED: 'PLUGIN_CONFIG_PYTHON_DISABLED',
})

export const DEFAULT_ALLOWED_FORMATS = Object.freeze(['PNG', 'JPEG', 'WEBP', 'BMP'])

export const DEFAULT_PLUGIN_CONFIG = Object.freeze({
  configDir: './configs',
  dataDir: './data',
  logDir: './logs',

  target_profile: null,

  vision: Object.freeze({
    model: null,
    provider: null,
    probe_on_select: false,
    fallback: Object.freeze({
      on_error_classes: Object.freeze(['unsupported_image', 'modality_mismatch']),
      retry_classes: Object.freeze(['5xx', 'timeout', 'rate_limit']),
      unavail_ttl_seconds: 3600,
    }),
    timeout_seconds: 120,
    max_tokens: 4096,
    temperature: 0.2,
    max_local_reviews: 3,
    min_crop_side: 0.08,
    review_confidence_threshold: 0.5,
    important_threshold: 0.5,
  }),

  python: Object.freeze({
    executable: 'python',
    timeout_seconds: 30,
    enabled: true,
  }),

  image: Object.freeze({
    max_edge: 4096,
    max_pixels: 16777216,
    max_bytes: 33554432,
    allowed_formats: DEFAULT_ALLOWED_FORMATS,
    raw_enabled: false,
    temp_ttl_minutes: 60,
    keep_temp_files: true,
  }),

  privacy: Object.freeze({
    save_experience_default: false,
    log_image_paths: false,
  }),

  panel: Object.freeze({
    enabled: true,
    max_recent_tasks: 20,
    workbench_temp_ttl_minutes: 10,
  }),
})

function deepMerge(base, override) {
  if (override === undefined || override === null) return base
  if (Array.isArray(base) || Array.isArray(override)) return override
  if (typeof base !== 'object' || typeof override !== 'object') return override
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? deepMerge(base[key], value) : value
  }
  return out
}

const isNumberInRange = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

export function resolvePluginConfig(raw, configFile = 'cordis.patch.yml (plugin row config)') {
  const diagnostics = []
  const input = raw && typeof raw === 'object' ? raw : {}

  const legacyPaths = [
    ['/vision/backend', input.vision?.backend],
    ['/vision/independent', input.vision?.independent],
    ['/privacy/allow_image_upload', input.privacy?.allow_image_upload],
    ['/network', input.network],
    ['/cache', input.cache],
  ]
  for (const [field_path, value] of legacyPaths) {
    if (value === undefined) continue
    diagnostics.push(
      diagnostic({
        error_code: MIGRATE_CODES.LEGACY_VALUE_REWRITTEN,
        severity: SEVERITY.WARNING,
        config_file: configFile,
        field_path,
        message: `${field_path} 属于已删除的设计，本版本不再读取它（视觉模型改为从宿主模型目录自动发现；联网查询已随纯本地知识库 2.0 移除）。`,
        suggested_fix: '删掉这个字段。要固定模型时改用 vision.provider + vision.model；标签数据改用本地文件导入。',
      }),
    )
  }

  const forbidden = ['api_key', 'apikey', 'apiKey', 'token', 'password', 'secret']
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (forbidden.includes(key)) {
        diagnostics.push(
          diagnostic({
            error_code: PLUGIN_CONFIG_CODES.SECRET_IN_CONFIG,
            severity: SEVERITY.ERROR,
            config_file: configFile,
            field_path: `${path}/${key}`,
            message: '配置里出现了疑似密钥明文的字段。文档 §11 要求密钥只走 DSH 凭据服务。',
            suggested_fix: '删掉这个字段。需要模型鉴权时由 DSH 的模型路由与凭据服务负责，插件本身不读密钥。',
          }),
        )
        continue
      }
      walk(value, `${path}/${key}`)
    }
  }
  walk(input, '')

  const merged = deepMerge(DEFAULT_PLUGIN_CONFIG, input)

  delete merged.vision.backend
  delete merged.vision.independent
  delete merged.privacy.allow_image_upload
  delete merged.network
  delete merged.cache

  const numericGuards = [
    ['/image/max_edge', merged.image.max_edge, 64, 65536],
    ['/image/max_pixels', merged.image.max_pixels, 4096, 268435456],
    ['/image/max_bytes', merged.image.max_bytes, 1024, 1073741824],
    ['/image/temp_ttl_minutes', merged.image.temp_ttl_minutes, 1, 10080],
    ['/vision/timeout_seconds', merged.vision.timeout_seconds, 1, 3600],
    ['/vision/fallback/unavail_ttl_seconds', merged.vision.fallback?.unavail_ttl_seconds ?? 3600, 1, 86400],
    ['/vision/max_local_reviews', merged.vision.max_local_reviews, 0, 32],
    ['/vision/review_confidence_threshold', merged.vision.review_confidence_threshold, 0, 1],
    ['/vision/important_threshold', merged.vision.important_threshold, 0, 1],
    ['/python/timeout_seconds', merged.python.timeout_seconds, 1, 600],
    ['/panel/max_recent_tasks', merged.panel.max_recent_tasks, 1, 500],
    ['/panel/workbench_temp_ttl_minutes', merged.panel.workbench_temp_ttl_minutes, 1, 10080],
  ]
  for (const [field_path, value, min, max] of numericGuards) {
    if (!isNumberInRange(value, min, max)) {
      diagnostics.push(
        diagnostic({
          error_code: PLUGIN_CONFIG_CODES.VALUE_OUT_OF_RANGE,
          severity: SEVERITY.ERROR,
          config_file: configFile,
          field_path,
          message: `取值 ${JSON.stringify(value)} 不在允许范围 ${min}–${max} 内。`,
          suggested_fix: `改成一个 ${min} 到 ${max} 之间的数字；要"不限制"请显式给上界，不要给 0 或负数。`,
        }),
      )
    }
  }

  if (merged.image.max_pixels > merged.image.max_edge * merged.image.max_edge) {
    diagnostics.push(
      diagnostic({
        error_code: PLUGIN_CONFIG_CODES.PIXEL_LIMIT_INCONSISTENT,
        severity: SEVERITY.WARNING,
        config_file: configFile,
        field_path: '/image/max_pixels',
        message: `max_pixels (${merged.image.max_pixels}) 大于 max_edge² (${merged.image.max_edge * merged.image.max_edge})，意味着像素上限永远先被边长上限挡住，max_pixels 实际不生效。`,
        suggested_fix: '要么把 max_pixels 调小，要么把 max_edge 调大，让两个限制各自有意义。',
      }),
    )
  }

  if (!merged.python.enabled) {
    diagnostics.push(
      diagnostic({
        error_code: PLUGIN_CONFIG_CODES.PYTHON_DISABLED,
        severity: SEVERITY.WARNING,
        config_file: configFile,
        field_path: '/python/enabled',
        message: 'python.enabled 是 false，所有图片解码都会返回 PYTHON_UNAVAILABLE，主工具实际不可用。',
        suggested_fix: '把它设回 true；只在完全不做图片分析时关闭。',
      }),
    )
  }

  return { config: merged, diagnostics }
}

export const PLUGIN_CONFIG_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'dsh-image-prompt-analyzer plugin row config',
  type: 'object',
  additionalProperties: false,
  properties: {
    configDir: { type: 'string', minLength: 1 },
    dataDir: { type: 'string', minLength: 1 },
    logDir: { type: 'string', minLength: 1 },
    vision: {
      type: 'object',
      additionalProperties: false,
      properties: {
        model: { type: ['string', 'null'], minLength: 1 },
        provider: { type: ['string', 'null'] },
        probe_on_select: { type: 'boolean' },
        fallback: {
          type: 'object',
          additionalProperties: false,
          properties: {
            on_error_classes: { type: 'array', items: { type: 'string' }, minItems: 1 },
            retry_classes: { type: 'array', items: { type: 'string' }, minItems: 1 },
            unavail_ttl_seconds: { type: 'integer', minimum: 1, maximum: 86400 },
          },
        },
        timeout_seconds: { type: 'number', minimum: 1, maximum: 3600 },
        max_tokens: { type: 'integer', minimum: 64, maximum: 200000 },
        temperature: { type: 'number', minimum: 0, maximum: 2 },
        max_local_reviews: { type: 'integer', minimum: 0, maximum: 32 },
        min_crop_side: { type: 'number', minimum: 0.01, maximum: 1 },
        review_confidence_threshold: { type: 'number', minimum: 0, maximum: 1 },
        important_threshold: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
    python: {
      type: 'object',
      additionalProperties: false,
      properties: {
        executable: { type: 'string', minLength: 1 },
        timeout_seconds: { type: 'number', minimum: 1, maximum: 600 },
        enabled: { type: 'boolean' },
      },
    },
    image: {
      type: 'object',
      additionalProperties: false,
      properties: {
        max_edge: { type: 'integer', minimum: 64, maximum: 65536 },
        max_pixels: { type: 'integer', minimum: 4096, maximum: 268435456 },
        max_bytes: { type: 'integer', minimum: 1024, maximum: 1073741824 },
        allowed_formats: { type: 'array', items: { type: 'string', enum: ['PNG', 'JPEG', 'WEBP', 'BMP', 'RAW'] }, minItems: 1 },
        raw_enabled: { type: 'boolean' },
        temp_ttl_minutes: { type: 'integer', minimum: 1, maximum: 10080 },
        keep_temp_files: { type: 'boolean' },
      },
    },
    privacy: {
      type: 'object',
      additionalProperties: false,
      properties: {
        save_experience_default: { type: 'boolean' },
        log_image_paths: { type: 'boolean' },
      },
    },
    panel: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        max_recent_tasks: { type: 'integer', minimum: 1, maximum: 500 },
        workbench_temp_ttl_minutes: { type: 'integer', minimum: 1, maximum: 10080 },
      },
    },
  },
})
