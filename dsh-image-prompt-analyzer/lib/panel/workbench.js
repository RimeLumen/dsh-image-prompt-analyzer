
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { join, sep } from 'node:path'
import { randomBytes } from 'node:crypto'

import { PANEL_CODES } from './codes.js'
import { NULL_LOGGER } from '../log.js'

export class WorkbenchError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'WorkbenchError'
    this.code = code
  }
}

export function sanitizeUploadName(name) {
  const segments = String(name ?? '')
    .split(/[\\/]+/)
    .filter((segment) => segment !== '..' && segment !== '.')
  const base = segments[segments.length - 1] ?? ''
  return base.length > 0 ? base : 'upload'
}

function extensionOf(name) {
  const match = /\.[A-Za-z0-9]+$/.exec(String(name))
  return match ? match[0].toLowerCase() : '.bin'
}

export function createWorkbenchFiles({ dataDir, ttlMinutes = 10, logger = NULL_LOGGER }) {
  const dir = join(dataDir, 'tmp', 'workbench')
  const ttlMs = Math.max(1, Number(ttlMinutes) || 10) * 60 * 1000

  async function ensureDir() {
    await mkdir(dir, { recursive: true })
  }

  async function saveUpload(bytes, name) {
    const clean = sanitizeUploadName(name)
    await ensureDir()
    const path = join(dir, `wb-${randomBytes(4).toString('hex')}${extensionOf(clean)}`)
    if (!path.startsWith(dir + sep)) {
      throw new WorkbenchError(PANEL_CODES.INTERNAL_ERROR, `落盘路径越出受管目录：${path}`)
    }
    await writeFile(path, bytes)
    return { path, size_bytes: bytes.length, name: clean }
  }

  async function sweepExpired() {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return 0 // 目录还不存在 = 从没有过工作台文件。
    }
    const deadline = Date.now() - ttlMs
    let removed = 0
    for (const entry of entries) {
      const path = join(dir, entry.name)
      try {
        const info = await stat(path)
        if (info.mtimeMs >= deadline) continue
        await rm(path, { recursive: true, force: true })
        removed += 1
      } catch (error) {
        logger.warn?.(`workbench 清扫单项失败：${path}（${error?.message ?? error}）`)
      }
    }
    return removed
  }

  async function cleanupAll() {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return { deleted_files: 0, freed_bytes: 0 }
    }
    let deleted = 0
    let freed = 0
    for (const entry of entries) {
      const path = join(dir, entry.name)
      try {
        const info = await stat(path)
        await rm(path, { recursive: true, force: true })
        deleted += 1
        if (info.isFile()) freed += info.size
      } catch (error) {
        logger.warn?.(`workbench 清除缓存跳过失败项：${path}（${error?.message ?? error}）`)
      }
    }
    return { deleted_files: deleted, freed_bytes: freed }
  }

  return { dir, saveUpload, sweepExpired, cleanupAll }
}

const FETCH_PROTOCOLS = new Set(['http:', 'https:'])

export function proxyUrlFor(targetProtocol) {
  const names =
    targetProtocol === 'https:'
      ? ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']
      : ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
  for (const name of names) {
    const value = process.env?.[name]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

const REDIRECT_LIMIT = 5

function proxiedRequestOnce({ target, proxyUrl, signal }) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl)
    const proxyPort = Number(proxy.port) || 80
    if (target.protocol === 'http:') {
      const req = httpRequest(
        {
          host: proxy.hostname,
          port: proxyPort,
          method: 'GET',
          path: target.href,
          headers: { host: target.host },
          signal,
        },
        (res) => resolve(res),
      )
      req.on('error', reject)
      req.end()
      return
    }
    const connectReq = httpRequest({
      host: proxy.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port ? Number(target.port) : 443}`,
      signal,
    })
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`代理拒绝建立隧道（HTTP ${res.statusCode}）`))
        return
      }
      const tlsSocket = tlsConnect({ socket, servername: target.hostname, signal })
      tlsSocket.on('error', reject)
      const inner = httpsRequest(
        {
          host: target.hostname,
          port: target.port ? Number(target.port) : 443,
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers: { host: target.host },
          signal,
          createConnection: () => tlsSocket,
        },
        (innerRes) => resolve(innerRes),
      )
      inner.on('error', reject)
      inner.end()
    })
    connectReq.on('error', reject)
    connectReq.end()
  })
}

async function proxyFetch({ url, proxyUrl, signal }) {
  let current = new URL(url)
  for (let hop = 0; hop <= REDIRECT_LIMIT; hop += 1) {
    const res = await proxiedRequestOnce({ target: current, proxyUrl, signal })
    const status = res.statusCode ?? 0
    const location = res.headers?.location
    if (status >= 300 && status < 400 && typeof location === 'string' && location.length > 0) {
      res.resume() // 丢弃当前重定向体，再走下一跳。
      const next = new URL(location, current)
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new Error(`重定向到不支持的协议：${next.protocol}`)
      }
      current = next
      continue
    }
    return { ok: status >= 200 && status < 300, status, body: res }
  }
  throw new Error(`重定向超过 ${REDIRECT_LIMIT} 跳`)
}

export async function fetchUrlToFile({ url, fetchImpl = null, timeoutMs = 30000, maxBytes, saveUpload }) {
  let parsed
  try {
    parsed = new URL(String(url ?? ''))
  } catch {
    throw new WorkbenchError(PANEL_CODES.FETCH_UNSUPPORTED_PROTOCOL, `不是合法的 URL：${String(url)}`)
  }
  if (!FETCH_PROTOCOLS.has(parsed.protocol)) {
    throw new WorkbenchError(PANEL_CODES.FETCH_UNSUPPORTED_PROTOCOL, `只接受 http/https，收到 ${parsed.protocol}`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 30000))
  try {
    let response
    try {
      if (typeof fetchImpl === 'function') {
        response = await fetchImpl(parsed.href, { signal: controller.signal, redirect: 'follow' })
      } else {
        const proxy = proxyUrlFor(parsed.protocol)
        if (proxy) {
          response = await proxyFetch({ url: parsed.href, proxyUrl: proxy, signal: controller.signal })
        } else if (typeof globalThis.fetch === 'function') {
          response = await globalThis.fetch(parsed.href, { signal: controller.signal, redirect: 'follow' })
        } else {
          throw new WorkbenchError(PANEL_CODES.FETCH_FAILED, '当前运行环境没有可用的 fetch 实现，也未配置代理环境变量。')
        }
      }
    } catch (error) {
      if (error instanceof WorkbenchError || error?.name === 'WorkbenchError') throw error
      throw new WorkbenchError(PANEL_CODES.FETCH_FAILED, `下载失败：${error?.message ?? error}`)
    }
    if (!response?.ok) {
      throw new WorkbenchError(PANEL_CODES.FETCH_FAILED, `远端返回 ${response?.status ?? '未知状态'}。`)
    }
    const chunks = []
    let total = 0
    try {
      if (response.body) {
        for await (const chunk of response.body) {
          const view = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          total += view.length
          if (total > maxBytes) {
            controller.abort()
            throw new WorkbenchError(PANEL_CODES.UPLOAD_TOO_LARGE, `下载超过上限 ${maxBytes} 字节，已中断。`)
          }
          chunks.push(view)
        }
      }
    } catch (error) {
      if (error instanceof WorkbenchError || error?.name === 'WorkbenchError') throw error
      throw new WorkbenchError(PANEL_CODES.FETCH_FAILED, `下载中断：${error?.message ?? error}`)
    }
    const bytes = Buffer.concat(chunks)
    const saved = await saveUpload(bytes, parsed.pathname)
    return { path: saved.path, size_bytes: saved.size_bytes, source_url: String(url) }
  } finally {
    clearTimeout(timer)
  }
}
