
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateAgainstSchema } from './schema-validator.js'
import { deepFreeze } from './util.js'
import { CATEGORY_IDS } from './categories.js'
import { UNCERTAINTY_CODES } from './ir-schema.js'
import { SEVERITY, diagnostic } from '../diagnostics.js'
import {
  DIMENSION_ID_PATTERN,
  RULE_CODES,
  SIGNAL_ID_PATTERN,
  TYPE_CODE_PATTERN,
} from './codes.js'

export const DEFAULT_IMAGE_TYPE_DIR = fileURLToPath(new URL('../../configs/image-types/', import.meta.url))

export const ROUTER_FILE = '_router.json'
export const RULE_SCHEMA_FILE = 'rule.schema.json'

export const IMAGE_TYPE_RULE_KIND = 'image_type_rule'
export const IMAGE_TYPE_ROUTER_KIND = 'image_type_router'
export const IMAGE_TYPE_RULE_SET_KIND = 'image_type_rule_set'

async function readJson(file, relative, diagnostics) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    diagnostics.push(
      diagnostic({
        error_code: RULE_CODES.FILE_UNREADABLE,
        severity: SEVERITY.ERROR,
        config_file: relative,
        message: `规则库文件读取失败：${error?.code ?? error?.message ?? String(error)}。`,
        suggested_fix: '确认该文件存在且当前用户可读。规则库随插件发布，通常是安装不完整或被误删。',
      }),
    )
    return null
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    diagnostics.push(
      diagnostic({
        error_code: RULE_CODES.JSON_SYNTAX_ERROR,
        severity: SEVERITY.ERROR,
        config_file: relative,
        message: `规则库文件不是合法 JSON：${error.message}。`,
        suggested_fix: '检查多余逗号、注释、未转义的引号或 BOM。',
      }),
    )
    return null
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isRatio(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

export function validateRouterShape(router, { configFile = ROUTER_FILE, diagnostics = [] } = {}) {
  const before = diagnostics.length
  const fail = (field_path, message, suggested_fix) => {
    diagnostics.push(
      diagnostic({
        error_code: RULE_CODES.ROUTER_INVALID,
        severity: SEVERITY.ERROR,
        config_file: configFile,
        field_path,
        message,
        suggested_fix,
      }),
    )
  }

  if (!isPlainObject(router)) {
    fail('', '路由表必须是一个 JSON 对象。', '检查文件是否被整体替换成了数组或标量。')
    return false
  }
  if (router.kind !== IMAGE_TYPE_ROUTER_KIND) {
    fail('/kind', `kind 必须是 ${IMAGE_TYPE_ROUTER_KIND}，实际 ${String(router.kind)}。`, `把 kind 改回 ${IMAGE_TYPE_ROUTER_KIND}。`)
  }

  const selection = router.selection
  if (!isPlainObject(selection)) {
    fail('/selection', '缺少 selection 对象，判定阈值无处可取。', '补上 selection，至少含 fallback_type / min_score / min_signals。')
  } else {
    if (typeof selection.fallback_type !== 'string' || selection.fallback_type.trim() === '') {
      fail('/selection/fallback_type', 'fallback_type 必须是非空字符串。', '写兜底类型的 config_id，通常是 general。')
    }
    for (const field of ['min_score', 'secondary_threshold', 'confidence_floor']) {
      if (!isRatio(selection[field])) {
        fail(`/selection/${field}`, `${field} 必须是 0 到 1 之间的小数。`, '按分数区间给一个 0 到 1 的小数。')
      }
    }
    if (!Number.isInteger(selection.min_signals) || selection.min_signals < 0) {
      fail('/selection/min_signals', 'min_signals 必须是非负整数。', '写一个整数，例如 2。')
    }
    if (!Number.isInteger(selection.max_secondary) || selection.max_secondary < 0) {
      fail('/selection/max_secondary', 'max_secondary 必须是非负整数。', '写一个整数，例如 2。')
    }
  }

  const types = Array.isArray(router.types) ? router.types : null
  if (!types || types.length === 0) {
    fail('/types', 'types 必须是非空数组，否则没有任何类型可判定。', '至少保留兜底类型一项。')
    return diagnostics.length === before
  }

  const seenIds = new Set()
  const seenCodes = new Set()
  types.forEach((entry, index) => {
    const at = `/types/${index}`
    if (!isPlainObject(entry)) {
      fail(at, '类型条目必须是对象。', '按 types[] 的结构补 config_id / code / marker / file / priority。')
      return
    }
    if (typeof entry.config_id !== 'string' || entry.config_id.trim() === '') {
      fail(`${at}/config_id`, 'config_id 不能为空。', '写该类型规则文件的 config_id。')
    } else if (seenIds.has(entry.config_id)) {
      fail(`${at}/config_id`, `config_id ${entry.config_id} 重复。`, '每个类型只能出现一次。')
    } else {
      seenIds.add(entry.config_id)
    }
    if (typeof entry.code !== 'string' || !TYPE_CODE_PATTERN.test(entry.code)) {
      fail(`${at}/code`, `code 必须匹配 ${TYPE_CODE_PATTERN}，实际 ${String(entry.code)}。`, '按 T<0-6>-<三个大写字母> 的形式写，例如 T1-PHO。')
    } else if (seenCodes.has(entry.code)) {
      fail(`${at}/code`, `code ${entry.code} 重复。`, '编号必须全局唯一。')
    } else {
      seenCodes.add(entry.code)
    }
    if (entry.marker !== `[${entry.code}]`) {
      fail(`${at}/marker`, `marker 必须等于 [${String(entry.code)}]，实际 ${String(entry.marker)}。`, 'marker 由 code 加方括号组成，不允许手写别的写法。')
    }
    if (typeof entry.file !== 'string' || !entry.file.endsWith('.json')) {
      fail(`${at}/file`, 'file 必须是以 .json 结尾的文件名。', '写同目录下的规则文件名。')
    }
    if (!Number.isFinite(entry.priority)) {
      fail(`${at}/priority`, 'priority 必须是数字。', '给一个整数优先级，数字越大越优先。')
    }
  })

  if (typeof selection?.fallback_type === 'string') {
    const fallbackEntry = types.find((entry) => entry?.config_id === selection.fallback_type)
    if (!fallbackEntry) {
      fail('/selection/fallback_type', `fallback_type ${selection.fallback_type} 不在 types 里。`, '把兜底类型加进 types，或把 fallback_type 改成已存在的 config_id。')
    } else if (fallbackEntry.role !== 'fallback') {
      fail(`/types/${types.indexOf(fallbackEntry)}/role`, `兜底类型的 role 必须是 fallback，实际 ${String(fallbackEntry.role)}。`, '把该条目的 role 改成 fallback。')
    }
  }

  return diagnostics.length === before
}

export function crossValidateRule(rule, { entry, configFile, diagnostics = [], seenCodes = new Set(), seenSignals = new Set() } = {}) {
  const before = diagnostics.length
  const fail = (code, field_path, message, suggested_fix) => {
    diagnostics.push(
      diagnostic({ error_code: code, severity: SEVERITY.ERROR, config_file: configFile, field_path, message, suggested_fix }),
    )
  }
  const warn = (code, field_path, message, suggested_fix) => {
    diagnostics.push(
      diagnostic({ error_code: code, severity: SEVERITY.WARNING, config_file: configFile, field_path, message, suggested_fix }),
    )
  }

  if (entry) {
    for (const field of ['config_id', 'code', 'marker']) {
      if (rule?.[field] !== entry[field]) {
        fail(
          RULE_CODES.ENTRY_MISMATCH,
          `/${field}`,
          `规则文件的 ${field}（${String(rule?.[field])}）与路由表（${String(entry[field])}）不一致。`,
          '两处必须完全一致；改一处忘另一处会让判定结果和提示词里的标识对不上。',
        )
      }
    }
  }

  if (typeof rule?.code === 'string' && seenCodes.has(rule.code)) {
    fail(RULE_CODES.CODE_DUPLICATE, '/code', `类型编号 ${rule.code} 已被另一份规则文件占用。`, '每个类型编号必须唯一。')
  }
  if (typeof rule?.code === 'string') seenCodes.add(rule.code)

  const signals = Array.isArray(rule?.identification?.signals) ? rule.identification.signals : []
  const antis = Array.isArray(rule?.identification?.anti_signals) ? rule.identification.anti_signals : []
  if (signals.length === 0) {
    warn(RULE_CODES.RULE_SET_INCOMPLETE, '/identification/signals', '没有任何正向标识，这一类型永远算不出分数。', '至少给两条可观察的正向标识。')
  }
  for (const [listName, list] of [['signals', signals], ['anti_signals', antis]]) {
    list.forEach((signal, index) => {
      const at = `/identification/${listName}/${index}`
      if (typeof signal?.id !== 'string' || !SIGNAL_ID_PATTERN.test(signal.id)) {
        fail(RULE_CODES.SIGNAL_INVALID, `${at}/id`, `标识编号必须匹配 ${SIGNAL_ID_PATTERN}，实际 ${String(signal?.id)}。`, '按 T1-S1 / T1-X1 的形式写。')
        return
      }
      if (seenSignals.has(signal.id)) {
        fail(RULE_CODES.SIGNAL_DUPLICATE, `${at}/id`, `标识编号 ${signal.id} 重复出现。`, '标识编号必须全局唯一，模型回填的编号才能唯一定位到一条判据。')
      }
      seenSignals.add(signal.id)
    })
  }

  const dims = Array.isArray(rule?.dimensions) ? rule.dimensions : []
  const seenDimIds = new Set()
  const slots = new Set()
  dims.forEach((dim, index) => {
    const at = `/dimensions/${index}`
    if (typeof dim?.id !== 'string' || !DIMENSION_ID_PATTERN.test(dim.id)) {
      fail(RULE_CODES.DIMENSION_INVALID, `${at}/id`, `维度编号必须匹配 ${DIMENSION_ID_PATTERN}，实际 ${String(dim?.id)}。`, '按 D1 / D2 的形式写。')
    } else if (seenDimIds.has(dim.id)) {
      fail(RULE_CODES.DIMENSION_INVALID, `${at}/id`, `维度编号 ${dim.id} 在本文件内重复。`, '每个维度编号在本文件内唯一。')
    } else {
      seenDimIds.add(dim.id)
    }
    if (typeof dim?.ir_category !== 'string' || !CATEGORY_IDS.has(dim.ir_category)) {
      fail(RULE_CODES.UNKNOWN_CATEGORY, `${at}/ir_category`, `ir_category ${String(dim?.ir_category)} 不是已登记的内部分类。`, '取值见 configs/categories.json 的 internal_categories。')
    }
    const slot = typeof dim?.slot === 'string' ? dim.slot : ''
    const dot = slot.indexOf('.')
    if (dot <= 0 || dot === slot.length - 1) {
      fail(RULE_CODES.UNKNOWN_SLOT, `${at}/slot`, `slot 必须形如 <category>.<key>，实际 ${String(dim?.slot)}。`, '例如 camera.focal_length。')
    } else {
      const head = slot.slice(0, dot)
      if (!CATEGORY_IDS.has(head)) {
        fail(RULE_CODES.UNKNOWN_CATEGORY, `${at}/slot`, `slot 前缀 ${head} 不是已登记的内部分类。`, 'slot 的前缀必须与 ir_category 一致且已登记。')
      }
      if (dim.ir_category && head !== dim.ir_category) {
        fail(RULE_CODES.UNKNOWN_SLOT, `${at}/slot`, `slot 前缀 ${head} 与 ir_category ${dim.ir_category} 不一致。`, '两者必须一致，否则特征会被写进错误的分类。')
      }
      slots.add(slot)
    }
    if (dim?.fallback_uncertainty !== undefined && !UNCERTAINTY_CODES.includes(dim.fallback_uncertainty)) {
      fail(RULE_CODES.UNKNOWN_UNCERTAINTY_CODE, `${at}/fallback_uncertainty`, `fallback_uncertainty ${String(dim.fallback_uncertainty)} 不在 UNCERTAINTY_CODES 里。`, '取值见 configs/uncertainty-codes.json 的 uncertainty_codes。')
    }
  })

  const mustKeep = Array.isArray(rule?.compile?.must_keep) ? rule.compile.must_keep : []
  mustKeep.forEach((slot, index) => {
    if (!slots.has(slot)) {
      warn(
        RULE_CODES.MUST_KEEP_UNKNOWN,
        `/compile/must_keep/${index}`,
        `must_keep 里的 ${String(slot)} 不是本文件任何维度的 slot。`,
        'must_keep 只能引用本文件里存在的 slot；引用不存在的 slot 等于什么都没保住。',
      )
    }
  })

  const keywords = Array.isArray(rule?.keywords) ? rule.keywords : []
  keywords.forEach((keyword, index) => {
    if (!CATEGORY_IDS.has(keyword?.ir_category)) {
      fail(RULE_CODES.UNKNOWN_CATEGORY, `/keywords/${index}/ir_category`, `ir_category ${String(keyword?.ir_category)} 不是已登记的内部分类。`, '取值见 INTERNAL_CATEGORIES。')
    }
  })

  return diagnostics.length === before
}

function buildRuleSet({ router, rules, diagnostics }) {
  const byCode = {}
  const byMarker = {}
  const byConfigId = {}
  for (const rule of rules) {
    byCode[rule.code] = rule
    byMarker[rule.marker] = rule
    byConfigId[rule.config_id] = rule
  }
  const fallbackId = router?.selection?.fallback_type
  const fallback = typeof fallbackId === 'string' ? (byConfigId[fallbackId] ?? null) : null
  const ok = !diagnostics.some((item) => item.severity === SEVERITY.ERROR)

  return deepFreeze({
    schema_version: typeof router?.schema_version === 'string' ? router.schema_version : '1.0',
    kind: IMAGE_TYPE_RULE_SET_KIND,
    config_id: typeof router?.config_id === 'string' ? router.config_id : 'image-type-router',
    version: typeof router?.version === 'string' ? router.version : '0.0.0',
    selection: isPlainObject(router?.selection) ? router.selection : {},
    prompt_policy: isPlainObject(router?.prompt_policy) ? router.prompt_policy : {},
    multi_type_policy: isPlainObject(router?.multi_type_policy) ? router.multi_type_policy : {},
    decision_procedure: Array.isArray(router?.decision_procedure) ? router.decision_procedure : [],
    conflict_pairs: Array.isArray(router?.conflict_pairs) ? router.conflict_pairs : [],
    types: rules,
    byCode,
    byMarker,
    byConfigId,
    fallback,
    ok,
    diagnostics,
  })
}

export async function loadImageTypeRules({ dir = DEFAULT_IMAGE_TYPE_DIR, diagnostics: seed = [] } = {}) {
  const diagnostics = [...seed]

  try {
    const info = await stat(dir)
    if (!info.isDirectory()) throw Object.assign(new Error('不是目录'), { code: 'ENOTDIR' })
  } catch (error) {
    diagnostics.push(
      diagnostic({
        error_code: RULE_CODES.DIR_MISSING,
        severity: SEVERITY.ERROR,
        message: `规则库目录不存在或不可读：${dir}（${error?.code ?? error?.message ?? String(error)}）。`,
        suggested_fix: '确认插件安装完整（configs/image-types/ 应随包发布）；也可以关掉 vision.detect_image_type 走兜底类型。',
      }),
    )
    return buildRuleSet({ router: null, rules: [], diagnostics })
  }

  const router = await readJson(join(dir, ROUTER_FILE), ROUTER_FILE, diagnostics)
  const schema = await readJson(join(dir, RULE_SCHEMA_FILE), RULE_SCHEMA_FILE, diagnostics)
  if (!router || !schema) return buildRuleSet({ router: null, rules: [], diagnostics })

  const routerOk = validateRouterShape(router, { configFile: ROUTER_FILE, diagnostics })
  const rules = []
  const seenCodes = new Set()
  const seenSignals = new Set()

  for (const entry of Array.isArray(router.types) ? router.types : []) {
    const file = typeof entry?.file === 'string' ? entry.file : null
    if (!file) continue
    const rule = await readJson(join(dir, file), file, diagnostics)
    if (!rule) continue

    for (const problem of validateAgainstSchema(rule, schema)) {
      diagnostics.push(
        diagnostic({
          error_code: RULE_CODES.SCHEMA_INVALID,
          severity: SEVERITY.ERROR,
          config_file: file,
          field_path: problem.field_path,
          message: problem.message,
          suggested_fix: `对照 ${RULE_SCHEMA_FILE} 修正该字段。`,
        }),
      )
    }

    crossValidateRule(rule, { entry, configFile: file, diagnostics, seenCodes, seenSignals })
    rules.push({
      ...rule,
      role: entry.role ?? 'primary',
      priority: Number.isFinite(entry.priority) ? entry.priority : 0,
      summary: typeof entry.summary === 'string' ? entry.summary : '',
      file,
    })
  }

  if (routerOk && rules.length === 0) {
    diagnostics.push(
      diagnostic({
        error_code: RULE_CODES.RULE_SET_INCOMPLETE,
        severity: SEVERITY.ERROR,
        config_file: ROUTER_FILE,
        field_path: '/types',
        message: '路由表声明了类型，但没有任何一份规则文件被成功加载。',
        suggested_fix: '确认 types[].file 指向的文件都在同一目录下且能被解析。',
      }),
    )
  }

  const declaredFallback = router?.selection?.fallback_type
  if (typeof declaredFallback === 'string' && !rules.some((rule) => rule.config_id === declaredFallback)) {
    diagnostics.push(
      diagnostic({
        error_code: RULE_CODES.FALLBACK_MISSING,
        severity: SEVERITY.ERROR,
        config_file: ROUTER_FILE,
        field_path: '/selection/fallback_type',
        message: `兜底类型 ${declaredFallback} 声明了但没有加载成功，判定失败时无路可退。`,
        suggested_fix: `确认 ${declaredFallback}.json 存在且通过校验，或把 fallback_type 指向另一份可用的规则。`,
      }),
    )
  }

  const known = new Set(rules.map((rule) => rule.config_id))
  ;(Array.isArray(router.conflict_pairs) ? router.conflict_pairs : []).forEach((pair, index) => {
    for (const side of ['a', 'b']) {
      if (!known.has(pair?.[side])) {
        diagnostics.push(
          diagnostic({
            error_code: RULE_CODES.CONFLICT_UNKNOWN_TYPE,
            severity: SEVERITY.WARNING,
            config_file: ROUTER_FILE,
            field_path: `/conflict_pairs/${index}/${side}`,
            message: `冲突对引用了未加载的类型 ${String(pair?.[side])}，这条约束不会生效。`,
            suggested_fix: '把该类型加进 types，或从冲突对里删掉它。',
          }),
        )
      }
    }
  })

  return buildRuleSet({ router, rules, diagnostics })
}

export function lookupType(ruleSet, ref) {
  const raw = typeof ref === 'string' ? ref.trim() : ''
  if (!raw) return null
  const bare = raw.replace(/^\[|\]$/g, '')
  return ruleSet?.byCode?.[bare] ?? ruleSet?.byMarker?.[`[${bare}]`] ?? ruleSet?.byConfigId?.[bare] ?? null
}
