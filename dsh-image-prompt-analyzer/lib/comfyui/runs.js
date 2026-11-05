
import { randomUUID } from 'node:crypto'

import { COMFY_CODES, ComfyError } from './errors.js'

export const RUN_STATES = Object.freeze({
  PREPARED: 'prepared',
  SUBMITTING: 'submitting',
  ACCEPTED: 'accepted',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
})

// ComfyUI 的 validate_job_id 只接受规范的小写带连字符 UUID。
const PROMPT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isValidPromptId(value) {
  return typeof value === 'string' && PROMPT_ID_RE.test(value)
}

export function createRunRegistry() {
  const runs = new Map()
  return {
    create(record) {
      runs.set(record.run_id, record)
      return record
    },
    get(runId) {
      return runs.get(runId) ?? null
    },
    list() {
      return [...runs.values()]
    },
    update(runId, patch) {
      const current = runs.get(runId)
      if (!current) return null
      const next = { ...current, ...patch }
      runs.set(runId, next)
      return next
    },
    clear() {
      runs.clear()
    },
  }
}

function collectNodeErrors(body) {
  const nodeErrors = body?.node_errors
  if (!nodeErrors || typeof nodeErrors !== 'object') return []
  const flat = []
  for (const [nodeId, info] of Object.entries(nodeErrors)) {
    const list = Array.isArray(info?.errors) ? info.errors : []
    for (const item of list) {
      flat.push({
        node_id: nodeId,
        class_type: info?.class_type ?? null,
        message: item?.message ?? String(item),
        details: item?.details ?? null,
      })
    }
  }
  return flat
}

/**
 * 提交一次生成任务。
 *
 * 最重要的一条：请求发出去之后，超时、断连、响应不完整一律记为 unknown，
 * 并且**绝不重发**。网络错误不等于"服务端没收到"，自动重发会重复生图。
 */
export async function submitPrompt({ client, prompt, runId = randomUUID(), clientId = null, signal = null }) {
  const run = {
    run_id: runId,
    state: RUN_STATES.PREPARED,
    prompt_id: null,
    submitted_at: new Date().toISOString(),
    node_errors: [],
    http_status: null,
    message: null,
  }

  run.state = RUN_STATES.SUBMITTING
  const payload = { prompt }
  if (clientId) payload.client_id = clientId

  let result
  try {
    result = await client.postJson('/prompt', payload, { signal })
  } catch (error) {
    // 请求已经发出，结果不可知。标 unknown，不重试。
    return {
      ...run,
      state: RUN_STATES.UNKNOWN,
      message: `提交结果未知：${error?.message ?? error}。不会自动重发，请用 get_job 查询或人工确认。`,
      error_code: COMFY_CODES.SUBMISSION_UNKNOWN,
    }
  }

  run.http_status = result.status
  let body = null
  try {
    body = result.text ? JSON.parse(result.text) : null
  } catch {
    return {
      ...run,
      state: RUN_STATES.UNKNOWN,
      message: '服务端返回了无法解析的响应，提交结果未知。不会自动重发。',
      error_code: COMFY_CODES.SUBMISSION_UNKNOWN,
    }
  }

  const nodeErrors = collectNodeErrors(body)

  if (!result.ok) {
    return {
      ...run,
      state: RUN_STATES.FAILED,
      node_errors: nodeErrors,
      message: `ComfyUI 拒绝了这次提交（HTTP ${result.status}）：${body?.error?.message ?? '未提供原因'}`,
      error_code: COMFY_CODES.SUBMISSION_REJECTED,
      error_type: body?.error?.type ?? null,
    }
  }

  // HTTP 200 也可能是失败：node_errors 非空就不能算提交成功。
  if (nodeErrors.length > 0) {
    return {
      ...run,
      state: RUN_STATES.FAILED,
      node_errors: nodeErrors,
      message: `HTTP 200，但有 ${nodeErrors.length} 条节点错误，未进入执行队列。`,
      error_code: COMFY_CODES.SUBMISSION_REJECTED,
    }
  }

  const promptId = body?.prompt_id
  if (!isValidPromptId(promptId)) {
    return {
      ...run,
      state: RUN_STATES.UNKNOWN,
      message: `服务端没有返回合法 prompt_id（收到 ${JSON.stringify(promptId)}），提交结果未知。`,
      error_code: COMFY_CODES.SUBMISSION_UNKNOWN,
    }
  }

  return {
    ...run,
    state: RUN_STATES.ACCEPTED,
    prompt_id: promptId,
    accepted_at: new Date().toISOString(),
  }
}

function queueContains(queueBody, promptId) {
  const running = Array.isArray(queueBody?.queue_running) ? queueBody.queue_running : []
  const pending = Array.isArray(queueBody?.queue_pending) ? queueBody.queue_pending : []
  for (const item of [...running, ...pending]) {
    if (Array.isArray(item) && item[1] === promptId) return true
  }
  return false
}

/**
 * 查询任务。只由工具调用触发，不做后台轮询。
 * 完成与否只看 /history 里的实际状态，不看"进过队列"。
 */
export async function queryRun({ client, run, signal = null }) {
  if (!run?.prompt_id) {
    return { ...run, state: run?.state ?? RUN_STATES.UNKNOWN, message: '没有 prompt_id，无法查询。' }
  }

  const history = await client.getHistory(run.prompt_id, { signal })
  const record = history?.[run.prompt_id]

  if (record) {
    const status = record.status ?? {}
    const messages = Array.isArray(status.messages) ? status.messages : []
    const failed = status.status_str === 'error' || messages.some((item) => item?.[0] === 'execution_error')
    const completed = status.completed === true

    const outputs = record.outputs && typeof record.outputs === 'object' ? record.outputs : {}
    const images = []
    for (const [nodeId, out] of Object.entries(outputs)) {
      for (const image of out?.images ?? []) {
        images.push({
          node_id: nodeId,
          filename: image?.filename ?? null,
          subfolder: image?.subfolder ?? '',
          type: image?.type ?? 'output',
        })
      }
    }

    if (failed) {
      const errorMessage = messages
        .filter((item) => item?.[0] === 'execution_error')
        .map((item) => item?.[1]?.exception_message ?? item?.[1]?.exception_type ?? '执行出错')
        .join('；')
      return {
        ...run,
        state: RUN_STATES.FAILED,
        message: errorMessage || '执行失败。',
        images,
        finished_at: new Date().toISOString(),
      }
    }

    if (completed) {
      return {
        ...run,
        state: RUN_STATES.COMPLETED,
        message: images.length > 0 ? `生成完成，共 ${images.length} 张图。` : '执行完成，但没有产出图片。',
        images,
        finished_at: new Date().toISOString(),
      }
    }

    return { ...run, state: RUN_STATES.RUNNING, message: '已执行但尚未结束。', images }
  }

  const queue = await client.getQueue({ signal })
  if (queueContains(queue, run.prompt_id)) {
    return { ...run, state: RUN_STATES.RUNNING, message: '任务在队列中。' }
  }

  return {
    ...run,
    state: RUN_STATES.UNKNOWN,
    message: '历史里没有这个任务，队列里也没有。可能还在排队，也可能已被丢弃；请稍后再查。',
  }
}

/**
 * 取回输出图片的 URL。只用 ComfyUI 的 /view 参数，不接受任意文件路径。
 */
export function imageViewUrl(client, image) {
  if (!image || typeof image.filename !== 'string' || image.filename === '') {
    throw new ComfyError(COMFY_CODES.OUTPUT_UNAVAILABLE, '输出图片缺少文件名。')
  }
  if (image.filename.includes('..') || image.filename.includes('/') || image.filename.includes('\\')) {
    throw new ComfyError(COMFY_CODES.OUTPUT_UNAVAILABLE, '输出文件名包含路径片段，拒绝拼接。')
  }
  return client.viewUrl({
    filename: image.filename,
    subfolder: image.subfolder ?? '',
    type: image.type ?? 'output',
  })
}
