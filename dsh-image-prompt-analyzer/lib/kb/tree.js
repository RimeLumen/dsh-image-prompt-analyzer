import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { SEVERITY, diagnostic } from '../diagnostics.js'

/**
 * 工作室的分类树种子。
 *
 * 这两份文件描述的是"分类怎么分层"，不是"哪些标签属于哪一类"——种子里只有
 * `{name, parent}`，没有任何标签归属。所以它只用来回答"这个分支底下有什么"、
 * "某个分支的完整路径是什么"，不参与标签判定，也不参与编译。
 *
 * 发行包里它们躺在 `ui/` 下，和 `data/tags.sqlite` 是兄弟目录。插件不打包这两份
 * 文件：路径从用户配置的工作室词库位置推出来，推不出来就报一条警告，不影响其它功能。
 */
export const TREE_CODES = Object.freeze({
  MISSING: 'KB_STUDIO_TREE_MISSING',
  INVALID: 'KB_STUDIO_TREE_INVALID',
  ORPHAN: 'KB_STUDIO_TREE_ORPHAN',
  DUPLICATE_ID: 'KB_STUDIO_TREE_DUPLICATE_ID',
})

export const TREE_SEED_FILES = Object.freeze({
  visual_index: 'visual-index-seed.json',
  wiki_section: 'wiki-section-seed.json',
})

const MAX_DEPTH = 32

/**
 * 从工作室词库路径推出两份种子的位置。
 *
 * 发行包布局是 `<包根>/data/tags.sqlite` 与 `<包根>/ui/*.json`，所以先试兄弟目录 `ui/`，
 * 再试词库同目录（有人会把文件摊平放）。两个位置都没有就返回 null——不猜、不递归扫盘。
 */
export function resolveTreeSeedPaths(studioPath) {
  const raw = String(studioPath ?? '').trim()
  if (raw === '') return null
  const dbDir = dirname(raw)
  const candidates = [join(dbDir, '..', 'ui'), dbDir]
  for (const dir of candidates) {
    const visualIndex = join(dir, TREE_SEED_FILES.visual_index)
    const wikiSection = join(dir, TREE_SEED_FILES.wiki_section)
    if (existsSync(visualIndex) || existsSync(wikiSection)) return { visual_index: visualIndex, wiki_section: wikiSection }
  }
  return null
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 合并两份种子成一张树。
 *
 * 两份文件是互补的：visual-index 是 1–209 的骨架，wiki-section 是 210 起的分支叶子，
 * 后者的 parent 指向前者。所以必须先合并再算深度，单独看任何一份都有一堆"孤儿"。
 */
export function parseStudioTree({ visualIndex = null, wikiSection = null } = {}) {
  const nodes = new Map()
  const diagnostics = []
  let revision = null
  let duplicates = 0

  const add = (id, entry, origin) => {
    const key = String(id)
    if (!isPlainObject(entry)) return
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (name === '') return
    if (nodes.has(key)) {
      duplicates += 1
      return
    }
    nodes.set(key, {
      id: key,
      name,
      parent: entry.parent === null || entry.parent === undefined ? '' : String(entry.parent).trim(),
      origin,
    })
  }

  if (isPlainObject(visualIndex)) {
    for (const [id, entry] of Object.entries(visualIndex)) add(id, entry, 'visual_index')
  }
  if (isPlainObject(wikiSection?.nodes)) {
    revision = typeof wikiSection.revision === 'string' ? wikiSection.revision : null
    for (const [id, entry] of Object.entries(wikiSection.nodes)) add(id, entry, 'wiki_section')
  }

  if (duplicates > 0) {
    diagnostics.push(
      diagnostic({
        error_code: TREE_CODES.DUPLICATE_ID,
        severity: SEVERITY.WARNING,
        message: `两份分类树种子里有 ${duplicates} 个重复节点号，重复的已忽略。`,
        suggested_fix: '确认导出的两份种子来自同一次工作室快照。',
      }),
    )
  }

  if (nodes.size === 0) {
    diagnostics.push(
      diagnostic({
        error_code: TREE_CODES.MISSING,
        severity: SEVERITY.WARNING,
        message: '没有读到任何分类树节点。',
        suggested_fix: '确认 studio 源的 path 指向 data/tags.sqlite，且同级 ui/ 目录里有 visual-index-seed.json 与 wiki-section-seed.json。',
      }),
    )
    return { ok: false, revision, nodes, rootId: null, roots: [], stats: null, diagnostics }
  }

  const orphans = []
  for (const node of nodes.values()) {
    if (node.parent !== '' && !nodes.has(node.parent)) {
      orphans.push(node.id)
      node.parent = ''
    }
  }
  if (orphans.length > 0) {
    diagnostics.push(
      diagnostic({
        error_code: TREE_CODES.ORPHAN,
        severity: SEVERITY.WARNING,
        message: `${orphans.length} 个节点的父节点不在种子里，已按根节点处理（如 ${orphans.slice(0, 5).join(', ')}）。`,
        suggested_fix: '两份种子可能不是同一次导出的：重新导出 visual-index-seed.json 与 wiki-section-seed.json。',
      }),
    )
  }

  const children = new Map()
  const roots = []
  for (const node of nodes.values()) {
    if (node.parent === '') {
      roots.push(node.id)
      continue
    }
    if (!children.has(node.parent)) children.set(node.parent, [])
    children.get(node.parent).push(node.id)
  }

  const tree = assembleTree(nodes, { revision, duplicates, orphans: orphans.length })
  tree.diagnostics = diagnostics
  tree.source = 'seed'
  return tree
}

export function loadStudioTree({ studioPath = null, paths = null, logger = null } = {}) {
  const resolved = paths ?? resolveTreeSeedPaths(studioPath)
  if (!resolved) {
    return {
      ok: false,
      revision: null,
      nodes: new Map(),
      rootId: null,
      roots: [],
      stats: null,
      paths: null,
      diagnostics: [
        diagnostic({
          error_code: TREE_CODES.MISSING,
          severity: SEVERITY.INFO,
          message: '没有找到分类树种子（ui/visual-index-seed.json 与 ui/wiki-section-seed.json）。',
          suggested_fix: '分类树只用于浏览分支，不影响标签检索与编译；需要浏览时把种子留在工作室包的 ui/ 目录里即可。',
        }),
      ],
    }
  }

  const read = (path) => {
    if (!path || !existsSync(path)) return null
    try {
      return readJson(path)
    } catch (error) {
      logger?.warn?.(`读取分类树种子失败：${path}`, error)
      return null
    }
  }

  const visualIndex = read(resolved.visual_index)
  const wikiSection = read(resolved.wiki_section)
  const tree = parseStudioTree({ visualIndex, wikiSection })
  return { ...tree, paths: resolved }
}

/**
 * 把一堆 `{id, name, parent}` 组装成树。
 *
 * 种子文件与数据库里存的分类行最后都走这一条路：孤儿改根、算深度、算子节点。
 * 分开写两份会慢慢跑偏，所以合并成一处。
 */
function assembleTree(nodes, { revision = null, duplicates = 0, orphans = [] } = {}) {
  const children = new Map()
  const roots = []
  for (const node of nodes.values()) {
    if (node.parent === '') {
      roots.push(node.id)
      continue
    }
    if (!children.has(node.parent)) children.set(node.parent, [])
    children.get(node.parent).push(node.id)
  }

  const depthOf = (id) => {
    let depth = 0
    let cursor = nodes.get(id)
    const seen = new Set()
    while (cursor && cursor.parent !== '' && !seen.has(cursor.id)) {
      seen.add(cursor.id)
      cursor = nodes.get(cursor.parent)
      depth += 1
      if (depth > MAX_DEPTH) break
    }
    return depth
  }

  for (const node of nodes.values()) {
    node.depth = depthOf(node.id)
    node.children = children.get(node.id) ?? []
  }

  const leaves = [...nodes.values()].filter((node) => node.children.length === 0).length
  const depthMax = nodes.size > 0 ? Math.max(...[...nodes.values()].map((node) => node.depth)) : 0
  return {
    ok: nodes.size > 0,
    revision,
    nodes,
    rootId: roots.length === 1 ? roots[0] : null,
    roots,
    stats: { nodes: nodes.size, leaves, depth_max: depthMax, roots: roots.length, duplicates, orphans: orphans.length },
  }
}

/**
 * 从数据库里的分类行建树。
 *
 * 迁移导入之后，层级就已经在 `studio_categories` 里了（导入时由种子算出 parent 与 depth）。
 * 这里只需要按 parent 重新拼一次——运行时不读任何种子文件，工作室目录可以整个不在了。
 */
export function treeFromCategoryRows(rows = [], { revision = null } = {}) {
  const nodes = new Map()
  let duplicates = 0
  for (const row of rows) {
    const id = String(row?.studio_id ?? row?.id ?? '').trim()
    const name = String(row?.name ?? '').trim()
    if (id === '' || name === '') continue
    if (nodes.has(id)) {
      duplicates += 1
      continue
    }
    const parent = String(row?.parent_id ?? '').trim()
    nodes.set(id, { id, name, parent: parent === id ? '' : parent, origin: row?.origin ?? null })
  }

  const orphans = []
  for (const node of nodes.values()) {
    if (node.parent !== '' && !nodes.has(node.parent)) {
      orphans.push(node.id)
      node.parent = ''
    }
  }

  const tree = assembleTree(nodes, { revision, duplicates, orphans })
  tree.source = 'database'
  tree.diagnostics = []
  return tree
}

/** 从某个节点往上走到根，返回 `[{id, name}]`。 */
export function treePath(tree, id) {
  const nodes = tree?.nodes
  if (!(nodes instanceof Map)) return []
  const out = []
  let cursor = nodes.get(String(id))
  const seen = new Set()
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    out.unshift({ id: cursor.id, name: cursor.name })
    cursor = cursor.parent === '' ? null : nodes.get(cursor.parent)
  }
  return out
}

/** 子树展平（含自身），用于"这个分支底下有什么"。 */
export function treeSubtree(tree, id, { limit = 200 } = {}) {
  const nodes = tree?.nodes
  if (!(nodes instanceof Map)) return []
  const root = nodes.get(String(id))
  if (!root) return []
  const out = []
  const queue = [root]
  while (queue.length > 0 && out.length < limit) {
    const node = queue.shift()
    out.push(node)
    for (const childId of node.children) {
      const child = nodes.get(childId)
      if (child) queue.push(child)
    }
  }
  return out
}

/**
 * 按名字找分支。
 *
 * 只做"名字里含这个词"的匹配：种子没有标签归属，也就没有别的可用信号。
 * 结果按"层级浅的在前、子节点多的在前"排，方便先看到主干再看到细分。
 */
export function searchTree(tree, query, { limit = 20 } = {}) {
  const nodes = tree?.nodes
  if (!(nodes instanceof Map)) return []
  const text = String(query ?? '').trim().toLowerCase()
  if (text === '') return []
  const hits = []
  for (const node of nodes.values()) {
    if (!node.name.toLowerCase().includes(text)) continue
    hits.push(node)
  }
  hits.sort((a, b) => a.depth - b.depth || b.children.length - a.children.length || a.name.localeCompare(b.name))
  return hits.slice(0, Math.max(1, Number(limit) || 20)).map((node) => ({
    id: node.id,
    name: node.name,
    depth: node.depth,
    children: node.children.length,
    path: treePath(tree, node.id).map((item) => item.name),
  }))
}
