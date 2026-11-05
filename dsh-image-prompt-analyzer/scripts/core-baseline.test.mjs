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
import { applyWorkflowPatch, planWorkflowPatch, stableFingerprint } from '../lib/comfyui/patch.js'
import { imageViewUrl, isValidPromptId, queryRun, submitPrompt } from '../lib/comfyui/runs.js'
import { detectWorkflowFormat, inspectWorkflow } from '../lib/comfyui/workflow.js'
import { createComfyToolSpecs } from '../lib/comfyui/tools.js'
import YAML from 'yaml'
import { createFakeFetch, createMemoryFs, jsonResponse } from './fixtures/comfyui/harness.mjs'

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

test('ComfyUI 默认关闭，默认值取自内置默认配置', () => {
  const resolved = resolvePluginConfig({})
  assert.equal(resolved.config.comfyui.enabled, false)
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
    ['model_catalog', 'model_scan', 'query', 'submit', 'workflow_patch', 'workflow_read'],
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

test('未启用时六个工具一律返回 CAPABILITY_UNAVAILABLE，且不碰 fs 与网络', async () => {
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
    return new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })
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
