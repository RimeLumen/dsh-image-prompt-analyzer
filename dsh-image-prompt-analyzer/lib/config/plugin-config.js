
import { diagnostic, SEVERITY } from '../diagnostics.js'
import { MIGRATE_CODES } from './migrate.js'
import { DEFAULT_COMFY_BASE_URL, DEFAULT_COMFY_TIMEOUT_MS, normalizeComfySettings } from '../comfyui/index.js'

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
    // 满编八维 + 实体关系 + 复核请求时，中文 JSON 大约 1.5 字符/token：
    // 6144 只够写 ~9000 字，实测会在 features 段中间被砍断（Unterminated string）。
    // 8192 也仍然会被撑满：复杂图一次要写三十条以上观察加关系与不确定项，
    // 而"截断后翻倍重试"虽然能救回来，却等于每次多花一整次全量调用。
    // 所以默认给到 16384；analyze.js 里另有两道兜底：截断翻倍重试、
    // 以及从尾部往回退并补全括号的"截断抢救"。
    max_tokens: 16384,
    temperature: 0.2,
    // 首次分析的自动复核框：只允许 4 或 9。要"不复核"走面板里的二次分析选项，
    // 不要靠把它设成 0 来省调用——那样会连模糊区域的追问一起关掉。
    max_local_reviews: 4,
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

  // 阶段留痕：把一次分析的各阶段产物写到 data/traces/<task_id>/ 下。
  // 默认开着，因为它不花钱、不影响提示词，却决定了"这次到底哪一步改了什么"能不能回答。
  // 只保留最近若干次，避免无限占盘。
  trace: Object.freeze({
    enabled: true,
    max_tasks: 10,
  }),

  // ComfyUI 接入默认关闭：不配置时插件行为与 1.0 完全一致，
  // 也不会去碰用户的模型目录。installRoot 只接受绝对路径——它指向插件包之外。
  comfyui: Object.freeze({
    enabled: false,
    baseUrl: DEFAULT_COMFY_BASE_URL,
    installRoot: null,
    extraModelPathsConfigFiles: Object.freeze([]),
    additionalModelRoots: Object.freeze([]),
    requestTimeoutMs: DEFAULT_COMFY_TIMEOUT_MS,
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

  // comfyui 段单独规范化：未知键要清掉（schema 是 additionalProperties:false），
  // 路径与 URL 的写法校验也在这里做，避免 deepMerge 把非法值原样留在配置里。
  const comfy = normalizeComfySettings(input.comfyui, { configFile })
  diagnostics.push(...comfy.diagnostics)
  merged.comfyui = comfy.settings

  const numericGuards = [
    ['/image/max_edge', merged.image.max_edge, 64, 65536],
    ['/image/max_pixels', merged.image.max_pixels, 4096, 268435456],
    ['/image/max_bytes', merged.image.max_bytes, 1024, 1073741824],
    ['/image/temp_ttl_minutes', merged.image.temp_ttl_minutes, 1, 10080],
    ['/vision/timeout_seconds', merged.vision.timeout_seconds, 1, 3600],
    ['/vision/fallback/unavail_ttl_seconds', merged.vision.fallback?.unavail_ttl_seconds ?? 3600, 1, 86400],
    ['/vision/max_local_reviews', merged.vision.max_local_reviews, 4, 9],
    ['/vision/review_confidence_threshold', merged.vision.review_confidence_threshold, 0, 1],
    ['/vision/important_threshold', merged.vision.important_threshold, 0, 1],
    ['/python/timeout_seconds', merged.python.timeout_seconds, 1, 600],
    ['/panel/max_recent_tasks', merged.panel.max_recent_tasks, 1, 500],
    ['/panel/workbench_temp_ttl_minutes', merged.panel.workbench_temp_ttl_minutes, 1, 10080],
    ['/trace/max_tasks', merged.trace?.max_tasks ?? 10, 1, 200],
    ['/comfyui/requestTimeoutMs', merged.comfyui?.requestTimeoutMs ?? DEFAULT_COMFY_TIMEOUT_MS, 1000, 600000],
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
        max_local_reviews: { type: 'integer', enum: [4, 9] },
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
    trace: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        max_tasks: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
    comfyui: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        baseUrl: { type: 'string', minLength: 1 },
        installRoot: { type: ['string', 'null'], minLength: 1 },
        extraModelPathsConfigFiles: { type: 'array', items: { type: 'string', minLength: 1 } },
        additionalModelRoots: { type: 'array', items: { type: 'string', minLength: 1 } },
        requestTimeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 },
      },
    },
  },
})
