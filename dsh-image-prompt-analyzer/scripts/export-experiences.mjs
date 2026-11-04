#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openKnowledgeDatabase } from '../lib/kb/db.js'
import {
  experienceStats,
  importExperiences,
  listExperiences,
  parseJsonl,
  toJsonl,
} from '../lib/experience/store.js'
import { createConfigStore } from '../lib/config/index.js'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

export function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const eq = token.indexOf('=')
    if (eq > 0) {
      args[token.slice(2, eq)] = token.slice(eq + 1)
      continue
    }
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = next
      index += 1
    }
  }
  return args
}

function resolveFromPackage(value) {
  return isAbsolute(value) ? value : resolve(PACKAGE_DIR, value)
}

async function resolvePaths(args) {
  if (args.db) return { dbPath: resolveFromPackage(args.db), exportPath: args.out ? resolveFromPackage(args.out) : null }

  const store = createConfigStore({ configDir: resolve(PACKAGE_DIR, 'configs'), dataDir: resolve(PACKAGE_DIR, 'data') })
  await store.get()
  const kbConfig = store.getKnowledgeBase()
  const dbPath = resolveFromPackage(String(kbConfig?.storage?.database_path ?? 'data/knowledge.sqlite3'))
  const exportPath = args.out
    ? resolveFromPackage(args.out)
    : resolveFromPackage(String(kbConfig?.storage?.experience_export_path ?? 'data/experiences/experiences.jsonl'))
  return { dbPath, exportPath }
}

async function main(argv) {
  const args = parseArgs(argv)
  const { dbPath, exportPath } = await resolvePaths(args)

  const handle = openKnowledgeDatabase({ path: dbPath, createIfMissing: true, logger: null })
  try {
    if (args.stats) {
      console.log(JSON.stringify(experienceStats(handle), null, 2))
      return 0
    }

    if (args.import) {
      const source = resolveFromPackage(String(args.import))
      const text = await readFile(source, 'utf8')
      const parsed = parseJsonl(text, { tolerant: true })
      const result = importExperiences(handle, parsed.records)
      console.log(`导入 ${result.imported} 条，跳过 ${result.skipped + parsed.skipped.length} 条。`)
      for (const item of parsed.skipped) console.warn(`  第 ${item.line} 行：${item.message}`)
      return 0
    }

    const rows = listExperiences(handle, {
      limit: args.limit ? Number(args.limit) : 100000,
      targetModel: args.model ? String(args.model) : null,
    })
    const text = toJsonl(rows)
    await mkdir(dirname(exportPath), { recursive: true })
    await writeFile(exportPath, text, 'utf8')
    console.log(`导出 ${rows.length} 条经验到 ${exportPath}`)
    if (rows.length === 0) console.log('（经验库是空的；analyze_image_prompt 的 save_experience 默认为 false。）')
    return 0
  } finally {
    handle.close()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(`导出失败：${error?.message ?? error}`)
      process.exitCode = 1
    })
}
