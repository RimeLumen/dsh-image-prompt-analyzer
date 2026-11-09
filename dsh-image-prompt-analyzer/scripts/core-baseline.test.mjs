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
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { registerAllTools } from '../lib/tools/index.js'
import { compilePrompt } from '../lib/compile/index.js'
import { MOSS_CODES, MOSS_NEGATIVE_BASE } from '../lib/compile/moss.js'
import { createConfigStore, resolveProfileRequest } from '../lib/config/loader.js'
// PLUGIN_CONFIG_CODES 没有从 plugin-config.js 导出，所以这里比对错误码字面量。
// 字面量同时也是对外契约的一部分：诊断里的 error_code 就是这些字符串。
import { DEFAULT_PLUGIN_CONFIG, PLUGIN_CONFIG_SCHEMA, resolvePluginConfig } from '../lib/config/plugin-config.js'
import { createRuntime } from '../lib/runtime.js'
import { PLUGIN_VERSION } from '../lib/version.js'
import { buildAnalysisEnvelope, traceStage } from '../lib/pipeline/stages.js'
import { TRACE_STAGES } from '../lib/trace/stages.js'
import {
  COMFY_CODES,
  ComfyError,
  DEFAULT_COMFY_BASE_URL,
  DEFAULT_COMFY_TIMEOUT_MS,
  createComfyRuntime,
  normalizeComfySettings,
  parseLoopbackBaseUrl,
} from '../lib/comfyui/index.js'
import { CATEGORY_ALIASES, canonicalCategory, categoryNames, joinLikePython, parseModelPathsYaml } from '../lib/comfyui/paths.js'
import { scanModelRoots, scanRoot } from '../lib/comfyui/catalog.js'
import { CATEGORY_LOADERS, filterByStates, reconcileModels } from '../lib/comfyui/reconcile.js'
import { assertLoopbackNotProxied, createComfyClient } from '../lib/comfyui/client.js'
import { analyzeBindings, resolvePromptTarget } from '../lib/comfyui/bindings.js'
import { openKnowledgeDatabase } from '../lib/kb/db.js'
import { experienceStats, listExperiences, searchExperiences } from '../lib/experience/store.js'
import { runManageExperiences } from '../lib/tools/impl/manage-experiences.js'
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
import {
  detectActiveUser,
  isAbsolutePath,
  listWorkflows,
  resolveWorkflowByName,
  workflowRoots,
  workflowUserRoot,
} from '../lib/comfyui/workflows.js'
import { architectureInPrompt, resolveModelArchitecture } from '../lib/comfyui/loader-architecture.js'
import { createObjectInfoCache, fetchNodeInfos } from '../lib/comfyui/object-info.js'
import { buildWorkflow, classesInPrompt, validateBuiltWorkflow } from '../lib/comfyui/build.js'
import { ROLE_VALUES, resolveSemanticChanges } from '../lib/comfyui/edits.js'
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
  // 2026-11-08 有意更新：include_ir 的描述改成「调试用」，并把工具描述里
  // 「两个正稿字段并列返回」的旧说法换掉。属性名、枚举、required 全部未动。
  // 2026-11-09 有意更新：示例档案名 animagine-xl-4.0 → anima（同一份档案改名，
  // 旧名登记为别名）。属性名、枚举、required 仍未动。
  // 2026-11-09 再次有意更新：新增 moss 档案后，描述里补上 prompt_style 的第三个值
  // caption 与示例档案名 moss。属性名、枚举、required 依旧未动。
  analyze_image_prompt: '16ada85c52eaf3f200d94fde768ddaf2378ac613208d8c91f53b65719d0288e1',
  validate_configs: 'c288b8347979e39b2eb3083e661c81f2e2555e3bfac948a13bc2834be17c2801',
  diagnose_knowledge_base: 'e366cbd5fddf761a42b34d27b790d867e8f2405b0523c92eeaae536427844682',
  rebuild_knowledge_base: '562b673a7a02ee57c03e7ac880d186e3f9ccb80ce3033ae560abac6ffecba6d3',
  preview_model_profile: '1c43163146bbec55bfa23e798c12697458e47d13e1d01c8972dc4bd5494790c3',
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

test('未启用时十个工具一律返回 CAPABILITY_UNAVAILABLE，且不碰 fs 与网络', async () => {
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
    'comfyui_list_workflows',
    'comfyui_build_workflow',
    'comfyui_save_workflow',
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

test('显式 enabled=false 时十个工具根本不注册，discover 也不会跑', async () => {
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

test('十个工具在任何状态下都不把 undefined 拼进错误信息', async () => {
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
  assert.equal(comfyTools.length, 10)
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

// ───────────────────────── MODEL-SCAN-FIX：别名对账与分类统计 ─────────────────────────
// 这一段只证明本地对账逻辑正确。真实机器上 text_encoders / diffusion_models 的
// 具体文件数另行只读核对，两者不能互相替代。

/** 一个只有 models/ 下若干分类目录的最小安装。files 形如 { 'clip/clip_l.safetensors': 100 }。 */
function modelsTree(install, files = {}, extraDirs = []) {
  const tree = mergeTrees(installTree(install), { [`${install}\\models`]: { type: 'directory' } })
  for (const dir of extraDirs) {
    tree[`${install}\\models\\${dir.replace(/\//g, '\\')}`] = { type: 'directory' }
  }
  for (const [relative, size] of Object.entries(files)) {
    const parts = relative.split('/')
    for (let i = 1; i < parts.length; i += 1) {
      tree[`${install}\\models\\${parts.slice(0, i).join('\\')}`] = { type: 'directory' }
    }
    tree[`${install}\\models\\${relative.replace(/\//g, '\\')}`] = { type: 'file', size }
  }
  return tree
}

function listModelsSpec(comfy) {
  return createComfyToolSpecs({ getComfyUI: async () => comfy, logger: SILENT_LOGGER }).find(
    (item) => item.name === 'comfyui_list_models',
  )
}

test('clip 别名目录里的文件按 text_encoders 对账，不再判成运行时看不见', async () => {
  const install = 'C:\\ComfyUI'
  const fs = createMemoryFs({
    tree: modelsTree(install, {
      'clip/clip_l.safetensors': 100,
      'clip/t5xxl_fp16.safetensors': 100,
      'text_encoders/qwen_3_06b_base.safetensors': 100,
    }),
  })
  const fake = createFakeFetch({
    '/models': () => ['text_encoders'],
    '/models/text_encoders': () => ['clip_l.safetensors', 't5xxl_fp16.safetensors', 'qwen_3_06b_base.safetensors'],
    '/object_info/CLIPLoader': () => ({
      CLIPLoader: {
        input: {
          required: {
            clip_name: [['clip_l.safetensors', 't5xxl_fp16.safetensors', 'qwen_3_06b_base.safetensors'], {}],
          },
        },
      },
    }),
  })
  const comfy = createComfyRuntime({
    ctx: { fs },
    pluginConfig: { comfyui: { enabled: true, autoDetect: false, installRoot: install, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: fake.fetchImpl,
  })
  const result = await listModelsSpec(comfy).execute({ category: 'text_encoders', limit: 20 }, {})

  assert.equal(result.total, 3, JSON.stringify(result.diagnostics))
  // 别名目录里的两个文件要按"相对分类目录的路径"参与对账，否则永远对不上裸文件名。
  for (const entry of result.entries) {
    assert.equal(entry.states.runtime_visible, 'true', entry.relative_path)
    assert.equal(entry.states.loader_selectable, 'true', entry.relative_path)
    assert.equal(entry.states.disk_present, 'true')
  }
  // 修复前这里会多出两条"磁盘不存在"的虚拟项，指向同一批文件。
  assert.deepEqual(result.virtual_entries, [])
  assert.equal(result.virtual_total, 0)
  await comfy.dispose()
})

test('unet 别名目录同理，diffusion_models 不再把磁盘文件当虚拟项', async () => {
  const install = 'C:\\ComfyUI'
  const fs = createMemoryFs({
    tree: modelsTree(install, {
      'unet/flux1-dev-fp8.safetensors': 100,
      'diffusion_models/moss_image_base_bf16.safetensors': 100,
    }),
  })
  const fake = createFakeFetch({
    '/models': () => ['diffusion_models'],
    '/models/diffusion_models': () => ['flux1-dev-fp8.safetensors', 'moss_image_base_bf16.safetensors'],
    '/object_info/UNETLoader': () => ({
      UNETLoader: {
        input: {
          required: { unet_name: [['flux1-dev-fp8.safetensors', 'moss_image_base_bf16.safetensors'], {}] },
        },
      },
    }),
  })
  const comfy = createComfyRuntime({
    ctx: { fs },
    pluginConfig: { comfyui: { enabled: true, autoDetect: false, installRoot: install, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: fake.fetchImpl,
  })
  const result = await listModelsSpec(comfy).execute({ category: 'diffusion_models', limit: 20 }, {})

  assert.equal(result.total, 2)
  assert.deepEqual(
    result.entries.map((entry) => [entry.name, entry.states.runtime_visible]).sort(),
    [
      ['flux1-dev-fp8.safetensors', 'true'],
      ['moss_image_base_bf16.safetensors', 'true'],
    ],
  )
  assert.deepEqual(result.virtual_entries, [])
  await comfy.dispose()
})

test('别名反查只认 CATEGORY_ALIASES 这一张表，正查反查结论一致', () => {
  for (const [alias, canonical] of Object.entries(CATEGORY_ALIASES)) {
    assert.equal(canonicalCategory(alias), canonical)
    const names = categoryNames(canonical)
    assert.ok(names.includes(alias), `${canonical} 没反查到 ${alias}`)
    assert.ok(names.includes(canonical))
    // 拿别名去反查，结果要和拿规范名反查完全一样：两个入口指向同一张表。
    assert.deepEqual([...categoryNames(alias)].sort(), [...names].sort())
  }
  // 没有别名的分类只回自己，不凭空造出第二个名字。
  assert.deepEqual(categoryNames('checkpoints'), ['checkpoints'])
  assert.deepEqual(categoryNames(''), [])
})

test('没有 loader 映射的分类照样扫描，loader_selectable 停在 unknown 而不是 false', async () => {
  const install = 'C:\\ComfyUI'
  const fs = createMemoryFs({ tree: modelsTree(install, { 'embeddings/foo.pt': 100 }) })
  const fake = createFakeFetch({
    '/models': () => ['embeddings'],
    '/models/embeddings': () => ['foo.pt'],
  })
  const comfy = createComfyRuntime({
    ctx: { fs },
    pluginConfig: { comfyui: { enabled: true, autoDetect: false, installRoot: install, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: fake.fetchImpl,
  })
  const result = await listModelsSpec(comfy).execute({ category: 'embeddings', limit: 20 }, {})

  assert.equal(result.total, 1)
  assert.equal(result.entries[0].states.runtime_visible, 'true')
  // 没有映射的分类算不出"能不能选"，只能停在 unknown——问不问别的节点是另一回事。
  assert.equal(result.entries[0].states.loader_selectable, 'unknown')
  const summary = result.category_summary.find((item) => item.category === 'embeddings')
  assert.equal(summary.has_loader, false)
  assert.equal(summary.runtime_files, 1)
  // 问过的节点必须全部来自映射表，不能为了 embeddings 临时编一个 loader 出来。
  const mapped = new Set(Object.values(CATEGORY_LOADERS).map((item) => item.node))
  const asked = fake.calls.filter((call) => call.pathname.startsWith('/object_info/'))
  assert.ok(asked.length > 0)
  for (const call of asked) {
    const node = call.pathname.slice('/object_info/'.length)
    assert.ok(mapped.has(node), `问了映射表里没有的节点 ${node}`)
  }
  await comfy.dispose()
})

test('空分类目录仍然出现在分类列表里，文件数为零', async () => {
  const install = 'C:\\ComfyUI'
  const fs = createMemoryFs({ tree: modelsTree(install, {}, ['kgen', 'checkpoints']) })
  const fake = createFakeFetch({
    '/models': () => ['checkpoints'],
    '/models/checkpoints': () => [],
  })
  const comfy = createComfyRuntime({
    ctx: { fs },
    pluginConfig: { comfyui: { enabled: true, autoDetect: false, installRoot: install, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: fake.fetchImpl,
  })
  const result = await listModelsSpec(comfy).execute({ limit: 20 }, {})

  assert.ok(result.categories.includes('kgen'))
  assert.equal(result.total, 0)
  const empty = result.category_summary.find((item) => item.category === 'kgen')
  assert.equal(empty.disk_files, 0)
  assert.equal(empty.empty, true)
  // 磁盘上没有、运行时也没有的目录，运行时文件数是"不知道"，不是 0。
  assert.equal(empty.runtime_files, null)
  await comfy.dispose()
})

test('多层子目录里的模型按相对分类目录的路径对账', async () => {
  const install = 'C:\\ComfyUI'
  const fs = createMemoryFs({ tree: modelsTree(install, { 'diffusion_models/moss/moss_image_base_bf16.safetensors': 100 }) })
  const fake = createFakeFetch({
    '/models': () => ['diffusion_models'],
    // 真实实例给的是带反斜杠的相对路径，不是裸文件名。
    '/models/diffusion_models': () => ['moss\\moss_image_base_bf16.safetensors'],
    '/object_info/UNETLoader': () => ({
      UNETLoader: {
        input: { required: { unet_name: [['moss\\moss_image_base_bf16.safetensors'], {}] } },
      },
    }),
  })
  const comfy = createComfyRuntime({
    ctx: { fs },
    pluginConfig: { comfyui: { enabled: true, autoDetect: false, installRoot: install, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: fake.fetchImpl,
  })
  const result = await listModelsSpec(comfy).execute({ category: 'diffusion_models', limit: 20 }, {})

  assert.equal(result.total, 1)
  assert.equal(result.entries[0].states.runtime_visible, 'true')
  assert.equal(result.entries[0].states.loader_selectable, 'true')
  await comfy.dispose()
})

test('未知分类不猜 loader，四态里只有磁盘那条是确定的', async () => {
  const install = 'C:\\ComfyUI'
  const fs = createMemoryFs({ tree: modelsTree(install, { 'reactor/faces/x.onnx': 100 }) })
  const fake = createFakeFetch({
    // 运行时压根没注册这个分类：无从得知它会不会认这个文件。
    '/models': () => [],
  })
  const comfy = createComfyRuntime({
    ctx: { fs },
    pluginConfig: { comfyui: { enabled: true, autoDetect: false, installRoot: install, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: fake.fetchImpl,
  })
  const result = await listModelsSpec(comfy).execute({ category: 'reactor', limit: 20 }, {})

  assert.equal(result.total, 1)
  const states = result.entries[0].states
  assert.equal(states.disk_present, 'true')
  assert.equal(states.runtime_visible, 'unknown')
  assert.equal(states.loader_selectable, 'unknown')
  assert.equal(states.execution_success, 'unknown')
  const summary = result.category_summary.find((item) => item.category === 'reactor')
  assert.equal(summary.runtime_files, null)
  assert.equal(summary.has_loader, false)
  await comfy.dispose()
})

test('单个分类 404 只影响它自己，别的分类照常对账', async () => {
  const install = 'C:\\ComfyUI'
  const fs = createMemoryFs({
    tree: modelsTree(install, { 'checkpoints/a.safetensors': 100, 'text_encoders/b.safetensors': 100 }),
  })
  const fake = createFakeFetch({
    '/models': () => ['checkpoints', 'text_encoders'],
    // /models/checkpoints 故意不给路由：fake 会回 404，客户端记为 missing。
    '/models/text_encoders': () => ['b.safetensors'],
  })
  const comfy = createComfyRuntime({
    ctx: { fs },
    pluginConfig: { comfyui: { enabled: true, autoDetect: false, installRoot: install, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: fake.fetchImpl,
  })
  const result = await listModelsSpec(comfy).execute({ limit: 20 }, {})

  assert.equal(result.runtime_available, true)
  assert.equal(result.total, 2)
  const byName = new Map(result.entries.map((entry) => [entry.name, entry.states]))
  assert.equal(byName.get('a.safetensors').runtime_visible, 'unknown')
  assert.equal(byName.get('b.safetensors').runtime_visible, 'true')
  const summary = new Map(result.category_summary.map((item) => [item.category, item]))
  assert.equal(summary.get('checkpoints').runtime_files, null)
  assert.equal(summary.get('text_encoders').runtime_files, 1)
  // 404 是"这个分类没有"，不是错误，不该刷出 error 级诊断。
  assert.ok(!result.diagnostics.some((item) => item.severity === 'error'))
  await comfy.dispose()
})

test('API 不可达时磁盘扫描照常，运行时文件数是 null 而不是 0', async () => {
  const install = 'C:\\ComfyUI'
  const fs = createMemoryFs({ tree: modelsTree(install, { 'checkpoints/a.safetensors': 100 }) })
  const comfy = createComfyRuntime({
    ctx: { fs },
    pluginConfig: { comfyui: { enabled: true, autoDetect: false, installRoot: install, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED')
    },
  })
  const result = await listModelsSpec(comfy).execute({ limit: 20 }, {})

  assert.equal(result.runtime_available, false)
  assert.equal(result.total, 1)
  assert.equal(result.entries[0].states.runtime_visible, 'unknown')
  assert.equal(result.runtime_categories, null)
  const summary = result.category_summary.find((item) => item.category === 'checkpoints')
  // 写成 0 就等于替 ComfyUI 回答"你没有这个文件"，实际只是没连上。
  assert.equal(summary.runtime_files, null)
  assert.equal(summary.disk_files, 1)
  assert.ok(result.diagnostics.some((item) => item.error_code === COMFY_CODES.CAPABILITY_UNAVAILABLE))
  await comfy.dispose()
})

test('输出被 limit 截断时，total 仍是真实总数', async () => {
  const install = 'C:\\ComfyUI'
  const files = {}
  for (let i = 0; i < 5; i += 1) files[`checkpoints/m${i}.safetensors`] = 100
  const fs = createMemoryFs({ tree: modelsTree(install, files) })
  const fake = createFakeFetch({
    '/models': () => ['checkpoints'],
    '/models/checkpoints': () => ['m0.safetensors', 'm1.safetensors', 'm2.safetensors', 'm3.safetensors', 'm4.safetensors'],
  })
  const comfy = createComfyRuntime({
    ctx: { fs },
    pluginConfig: { comfyui: { enabled: true, autoDetect: false, installRoot: install, baseUrl: 'http://127.0.0.1:8188' } },
    logger: SILENT_LOGGER,
    fetchImpl: fake.fetchImpl,
  })
  const result = await listModelsSpec(comfy).execute({ limit: 2 }, {})

  assert.equal(result.total, 5)
  assert.equal(result.returned, 2)
  assert.equal(result.entries.length, 2)
  const summary = result.category_summary.find((item) => item.category === 'checkpoints')
  // 分类统计看的是全集，不受 limit 影响。
  assert.equal(summary.disk_files, 5)
  assert.equal(summary.runtime_files, 5)
  await comfy.dispose()
})

// ───── PL-OUTPUT-CONTRACT：对话里只留生成需要的东西 ─────

/**
 * 一份"该有的都有"的编译结果。
 *
 * 故意塞满审计字段：slots / composed / fact_ledger / fidelity / coverage / stats。
 * 这些字段真机上确实存在，只有这样才能证明它们被挡在信封外面，
 * 而不是恰好因为没人填所以没出现。
 */
function envelopeInputs(overrides = {}) {
  return {
    taskId: 'task-1',
    diagnostics: [],
    profileRequest: {
      profile: { config_id: 'illustrious', display_name: 'Illustrious' },
      entry: { schema_version: '1.0' },
      variant: null,
    },
    presetResult: { entry: { config_id: 'detail-standard', schema_version: '1.0' } },
    snapshot: { knowledgeBase: null },
    analysis: {
      ir: { image: { width: 832, height: 1216, aspect_ratio: '13:19' } },
      coverage: { ratio: 0.9 },
      stats: { reviews_run: 0 },
    },
    compiled: {
      target_profile: 'illustrious',
      detail_level: 'detail-standard',
      register: 'tag',
      prompts: { positive: 'a, b, c', description: '句子版正稿', negative: 'lowres' },
      slots: [{ id: 'subject' }],
      quality_block: { status: 'ok' },
      composed: { text: '成分句' },
      keywords: ['k'],
      keywords_detail: { k: 'v' },
      aliases: { a: 'b' },
      dropped: [{ term: 'x', reason: 'budget' }],
      stats: { tags: 3 },
      fact_ledger: { entries: [{ id: 'f1' }] },
      fidelity: { channels: [] },
      pose_control: { mode: 'none' },
    },
    knowledge: { kb: null },
    experience: null,
    include_ir: false,
    ...overrides,
  }
}

test('反推结果只留正向、反向与出图要用的信息，审计数据不再进对话', () => {
  const result = buildAnalysisEnvelope(envelopeInputs())

  assert.deepEqual(Object.keys(result.result).sort(), ['image', 'prompt_style', 'prompts', 'target_profile'])
  assert.equal(result.result.prompts.positive, 'a, b, c')
  assert.equal(result.result.prompts.negative, 'lowres')
  // 描述版不再并列返回：档案决定哪版是正稿，另一版留在 trace 里。
  assert.equal(Object.hasOwn(result.result.prompts, 'description'), false)
  assert.equal(result.result.prompt_style, 'tag')
  assert.deepEqual(result.result.image, { width: 832, height: 1216, aspect_ratio: '13:19' })
  // pose_control.mode 是 none 时不出现：没交给控制网，就没有权重可带。
  assert.equal(Object.hasOwn(result.result, 'pose_control'), false)

  const serialized = JSON.stringify(result)
  for (const key of ['slots', 'quality_block', 'composed', 'fact_ledger', 'fidelity', 'coverage', 'dropped', 'keywords', 'stats', 'plugin_version', 'detail_level', 'knowledge_base_used', 'trace']) {
    assert.equal(serialized.includes(`"${key}"`), false, `返回里还留着 ${key}`)
  }
})

test('INFO 级诊断留在 trace，只有 warning 与 error 进对话', () => {
  const base = { config_file: null, field_path: null, message: 'm', suggested_fix: null }
  const result = buildAnalysisEnvelope(
    envelopeInputs({
      diagnostics: [
        { ...base, error_code: 'PIPELINE_PREVIEW_DEMO_IR', severity: 'info' },
        { ...base, error_code: 'PIPELINE_PRESET_FALLBACK', severity: 'warning' },
      ],
    }),
  )

  assert.equal(result.diagnostics.length, 1)
  assert.equal(result.diagnostics[0].error_code, 'PIPELINE_PRESET_FALLBACK')
  assert.equal(result.status, 'ok_with_warnings')
})

test('状态仍按全量诊断判定：只有 INFO 时是 ok，有 error 时是 failed', () => {
  const base = { config_file: null, field_path: null, message: 'm', suggested_fix: null }
  const onlyInfo = buildAnalysisEnvelope(
    envelopeInputs({ diagnostics: [{ ...base, error_code: 'PIPELINE_PREVIEW_DEMO_IR', severity: 'info' }] }),
  )
  // INFO 被挡在对话外面，但"这次运行是好的"这个结论不能因此变成"有问题"。
  assert.equal(onlyInfo.diagnostics.length, 0)
  assert.equal(onlyInfo.status, 'ok')

  const withError = buildAnalysisEnvelope(
    envelopeInputs({ diagnostics: [{ ...base, error_code: 'PIPELINE_NO_PROFILE', severity: 'error' }] }),
  )
  assert.equal(withError.status, 'failed')
  assert.equal(withError.diagnostics.length, 1)
})

test('描述档档案给 prompt_style: prose，标签档给 tag', () => {
  const prose = buildAnalysisEnvelope(
    envelopeInputs({ compiled: { ...envelopeInputs().compiled, register: 'clause', prompts: { positive: '一整句自然语言。', negative: '' } } }),
  )
  assert.equal(prose.result.prompt_style, 'prose')
  assert.equal(prose.result.prompts.positive, '一整句自然语言。')
  assert.equal(prose.result.prompts.negative, '')

  const tag = buildAnalysisEnvelope(envelopeInputs())
  assert.equal(tag.result.prompt_style, 'tag')
})

test('完整 IR 只有显式要求时才跟着返回，默认不给', () => {
  const withIr = buildAnalysisEnvelope(envelopeInputs({ include_ir: true }))
  assert.deepEqual(withIr.result.ir, { image: { width: 832, height: 1216, aspect_ratio: '13:19' } })

  const withoutIr = buildAnalysisEnvelope(envelopeInputs({ include_ir: false }))
  assert.equal(Object.hasOwn(withoutIr.result, 'ir'), false)
})

test('从对话里拿掉的四段审计数据，仍然完整写进本地 trace', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-trace-'))
  const base = { config_file: null, field_path: null, message: 'm', suggested_fix: null }
  try {
    const inputs = envelopeInputs({
      taskId: 'trace-task-1',
      diagnostics: [
        { ...base, error_code: 'PIPELINE_PREVIEW_DEMO_IR', severity: 'info' },
        { ...base, error_code: 'PIPELINE_PRESET_FALLBACK', severity: 'warning' },
      ],
    })
    const summary = traceStage({
      runtime: { pluginConfig: { trace: { enabled: true, max_tasks: 10 } }, dirs: { dataDir } },
      taskId: inputs.taskId,
      analysis: inputs.analysis,
      compiled: inputs.compiled,
      profileRequest: inputs.profileRequest,
      presetResult: inputs.presetResult,
      snapshot: inputs.snapshot,
      knowledge: inputs.knowledge,
      diagnostics: inputs.diagnostics,
    })

    const dir = join(dataDir, 'traces', 'trace-task-1')
    const read = (name) => JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'))

    // 四段新留痕都在，且内容是完整的那一份，不是被裁过的。
    const audit = read(TRACE_STAGES.COMPILE_AUDIT)
    assert.equal(audit.slots.length, 1)
    assert.equal(audit.composed.text, '成分句')
    assert.equal(audit.prompts.description, '句子版正稿')
    assert.equal(read(TRACE_STAGES.FIDELITY).channels.length, 0)
    const coverage = read(TRACE_STAGES.COVERAGE)
    assert.equal(coverage.coverage.ratio, 0.9)
    assert.deepEqual(coverage.stats.compile, { tags: 3 })
    // 诊断存全量：INFO 也在，因为"没交给 Agent"不等于"没发生"。
    const diag = read(TRACE_STAGES.DIAGNOSTICS)
    assert.equal(diag.length, 2)
    assert.equal(diag[0].severity, 'info')

    assert.ok(summary.captured.includes(TRACE_STAGES.COMPILE_AUDIT))
    assert.ok(summary.captured.includes(TRACE_STAGES.DIAGNOSTICS))
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ───── ANIMA-PROFILE-MIGRATION：改名不该让已有引用失效 ─────
//
// animagine-xl-4.0 是本项目最初给 Anima 起错的名称，已迁成 anima。
// 这几项钉的是「迁移之后旧写法还能用、两份档案互不干扰、正稿形态各自正确」。

/** 用真实的 configs/ 加载一次配置仓库；dataDir 用临时目录，避免读到本机用户覆盖。 */
async function loadRealConfigStore() {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-profiles-'))
  const store = createConfigStore({ configDir: join(PACKAGE_DIR, 'configs'), dataDir, logger: null })
  const loaded = await store.get()
  return { store, loaded, dataDir }
}

test('anima 档案能加载，正向正稿走自然语言描述版', async () => {
  const { store, loaded, dataDir } = await loadRealConfigStore()
  try {
    const entry = store.getModelProfile('anima')
    assert.ok(entry, 'anima 档案没加载出来')
    assert.equal(entry.config.config_id, 'anima')
    assert.equal(entry.config.tag_standard.word_style, 'prose')

    const ir = readJson('scripts/fixtures/promptlens/baseline-ir.json')
    const compiled = await compilePrompt({ ir, profile: entry.config, includeNegative: true })
    // prose 档的正稿就是成分句本身：register 记 clause，正稿与描述版逐字相同。
    assert.equal(compiled.register, 'clause')
    assert.equal(compiled.prompts.positive, compiled.prompts.description)
    assert.ok(compiled.prompts.positive.length > 0)
    // 反向提示词仍走档案里的 negative 机制，不是空串。
    assert.ok(compiled.prompts.negative.length > 0)

    const errors = loaded.diagnostics.filter((item) => item.severity === 'error')
    assert.deepEqual(errors, [], `加载 anima 时出现 error：${errors.map((item) => item.message).join('；')}`)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('AnimaImage 与 animagine-xl-4.0 都归一为 anima，不另立档案', async () => {
  const { store, dataDir } = await loadRealConfigStore()
  try {
    const ids = store.listModelProfileIds().map((item) => item.config_id).sort()
    // 三份档案，各自一个 config_id：改名不能变成"新旧各一份"，新增模型也不能另立同义档案。
    assert.deepEqual(ids, ['anima', 'illustrious', 'moss'])

    for (const name of ['anima', 'AnimaImage', 'animagine-xl-4.0', 'ANIMAGINE-XL-4.0', 'animagine_xl_4_0']) {
      const entry = store.getModelProfile(name)
      assert.ok(entry, `${name} 没有解析到任何档案`)
      assert.equal(entry.config.config_id, 'anima', `${name} 解析到了 ${entry.config.config_id}`)
    }

    // 别名解析走的是真实的 resolveProfileRequest，不是直接查 Map。
    const resolved = resolveProfileRequest(store, { profile_id: 'AnimaImage' })
    assert.equal(resolved.entry?.config_id, 'anima')
    assert.equal(resolved.profile?.tag_standard?.word_style, 'prose')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('illustrious 仍是标签档，和 anima 互不干扰', async () => {
  const { store, dataDir } = await loadRealConfigStore()
  try {
    const ir = readJson('scripts/fixtures/promptlens/baseline-ir.json')
    const anima = store.getModelProfile('anima')
    const illustrious = store.getModelProfile('illustrious')
    assert.ok(anima && illustrious)

    const animaOut = await compilePrompt({ ir, profile: anima.config, includeNegative: true })
    const illustriousOut = await compilePrompt({ ir, profile: illustrious.config, includeNegative: true })

    assert.equal(animaOut.register, 'clause')
    assert.equal(illustriousOut.register, 'tag')
    // 标签档的正稿与描述版是两段不同的文本，不能被 prose 档带着走。
    assert.notEqual(illustriousOut.prompts.positive, illustriousOut.prompts.description)
    // 两份档案的负向词表本就不同（anima 18 条 / illustrious 11 条），
    // 如果谁读到了对方的档案，这条会立刻断。
    assert.notEqual(animaOut.prompts.negative, illustriousOut.prompts.negative)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('档案目录里没有第二份 anima，旧文件名已不在', () => {
  const files = readdirSync(join(PACKAGE_DIR, 'configs/model-profiles')).sort()
  assert.deepEqual(files, ['anima.json', 'illustrious.json', 'moss.json'])
})

// ───── 改名之后，历史记录仍然查得到 ─────
//
// 经验库里存的是编译时的 target_profile 原值。档案从 animagine-xl-4.0 改名成 anima 之后，
// 旧记录里那一列不会跟着变——所以查询必须按"这个档案用过的所有名字"去筛。

/** 造一个只含经验表的临时库，插两行：一行旧名、一行新名。 */
async function tempExperienceDb() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-exp-'))
  const handle = await openKnowledgeDatabase({ path: join(dir, 'k.sqlite3'), readonly: false, createIfMissing: true })
  const insert = (taskId, profile) => {
    handle.run(
      `INSERT INTO prompt_experiences (task_id, target_model, target_profile, detail_level, positive_prompt, config_version, created_at)
       VALUES (?, ?, ?, 'standard', 'a', 'test', '2026-11-09T00:00:00.000Z')`,
      taskId,
      profile === 'anima' ? 'Anima' : 'Animagine XL 4.0',
      profile,
    )
    const id = handle.get('SELECT id FROM prompt_experiences WHERE task_id = ?', taskId).id
    handle.run(
      "INSERT INTO experience_tags (experience_id, tag_text, role) VALUES (?, '1girl', 'subject')",
      id,
    )
  }
  insert('task-old', 'animagine-xl-4.0')
  insert('task-new', 'anima')
  return { handle, dir }
}

test('经验库按档案查询时，旧档案名与新档案名都能被筛出来', async () => {
  const { handle, dir } = await tempExperienceDb()
  try {
    // 单值语义没变：只写新名就只匹配新名。
    assert.equal(listExperiences(handle, { targetProfile: 'anima' }).length, 1)
    assert.equal(listExperiences(handle, { targetProfile: 'animagine-xl-4.0' }).length, 1)

    // 展开成一组名字之后，改名前后两条都在。
    const names = ['anima', 'animagine-xl-4.0', 'AnimaImage']
    assert.equal(listExperiences(handle, { targetProfiles: names }).length, 2)

    const stats = experienceStats(handle, { targetProfiles: names })
    assert.equal(stats.total, 2)
    assert.equal(stats.tags, 2)

    const found = searchExperiences(handle, { tags: ['1girl'], targetProfiles: names })
    assert.equal(found.length, 2)
  } finally {
    try {
      handle.close?.()
    } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})

test('manage_experiences 收到新档案名时，自动把旧名一起查', async () => {
  const { handle, dir } = await tempExperienceDb()
  try {
    const { store, dataDir } = await loadRealConfigStore()
    try {
      const runtime = {
        getKnowledgeBase: async () => ({ handle }),
        getConfigStore: async () => store,
        logger: { error() {}, warn() {}, debug() {} },
      }
      const result = await runManageExperiences(runtime, { action: 'list', target_profile: 'anima' })
      assert.equal(result.status, 'ok')
      assert.equal(result.count, 2, '按 anima 查应当同时拿到改名前的记录')

      // 档案名写成旧名，展开结果里同样包含新名。
      const legacy = await runManageExperiences(runtime, { action: 'list', target_profile: 'animagine-xl-4.0' })
      assert.equal(legacy.count, 2)

      // 不传档案时不过滤，两条都在。
      const all = await runManageExperiences(runtime, { action: 'list' })
      assert.equal(all.count, 2)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  } finally {
    try {
      handle.close?.()
    } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})

// ───────────────────── 工作流：用本地文件，不扫全盘、不替用户挑 ─────────────────────
// 这一段证明的是"检索 → 读取 → 修改 → 另存"这条链的形状。
// 内存 fs 里通过不等于本机 ComfyUI 的节点定义真的齐全，那是另一件事。

const WF_INSTALL = 'C:\\ComfyUI'
const WF_DIR = `${WF_INSTALL}/user/default/workflows`

/** 一份最小 7 节点 API Prompt，读取与修改都拿它当样本。 */
function sampleApiWorkflow() {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'waiIllustriousSDXL_v140.safetensors' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: '1girl, silver hair', clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: 'bad hands', clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 1024, batch_size: 1 } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed: 1234567890,
        steps: 24,
        cfg: 6,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1,
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'sample' } },
  }
}

/** 前端「保存」导出的那种：nodes + links，不是 API Prompt。 */
const UI_EXPORT = { version: 0.4, nodes: [{ id: 1, type: 'CheckpointLoaderSimple' }], links: [] }

function workflowTree(files) {
  const tree = installTree(WF_INSTALL)
  tree[WF_DIR] = { type: 'directory' }
  for (const [relative, body] of Object.entries(files)) {
    tree[`${WF_DIR}/${relative}`] = { type: 'file', size: 2048, text: JSON.stringify(body) }
  }
  return tree
}

function nodeInfo(required = {}, optional = {}) {
  return { input: { required, optional } }
}

/** 只覆盖首版会搭到的那九个节点类，字段形状照 /object_info 的真实嵌套。 */
const BUILD_OBJECT_INFO = {
  CheckpointLoaderSimple: nodeInfo({ ckpt_name: [['wai.safetensors'], {}] }),
  UNETLoader: nodeInfo({
    unet_name: [['flux1-dev-fp8.safetensors'], {}],
    weight_dtype: [['default', 'fp8_e4m3fn'], {}],
  }),
  CLIPLoader: nodeInfo({ clip_name: [['t5xxl_fp8.safetensors'], {}], type: [['stable_diffusion'], {}] }),
  VAELoader: nodeInfo({ vae_name: [['ae.safetensors'], {}] }),
  LoraLoader: nodeInfo({
    lora_name: [['detail.safetensors'], {}],
    strength_model: ['FLOAT', { min: -10, max: 10 }],
    strength_clip: ['FLOAT', { min: -10, max: 10 }],
    model: ['MODEL', {}],
    clip: ['CLIP', {}],
  }),
  CLIPTextEncode: nodeInfo({ text: ['STRING', {}], clip: ['CLIP', {}] }),
  EmptyLatentImage: nodeInfo({
    width: ['INT', { min: 16, max: 16384 }],
    height: ['INT', { min: 16, max: 16384 }],
    batch_size: ['INT', { min: 1, max: 64 }],
  }),
  KSampler: nodeInfo({
    seed: ['INT', { min: 0, max: 4294967295 }],
    steps: ['INT', { min: 1, max: 10000 }],
    cfg: ['FLOAT', { min: 0, max: 100 }],
    sampler_name: [['euler', 'dpmpp_2m'], {}],
    scheduler: [['normal', 'karras'], {}],
    denoise: ['FLOAT', { min: 0, max: 1 }],
    model: ['MODEL', {}],
    positive: ['CONDITIONING', {}],
    negative: ['CONDITIONING', {}],
    latent_image: ['LATENT', {}],
  }),
  VAEDecode: nodeInfo({ samples: ['LATENT', {}], vae: ['VAE', {}] }),
  SaveImage: nodeInfo({ images: ['IMAGE', {}], filename_prefix: ['STRING', {}] }),
}

function comfyWithFs(tree, extra = {}) {
  const fs = createMemoryFs({ tree })
  const comfy = createComfyRuntime({
    ctx: { fs },
    pluginConfig: { comfyui: { enabled: true, installRoot: WF_INSTALL, ...extra } },
    logger: SILENT_LOGGER,
  })
  return { fs, comfy }
}

test('本地工作流按名字检索：不带扩展名、大小写与分隔符都能认', async () => {
  const fs = createMemoryFs({
    tree: workflowTree({ 'portrait_flux.json': sampleApiWorkflow(), 'scene.json': sampleApiWorkflow() }),
  })
  const roots = workflowRoots({ installRoot: WF_INSTALL })
  const listing = await listWorkflows(fs, roots)
  assert.deepEqual(listing.items.map((item) => item.stem), ['portrait_flux', 'scene'])
  assert.equal(listing.partial, false)

  const exact = await resolveWorkflowByName(fs, roots, 'portrait_flux.json')
  assert.equal(exact.level, 'exact')

  // 用户通常不带扩展名：补上 .json 后就是同一个文件，不必让他记住后缀。
  const stem = await resolveWorkflowByName(fs, roots, 'portrait_flux')
  assert.equal(stem.level, 'exact')
  assert.equal(stem.item.relative_path, 'portrait_flux.json')

  // 连分隔符都记错时再退一步按"抹掉 - _ . 空白"比较。
  const loose = await resolveWorkflowByName(fs, roots, 'Portrait-Flux')
  assert.equal(loose.level, 'loose')
  assert.equal(loose.item.name, 'portrait_flux.json')
})

test('同名工作流有多份时报候选，绝不替用户挑一个', async () => {
  const tree = workflowTree({ 'portrait_flux.json': sampleApiWorkflow() })
  tree[`${WF_DIR}/archive`] = { type: 'directory' }
  tree[`${WF_DIR}/archive/portrait_flux.json`] = {
    type: 'file',
    size: 2048,
    text: JSON.stringify(sampleApiWorkflow()),
  }
  const fs = createMemoryFs({ tree })
  const roots = workflowRoots({ installRoot: WF_INSTALL })

  await assert.rejects(
    () => resolveWorkflowByName(fs, roots, 'portrait_flux'),
    (error) => {
      assert.equal(error.code, COMFY_CODES.BINDING_AMBIGUOUS)
      assert.equal(error.candidates.length, 2)
      assert.equal(new Set(error.candidates.map((item) => item.display_path)).size, 2)
      return true
    },
  )
})

test('找不到工作流时报可用名称，不拿别的工作流顶替', async () => {
  const fs = createMemoryFs({ tree: workflowTree({ 'portrait_flux.json': sampleApiWorkflow() }) })
  const roots = workflowRoots({ installRoot: WF_INSTALL })

  await assert.rejects(
    () => resolveWorkflowByName(fs, roots, 'nothing_here'),
    (error) => {
      assert.equal(error.code, COMFY_CODES.PATH_MISSING)
      assert.deepEqual(error.available, ['portrait_flux.json'])
      assert.match(error.message, /没有找到名为 nothing_here/)
      return true
    },
  )
})

test('comfyui_list_workflows 只回名字与大小，不回工作流内容', async () => {
  const { comfy } = comfyWithFs(
    workflowTree({ 'portrait_flux.json': sampleApiWorkflow(), 'scene.json': sampleApiWorkflow() }),
  )
  const specs = createComfyToolSpecs({ getComfyUI: async () => comfy, logger: SILENT_LOGGER })
  const list = specs.find((item) => item.name === 'comfyui_list_workflows')

  const all = await list.execute({}, {})
  assert.equal(all.total, 2)
  assert.equal(all.returned, 2)
  assert.deepEqual(all.workflows.map((item) => item.name), ['portrait_flux.json', 'scene.json'])
  const text = JSON.stringify(all)
  assert.equal(text.includes('class_type'), false, '列表不该带工作流内容')
  assert.equal(text.includes('waiIllustriousSDXL'), false)

  const filtered = await list.execute({ query: 'portrait_flux' }, {})
  assert.equal(filtered.total, 2)
  assert.equal(filtered.returned, 1)
  assert.equal(filtered.match_level, 'exact')
  await comfy.dispose()
})

test('UI 格式的工作流能读能看，但不转换；拿它去改或去提交会被明确拒绝', async () => {
  const { comfy, fs } = comfyWithFs(workflowTree({ 'ui_export.json': UI_EXPORT }))
  const specs = createComfyToolSpecs({ getComfyUI: async () => comfy, logger: SILENT_LOGGER })
  const inspect = specs.find((item) => item.name === 'comfyui_inspect_workflow')
  const plan = specs.find((item) => item.name === 'comfyui_plan_workflow_patch')

  // 只读检查如实告诉调用方"这是 UI 格式、不能转换"，而不是假装它是 API Prompt。
  const report = await inspect.execute({ workflow_name: 'ui_export' }, {})
  assert.equal(report.format, 'ui')
  assert.equal(report.convertible, false)
  assert.equal(report.node_count, 1)
  assert.match(report.note, /不转换/)

  // 真要动手时就必须失败，绝不能拿 UI 格式去当 API Prompt 提交。
  const refused = await plan.execute(
    { workflow_name: 'ui_export', changes: [{ role: 'checkpoint', value: 'x.safetensors' }] },
    {},
  )
  assert.equal(refused.status, 'failed')
  assert.equal(refused.diagnostics[0].error_code, COMFY_CODES.WORKFLOW_FORMAT_UNSUPPORTED)
  assert.match(refused.diagnostics[0].message, /UI Workflow/)
  // 拒绝就是拒绝：没有偷偷写出转换后的文件。
  assert.equal(fs.writes.length, 0)
  await comfy.dispose()
})

test('语义角色能把"换模型、改采样参数"翻成具体节点上的具体字段', () => {
  const prompt = sampleApiWorkflow()
  const resolved = resolveSemanticChanges(prompt, [
    { role: 'checkpoint', value: 'other.safetensors' },
    { role: 'sampler', field: 'steps', value: 30 },
    { role: 'latent', field: 'width', value: 1024 },
    { role: 'positive', value: 'black hair' },
  ])

  assert.deepEqual(
    resolved.map((item) => [item.node_id, item.field, item.value]),
    [
      ['1', 'ckpt_name', 'other.safetensors'],
      ['5', 'steps', 30],
      ['4', 'width', 1024],
      ['2', 'text', 'black hair'],
    ],
  )
  // 解析只算出一份改动清单，原工作流一个字段都没被就地改写。
  assert.equal(prompt['1'].inputs.ckpt_name, 'waiIllustriousSDXL_v140.safetensors')
  assert.equal(prompt['5'].inputs.steps, 24)

  // 工作流里没有 LoRA 时，不能凭空加一个出来。
  assert.throws(
    () => resolveSemanticChanges(prompt, [{ role: 'lora', value: 'x.safetensors' }]),
    (error) => {
      assert.equal(error.code, COMFY_CODES.NODE_UNSUPPORTED)
      assert.match(error.message, /没有 lora 节点/)
      return true
    },
  )
  // 不认识的修改目标直接点名，而不是静默跳过。
  assert.throws(
    () => resolveSemanticChanges(prompt, [{ role: 'style', value: 'x' }]),
    (error) => error.code === COMFY_CODES.VALIDATION_FAILED,
  )
})

test('新建工作流两条加载路径都能过节点定义校验，缺模型直接报错', () => {
  const checkpoint = buildWorkflow({
    positive: 'a girl, silver hair',
    checkpoint: 'wai.safetensors',
    steps: 20,
    cfg: 6,
  })
  assert.equal(checkpoint.loader, 'checkpoint')
  assert.equal(checkpoint.node_count, 7)
  assert.deepEqual(classesInPrompt(checkpoint.prompt), [
    'CLIPTextEncode',
    'CheckpointLoaderSimple',
    'EmptyLatentImage',
    'KSampler',
    'SaveImage',
    'VAEDecode',
  ])
  const checkpointCheck = validateBuiltWorkflow({
    prompt: checkpoint.prompt,
    objectInfoByClass: BUILD_OBJECT_INFO,
  })
  assert.equal(checkpointCheck.ok, true, JSON.stringify(checkpointCheck.problems))

  const unet = buildWorkflow({
    loader: 'unet',
    positive: 'a girl',
    unet: 'flux1-dev-fp8.safetensors',
    clip: 't5xxl_fp8.safetensors',
    vae: 'ae.safetensors',
    loras: [{ name: 'detail.safetensors', strength_model: 0.6 }],
  })
  assert.equal(unet.loader, 'unet')
  assert.equal(unet.lora_count, 1)
  assert.equal(unet.node_count, 10)
  assert.equal(unet.prompt[unet.sampler_id].inputs.model[0], '4')
  const unetCheck = validateBuiltWorkflow({ prompt: unet.prompt, objectInfoByClass: BUILD_OBJECT_INFO })
  assert.equal(unetCheck.ok, true, JSON.stringify(unetCheck.problems))

  // 模型名不在枚举里就是错，不许写一个看起来能用、实际不存在的名字。
  const missing = buildWorkflow({ positive: 'a girl', checkpoint: 'not_installed.safetensors' })
  const missingCheck = validateBuiltWorkflow({ prompt: missing.prompt, objectInfoByClass: BUILD_OBJECT_INFO })
  assert.equal(missingCheck.ok, false)
  assert.equal(missingCheck.problems[0].error_code, COMFY_CODES.VALIDATION_FAILED)
  assert.match(missingCheck.problems[0].message, /枚举/)

  assert.throws(
    () => buildWorkflow({ loader: 'gguf', positive: 'x' }),
    (error) => error.code === COMFY_CODES.NODE_UNSUPPORTED,
  )
})

test('新建工作流走运行时校验时，节点定义按类名逐项取到，不会被误判成拿不到定义', async () => {
  // 这条专门盯一个真实踩过的坑：运行时把节点定义存成 Map，校验函数按对象取键。
  // 直接拿 Map 进去查，一个都查不到，于是每个节点都被判成"拿不到节点定义"，
  // 而 missing 又是空的——只看 missing 会以为一切正常。
  const routes = {}
  for (const [classType, entry] of Object.entries(BUILD_OBJECT_INFO)) {
    routes[`/object_info/${classType}`] = () => ({ [classType]: entry })
  }
  const { fetchImpl, calls } = createFakeFetch(routes)
  const comfy = createComfyRuntime({
    ctx: { fs: createMemoryFs({ tree: workflowTree({}) }) },
    pluginConfig: { comfyui: { enabled: true, installRoot: WF_INSTALL } },
    logger: SILENT_LOGGER,
    fetchImpl,
  })

  const built = await comfy.buildLocalWorkflow({
    positive: 'a girl, silver hair',
    checkpoint: 'wai.safetensors',
    steps: 20,
    cfg: 6,
  })
  assert.equal(built.validation.ok, true, JSON.stringify(built.validation.problems))
  assert.deepEqual(built.validation.problems, [])
  assert.deepEqual(built.missing, [])
  // 六个节点 + UNETLoader：判断"该走哪条加载路径"要两个 Loader 的枚举同时在场，
  // checkpoint 工作流里本来没有 UNETLoader，得额外问一次。
  assert.equal(calls.length, 7)

  // 同一个实例再搭一次：节点定义全在缓存里，不该再发请求。
  const again = await comfy.buildLocalWorkflow({ positive: 'a girl', checkpoint: 'wai.safetensors' })
  assert.equal(again.validation.ok, true)
  assert.equal(calls.length, 7)

  await comfy.dispose()
})

test('节点定义按需取并缓存：负缓存也命中，refresh 才重新问', async () => {
  let clock = 0
  const cache = createObjectInfoCache({ ttlMs: 1000, now: () => clock })
  const calls = []
  const client = {
    baseUrl: 'http://127.0.0.1:8188',
    async getObjectInfoFor(classType) {
      calls.push(classType)
      return BUILD_OBJECT_INFO[classType] ?? null
    },
  }

  const first = await fetchNodeInfos({ client, cache, classTypes: ['KSampler', 'NoSuchNode'] })
  assert.equal(first.fetched, 2)
  assert.deepEqual(first.missing, ['NoSuchNode'])
  assert.equal(first.byClass.get('KSampler').input.required.steps[0], 'INT')

  const second = await fetchNodeInfos({ client, cache, classTypes: ['KSampler', 'NoSuchNode'] })
  assert.equal(second.fetched, 0, '缓存命中时不该再发请求')
  assert.deepEqual(second.missing, ['NoSuchNode'])
  assert.deepEqual(calls, ['KSampler', 'NoSuchNode'])

  // 过期之后重新问；负缓存同样过期。
  clock = 2000
  const third = await fetchNodeInfos({ client, cache, classTypes: ['KSampler', 'NoSuchNode'] })
  assert.equal(third.fetched, 2)
  assert.deepEqual(calls, ['KSampler', 'NoSuchNode', 'KSampler', 'NoSuchNode'])

  // 显式 refresh 跳过缓存，哪怕还没过期。
  await fetchNodeInfos({ client, cache, classTypes: ['KSampler'], refresh: true })
  assert.equal(calls.filter((item) => item === 'KSampler').length, 3)
})

test('另存工作流只新建不覆盖，文件名带路径分隔符会被拒', async () => {
  const { comfy, fs } = comfyWithFs(workflowTree({ 'portrait_flux.json': sampleApiWorkflow() }))

  const saved = await comfy.saveLocalWorkflow({ workflow: sampleApiWorkflow(), name: 'my_flux' })
  assert.equal(saved.saved, true)
  assert.equal(saved.name, 'my_flux.json')
  assert.equal(saved.node_count, 7)
  assert.equal(fs.writes.length, 1)
  assert.equal(fs.writes[0].expected.kind, 'createIfAbsent')
  assert.equal(JSON.parse(fs.writes[0].content)['5'].inputs.steps, 24)

  await assert.rejects(
    () => comfy.saveLocalWorkflow({ workflow: sampleApiWorkflow(), name: 'my_flux' }),
    (error) => {
      assert.equal(error.code, COMFY_CODES.VALIDATION_FAILED)
      assert.match(error.message, /不覆盖/)
      return true
    },
  )
  await assert.rejects(
    () => comfy.saveLocalWorkflow({ workflow: sampleApiWorkflow(), name: '../escape' }),
    (error) => {
      assert.equal(error.code, COMFY_CODES.VALIDATION_FAILED)
      assert.match(error.message, /路径分隔符/)
      return true
    },
  )
  // 两次失败都没有产生新的写入，原始工作流也没被就地改写。
  assert.equal(fs.writes.length, 1)
  assert.equal(JSON.parse(fs.writes[0].content)['1'].inputs.ckpt_name, 'waiIllustriousSDXL_v140.safetensors')
  await comfy.dispose()
})


// ───── 工作流路由：目录跟实例走、builder 要授权、模型按 Loader 归位 ─────

test('工作流目录跟着当前实例的启动参数推导，不写死任何一台机器的路径', () => {
  // --user-directory 是绝对路径覆盖，直接换掉 <base>/user。
  const byUser = workflowUserRoot({
    installRoot: 'D:\\ComfyUI',
    launch: { user_directory: 'E:\\comfy-user', base_directory: 'D:\\base', multi_user: false },
  })
  assert.equal(byUser.path, 'E:\\comfy-user')
  assert.equal(byUser.source, 'arg_user_directory')

  // --base-directory 换的是 <base>，user 跟着走。
  const byBase = workflowUserRoot({ installRoot: 'D:\\ComfyUI', launch: { base_directory: 'F:\\shared' } })
  assert.equal(byBase.path, 'F:\\shared\\user')
  assert.equal(byBase.source, 'arg_base_directory')

  // 两个都没有才退回安装根——这一步不碰磁盘，也不去找别的盘。
  const byInstall = workflowUserRoot({ installRoot: 'D:\\ComfyUI' })
  assert.equal(byInstall.path, 'D:\\ComfyUI\\user')
  assert.equal(byInstall.source, 'install_root')

  // 相对路径不当覆盖用：它的含义取决于进程 cwd，猜不得。
  assert.equal(isAbsolutePath('user'), false)
  assert.equal(isAbsolutePath('D:\\user'), true)
  assert.equal(isAbsolutePath('\\\\nas\\share'), true)
  assert.equal(isAbsolutePath('/home/u'), true)
  assert.equal(
    workflowUserRoot({ installRoot: 'D:\\ComfyUI', launch: { user_directory: 'user' } }).source,
    'install_root',
  )
})

test('主根是当前用户目录下的 workflows，老整合包目录只当次要根', () => {
  const roots = workflowRoots({
    installRoot: 'D:\\ComfyUI',
    launch: { base_directory: 'E:\\data' },
    userId: 'alice',
    workflowDirs: ['E:\\data\\user\\alice\\workflows', 'G:\\extra\\'],
  })
  assert.equal(roots.length, 3)
  assert.equal(roots[0].path, 'E:\\data\\user\\alice\\workflows')
  assert.equal(roots[0].primary, true)
  assert.equal(roots[0].source, 'arg_base_directory')
  assert.equal(roots[0].user_id, 'alice')
  assert.equal(roots[1].path, 'D:\\ComfyUI\\workflows')
  assert.equal(roots[1].source, 'install-legacy')
  assert.equal(roots[1].primary, false)
  // 配置里重复登记了主根，不该出现第二遍；只留真正额外的那个。
  assert.equal(roots[2].path, 'G:\\extra')
  assert.equal(roots[2].source, 'config')

  // 没给 userId 时按单用户环境的 default 走。
  const single = workflowRoots({ installRoot: 'D:\\ComfyUI' })
  assert.equal(single[0].path, 'D:\\ComfyUI\\user\\default\\workflows')
  assert.equal(single[0].user_id, 'default')
})

test('多用户环境要认出实际用户，认不出就报歧义而不是假定 default', async () => {
  const root = 'E:\\comfy-user'
  const many = createMemoryFs({
    tree: {
      [root]: { type: 'directory' },
      [`${root}\\alice`]: { type: 'directory' },
      [`${root}\\bob`]: { type: 'directory' },
      // 系统用户（__ 前缀）走内部通道，不该被当成可选用户。
      [`${root}\\__system__`]: { type: 'directory' },
      [`${root}\\notes.txt`]: { type: 'file', size: 12 },
    },
  })
  const ambiguous = await detectActiveUser(many, root)
  assert.equal(ambiguous.ambiguous, true)
  assert.deepEqual(ambiguous.candidates, ['alice', 'bob'])

  // 只有一个用户时不用问。
  const one = createMemoryFs({
    tree: { [root]: { type: 'directory' }, [`${root}\\alice`]: { type: 'directory' } },
  })
  assert.equal((await detectActiveUser(one, root)).user_id, 'alice')

  // 有 default 就用 default：单用户装出来的目录就长这样。
  const withDefault = createMemoryFs({
    tree: {
      [root]: { type: 'directory' },
      [`${root}\\default`]: { type: 'directory' },
      [`${root}\\alice`]: { type: 'directory' },
    },
  })
  assert.equal((await detectActiveUser(withDefault, root)).user_id, 'default')

  // 一个用户目录都没有时不报错，退回 default。
  const empty = createMemoryFs({ tree: { [root]: { type: 'directory' } } })
  assert.equal((await detectActiveUser(empty, root)).user_id, 'default')
})

test('模型该用哪个 Loader 看枚举与目录，不看文件名里写了什么', () => {
  const enums = {
    checkpoint: ['waiIllustriousSDXL_v140.safetensors'],
    unet: ['flux1-dev-fp8.safetensors', 'moss\\anima_fp8.safetensors'],
  }

  // 磁盘分类说它在 checkpoints，枚举说它在 unet：以 ComfyUI 自己的枚举为准。
  const byEnum = resolveModelArchitecture({
    model: 'flux1-dev-fp8.safetensors',
    category: 'checkpoints',
    loaderEnums: enums,
  })
  assert.equal(byEnum.architecture, 'unet')
  assert.equal(byEnum.node, 'UNETLoader')
  assert.equal(byEnum.evidence, 'loader_enum')

  // 名字里带 anima 但枚举说它在 checkpoints 里——照枚举，不照名字。
  const named = resolveModelArchitecture({
    model: 'waiIllustriousSDXL_v140.safetensors',
    category: null,
    loaderEnums: enums,
  })
  assert.equal(named.architecture, 'checkpoint')
  assert.equal(named.node, 'CheckpointLoaderSimple')

  // 子目录前缀的反斜杠与正斜杠是同一个文件。
  const subdir = resolveModelArchitecture({ model: 'moss/anima_fp8.safetensors', loaderEnums: enums })
  assert.equal(subdir.architecture, 'unet')

  // 两个枚举里都有：不猜，把两条都当候选。
  const both = resolveModelArchitecture({
    model: 'same.safetensors',
    loaderEnums: { checkpoint: ['same.safetensors'], unet: ['same.safetensors'] },
  })
  assert.equal(both.architecture, null)
  assert.equal(both.evidence, 'ambiguous')

  // 枚举里没有，但磁盘分类明确：给架构，同时把依据标弱。
  const byDisk = resolveModelArchitecture({ model: 'x.safetensors', category: 'diffusion_models', loaderEnums: {} })
  assert.equal(byDisk.architecture, 'unet')
  assert.equal(byDisk.evidence, 'disk_category')

  // 什么依据都没有就是不知道。
  const unknown = resolveModelArchitecture({ model: 'x.safetensors' })
  assert.equal(unknown.architecture, null)
  assert.equal(unknown.evidence, 'unknown')

  assert.equal(architectureInPrompt({ 1: { class_type: 'CheckpointLoaderSimple' } }), 'checkpoint')
  assert.equal(architectureInPrompt({ 1: { class_type: 'UNETLoader' } }), 'unet')
  assert.equal(
    architectureInPrompt({ 1: { class_type: 'UNETLoader' }, 2: { class_type: 'CheckpointLoaderSimple' } }),
    'mixed',
  )
  assert.equal(architectureInPrompt({}), null)
})

test('默认工作流目录不存在时只报不存在，不换到别的盘去找', async () => {
  // 只有安装根，user 目录一个都没有：这是整合包没跑过的常态，不是错误。
  const fs = createMemoryFs({ tree: installTree(WF_INSTALL) })
  const roots = workflowRoots({ installRoot: WF_INSTALL })
  const listing = await listWorkflows(fs, roots)

  assert.deepEqual(listing.items, [])
  assert.equal(listing.partial, false, '目录不存在不该算部分失败')
  assert.deepEqual(listing.diagnostics, [])
  assert.equal(listing.roots.every((root) => root.exists === false), true)
  // 没有列过任何目录，等于没去别处找。
  assert.equal(fs.stats.listCalls, 0)
})

test('工作流目录里的符号链接指到根外面时被跳过，不会跟出去', async () => {
  const tree = workflowTree({ 'portrait_flux.json': sampleApiWorkflow() })
  tree['C:/outside/secret.json'] = { type: 'file', size: 64, text: JSON.stringify(sampleApiWorkflow()) }
  const fs = createMemoryFs({
    tree,
    symlinks: { [`${WF_DIR}/escape.json`]: 'C:/outside/secret.json' },
  })

  const listing = await listWorkflows(fs, workflowRoots({ installRoot: WF_INSTALL }))
  assert.deepEqual(listing.items.map((item) => item.name), ['portrait_flux.json'])
  assert.equal(listing.partial, true)
  const escapeNote = listing.diagnostics.find((item) => item.message.includes('escape.json'))
  assert.ok(escapeNote, '越界的链接必须留下一条诊断，不能悄悄跳过')
  assert.equal(escapeNote.error_code, COMFY_CODES.SCAN_PARTIAL)
  assert.match(escapeNote.message, /根之外/)
})

test('没有用户明确授权时，新建工作流会被挡住，连参数都不往下传', async () => {
  const { comfy } = comfyWithFs(workflowTree({ 'portrait_flux.json': sampleApiWorkflow() }))
  const specs = createComfyToolSpecs({ getComfyUI: async () => comfy, logger: SILENT_LOGGER })
  const build = specs.find((item) => item.name === 'comfyui_build_workflow')

  const refused = await build.execute({ positive: '1girl, solo', checkpoint: 'wai.safetensors' }, {})
  assert.equal(refused.status, 'failed')
  assert.equal(refused.diagnostics[0].error_code, COMFY_CODES.CAPABILITY_UNAVAILABLE)
  assert.match(refused.diagnostics[0].message, /明确授权/)
  // 提示必须指向"先用本地工作流"，否则等于把人往 builder 上推。
  assert.match(refused.diagnostics[0].suggested_fix, /comfyui_list_workflows/)
  assert.match(refused.diagnostics[0].suggested_fix, /comfyui_plan_workflow_patch/)

  // 带上授权后闸门放行：这次是"缺 positive"这类真实参数错误，不再是授权问题。
  const allowed = await build.execute(
    { reason: 'user_requested_new_workflow', checkpoint: 'wai.safetensors' },
    {},
  )
  assert.equal(allowed.status, 'failed')
  assert.notEqual(allowed.diagnostics[0].error_code, COMFY_CODES.CAPABILITY_UNAVAILABLE)
  assert.match(allowed.diagnostics[0].message, /positive/)
  await comfy.dispose()
})

test('从本地工作流改到提交：提交的是改过的副本，只发一次 POST', async () => {
  const original = sampleApiWorkflow()
  const posted = []
  // 枚举里得真有这个模型；换成枚举外的名字，校验本来就该拒，那是另一条用例。
  const objectInfo = {
    ...BUILD_OBJECT_INFO,
    CheckpointLoaderSimple: nodeInfo({ ckpt_name: [['waiIllustriousSDXL_v140.safetensors'], {}] }),
  }
  const routes = {}
  for (const [classType, info] of Object.entries(objectInfo)) {
    routes[`/object_info/${classType}`] = () => ({ [classType]: info })
  }
  routes['/prompt'] = (init) => {
    posted.push(JSON.parse(init.body))
    return { prompt_id: '4f730c70-07c9-4a74-9a31-ca563fc09beb', number: 1, node_errors: {} }
  }

  const fs = createMemoryFs({ tree: workflowTree({ 'portrait_flux.json': original }) })
  const fake = createFakeFetch(routes)
  const comfy = createComfyRuntime({
    ctx: { fs },
    pluginConfig: { comfyui: { enabled: true, installRoot: WF_INSTALL } },
    logger: SILENT_LOGGER,
    fetchImpl: fake.fetchImpl,
  })
  const specs = createComfyToolSpecs({ getComfyUI: async () => comfy, logger: SILENT_LOGGER })
  const plan = specs.find((item) => item.name === 'comfyui_plan_workflow_patch')
  const submit = specs.find((item) => item.name === 'comfyui_submit_workflow')

  const planResult = await plan.execute(
    {
      workflow_name: 'portrait_flux',
      changes: [
        { role: 'checkpoint', value: 'waiIllustriousSDXL_v140.safetensors' },
        { role: 'sampler', field: 'steps', value: 30 },
      ],
    },
    {},
  )
  assert.equal(planResult.changed_nodes.length, 2)
  assert.equal(planResult.prompt['1'].inputs.ckpt_name, 'waiIllustriousSDXL_v140.safetensors')
  assert.equal(planResult.prompt['5'].inputs.steps, 30)

  const submitResult = await submit.execute({ workflow: planResult.prompt }, {})
  assert.equal(submitResult.state, 'accepted')
  assert.equal(submitResult.prompt_id, '4f730c70-07c9-4a74-9a31-ca563fc09beb')

  // 只发一次 POST：一次任务就是一次。
  const posts = fake.calls.filter((call) => call.method === 'POST')
  assert.equal(posts.length, 1)
  assert.equal(posted.length, 1)
  // 发出去的就是改过的那份，逐字段一致，不是原文件、也不是新建的图。
  assert.deepEqual(posted[0].prompt, planResult.prompt)
  assert.deepEqual(Object.keys(posted[0].prompt), Object.keys(original))
  assert.equal(posted[0].prompt['5'].inputs.seed, 1234567890, '没让人改的 seed 必须原样留着')
  assert.equal(posted[0].prompt['2'].inputs.text, original['2'].inputs.text)
  // 本地文件没被改写，也没有多出一份新建的工作流。
  assert.equal(fs.writes.length, 0)
  assert.equal(JSON.parse(await fs.readText(await fs.resolve(`${WF_DIR}/portrait_flux.json`)))['1'].inputs.ckpt_name,
    'waiIllustriousSDXL_v140.safetensors')
  await comfy.dispose()
})

test('模型该走哪条加载路径看 Loader 枚举：diffusion_models 的文件名塞进 ckpt_name 会被指出来', async () => {
  const routes = {}
  for (const [classType, entry] of Object.entries(BUILD_OBJECT_INFO)) {
    routes[`/object_info/${classType}`] = () => ({ [classType]: entry })
  }
  const { fetchImpl } = createFakeFetch(routes)
  const comfy = createComfyRuntime({
    ctx: { fs: createMemoryFs({ tree: workflowTree({}) }) },
    pluginConfig: { comfyui: { enabled: true, installRoot: WF_INSTALL } },
    logger: SILENT_LOGGER,
    fetchImpl,
  })

  // 把它当 checkpoint 用：校验该拒，而且要说清它其实属于 unet 那条路径。
  const wrong = await comfy.buildLocalWorkflow({ positive: 'a girl', checkpoint: 'flux1-dev-fp8.safetensors' })
  assert.equal(wrong.validation.ok, false)
  assert.equal(wrong.loader_check.used_loader, 'checkpoint')
  assert.equal(wrong.loader_check.expected_loader, 'unet')
  assert.equal(wrong.loader_check.evidence, 'loader_enum')
  assert.equal(wrong.loader_check.mismatch, true)

  // 换成它自己的路径：模型名一字不改，只换 Loader，校验就过。
  const right = await comfy.buildLocalWorkflow({
    loader: 'unet',
    unet: 'flux1-dev-fp8.safetensors',
    clip: 't5xxl_fp8.safetensors',
    vae: 'ae.safetensors',
    positive: 'a girl',
  })
  assert.equal(right.validation.ok, true, JSON.stringify(right.validation.problems))
  assert.equal(right.loader, 'unet')
  assert.equal(right.prompt['1'].class_type, 'UNETLoader')
  assert.equal(right.loader_check.expected_loader, 'unet')
  assert.equal(right.loader_check.mismatch, false)
  await comfy.dispose()
})

// ───── MOSS-IMAGE：第三档写法，从同一份 IR 编译 Caption ─────
//
// MOSS 官方要的是「对最终画面内容的连贯描述」：主体、外观、动作、空间关系、
// 构图、环境、光照按语义顺序写进一段话。它既不是 Anima 那种把标签串成句子的
// prose，也不是 Illustrious 的标签流——三档都从同一份 IR 出发各自编译，
// 谁也不翻译谁的成品。这一组钉的是路由、写法形态、事实保留与负向的短。

/** 用真实 configs/ 取一份 moss 档案；dataDir 走临时目录，不读本机用户覆盖。 */
async function loadMossProfile() {
  const { store, loaded, dataDir } = await loadRealConfigStore()
  return { store, loaded, dataDir, moss: store.getModelProfile('moss') }
}

test('moss 档案能加载，写法是 caption，加载诊断里没有 error', async () => {
  const { moss, loaded, dataDir } = await loadMossProfile()
  try {
    assert.ok(moss, 'moss 档案没有加载出来')
    assert.equal(moss.config.config_id, 'moss')
    assert.equal(moss.config.tag_standard.word_style, 'caption')
    // 负向就是官方那四条，不是 Illustrious 的几十条。
    assert.deepEqual(moss.config.tag_standard.negative.terms, [...MOSS_NEGATIVE_BASE])
    assert.equal(moss.config.tag_standard.negative.max_terms, 6)

    const errors = loaded.diagnostics.filter((item) => item.severity === 'error')
    assert.deepEqual(errors, [], `加载 moss 时出现 error：${errors.map((item) => item.message).join('；')}`)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('moss-image-base 与 MOSS-Image-SFT 都归一为 moss，不会落到 illustrious', async () => {
  const { store, dataDir } = await loadMossProfile()
  try {
    for (const name of ['moss', 'MOSS-Image', 'moss-image-base', 'moss-image-sft', 'openmoss', 'MOSS_IMAGE']) {
      const entry = store.getModelProfile(name)
      assert.ok(entry, `${name} 没有解析到任何档案`)
      assert.equal(entry.config.config_id, 'moss', `${name} 解析到了 ${entry.config.config_id}`)
    }
    // 走真实解析入口，确认写法也一起跟过来。
    const resolved = resolveProfileRequest(store, { profile_id: 'MOSS-Image-SFT' })
    assert.equal(resolved.profile?.tag_standard?.word_style, 'caption')
    assert.notEqual(resolved.profile?.config_id, 'illustrious')
    assert.deepEqual(resolved.diagnostics.filter((item) => item.severity === 'error'), [])
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('moss 只从 IR 编译：不传知识库也能出 Caption，register 是 caption', async () => {
  const { moss, dataDir } = await loadMossProfile()
  try {
    const ir = readJson('scripts/fixtures/promptlens/baseline-ir.json')
    // kb: null 是有意的：Caption 不需要查标签词库，也不需要再调一次视觉模型。
    const out = await compilePrompt({ ir, profile: moss.config, kb: null })

    assert.equal(out.register, 'caption')
    assert.ok(out.prompts.positive.length > 0)
    assert.equal(out.caption?.text, out.prompts.positive)
    // Caption 就是正稿本身，不再并列一份「成分句」让下游分不清。
    assert.equal(out.prompts.description, out.prompts.positive)
    assert.equal(out.stats.caption_chars, out.caption.text.length)
    assert.equal(out.stats.caption_sentences, out.caption.stats.sentences)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('同一份 IR 在 anima / illustrious / moss 三档编译成三种不同写法', async () => {
  const { store, dataDir } = await loadMossProfile()
  try {
    const ir = readJson('scripts/fixtures/promptlens/baseline-ir.json')
    const outs = {}
    for (const id of ['anima', 'illustrious', 'moss']) {
      const entry = store.getModelProfile(id)
      assert.ok(entry, `${id} 档案缺失`)
      outs[id] = await compilePrompt({ ir, profile: entry.config, kb: null })
    }

    assert.equal(outs.anima.register, 'clause')
    assert.equal(outs.illustrious.register, 'tag')
    assert.equal(outs.moss.register, 'caption')

    const positives = new Set([outs.anima, outs.illustrious, outs.moss].map((out) => out.prompts.positive))
    assert.equal(positives.size, 3, '三档正稿不能有两档是同一段文本')
    // Caption 不是标签流：逗号密度必须明显低于标签档。
    assert.ok(
      outs.moss.prompts.positive.split(',').length < outs.illustrious.prompts.positive.split(',').length,
      'moss 正稿看起来还是逗号标签流',
    )
    // 也不复用 Anima 的成分句。
    assert.notEqual(outs.moss.prompts.positive, outs.anima.prompts.positive)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('moss 正稿是连贯描述：有主语、成句、不带质量词与标签开头', async () => {
  const { moss, dataDir } = await loadMossProfile()
  try {
    const ir = readJson('scripts/fixtures/promptlens/baseline-ir.json')
    const out = await compilePrompt({ ir, profile: moss.config, kb: null })
    const text = out.prompts.positive

    assert.match(text, /^The image shows /)
    assert.ok(text.split(/\.\s/).length >= 5, `句子太少，看着不像 Caption：${text}`)
    // 质量词与评分词不进 Caption：它们不描述画面。
    assert.equal(/masterpiece|best quality|absurdres|highres|score_\d|very aesthetic/i.test(text), false)
    // 标签原样开头（1girl、long_hair）说明还在拼标签。
    assert.equal(/\b1girl\b|\d+girl/.test(text), false)
    assert.equal(text.includes('_'), false)
    // 逗号只用来分隔同一句里的并列项，不该像标签流那样每两三个词一个逗号。
    const commas = (text.match(/,/g) ?? []).length
    assert.ok(commas <= out.caption.stats.sentences * 2, `逗号 ${commas} 个，句子才 ${out.caption.stats.sentences} 句`)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('moss Caption 保留主体外观、服装与表情', async () => {
  const { moss, dataDir } = await loadMossProfile()
  try {
    const ir = readJson('scripts/fixtures/promptlens/baseline-ir.json')
    const out = await compilePrompt({ ir, profile: moss.config, kb: null })
    const text = out.prompts.positive

    assert.match(text, /silver hair/)
    assert.match(text, /red eyes/)
    assert.match(text, /white blouse/)
    assert.match(text, /slight smile/)
    // 外观跟主体在同一句里，不是各起一句把关系拆散。
    assert.match(text, /shows a girl with silver hair and red eyes/)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('moss Caption 保留姿态、肢体动作与空间关系', async () => {
  const { moss, dataDir } = await loadMossProfile()
  try {
    const ir = readJson('scripts/fixtures/promptlens/baseline-ir.json')
    const out = await compilePrompt({ ir, profile: moss.config, kb: null })
    const text = out.prompts.positive

    assert.match(text, /standing with weight on one leg/)
    assert.match(text, /left arm is raised toward the viewer/)
    // 关系不能拆成两个名词：手和伞要出现在同一句里。
    assert.match(text, /hand holds the umbrella/)
    assert.equal(text.includes('umbrella, hand'), false)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('moss Caption 保留构图、镜头、背景与光照', async () => {
  const { moss, dataDir } = await loadMossProfile()
  try {
    const ir = readJson('scripts/fixtures/promptlens/baseline-ir.json')
    const out = await compilePrompt({ ir, profile: moss.config, kb: null })
    const text = out.prompts.positive

    assert.match(text, /cowboy shot/)
    assert.match(text, /from below/)
    assert.match(text, /rainy street/)
    // 光照排在环境之后，不能因为句子预算被挤掉。
    assert.match(text, /overcast daylight/)
    assert.ok(text.indexOf('rainy street') < text.indexOf('overcast daylight'))
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('moss Caption 不补 IR 里没有的东西，依据核对全部通过', async () => {
  const { moss, dataDir } = await loadMossProfile()
  try {
    const ir = readJson('scripts/fixtures/promptlens/baseline-ir.json')
    const out = await compilePrompt({ ir, profile: moss.config, kb: null })

    assert.deepEqual(out.caption.grounding.unsupported, [])
    assert.equal(out.caption.grounding.ok, true)
    // 这几样都是「顺手写上去很像」的幻觉，必须一个都不出现。
    const text = out.prompts.positive
    for (const invented of ['blue eyes', 'pet', 'flower', 'cat', 'smile at the camera', 'soft morning light']) {
      assert.equal(text.includes(invented), false, `Caption 补了 IR 里没有的「${invented}」`)
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('moss Caption 不重复同一件事，也不重复同一句', async () => {
  const { moss, dataDir } = await loadMossProfile()
  try {
    const ir = readJson('scripts/fixtures/promptlens/baseline-ir.json')
    const out = await compilePrompt({ ir, profile: moss.config, kb: null })
    const text = out.prompts.positive

    assert.equal(text.split('silver hair').length - 1, 1, 'silver hair 说了不止一次')
    assert.equal(text.split('white blouse').length - 1, 1, 'white blouse 说了不止一次')
    const sentences = text.split(/(?<=\.)\s+/).map((line) => line.trim()).filter(Boolean)
    assert.equal(new Set(sentences).size, sentences.length, 'Caption 里有重复句')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('moss 负向默认只有官方四条，不带 Illustrious 的大串标签', async () => {
  const { store, moss, dataDir } = await loadMossProfile()
  try {
    const ir = readJson('scripts/fixtures/promptlens/baseline-ir.json')
    const out = await compilePrompt({ ir, profile: moss.config, kb: null })
    const terms = out.caption.negative.terms.map((term) => term.text)

    assert.deepEqual(terms, [...MOSS_NEGATIVE_BASE])
    assert.equal(terms.length <= 6, true)
    // 这些是 Illustrious 负向的常客，MOSS 这边一个都不该有。
    for (const tag of ['lowres', 'bad hands', 'signature', 'username', 'blurry', 'multiple girls']) {
      assert.equal(terms.includes(tag), false, `moss 负向混进了标签档的「${tag}」`)
    }

    const illustrious = await compilePrompt({ ir, profile: store.getModelProfile('illustrious').config, kb: null })
    assert.ok(out.prompts.negative.length < illustrious.prompts.negative.length)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('用户明确要求全年龄时才补 nsfw；模型自己判的 safe 不算', async () => {
  const { moss, dataDir } = await loadMossProfile()
  try {
    const base = readJson('scripts/fixtures/promptlens/baseline-ir.json')
    const withRating = (source) => ({
      ...base,
      features: [
        ...base.features,
        { category: 'quality_style', key: 'rating', value: 'safe', confidence: 0.9, importance: 0.5, source, status: 'confirmed' },
      ],
    })

    const declared = await compilePrompt({ ir: withRating('user_correction'), profile: moss.config, kb: null })
    assert.equal(declared.caption.negative.terms.some((term) => term.text === 'nsfw'), true)
    assert.ok(declared.diagnostics.some((item) => item.error_code === MOSS_CODES.NEGATIVE_SFW_ADDED))

    const judged = await compilePrompt({ ir: withRating('global_analysis'), profile: moss.config, kb: null })
    assert.equal(judged.caption.negative.terms.some((term) => term.text === 'nsfw'), false)
    assert.equal(judged.diagnostics.some((item) => item.error_code === MOSS_CODES.NEGATIVE_SFW_ADDED), false)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('画面里的文字逐字保留原语言，不翻译也不改大小写', async () => {
  const { moss, dataDir } = await loadMossProfile()
  try {
    const ir = readJson('scripts/fixtures/promptlens/baseline-ir.json')
    const withText = {
      ...ir,
      entities: [
        ...ir.entities,
        {
          entity_id: 'ent_sign',
          kind: 'object',
          label: 'shop sign',
          count: 1,
          confidence: 0.9,
          importance: 0.4,
          features: [{ category: 'text', key: 'text', value: '营业中 OPEN 24H', confidence: 0.9, importance: 0.4, status: 'confirmed' }],
        },
      ],
    }
    const out = await compilePrompt({ ir: withText, profile: moss.config, kb: null })

    assert.ok(out.prompts.positive.includes('营业中 OPEN 24H'), `原文没有逐字保留：${out.prompts.positive}`)
    assert.equal(out.prompts.positive.includes('open 24h'), false)
    // 中文观察在 describe.js 那层会被剔掉（它只写英文句子），Caption 必须绕过那层自己取原文。
    assert.ok(out.caption.clauses.some((clause) => clause.role === 'text'))
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('IR 里没有可写的事实时，moss 退回标签版并说明原因', async () => {
  const { moss, dataDir } = await loadMossProfile()
  try {
    const empty = { schema_version: '1.0', entities: [], relations: [], features: [], uncertainties: [] }
    const out = await compilePrompt({ ir: empty, profile: moss.config, kb: null })

    assert.equal(out.caption.text, '')
    assert.equal(out.register, 'tag')
    assert.equal(out.prompts.positive, '')
    assert.ok(out.diagnostics.some((item) => item.error_code === MOSS_CODES.CAPTION_EMPTY))
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('caption 档的返回仍只多一个 prompt_style 值，结果结构不变', () => {
  const envelope = buildAnalysisEnvelope(
    envelopeInputs({
      compiled: {
        ...envelopeInputs().compiled,
        register: 'caption',
        prompts: { positive: 'The image shows a girl.', description: 'The image shows a girl.', negative: 'worst quality' },
        caption: { text: 'The image shows a girl.', stats: { sentences: 1 } },
      },
    }),
  )
  assert.deepEqual(Object.keys(envelope.result).sort(), ['image', 'prompt_style', 'prompts', 'target_profile'])
  assert.equal(envelope.result.prompt_style, 'caption')
  assert.equal(envelope.result.prompts.positive, 'The image shows a girl.')
  // Caption 明细（分句、依据、丢弃事实）是分析过程，留在 trace 里；对话里只有正负向。
  assert.equal(Object.hasOwn(envelope.result, 'caption'), false)
  assert.equal(JSON.stringify(envelope).includes('"stats"'), false)
})
