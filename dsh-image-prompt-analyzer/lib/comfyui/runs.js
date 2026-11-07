
import { randomUUID } from 'node:crypto'

import { COMFY_CODES, ComfyError } from './errors.js'
import { stableFingerprint } from './patch.js'

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

// /history 的 status.messages 里，这两种事件说明执行中途出过事。
const EXECUTION_ERROR_TYPES = new Set(['execution_error', 'execution_interrupted'])

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

function sortedNodeIds(nodes) {
  return Object.keys(nodes).sort((left, right) => {
    const a = Number(left)
    const b = Number(right)
    if (Number.isFinite(a) && Number.isFinite(b)) return a - b
    return left.localeCompare(right)
  })
}

function inputsOf(node) {
  return node?.inputs && typeof node.inputs === 'object' ? node.inputs : {}
}

function loaderEntry(nodeId, node, field) {
  const selector = inputsOf(node)[field]
  if (typeof selector !== 'string' || selector === '') return null
  return { node_id: nodeId, class_type: node.class_type, field, selector }
}

/**
 * 从提交出去的那份 prompt 里抽出"这次实际用了什么"。
 * 只读，不改 prompt，也不补默认值：工作流里没写的字段一律留 null，
 * 因为默认值是 ComfyUI 那边决定的，插件替它猜就等于记录了一个没发生的事实。
 */
export function describeExecution(prompt) {
  const nodes = prompt && typeof prompt === 'object' && !Array.isArray(prompt) ? prompt : {}
  const ids = sortedNodeIds(nodes)
  const checkpoints = []
  const loras = []
  const vaes = []
  const samplers = []
  const latents = []

  for (const nodeId of ids) {
    const node = nodes[nodeId]
    const classType = node?.class_type
    const inputs = inputsOf(node)
    if (classType === 'CheckpointLoaderSimple') {
      const entry = loaderEntry(nodeId, node, 'ckpt_name')
      if (entry) checkpoints.push(entry)
    } else if (classType === 'LoraLoader') {
      const entry = loaderEntry(nodeId, node, 'lora_name')
      if (entry) {
        entry.strength_model = inputs.strength_model ?? null
        entry.strength_clip = inputs.strength_clip ?? null
        loras.push(entry)
      }
    } else if (classType === 'VAELoader') {
      const entry = loaderEntry(nodeId, node, 'vae_name')
      if (entry) vaes.push(entry)
    } else if (classType === 'KSampler') {
      samplers.push({
        node_id: nodeId,
        class_type: classType,
        seed: Number.isSafeInteger(inputs.seed) ? inputs.seed : null,
        seed_unsafe: typeof inputs.seed === 'number' && !Number.isSafeInteger(inputs.seed),
        steps: typeof inputs.steps === 'number' ? inputs.steps : null,
        cfg: typeof inputs.cfg === 'number' ? inputs.cfg : null,
        sampler_name: typeof inputs.sampler_name === 'string' ? inputs.sampler_name : null,
        scheduler: typeof inputs.scheduler === 'string' ? inputs.scheduler : null,
        denoise: typeof inputs.denoise === 'number' ? inputs.denoise : null,
      })
    } else if (classType === 'EmptyLatentImage') {
      latents.push({
        node_id: nodeId,
        class_type: classType,
        width: typeof inputs.width === 'number' ? inputs.width : null,
        height: typeof inputs.height === 'number' ? inputs.height : null,
        batch_size: typeof inputs.batch_size === 'number' ? inputs.batch_size : null,
      })
    }
  }

  // 结构指纹只看节点与类型，不看参数值：history 里存的是执行用的那份 prompt，
  // 节点对得上才说明这确实是同一次提交的产物。
  const shape = {}
  for (const nodeId of ids) shape[nodeId] = nodes[nodeId]?.class_type ?? null

  return {
    workflow_id: stableFingerprint(nodes),
    workflow_shape: stableFingerprint(shape),
    workflow_nodes: ids.length,
    checkpoints,
    loras,
    vaes,
    samplers,
    latents,
  }
}

/** 与 imageViewUrl 同一套规则：带路径片段的名字不能当输出引用。 */
export function isSafeOutputFilename(filename) {
  if (typeof filename !== 'string' || filename === '') return false
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) return false
  return true
}

/** subfolder 允许嵌套，但不能跳出输出目录，也不能是绝对路径。 */
export function isSafeOutputSubfolder(subfolder) {
  if (subfolder === undefined || subfolder === null || subfolder === '') return true
  if (typeof subfolder !== 'string') return false
  if (subfolder.includes('..')) return false
  if (subfolder.startsWith('/') || subfolder.startsWith('\\')) return false
  if (/^[A-Za-z]:/.test(subfolder)) return false
  return true
}

// folder_paths.get_directory_by_type 只认这三种；其它值在服务端直接 400。
const OUTPUT_TYPES = new Set(['output', 'input', 'temp'])

/** 一条输出引用整体能不能安全地拼进 /view。 */
export function isSafeOutputRef(image) {
  if (!image || typeof image !== 'object') return false
  if (!isSafeOutputFilename(image.filename)) return false
  if (!isSafeOutputSubfolder(image.subfolder)) return false
  const type = image.type ?? 'output'
  return typeof type === 'string' && OUTPUT_TYPES.has(type)
}

async function readComfyVersion(client) {
  try {
    const stats = await client.getSystemStats()
    const version = stats?.system?.comfyui_version
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    // 版本只是记录用，取不到不影响任务本身的结论。
    return null
  }
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
    // 这次提交的工作流摘要。它只说明"提交了什么"，不代表执行成功。
    workflow: describeExecution(prompt),
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
 * 一次执行成功的完整记录。
 *
 * 只在 /history 明确说 completed、没有执行错误、工作流对得上本次提交、
 * 并且输出里确实有可安全取回的图片时才生成；排队、执行中、unknown、failed 都不生成。
 *
 * 这是**任务级**记录：它跟着这一次 run 走，不回写任何 ModelRecord——
 * 一次跑通不等于这个模型以后一直可用。它也只活在当前进程的 run registry 里，
 * dispose 或进程退出后就没了；本版本不做落盘，别把它当成历史数据库。
 */
export function buildExecutionSuccess({ run, summary, comfyVersion = null, images = [], finishedAt = null }) {
  const described = summary ?? describeExecution(null)
  const usable = images.filter((image) => isSafeOutputRef(image))
  return {
    execution_status: 'success',
    scope: 'run',
    persistence: 'process',
    run_id: run?.run_id ?? null,
    prompt_id: run?.prompt_id ?? null,
    comfyui_version: comfyVersion,
    workflow_id: described.workflow_id,
    workflow_hash: described.workflow_id,
    workflow_shape: described.workflow_shape,
    workflow_nodes: described.workflow_nodes,
    checkpoint_selectors: described.checkpoints,
    lora_selectors: described.loras,
    vae_selectors: described.vaes,
    samplers: described.samplers,
    latents: described.latents,
    images: usable.map((image) => ({
      node_id: image.node_id ?? null,
      filename: image.filename,
      subfolder: image.subfolder ?? '',
      type: image.type ?? 'output',
    })),
    finished_at: finishedAt,
  }
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
    // 这两类消息意味着这次执行中途出过事，哪怕 status.completed 是 true 也不能算成功。
    const errorMessages = messages.filter((item) => EXECUTION_ERROR_TYPES.has(item?.[0]))
    const failed = status.status_str === 'error' || errorMessages.length > 0
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
      const errorMessage = errorMessages
        .map((item) => item?.[1]?.exception_message ?? item?.[1]?.exception_type ?? item?.[0] ?? '执行出错')
        .join('；')
      return {
        ...run,
        state: RUN_STATES.FAILED,
        message: completed
          ? `history 标了完成，但记录里有执行错误，按失败处理：${errorMessage || '未提供原因'}。`
          : errorMessage || '执行失败。',
        images,
        finished_at: new Date().toISOString(),
      }
    }

    if (completed) {
      const finishedAt = new Date().toISOString()
      // 本进程提交过的任务带自己的摘要；只给 prompt_id 查回来的历史任务没有，
      // 但 /history 的记录里存着当初执行的那份 prompt（`prompt[2]`），据此还原。
      const historySummary = Array.isArray(record.prompt) ? describeExecution(record.prompt[2]) : null
      const summary = run?.workflow ?? historySummary
      if (
        run?.workflow &&
        historySummary &&
        run.workflow.workflow_shape !== historySummary.workflow_shape
      ) {
        // 同一个 prompt_id 底下却挂着另一套节点，不能拿它当本次提交的成功记录。
        return {
          ...run,
          state: RUN_STATES.COMPLETED,
          message: '执行完成，但 history 里的工作流与本次提交对不上，不写成功记录。',
          images,
          finished_at: finishedAt,
          execution_success: null,
        }
      }
      const usable = images.filter((image) => isSafeOutputRef(image))
      if (usable.length === 0) {
        // 执行完了但没留下可取的图：这不是成功记录能写的场合。
        return {
          ...run,
          state: RUN_STATES.COMPLETED,
          message: images.length > 0 ? '执行完成，但输出文件名不可用，取不回图片。' : '执行完成，但没有产出图片。',
          images,
          finished_at: finishedAt,
          execution_success: null,
        }
      }
      const comfyVersion = await readComfyVersion(client)
      return {
        ...run,
        state: RUN_STATES.COMPLETED,
        message: `生成完成，共 ${images.length} 张图。`,
        images,
        finished_at: finishedAt,
        execution_success: buildExecutionSuccess({
          run,
          summary,
          comfyVersion,
          images,
          finishedAt,
        }),
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
  if (!isSafeOutputFilename(image.filename)) {
    throw new ComfyError(COMFY_CODES.OUTPUT_UNAVAILABLE, '输出文件名包含路径片段，拒绝拼接。')
  }
  if (!isSafeOutputSubfolder(image.subfolder)) {
    throw new ComfyError(COMFY_CODES.OUTPUT_UNAVAILABLE, '输出子目录越出了输出目录，拒绝拼接。')
  }
  const type = image.type ?? 'output'
  if (!OUTPUT_TYPES.has(type)) {
    throw new ComfyError(COMFY_CODES.OUTPUT_UNAVAILABLE, `输出类型 ${type} 不是 output/input/temp，拒绝拼接。`)
  }
  return client.viewUrl({
    filename: image.filename,
    subfolder: image.subfolder ?? '',
    type,
  })
}
