
// 绘画工作室 SQLite 词库的只读适配器。
//
// 这个文件只做三件事：把别人的表结构读懂、把行翻成插件内部记录、把源库指纹算出来。
// 它不写源库、不迁移源库、不假设源库一定是"工作室"出品——任何一张符合
// tags(en, category, post_count, …) 契约的 SQLite 都能读。
//
// 契约（P0-2）：
//   en                 → tags.name / canonical_name
//   zh                 → tags.zh_name
//   category           → tags.native_category（Danbooru 五类，不是插件的 15 个内部分类）
//   post_count         → tags.post_count
//   aliases            → tag_aliases（空格或逗号分隔）
//   deprecated         → tags.deprecated
//   tag_group          → tags.tag_group
//   translation_status → tags.translation_status
//   updated_at         → tags.updated_at
//
// 源库里没有的列一律当"来源没声明"，不编造默认值：zh 空就是空，
// deprecated 列不存在就是 0（= 来源没说它废弃），而不是猜成 1。

import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'

import { KnowledgeBaseError, listTables, openSourceDatabase } from '../db.js'
import { inferTagKind, normalizeNativeCategory } from '../kind.js'
import { normalizeTagName } from '../normalize.js'
import { resolveTreeSeedPaths } from '../tree.js'

export const STUDIO_SOURCE_TYPE = 'studio_sqlite'

export const STUDIO_ADAPTER = 'studio-sqlite'

export const STUDIO_ADAPTER_VERSION = '1.0'

export const STUDIO_CODES = Object.freeze({
  SCHEMA: 'KB_STUDIO_SCHEMA',
  NOT_SQLITE: 'KB_STUDIO_NOT_SQLITE',
  EMPTY: 'KB_STUDIO_EMPTY',
  FINGERPRINT_FAILED: 'KB_STUDIO_FINGERPRINT_FAILED',
  READONLY_VIOLATION: 'KB_STUDIO_READONLY_VIOLATION',
})

const REQUIRED_COLUMNS = Object.freeze(['en', 'category', 'post_count'])

const OPTIONAL_COLUMNS = Object.freeze(['id', 'zh', 'aliases', 'deprecated', 'tag_group', 'translation_status', 'updated_at'])

// 中文名可信度里，只有这些状态是"人看过的"。其余都算机器初稿。
// 编译器不按它取舍，报告里用它区分"机器初稿"和"已审核"。
export const REVIEWED_TRANSLATION_STATUSES = Object.freeze([
  'wiki_definition_reviewed',
  'wiki_zh_selected',
  'user_glossary',
  'curated',
  'manual',
])

function studioError(code, message, { detail = null, suggestedFix = null, fieldPath = null } = {}) {
  return new KnowledgeBaseError(code, message, { detail, suggestedFix, configFile: 'knowledge-base', fieldPath })
}

/**
 * 源库指纹：整份文件的 sha256。
 *
 * 用内容而不是 mtime 或 size：工作室那边重新导出一次，文件大小和行数都可能一字不变，
 * 只有内容哈希能说明"这份数据确实换过"。分块读，避免把几百 MB 的库一次读进内存。
 */
export function hashFile(path) {
  const hash = createHash('sha256')
  const chunk = Buffer.allocUnsafe(1024 * 1024)
  let fd
  try {
    fd = openSync(path, 'r')
    let read = 0
    while ((read = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      hash.update(chunk.subarray(0, read))
    }
  } catch (error) {
    throw studioError(STUDIO_CODES.FINGERPRINT_FAILED, `计算源库指纹失败：${error?.message ?? error}`, {
      detail: 'FILE_UNREADABLE',
      fieldPath: '/sources/*/path',
      suggestedFix: '确认该文件存在且当前账户可读。',
    })
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // 关句柄失败不影响已经算出来的指纹。
      }
    }
  }
  return hash.digest('hex')
}

function readColumns(handle, table = 'tags') {
  return handle.all(`PRAGMA table_info(${table})`).map((row) => ({
    name: String(row.name),
    type: row.type === null ? null : String(row.type),
    notnull: Number(row.notnull ?? 0),
    pk: Number(row.pk ?? 0),
  }))
}

// 列结构哈希：用来判断"源库的表结构有没有变"，和文件指纹分开记。
function schemaHash(columns) {
  const text = columns.map((column) => `${column.name}:${column.type ?? ''}`).join('|')
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * 源库体检：不写任何东西，只回答"能不能用、有多大、有哪些可选列缺失"。
 *
 * 结果里所有计数都是真读出来的，不是估算——诊断报告要能拿去和
 * RELEASE_MANIFEST.json 里的 database_counts 对账。
 */
export async function inspectStudioDatabase({ path, logger = null, fingerprint = true } = {}) {
  let bytes = null
  try {
    bytes = statSync(path).size
  } catch (error) {
    throw studioError(STUDIO_CODES.NOT_SQLITE, `外部源库不可读：${error?.message ?? error}`, {
      detail: 'FILE_MISSING',
      fieldPath: '/sources/*/path',
      suggestedFix: '确认该路径存在且当前账户可读；相对路径以插件包目录为基准，绝对路径直接使用。',
    })
  }

  const handle = await openSourceDatabase({ path, logger })
  try {
    let tables
    try {
      tables = listTables(handle)
    } catch (error) {
      throw studioError(STUDIO_CODES.NOT_SQLITE, `读取 sqlite_master 失败，这个文件可能不是 SQLite 数据库：${error?.message ?? error}`, {
        fieldPath: '/sources/*/path',
        suggestedFix: '确认 path 指向 .sqlite / .sqlite3 / .db 文件，而不是导出的表格或压缩包。',
      })
    }

    if (!tables.includes('tags')) {
      throw studioError(
        STUDIO_CODES.SCHEMA,
        `外部源库里没有 tags 表（现有表：${tables.join(', ') || '无'}）。`,
        {
          fieldPath: '/sources/*/path',
          suggestedFix: '工作室公开版的数据文件是 data/tags.sqlite，里面应当有 tags 表。',
        },
      )
    }

    const columns = readColumns(handle)
    const names = columns.map((column) => column.name)
    const missing = REQUIRED_COLUMNS.filter((name) => !names.includes(name))
    if (missing.length > 0) {
      throw studioError(
        STUDIO_CODES.SCHEMA,
        `外部源库的 tags 表缺少必需列：${missing.join(', ')}（实际列：${names.join(', ')}）。`,
        {
          fieldPath: '/sources/*/path',
          suggestedFix: '至少需要 en / category / post_count 三列；zh、aliases、deprecated、tag_group、translation_status、updated_at 可选。',
        },
      )
    }

    const has = (name) => names.includes(name)
    const row = handle.get(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN ${has('deprecated') ? 'deprecated' : '0'} = 0 THEN 1 ELSE 0 END) AS active
       FROM tags`,
    )
    const total = Number(row?.total ?? 0)
    const active = Number(row?.active ?? 0)

    const translationStatusCounts = has('translation_status')
      ? handle
          .all('SELECT translation_status AS status, COUNT(*) AS n FROM tags GROUP BY translation_status ORDER BY n DESC')
          .map((item) => ({ status: item.status === null ? null : String(item.status), count: Number(item.n) }))
      : []

    const tagGroupCounts = has('tag_group')
      ? handle
          .all('SELECT tag_group AS name, COUNT(*) AS n FROM tags GROUP BY tag_group ORDER BY n DESC')
          .map((item) => ({ name: item.name === null ? null : String(item.name), count: Number(item.n) }))
      : []

    const categoryCounts = handle
      .all('SELECT category AS name, COUNT(*) AS n FROM tags GROUP BY category ORDER BY n DESC')
      .map((item) => ({ name: item.name === null ? null : String(item.name), count: Number(item.n) }))

    const updatedAtRange = has('updated_at')
      ? handle.get('SELECT MIN(updated_at) AS oldest, MAX(updated_at) AS newest FROM tags')
      : { oldest: null, newest: null }

    const userCategories = tables.includes('user_categories')
      ? handle.get('SELECT COUNT(*) AS n FROM user_categories')
      : null

    const userCategoryLinks = tables.includes('user_category_tags')
      ? handle.get('SELECT COUNT(*) AS n FROM user_category_tags')
      : null

    const fts = tables.includes('tags_fts')

    return {
      ok: true,
      path,
      bytes,
      fingerprint: fingerprint ? hashFile(path) : null,
      schema_hash: schemaHash(columns),
      tables,
      columns: names,
      missing_optional: OPTIONAL_COLUMNS.filter((name) => !names.includes(name)),
      row_count: total,
      active_count: active,
      deprecated_count: total - active,
      category_counts: categoryCounts,
      translation_status_counts: translationStatusCounts,
      tag_group_counts: tagGroupCounts,
      reviewed_translation_count: translationStatusCounts
        .filter((item) => REVIEWED_TRANSLATION_STATUSES.includes(item.status))
        .reduce((sum, item) => sum + item.count, 0),
      updated_at_range: {
        oldest: updatedAtRange?.oldest === null || updatedAtRange?.oldest === undefined ? null : String(updatedAtRange.oldest),
        newest: updatedAtRange?.newest === null || updatedAtRange?.newest === undefined ? null : String(updatedAtRange.newest),
      },
      user_category_count: userCategories === null ? null : Number(userCategories?.n ?? 0),
      user_category_link_count: userCategoryLinks === null ? null : Number(userCategoryLinks?.n ?? 0),
      fts_index: fts,
      // 发行版剥离了画师目录，所以这三类通常是 0；这里只报告，不当作错误。
      has_artist_category: categoryCounts.some((item) => item.name === 'artist' && item.count > 0),
    }
  } finally {
    try {
      handle.close()
    } catch {
      // 只读句柄关不掉不影响体检结果。
    }
  }
}

// aliases 列在源库里是空格分隔的一串中文/英文别名（实测只有 16 条非空）。
// 逗号、顿号、分号、竖线也一并当分隔符：别人导出的库不一定会用空格。
const ALIAS_SEPARATOR = /[\s,，、;；|]+/

export function splitAliases(value, { self = null } = {}) {
  if (value === null || value === undefined) return []
  const text = String(value).trim()
  if (!text) return []
  const selfName = self === null || self === undefined ? null : normalizeTagName(self)
  const seen = new Set()
  const out = []
  for (const piece of text.split(ALIAS_SEPARATOR)) {
    const alias = piece.trim()
    if (!alias) continue
    const normalized = normalizeTagName(alias)
    if (!normalized) continue
    // 别名等于自己不算别名，否则每次查询都会先撞上一条自己到自己的"归一"。
    if (selfName !== null && normalized === selfName) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(alias)
  }
  return out
}

export function studioTagRecord(row, { sourceId }) {
  const name = normalizeTagName(row?.en)
  if (!name) return null
  const nativeCategory = normalizeNativeCategory(row?.category)
  const postCount = Number.isFinite(Number(row?.post_count)) ? Number(row?.post_count) : null
  const zh = row?.zh === null || row?.zh === undefined ? null : String(row.zh).trim()
  const tagGroup = row?.tag_group === null || row?.tag_group === undefined ? null : String(row.tag_group).trim()
  const translationStatus = row?.translation_status === null || row?.translation_status === undefined
    ? null
    : String(row.translation_status).trim()
  const updatedAt = row?.updated_at === null || row?.updated_at === undefined || String(row.updated_at).trim() === ''
    ? null
    : String(row.updated_at).trim()

  return {
    name,
    canonical_name: name,
    source_id: sourceId,
    native_category: nativeCategory,
    post_count: postCount,
    zh_name: zh === '' ? null : zh,
    kind: inferTagKind({ tag: name, native_category: nativeCategory }),
    // 源库明确给了 deprecated 就用它的值；没有这一列就是"来源没说"，记 0。
    deprecated: Number(row?.deprecated ?? 0) === 1 ? 1 : 0,
    tag_group: tagGroup === '' ? null : tagGroup,
    translation_status: translationStatus === '' ? null : translationStatus,
    updated_at: updatedAt,
    aliases: splitAliases(row?.aliases, { self: name }),
  }
}

/**
 * 把源库里的标签全部读成插件内部记录。
 *
 * 一次全读、返回数组，而不是游标边读边写：导入要在单个事务里完成，
 * 读阶段失败时插件库必须一个字节都没动（P0-3 的"失败保留旧快照"）。
 */
export async function readStudioTags({ path, sourceId, limit = null, logger = null } = {}) {
  const handle = await openSourceDatabase({ path, logger })
  const records = []
  let skipped = 0
  let aliasCount = 0
  try {
    const columns = readColumns(handle).map((column) => column.name)
    const has = (name) => columns.includes(name)
    const select = [
      'en',
      'category',
      has('post_count') ? 'post_count' : 'NULL AS post_count',
      has('zh') ? 'zh' : 'NULL AS zh',
      has('aliases') ? 'aliases' : 'NULL AS aliases',
      has('deprecated') ? 'deprecated' : '0 AS deprecated',
      has('tag_group') ? 'tag_group' : 'NULL AS tag_group',
      has('translation_status') ? 'translation_status' : 'NULL AS translation_status',
      has('updated_at') ? 'updated_at' : 'NULL AS updated_at',
    ].join(', ')
    const sql = `SELECT ${select} FROM tags ORDER BY ${has('post_count') ? 'post_count DESC NULLS LAST' : 'rowid'}`
    const statement = handle.all(sql)
    const capped = Number.isInteger(limit) && limit > 0 ? statement.slice(0, limit) : statement
    for (const row of capped) {
      const record = studioTagRecord(row, { sourceId })
      if (record === null) {
        skipped += 1
        continue
      }
      aliasCount += record.aliases.length
      records.push(record)
    }
  } finally {
    try {
      handle.close()
    } catch {
      // 同上。
    }
  }
  if (records.length === 0) {
    throw studioError(STUDIO_CODES.EMPTY, `源库 tags 表里没有可用的标签行（${path}）。`, {
      fieldPath: '/sources/*/path',
      suggestedFix: '确认 tags 表的 en 列有值；空库或只有废弃行的库导进来也没意义。',
    })
  }
  return { records, skipped, aliases: aliasCount }
}

/**
 * 工作室的"用户分类"：一张自建的分类表 + 一张多对多关联表。
 *
 * 这是纯中文的检索线索（"发型变化""眼睛的变化"），不是模型分类，
 * 所以单独存一张表，绝不写进 tag_categories。
 */
export async function readStudioUserCategories({ path, logger = null } = {}) {
  const handle = await openSourceDatabase({ path, logger })
  try {
    const tables = listTables(handle)
    if (!tables.includes('user_categories')) return []
    const hasLinks = tables.includes('user_category_tags')
    const rows = hasLinks
      ? handle.all(
          `SELECT c.name AS name, c.sort_order AS sort_order, COUNT(l.tag_id) AS n
           FROM user_categories c
           LEFT JOIN user_category_tags l ON l.category_id = c.id
           GROUP BY c.id
           ORDER BY c.sort_order ASC, c.name ASC`,
        )
      : handle.all('SELECT name AS name, sort_order AS sort_order, 0 AS n FROM user_categories ORDER BY sort_order ASC, name ASC')
    return rows
      .map((row) => ({
        name: row.name === null || row.name === undefined ? null : String(row.name),
        sort_order: Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : 0,
        tag_count: Number(row.n ?? 0),
      }))
      .filter((row) => row.name !== null && row.name.trim() !== '')
  } finally {
    try {
      handle.close()
    } catch {
      // 同上。
    }
  }
}

/**
 * 读工作室的分类树与标签归属。
 *
 * 数据来自两个地方，缺一不可：
 *   - `<dbDir>/../ui/*.json` 两份种子：分类 ID、名字、父子关系（只有层级，没有标签归属）；
 *   - 源库的 user_categories / user_category_tags：排序、成员数与「哪些标签挂在这个分类下」。
 *
 * 发行版实测：1208 个分类、12873 条归属，其中 1198 个分类能在种子树里按 ID 对上同名节点，
 * 剩下 10 个（主要改动 / 整体服装的变化 …）是种子树里没有的独立分类，按根节点处理。
 * 两边都不是"必须齐全"：种子缺了就只导库里的，库缺了就只导种子，只是归属会少。
 */
export async function readStudioCategories({ path, logger = null } = {}) {
  const diagnostics = []
  const dbPath = String(path ?? '')
  const seedPaths = resolveTreeSeedPaths(dbPath)

  const seedNodes = new Map()
  for (const [key, file] of Object.entries(seedPaths ?? {})) {
    if (!file || !existsSync(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const nodes = parsed?.nodes ?? parsed
      for (const [id, node] of Object.entries(nodes ?? {})) {
        if (!node || typeof node !== 'object') continue
        seedNodes.set(String(id), {
          name: node.name === null || node.name === undefined ? null : String(node.name),
          parent: node.parent === null || node.parent === undefined ? null : String(node.parent),
          origin: key,
        })
      }
    } catch (error) {
      diagnostics.push(
        diagnostic({
          error_code: STUDIO_CODES.SCHEMA,
          severity: SEVERITY.WARNING,
          field_path: '/sources',
          message: `分类树种子 ${file} 读不出来：${error?.message ?? error}，本次只用源库里的分类。`,
          suggested_fix: '确认 ui/ 下的种子文件是合法 JSON；不影响标签导入，只是少一层层级。',
        }),
      )
    }
  }

  const rows = []
  const links = []
  const handle = await openSourceDatabase({ path: dbPath, logger })
  try {
    const tables = listTables(handle)
    if (tables.includes('user_categories')) {
      const categories = handle.all('SELECT id, name, sort_order FROM user_categories ORDER BY id ASC')
      for (const row of categories) {
        rows.push({
          studio_id: String(row.id),
          name: row.name === null || row.name === undefined ? '' : String(row.name),
          sort_order: Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : 0,
        })
      }
    }
    if (tables.includes('user_category_tags') && tables.includes('tags')) {
      const joined = handle.all(
        `SELECT l.category_id AS category_id, g.en AS en, g.id AS tag_id
           FROM user_category_tags l
           JOIN tags g ON g.id = l.tag_id`,
      )
      for (const row of joined) {
        const name = normalizeTagName(row.en ?? '')
        if (!name) continue
        links.push({ studio_id: String(row.category_id), tag_name: name, studio_tag_id: String(row.tag_id) })
      }
    }
  } finally {
    try {
      handle.close()
    } catch {
      // 与 readStudioUserCategories 同：关不上不影响已经读到的数据。
    }
  }

  const known = new Map()
  for (const row of rows) {
    if (!row.name.trim()) continue
    known.set(row.studio_id, row)
  }
  // 种子里有、库里没有的分类也导进来：ID 与父子关系还在，只是没有成员数。
  for (const [id, node] of seedNodes) {
    if (known.has(id) || !node.name || !node.name.trim()) continue
    known.set(id, { studio_id: id, name: node.name, sort_order: 0 })
  }

  // 深度用 BFS 算，遇到环就停在 MAX_DEPTH，不递归到底。
  const depthOf = new Map()
  const parentOf = new Map()
  let seedMismatch = 0
  // 先算「可信节点」：名字与种子一致（或本来就只来自种子）。
  // 只有可信节点之间才接父子关系——ID 对得上、名字对不上说明种子和源库不是同一版，
  // 硬接会把标签挂到不相干的分类下面，比没有层级更糟。
  const trusted = new Set()
  for (const [id, row] of known) {
    const seed = seedNodes.get(id)
    const sameName = Boolean(seed) && seed.name !== null && seed.name === row.name
    if (seed && seed.name !== null && !sameName) seedMismatch += 1
    if (sameName) trusted.add(id)
  }
  for (const [id] of known) {
    const parent = trusted.has(id) ? seedNodes.get(id)?.parent ?? null : null
    parentOf.set(id, parent && trusted.has(parent) && parent !== id ? parent : null)
  }
  const childrenOf = new Map()
  for (const [id, parent] of parentOf) {
    if (!parent) continue
    if (!childrenOf.has(parent)) childrenOf.set(parent, [])
    childrenOf.get(parent).push(id)
  }
  const queue = [...known.keys()].filter((id) => parentOf.get(id) === null)
  for (const id of queue) depthOf.set(id, 0)
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]
    const depth = depthOf.get(id) ?? 0
    if (depth >= 32) continue
    for (const child of childrenOf.get(id) ?? []) {
      if (depthOf.has(child)) continue
      depthOf.set(child, depth + 1)
      queue.push(child)
    }
  }
  // 环里的节点没被 BFS 摸到：按根处理，深度 0，并说一声。
  const unreached = [...known.keys()].filter((id) => !depthOf.has(id))
  if (unreached.length > 0) {
    for (const id of unreached) depthOf.set(id, 0)
    diagnostics.push(
      diagnostic({
        error_code: STUDIO_CODES.SCHEMA,
        severity: SEVERITY.WARNING,
        field_path: '/sources',
        message: `分类树里有 ${unreached.length} 个分类的父节点连不成根（疑似环或父节点缺失），已按根节点处理。`,
        suggested_fix: '通常是种子文件与源库版本不一致；重新导入一次工作室包即可。',
      }),
    )
  }

  const tagCount = new Map()
  for (const link of links) tagCount.set(link.studio_id, (tagCount.get(link.studio_id) ?? 0) + 1)

  const categories = [...known.values()]
    .map((row) => ({
      studio_id: row.studio_id,
      name: row.name,
      parent_id: parentOf.get(row.studio_id) ?? null,
      sort_order: row.sort_order,
      depth: depthOf.get(row.studio_id) ?? 0,
      tag_count: tagCount.get(row.studio_id) ?? 0,
      origin: seedNodes.get(row.studio_id)?.origin ?? 'user_categories',
    }))
    .sort((a, b) => a.depth - b.depth || a.sort_order - b.sort_order || a.name.localeCompare(b.name))

  return {
    categories,
    links,
    stats: {
      categories: categories.length,
      links: links.length,
      roots: categories.filter((row) => row.parent_id === null).length,
      depth_max: categories.reduce((max, row) => Math.max(max, row.depth), 0),
      seed_nodes: seedNodes.size,
      seed_mismatch: seedMismatch,
      linked_categories: tagCount.size,
    },
    diagnostics,
  }
}
