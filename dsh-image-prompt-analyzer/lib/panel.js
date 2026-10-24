
import { experienceStats } from './experience/index.js'
import { SEVERITY, diagnostic, errorGroupFor } from './diagnostics.js'
import { PANEL_CODES } from './panel/codes.js'
import { createWorkbenchFiles, fetchUrlToFile, WorkbenchError } from './panel/workbench.js'

export { PANEL_CODES }

export const PANEL_SCHEMA_VERSION = '1.1'
export const PANEL_ROUTE_PREFIX = '/dsh-image-prompt-analyzer/api'

function makePanelEntry({
  taskId,
  createdAt = null,
  image = null,
  target = null,
  positive = null,
  negative = null,
  qualityPrefix = [],
  positiveTerms = [],
  negativeTerms = [],
  lowConfidence = [],
  dropped = [],
  ir = null,
  stats = null,
  knowledgeBaseUsed = false,
  savedExperienceId = null,
  warnings = [],
}) {
  return {
    task_id: taskId,
    created_at: createdAt ?? new Date().toISOString(),
    image,
    target,
    target_profile: target?.config_id ?? null,
    positive_prompt: positive,
    negative_prompt: negative,
    quality_prefix: qualityPrefix,
    positive_terms: positiveTerms,
    negative_terms: negativeTerms,
    low_confidence: lowConfidence,
    dropped,
    ir,
    stats,
    knowledge_base_used: knowledgeBaseUsed === true,
    saved_experience_id: savedExperienceId,
    warnings,
  }
}

export function createPanelStore({ maxRecentTasks = 20, logger = null } = {}) {
  const requested = Number(maxRecentTasks)
  const limit = Math.max(1, Math.min(200, Number.isFinite(requested) ? requested : 20))
  let entries = []

  return {
    record(input) {
      const entry = makePanelEntry(input ?? {})
      if (!entry.task_id) return null
      entries = [entry, ...entries.filter((item) => item.task_id !== entry.task_id)]
      if (entries.length > limit) entries = entries.slice(0, limit)
      return entry
    },
    list() {
      return entries.map((entry) => ({
        task_id: entry.task_id,
        created_at: entry.created_at,
        image: entry.image,
        target: entry.target,
        target_profile: entry.target_profile,
        positive_prompt: entry.positive_prompt,
        negative_prompt: entry.negative_prompt,
        positive_term_count: entry.positive_terms.length,
        negative_term_count: entry.negative_terms.length,
        low_confidence_count: entry.low_confidence.length,
        dropped_count: entry.dropped.length,
        knowledge_base_used: entry.knowledge_base_used,
        saved_experience_id: entry.saved_experience_id,
        warning_count: entry.warnings.length,
      }))
    },
    get(taskId) {
      return entries.find((entry) => entry.task_id === String(taskId)) ?? null
    },
    clear() {
      const removed = entries.length
      entries = []
      return removed
    },
    size() {
      return entries.length
    },
    limit() {
      return limit
    },
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function createPanelRoutes({ store, getRuntime, logger = null }) {
  const prefix = PANEL_ROUTE_PREFIX

  async function experienceStatsOrNull(runtime) {
    try {
      const knowledge = await runtime?.getKnowledgeBase?.()
      if (!knowledge?.handle) return null
      return experienceStats(knowledge.handle)
    } catch (error) {
      logger?.warn?.(`结果面板读取经验库统计失败：${error?.message ?? error}`)
      return null
    }
  }

  async function summary() {
    const runtime = typeof getRuntime === 'function' ? getRuntime() : (getRuntime ?? null)
    const snapshot = runtime?.peekConfigSnapshot?.() ?? null
    const stats = await experienceStatsOrNull(runtime)
    const byProfile = stats
      ? Object.fromEntries(stats.by_profile.map((row) => [row.target_profile ?? 'legacy', Number(row.n)]))
      : {}
    return {
      schema_version: PANEL_SCHEMA_VERSION,
      generated_at: new Date().toISOString(),
      plugin_version: runtime?.pluginVersion ?? null,
      read_only: true,
      totals: {
        tasks: store.size(),
        recent_limit: store.limit(),
        experiences: stats?.total ?? null,
        rated_experiences: stats?.rated ?? null,
      },
      by_profile: byProfile,
      recent_tasks: store.list(),
      storage: {
        size: store.size(),
        limit: store.limit(),
        database_path: snapshot?.knowledge_base?.storage?.database_path ?? null,
      },
      configs: snapshot,
      note: '这个面板只读。要改变任何状态，请用工具（analyze_image_prompt / validate_configs / diagnose_knowledge_base / rebuild_knowledge_base / preview_model_profile / manage_experiences）。',
    }
  }
  const JSON_BODY_LIMIT = 1 << 20

  let workbenchFilesCache = null
  function ensureWorkbenchFiles(runtime) {
    const dataDir = runtime?.dirs?.dataDir
    const ttl = runtime?.pluginConfig?.panel?.workbench_temp_ttl_minutes ?? 10
    if (typeof dataDir !== 'string' || dataDir.length === 0) {
      throw new WorkbenchError(PANEL_CODES.INTERNAL_ERROR, '运行时没有可用的数据目录，无法操作工作台文件。')
    }
    const key = `${dataDir}\u0000${ttl}`
    if (!workbenchFilesCache || workbenchFilesCache.key !== key) {
      workbenchFilesCache = { key, handle: createWorkbenchFiles({ dataDir, ttlMinutes: ttl, logger }) }
    }
    return workbenchFilesCache.handle
  }

  function isSameOrigin(req) {
    const headers = req?.headers ?? {}
    const origin = typeof headers.origin === 'string' ? headers.origin.trim() : ''
    const host = typeof headers.host === 'string' ? headers.host.trim().toLowerCase() : ''
    if (!origin || !host) return false
    try {
      return new URL(origin).host.toLowerCase() === host
    } catch {
      return false
    }
  }

  async function readRequestBody(req, { maxBytes }) {
    const declared = Number(req?.headers?.['content-length'])
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new WorkbenchError(PANEL_CODES.UPLOAD_TOO_LARGE, `请求体声明 ${declared} 字节，超过上限 ${maxBytes}。`)
    }
    const chunks = []
    let total = 0
    for await (const chunk of req) {
      const view = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += view.length
      if (total > maxBytes) {
        throw new WorkbenchError(PANEL_CODES.UPLOAD_TOO_LARGE, `请求体超过上限 ${maxBytes} 字节。`)
      }
      chunks.push(view)
    }
    return Buffer.concat(chunks)
  }

  async function readJsonBody(req, { allowedKeys, requiredKeys }) {
    const bytes = await readRequestBody(req, { maxBytes: JSON_BODY_LIMIT })
    let parsed
    try {
      parsed = JSON.parse(bytes.toString('utf8'))
    } catch {
      throw new WorkbenchError(PANEL_CODES.REQUEST_INVALID, '请求体不是合法 JSON。')
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new WorkbenchError(PANEL_CODES.REQUEST_INVALID, '请求体必须是一个 JSON 对象。')
    }
    for (const key of Object.keys(parsed)) {
      if (!allowedKeys.includes(key)) {
        throw new WorkbenchError(PANEL_CODES.REQUEST_INVALID, `未知字段：${key}（只接受 ${allowedKeys.join(' / ')}）。`)
      }
    }
    for (const key of requiredKeys) {
      if (parsed[key] === undefined) {
        throw new WorkbenchError(PANEL_CODES.REQUEST_INVALID, `缺少必填字段：${key}。`)
      }
    }
    return parsed
  }

  function sendWorkbenchError(res, error) {
    const code = error?.code ?? PANEL_CODES.INTERNAL_ERROR
    const status =
      code === PANEL_CODES.ORIGIN_REJECTED
        ? 403
        : code === PANEL_CODES.METHOD_NOT_ALLOWED
          ? 405
          : code === PANEL_CODES.REQUEST_INVALID ||
              code === PANEL_CODES.UPLOAD_TOO_LARGE ||
              code === PANEL_CODES.FETCH_UNSUPPORTED_PROTOCOL ||
              code === PANEL_CODES.FETCH_FAILED
            ? 400
            : 500
    sendJson(res, status, {
      schema_version: PANEL_SCHEMA_VERSION,
      error_code: code,
      error_group: errorGroupFor(code),
      message: `工作台动作失败：${error?.message ?? error}`,
      suggested_fix: '参数与限制见 docs/PANEL_API.md 的工作台动作路由一节。',
    })
  }

  async function handleWorkbench(req, res, rest, url) {
    if (req.method !== 'POST') {
      sendJson(res, 405, {
        schema_version: PANEL_SCHEMA_VERSION,
        error_code: PANEL_CODES.METHOD_NOT_ALLOWED,
        error_group: errorGroupFor(PANEL_CODES.METHOD_NOT_ALLOWED),
        message: `工作台动作只接受 POST，收到 ${req.method}。`,
        suggested_fix: '查询请走 GET 路由；动作定义见 docs/PANEL_API.md。',
      })
      return
    }
    if (!isSameOrigin(req)) {
      sendJson(res, 403, {
        schema_version: PANEL_SCHEMA_VERSION,
        error_code: PANEL_CODES.ORIGIN_REJECTED,
        error_group: errorGroupFor(PANEL_CODES.ORIGIN_REJECTED),
        message: '工作台动作要求同源请求：缺少 Origin 或与 Host 不匹配。',
        suggested_fix: '请在 DSH 页面里操作工作台；跨站或命令行直打一律拒绝。',
      })
      return
    }
    const runtime = typeof getRuntime === 'function' ? getRuntime() : (getRuntime ?? null)
    if (!runtime || typeof runtime.runAnalyze !== 'function') {
      throw new WorkbenchError(PANEL_CODES.INTERNAL_ERROR, '运行时不可用。')
    }
    const files = ensureWorkbenchFiles(runtime)
    const maxBytes = runtime.pluginConfig?.image?.max_bytes ?? 33554432
    try {
      await files.sweepExpired()
    } catch (error) {
      logger?.warn?.(`workbench 清扫失败（不阻断动作）：${error?.message ?? error}`)
    }

    if (rest === '/workbench/image') {
      const name = url.searchParams.get('name') ?? 'upload.bin'
      const bytes = await readRequestBody(req, { maxBytes })
      const saved = await files.saveUpload(bytes, name)
      sendJson(res, 200, { schema_version: PANEL_SCHEMA_VERSION, status: 'ok', result: saved })
      return
    }
    if (rest === '/workbench/fetch') {
      const payload = await readJsonBody(req, { allowedKeys: ['url'], requiredKeys: ['url'] })
      if (typeof payload.url !== 'string' || payload.url.length === 0) {
        throw new WorkbenchError(PANEL_CODES.REQUEST_INVALID, 'url 必须是非空字符串。')
      }
      const result = await fetchUrlToFile({ url: payload.url, maxBytes, saveUpload: files.saveUpload })
      sendJson(res, 200, { schema_version: PANEL_SCHEMA_VERSION, status: 'ok', result })
      return
    }
    if (rest === '/workbench/analyze') {
      const payload = await readJsonBody(req, {
        allowedKeys: [
          'image_path',
          'target_profile',
          'detail_level',
          'include_negative',
          'save_experience',
          'vision_provider',
          'vision_model',
          'progress_key',
        ],
        requiredKeys: ['image_path'],
      })
      for (const key of ['vision_provider', 'vision_model', 'progress_key']) {
        if (payload[key] !== undefined && typeof payload[key] !== 'string') {
          throw new WorkbenchError(PANEL_CODES.REQUEST_INVALID, `${key} 必须是字符串。`)
        }
        if (typeof payload[key] === 'string' && payload[key].trim().length === 0) delete payload[key]
      }
      const progressKey = payload.progress_key ?? null
      try {
        const envelope = await runtime.runAnalyze({ ...payload })
        sendJson(res, 200, envelope)
      } finally {
        if (progressKey) runtime.progress?.finish?.(progressKey)
      }
      return
    }
    if (rest === '/workbench/cleanup') {
      const result = await files.cleanupAll()
      sendJson(res, 200, { schema_version: PANEL_SCHEMA_VERSION, status: 'ok', result })
      return
    }
    sendJson(res, 404, {
      schema_version: PANEL_SCHEMA_VERSION,
      error_code: PANEL_CODES.TASK_NOT_FOUND,
      error_group: errorGroupFor(PANEL_CODES.TASK_NOT_FOUND),
      message: `未知的工作台动作：${rest}`,
      suggested_fix: '可用动作：image、fetch、analyze、cleanup。',
    })
  }

  async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://x')
    const pathname = url.pathname
    const rest = pathname.slice(prefix.length) || '/'

    if (rest.startsWith('/workbench/') && rest !== '/workbench/models' && !rest.startsWith('/workbench/progress/')) {
      try {
        await handleWorkbench(req, res, rest, url)
      } catch (error) {
        sendWorkbenchError(res, error)
      }
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, {
        schema_version: PANEL_SCHEMA_VERSION,
        error_code: PANEL_CODES.METHOD_NOT_ALLOWED,
        error_group: errorGroupFor(PANEL_CODES.METHOD_NOT_ALLOWED),
        message: `结果面板是只读的，不接受 ${req.method}。`,
        suggested_fix: '改变状态请用工具，不要从浏览器直接写。',
      })
      return
    }

    try {
      if (rest === '/' || rest === '/summary' || rest === '/tasks') {
        sendJson(res, 200, await summary())
        return
      }
      if (rest === '/workbench/models') {
        const runtime = typeof getRuntime === 'function' ? getRuntime() : (getRuntime ?? null)
        let result
        try {
          result = await runtime?.listVisionCandidates?.()
        } catch (error) {
          logger?.warn?.(`读取视觉模型候选失败：${error?.message ?? error}`)
        }
        sendJson(res, 200, {
          schema_version: PANEL_SCHEMA_VERSION,
          status: 'ok',
          result:
            result ?? {
              current: null,
              candidates: [],
              diagnostics: [
                {
                  error_code: PANEL_CODES.INTERNAL_ERROR,
                  error_group: errorGroupFor(PANEL_CODES.INTERNAL_ERROR),
                  severity: 'warning',
                  message: '运行时还没有模型候选入口，先让模型跑一次任意工具再刷新。',
                  suggested_fix: null,
                },
              ],
            },
        })
        return
      }
      if (rest.startsWith('/workbench/progress/')) {
        const key = decodeURIComponent(rest.slice('/workbench/progress/'.length))
        const runtime = typeof getRuntime === 'function' ? getRuntime() : (getRuntime ?? null)
        const state = runtime?.progress?.get?.(key) ?? null
        sendJson(res, 200, {
          schema_version: PANEL_SCHEMA_VERSION,
          status: 'ok',
          result: {
            text: state?.text ?? '',
            done: state?.done ?? true,
          },
        })
        return
      }
      if (rest.startsWith('/tasks/')) {
        const taskId = decodeURIComponent(rest.slice('/tasks/'.length))
        const entry = store.get(taskId)
        if (!entry) {
          sendJson(res, 404, {
            schema_version: PANEL_SCHEMA_VERSION,
            error_code: PANEL_CODES.TASK_NOT_FOUND,
            error_group: errorGroupFor(PANEL_CODES.TASK_NOT_FOUND),
            message: `面板里没有 task_id 为 ${taskId} 的分析结果。`,
            suggested_fix:
              '面板只保留本次运行期最近若干条结果，重启后会清空；长期保存请用 save_experience 写入经验库。',
          })
          return
        }
        sendJson(res, 200, { schema_version: PANEL_SCHEMA_VERSION, task: entry })
        return
      }
      sendJson(res, 404, {
        schema_version: PANEL_SCHEMA_VERSION,
        error_code: PANEL_CODES.TASK_NOT_FOUND,
        error_group: errorGroupFor(PANEL_CODES.TASK_NOT_FOUND),
        message: `未知的面板路径：${pathname}`,
        suggested_fix: `可用路径：${prefix}/summary、${prefix}/tasks、${prefix}/tasks/<task_id>。`,
      })
    } catch (error) {
      logger?.warn?.(`结果面板处理请求失败：${error?.message ?? error}`)
      sendJson(res, 500, {
        schema_version: PANEL_SCHEMA_VERSION,
        error_code: PANEL_CODES.INTERNAL_ERROR,
        error_group: errorGroupFor(PANEL_CODES.INTERNAL_ERROR),
        message: `结果面板内部错误：${error?.message ?? error}`,
      })
    }
  }

  return {
    prefix,
    handler,
    register(ctx) {
      const diagnostics = []
      if (!ctx?.webServer || typeof ctx.webServer.register !== 'function') {
        diagnostics.push(
          diagnostic({
            error_code: PANEL_CODES.ROUTE_UNAVAILABLE,
            severity: SEVERITY.WARNING,
            message: '当前 profile 没有 webServer 服务，结果面板的只读接口没有注册。',
            suggested_fix: '这不影响分析功能。要在页面里看到面板，需要 Web 形态的 profile。',
          }),
        )
        return { disposer: null, diagnostics }
      }
      const disposer = ctx.webServer.register({ kind: 'prefix', path: prefix, handler })
      logger?.info?.(`结果面板只读接口已注册：GET ${prefix}/summary`)
      return { disposer, diagnostics }
    },
  }
}
