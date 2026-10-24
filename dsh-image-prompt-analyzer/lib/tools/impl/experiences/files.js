
import { resolve } from 'node:path'

import { SEVERITY, diagnostic } from '../../../diagnostics.js'
import { PACKAGE_DIR, resolveWithin } from '../../../paths.js'
import { EXPERIENCE_CODES } from '../../../experience/index.js'

export async function writeExport(targetPath, text) {
  const resolved = resolveWithin(PACKAGE_DIR, targetPath, null)
  if (!resolved) {
    return {
      ok: false,
      diagnostic: diagnostic({
        error_code: EXPERIENCE_CODES.EXPORT_PATH_UNSAFE,
        severity: SEVERITY.ERROR,
        message: `导出路径越出插件包目录，已拒绝：${targetPath}`,
        suggested_fix: '导出路径必须是相对插件包目录的相对路径，例如 data/experiences/experiences.jsonl。',
      }),
    }
  }

  const { mkdir, writeFile } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  await mkdir(dirname(resolved), { recursive: true })
  await writeFile(resolved, text, 'utf8')
  return { ok: true, path: resolved }
}

export async function writeExportStream(targetPath, toLine, records) {
  const resolved = resolveWithin(PACKAGE_DIR, targetPath, null)
  if (!resolved) {
    return {
      ok: false,
      diagnostic: diagnostic({
        error_code: EXPERIENCE_CODES.EXPORT_PATH_UNSAFE,
        severity: SEVERITY.ERROR,
        message: `导出路径越出插件包目录，已拒绝：${targetPath}`,
        suggested_fix: '导出路径必须是相对插件包目录的相对路径，例如 data/experiences/experiences.jsonl。',
      }),
    }
  }

  const { mkdir } = await import('node:fs/promises')
  const { createWriteStream } = await import('node:fs')
  const { dirname } = await import('node:path')
  await mkdir(dirname(resolved), { recursive: true })

  return new Promise((resolvePromise, rejectPromise) => {
    const stream = createWriteStream(resolved, { encoding: 'utf8' })
    let failed = false
    stream.on('error', (error) => {
      if (failed) return
      failed = true
      rejectPromise(error)
    })
    stream.on('finish', () => {
      if (!failed) resolvePromise({ ok: true, path: resolved })
    })
    try {
      for (const record of records) {
        stream.write(toLine(record) + '\n')
      }
      stream.end()
    } catch (error) {
      if (!failed) {
        failed = true
        rejectPromise(error)
      }
    }
  })
}

export async function readImportFile(sourcePath) {
  const resolved = resolveWithin(PACKAGE_DIR, sourcePath, null)
  if (!resolved) {
    if (!sourcePath || !resolve(sourcePath)) {
      throw Object.assign(new Error('导入路径不可用。'), { code: 'EXPERIENCE_IMPORT_PATH_UNSAFE' })
    }
  }
  const { readFile } = await import('node:fs/promises')
  return readFile(resolved ?? resolve(sourcePath), 'utf8')
}
