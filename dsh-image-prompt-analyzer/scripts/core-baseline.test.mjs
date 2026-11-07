// PromptLens 核心回归基线。
//
// 这个文件只做一件事：把当前实现里"已经对外承诺过的东西"钉死，任何漂移都会
// 让 `npm test` 变红。它不测 ComfyUI，不测视觉模型，不读图片，不联网。
//
// 基线值全部来自 b715017c 这一版的真实输出，是写死在下面的常量，不在运行时
// 现算——现算的期望值只能证明"代码等于代码"，证明不了"代码没变"。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { registerAllTools } from '../lib/tools/index.js'
import { compilePrompt } from '../lib/compile/index.js'
import { resolveProfileRequest } from '../lib/config/loader.js'
// PLUGIN_CONFIG_CODES 没有从 plugin-config.js 导出，所以这里比对错误码字面量。
// 字面量同时也是对外契约的一部分：诊断里的 error_code 就是这些字符串。
import { DEFAULT_PLUGIN_CONFIG, PLUGIN_CONFIG_SCHEMA, resolvePluginConfig } from '../lib/config/plugin-config.js'
import { createRuntime } from '../lib/runtime.js'
import { PLUGIN_VERSION } from '../lib/version.js'
import {
  COMFY_CODES,
  ComfyError,
  DEFAULT_COMFY_BASE_URL,
  DEFAULT_COMFY_TIMEOUT_MS,
  createComfyRuntime,
  normalizeComfySettings,
  parseLoopbackBaseUrl,
} from '../lib/comfyui/index.js'
import { canonicalCategory, joinLikePython, parseModelPathsYaml } from '../lib/comfyui/paths.js'
import { scanModelRoots, scanRoot } from '../lib/comfyui/catalog.js'
import { filterByStates, reconcileModels } from '../lib/comfyui/reconcile.js'
import { assertLoopbackNotProxied, createComfyClient } from '../lib/comfyui/client.js'
import { analyzeBindings, resolvePromptTarget } from '../lib/comfyui/bindings.js'
import {
  applyWorkflowPatch,
  enumOptionsOf,
  planWorkflowPatch,
  stableFingerprint,
  validateFieldValue,
} from '../lib/comfyui/patch.js'
import {
  imageViewUrl,
  isSafeOutputRef,
  isValidPromptId,
  queryRun,
  submitPrompt,
  describeExecution,
} from '../lib/comfyui/runs.js'
import { sniffImage } from '../lib/comfyui/image-info.js'
import { detectWorkflowFormat, inspectWorkflow } from '../lib/comfyui/workflow.js'
import {
  CONFIDENCE,
  DISCOVERY_SOURCES,
  DISCOVERY_STATUS,
  DRIVE_PROBE_LIMITS,
  MAX_CANDIDATES,
  collectDriveRoots,
  discoverComfyUI,
  inspectInstallRoot,
  isDesktopBundlePath,
  knownInstallCandidates,
  parseComfyArgv,
  probeComfyDirectories,
} from '../lib/comfyui/discovery.js'
import { createComfyToolSpecs } from '../lib/comfyui/tools.js'
import { registerTool } from '../lib/tools/registry.js'
import YAML from 'yaml'
import { createFakeFetch, createFakeSubprocess, createMemoryFs, imageResponse, jsonResponse, pngBytes } from './fixtures/comfyui/harness.mjs'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/** 六工具的注册顺序。新增工具只允许往后加，不允许插队或改名。 */
const CORE_TOOL_ORDER = [
  'analyze_image_prompt',
  'validate_configs',
  'diagnose_knowledge_base',
  'rebuild_knowledge_base',
  'preview_model_profile',
  'manage_experiences',
]

/** 每个工具的 parameters 顶层属性名。顺序不敏感，内容敏感。 */
const CORE_TOOL_PROPERTIES = {
  analyze_image_prompt: [
    'image_path',
    'target_profile',
    'variant',
    'detail_level',
    'character',
    'include_negative',
    'pose_control',
    'include_ir',
    'save_experience',
  ],
  validate_configs: ['config_id', 'strict_mode'],
  diagnose_knowledge_base: ['source_id'],
  rebuild_knowledge_base: ['sources', 'dry_run', 'limit'],
  preview_model_profile: ['target_profile', 'variant', 'detail_level', 'sample_ir'],
  manage_experiences: [
    'action',
    'experience_id',
    'task_id',
    'tags',
    'require_all',
    'target_model',
    'target_profile',
    'image_hash',
    'rating',
    'note',
    'ids',
    'path',
    'limit',
  ],
}

/** 每个工具的 required 列表（没有 required 的记 null）。 */
const CORE_TOOL_REQUIRED = {
  analyze_image_prompt: ['image_path', 'target_profile'],
  validate_configs: null,
  diagnose_knowledge_base: null,
  rebuild_knowledge_base: null,
  preview_model_profile: ['target_profile'],
  manage_experiences: null,
}

/**
 * parameters 的规范化 JSON（对象键排序）哈希。
 * 只改属性的书写顺序不会让它变，改任何一个枚举值、范围、描述都会。
 */
const CORE_TOOL_SCHEMA_SHA256 = {
  analyze_image_prompt: '107199c3e83a142002b8c988dbb3e9aea8aa48b7f6867c6b1243f60872665f21',
  validate_configs: 'c288b8347979e39b2eb3083e661c81f2e2555e3bfac948a13bc2834be17c2801',
  diagnose_knowledge_base: 'e366cbd5fddf761a42b34d27b790d867e8f2405b0523c92eeaae536427844682',
  rebuild_knowledge_base: '562b673a7a02ee57c03e7ac880d186e3f9ccb80ce3033ae560abac6ffecba6d3',
  preview_model_profile: 'b446c99ea4d10630dd4279abf5240fddf94aa022cb418d0cfc4b3a553834259b',
  manage_experiences: '1f67cf58e5d0094b02ad3deaefdc27369cf07c07db4e162b493cf43868fe0a9d',
}

/** 固定 IR + 固定档案 + 固定 preset 跑出来的三段文本。 */
const PROMPT_BASELINE = {
  positive: {
    length: 263,
    sha256: 'f90008858487969e5ddcd0e9f155ea2e7cd447a97e6a23d0e5421a749b81e81d',
  },
  description: {
    length: 305,
    sha256: '4c783506d317392d9f64f423aec387f93692cd7a7d4fc718ccd1154e18e12eaf',
  },
  negative: {
    length: 232,
    sha256: '574fffbfaff096ab1e2066a67b301cf6214a9c632dd9647938f57e1c7f241688',
  },
}

const SILENT_LOGGER = { debug() {}, info() {}, warn() {}, error() {} }

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 键排序的规范化 JSON：同一个对象换个书写顺序不会换哈希。 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(PACKAGE_DIR, relativePath), 'utf8'))
}

/** 用真实注册函数往一个只记录调用的 ctx 里注册，返回注册结果与 disposer 调用记录。 */
function registerIntoRecorder(runtime) {
  const registered = []
  const disposeCalls = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {
          disposeCalls.push(definition.name)
        }
      },
    },
  }
  const disposers = registerAllTools(ctx, runtime)
  return { registered, disposers, disposeCalls }
}

// 网络闸门：本文件里的任何代码只要碰 fetch 就会立刻炸掉，而不是悄悄发出去。
let realFetch = null
before(() => {
  realFetch = globalThis.fetch
  globalThis.fetch = () => {
    throw new Error('core-baseline 禁止网络请求')
  }
})
after(() => {
  if (realFetch) globalThis.fetch = realFetch
})

test('网络闸门已生效，测试期间不存在静默外呼', () => {
  assert.throws(() => globalThis.fetch('http://127.0.0.1/'), /禁止网络请求/)
})

test('六工具全部注册且各注册一次，注册顺序不变', () => {
  const { registered } = registerIntoRecorder({ logger: SILENT_LOGGER })
  const names = registered.map((definition) => definition.name)

  // 总数不钉死：T02 起会加 ComfyUI 工具，这里只要求"只增不减"。
  assert.ok(
    names.length >= CORE_TOOL_ORDER.length,
    `注册数量 ${names.length} 少于基线 ${CORE_TOOL_ORDER.length}`,
  )
  assert.equal(new Set(names).size, names.length, `工具名重复：${names.join(', ')}`)

  for (const name of CORE_TOOL_ORDER) {
    assert.equal(names.filter((item) => item === name).length, 1, `${name} 应当恰好注册一次`)
  }

  // 只比较基线这六个之间的相对顺序，后加的工具插在哪儿都不影响。
  assert.deepEqual(
    names.filter((name) => CORE_TOOL_ORDER.includes(name)),
    CORE_TOOL_ORDER,
  )
})

test('六工具的参数 Schema 与基线逐字一致', () => {
  const { registered } = registerIntoRecorder({ logger: SILENT_LOGGER })
  const byName = new Map(registered.map((definition) => [definition.name, definition]))

  for (const name of CORE_TOOL_ORDER) {
    const definition = byName.get(name)
    assert.ok(definition, `缺少工具 ${name}`)

    const parameters = definition.parameters
    assert.equal(parameters?.type, 'object', `${name} 的 parameters.type 应为 object`)
    assert.equal(parameters?.additionalProperties, false, `${name} 必须禁止未知参数`)

    assert.deepEqual(
      [...Object.keys(parameters.properties ?? {})].sort(),
      [...CORE_TOOL_PROPERTIES[name]].sort(),
      `${name} 的参数名发生了变化`,
    )
    assert.deepEqual(
      parameters.required ?? null,
      CORE_TOOL_REQUIRED[name],
      `${name} 的 required 发生了变化`,
    )
    assert.equal(
      sha256(canonicalJson(parameters)),
      CORE_TOOL_SCHEMA_SHA256[name],
      `${name} 的参数 Schema 内容发生了变化（枚举、范围或描述被改过）`,
    )
  }
})

test('disposer 数量与注册数量一致，且都能执行清理', () => {
  const { registered, disposers, disposeCalls } = registerIntoRecorder({ logger: SILENT_LOGGER })

  assert.equal(disposers.length, registered.length)
  for (const dispose of disposers) assert.equal(typeof dispose, 'function')

  for (const dispose of disposers) dispose()

  assert.equal(disposeCalls.length, registered.length)
  assert.deepEqual(disposeCalls, registered.map((definition) => definition.name))
})

test('固定 IR 的编译结果与基线哈希一致', async () => {
  const ir = readJson('scripts/fixtures/promptlens/baseline-ir.json')
  const preset = readJson('configs/presets/detail-standard.json')
  const profileConfig = readJson('configs/model-profiles/illustrious.json')

  // 走真实的档案解析，而不是自己把 config 对象塞给编译器。
  const store = {
    listModelProfileIds: () => [{ config_id: 'illustrious', aliases: profileConfig.aliases ?? [] }],
    getModelProfile: (id) =>
      id === 'illustrious'
        ? {
            config_id: 'illustrious',
            relative_file: 'configs/model-profiles/illustrious.json',
            schema_version: '2.0',
            config: profileConfig,
          }
        : null,
  }
  const resolved = resolveProfileRequest(store, { profile_id: 'illustrious' })
  assert.deepEqual(resolved.diagnostics, [])
  assert.ok(resolved.profile, 'illustrious 档案解析失败')

  const compile = () =>
    compilePrompt({
      ir,
      profile: resolved.profile,
      preset,
      kb: null,
      includeNegative: true,
      detailLevel: 'standard',
    })

  const first = await compile()
  const second = await compile()

  assert.equal(first.schema_version, '2.0')
  assert.equal(first.target_profile, 'illustrious')
  assert.equal(first.register, 'tag')

  for (const field of ['positive', 'description', 'negative']) {
    const actual = first.prompts[field]
    assert.equal(typeof actual, 'string')
    assert.equal(actual.length, PROMPT_BASELINE[field].length, `${field} 长度发生了变化`)
    assert.equal(sha256(actual), PROMPT_BASELINE[field].sha256, `${field} 内容发生了变化`)
  }

  // 同一份输入跑两次必须一模一样，否则基线本身就是浮动的。
  assert.deepEqual(second.prompts, first.prompts)
})

test('默认配置与内置默认值完全一致，且不产生诊断', () => {
  const resolved = resolvePluginConfig({})
  assert.deepEqual(resolved.config, DEFAULT_PLUGIN_CONFIG)
  assert.deepEqual(resolved.diagnostics, [])
})

test('配置里的疑似密钥会被判为 error', () => {
  const resolved = resolvePluginConfig({ api_key: 'placeholder-value' })
  const hit = resolved.diagnostics.find(
    (item) => item.error_code === 'PLUGIN_CONFIG_SECRET_IN_CONFIG',
  )
  assert.ok(hit, '未检出密钥明文')
  assert.equal(hit.severity, 'error')
  assert.equal(hit.field_path, '/api_key')
})

test('数值越界会被判为 error', () => {
  const resolved = resolvePluginConfig({ image: { max_edge: 8 } })
  const hit = resolved.diagnostics.find(
    (item) => item.error_code === 'PLUGIN_CONFIG_VALUE_OUT_OF_RANGE',
  )
  assert.ok(hit, '未检出数值越界')
  assert.equal(hit.severity, 'error')
  assert.equal(hit.field_path, '/image/max_edge')
})

test('知识库未初始化时 runtime.dispose() 不抛异常', async () => {
  const runtime = createRuntime({ ctx: {}, config: {}, logger: SILENT_LOGGER })
  assert.equal(typeof runtime.dispose, 'function')

  await runtime.dispose()
  // 重复调用也必须安全：卸载路径可能因为重载被执行两次。
  await runtime.dispose()
})

test('PLUGIN_VERSION 与 package.json 的 version 一致', () => {
  const pkg = readJson('package.json')
  assert.equal(PLUGIN_VERSION, pkg.version)
})

// ─────────────────────────── T02：ComfyUI 配置与生命周期 ───────────────────────────
// 这一段只测"配置能进、能校验、能释放"。模型扫描、工作流、HTTP 都还没写，
// 所以这里不该出现任何请求或文件读取。

test('ComfyUI 默认打开并默认自动发现，默认值取自内置默认配置', () => {
  const resolved = resolvePluginConfig({})
  // 装完即用：默认 enabled=true + autoDetect=true，不要求用户先填路径。
  // 显式写 false 才是关闭，见下面"显式关闭"的用例。
  assert.equal(resolved.config.comfyui.enabled, true)
  assert.equal(resolved.config.comfyui.autoDetect, true)
  assert.equal(resolved.config.comfyui.baseUrl, DEFAULT_COMFY_BASE_URL)
  assert.equal(resolved.config.comfyui.installRoot, null)
  assert.deepEqual(resolved.config.comfyui.extraModelPathsConfigFiles, [])
  assert.deepEqual(resolved.config.comfyui.additionalModelRoots, [])
  assert.equal(resolved.config.comfyui.requestTimeoutMs, DEFAULT_COMFY_TIMEOUT_MS)

  // 默认关闭时不许产生任何 comfyui 相关诊断，否则每次启动都会刷屏。
  const noisy = resolved.diagnostics.filter((item) => String(item.field_path).startsWith('/comfyui'))
  assert.deepEqual(noisy, [])
})

test('合法的 comfyui 配置被接受，URL 归一化且未知字段被清掉', () => {
  const resolved = resolvePluginConfig({
    comfyui: {
      enabled: true,
      baseUrl: 'http://127.0.0.1:8188///',
      installRoot: 'D:\\ComfyUI',
      extraModelPathsConfigFiles: ['D:\\ComfyUI\\extra_model_paths.yaml'],
      additionalModelRoots: ['E:\\models\\checkpoints'],
      requestTimeoutMs: 45000,
    },
  })

  assert.deepEqual(resolved.diagnostics, [])
  assert.equal(resolved.config.comfyui.enabled, true)
  // 尾部斜杠被吃掉，否则后面拼 /prompt 会拼出 //prompt。
  assert.equal(resolved.config.comfyui.baseUrl, 'http://127.0.0.1:8188')
  assert.equal(resolved.config.comfyui.installRoot, 'D:\\ComfyUI')
  assert.deepEqual(resolved.config.comfyui.extraModelPathsConfigFiles, [
    'D:\\ComfyUI\\extra_model_paths.yaml',
  ])
  assert.equal(resolved.config.comfyui.requestTimeoutMs, 45000)
})

test('comfyui 段的未知字段被拒，且不会留在解析结果里', () => {
  const resolved = resolvePluginConfig({ comfyui: { enabled: true, apiKeyHint: 'x' } })
  const hit = resolved.diagnostics.find((item) => item.field_path === '/comfyui/apiKeyHint')
  assert.ok(hit, '未检出未知字段')
  assert.equal(hit.error_code, COMFY_CODES.VALIDATION_FAILED)
  assert.equal(hit.severity, 'error')
  assert.equal('apiKeyHint' in resolved.config.comfyui, false)
})

test('非本机 baseUrl、内嵌凭据与非法协议都被拒', () => {
  const remote = parseLoopbackBaseUrl('http://192.168.1.20:8188')
  assert.equal(remote.ok, false)
  assert.equal(remote.code, COMFY_CODES.TARGET_NOT_LOCAL)

  const creds = parseLoopbackBaseUrl('http://user:pw@127.0.0.1:8188')
  assert.equal(creds.ok, false)
  assert.equal(creds.code, COMFY_CODES.VALIDATION_FAILED)

  const proto = parseLoopbackBaseUrl('ftp://127.0.0.1:8188')
  assert.equal(proto.ok, false)
  assert.equal(proto.code, COMFY_CODES.VALIDATION_FAILED)

  // 被拒之后必须回退成默认值，不能把非法 URL 留在配置里等着后面真去连。
  const resolved = resolvePluginConfig({ comfyui: { baseUrl: 'http://192.168.1.20:8188' } })
  assert.equal(resolved.config.comfyui.baseUrl, DEFAULT_COMFY_BASE_URL)
  assert.equal(resolved.config.comfyui.enabled, false)
})

test('非法超时值与非绝对路径分别被判为错误', () => {
  const notNumber = resolvePluginConfig({ comfyui: { requestTimeoutMs: 'soon' } })
  const typeHit = notNumber.diagnostics.find(
    (item) => item.field_path === '/comfyui/requestTimeoutMs',
  )
  assert.ok(typeHit)
  assert.equal(typeHit.error_code, COMFY_CODES.VALIDATION_FAILED)

  const tooSmall = resolvePluginConfig({ comfyui: { requestTimeoutMs: 50 } })
  const rangeHit = tooSmall.diagnostics.find(
    (item) => item.field_path === '/comfyui/requestTimeoutMs',
  )
  assert.ok(rangeHit)
  assert.equal(rangeHit.error_code, 'PLUGIN_CONFIG_VALUE_OUT_OF_RANGE')

  const relative = resolvePluginConfig({ comfyui: { installRoot: './ComfyUI' } })
  const pathHit = relative.diagnostics.find((item) => item.field_path === '/comfyui/installRoot')
  assert.ok(pathHit)
  assert.equal(pathHit.error_code, COMFY_CODES.PATH_UNRESOLVED)
  assert.equal(relative.config.comfyui.installRoot, null)
})

test('schema 的 comfyui 块与内置默认值互相吻合', () => {
  const block = PLUGIN_CONFIG_SCHEMA.properties.comfyui
  assert.ok(block, 'schema 里没有 comfyui 块')
  assert.equal(block.additionalProperties, false)

  // 默认配置里的每个键都必须在 schema 里声明，否则校验器会把它当未知字段拒掉。
  assert.deepEqual(Object.keys(DEFAULT_PLUGIN_CONFIG.comfyui).sort(), Object.keys(block.properties).sort())
  for (const [key, spec] of Object.entries(block.properties)) {
    const value = DEFAULT_PLUGIN_CONFIG.comfyui[key]
    if (spec.type === 'boolean') assert.equal(typeof value, 'boolean', `${key} 默认值类型不对`)
    if (spec.type === 'array') assert.ok(Array.isArray(value), `${key} 默认值类型不对`)
    if (spec.type === 'integer') {
      assert.ok(Number.isInteger(value), `${key} 默认值类型不对`)
      assert.ok(value >= spec.minimum && value <= spec.maximum, `${key} 默认值越界`)
    }
  }
})

test('ComfyUI 运行时惰性初始化既不碰文件系统也不联网', async () => {
  // ctx.fs 上任何一次属性访问都会炸：用来证明建运行时与初始化没有偷偷读盘。
  const forbiddenCtx = new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`ComfyUI 骨架不允许访问 ctx.${String(prop)}`)
      },
    },
  )
  const runtime = createRuntime({
    ctx: forbiddenCtx,
    config: { comfyui: { enabled: true, installRoot: 'D:\\ComfyUI' } },
    logger: SILENT_LOGGER,
  })

  // fetch 已被本文件的闸门换成抛错函数，这里只要真发请求就会红。
  const comfy = await runtime.getComfyUI()
  assert.equal(comfy.phase, 'idle')

  const described = await comfy.initialize()
  assert.equal(described.phase, 'ready')
  assert.equal(described.enabled, true)
  assert.equal(described.base_url, DEFAULT_COMFY_BASE_URL)
  // T02 时这里断言的是"全部未实现"；T03–T09 落地后，标志位必须如实变成 true，
  // 否则工具会拿着过期的自述去骗调用方。键集合仍然固定，防止悄悄加能力不登记。
  assert.deepEqual(
    Object.keys(described.implemented).sort(),
    ['launch', 'model_catalog', 'model_scan', 'query', 'submit', 'workflow_patch', 'workflow_read'],
  )
  assert.equal(described.implemented.model_scan, true)
  assert.equal(described.implemented.submit, true)

  // 重复初始化不推进计数，也不产生副作用。
  const again = await comfy.initialize()
  assert.equal(again.initialize_count, 1)
  await runtime.dispose()
})

test('知识库从未初始化时，dispose 仍然释放 ComfyUI 资源', async () => {
  const runtime = createRuntime({
    ctx: {},
    config: { comfyui: { enabled: true } },
    logger: SILENT_LOGGER,
  })
  const comfy = await runtime.getComfyUI()
  assert.equal(comfy.phase, 'idle')

  await runtime.dispose()
  assert.equal(comfy.phase, 'disposed')
  assert.equal(comfy.enabled, false)

  // 释放之后不再提供能力，且抛出的是带建议的 ComfyError。
  await assert.rejects(() => comfy.initialize(), (error) => {
    assert.ok(error instanceof ComfyError)
    assert.equal(error.code, COMFY_CODES.CAPABILITY_UNAVAILABLE)
    assert.ok(error.suggested_fix.length > 0)
    return true
  })
})

test('重复 dispose 不抛错，ComfyUI 只释放一次', async () => {
  const runtime = createRuntime({
    ctx: {},
    config: { comfyui: { enabled: true } },
    logger: SILENT_LOGGER,
  })
  const comfy = await runtime.getComfyUI()
  await runtime.dispose()
  assert.equal(comfy.phase, 'disposed')
  assert.equal(comfy.dispose(), false, '第二次释放应当返回 false 而不是再执行一遍')
  await runtime.dispose()

  // 从未取用 ComfyUI 的运行时也必须能安全释放。
  const untouched = createRuntime({ ctx: {}, config: {}, logger: SILENT_LOGGER })
  await untouched.dispose()
  await untouched.dispose()
})

test('COMFY 错误码与规划文档 H4 的清单逐字一致', () => {
  const expected = [
    'COMFY_NOT_CONFIGURED',
    'COMFY_TARGET_NOT_LOCAL',
    'COMFY_PATH_MISSING',
    'COMFY_PATH_DENIED',
    'COMFY_PATH_UNRESOLVED',
    'COMFY_SCAN_PARTIAL',
    'COMFY_CACHE_STALE',
    'COMFY_CONNECTION_FAILED',
    'COMFY_BAD_RESPONSE',
    'COMFY_CAPABILITY_UNAVAILABLE',
    'COMFY_WORKFLOW_FORMAT_UNSUPPORTED',
    'COMFY_NODE_UNSUPPORTED',
    'COMFY_BINDING_AMBIGUOUS',
    'COMFY_WORKFLOW_STALE',
    'COMFY_UNSAFE_INTEGER',
    'COMFY_VALIDATION_FAILED',
    'COMFY_MODEL_SELECTOR_UNAVAILABLE',
    'COMFY_SUBMISSION_REJECTED',
    'COMFY_SUBMISSION_UNKNOWN',
    'COMFY_EXECUTION_FAILED',
    'COMFY_OUTPUT_UNAVAILABLE',
  ]
  assert.deepEqual(Object.values(COMFY_CODES).sort(), [...expected].sort())

  // 每个码都要有中文修复建议，否则诊断里会出现空字段。
  const settings = normalizeComfySettings({})
  assert.deepEqual(settings.diagnostics, [])
  for (const code of expected) {
    const error = new ComfyError(code, '占位')
    assert.ok(error.suggested_fix.length > 0, `${code} 缺少 suggested_fix`)
    assert.equal(error.toDiagnostic().error_code, code)
  }
})

// ---------------------------------------------------------------------------
// T03–T09：ComfyUI 集成。全部走注入的 fs 与 fetch，不读真实磁盘、不连真机。
// 这些用例证明本地逻辑与协议处理正确，不代表真实 ComfyUI 已经跑通生图。
// ---------------------------------------------------------------------------

function readFixture(name) {
  return readFileSync(join(PACKAGE_DIR, 'scripts', 'fixtures', 'comfyui', name), 'utf8')
}

function modelRoot(path, extra = {}) {
  return { path, source: 'user_root', category: null, category_raw: null, is_default: false, ...extra }
}

test('ntpath.join 的三条分支都按 Python 语义走，而不是 path.join', () => {
  // 子路径自带盘符：Python 丢弃 base，path.join 会拼成嵌套路径。
  assert.equal(joinLikePython('D:\\models', 'D:\\other'), 'D:\\other')
  // 子路径无盘符但绝对：借用 base 的盘符。
  assert.equal(joinLikePython('D:\\models', '\\abs'), 'D:\\abs')
  // 相对子路径：拼接。
  assert.equal(joinLikePython('D:\\models', 'sub'), 'D:\\models\\sub')
  // 正斜杠写法同样成立。
  assert.equal(joinLikePython('D:/models', '/abs'), 'D:\\abs')
})

test('extra_model_paths.yaml 的 base_path、is_default、多行分类与别名都能解析', () => {
  const text = readFixture('extra_model_paths.yaml')
  const { roots, diagnostics } = parseModelPathsYaml(text, {
    yamlFile: 'D:/ComfyUI/extra_model_paths.yaml',
    yamlDir: 'D:/ComfyUI',
    env: {},
    homedir: 'C:/Users/tester',
    windows: true,
    YAML,
  })
  assert.equal(diagnostics.length, 0)

  const byKey = (raw, pathRaw) => roots.find((root) => root.category_raw === raw && root.path_raw === pathRaw)

  // 多行写法：一个分类切出两个目录。
  assert.ok(byKey('checkpoints', 'models/checkpoints'))
  assert.ok(byKey('checkpoints', 'D:/Extra/checkpoints'))
  // 相对 base_path 拼到 YAML 目录，绝对路径原样保留。
  assert.equal(byKey('checkpoints', 'models/checkpoints').path, 'D:\\ComfyUI\\models\\checkpoints')
  // 绝对路径不做拼接，但仍然要过 normpath——ComfyUI 的 extra_config.py 就是这么写的。
  assert.equal(byKey('checkpoints', 'D:/Extra/checkpoints').path, 'D:\\Extra\\checkpoints')

  // 别名保留原始名，同时给出规范名。
  assert.equal(byKey('clip', 'models/clip').category, 'text_encoders')
  assert.equal(byKey('unet', 'models/unet').category, 'diffusion_models')
  // 未知分类不丢。
  assert.equal(byKey('my_custom_category', 'models/my_custom_category').category, 'my_custom_category')
  // is_default 按配置块生效。
  assert.equal(byKey('loras', 'models/loras').is_default, true)
  assert.equal(byKey('text_encoders', 'te').is_default, false)
  // 第二个块的相对路径相对它自己的 base_path。
  assert.equal(byKey('text_encoders', 'te').path, 'D:\\ComfyUI\\models\\te')
})

test('YAML 的多文档、非映射顶层与超大内容都被拒绝', () => {
  const base = { yamlFile: 'x.yaml', yamlDir: 'D:/x', env: {}, homedir: null, windows: true, YAML }

  assert.throws(() => parseModelPathsYaml(readFixture('extra_model_paths_multidoc.yaml'), base), /单文档/)

  assert.throws(() => parseModelPathsYaml('- a\n- b\n', base), /顶层必须是映射/)

  const huge = `a:\n  checkpoints: ${'x'.repeat(1024 * 1024 + 10)}\n`
  assert.throws(() => parseModelPathsYaml(huge, base), /上限/)

  assert.throws(() => parseModelPathsYaml('a:\n  b: [1, 2\n', base), /语法错误/)
})

test('环境变量与用户目录取不到时标记未解析，不猜也不静默替换', () => {
  const text = 'a:\n  base_path: D:/x\n  checkpoints: "%NOPE_VAR%/ckpt"\n  loras: "~/loras"\n'
  const { roots } = parseModelPathsYaml(text, {
    yamlFile: 'D:/x/extra_model_paths.yaml',
    yamlDir: 'D:/x',
    env: {},
    homedir: null,
    windows: true,
    YAML,
  })
  const ckpt = roots.find((root) => root.category_raw === 'checkpoints')
  assert.equal(ckpt.path, null)
  assert.match(ckpt.unresolved, /环境变量/)
  const loras = roots.find((root) => root.category_raw === 'loras')
  assert.equal(loras.path, null)
  assert.match(loras.unresolved, /用户目录/)

  // 变量存在时正常展开。
  const resolved = parseModelPathsYaml(text, {
    yamlFile: 'D:/x/extra_model_paths.yaml',
    yamlDir: 'D:/x',
    env: { NOPE_VAR: 'E:/models' },
    homedir: 'C:/Users/tester',
    windows: true,
    YAML,
  })
  assert.equal(resolved.roots.find((r) => r.category_raw === 'checkpoints').path, 'E:\\models\\ckpt')
  assert.equal(resolved.roots.find((r) => r.category_raw === 'loras').path, 'C:\\Users\\tester\\loras')
})

test('分类别名只做映射，不改大小写也不丢原始名', () => {
  assert.equal(canonicalCategory('clip'), 'text_encoders')
  assert.equal(canonicalCategory('unet'), 'diffusion_models')
  assert.equal(canonicalCategory('Checkpoints'), 'Checkpoints')
  assert.equal(canonicalCategory('whatever'), 'whatever')
})

const MODEL_TREE = {
  'D:/ComfyUI/models': { type: 'directory' },
  'D:/ComfyUI/models/checkpoints': { type: 'directory' },
  'D:/ComfyUI/models/checkpoints/sd15.safetensors': { type: 'file', size: 100 },
  'D:/ComfyUI/models/checkpoints/sub': { type: 'directory' },
  'D:/ComfyUI/models/checkpoints/sub/deep.ckpt': { type: 'file', size: 200 },
  'D:/ComfyUI/models/checkpoints/readme.txt': { type: 'file', size: 3 },
  'D:/ComfyUI/models/loras': { type: 'directory' },
  'D:/ComfyUI/models/loras/detail.safetensors': { type: 'file', size: 50 },
  'D:/ComfyUI/models/empty': { type: 'directory' },
  'D:/ComfyUI/models/mystery': { type: 'directory' },
  'D:/ComfyUI/models/mystery/thing.weird': { type: 'file', size: 7 },
  'D:/ComfyUI/models/locked': { type: 'directory' },
  'D:/ComfyUI/models/locked/secret.safetensors': { type: 'file', size: 9 },
  'D:/Extra/checkpoints': { type: 'directory' },
  'D:/Extra/checkpoints/sd15.safetensors': { type: 'file', size: 111 },
}

test('模型扫描覆盖多分类、多级子目录与未知扩展名，且不靠 mtime 判断', async () => {
  const fs = createMemoryFs({ tree: MODEL_TREE })
  const result = await scanModelRoots(fs, [modelRoot('D:/ComfyUI/models')])

  assert.equal(result.partial, false)
  assert.deepEqual(result.categories, ['checkpoints', 'empty', 'locked', 'loras', 'mystery'])

  const names = result.entries.map((entry) => entry.relative_path).sort()
  assert.deepEqual(names, [
    'checkpoints/readme.txt',
    'checkpoints/sd15.safetensors',
    'checkpoints/sub/deep.ckpt',
    'locked/secret.safetensors',
    'loras/detail.safetensors',
    'mystery/thing.weird',
  ])

  // 未知扩展名保留，只是不标成已知格式。
  const weird = result.entries.find((entry) => entry.name === 'thing.weird')
  assert.equal(weird.known_format, false)
  assert.equal(weird.extension, '.weird')
  assert.equal(weird.size, 7)

  // 只读元数据：全程没有读过任何文件内容。
  assert.equal(fs.stats.readCalls, 0)
  // 每个条目都带 FsVersion 与大小，没有伪造的时间戳字段。
  for (const entry of result.entries) {
    assert.equal(entry.version, 'v1')
    assert.equal('mtime' in entry, false)
  }
})

test('同名模型出现在不同根时不合并，来源与优先级都保留', async () => {
  const fs = createMemoryFs({ tree: MODEL_TREE })
  const result = await scanModelRoots(fs, [
    modelRoot('D:/ComfyUI/models', { priority: 0 }),
    modelRoot('D:/Extra/checkpoints', { priority: 1 }),
  ])
  const same = result.entries.filter((entry) => entry.name === 'sd15.safetensors')
  assert.equal(same.length, 2)
  assert.deepEqual(same.map((entry) => entry.root).sort(), [
    'D:/ComfyUI/models',
    'D:/Extra/checkpoints',
  ])
  for (const entry of same) assert.equal(entry.sources.length, 1)
})

test('权限拒绝只影响那一个目录：返回部分结果并如实标记 partial', async () => {
  const fs = createMemoryFs({ tree: MODEL_TREE, deny: ['D:/ComfyUI/models/locked'] })
  const result = await scanModelRoots(fs, [modelRoot('D:/ComfyUI/models')])

  assert.equal(result.partial, true)
  assert.ok(result.diagnostics.some((item) => item.error_code === COMFY_CODES.PATH_DENIED))
  assert.equal(result.entries.some((entry) => entry.relative_path.startsWith('locked/')), false)
  // 其它分类照常返回，部分成功没有被伪装成完整成功。
  assert.ok(result.entries.some((entry) => entry.name === 'sd15.safetensors'))
})

test('越界符号链接被跳过，环状链接不会让扫描停不下来', async () => {
  const fs = createMemoryFs({
    tree: MODEL_TREE,
    symlinks: {
      'D:/ComfyUI/models/escape': 'D:/Outside',
      'D:/ComfyUI/models/loop': 'D:/ComfyUI/models',
    },
  })
  const outside = {
    'D:/Outside': { type: 'directory' },
    'D:/Outside/private.safetensors': { type: 'file', size: 1 },
  }
  const merged = createMemoryFs({ tree: { ...MODEL_TREE, ...outside }, symlinks: {
    'D:/ComfyUI/models/escape': 'D:/Outside',
    'D:/ComfyUI/models/loop': 'D:/ComfyUI/models',
  } })

  const result = await scanModelRoots(merged, [modelRoot('D:/ComfyUI/models')])
  assert.equal(result.entries.some((entry) => entry.name === 'private.safetensors'), false)
  assert.ok(result.diagnostics.some((item) => /之外/.test(item.message)))
  // 环被 targetKey 去重挡住：每个文件只出现一次。
  const ids = result.entries.map((entry) => entry.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('深度上限与条目上限触发 SCAN_PARTIAL，扫描提前停止但保留已扫到的结果', async () => {
  const fs = createMemoryFs({ tree: MODEL_TREE })
  const shallow = await scanRoot(fs, modelRoot('D:/ComfyUI/models/checkpoints'), { maxDepth: 0 })
  assert.equal(shallow.partial, true)
  assert.ok(shallow.diagnostics.some((item) => item.error_code === COMFY_CODES.SCAN_PARTIAL))
  assert.equal(shallow.entries.some((entry) => entry.relative_path === 'sub/deep.ckpt'), false)

  const capped = await scanRoot(fs, modelRoot('D:/ComfyUI/models'), { maxEntries: 1 })
  assert.equal(capped.partial, true)
  assert.equal(capped.entries.length, 1)
})

test('扫描可以被取消，取消后标记 cancelled 而不是当作完整结果', async () => {
  const fs = createMemoryFs({ tree: MODEL_TREE })
  const controller = new AbortController()
  controller.abort()
  const result = await scanRoot(fs, modelRoot('D:/ComfyUI/models'), { signal: controller.signal })
  assert.equal(result.cancelled, true)
  assert.equal(result.partial, true)
})

test('运行时不可达时三个运行时状态都是 unknown，而不是 false', () => {
  const entries = [
    { id: 'a', name: 'sd15.safetensors', category: 'checkpoints', relative_path: 'checkpoints/sd15.safetensors' },
  ]
  const result = reconcileModels({ entries, models: null, loaderEnums: null, runtimeAvailable: false })
  const states = result.entries[0].states
  assert.equal(states.disk_present, 'true')
  assert.equal(states.runtime_visible, 'unknown')
  assert.equal(states.loader_selectable, 'unknown')
  assert.equal(states.execution_success, 'unknown')
  assert.ok(result.diagnostics.some((item) => item.error_code === COMFY_CODES.CAPABILITY_UNAVAILABLE))
})

test('四态各自独立：可见不等于可选，虚拟枚举不会被当成磁盘模型', () => {
  const entries = [
    { id: 'a', name: 'sd15.safetensors', category: 'checkpoints', relative_path: 'checkpoints/sd15.safetensors' },
    { id: 'b', name: 'vae-ft-mse.safetensors', category: 'vae', relative_path: 'vae/vae-ft-mse.safetensors' },
  ]
  const objectInfo = readJson('scripts/fixtures/comfyui/object_info.json')
  const result = reconcileModels({
    entries,
    models: { checkpoints: ['sd15.safetensors'], vae: ['vae-ft-mse.safetensors', 'pixel_space', 'taesd'] },
    loaderEnums: { CheckpointLoaderSimple: objectInfo.CheckpointLoaderSimple, VAELoader: objectInfo.VAELoader },
    runtimeAvailable: true,
  })

  const ckpt = result.entries.find((entry) => entry.name === 'sd15.safetensors')
  assert.equal(ckpt.states.runtime_visible, 'true')
  assert.equal(ckpt.states.loader_selectable, 'true')
  assert.equal(ckpt.states.execution_success, 'unknown')

  // /models 里出现、磁盘上没有的项单独列出，并标出哪些是虚拟项。
  assert.deepEqual(result.virtual.map((item) => item.name).sort(), ['pixel_space', 'taesd'])
  assert.ok(result.virtual.every((item) => item.virtual === true))
  assert.ok(result.virtual.every((item) => item.states.disk_present === 'false'))

  // 过滤按四态取值，'unknown' 也能筛。
  assert.equal(filterByStates(result.entries, { execution_success: 'unknown' }).length, 2)
  assert.equal(filterByStates(result.entries, { execution_success: 'true' }).length, 0)
})

test('客户端拒绝远程地址、内嵌凭据与非法协议', () => {
  for (const bad of ['http://192.168.1.10:8188', 'http://user:pass@127.0.0.1:8188', 'ftp://127.0.0.1:8188']) {
    assert.throws(() => createComfyClient({ baseUrl: bad, fetchImpl: async () => jsonResponse(200, {}) }), (error) => {
      assert.equal(error.code, COMFY_CODES.TARGET_NOT_LOCAL)
      return true
    })
  }
  // 本机地址正常，origin 归一化掉多余路径。
  const client = createComfyClient({ baseUrl: 'http://127.0.0.1:8188/', fetchImpl: async () => jsonResponse(200, {}) })
  assert.equal(client.baseUrl, 'http://127.0.0.1:8188')
})

test('非法 JSON、超大响应与不可达都收敛成明确的错误码', async () => {
  const bad = createComfyClient({
    fetchImpl: async () => jsonResponse(200, 'not json at all'),
  })
  await assert.rejects(() => bad.getSystemStats(), (error) => {
    assert.equal(error.code, COMFY_CODES.BAD_RESPONSE)
    return true
  })

  const big = createComfyClient({
    maxResponseBytes: 16,
    fetchImpl: async () => jsonResponse(200, { padding: 'x'.repeat(200) }),
  })
  await assert.rejects(() => big.getSystemStats(), (error) => {
    assert.equal(error.code, COMFY_CODES.BAD_RESPONSE)
    assert.match(error.message, /上限/)
    return true
  })

  const down = createComfyClient({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED')
    },
    getRetries: 0,
  })
  await assert.rejects(() => down.getSystemStats(), (error) => {
    assert.equal(error.code, COMFY_CODES.CONNECTION_FAILED)
    return true
  })
})

test('未知节点返回 200 + 空对象时判为不可用，不能只看状态码', async () => {
  const fake = createFakeFetch({
    '/object_info': () => ({ CheckpointLoaderSimple: { input: { required: {} } } }),
    '/object_info/CheckpointLoaderSimple': () => ({ CheckpointLoaderSimple: { input: { required: {} } } }),
    '/object_info/NoSuchNode': () => ({}),
  })
  const client = createComfyClient({ fetchImpl: fake.fetchImpl })
  assert.equal(await client.getObjectInfoFor('NoSuchNode'), null)
  assert.ok(await client.getObjectInfoFor('CheckpointLoaderSimple'))
})

test('GET 会有限重试，POST 一次都不重发', async () => {
  let getAttempts = 0
  const getFake = createFakeFetch({
    '/system_stats': () => {
      getAttempts += 1
      if (getAttempts < 2) throw new Error('ECONNREFUSED')
      return { system: { os: 'nt' }, devices: [] }
    },
  })
  const getClient = createComfyClient({ fetchImpl: getFake.fetchImpl, getRetries: 2 })
  const stats = await getClient.getSystemStats()
  assert.equal(getAttempts, 2)
  assert.equal(stats.system.os, 'nt')

  const postFake = createFakeFetch({
    '/prompt': () => {
      throw new Error('ECONNRESET')
    },
  })
  const postClient = createComfyClient({ fetchImpl: postFake.fetchImpl, getRetries: 3 })
  await assert.rejects(() => postClient.postJson('/prompt', {}))
  assert.equal(postFake.calls.filter((call) => call.method === 'POST').length, 1)
})

test('请求带上 redirect:error，3xx 不会被静默跟到别的地址', async () => {
  let seen = null
  const client = createComfyClient({
    fetchImpl: async (_url, init) => {
      seen = init
      return jsonResponse(200, {})
    },
  })
  await client.getSystemStats()
  assert.equal(seen.redirect, 'error')
})

test('工作流格式识别：API、UI 与不支持三种', () => {
  const api = readJson('scripts/fixtures/comfyui/api-prompt.json')
  const ui = readJson('scripts/fixtures/comfyui/ui-workflow.json')
  assert.equal(detectWorkflowFormat(api), 'api')
  assert.equal(detectWorkflowFormat(ui), 'ui')
  assert.equal(detectWorkflowFormat({ hello: 1 }), 'unsupported')
  assert.equal(detectWorkflowFormat(null), 'unsupported')

  const uiReport = inspectWorkflow(ui)
  assert.equal(uiReport.format, 'ui')
  assert.equal(uiReport.node_count, 4)
  assert.equal(uiReport.link_count, 3)
  assert.equal(uiReport.convertible, false)
  assert.equal(uiReport.types.CLIPTextEncode, 2)

  assert.throws(() => inspectWorkflow({ hello: 1 }), (error) => {
    assert.equal(error.code, COMFY_CODES.WORKFLOW_FORMAT_UNSUPPORTED)
    return true
  })
})

test('正负提示词由 KSampler 的连接决定，与节点 ID 大小无关', () => {
  const prompt = readJson('scripts/fixtures/comfyui/api-prompt.json')
  const before = analyzeBindings(prompt)
  assert.equal(before.samplers[0].positive.node_id, '6')
  assert.equal(before.samplers[0].negative.node_id, '7')
  assert.equal(before.prompts.find((item) => item.id === '6').role, 'positive')

  // 把两个提示词节点的 ID 对调：连接指向不变，角色必须跟着连接走。
  const swapped = JSON.parse(JSON.stringify(prompt))
  swapped['99'] = swapped['6']
  swapped['6'] = swapped['7']
  swapped['7'] = swapped['99']
  delete swapped['99']
  swapped['4'].inputs.positive = ['7', 0]
  swapped['4'].inputs.negative = ['6', 0]

  const after = analyzeBindings(swapped)
  assert.equal(after.samplers[0].positive.node_id, '7')
  assert.equal(after.prompts.find((item) => item.id === '7').role, 'positive')
  assert.equal(after.prompts.find((item) => item.id === '7').text, 'a quiet street at dawn')
})

test('多个 KSampler 时不猜，返回候选并要求显式指定', () => {
  const prompt = readJson('scripts/fixtures/comfyui/api-prompt.json')
  prompt['10'] = JSON.parse(JSON.stringify(prompt['4']))
  const bindings = analyzeBindings(prompt)
  assert.equal(bindings.samplers.length, 2)

  assert.throws(() => resolvePromptTarget(prompt, 'positive'), (error) => {
    assert.equal(error.code, COMFY_CODES.BINDING_AMBIGUOUS)
    assert.deepEqual(error.candidates.sort(), ['10', '4'])
    return true
  })
  // 指定之后就唯一了。
  assert.equal(resolvePromptTarget(prompt, 'positive', '4').node_id, '6')
})

test('失效连接与不支持节点都明确报告，不静默跳过', () => {
  const prompt = readJson('scripts/fixtures/comfyui/api-prompt.json')
  prompt['4'].inputs.positive = ['404', 0]
  prompt['11'] = { class_type: 'SomeCustomNode', inputs: { whatever: 1 } }

  const report = inspectWorkflow(prompt)
  assert.equal(report.format, 'api')
  assert.ok(report.dangling_links.some((item) => item.target === '404'))
  assert.ok(report.unsupported.some((item) => item.class_type === 'SomeCustomNode'))
  assert.ok(report.diagnostics.some((item) => item.error_code === COMFY_CODES.NODE_UNSUPPORTED))
})

test('合法补丁只改指定字段，其它字段与连接原样保留', () => {
  const prompt = readJson('scripts/fixtures/comfyui/api-prompt.json')
  const objectInfo = readJson('scripts/fixtures/comfyui/object_info.json')
  const snapshot = JSON.stringify(prompt)

  const plan = planWorkflowPatch({
    prompt,
    objectInfo,
    changes: [{ node_id: '4', field: 'seed', value: 42 }],
  })

  assert.equal(plan.prompt['4'].inputs.seed, 42)
  // 未要求修改的一律不动：负向提示词、其它采样参数、连接结构。
  assert.equal(plan.prompt['7'].inputs.text, 'blurry, lowres')
  assert.equal(plan.prompt['4'].inputs.steps, 20)
  assert.deepEqual(plan.prompt['4'].inputs.positive, ['6', 0])
  // 节点数不变，没有新增也没有删除。
  assert.equal(plan.node_count_before, plan.node_count_after)
  // 原对象没有被就地修改。
  assert.equal(JSON.stringify(prompt), snapshot)
})

test('补丁全有或全无：一处非法则整份作废', () => {
  const prompt = readJson('scripts/fixtures/comfyui/api-prompt.json')
  const objectInfo = readJson('scripts/fixtures/comfyui/object_info.json')

  assert.throws(
    () =>
      planWorkflowPatch({
        prompt,
        objectInfo,
        changes: [
          { node_id: '4', field: 'seed', value: 7 },
          { node_id: '4', field: 'no_such_field', value: 1 },
        ],
      }),
    (error) => {
      assert.equal(error.code, COMFY_CODES.VALIDATION_FAILED)
      assert.equal(error.details.length, 1)
      assert.equal(error.details[0].field, 'no_such_field')
      return true
    },
  )

  // 不在白名单里的字段同样被拒。
  assert.throws(
    () => planWorkflowPatch({ prompt, objectInfo, changes: [{ node_id: '9', field: 'filename_prefix', value: 'x' }] }),
    (error) => {
      assert.equal(error.code, COMFY_CODES.NODE_UNSUPPORTED)
      return true
    },
  )

  // 枚举之外的采样器名被拒。
  assert.throws(
    () => planWorkflowPatch({ prompt, objectInfo, changes: [{ node_id: '4', field: 'sampler_name', value: 'nope' }] }),
    (error) => {
      assert.equal(error.code, COMFY_CODES.VALIDATION_FAILED)
      assert.match(error.message, /枚举/)
      return true
    },
  )

  // 超出节点 Schema 范围。
  assert.throws(
    () => planWorkflowPatch({ prompt, objectInfo, changes: [{ node_id: '4', field: 'steps', value: 0 }] }),
    (error) => {
      assert.equal(error.code, COMFY_CODES.VALIDATION_FAILED)
      return true
    },
  )
})

test('Seed 超出安全整数时拒绝，不舍入也不提交', () => {
  const prompt = readJson('scripts/fixtures/comfyui/api-prompt.json')
  const objectInfo = readJson('scripts/fixtures/comfyui/object_info.json')
  assert.throws(
    () =>
      planWorkflowPatch({
        prompt,
        objectInfo,
        changes: [{ node_id: '4', field: 'seed', value: Number.MAX_SAFE_INTEGER + 2 }],
      }),
    (error) => {
      assert.equal(error.code, COMFY_CODES.UNSAFE_INTEGER)
      assert.match(error.suggested_fix, /本插件/)
      return true
    },
  )
})

test('原工作流在生成补丁之后变化时，旧补丁被拒绝应用', () => {
  const prompt = readJson('scripts/fixtures/comfyui/api-prompt.json')
  const objectInfo = readJson('scripts/fixtures/comfyui/object_info.json')
  const plan = planWorkflowPatch({ prompt, objectInfo, changes: [{ node_id: '4', field: 'seed', value: 42 }] })

  assert.deepEqual(applyWorkflowPatch({ plan, prompt }).inputs ?? {}, {})

  const mutated = JSON.parse(JSON.stringify(prompt))
  mutated['4'].inputs.steps = 30
  assert.throws(() => applyWorkflowPatch({ plan, prompt: mutated }), (error) => {
    assert.equal(error.code, COMFY_CODES.WORKFLOW_STALE)
    return true
  })
  assert.equal(plan.workflow_id, stableFingerprint(prompt))
})

test('提交成功的最低条件是 200 + 合法 prompt_id + node_errors 为空', async () => {
  const okId = '11111111-2222-4333-8444-555555555555'
  const okFake = createFakeFetch({ '/prompt': () => ({ prompt_id: okId, number: 1, node_errors: {} }) })
  const okClient = createComfyClient({ fetchImpl: okFake.fetchImpl })
  const accepted = await submitPrompt({ client: okClient, prompt: {} })
  assert.equal(accepted.state, 'accepted')
  assert.equal(accepted.prompt_id, okId)
  assert.equal(isValidPromptId(okId), true)

  // HTTP 200 但 node_errors 非空：不能算成功。
  const badFake = createFakeFetch({
    '/prompt': () => ({ prompt_id: okId, node_errors: { '4': { class_type: 'KSampler', errors: [{ message: 'bad seed' }] } } }),
  })
  const rejected = await submitPrompt({ client: createComfyClient({ fetchImpl: badFake.fetchImpl }), prompt: {} })
  assert.equal(rejected.state, 'failed')
  assert.equal(rejected.error_code, COMFY_CODES.SUBMISSION_REJECTED)
  assert.equal(rejected.node_errors.length, 1)
  assert.equal(rejected.node_errors[0].node_id, '4')

  // 非规范 UUID 的 prompt_id 不能当作提交成功。
  const weirdFake = createFakeFetch({ '/prompt': () => ({ prompt_id: 'not-a-uuid', node_errors: {} }) })
  const unknown = await submitPrompt({ client: createComfyClient({ fetchImpl: weirdFake.fetchImpl }), prompt: {} })
  assert.equal(unknown.state, 'unknown')
  assert.equal(unknown.error_code, COMFY_CODES.SUBMISSION_UNKNOWN)
})

test('POST 超时或断连后记为 unknown，且绝不自动重发', async () => {
  let attempts = 0
  const fake = createFakeFetch({
    '/prompt': () => {
      attempts += 1
      throw new Error('socket hang up')
    },
  })
  const client = createComfyClient({ fetchImpl: fake.fetchImpl, getRetries: 5 })
  const run = await submitPrompt({ client, prompt: {} })

  assert.equal(run.state, 'unknown')
  assert.equal(run.error_code, COMFY_CODES.SUBMISSION_UNKNOWN)
  assert.match(run.message, /不会自动重发/)
  // 重试次数是给 GET 的；POST 只允许发出一次。
  assert.equal(attempts, 1)
})

test('查询只看历史里的真实状态：运行中、已完成、失败各不相同', async () => {
  const promptId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

  const runningFake = createFakeFetch({
    [`/history/${promptId}`]: () => ({}),
    '/queue': () => ({ queue_running: [[1, promptId]], queue_pending: [] }),
  })
  const running = await queryRun({
    client: createComfyClient({ fetchImpl: runningFake.fetchImpl }),
    run: { run_id: 'r1', prompt_id: promptId, state: 'accepted' },
  })
  assert.equal(running.state, 'running')

  const doneFake = createFakeFetch({
    [`/history/${promptId}`]: () => ({
      [promptId]: {
        status: { completed: true, status_str: 'success' },
        outputs: { '9': { images: [{ filename: 'ComfyUI_0001.png', subfolder: '', type: 'output' }] } },
      },
    }),
    '/queue': () => ({ queue_running: [], queue_pending: [] }),
  })
  const done = await queryRun({
    client: createComfyClient({ fetchImpl: doneFake.fetchImpl }),
    run: { run_id: 'r2', prompt_id: promptId, state: 'accepted' },
  })
  assert.equal(done.state, 'completed')
  assert.equal(done.images.length, 1)
  assert.equal(done.images[0].filename, 'ComfyUI_0001.png')

  const failedFake = createFakeFetch({
    [`/history/${promptId}`]: () => ({
      [promptId]: {
        status: {
          completed: false,
          status_str: 'error',
          messages: [['execution_error', { exception_message: 'CUDA out of memory' }]],
        },
        outputs: {},
      },
    }),
    '/queue': () => ({ queue_running: [], queue_pending: [] }),
  })
  const failed = await queryRun({
    client: createComfyClient({ fetchImpl: failedFake.fetchImpl }),
    run: { run_id: 'r3', prompt_id: promptId, state: 'accepted' },
  })
  assert.equal(failed.state, 'failed')
  assert.match(failed.message, /CUDA out of memory/)
})

test('输出图片只按 /view 参数拼 URL，带路径片段的名字被拒', () => {
  const client = createComfyClient({ fetchImpl: async () => jsonResponse(200, {}) })
  const url = client.viewUrl({ filename: 'a b.png', subfolder: 'sub', type: 'output' })
  assert.match(url, /\/view\?filename=a\+b\.png&subfolder=sub&type=output$/)

  assert.throws(
    () => imageViewUrl(client, { filename: '../../etc/passwd' }),
    (error) => {
      assert.equal(error.code, COMFY_CODES.OUTPUT_UNAVAILABLE)
      return true
    },
  )
})

test('未启用时七个工具一律返回 CAPABILITY_UNAVAILABLE，且不碰 fs 与网络', async () => {
  const forbiddenCtx = new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`未启用时不允许访问 ctx.${String(prop)}`)
      },
    },
  )
  const comfy = createComfyRuntime({
    ctx: forbiddenCtx,
    pluginConfig: { comfyui: { enabled: false } },
    logger: SILENT_LOGGER,
  })
  const fakeRuntime = { getComfyUI: async () => comfy, logger: SILENT_LOGGER }
  const specs = createComfyToolSpecs(fakeRuntime)

  assert.deepEqual(specs.map((spec) => spec.name), [
    'comfyui_status',
    'comfyui_list_models',
    'comfyui_inspect_workflow',
    'comfyui_plan_workflow_patch',
    'comfyui_submit_workflow',
    'comfyui_get_job',
    'comfyui_start',
  ])
  // 参数 Schema 一律 additionalProperties:false。
  for (const spec of specs) {
    assert.equal(spec.parameters.additionalProperties, false, `${spec.name} 缺少 additionalProperties:false`)
  }

  for (const spec of specs.filter((item) => item.name !== 'comfyui_status')) {
    const result = await spec.execute({}, {})
    assert.equal(result.status, 'failed', `${spec.name} 未启用时不该成功`)
    assert.equal(result.diagnostics[0].error_code, COMFY_CODES.CAPABILITY_UNAVAILABLE)
  }

  // status 在未启用时返回自述而不是抛错，方便用户看到原因。
  const status = await specs[0].execute({}, {})
  assert.equal(status.enabled, false)
  assert.equal(status.reachable, false)
})

test('远程 baseUrl 被拒时整个功能关闭，绝不回退成本机地址偷偷连上', async () => {
  // 用户写了远程地址、并且显式开了 enabled：这是最危险的一种组合。
  const resolved = resolvePluginConfig({
    comfyui: { enabled: true, baseUrl: 'http://10.0.0.5:8188' },
  })
  const settings = resolved.config.comfyui
  assert.equal(settings.enabled, false, '被拒的 baseUrl 不能留下一个仍启用的配置')
  assert.equal(settings.disabled_reason, COMFY_CODES.TARGET_NOT_LOCAL)
  assert.ok(resolved.diagnostics.some((item) => item.error_code === COMFY_CODES.TARGET_NOT_LOCAL))

  // 回退值只用来占位，不允许被当成"用户想要的本机地址"去连。
  const forbiddenCtx = new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`配置被拒时不允许访问 ctx.${String(prop)}`)
      },
    },
  )
  const comfy = createComfyRuntime({ ctx: forbiddenCtx, pluginConfig: resolved.config, logger: SILENT_LOGGER })
  const described = await comfy.initialize()
  assert.equal(described.enabled, false)
  assert.equal(described.disabled_reason, COMFY_CODES.TARGET_NOT_LOCAL)
  assert.equal(comfy.describe().enabled, false)

  assert.throws(
    () => comfy.ensureEnabled('扫描模型目录'),
    (error) => {
      assert.equal(error.code, COMFY_CODES.CAPABILITY_UNAVAILABLE)
      return true
    },
  )
  await comfy.dispose()
})

test('未启用时 dispose 之后工具不会复活运行时', async () => {
  const comfy = createComfyRuntime({
    ctx: {},
    pluginConfig: { comfyui: { enabled: true, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
  })
  await comfy.initialize()
  assert.equal(comfy.describe().enabled, true)
  assert.equal(await comfy.dispose(), true)
  assert.equal(comfy.phase, 'disposed')
  assert.throws(() => comfy.ensureEnabled('提交工作流'), (error) => {
    assert.equal(error.code, COMFY_CODES.CAPABILITY_UNAVAILABLE)
    return true
  })
  assert.equal(await comfy.dispose(), false)
})

test('本机地址会被环境代理劫持时拒绝建客户端，而不是让请求走出本机', () => {
  const proxied = { http_proxy: 'http://10.0.0.9:3128' }
  assert.throws(
    () => createComfyClient({ baseUrl: 'http://127.0.0.1:8188', env: proxied, fetchImpl: () => {} }),
    (error) => {
      assert.equal(error.code, COMFY_CODES.CAPABILITY_UNAVAILABLE)
      assert.match(error.message, /no_proxy/)
      return true
    },
  )
  // no_proxy 显式排除本机时才放行。
  const bypassed = { http_proxy: 'http://10.0.0.9:3128', no_proxy: 'localhost,127.0.0.1' }
  const client = createComfyClient({
    baseUrl: 'http://127.0.0.1:8188',
    env: bypassed,
    fetchImpl: () => {},
  })
  assert.equal(client.baseUrl, 'http://127.0.0.1:8188')
  // 通配符也算排除。
  assertLoopbackNotProxied('127.0.0.1', { env: { HTTP_PROXY: 'http://10.0.0.9:3128', NO_PROXY: '*' } })
})

test('输出图只按 /view 取字节，并交给 Host attachments 落盘', async () => {
  const requested = []
  const fetchImpl = async (url) => {
    requested.push(new URL(url).pathname + new URL(url).search)
    return imageResponse(pngBytes(64, 64))
  }
  const saved = []
  const attachments = {
    async saveImage(input) {
      saved.push(input)
      return { attachmentId: 'att_1', mediaType: input.mediaType, bytes: input.data.byteLength, width: 64, height: 64, name: input.name }
    },
  }
  const comfy = createComfyRuntime({
    ctx: { get: (key) => (key === 'attachments' ? attachments : undefined) },
    pluginConfig: { comfyui: { enabled: true, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl,
  })
  const result = await comfy.collectImages({
    run: { images: [{ filename: 'ComfyUI_0001.png', subfolder: 'out', type: 'output' }] },
  })
  assert.equal(result.attachments.length, 1)
  assert.equal(result.attachments[0].attachment_id, 'att_1')
  assert.equal(result.diagnostics.length, 0)
  assert.match(requested[0], /^\/view\?/)
  assert.match(requested[0], /filename=ComfyUI_0001\.png/)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].mediaType, 'image/png')
})

test('没有 attachments 服务时如实报告取图不可用，不伪造附件', async () => {
  const comfy = createComfyRuntime({
    ctx: {},
    pluginConfig: { comfyui: { enabled: true, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: async () => new Response(new Uint8Array([1]), { status: 200 }),
  })
  const result = await comfy.collectImages({
    run: { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] },
  })
  assert.equal(result.attachments.length, 0)
  assert.equal(result.diagnostics.length, 1)
  assert.equal(result.diagnostics[0].error_code, COMFY_CODES.OUTPUT_UNAVAILABLE)
  assert.match(result.images[0].url, /^http:\/\/127\.0\.0\.1:8188\/view\?/)
})

// ─────────────────────────── T10-AUTO：自动发现与默认启用 ───────────────────────────
// 这一段只证明"发现逻辑"正确。真实机器上的发现结果另行只读核对，
// 两者不能互相替代：内存 fs 里找到的安装，不代表这台电脑上真的装了 ComfyUI。

const WIN_ENV = {
  USERPROFILE: 'C:\\Users\\tester',
  LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
}

/** 一个能通过安装根判定的最小目录树：main.py + folder_paths.py 是硬标志。 */
function installTree(root) {
  return {
    [root]: { type: 'directory' },
    [`${root}/main.py`]: { type: 'file', size: 4096 },
    [`${root}/folder_paths.py`]: { type: 'file', size: 8192 },
    [`${root}/comfy/cli_args.py`]: { type: 'file', size: 2048 },
  }
}

function mergeTrees(...trees) {
  return Object.assign({}, ...trees)
}

function yamlFile(path, text) {
  return { [path]: { type: 'file', size: text.length, text } }
}

test('Windows Portable 安装被自动发现，模型根由安装根推导且与安装根分开', async () => {
  const root = 'C:\\ComfyUI_windows_portable\\ComfyUI'
  const fs = createMemoryFs({ tree: installTree(root) })
  const result = await discoverComfyUI({ fsAdapter: fs, platform: 'win32', env: WIN_ENV, YAML })

  assert.equal(result.candidates.length, 1)
  const found = result.candidates[0]
  assert.equal(found.discovery_source, DISCOVERY_SOURCES.PORTABLE)
  assert.equal(found.installation_root, root)
  assert.equal(found.status, DISCOVERY_STATUS.FOUND)
  assert.equal(found.confidence, CONFIDENCE.HIGH)
  // models_root 是 installation_root 的子目录，但字段本身独立。
  assert.equal(found.models_root, `${root}\\models`)
  assert.equal(result.status, DISCOVERY_STATUS.FOUND)
  assert.equal(result.selected?.installation_root, root)
})

test('两个本地安装候选同时存在时返回候选，不替用户选', async () => {
  const git = 'C:\\ComfyUI'
  const portable = 'D:\\ComfyUI_windows_portable\\ComfyUI'
  const fs = createMemoryFs({ tree: mergeTrees(installTree(git), installTree(portable)) })
  const result = await discoverComfyUI({ fsAdapter: fs, platform: 'win32', env: WIN_ENV, YAML })

  assert.equal(result.candidates.length, 2)
  assert.equal(result.status, DISCOVERY_STATUS.AMBIGUOUS)
  assert.equal(result.selected, null)
  const roots = result.candidates.map((item) => item.installation_root).sort()
  assert.deepEqual(roots, [git, portable].sort())
  const sources = result.candidates.map((item) => item.discovery_source).sort()
  assert.deepEqual(sources, [DISCOVERY_SOURCES.GIT, DISCOVERY_SOURCES.PORTABLE].sort())
})

test('Git 安装被识别，且不会把只有同名目录的地方当成 ComfyUI', async () => {
  const git = 'C:\\ComfyUI'
  const fake = 'D:\\ComfyUI'
  const fs = createMemoryFs({
    tree: mergeTrees(installTree(git), { [fake]: { type: 'directory' } }),
  })
  const result = await discoverComfyUI({ fsAdapter: fs, platform: 'win32', env: WIN_ENV, YAML })

  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].installation_root, git)
  assert.equal(result.candidates[0].discovery_source, DISCOVERY_SOURCES.GIT)
})

test('YAML 里的绝对路径把模型根指到安装目录之外，两者互不覆盖', async () => {
  const install = 'D:\\ComfyUI'
  const yamlPath = 'D:\\ComfyUI\\extra_model_paths.yaml'
  const text = String.raw`comfyui:
  base_path: D:\ComfyUI
  checkpoints: E:\ai\models\checkpoints
  loras: E:\ai\models\loras
`
  const fs = createMemoryFs({
    tree: mergeTrees(installTree(install), yamlFile(yamlPath, text)),
  })
  const result = await discoverComfyUI({
    fsAdapter: fs,
    platform: 'win32',
    env: WIN_ENV,
    YAML,
    userSettings: { installRoot: install, baseUrl: 'http://127.0.0.1:8188' },
  })

  const candidate = result.candidates[0]
  assert.equal(candidate.installation_root, install)
  const paths = candidate.model_roots.map((root) => root.path)
  assert.ok(paths.includes('E:\\ai\\models\\checkpoints'), `实际模型根：${paths.join(' | ')}`)
  assert.ok(paths.includes('E:\\ai\\models\\loras'))
  // 安装根下的 models 仍然在，只是不再唯一。
  assert.ok(paths.includes('D:\\ComfyUI\\models'))
  assert.equal(candidate.extra_model_paths_config.includes(yamlPath), true)
})

test('官方 Desktop 的 extra_models_config.yaml 不会被当成模型路径表，也不产生候选', async () => {
  const configPath = 'C:\\Users\\tester\\AppData\\Roaming\\ComfyUI\\extra_models_config.yaml'
  const bundle = 'C:\\Users\\tester\\AppData\\Local\\Programs\\@comfyorgcomfyui-electron\\resources\\ComfyUI'
  const text = String.raw`comfyui_desktop:
  base_path: F:\ComfyData
  custom_nodes: custom_nodes/
  download_model_base: models
is_default: 'true'
`
  // 配置文件与 Desktop 自带的完整源码树都放在内存 fs 里，这是最容易误判的现场。
  const fs = createMemoryFs({ tree: mergeTrees(installTree(bundle), yamlFile(configPath, text)) })
  const result = await discoverComfyUI({ fsAdapter: fs, platform: 'win32', env: WIN_ENV, YAML })

  assert.equal(result.status, DISCOVERY_STATUS.NOT_FOUND)
  assert.equal(result.candidates.length, 0)
  assert.equal(result.selected, null)
  // 这个文件根本不该被打开，更不能从中读出一个 base_path 当安装根。
  assert.equal(result.scanned_paths.includes(configPath), false)
  assert.equal(result.scanned_paths.some((item) => String(item).toLowerCase().includes('comfyorgcomfyui-electron')), false)
})

test('Desktop 应用包内的核心程序只被标注，不被当成受支持的安装方式', async () => {
  assert.equal(
    isDesktopBundlePath('C:\\Users\\tester\\AppData\\Local\\Programs\\@comfyorgcomfyui-electron\\resources\\ComfyUI', {
      platform: 'win32',
    }),
    true,
  )
  assert.equal(isDesktopBundlePath('C:\\ComfyUI', { platform: 'win32' }), false)
  assert.equal(isDesktopBundlePath('/Applications/ComfyUI.app/Contents/Resources/ComfyUI', { platform: 'darwin' }), true)
  assert.equal(isDesktopBundlePath('/opt/ComfyUI', { platform: 'linux' }), false)

  // 进程真的在跑 main.py 就照样认，但必须打上 desktop_bundle 标记并给出说明。
  const bundle = 'C:\\Users\\tester\\AppData\\Local\\Programs\\@comfyorgcomfyui-electron\\resources\\ComfyUI'
  const fs = createMemoryFs({ tree: installTree(bundle) })
  const result = await discoverComfyUI({
    fsAdapter: fs,
    platform: 'win32',
    env: WIN_ENV,
    YAML,
    processResult: {
      available: true,
      candidates: [{ pid: 4321, command_line: `python "${bundle}\\main.py" --port 8188`, executable_path: null }],
      diagnostics: [],
    },
  })

  assert.equal(result.candidates.length, 1)
  const candidate = result.candidates[0]
  assert.equal(candidate.discovery_source, DISCOVERY_SOURCES.PROCESS)
  assert.equal(candidate.desktop_bundle, true)
  assert.equal(
    candidate.diagnostics.some((item) => item.error_code === COMFY_CODES.CAPABILITY_UNAVAILABLE),
    true,
  )
  // 说明里要讲清楚它不算受支持的安装方式，而不是静默当成正常候选。
  assert.equal(
    candidate.diagnostics.some((item) => String(item.message).includes('Desktop')),
    true,
  )
})

test('YAML 多文件合并：默认 YAML 与用户指定 YAML 的根都保留，来源可追溯', async () => {
  const install = 'D:\\ComfyUI'
  const defaultYaml = 'D:\\ComfyUI\\extra_model_paths.yaml'
  const userYaml = 'E:\\conf\\extra_paths.yaml'
  const defaultText = String.raw`comfyui:
  base_path: D:\ComfyUI
  checkpoints: models\checkpoints
`
  const userText = String.raw`extra:
  base_path: E:\shared
  loras: loras
`
  const fs = createMemoryFs({
    tree: mergeTrees(installTree(install), yamlFile(defaultYaml, defaultText), yamlFile(userYaml, userText)),
  })
  const result = await discoverComfyUI({
    fsAdapter: fs,
    platform: 'win32',
    env: WIN_ENV,
    YAML,
    userSettings: { installRoot: install, extraModelPathsConfigFiles: [userYaml] },
  })

  const candidate = result.candidates[0]
  const paths = candidate.model_roots.map((root) => root.path)
  assert.ok(paths.includes('D:\\ComfyUI\\models\\checkpoints'), paths.join(' | '))
  assert.ok(paths.includes('E:\\shared\\loras'), paths.join(' | '))
  assert.deepEqual([...candidate.extra_model_paths_config].sort(), [defaultYaml, userYaml].sort())
  const userRoot = candidate.model_roots.find((root) => root.path === 'E:\\shared\\loras')
  assert.equal(userRoot.yaml_file, userYaml)
})

test('启动参数 --models-directory 指定非默认模型根时优先于安装根下的 models', async () => {
  const install = 'C:\\ComfyUI'
  const commandLine =
    '"C:\\Python311\\python.exe" "C:\\ComfyUI\\main.py" --models-directory E:\\ai\\models --port 8190'
  const fs = createMemoryFs({ tree: installTree(install) })
  const result = await discoverComfyUI({
    fsAdapter: fs,
    platform: 'win32',
    env: WIN_ENV,
    YAML,
    processResult: {
      available: true,
      candidates: [{ pid: 4242, name: 'python.exe', command_line: commandLine, executable_path: 'C:\\Python311\\python.exe' }],
      diagnostics: [],
    },
  })

  const candidate = result.candidates[0]
  assert.equal(candidate.discovery_source, DISCOVERY_SOURCES.PROCESS)
  assert.equal(candidate.pid, 4242)
  assert.equal(candidate.installation_root, install)
  assert.equal(candidate.models_root, 'E:\\ai\\models')
  // 自定义端口要如实反映到 runtime_base_url。
  assert.equal(candidate.runtime_base_url, 'http://127.0.0.1:8190')
})

test('启动参数解析按 argparse 语义处理 nargs+ 与 append', () => {
  const parsed = parseComfyArgv(
    String.raw`python.exe C:\ComfyUI\main.py --extra-model-paths-config a.yaml b.yaml --extra-model-paths-config c.yaml --listen 0.0.0.0 --port 8189`,
    { windows: true },
  )
  assert.equal(parsed.install_root, 'C:\\ComfyUI')
  assert.deepEqual(parsed.extra_model_paths_config, ['a.yaml', 'b.yaml', 'c.yaml'])
  assert.equal(parsed.listen, '0.0.0.0')
  assert.equal(parsed.port, 8189)

  const inline = parseComfyArgv('python main.py --port=9000 --models-directory=/data/models', { windows: false })
  assert.equal(inline.port, 9000)
  assert.equal(inline.models_directory, '/data/models')
})

test('多个运行实例同时存在时返回候选，不随便挑一个', async () => {
  const a = 'C:\\ComfyUI'
  const b = 'D:\\ComfyUI'
  const fs = createMemoryFs({ tree: mergeTrees(installTree(a), installTree(b)) })
  const result = await discoverComfyUI({
    fsAdapter: fs,
    platform: 'win32',
    env: WIN_ENV,
    YAML,
    processResult: {
      available: true,
      candidates: [
        { pid: 11, command_line: `python "${a}\\main.py" --port 8188`, executable_path: null },
        { pid: 22, command_line: `python "${b}\\main.py" --port 8190`, executable_path: null },
      ],
      diagnostics: [],
    },
  })

  assert.equal(result.candidates.length, 2)
  assert.equal(result.status, DISCOVERY_STATUS.AMBIGUOUS)
  assert.equal(result.selected, null)
  assert.deepEqual(
    result.candidates.map((item) => item.runtime_base_url).sort(),
    ['http://127.0.0.1:8188', 'http://127.0.0.1:8190'],
  )
})

test('同一个安装下可以有多个模型根，分类原始名与规范名都保留', async () => {
  const install = 'D:\\ComfyUI'
  const yamlPath = 'D:\\ComfyUI\\extra_model_paths.yaml'
  const text = String.raw`comfyui:
  base_path: D:\ComfyUI
  checkpoints: |
    models\checkpoints
    E:\ai\ckpt
  clip: models\text_encoders
  mystery_category: E:\ai\mystery
`
  const fs = createMemoryFs({ tree: mergeTrees(installTree(install), yamlFile(yamlPath, text)) })
  const result = await discoverComfyUI({
    fsAdapter: fs,
    platform: 'win32',
    env: WIN_ENV,
    YAML,
    userSettings: { installRoot: install },
  })

  const roots = result.candidates[0].model_roots
  const byPath = new Map(roots.map((root) => [root.path, root]))
  assert.ok(byPath.has('D:\\ComfyUI\\models\\checkpoints'))
  assert.ok(byPath.has('E:\\ai\\ckpt'))
  assert.equal(byPath.get('E:\\ai\\ckpt').category, 'checkpoints')
  // clip 是别名，原始名与规范名都要留下。
  const clipRoot = roots.find((root) => root.category_raw === 'clip')
  assert.equal(clipRoot.category, 'text_encoders')
  const unknown = roots.find((root) => root.category_raw === 'mystery_category')
  assert.equal(unknown.category, 'mystery_category')
})

test('什么都没找到时返回 not_found 与可执行的手动兜底建议', async () => {
  const fs = createMemoryFs({ tree: {} })
  const result = await discoverComfyUI({ fsAdapter: fs, platform: 'win32', env: WIN_ENV, YAML })

  assert.equal(result.candidates.length, 0)
  assert.equal(result.status, DISCOVERY_STATUS.NOT_FOUND)
  assert.equal(result.selected, null)
  assert.equal(result.scanned_paths.length > 0, true)
})

test('装好了但没运行时标 not_running，不把连接失败当成"没安装"', async () => {
  const root = 'C:\\ComfyUI'
  const fs = createMemoryFs({ tree: installTree(root) })
  const result = await discoverComfyUI({
    fsAdapter: fs,
    platform: 'win32',
    env: WIN_ENV,
    YAML,
    processResult: {
      available: true,
      candidates: [{ pid: 7, command_line: `python "${root}\\main.py" --port 8188`, executable_path: null }],
      diagnostics: [],
    },
    probeRuntime: async () => ({ ok: false, error: { error_code: COMFY_CODES.CONNECTION_FAILED, message: '连接被拒绝' } }),
  })

  const candidate = result.candidates[0]
  assert.equal(candidate.installation_root, root)
  assert.equal(candidate.runtime_reachable, false)
  assert.equal(candidate.status, DISCOVERY_STATUS.NOT_RUNNING)
  assert.equal(result.status, DISCOVERY_STATUS.NOT_RUNNING)
})

test('能连上 API 但确认不了物理模型路径时，如实标 partial 不编路径', async () => {
  const ghost = 'G:\\ghost\\ComfyUI'
  const fs = createMemoryFs({ tree: {} })
  const result = await discoverComfyUI({
    fsAdapter: fs,
    platform: 'win32',
    env: WIN_ENV,
    YAML,
    processResult: {
      available: true,
      candidates: [{ pid: 9, command_line: `python "${ghost}\\main.py" --port 8188`, executable_path: null }],
      diagnostics: [],
    },
    probeRuntime: async () => ({ ok: true }),
  })

  const candidate = result.candidates[0]
  assert.equal(candidate.verified, false)
  assert.equal(candidate.status, DISCOVERY_STATUS.PARTIAL)
  assert.equal(candidate.runtime_base_url, 'http://127.0.0.1:8188')
  // 猜出来的 models 根不能当成"已确认"。
  assert.equal(candidate.confidence, CONFIDENCE.MEDIUM)
})

test('用户显式配置的安装根排在自动发现之前，且不会被自动发现覆盖', async () => {
  const mine = 'X:\\MyComfy'
  const auto = 'C:\\ComfyUI'
  const fs = createMemoryFs({ tree: mergeTrees(installTree(mine), installTree(auto)) })
  const result = await discoverComfyUI({
    fsAdapter: fs,
    platform: 'win32',
    env: WIN_ENV,
    YAML,
    userSettings: { installRoot: mine, baseUrl: 'http://127.0.0.1:9999' },
  })

  assert.equal(result.candidates[0].installation_root, mine)
  assert.equal(result.candidates[0].discovery_source, DISCOVERY_SOURCES.USER_CONFIG)
  assert.equal(result.candidates[0].runtime_base_url, 'http://127.0.0.1:9999')
  assert.equal(result.candidates.length, 2)
})

test('权限拒绝如实进诊断，不换成别的接口重试', async () => {
  const root = 'X:\\Locked'
  const fs = createMemoryFs({ tree: installTree(root), deny: [root] })
  const result = await discoverComfyUI({
    fsAdapter: fs,
    platform: 'win32',
    env: WIN_ENV,
    YAML,
    userSettings: { installRoot: root },
  })

  const denied = result.diagnostics.filter((item) => item.error_code === COMFY_CODES.PATH_DENIED)
  assert.equal(denied.length >= 1, true, JSON.stringify(result.diagnostics))
  // 被拒之后不能再产出"已确认"的候选。
  assert.equal(result.candidates[0].verified, false)
})

test('自动发现只在有限候选里找，不会退化成全盘扫描', async () => {
  const fs = createMemoryFs({ tree: {} })
  const result = await discoverComfyUI({ fsAdapter: fs, platform: 'win32', env: WIN_ENV, YAML })
  const known = knownInstallCandidates({ platform: 'win32', env: WIN_ENV })
  assert.equal(known.length <= MAX_CANDIDATES, true)

  // 扫描过的路径必须都在候选清单的推导范围内，且数量有界。
  assert.equal(result.scanned_paths.length <= 200, true, `扫描了 ${result.scanned_paths.length} 条路径`)
  for (const scanned of result.scanned_paths) {
    assert.equal(/^[A-Za-z]:\\?$/.test(scanned), false, `不该直接扫盘符根：${scanned}`)
    const insideKnown = known.some((item) => {
      const base = item.path.replace(/\\/g, '/')
      const target = String(scanned).replace(/\\/g, '/')
      return target === base || target.startsWith(`${base}/`)
    })
    assert.equal(insideKnown, true, `扫到了候选之外的位置：${scanned}`)
  }
})

test('显式 enabled=false 时七个工具根本不注册，discover 也不会跑', async () => {
  const runtime = createRuntime({ ctx: {}, config: { comfyui: { enabled: false } }, logger: SILENT_LOGGER })
  const { registered, disposeCalls } = await registerIntoRecorder(runtime)
  const names = registered.map((item) => item.name)
  assert.equal(names.some((name) => name.startsWith('comfyui_')), false, names.join(','))
  for (const dispose of disposeCalls) dispose()

  const comfy = await runtime.getComfyUI()
  await assert.rejects(
    () => comfy.discover(),
    (error) => error.code === COMFY_CODES.CAPABILITY_UNAVAILABLE,
  )
  assert.equal(comfy.describe().initialize_count, 0)
})

test('代理可能把 loopback 请求带出本机时，自动探测直接放弃而不是硬连', async () => {
  const root = 'C:\\ComfyUI'
  const fs = createMemoryFs({ tree: installTree(root) })
  let requests = 0
  const result = await discoverComfyUI({
    fsAdapter: fs,
    platform: 'win32',
    env: { ...WIN_ENV, http_proxy: 'http://127.0.0.1:7897', no_proxy: '' },
    YAML,
    processResult: {
      available: true,
      candidates: [{ pid: 3, command_line: `python "${root}\\main.py" --port 8188`, executable_path: null }],
      diagnostics: [],
    },
    probeRuntime: async ({ baseUrl }) => {
      const client = createComfyClient({
        baseUrl,
        fetchImpl: async () => {
          requests += 1
          return new Response('{}', { status: 200 })
        },
        env: { http_proxy: 'http://127.0.0.1:7897', no_proxy: '' },
      })
      await client.getSystemStats()
      return { ok: true }
    },
  })

  assert.equal(requests, 0, '代理风险下不该发出任何请求')
  assert.equal(result.candidates[0].runtime_reachable, false)
  assert.equal(result.candidates[0].status, DISCOVERY_STATUS.NOT_RUNNING)
})

test('七个工具在任何状态下都不把 undefined 拼进错误信息', async () => {
  const comfy = createComfyRuntime({
    ctx: {},
    pluginConfig: { comfyui: { enabled: false } },
    logger: SILENT_LOGGER,
  })
  const fakeRuntime = { getComfyUI: async () => comfy, logger: SILENT_LOGGER }
  for (const spec of createComfyToolSpecs(fakeRuntime)) {
    const envelopeResult = await spec.execute({}, {})
    const text = JSON.stringify(envelopeResult)
    assert.equal(text.includes('undefined'), false, `${spec.name} 的输出里出现了 undefined：${text}`)
    if (spec.name !== 'comfyui_status') {
      assert.equal(envelopeResult.status, 'failed')
      assert.equal(envelopeResult.diagnostics[0].error_code, COMFY_CODES.CAPABILITY_UNAVAILABLE)
    }
  }
})

test('默认配置下 ComfyUI 工具会注册，且状态工具能回答"未发现"', async () => {
  const runtime = createRuntime({ ctx: {}, config: {}, logger: SILENT_LOGGER })
  const { registered, disposeCalls } = await registerIntoRecorder(runtime)
  const comfyTools = registered.filter((item) => item.name.startsWith('comfyui_')).map((item) => item.name)
  assert.equal(comfyTools.length, 7)
  for (const dispose of disposeCalls) dispose()

  const comfy = await runtime.getComfyUI()
  const described = comfy.describe()
  assert.equal(described.enabled, true)
  assert.equal(described.auto_detect, true)
  assert.equal(described.discovery, null)
  // 还没发现过，就不该报任何候选。
  assert.equal(described.effective_base_url, DEFAULT_COMFY_BASE_URL)
})

// ───── 盘符级探测：整合启动器把 ComfyUI 埋在任意盘的深层目录里 ─────

test('整合启动器那种四层嵌套的安装根能被盘符探测找到', async () => {
  const bundle = 'D:\\ComfyUI\\ComfyUI_windows_portable'
  const install = `${bundle}\\ComfyUI`
  const fs = createMemoryFs({
    tree: mergeTrees(
      {
        'D:\\': { type: 'directory' },
        'D:\\ComfyUI': { type: 'directory' },
        'D:\\ComfyUI\\ComfyUI_windows_portable': { type: 'directory' },
        [bundle]: { type: 'directory' },
        [`${bundle}\\绘世启动器.exe`]: { type: 'file', size: 1024 },
      },
      installTree(install),
    ),
  })

  const result = await discoverComfyUI({
    fsAdapter: fs,
    platform: 'win32',
    env: WIN_ENV,
    YAML,
    driveRoots: ['D:\\'],
  })

  assert.equal(result.candidates.length, 1, JSON.stringify(result.candidates.map((c) => c.installation_root)))
  const found = result.candidates[0]
  assert.equal(found.installation_root, install)
  assert.equal(found.discovery_source, DISCOVERY_SOURCES.KNOWN_LOCATION)
  assert.equal(found.confidence, CONFIDENCE.HIGH)
  assert.equal(found.models_root, `${install}\\models`)
  assert.deepEqual(result.drive_roots, ['D:\\'])
})

test('盘符探测只进名字带 comfy 的目录，模型目录里的同名目录不会被误认', async () => {
  const decoy = 'D:\\ComfyUI\\ComfyUI_windows_portable\\models\\fake\\main.py'
  const fs = createMemoryFs({
    tree: mergeTrees(
      {
        'D:\\ComfyUI': { type: 'directory' },
        'D:\\ComfyUI\\ComfyUI_windows_portable': { type: 'directory' },
        'D:\\ComfyUI\\ComfyUI_windows_portable\\models': { type: 'directory' },
        'D:\\ComfyUI\\ComfyUI_windows_portable\\models\\fake': { type: 'directory' },
        [decoy]: { type: 'file', size: 10 },
        'D:\\ComfyUI\\ComfyUI_windows_portable\\models\\fake\\folder_paths.py': { type: 'file', size: 10 },
      },
    ),
  })

  const result = await probeComfyDirectories(fs, { seeds: ['D:\\ComfyUI'], platform: 'win32' })

  // 模型目录被整段跳过，连列都没列，里面的假安装根不会被认成 ComfyUI。
  assert.equal(result.found.length, 0)
  assert.equal(
    result.scanned_paths.some((path) => path.includes('\\models')),
    false,
    `不该扫进 models：${result.scanned_paths.join(' | ')}`,
  )
})

test('盘符探测达到目录上限就停下并如实标记 SCAN_PARTIAL', async () => {
  const wide = {}
  const seedA = 'D:\\ComfyUI\\a'
  const seedB = 'D:\\ComfyUI\\b'
  wide['D:\\ComfyUI'] = { type: 'directory' }
  wide[seedA] = { type: 'directory' }
  wide[seedB] = { type: 'directory' }
  for (const seed of [seedA, seedB]) {
    for (let index = 0; index < 130; index += 1) {
      wide[`${seed}\\ComfyUI-${index}`] = { type: 'directory' }
    }
  }
  const fs = createMemoryFs({ tree: wide })

  const result = await probeComfyDirectories(fs, { seeds: [seedA, seedB], platform: 'win32' })

  assert.equal(result.truncated, true)
  assert.equal(result.found.length, 0)
  assert.ok(
    result.diagnostics.some((item) => item.error_code === COMFY_CODES.SCAN_PARTIAL),
    '达到上限必须报 SCAN_PARTIAL，不能静默截断',
  )
  assert.ok(result.visited_dirs <= DRIVE_PROBE_LIMITS.maxTotalDirs)
})

test('没有 subprocess 服务时盘符枚举如实不可用，不退回 node:child_process', async () => {
  const result = await collectDriveRoots({ subprocess: null, platform: 'win32' })
  assert.equal(result.available, false)
  assert.deepEqual(result.roots, [])
  assert.equal(result.skipped_reason, 'no_subprocess')
  assert.equal(result.diagnostics[0].error_code, COMFY_CODES.CAPABILITY_UNAVAILABLE)

  const posix = await collectDriveRoots({ subprocess: { spawn() {} }, platform: 'darwin' })
  assert.equal(posix.available, false)
  assert.equal(posix.skipped_reason, 'not_windows')
})

test('不存在的盘符不会让发现失败，也不该刷出噪声诊断', async () => {
  const git = 'C:\\ComfyUI'
  const fs = createMemoryFs({
    tree: mergeTrees(installTree(git), { 'D:\\': { type: 'directory' } }),
  })
  const result = await discoverComfyUI({
    fsAdapter: fs,
    platform: 'win32',
    env: WIN_ENV,
    YAML,
    driveRoots: ['D:\\', 'Z:\\'],
  })

  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].installation_root, git)
  // Z:\ComfyUI 不存在是常态，不该因此报错——否则每台机器都会满屏诊断。
  assert.equal(
    result.diagnostics.some((item) => item.error_code === COMFY_CODES.PATH_MISSING),
    false,
    JSON.stringify(result.diagnostics),
  )
})

// ─────────────────────────── T12-A：真实 API 形状与诊断粒度 ───────────────────────────
// 这一段的形状全部照 server.py 抄：/models 给分类名数组，/models/{folder} 给文件名数组，
// 未注册分类 404。用真实形状的 fixture 是为了防止实现再退回"把 /models 当映射"。

test('GET /models 只给分类名，文件名要逐类再查；404 分类记为 missing 而不是错误', async () => {
  const fake = createFakeFetch({
    '/models': () => ['checkpoints', 'loras', 'ghost'],
    '/models/checkpoints': () => ['a.safetensors', 'sub/b.safetensors'],
    '/models/loras': () => [],
    '/models/ghost': () => jsonResponse(404, { error: 'not found' }),
  })
  const client = createComfyClient({ fetchImpl: fake.fetchImpl })
  const index = await client.getModels()

  assert.deepEqual(index.categories, ['checkpoints', 'loras', 'ghost'])
  assert.deepEqual(index.files.checkpoints, ['a.safetensors', 'sub/b.safetensors'])
  assert.deepEqual(index.files.loras, [])
  assert.deepEqual(index.missing, ['ghost'])
  assert.deepEqual(index.failures, [])
  assert.equal(index.truncated, false)
  // 分类到文件的映射必须是对象，不能把分类名数组原样当成映射用。
  assert.equal(Array.isArray(index.files), false)
})

test('/models 不是字符串数组时判为响应异常，不把空索引当成"没有模型"', async () => {
  const mapping = createFakeFetch({ '/models': () => ({ checkpoints: ['a.safetensors'] }) })
  await assert.rejects(() => createComfyClient({ fetchImpl: mapping.fetchImpl }).getModels(), (error) => {
    assert.equal(error.code, COMFY_CODES.BAD_RESPONSE)
    assert.match(error.message, /字符串数组/)
    return true
  })

  // 单个分类取不到不该拖垮整份索引，但要留痕。
  const broken = createFakeFetch({
    '/models': () => ['checkpoints', 'loras'],
    '/models/checkpoints': () => jsonResponse(500, 'boom'),
    '/models/loras': () => ['x.safetensors'],
  })
  const index = await createComfyClient({ fetchImpl: broken.fetchImpl }).getModels()
  assert.deepEqual(index.files.loras, ['x.safetensors'])
  assert.equal(index.failures.length, 1)
  assert.equal(index.failures[0].category, 'checkpoints')
  assert.equal(index.failures[0].code, COMFY_CODES.BAD_RESPONSE)
})

test('分类名不能让请求跳出 /models/ 前缀', async () => {
  const fake = createFakeFetch({ '*': () => [] })
  const client = createComfyClient({ fetchImpl: fake.fetchImpl })

  for (const bad of ['..', '.']) {
    await assert.rejects(() => client.getModelFiles(bad), (error) => {
      assert.equal(error.code, COMFY_CODES.BAD_RESPONSE)
      return true
    })
  }
  assert.equal(fake.calls.length, 0, '被拒的分类名不该发出任何请求')

  await client.getModelFiles('checkpoints')
  assert.deepEqual(fake.calls.map((call) => call.pathname), ['/models/checkpoints'])
})

test('没有代理时 loopback 守卫返回 true，而不是让调用方拿到 undefined', () => {
  assert.equal(assertLoopbackNotProxied('127.0.0.1', { env: {} }), true)
  assert.equal(
    assertLoopbackNotProxied('127.0.0.1', { env: { http_proxy: 'http://10.0.0.9:3128' }, allowProxy: true }),
    true,
  )
  assert.equal(
    assertLoopbackNotProxied('localhost', { env: { http_proxy: 'http://10.0.0.9:3128', no_proxy: 'localhost' } }),
    true,
  )
  // 点前缀只匹配子域，不匹配 host 本身。
  assert.equal(
    assertLoopbackNotProxied('a.localhost', { env: { http_proxy: 'http://10.0.0.9:3128', no_proxy: '.localhost' } }),
    true,
  )
  assert.throws(() => assertLoopbackNotProxied('127.0.0.1', { env: { http_proxy: 'http://10.0.0.9:3128' } }))
})

test('补丁整份作废时，每一处失败单独进诊断，并带上节点与字段', async () => {
  const prompt = readJson('scripts/fixtures/comfyui/api-prompt.json')
  const objectInfo = readJson('scripts/fixtures/comfyui/object_info.json')
  const fs = createMemoryFs({
    tree: { 'D:/flows/base.json': { type: 'file', text: JSON.stringify(prompt) } },
  })
  const fake = createFakeFetch({ '/object_info': () => objectInfo })
  const comfy = createComfyRuntime({
    ctx: { fs },
    pluginConfig: { comfyui: { enabled: true, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: fake.fetchImpl,
  })
  const spec = createComfyToolSpecs({ getComfyUI: async () => comfy, logger: SILENT_LOGGER }).find(
    (item) => item.name === 'comfyui_plan_workflow_patch',
  )
  const result = await spec.execute(
    {
      workflow_path: 'D:/flows/base.json',
      changes: [
        { node_id: '4', field: 'no_such_field', value: 1 },
        { node_id: '9', field: 'filename_prefix', value: 'x' },
      ],
    },
    {},
  )

  assert.equal(result.status, 'failed')
  // 一条汇总 + 两处失败，不能把两处压成一条。
  assert.equal(result.diagnostics.length, 3, JSON.stringify(result.diagnostics))
  const [first, second] = result.diagnostics.slice(1)
  assert.equal(first.node_id, '4')
  assert.equal(first.field, 'no_such_field')
  assert.equal(first.input, 1)
  assert.equal(typeof first.class_type, 'string')
  assert.equal(second.node_id, '9')
  assert.equal(second.field, 'filename_prefix')
  assert.equal(second.input, 'x')
})

test('status 回报实际连通的地址与来源，连不上时不留验证过的地址', async () => {
  let refuse = false
  const fetchImpl = async (url) => {
    const pathname = new URL(String(url)).pathname
    if (pathname !== '/system_stats') return jsonResponse(404, {})
    if (refuse) throw new Error('connect ECONNREFUSED 127.0.0.1:8188')
    return jsonResponse(200, { system: { comfyui_version: '0.33.1' }, devices: [] })
  }
  const comfy = createComfyRuntime({
    ctx: {},
    pluginConfig: { comfyui: { enabled: true, autoDetect: false, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl,
  })

  // 只写了配置、还没真的连上：来源只能是 config。
  assert.equal(comfy.describe().base_url_source, 'config')
  assert.equal(comfy.describe().verified_base_url, null)

  const status = await comfy.status()
  assert.equal(status.base_url, 'http://127.0.0.1:8188')
  assert.equal(status.base_url_source, 'verified')
  assert.equal(status.configured_base_url, 'http://127.0.0.1:8188')
  assert.equal(comfy.describe().verified_base_url, 'http://127.0.0.1:8188')
  assert.equal(comfy.describe().base_url_source, 'verified')

  // 服务停了之后，"验证过"必须失效，不能继续拿旧结论冒充在线。
  refuse = true
  await assert.rejects(() => comfy.status())
  assert.equal(comfy.describe().verified_base_url, null)
  assert.equal(comfy.describe().base_url_source, 'config')
})

test('取图前按 Host 的 imageLimits 预检：超量、超总大小、不支持的媒体类型都不落盘', async () => {
  const requested = []
  const fetchImpl = async (url) => {
    requested.push(new URL(String(url)).searchParams.get('filename'))
    return imageResponse(pngBytes(2, 2))
  }
  const saved = []
  const attachments = {
    imageLimits: {
      maxImageBytes: 40,
      maxImagesPerMessage: 2,
      maxMessageImageBytes: 40,
      maxImagePixels: 4096,
      maxImageDimension: 64,
      mediaTypes: ['image/png'],
    },
    async saveImage(input) {
      saved.push(input)
      return {
        attachmentId: `att_${saved.length}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 2,
        height: 2,
        name: input.name,
      }
    },
  }
  const comfy = createComfyRuntime({
    ctx: { get: (key) => (key === 'attachments' ? attachments : undefined) },
    pluginConfig: { comfyui: { enabled: true, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl,
  })
  const result = await comfy.collectImages({
    run: {
      images: [
        { filename: 'a.png', subfolder: '', type: 'output' },
        { filename: 'b.png', subfolder: '', type: 'output' },
        { filename: 'c.png', subfolder: '', type: 'output' },
      ],
    },
  })

  // 三张超过单条消息的张数上限：整批拒绝，一张都不下载、一张都不存。
  assert.deepEqual(requested, [])
  assert.equal(saved.length, 0)
  assert.equal(result.attachments.length, 0)
  assert.equal(result.partial_saved, false)
  assert.equal(result.diagnostics.length, 1)
  assert.equal(result.diagnostics[0].error_code, COMFY_CODES.OUTPUT_UNAVAILABLE)
  assert.match(result.diagnostics[0].message, /超过 Host 单条消息上限 2 张/)

  // 张数放行但总量超限：第一段会取回两张，第二段一张都不存。
  const tight = {
    imageLimits: {
      maxImageBytes: 40,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 40,
      maxImagePixels: 4096,
      maxImageDimension: 64,
      mediaTypes: ['image/png'],
    },
    async saveImage() {
      throw new Error('不该被调用')
    },
  }
  const tightRun = createComfyRuntime({
    ctx: { get: (key) => (key === 'attachments' ? tight : undefined) },
    pluginConfig: { comfyui: { enabled: true, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl,
  })
  requested.length = 0
  const overTotal = await tightRun.collectImages({
    run: {
      images: [
        { filename: 'a.png', subfolder: '', type: 'output' },
        { filename: 'b.png', subfolder: '', type: 'output' },
      ],
    },
  })
  assert.deepEqual(requested, ['a.png', 'b.png'])
  assert.equal(overTotal.attachments.length, 0)
  assert.equal(overTotal.partial_saved, false)
  assert.equal(overTotal.diagnostics.length, 1)
  assert.match(overTotal.diagnostics[0].message, /总大小超过 Host 上限/)

  // 媒体类型不在允许列表时同样拒绝落盘。
  const jpegOnly = {
    imageLimits: { maxImageBytes: 4096, maxImagesPerMessage: 4, maxMessageImageBytes: 1024, maxImagePixels: 4096, maxImageDimension: 64, mediaTypes: ['image/jpeg'] },
    async saveImage() {
      throw new Error('不该被调用')
    },
  }
  const second = createComfyRuntime({
    ctx: { get: (key) => (key === 'attachments' ? jpegOnly : undefined) },
    pluginConfig: { comfyui: { enabled: true, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl,
  })
  const rejected = await second.collectImages({
    run: { images: [{ filename: 'd.png', subfolder: '', type: 'output' }] },
  })
  assert.equal(rejected.attachments.length, 0)
  assert.equal(rejected.diagnostics.length, 1)
  assert.match(rejected.diagnostics[0].message, /image\/png/)
})

test('盘符枚举只要本地固定磁盘：命令里限定 DriveType，UNC 路径一律不进候选', async () => {
  const spawned = []
  const subprocess = {
    spawn(input) {
      spawned.push(input)
      return {
        done: Promise.resolve({ code: 0 }),
        collected: { stdout: { readFrom: () => ({ text: 'C:\r\nD:\r\n\\\\nas\\share\r\n' }) } },
      }
    },
  }
  const result = await collectDriveRoots({ subprocess, platform: 'win32' })

  assert.equal(result.available, true)
  assert.deepEqual(result.roots, ['C:\\', 'D:\\'])
  assert.equal(result.skipped_reason, null)

  const command = spawned[0].argv.join(' ')
  // Get-PSDrive 会把网络映射盘一起列出来；这里必须用 DriveType=3 只取本地固定盘。
  assert.match(command, /DriveType=3/)
  assert.equal(command.includes('Get-PSDrive'), false)
})

test('盘符预算按盘均分：第一块盘再大，也不会让后面的盘一个目录都扫不到', async () => {
  const seedA = 'D:\\ComfyUI\\a'
  const seedB = 'D:\\ComfyUI\\b'
  const install = `${seedB}\\ComfyUI`
  const tree = {
    'D:\\ComfyUI': { type: 'directory' },
    [seedA]: { type: 'directory' },
    [seedB]: { type: 'directory' },
  }
  for (let index = 0; index < 400; index += 1) {
    tree[`${seedA}\\ComfyUI-${index}`] = { type: 'directory' }
  }
  Object.assign(tree, installTree(install))
  const fs = createMemoryFs({ tree })

  const result = await probeComfyDirectories(fs, { seeds: [seedA, seedB], platform: 'win32' })

  // 预算全局共享时，seedA 的 400 个目录会把上限吃光，seedB 的安装永远看不到。
  assert.deepEqual(result.found.map((item) => item.path), [install])
  assert.ok(
    result.diagnostics.some((item) => item.error_code === COMFY_CODES.SCAN_PARTIAL),
    '均分预算导致的截断也要如实报告，不能装作扫完了',
  )
  assert.ok(result.visited_dirs <= DRIVE_PROBE_LIMITS.maxTotalDirs)
})

test('枚举字段两种 /object_info 形状都能读出选项，V3 COMBO 不再被判成无法校验', () => {
  // 旧版：选项直接是第一项。
  assert.deepEqual(enumOptionsOf([['a.safetensors', 'b.safetensors'], {}]), ['a.safetensors', 'b.safetensors'])
  // V3：第一项是类型名 COMBO，选项挪到第二项的 options 里。
  assert.deepEqual(enumOptionsOf(['COMBO', { multiselect: false, options: ['x.pth', 'y.pth'] }]), ['x.pth', 'y.pth'])
  // 不是枚举字段的，一律返回 null，让调用方按类型继续校验。
  assert.equal(enumOptionsOf(['INT', { min: 1, max: 10 }]), null)
  assert.equal(enumOptionsOf(['STRING', {}]), null)
  assert.equal(enumOptionsOf(null), null)

  const objectInfo = {
    UpscaleModelLoader: {
      input: { required: { model_name: ['COMBO', { multiselect: false, options: ['4x-AnimeSharp.pth'] }] } },
    },
  }

  // V3 形状下合法值要放行——按旧实现这里会抛"类型 COMBO 首版不支持写入"。
  assert.equal(
    validateFieldValue({ classType: 'UpscaleModelLoader', field: 'model_name', value: '4x-AnimeSharp.pth', objectInfo }),
    '4x-AnimeSharp.pth',
  )

  // 不在选项里仍然要拒，且把可选值提示出来。
  assert.throws(
    () =>
      validateFieldValue({
        classType: 'UpscaleModelLoader',
        field: 'model_name',
        value: 'nope.pth',
        objectInfo,
      }),
    (error) => {
      assert.equal(error.code, COMFY_CODES.VALIDATION_FAILED)
      assert.match(error.suggested_fix ?? '', /4x-AnimeSharp\.pth/)
      return true
    },
  )

  // 四态对账里同一处形状差异的后果：upscale_models 的 loader 可选择态
  // 会一直停在 unknown，明明运行时能选也被标成不知道。
  const reconciled = reconcileModels({
    entries: [
      { category: 'upscale_models', relative_path: 'upscale_models/4x-AnimeSharp.pth' },
      { category: 'upscale_models', relative_path: 'upscale_models/missing.pth' },
    ],
    models: { upscale_models: ['4x-AnimeSharp.pth', 'missing.pth'] },
    loaderEnums: { UpscaleModelLoader: objectInfo.UpscaleModelLoader },
    runtimeAvailable: true,
  })
  assert.equal(reconciled.entries[0].states.loader_selectable, 'true')
  assert.equal(reconciled.entries[1].states.loader_selectable, 'false')
})

test('运行时分类里的非模型文件不进 virtual_entries，跳过的数量如实报出', async () => {
  const install = 'C:\\ComfyUI'
  const fs = createMemoryFs({
    tree: mergeTrees(installTree(install), {
      [`${install}\\models`]: { type: 'directory' },
      [`${install}\\models\\checkpoints`]: { type: 'directory' },
      [`${install}\\models\\checkpoints\\a.safetensors`]: { type: 'file', size: 100 },
    }),
  })
  const fake = createFakeFetch({
    '/models': () => ['checkpoints', 'custom_nodes'],
    '/models/checkpoints': () => ['a.safetensors'],
    // 真实实例上 custom_nodes 是目录型分类，运行时把 .py / .pyc 也当条目列出来。
    '/models/custom_nodes': () => ['nodes.py', 'nodes.pyc', 'intrinsic.safetensors'],
    '/object_info/CheckpointLoaderSimple': () => ({
      CheckpointLoaderSimple: { input: { required: { ckpt_name: [['a.safetensors'], {}] } } },
    }),
  })
  const comfy = createComfyRuntime({
    ctx: { fs },
    pluginConfig: {
      comfyui: { enabled: true, autoDetect: false, installRoot: install, baseUrl: 'http://127.0.0.1:8188' },
    },
    logger: SILENT_LOGGER,
    fetchImpl: fake.fetchImpl,
  })
  const spec = createComfyToolSpecs({ getComfyUI: async () => comfy, logger: SILENT_LOGGER }).find(
    (item) => item.name === 'comfyui_list_models',
  )
  const result = await spec.execute({ limit: 5 }, {})

  assert.equal(result.runtime_available, true, JSON.stringify(result.diagnostics))
  assert.equal(result.entries[0].states.loader_selectable, 'true')

  const virtualNames = result.virtual_entries.map((item) => item.name)
  assert.deepEqual(virtualNames, ['intrinsic.safetensors'])
  // 被筛掉的数量要报出来，否则"运行时少了几百个条目"看起来像扫描漏了。
  assert.equal(result.virtual_total, 1)
  assert.equal(result.virtual_skipped, 2)
  assert.equal(result.virtual_truncated, false)

  // 指定分类时运行时独有条目也只看这个分类，否则查 checkpoints 会带出别的分类的一堆行。
  const scoped = await spec.execute({ category: 'checkpoints', limit: 5 }, {})
  assert.equal(scoped.entries.length, 1)
  assert.deepEqual(scoped.virtual_entries, [])
})

test('和权重放在一起的 .metadata.json 不算模型条目，跳过数量如实报出', async () => {
  const install = 'C:\\ComfyUI'
  const fs = createMemoryFs({
    tree: mergeTrees(installTree(install), {
      [`${install}\\models`]: { type: 'directory' },
      [`${install}\\models\\checkpoints`]: { type: 'directory' },
      [`${install}\\models\\checkpoints\\a.safetensors`]: { type: 'file', size: 100 },
      // 真实实例上 aki 整合包会在权重旁边放一份同名 .metadata.json，
      // ComfyUI 自己只列已知扩展名，磁盘扫描如果照单全收就会多出一行"不可见的模型"。
      [`${install}\\models\\checkpoints\\a.metadata.json`]: { type: 'file', size: 10 },
      [`${install}\\models\\checkpoints\\preview.png`]: { type: 'file', size: 10 },
    }),
  })
  const fake = createFakeFetch({
    '/models': () => ['checkpoints'],
    '/models/checkpoints': () => ['a.safetensors'],
    '/object_info/CheckpointLoaderSimple': () => ({
      CheckpointLoaderSimple: { input: { required: { ckpt_name: [['a.safetensors'], {}] } } },
    }),
  })
  const comfy = createComfyRuntime({
    ctx: { fs },
    pluginConfig: {
      comfyui: { enabled: true, autoDetect: false, installRoot: install, baseUrl: 'http://127.0.0.1:8188' },
    },
    logger: SILENT_LOGGER,
    fetchImpl: fake.fetchImpl,
  })
  const spec = createComfyToolSpecs({ getComfyUI: async () => comfy, logger: SILENT_LOGGER }).find(
    (item) => item.name === 'comfyui_list_models',
  )
  const result = await spec.execute({ category: 'checkpoints', limit: 5 }, {})

  assert.deepEqual(
    result.entries.map((item) => item.name),
    ['a.safetensors'],
  )
  assert.equal(result.total, 1)
  assert.equal(result.non_model_skipped, 2)
  assert.equal(result.entries[0].states.loader_selectable, 'true')
  await comfy.dispose()
})

// ───────────────────────── V1.1-FUNCTIONAL-CLOSE：执行成功记录与取图预检 ─────────────────────────
// 这一段区分三件事：提交了什么（workflow）、执行结果是什么（state）、
// 哪一次真的跑通并留下了可取的图（execution_success）。三者不能互相推导。

const CLOSE_PROMPT = {
  '3': {
    class_type: 'KSampler',
    inputs: { seed: 1234567890, steps: 24, cfg: 6, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['4', 0] },
  },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'waiIllustriousSDXL_v140.safetensors' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 1024, batch_size: 1 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a girl' } },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0] } },
  '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'close' } },
}

function closeHistory(
  promptId,
  {
    completed = true,
    images = [{ filename: 'close_0001.png', subfolder: '', type: 'output' }],
    messages = [],
    statusStr = completed ? 'success' : 'error',
    prompt = CLOSE_PROMPT,
    outputs = undefined,
  } = {},
) {
  return {
    [promptId]: {
      prompt: [0, promptId, prompt, {}, []],
      status: { completed, status_str: statusStr, messages },
      outputs: outputs ?? { '9': { images } },
    },
  }
}

test('执行成功记录带版本、工作流指纹、实际 loader 与采样参数，且不改原始 prompt', async () => {
  const promptId = '9f9f9f9f-1111-4222-8333-444444444444'
  const fake = createFakeFetch({
    [`/history/${promptId}`]: () => closeHistory(promptId),
    '/system_stats': () => ({ system: { comfyui_version: '0.33.1' }, devices: [] }),
    '/queue': () => ({ queue_running: [], queue_pending: [] }),
  })
  const before = JSON.stringify(CLOSE_PROMPT)
  // 提交时那份摘要与历史里的 prompt 故意不同：本进程记得的那份才是实际发出去的。
  const submitted = describeExecution({
    ...CLOSE_PROMPT,
    '3': { class_type: 'KSampler', inputs: { ...CLOSE_PROMPT['3'].inputs, steps: 12 } },
  })
  const run = await queryRun({
    client: createComfyClient({ fetchImpl: fake.fetchImpl }),
    run: { run_id: 'r-ok', prompt_id: promptId, state: 'accepted', workflow: submitted },
  })

  assert.equal(run.state, 'completed')
  const record = run.execution_success
  assert.equal(record.execution_status, 'success')
  assert.equal(record.run_id, 'r-ok')
  assert.equal(record.prompt_id, promptId)
  assert.equal(record.comfyui_version, '0.33.1')
  // 本进程提交过就用自己的摘要，不会被 history 里的 prompt 顶掉。
  assert.equal(record.workflow_id, submitted.workflow_id)
  assert.equal(record.checkpoint_selectors[0].selector, 'waiIllustriousSDXL_v140.safetensors')
  assert.equal(record.checkpoint_selectors[0].node_id, '4')
  assert.equal(record.samplers[0].seed, 1234567890)
  assert.equal(record.samplers[0].steps, 12)
  assert.equal(record.samplers[0].cfg, 6)
  assert.equal(record.samplers[0].sampler_name, 'euler')
  assert.equal(record.latents[0].width, 768)
  assert.equal(record.latents[0].height, 1024)
  assert.equal(record.images.length, 1)
  assert.equal(record.images[0].filename, 'close_0001.png')
  assert.equal(typeof record.finished_at, 'string')
  // 只读：原始 prompt 一个字节都不能变。
  assert.equal(JSON.stringify(CLOSE_PROMPT), before)
})

test('只有 prompt_id 的历史任务也能还原工作流指纹与实际使用的模型', async () => {
  const promptId = 'a1a1a1a1-2222-4333-8444-555555555555'
  const fake = createFakeFetch({
    [`/history/${promptId}`]: () => closeHistory(promptId),
    '/system_stats': () => ({ system: { comfyui_version: '0.33.1' } }),
    '/queue': () => ({ queue_running: [], queue_pending: [] }),
  })
  const run = await queryRun({
    client: createComfyClient({ fetchImpl: fake.fetchImpl }),
    run: { run_id: promptId, prompt_id: promptId, state: 'accepted' },
  })
  assert.equal(run.execution_success.workflow_id, stableFingerprint(CLOSE_PROMPT))
  assert.equal(run.execution_success.workflow_hash, stableFingerprint(CLOSE_PROMPT))
  assert.equal(run.execution_success.workflow_nodes, 6)
})

test('排队、执行中、失败、历史延迟都不得写出执行成功记录', async () => {
  const promptId = 'b2b2b2b2-3333-4444-8555-666666666666'
  const client = (routes) => createComfyClient({ fetchImpl: createFakeFetch(routes).fetchImpl })

  const queued = await queryRun({
    client: client({
      [`/history/${promptId}`]: () => ({}),
      '/queue': () => ({ queue_running: [], queue_pending: [[2, promptId]] }),
    }),
    run: { run_id: 'r-q', prompt_id: promptId, state: 'accepted' },
  })
  assert.equal(queued.state, 'running')
  assert.equal(queued.execution_success, undefined)

  const executing = await queryRun({
    client: client({
      [`/history/${promptId}`]: () => ({ [promptId]: { status: { completed: false, status_str: 'success' }, outputs: {} } }),
      '/queue': () => ({ queue_running: [[1, promptId]], queue_pending: [] }),
    }),
    run: { run_id: 'r-e', prompt_id: promptId, state: 'accepted' },
  })
  assert.equal(executing.state, 'running')
  assert.equal(executing.execution_success, undefined)

  const failed = await queryRun({
    client: client({
      [`/history/${promptId}`]: () => ({
        [promptId]: {
          status: { completed: false, status_str: 'error', messages: [['execution_error', { exception_message: 'CUDA out of memory' }]] },
          outputs: {},
        },
      }),
    }),
    run: { run_id: 'r-f', prompt_id: promptId, state: 'accepted' },
  })
  assert.equal(failed.state, 'failed')
  assert.equal(failed.execution_success, undefined)

  // 历史还没写进来，队列里也没有：这是 unknown，不是"没成功过所以算成功"。
  const delayed = await queryRun({
    client: client({
      [`/history/${promptId}`]: () => ({}),
      '/queue': () => ({ queue_running: [], queue_pending: [] }),
    }),
    run: { run_id: 'r-u', prompt_id: promptId, state: 'accepted' },
  })
  assert.equal(delayed.state, 'unknown')
  assert.equal(delayed.execution_success, undefined)
})

test('执行完成但输出文件名不可用时不写成功记录，也不假装有图', async () => {
  const promptId = 'c3c3c3c3-4444-4555-8666-777777777777'
  const fake = createFakeFetch({
    [`/history/${promptId}`]: () => closeHistory(promptId, { images: [{ filename: '../escape.png', subfolder: '', type: 'output' }] }),
    '/queue': () => ({ queue_running: [], queue_pending: [] }),
  })
  const run = await queryRun({
    client: createComfyClient({ fetchImpl: fake.fetchImpl }),
    run: { run_id: 'r-bad-name', prompt_id: promptId, state: 'accepted' },
  })
  assert.equal(run.state, 'completed')
  assert.equal(run.execution_success, null)
  assert.match(run.message, /文件名不可用/)

  const emptyFake = createFakeFetch({
    [`/history/${promptId}`]: () => closeHistory(promptId, { images: [] }),
    '/queue': () => ({ queue_running: [], queue_pending: [] }),
  })
  const empty = await queryRun({
    client: createComfyClient({ fetchImpl: emptyFake.fetchImpl }),
    run: { run_id: 'r-empty', prompt_id: promptId, state: 'accepted' },
  })
  assert.equal(empty.state, 'completed')
  assert.equal(empty.execution_success, null)
})

test('执行成功记录不碰 ModelRecord：同一次成功不会被记成模型永久可用', async () => {
  const promptId = 'd4d4d4d4-5555-4666-8777-888888888888'
  const fake = createFakeFetch({
    [`/history/${promptId}`]: () => closeHistory(promptId),
    '/system_stats': () => ({ system: { comfyui_version: '0.33.1' } }),
    '/queue': () => ({ queue_running: [], queue_pending: [] }),
  })
  const entries = [{ category: 'checkpoints', name: 'waiIllustriousSDXL_v140.safetensors', path: 'models/checkpoints/waiIllustriousSDXL_v140.safetensors' }]
  const frozen = JSON.stringify(entries)
  const reconciled = reconcileModels({ entries, models: { checkpoints: ['waiIllustriousSDXL_v140.safetensors'] }, loaderEnums: {}, runtimeAvailable: true })
  const run = await queryRun({
    client: createComfyClient({ fetchImpl: fake.fetchImpl }),
    run: { run_id: 'r-model', prompt_id: promptId, state: 'accepted' },
  })

  assert.equal(run.execution_success.execution_status, 'success')
  // 记录里只有这一次的 selector；模型四态仍是原来那份，execution_success 恒 unknown。
  assert.equal(JSON.stringify(entries), frozen)
  assert.equal(reconciled.entries[0].states.execution_success, 'unknown')
})

test('取图按文件头判断真实格式与尺寸，HTTP 声明的类型不作数', async () => {
  // 声明是 png，实际是 JPEG 头：以文件头为准，按 jpeg 判断 Host 是否接受。
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01])
  const info = sniffImage(jpeg)
  assert.equal(info.mediaType, 'image/jpeg')
  assert.equal(info.width, 32)
  assert.equal(info.height, 16)

  const saved = []
  const attachments = {
    imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 4, maxMessageImageBytes: 4096, maxImagePixels: 4096, maxImageDimension: 128, mediaTypes: ['image/png'] },
    async saveImage(input) {
      saved.push(input)
      return { attachmentId: 'att_x', mediaType: input.mediaType, bytes: input.data.byteLength, width: 32, height: 16, name: input.name }
    },
  }
  const comfy = createComfyRuntime({
    ctx: { get: (key) => (key === 'attachments' ? attachments : undefined) },
    pluginConfig: { comfyui: { enabled: true, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: async () => imageResponse(jpeg, 'image/png'),
  })
  const result = await comfy.collectImages({ run: { images: [{ filename: 'lie.png', subfolder: '', type: 'output' }] } })
  assert.equal(saved.length, 0)
  assert.equal(result.diagnostics.length, 1)
  assert.match(result.diagnostics[0].message, /image\/jpeg/)

  // 连图片都不是：不落盘，也不说成生图失败。
  const junk = createComfyRuntime({
    ctx: { get: (key) => (key === 'attachments' ? attachments : undefined) },
    pluginConfig: { comfyui: { enabled: true, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: async () => new Response(new TextEncoder().encode('<html>not an image</html>'), { status: 200, headers: { 'content-type': 'image/png' } }),
  })
  const junked = await junk.collectImages({ run: { images: [{ filename: 'x.png', subfolder: '', type: 'output' }] } })
  assert.equal(junked.attachments.length, 0)
  assert.match(junked.diagnostics[0].message, /不是可识别的/)
})

test('像素数与长边超限都在保存前拦下，恰好达限则放行', async () => {
  const save = () => {
    const saved = []
    return {
      saved,
      service: {
        imageLimits: { maxImageBytes: 4096, maxImagesPerMessage: 4, maxMessageImageBytes: 65536, maxImagePixels: 1000, maxImageDimension: 64, mediaTypes: ['image/png'] },
        async saveImage(input) {
          saved.push(input)
          return { attachmentId: 'att_ok', mediaType: input.mediaType, bytes: input.data.byteLength, width: 10, height: 10, name: input.name }
        },
      },
    }
  }

  const tooBig = save()
  const bigRuntime = createComfyRuntime({
    ctx: { get: (key) => (key === 'attachments' ? tooBig.service : undefined) },
    pluginConfig: { comfyui: { enabled: true, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: async () => imageResponse(pngBytes(40, 40)),
  })
  const big = await bigRuntime.collectImages({ run: { images: [{ filename: 'big.png', subfolder: '', type: 'output' }] } })
  assert.equal(tooBig.saved.length, 0)
  assert.match(big.diagnostics[0].message, /1600 像素/)

  const tooLong = save()
  const longRuntime = createComfyRuntime({
    ctx: { get: (key) => (key === 'attachments' ? tooLong.service : undefined) },
    pluginConfig: { comfyui: { enabled: true, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: async () => imageResponse(pngBytes(80, 4)),
  })
  const long = await longRuntime.collectImages({ run: { images: [{ filename: 'long.png', subfolder: '', type: 'output' }] } })
  assert.equal(tooLong.saved.length, 0)
  assert.match(long.diagnostics[0].message, /长边 80/)

  // 1000 像素正好等于上限，64 长边也正好等于上限：两边都该放行。
  const exact = save()
  const exactRuntime = createComfyRuntime({
    ctx: { get: (key) => (key === 'attachments' ? exact.service : undefined) },
    pluginConfig: { comfyui: { enabled: true, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: async () => imageResponse(pngBytes(25, 40)),
  })
  const ok = await exactRuntime.collectImages({ run: { images: [{ filename: 'exact.png', subfolder: '', type: 'output' }] } })
  assert.equal(exact.saved.length, 1)
  assert.equal(ok.attachments.length, 1)
  assert.equal(ok.diagnostics.length, 0)
})

test('单图字节数恰好达限放行，多 1 字节就拒；多张总量按累计算', async () => {
  const bytes = pngBytes(2, 2).byteLength
  const make = (limits) => {
    const saved = []
    return {
      saved,
      service: {
        imageLimits: limits,
        async saveImage(input) {
          saved.push(input)
          return { attachmentId: `att_${saved.length}`, mediaType: input.mediaType, bytes: input.data.byteLength, width: 2, height: 2, name: input.name }
        },
      },
    }
  }
  const base = { maxImagesPerMessage: 4, maxImagePixels: 4096, maxImageDimension: 64, mediaTypes: ['image/png'] }

  const exact = make({ ...base, maxImageBytes: bytes, maxMessageImageBytes: bytes * 4 })
  const exactRuntime = createComfyRuntime({
    ctx: { get: (key) => (key === 'attachments' ? exact.service : undefined) },
    pluginConfig: { comfyui: { enabled: true, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: async () => imageResponse(pngBytes(2, 2)),
  })
  const passed = await exactRuntime.collectImages({ run: { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } })
  assert.equal(passed.attachments.length, 1)

  const over = make({ ...base, maxImageBytes: bytes - 1, maxMessageImageBytes: bytes * 4 })
  const overRuntime = createComfyRuntime({
    ctx: { get: (key) => (key === 'attachments' ? over.service : undefined) },
    pluginConfig: { comfyui: { enabled: true, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: async () => imageResponse(pngBytes(2, 2)),
  })
  const rejected = await overRuntime.collectImages({ run: { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } })
  assert.equal(over.saved.length, 0)
  assert.match(rejected.diagnostics[0].message, new RegExp(`超过 Host 单图上限 ${bytes - 1} 字节`))

  // 单张都合规，但两张加起来超过总量上限：整批不保存，saveImage 一次都不调。
  const total = make({ ...base, maxImageBytes: bytes, maxMessageImageBytes: bytes + 1 })
  const totalRuntime = createComfyRuntime({
    ctx: { get: (key) => (key === 'attachments' ? total.service : undefined) },
    pluginConfig: { comfyui: { enabled: true, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: async () => imageResponse(pngBytes(2, 2)),
  })
  const partial = await totalRuntime.collectImages({
    run: { images: [{ filename: 'a.png', subfolder: '', type: 'output' }, { filename: 'b.png', subfolder: '', type: 'output' }] },
  })
  assert.equal(total.saved.length, 0)
  assert.equal(partial.attachments.length, 0)
  assert.equal(partial.partial_saved, false)
  assert.equal(partial.diagnostics.length, 1)
  assert.match(partial.diagnostics[0].message, /总大小超过 Host 上限/)
})

test('附件保存失败如实说是保存失败，不写成生图失败，也不留残留', async () => {
  const saved = []
  const service = {
    imageLimits: { maxImageBytes: 4096, maxImagesPerMessage: 4, maxMessageImageBytes: 65536, maxImagePixels: 4096, maxImageDimension: 64, mediaTypes: ['image/png'] },
    async saveImage(input) {
      saved.push(input)
      throw new Error('disk full')
    },
  }
  const comfy = createComfyRuntime({
    ctx: { get: (key) => (key === 'attachments' ? service : undefined) },
    pluginConfig: { comfyui: { enabled: true, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: async () => imageResponse(pngBytes(2, 2)),
  })
  const result = await comfy.collectImages({ run: { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } })
  assert.equal(saved.length, 1)
  assert.equal(result.attachments.length, 0)
  assert.equal(result.diagnostics.length, 1)
  assert.equal(result.diagnostics[0].error_code, COMFY_CODES.OUTPUT_UNAVAILABLE)
  assert.match(result.diagnostics[0].message, /图片已生成，但保存为附件失败/)
  assert.doesNotMatch(result.diagnostics[0].message, /生图失败/)
})

test('get_job 把执行成功记录与工作流摘要分开交给调用方，未完成时两者都不伪造', async () => {
  const promptId = 'e5e5e5e5-6666-4777-8888-999999999999'
  const doneFake = createFakeFetch({
    [`/history/${promptId}`]: () => closeHistory(promptId),
    '/system_stats': () => ({ system: { comfyui_version: '0.33.1' } }),
    '/queue': () => ({ queue_running: [], queue_pending: [] }),
    '*': () => imageResponse(pngBytes(2, 2)),
  })
  const attachments = {
    imageLimits: { maxImageBytes: 4096, maxImagesPerMessage: 4, maxMessageImageBytes: 65536, maxImagePixels: 4096, maxImageDimension: 64, mediaTypes: ['image/png'] },
    async saveImage(input) {
      return { attachmentId: 'att_done', mediaType: input.mediaType, bytes: input.data.byteLength, width: 2, height: 2, name: input.name }
    },
  }
  const comfy = createComfyRuntime({
    ctx: { get: (key) => (key === 'attachments' ? attachments : undefined) },
    pluginConfig: { comfyui: { enabled: true, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: doneFake.fetchImpl,
  })
  const spec = createComfyToolSpecs({ getComfyUI: async () => comfy, logger: SILENT_LOGGER }).find(
    (item) => item.name === 'comfyui_get_job',
  )
  const result = await spec.execute({ prompt_id: promptId }, {})
  assert.equal(result.state, 'completed')
  assert.equal(result.attachments.length, 1)
  assert.equal(result.execution_success.execution_status, 'success')
  assert.equal(result.execution_success.workflow_nodes, 6)
  assert.equal(result.workflow, null)

  const pendingFake = createFakeFetch({
    [`/history/${promptId}`]: () => ({}),
    '/queue': () => ({ queue_running: [[1, promptId]], queue_pending: [] }),
  })
  const pending = createComfyRuntime({
    ctx: {},
    pluginConfig: { comfyui: { enabled: true, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: pendingFake.fetchImpl,
  })
  const pendingSpec = createComfyToolSpecs({ getComfyUI: async () => pending, logger: SILENT_LOGGER }).find(
    (item) => item.name === 'comfyui_get_job',
  )
  const waiting = await pendingSpec.execute({ prompt_id: promptId }, {})
  assert.equal(waiting.state, 'running')
  assert.equal(waiting.execution_success, null)
  assert.equal(waiting.attachments.length, 0)
  await comfy.dispose()
  await pending.dispose()
})

test('多张图先全部取回并校验，确认整批都能交给 Host 之后才开始保存', async () => {
  const events = []
  const service = {
    imageLimits: {
      maxImageBytes: 4096,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 65536,
      maxImagePixels: 4096,
      maxImageDimension: 64,
      mediaTypes: ['image/png'],
    },
    async saveImage(input) {
      events.push(`save:${input.name}`)
      return {
        attachmentId: `att_${events.length}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 2,
        height: 2,
        name: input.name,
      }
    },
  }
  const comfy = createComfyRuntime({
    ctx: { get: (key) => (key === 'attachments' ? service : undefined) },
    pluginConfig: { comfyui: { enabled: true, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: async (url) => {
      events.push(`fetch:${new URL(String(url)).searchParams.get('filename')}`)
      return imageResponse(pngBytes(2, 2))
    },
  })
  const result = await comfy.collectImages({
    run: {
      images: [
        { filename: 'a.png', subfolder: '', type: 'output' },
        { filename: 'b.png', subfolder: '', type: 'output' },
        { filename: 'c.png', subfolder: '', type: 'output' },
      ],
    },
  })

  // 三个 fetch 全排在第一个 save 之前：没有任何一张是在"还没校验完"的时候存下去的。
  assert.deepEqual(events, ['fetch:a.png', 'fetch:b.png', 'fetch:c.png', 'save:a.png', 'save:b.png', 'save:c.png'])
  assert.equal(result.attachments.length, 3)
  assert.equal(result.partial_saved, false)
})

test('第二张图超限时，一张都不保存，saveImage 调用次数为零', async () => {
  let saveCalls = 0
  const service = {
    imageLimits: {
      maxImageBytes: 4096,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 65536,
      maxImagePixels: 1000,
      maxImageDimension: 64,
      mediaTypes: ['image/png'],
    },
    async saveImage() {
      saveCalls += 1
      throw new Error('不该被调用')
    },
  }
  const comfy = createComfyRuntime({
    ctx: { get: (key) => (key === 'attachments' ? service : undefined) },
    pluginConfig: { comfyui: { enabled: true, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: async (url) => {
      const name = new URL(String(url)).searchParams.get('filename')
      // 第一张 2×2 合规，第二张 40×40 超像素上限。
      return name === 'b.png' ? imageResponse(pngBytes(40, 40)) : imageResponse(pngBytes(2, 2))
    },
  })
  const result = await comfy.collectImages({
    run: {
      images: [
        { filename: 'a.png', subfolder: '', type: 'output' },
        { filename: 'b.png', subfolder: '', type: 'output' },
      ],
    },
  })

  assert.equal(saveCalls, 0)
  assert.equal(result.attachments.length, 0)
  assert.equal(result.partial_saved, false)
  assert.equal(result.diagnostics.length, 1)
  assert.match(result.diagnostics[0].message, /超过 Host 上限 1000 像素/)
})

test('张数超限时整个批次不保存，也不悄悄截断成前几张', async () => {
  let saveCalls = 0
  const service = {
    imageLimits: {
      maxImageBytes: 4096,
      maxImagesPerMessage: 2,
      maxMessageImageBytes: 65536,
      maxImagePixels: 4096,
      maxImageDimension: 64,
      mediaTypes: ['image/png'],
    },
    async saveImage() {
      saveCalls += 1
      throw new Error('不该被调用')
    },
  }
  let fetches = 0
  const comfy = createComfyRuntime({
    ctx: { get: (key) => (key === 'attachments' ? service : undefined) },
    pluginConfig: { comfyui: { enabled: true, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: async () => {
      fetches += 1
      return imageResponse(pngBytes(2, 2))
    },
  })
  const result = await comfy.collectImages({
    run: {
      images: [
        { filename: 'a.png', subfolder: '', type: 'output' },
        { filename: 'b.png', subfolder: '', type: 'output' },
        { filename: 'c.png', subfolder: '', type: 'output' },
      ],
    },
  })

  assert.equal(fetches, 0)
  assert.equal(saveCalls, 0)
  assert.equal(result.attachments.length, 0)
  assert.equal(result.diagnostics.length, 1)
  assert.match(result.diagnostics[0].message, /整批都没有取回/)
})

test('第二张保存失败时如实报告 partial_saved，已存下的那张仍然交回去', async () => {
  let call = 0
  const service = {
    imageLimits: {
      maxImageBytes: 4096,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 65536,
      maxImagePixels: 4096,
      maxImageDimension: 64,
      mediaTypes: ['image/png'],
    },
    async saveImage(input) {
      call += 1
      if (call === 2) throw new Error('attachment store full')
      return {
        attachmentId: `att_${call}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 2,
        height: 2,
        name: input.name,
      }
    },
  }
  const comfy = createComfyRuntime({
    ctx: { get: (key) => (key === 'attachments' ? service : undefined) },
    pluginConfig: { comfyui: { enabled: true, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: async () => imageResponse(pngBytes(2, 2)),
  })
  const result = await comfy.collectImages({
    run: {
      images: [
        { filename: 'a.png', subfolder: '', type: 'output' },
        { filename: 'b.png', subfolder: '', type: 'output' },
        { filename: 'c.png', subfolder: '', type: 'output' },
      ],
    },
  })

  assert.equal(result.partial_saved, true)
  assert.equal(result.attachments.length, 1)
  assert.equal(result.attachments[0].name, 'a.png')
  assert.equal(result.diagnostics.length, 1)
  const message = result.diagnostics[0].message
  assert.match(message, /保存为附件失败/)
  assert.match(message, /attachment store full/)
  // 已存的那张回滚不了，就不该假装能回滚。
  assert.match(message, /没有删除接口/)
  assert.doesNotMatch(message, /生图失败/)
  // 第二张失败之后不再继续尝试后面的图。
  assert.equal(call, 2)
})

test('history 标了完成但记录里有执行错误，按失败处理，不写成功记录', async () => {
  const promptId = 'b2b2b2b2-3333-4444-8555-666666666666'
  const fake = createFakeFetch({
    [`/history/${promptId}`]: () =>
      closeHistory(promptId, {
        completed: true,
        statusStr: 'error',
        messages: [['execution_error', { exception_message: 'CUDA out of memory' }]],
      }),
    '/system_stats': () => ({ system: { comfyui_version: '0.33.1' } }),
    '/queue': () => ({ queue_running: [], queue_pending: [] }),
  })
  const run = await queryRun({
    client: createComfyClient({ fetchImpl: fake.fetchImpl }),
    run: { run_id: 'r-err', prompt_id: promptId, state: 'accepted' },
  })

  assert.equal(run.state, 'failed')
  assert.equal(run.execution_success, undefined)
  assert.match(run.message, /CUDA out of memory/)
  assert.match(run.message, /按失败处理/)
})

test('history 完成但没有输出节点时，不写成功记录', async () => {
  const promptId = 'c3c3c3c3-4444-4555-8666-777777777777'
  const fake = createFakeFetch({
    [`/history/${promptId}`]: () => closeHistory(promptId, { completed: true, outputs: {} }),
    '/system_stats': () => ({ system: { comfyui_version: '0.33.1' } }),
    '/queue': () => ({ queue_running: [], queue_pending: [] }),
  })
  const run = await queryRun({
    client: createComfyClient({ fetchImpl: fake.fetchImpl }),
    run: { run_id: 'r-empty', prompt_id: promptId, state: 'accepted' },
  })

  assert.equal(run.state, 'completed')
  assert.equal(run.execution_success, null)
  assert.deepEqual(run.images, [])
  assert.match(run.message, /没有产出图片/)
})

test('输出引用带子目录越界或非法 type 时不算可取回，也不拼 /view 链接', async () => {
  const client = createComfyClient({ fetchImpl: async () => jsonResponse(200, {}) })
  for (const image of [
    { filename: 'ok.png', subfolder: '../outside', type: 'output' },
    { filename: 'ok.png', subfolder: 'C:/Windows', type: 'output' },
    { filename: 'ok.png', subfolder: 'sub', type: 'secret' },
    { filename: 'ok.png', subfolder: 'sub', type: 'Output' },
  ]) {
    assert.equal(isSafeOutputRef(image), false, `${JSON.stringify(image)} 不该被判为可取回`)
    assert.throws(() => imageViewUrl(client, image), (error) => error.code === COMFY_CODES.OUTPUT_UNAVAILABLE)
  }
  // 正常的嵌套子目录仍然放行；type 缺省按 output 处理，与 imageViewUrl 一致。
  assert.equal(isSafeOutputRef({ filename: 'ok.png', subfolder: 'sub/dir', type: 'temp' }), true)
  assert.equal(isSafeOutputRef({ filename: 'ok.png', subfolder: 'sub', type: null }), true)
  assert.match(imageViewUrl(client, { filename: 'ok.png', subfolder: 'sub/dir', type: 'output' }), /\/view\?/)
})

test('history 里的工作流结构与提交时对不上时，不写成功记录', async () => {
  const promptId = 'd4d4d4d4-5555-4666-8777-888888888888'
  const otherPrompt = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'other.safetensors' } },
    '2': { class_type: 'SaveImage', inputs: { filename_prefix: 'x', images: ['1', 0] } },
  }
  const fake = createFakeFetch({
    [`/history/${promptId}`]: () => closeHistory(promptId, { completed: true, prompt: otherPrompt }),
    '/system_stats': () => ({ system: { comfyui_version: '0.33.1' } }),
    '/queue': () => ({ queue_running: [], queue_pending: [] }),
  })
  const run = await queryRun({
    client: createComfyClient({ fetchImpl: fake.fetchImpl }),
    run: {
      run_id: 'r-stale',
      prompt_id: promptId,
      state: 'accepted',
      workflow: describeExecution(CLOSE_PROMPT),
    },
  })

  assert.equal(run.state, 'completed')
  assert.equal(run.execution_success, null)
  assert.match(run.message, /对不上/)
})

// ───────────────────────── T17：对话内显示图片（Host 侧那一半） ─────────────────────────
// 图片不进模型上下文：工具结果给模型看的仍然只有文本，附件引用走 output.presentationMeta
// 写进 block.meta，由浏览器半侧自己取图。这一段把这条边界钉死。

function recordingCtx() {
  const registered = []
  return {
    registered,
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {
          const index = registered.indexOf(definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
  }
}

test('只有显式声明 presentationMeta 的工具才往 block.meta 里写东西', () => {
  const ctx = recordingCtx()
  registerTool(ctx, {
    name: 'plain_tool',
    description: '没有展示元数据的工具',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ ok: true }),
  })
  registerTool(ctx, {
    name: 'rich_tool',
    description: '带展示元数据的工具',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ ok: true }),
    presentationMeta: (args, value) => ({ echo: args?.x ?? null, ok: value?.ok ?? null }),
  })

  const [plain, rich] = ctx.registered
  assert.equal('presentationMeta' in plain.output, false)
  assert.equal(typeof rich.output.presentationMeta, 'function')
  assert.deepEqual(rich.output.presentationMeta({ x: 1 }, { ok: true }), { echo: 1, ok: true })
  // 参数缺省时也要能调，不能因为 args 是 undefined 就抛。
  assert.deepEqual(rich.output.presentationMeta(undefined, { ok: false }), { echo: null, ok: false })
})

test('get_job 的展示元数据是驼峰引用，字段不全的引用整条丢掉', async () => {
  const promptId = 'c0c0c0c0-1111-4222-8333-444444444444'
  const fake = createFakeFetch({
    [`/history/${promptId}`]: () =>
      closeHistory(promptId, { completed: true, images: [{ filename: 'a.png', subfolder: '', type: 'output' }] }),
    '/system_stats': () => ({ system: { comfyui_version: '0.33.1' } }),
    '/queue': () => ({ queue_running: [], queue_pending: [] }),
    '/view': () => imageResponse(pngBytes(4, 4)),
  })
  const saved = []
  const attachments = {
    imageLimits: {
      maxImageBytes: 1 << 20,
      maxImagesPerMessage: 8,
      maxMessageImageBytes: 1 << 22,
      maxImagePixels: 1 << 24,
      maxImageDimension: 8192,
      mediaTypes: ['image/png'],
    },
    async saveImage(input) {
      saved.push(input)
      return {
        attachmentId: 'sha256:aaaa',
        mediaType: 'image/png',
        bytes: 40,
        width: 4,
        height: 4,
        name: input.name,
      }
    },
  }
  const comfy = createComfyRuntime({
    ctx: { get: (key) => (key === 'attachments' ? attachments : undefined) },
    pluginConfig: { comfyui: { enabled: true, autoDetect: false, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: fake.fetchImpl,
  })
  const spec = createComfyToolSpecs({ getComfyUI: async () => comfy, logger: SILENT_LOGGER }).find(
    (item) => item.name === 'comfyui_get_job',
  )
  const value = await spec.execute({ prompt_id: promptId }, {})

  const meta = spec.presentationMeta({ prompt_id: promptId }, value)
  assert.equal(meta.state, 'completed')
  assert.equal(meta.images.length, 1)
  assert.deepEqual(Object.keys(meta.images[0]).sort(), [
    'attachmentId',
    'bytes',
    'height',
    'mediaType',
    'name',
    'url',
    'width',
  ])
  assert.equal(meta.images[0].attachmentId, 'sha256:aaaa')
  assert.equal(meta.images[0].mediaType, 'image/png')
  // 宿主只授权会话事件里出现过的图片，生成结果读不到附件，浏览器要退回 /view。
  assert.equal(
    meta.images[0].url,
    `http://127.0.0.1:8188/view?filename=a.png&subfolder=&type=output`,
  )
  // 元数据里不能出现图片字节：一旦 base64 混进来，它会跟着会话历史一起涨。
  assert.doesNotMatch(JSON.stringify(meta), /data:image|base64|iVBORw0KGgo/)

  // 字段缺失或为空的引用不能进 meta，否则浏览器侧会拼出一个不存在的图。
  const dirty = spec.presentationMeta(
    {},
    {
      state: 'completed',
      message: 'x',
      attachments: [
        { attachment_id: '', media_type: 'image/png', bytes: 1, width: 1, height: 1 },
        { attachment_id: 'sha256:bbbb', media_type: 'image/png', bytes: 1, width: 1, height: 1 },
        { media_type: 'image/png', bytes: 1, width: 1, height: 1 },
        null,
      ],
    },
  )
  assert.equal(dirty.images.length, 1)
  assert.equal(dirty.images[0].attachmentId, 'sha256:bbbb')
  await comfy.dispose()
})

test('get_job 给模型看的内容仍然只有文本，没有 image block', async () => {
  const promptId = 'c1c1c1c1-1111-4222-8333-444444444444'
  const fake = createFakeFetch({
    [`/history/${promptId}`]: () =>
      closeHistory(promptId, { completed: true, images: [{ filename: 'a.png', subfolder: '', type: 'output' }] }),
    '/system_stats': () => ({ system: { comfyui_version: '0.33.1' } }),
    '/queue': () => ({ queue_running: [], queue_pending: [] }),
    '/view': () => imageResponse(pngBytes(4, 4)),
  })
  const attachments = {
    imageLimits: {
      maxImageBytes: 1 << 20,
      maxImagesPerMessage: 8,
      maxMessageImageBytes: 1 << 22,
      maxImagePixels: 1 << 24,
      maxImageDimension: 8192,
      mediaTypes: ['image/png'],
    },
    async saveImage(input) {
      return { attachmentId: 'sha256:cccc', mediaType: 'image/png', bytes: 40, width: 4, height: 4, name: input.name }
    },
  }
  const comfy = createComfyRuntime({
    ctx: { get: (key) => (key === 'attachments' ? attachments : undefined) },
    pluginConfig: { comfyui: { enabled: true, autoDetect: false, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: fake.fetchImpl,
  })
  const ctx = recordingCtx()
  const runtime = {
    logger: SILENT_LOGGER,
    comfyuiEnabled: true,
    getComfyUI: async () => comfy,
  }
  for (const spec of createComfyToolSpecs(runtime)) registerTool(ctx, spec)
  const definition = ctx.registered.find((item) => item.name === 'comfyui_get_job')
  const value = await definition.execute({ prompt_id: promptId }, {})

  const content = definition.output.render({ prompt_id: promptId }, value)
  assert.equal(content.length, 1)
  assert.equal(content[0].type, 'text')
  assert.doesNotMatch(content[0].text, /data:image|base64/)
  // 文本里仍然要说清楚有几张图、在哪，模型据此决定要不要继续追问。
  assert.match(content[0].text, /a\.png/)
  await comfy.dispose()
})

// ───── T18：启动与打开。四个固定动作，不接命令字符串 ─────

const LAUNCH_ROOT = 'D:\\ComfyUI\\ComfyUI_windows_portable\\ComfyUI'
const LAUNCH_BUNDLE = 'D:\\ComfyUI\\ComfyUI_windows_portable'

function launcherRuntime({ tree, subprocess, routes = {}, baseUrl = 'http://127.0.0.1:8188', installRoot = LAUNCH_ROOT }) {
  const fs = createMemoryFs({ tree })
  const fake = createFakeFetch(routes)
  const comfy = createComfyRuntime({
    ctx: { fs, get: (key) => (key === 'subprocess' ? subprocess : undefined) },
    pluginConfig: { comfyui: { enabled: true, autoDetect: false, baseUrl, installRoot } },
    logger: SILENT_LOGGER,
    fetchImpl: fake.fetchImpl,
    subprocess,
    platform: 'win32',
  })
  return { comfy, fs, fake }
}

test('comfyui_start 只暴露四个固定动作，未知动作在碰任何东西之前就被拒', async () => {
  const subprocess = createFakeSubprocess()
  const { comfy } = launcherRuntime({ tree: installTree(LAUNCH_ROOT), subprocess })

  const spec = createComfyToolSpecs({ getComfyUI: async () => comfy, logger: SILENT_LOGGER }).find(
    (item) => item.name === 'comfyui_start',
  )
  assert.deepEqual(spec.parameters.properties.action.enum, [
    'open_launcher',
    'start_backend',
    'open_install_folder',
    'open_web_ui',
  ])
  assert.deepEqual(spec.parameters.required, ['action'])
  assert.equal(spec.parameters.additionalProperties, false)

  // 这里没有"命令"这个字段，也绝不把它拼进 argv。
  const rejected = await spec.execute({ action: 'run: rm -rf /' }, {})
  assert.equal(rejected.status, 'failed')
  assert.equal(rejected.diagnostics[0].error_code, COMFY_CODES.VALIDATION_FAILED)
  assert.equal(subprocess.calls.length, 0)
  await comfy.dispose()
})

test('已有实例在响应时 start_backend 不再起第二个进程', async () => {
  const subprocess = createFakeSubprocess()
  const { comfy, fake } = launcherRuntime({
    tree: installTree(LAUNCH_ROOT),
    subprocess,
    routes: { '/system_stats': () => ({ system: { comfyui_version: '0.33.1' }, devices: [] }) },
  })

  const result = await comfy.start({ action: 'start_backend' })
  assert.equal(result.started, false)
  assert.equal(result.reason, 'already_running')
  assert.equal(subprocess.calls.length, 0)
  // 只探了一次 /system_stats，没有别的请求。
  assert.deepEqual(fake.calls.map((item) => item.pathname), ['/system_stats'])
  await comfy.dispose()
})

test('找不到 python 解释器时列出找过的位置，并且不启动进程', async () => {
  const subprocess = createFakeSubprocess()
  const { comfy } = launcherRuntime({ tree: installTree(LAUNCH_ROOT), subprocess })

  await assert.rejects(
    () => comfy.start({ action: 'start_backend' }),
    (error) => {
      assert.equal(error.code, COMFY_CODES.CAPABILITY_UNAVAILABLE)
      // 报错里必须有具体找过哪些位置，否则用户只能靠猜。
      assert.match(error.suggested_fix, /python_embeded/)
      return true
    },
  )
  assert.equal(subprocess.calls.length, 0)
  await comfy.dispose()
})

test('start_backend 的参数写死在代码里，端口只取自校验过的回环地址', async () => {
  // joinPath 把相对片段统一成平台分隔符，所以期望值也走同一个函数。
  const python = `${LAUNCH_ROOT}\\python_embeded\\python.exe`
  const subprocess = createFakeSubprocess({ hang: true })
  const { comfy } = launcherRuntime({
    tree: mergeTrees(installTree(LAUNCH_ROOT), { [python]: { type: 'file', size: 1024 } }),
    subprocess,
  })

  const result = await comfy.start({ action: 'start_backend' })
  assert.equal(result.started, true)
  assert.equal(result.port, 8188)
  assert.deepEqual(
    subprocess.calls[0].argv,
    [python, 'main.py', '--listen', '127.0.0.1', '--port', '8188'],
    JSON.stringify(subprocess.calls[0].argv),
  )
  assert.equal(subprocess.calls[0].cwd, LAUNCH_ROOT)
  assert.equal(comfy.describe().launch.backend_started, true)
  assert.equal(comfy.describe().implemented.launch, true)

  // 只有自己启动的进程才会被 dispose 结束。
  assert.equal(await comfy.dispose(), true)
  assert.equal(subprocess.handles[0].terminateCalls, 1)
})

test('没启动过后端的运行时，dispose 不会去结束任何进程', async () => {
  const subprocess = createFakeSubprocess()
  const { comfy } = launcherRuntime({ tree: installTree(LAUNCH_ROOT), subprocess })
  assert.equal(comfy.describe().launch.backend_started, false)
  await comfy.dispose()
  assert.equal(subprocess.calls.length, 0)
})

test('open_install_folder 用固定命令打开安装根，路径不当命令行再解析', async () => {
  const subprocess = createFakeSubprocess()
  const { comfy } = launcherRuntime({ tree: installTree(LAUNCH_ROOT), subprocess })

  const result = await comfy.start({ action: 'open_install_folder' })
  assert.equal(result.command, 'explorer.exe')
  assert.equal(result.target, LAUNCH_ROOT)
  assert.deepEqual(subprocess.calls[0].argv, ['explorer.exe', LAUNCH_ROOT])
  await comfy.dispose()
})

test('整合包的启动器在外层目录，能被找到并打开', async () => {
  const launcher = `${LAUNCH_BUNDLE}\\A绘世启动器.exe`
  const subprocess = createFakeSubprocess()
  const { comfy } = launcherRuntime({
    tree: mergeTrees(installTree(LAUNCH_ROOT), { [launcher]: { type: 'file', size: 2048 } }),
    subprocess,
  })

  const result = await comfy.start({ action: 'open_launcher' })
  assert.equal(result.launcher, launcher)
  assert.deepEqual(subprocess.calls[0].argv, ['explorer.exe', launcher])
  await comfy.dispose()
})

test('同时存在多个启动器时报候选，不替用户挑一个', async () => {
  const subprocess = createFakeSubprocess()
  const { comfy } = launcherRuntime({
    tree: mergeTrees(installTree(LAUNCH_ROOT), {
      [`${LAUNCH_ROOT}\\run_nvidia_gpu.bat`]: { type: 'file', size: 512 },
      [`${LAUNCH_ROOT}\\run_cpu.bat`]: { type: 'file', size: 512 },
    }),
    subprocess,
  })

  await assert.rejects(
    () => comfy.start({ action: 'open_launcher' }),
    (error) => {
      assert.equal(error.code, COMFY_CODES.BINDING_AMBIGUOUS)
      assert.match(error.message, /run_nvidia_gpu\.bat/)
      assert.match(error.message, /run_cpu\.bat/)
      return true
    },
  )
  assert.equal(subprocess.calls.length, 0)
  await comfy.dispose()
})

test('整合包把 python 放在安装根上一级时也能找到，不要求它搬进安装根', async () => {
  // 秋葉这类整合包：<包>/python/python.exe，而安装根是 <包>/ComfyUI。
  const python = `${LAUNCH_BUNDLE}\\python\\python.exe`
  const subprocess = createFakeSubprocess({ hang: true })
  const { comfy } = launcherRuntime({
    tree: mergeTrees(installTree(LAUNCH_ROOT), { [python]: { type: 'file', size: 1024 } }),
    subprocess,
  })

  const result = await comfy.start({ action: 'start_backend' })
  assert.equal(result.started, true)
  assert.equal(result.python, python)
  // 解释器在外层，但工作目录仍然是安装根，main.py 才找得到。
  assert.equal(subprocess.calls[0].cwd, LAUNCH_ROOT)
  await comfy.dispose()
})

test('open_web_ui 拒绝把非本机地址交给系统浏览器', async () => {
  const subprocess = createFakeSubprocess()
  const { comfy } = launcherRuntime({
    tree: installTree(LAUNCH_ROOT),
    subprocess,
    baseUrl: 'http://10.0.0.5:8188',
  })

  await assert.rejects(
    () => comfy.start({ action: 'open_web_ui' }),
    (error) => {
      assert.equal(error.code, COMFY_CODES.TARGET_NOT_LOCAL)
      return true
    },
  )
  assert.equal(subprocess.calls.length, 0)
  await comfy.dispose()
})

// ───── T19：同源转发 ─────────────────────────────────────────────

function invokeRoute(route, rawUrl, method = 'GET') {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = String(value)
      },
      end(body) {
        resolve({ status: this.statusCode, headers: this.headers, body })
      },
    }
    Promise.resolve(route.handler({ method, url: rawUrl }, res)).catch((error) =>
      resolve({ status: 0, headers: {}, body: null, error }),
    )
  })
}

test('有 webServer 时把生成图转发成同源地址，页面 CSP 才放行', async () => {
  const routes = new Map()
  const webServer = {
    getOrigin: () => 'http://127.0.0.1:56218',
    register(route) {
      if (routes.has(route.path)) throw new Error('duplicate route')
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const fake = createFakeFetch({ '/view': () => imageResponse(pngBytes(4, 4)) })
  const comfy = createComfyRuntime({
    ctx: { get: (key) => (key === 'webServer' ? webServer : undefined) },
    pluginConfig: { comfyui: { enabled: true, autoDetect: false, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: fake.fetchImpl,
  })

  const url = comfy.imageProxyUrl({ filename: 'a.png', subfolder: '', type: 'output' })
  assert.equal(url, '/comfyui/image?filename=a.png&subfolder=&type=output')
  // 重复调用不再注册第二条路由：宿主对重复 (kind, path) 直接抛。
  comfy.imageProxyUrl({ filename: 'b.png', subfolder: '', type: 'output' })
  assert.equal(routes.size, 1)

  const route = routes.get('/comfyui/image')
  // 转发前按 /view 的规矩验输出引用，不能让查询串变成任意文件读取。
  assert.equal((await invokeRoute(route, '/comfyui/image?filename=../../secret.png')).status, 400)
  assert.equal((await invokeRoute(route, '/comfyui/image?filename=a.png&type=../../etc')).status, 400)
  assert.equal((await invokeRoute(route, '/comfyui/image?filename=a.png', 'POST')).status, 405)

  const ok = await invokeRoute(route, '/comfyui/image?filename=a.png&subfolder=&type=output')
  assert.equal(ok.status, 200)
  assert.equal(ok.headers['content-type'], 'image/png')
  // 转发的是原始字节，不是重新编码的结果。
  assert.equal(ok.body[0], 0x89)
  assert.equal(ok.body[1], 0x50)

  await comfy.dispose()
  // 卸载要把路由还回去，否则下一次加载会因为重复注册而失败。
  assert.equal(routes.size, 0)
})

test('宿主没有 webServer 时退回 ComfyUI 原始地址，不假装能显示', async () => {
  const comfy = createComfyRuntime({
    ctx: { get: () => undefined },
    pluginConfig: { comfyui: { enabled: true, autoDetect: false, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
  })
  assert.equal(comfy.imageProxyUrl({ filename: 'a.png', subfolder: '', type: 'output' }), null)
  assert.equal(
    comfy.imageViewUrl({ filename: 'a.png', subfolder: '', type: 'output' }),
    'http://127.0.0.1:8188/view?filename=a.png&subfolder=&type=output',
  )
  await comfy.dispose()
})
