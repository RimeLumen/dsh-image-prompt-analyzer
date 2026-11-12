import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import { PACKAGE_DIR, resolveWithin } from '../../paths.js'
import { treeFromCategoryRows } from '../../kb/tree.js'
import { countAllStudioCategories, listAllStudioCategories } from '../../kb/store.js'
import { STUDIO_SOURCE_TYPE } from '../../kb/index.js'

/**
 * 配置里的工作室源，路径已解析成绝对路径；解析不出来的跳过。
 *
 * 这个路径只用于三件事：导入、主动更新、溯源。日常检索与编译不读它——
 * 数据在迁移导入时已经整份搬进插件自己的知识库了。
 *
 * `includeDisabled` 是给"看看当初配过哪些源"用的：关掉的源仍然能被诊断报出来，
 * 但不参与任何查询。
 */
export function studioSourcePaths(config, { includeDisabled = false } = {}) {
  const sources = Array.isArray(config?.sources) ? config.sources : []
  const out = []
  for (const source of sources) {
    if (source?.type !== STUDIO_SOURCE_TYPE) continue
    if (source?.enabled === false && !includeDisabled) continue
    const declared = typeof source?.path === 'string' ? source.path.trim() : ''
    if (declared === '') continue
    const absolute = isAbsolute(declared) ? declared : resolveWithin(PACKAGE_DIR, declared)
    if (!absolute) continue
    out.push({
      source_id: String(source.source_id ?? ''),
      path: absolute,
      enabled: source?.enabled !== false,
      exists: existsSync(absolute),
    })
  }
  return out
}

/**
 * 分类树按句柄缓存。
 *
 * 拼一次树要读两万行分类行，检索工具会被连续调用，每次都重读没有必要。
 * 缓存键是句柄本身（WeakMap，句柄回收即失效），另存一份行数签名——
 * 重新导入后行数变了，缓存自动作废。
 */
const treeCache = new WeakMap()

export function studioTreeFor(config = null, logger = null, { handle = null } = {}) {
  if (!handle) {
    return {
      ok: false,
      revision: null,
      nodes: new Map(),
      rootId: null,
      roots: [],
      stats: null,
      source: 'unavailable',
      diagnostics: [],
    }
  }

  let signature = null
  try {
    const counts = countAllStudioCategories(handle)
    signature = `${counts.categories}:${counts.links}`
    if (counts.categories === 0) {
      return {
        ok: false,
        revision: null,
        nodes: new Map(),
        rootId: null,
        roots: [],
        stats: null,
        source: 'unavailable',
        diagnostics: [],
      }
    }
  } catch (error) {
    logger?.warn?.('读取工作室分类树失败', error)
    return {
      ok: false,
      revision: null,
      nodes: new Map(),
      rootId: null,
      roots: [],
      stats: null,
      source: 'unavailable',
      diagnostics: [],
    }
  }

  const cached = treeCache.get(handle)
  if (cached && cached.signature === signature) return cached.tree

  const rows = listAllStudioCategories(handle)
  const tree = treeFromCategoryRows(rows)
  treeCache.set(handle, { signature, tree })
  return tree
}

export function clearStudioTreeCache() {
  // WeakMap 没有 clear：换句柄自然换缓存。这里保留函数是为了让调用方不用改。
}
