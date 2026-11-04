/**
 * 阶段产物留痕：把一次分析拆成可重放的几段，各自落盘。
 *
 * 为什么要单独一层：出问题时我们手里只有最终的 IR 与提示词，中间发生过什么
 * 全靠猜。例如"侧身被读成正对"——是模型没看见肩线？是证据层改写了？还是编译层
 * 把肩线那句话当成重复词删了？只看成品永远答不了。
 *
 * 这一层只做记录，**不改变任何输出**。写盘失败也不影响分析：
 * 拿不到产物是可接受的降级，伪造一份"看起来完整"的产物才是事故。
 *
 * 两种状态必须分开：
 *   captured —— 真的抓到了，内容在文件里；
 *   missing  —— 这个阶段在当前代码里根本没有可取的东西，写清原因。
 * 绝不用空对象冒充 captured：下游据此判断"能不能重放"，空对象会骗人。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const TRACE_SCHEMA_VERSION = '1.0'

/** 一次完整分析应当产出的阶段清单。缺哪一段，manifest 里就有哪一段的 missing 记录。 */
export const TRACE_STAGES = Object.freeze({
  VERSION: 'version',
  CONFIG: 'config',
  STAGE_A_RAW: 'stage_a_raw',
  STAGE_B_RAW: 'stage_b_raw',
  IR_PRE_EVIDENCE: 'ir_pre_evidence',
  IR_POST_EVIDENCE: 'ir_post_evidence',
  PROMPTS: 'prompts',
  FACT_LEDGER: 'fact_ledger',
})

export const TRACE_STATUS = Object.freeze({
  CAPTURED: 'captured',
  MISSING: 'missing',
})

const ALL_STAGES = Object.values(TRACE_STAGES)

/**
 * @param {object} args
 * @param {string} args.taskId
 * @param {string|null} [args.dir] 落盘根目录；null 表示只收集不写盘（离线脚本用）
 * @param {boolean} [args.enabled]
 */
export function createStageTrace({ taskId = null, dir = null, enabled = true } = {}) {
  const id = String(taskId ?? '').trim() || 'untraced'
  const entries = new Map()
  const startedAt = new Date().toISOString()

  const record = (name, status, payload, extra = {}) => {
    if (!enabled) return null
    entries.set(name, {
      stage: name,
      status,
      captured_at: new Date().toISOString(),
      ...extra,
      ...(status === TRACE_STATUS.CAPTURED ? { payload } : {}),
    })
    return entries.get(name)
  }

  return {
    taskId: id,
    enabled,
    /** 抓到一个阶段的产物。payload 必须是可 JSON 序列化的纯数据。 */
    capture(name, payload) {
      return record(name, TRACE_STATUS.CAPTURED, payload)
    },
    /**
     * 明确记一条"这段拿不到"。
     *
     * reason 要写清"为什么拿不到"，而不是"没抓到"——前者能指导下一步，
     * 后者只会让人以为是偶发失败又重跑一遍。
     */
    missing(name, reason) {
      return record(name, TRACE_STATUS.MISSING, undefined, { reason: String(reason ?? '未说明原因') })
    },
    has(name) {
      return entries.has(name)
    },
    get(name) {
      return entries.get(name) ?? null
    },
    /** 阶段清单：哪些抓到了、哪些缺、缺的原因。给 manifest 用。 */
    summary() {
      const stages = ALL_STAGES.map((name) => {
        const entry = entries.get(name)
        if (!entry) {
          return { stage: name, status: TRACE_STATUS.MISSING, reason: '本次运行没有走到这个阶段' }
        }
        return entry.status === TRACE_STATUS.CAPTURED
          ? { stage: name, status: TRACE_STATUS.CAPTURED, bytes: safeBytes(entry.payload) }
          : { stage: name, status: TRACE_STATUS.MISSING, reason: entry.reason }
      })
      const missing = stages.filter((item) => item.status === TRACE_STATUS.MISSING)
      return {
        task_id: id,
        started_at: startedAt,
        stages,
        captured: stages.filter((item) => item.status === TRACE_STATUS.CAPTURED).map((item) => item.stage),
        missing: missing.map((item) => ({ stage: item.stage, reason: item.reason })),
        // 能不能"完整重放"是一个结论，不能让下游自己数数去猜。
        replayable: missing.length === 0,
      }
    },
    /**
     * 写盘。返回 {dir, files, summary} 或 null（未启用 / 写失败）。
     *
     * 写失败只吞掉异常、返回 null：留痕是辅助设施，不能因为它把一次分析搞挂。
     */
    flush({ rootDir = null } = {}) {
      if (!enabled) return null
      const target = dir ?? (rootDir ? join(rootDir, id) : null)
      if (!target) return null
      try {
        mkdirSync(target, { recursive: true })
        const files = []
        for (const [name, entry] of entries) {
          if (entry.status !== TRACE_STATUS.CAPTURED) continue
          const file = `${name}.json`
          writeFileSync(join(target, file), `${JSON.stringify(entry.payload, null, 2)}\n`, 'utf8')
          files.push(file)
        }
        const summary = this.summary()
        writeFileSync(join(target, 'manifest.json'), `${JSON.stringify({ schema_version: TRACE_SCHEMA_VERSION, ...summary }, null, 2)}\n`, 'utf8')
        files.push('manifest.json')
        return { dir: target, files, summary }
      } catch {
        return null
      }
    },
  }
}

function safeBytes(value) {
  try {
    return JSON.stringify(value).length
  } catch {
    return null
  }
}

/**
 * 深拷贝一份 IR 当快照。
 *
 * 证据层是原地改写 feature.value 的，不拷贝就只能拿到最后一个状态——
 * 那正是"只能看成品、无法归因"的老问题。
 */
export function snapshotIR(ir) {
  try {
    return JSON.parse(JSON.stringify(ir))
  } catch {
    return null
  }
}
