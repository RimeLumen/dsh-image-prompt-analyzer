
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { NULL_LOGGER } from '../log.js'

const SAFE_LABEL = /[^a-zA-Z0-9_-]+/g

export function safeLabel(label, fallback = 'task') {
  const cleaned = String(label ?? '')
    .replace(SAFE_LABEL, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return cleaned.length > 0 ? cleaned : fallback
}

export function createTempWorkspace({ dataDir, ttlMinutes = 60, logger = NULL_LOGGER }) {
  const root = join(dataDir, 'tmp')
  const ttlMs = Math.max(1, Number(ttlMinutes) || 60) * 60 * 1000
  let counter = 0

  async function allocate(label) {
    await mkdir(root, { recursive: true })
    counter += 1
    const stamp = Date.now().toString(36)
    const rand = Math.random().toString(36).slice(2, 8)
    const dir = join(root, `${stamp}-${safeLabel(label)}-${counter}-${rand}`)
    await mkdir(dir, { recursive: true })
    return dir
  }

  async function release(dir) {
    if (typeof dir !== 'string' || dir.length === 0) return
    if (!dir.startsWith(root)) {
      logger.warn(`拒绝删除临时目录：不在受管根目录内（${dir}）`)
      return
    }
    try {
      await rm(dir, { recursive: true, force: true })
    } catch (error) {
      logger.warn(`临时目录清理失败：${dir}（${error?.message ?? error}）`)
    }
  }

  async function sweep() {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      return 0 // 根目录还不存在，说明从没跑过任务。
    }
    const deadline = Date.now() - ttlMs
    let removed = 0
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(root, entry.name)
      try {
        const info = await stat(dir)
        if (info.mtimeMs < deadline) {
          await rm(dir, { recursive: true, force: true })
          removed += 1
        }
      } catch {
      }
    }
    if (removed > 0) logger.debug(`临时工作区清扫：删除 ${removed} 个过期目录`)
    return removed
  }

  return { root, allocate, release, sweep }
}
