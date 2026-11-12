// 工作室词库（studio_sqlite）回归基线。
//
// 这个文件覆盖 v2.1 接进来的第三类数据源：绘画工作室导出的 tags.sqlite。
// 它不读 G 盘，不读发行包，不联网——所有 fixture 都在临时目录里现造，
// 所以换一台没有那个目录的机器，`npm test` 照样全绿。
//
// 钉死的是契约，不是实现细节：
//   1. 源库只读打开，query_only 生效，导入不改源文件；
//   2. en/zh/category/post_count/aliases/deprecated/tag_group/translation_status
//      怎么落到插件库里；
//   3. 重复导入幂等、失败保留旧快照；
//   4. 工作室词表不冒充模型词表，除非显式打开 fallback；
//   5. 配置校验放行外部绝对路径，但只放行 studio_sqlite。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { KB_SCHEMA_VERSION, openKnowledgeDatabase, openSourceDatabase, readMeta, writeMeta } from '../lib/kb/db.js'
import { META_KEYS } from '../lib/kb/schema.js'
import {
  STUDIO_ADAPTER,
  STUDIO_ADAPTER_VERSION,
  STUDIO_CODES,
  STUDIO_SOURCE_TYPE,
  hashFile,
  inspectStudioDatabase,
  readStudioCategories,
  readStudioTags,
  readStudioUserCategories,
  splitAliases,
  studioTagRecord,
} from '../lib/kb/adapters/studio-sqlite.js'
import { importLocalFileSource, importStudioSource } from '../lib/kb/import.js'
import {
  countStudioCategories,
  listSourceUserCategories,
  listStudioCategories,
  readSourceMeta,
  studioCategoriesForTag,
  studioCategoryPath,
  studioCategoryTagNames,
} from '../lib/kb/store.js'
import { createKnowledgeBase } from '../lib/kb/query.js'
import { resolveTerms } from '../lib/compile/resolve.js'
import { crossValidateKnowledgeBase } from '../lib/config/cross/knowledge-base.js'
import { studioSourceDiagnostics } from '../lib/runtime/knowledge.js'
import { inspectSources } from '../lib/tools/impl/diagnose/sources.js'
import { runSearchTags } from '../lib/tools/impl/search-tags.js'
import { runExplainTag } from '../lib/tools/impl/explain-tag.js'
import { runCompileBasket } from '../lib/tools/impl/compile-basket.js'
import { createConfigStore, resolveProfileRequest } from '../lib/config/loader.js'
import { registerAllTools } from '../lib/tools/index.js'
import { compilePrompt } from '../lib/compile/index.js'
import { addFeature, createIR } from '../lib/ir/build.js'
import { buildAnalysisEnvelope } from '../lib/pipeline/stages.js'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

// 六行 fixture 覆盖了真实发行版里会碰到的每一种状态：
// 已审核翻译、机器初稿、中文缺失、废弃、别名带多种分隔符、别名指向自己。
const FIXTURE_ROWS = [
  {
    id: 1,
    en: '1girl',
    zh: '一名女性角色',
    category: 'general',
    post_count: 1000,
    deprecated: 0,
    tag_group: '人物数量',
    translation_status: 'wiki_definition_reviewed',
    aliases: '一个女性角色 单女',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 2,
    en: 'highres',
    zh: '高分辨率',
    category: 'meta',
    post_count: 500,
    deprecated: 0,
    tag_group: '画质与媒介',
    translation_status: 'curated',
    aliases: '高分,高画质',
    updated_at: '2026-01-02T00:00:00.000Z',
  },
  {
    id: 3,
    en: 'long_hair',
    zh: null,
    category: 'general',
    post_count: 400,
    deprecated: 0,
    tag_group: '头发与五官',
    translation_status: 'machine_draft_1',
    aliases: '',
    updated_at: '2026-01-03T00:00:00.000Z',
  },
  {
    id: 4,
    en: 'old_tag',
    zh: '旧标签',
    category: 'general',
    post_count: 10,
    deprecated: 1,
    tag_group: '待归类',
    translation_status: 'draft',
    aliases: '',
    updated_at: '2026-01-04T00:00:00.000Z',
  },
  {
    id: 5,
    en: 'maid',
    zh: '女仆',
    category: 'general',
    post_count: 900,
    deprecated: 0,
    tag_group: '服装与饰品',
    translation_status: 'manual',
    aliases: '女仆装、メイド|maid_uniform',
    updated_at: '2026-01-05T00:00:00.000Z',
  },
  {
    id: 6,
    en: 'self_alias',
    zh: '自指',
    category: 'general',
    post_count: 5,
    deprecated: 0,
    tag_group: '待归类',
    translation_status: 'machine_draft_1_glossary',
    aliases: 'self_alias 自指别名',
    updated_at: '2026-01-06T00:00:00.000Z',
  },
]

const FIXTURE_USER_CATEGORIES = [
  { id: 1, name: 'BDSM 游戏', sort_order: 0, tags: [1, 5] },
  { id: 2, name: '主要', sort_order: 0, tags: [5] },
]

/**
 * 与 createStudioPackage 的种子同名的分类，用来测正常层级。
 * 树：1 视觉特征 → 2 画面构图与风格 → 3 画面构图 → 4 构图（4 来自 wiki-section）。
 */
const TREE_USER_CATEGORIES = [
  { id: 1, name: '视觉特征', sort_order: 0, tags: [1] },
  { id: 2, name: '画面构图与风格', sort_order: 0, tags: [5] },
  { id: 3, name: '画面构图', sort_order: 0, tags: [5] },
  { id: 4, name: '构图', sort_order: 0, tags: [1, 5] },
]

function tempDir(prefix = 'dsh-studio-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * 造一个工作室源库。omitColumns 用来模拟老版本导出（少列），
 * dropTagsTable 用来模拟"根本不是工作室库"的坏 schema。
 */
function createStudioDb(dir, {
  name = 'tags.sqlite',
  rows = FIXTURE_ROWS,
  userCategories = FIXTURE_USER_CATEGORIES,
  omitColumns = [],
  dropTagsTable = false,
} = {}) {
  const path = join(dir, name)
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    if (!dropTagsTable) {
      const definitions = [
        ['id', 'INTEGER PRIMARY KEY'],
        ['en', 'TEXT NOT NULL'],
        ['zh', 'TEXT'],
        ['category', 'TEXT NOT NULL'],
        ['post_count', 'INTEGER NOT NULL'],
        ['deprecated', 'INTEGER NOT NULL DEFAULT 0'],
        ['updated_at', 'TEXT'],
        ['tag_group', "TEXT NOT NULL DEFAULT '待归类'"],
        ['aliases', 'TEXT'],
        ['translation_status', "TEXT NOT NULL DEFAULT 'draft'"],
      ]
      const kept = definitions.filter(([column]) => !omitColumns.includes(column))
      db.exec(`CREATE TABLE tags (${kept.map(([column, type]) => `${column} ${type}`).join(', ')})`)
      const names = kept.map(([column]) => column)
      const insert = db.prepare(
        `INSERT INTO tags (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
      )
      for (const row of rows) {
        insert.run(...names.map((column) => row[column] ?? null))
      }
    }
    if (userCategories) {
      db.exec('CREATE TABLE user_categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL DEFAULT 0)')
      db.exec('CREATE TABLE user_category_tags (category_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (category_id, tag_id))')
      const addCategory = db.prepare('INSERT INTO user_categories (id, name, sort_order) VALUES (?, ?, ?)')
      const addTag = db.prepare('INSERT INTO user_category_tags (category_id, tag_id) VALUES (?, ?)')
      for (const category of userCategories) {
        addCategory.run(category.id, category.name, category.sort_order ?? 0)
        for (const tagId of category.tags ?? []) addTag.run(category.id, tagId)
      }
    }
  } finally {
    db.close()
  }
  return path
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 造一个插件侧空库（2.1 schema），调用方负责 close 与删目录。 */
async function tempPluginDb() {
  const dir = tempDir('dsh-kb-')
  const handle = await openKnowledgeDatabase({ path: join(dir, 'k.sqlite3'), readonly: false, createIfMissing: true })
  return { handle, dir }
}

function closeQuietly(target) {
  try {
    target?.close?.()
  } catch {
  }
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true })
}

// ───────────────────────── 契约：字段怎么映射 ─────────────────────────

test('studio 适配器把 en/zh/category/post_count 映射成插件库的列名', () => {
  const record = studioTagRecord(FIXTURE_ROWS[0], { sourceId: 'studio-tags' })
  assert.equal(record.name, '1girl')
  assert.equal(record.canonical_name, '1girl')
  assert.equal(record.zh_name, '一名女性角色')
  assert.equal(record.native_category, 'general')
  assert.equal(record.post_count, 1000)
  assert.equal(record.source_id, 'studio-tags')
  assert.equal(record.deprecated, 0)
  assert.equal(record.tag_group, '人物数量')
  assert.equal(record.translation_status, 'wiki_definition_reviewed')
  assert.equal(record.updated_at, '2026-01-01T00:00:00.000Z')
  assert.deepEqual(record.aliases, ['一个女性角色', '单女'])
})

test('studio 适配器保留 deprecated 与空中文，不自己编造中文名', () => {
  const deprecated = studioTagRecord(FIXTURE_ROWS[3], { sourceId: 'studio-tags' })
  assert.equal(deprecated.deprecated, 1)

  const noZh = studioTagRecord(FIXTURE_ROWS[2], { sourceId: 'studio-tags' })
  assert.equal(noZh.zh_name, null, '源库没给中文时必须是 null，不能填空串冒充已翻译')
  assert.equal(noZh.translation_status, 'machine_draft_1')
})

test('别名按空白、逗号、顿号、分号、竖线切分，并丢掉指向自己的别名', () => {
  assert.deepEqual(splitAliases('高分,高画质'), ['高分', '高画质'])
  assert.deepEqual(splitAliases('女仆装、メイド|maid_uniform'), ['女仆装', 'メイド', 'maid_uniform'])
  assert.deepEqual(splitAliases('self_alias 自指别名', { self: 'self_alias' }), ['自指别名'])
  assert.deepEqual(splitAliases('  '), [])
  assert.deepEqual(splitAliases(null), [])
})

// ───────────────────────── 源库体检与只读保护 ─────────────────────────

test('体检报告给出真实行数、废弃数、已审核翻译数与用户分类数', async () => {
  const dir = tempDir()
  try {
    const path = createStudioDb(dir)
    const inspection = await inspectStudioDatabase({ path })
    assert.equal(inspection.ok, true)
    assert.equal(inspection.row_count, FIXTURE_ROWS.length)
    assert.equal(inspection.deprecated_count, 1)
    assert.equal(inspection.active_count, FIXTURE_ROWS.length - 1)
    assert.equal(inspection.reviewed_translation_count, 3, 'wiki_definition_reviewed / curated / manual 三条算已审核')
    assert.equal(inspection.user_category_count, FIXTURE_USER_CATEGORIES.length)
    assert.equal(inspection.bytes, statSync(path).size)
    assert.equal(inspection.fingerprint, sha256(path))
    assert.equal(inspection.missing_optional.length, 0)
    const statusCount = (status) => inspection.translation_status_counts.find((item) => item.status === status)?.count ?? 0
    assert.equal(statusCount('machine_draft_1'), 1)
    assert.equal(statusCount('curated'), 1)
    const groupCount = (name) => inspection.tag_group_counts.find((item) => item.name === name)?.count ?? 0
    assert.equal(groupCount('待归类'), 2)
  } finally {
    cleanup(dir)
  }
})

test('源库少了几列时照常体检，把缺的列报出来而不是直接失败', async () => {
  const dir = tempDir()
  try {
    const path = createStudioDb(dir, { omitColumns: ['zh', 'aliases', 'deprecated', 'tag_group', 'translation_status', 'updated_at'] })
    const inspection = await inspectStudioDatabase({ path })
    assert.equal(inspection.ok, true)
    assert.equal(inspection.row_count, FIXTURE_ROWS.length)
    assert.ok(inspection.missing_optional.includes('zh'))
    assert.ok(inspection.missing_optional.includes('aliases'))
    assert.equal(inspection.deprecated_count, 0, '没有 deprecated 列时不能凭空算出一条废弃')
  } finally {
    cleanup(dir)
  }
})

test('不是工作室库的文件在体检阶段就报 schema 错，不会把别人的库当词表导进来', async () => {
  const dir = tempDir()
  try {
    const path = createStudioDb(dir, { dropTagsTable: true })
    await assert.rejects(
      () => inspectStudioDatabase({ path }),
      (error) => {
        assert.equal(error.code, STUDIO_CODES.SCHEMA)
        return true
      },
    )
  } finally {
    cleanup(dir)
  }
})

test('源库以只读 + query_only 打开，写操作被拒绝', async () => {
  const dir = tempDir()
  try {
    const path = createStudioDb(dir)
    const handle = await openSourceDatabase({ path })
    try {
      assert.equal(handle.readonly, true)
      assert.throws(() => handle.run("UPDATE tags SET zh = '改了' WHERE id = 1"))
      assert.throws(() => handle.run('DELETE FROM tags'))
    } finally {
      closeQuietly(handle)
    }
    // 拒绝写之后源文件一个字节都没变。
    assert.equal(sha256(path), (await inspectStudioDatabase({ path })).fingerprint)
  } finally {
    cleanup(dir)
  }
})

test('hashFile 与 node:crypto 算出来的 sha256 一致', async () => {
  const dir = tempDir()
  try {
    const path = createStudioDb(dir)
    assert.equal(hashFile(path), sha256(path))
  } finally {
    cleanup(dir)
  }
})

test('readStudioTags 一次读回全部标签，按 post_count 从高到低', async () => {
  const dir = tempDir()
  try {
    const path = createStudioDb(dir)
    const { records, skipped, aliases } = await readStudioTags({ path, sourceId: 'studio-tags' })
    assert.equal(records.length, FIXTURE_ROWS.length)
    assert.equal(skipped, 0)
    assert.equal(aliases, 8, '1girl 2 条、highres 2 条、maid 3 条、self_alias 1 条（自指被丢掉）')
    assert.deepEqual(records.map((r) => r.name), ['1girl', 'maid', 'highres', 'long_hair', 'old_tag', 'self_alias'])
  } finally {
    cleanup(dir)
  }
})

test('readStudioUserCategories 统计每个用户分类下挂了几个标签', async () => {
  const dir = tempDir()
  try {
    const path = createStudioDb(dir)
    const categories = await readStudioUserCategories({ path })
    assert.equal(categories.length, FIXTURE_USER_CATEGORIES.length)
    assert.equal(categories.find((c) => c.name === 'BDSM 游戏').tag_count, 2)
    assert.equal(categories.find((c) => c.name === '主要').tag_count, 1)
  } finally {
    cleanup(dir)
  }
})

// ───────────────────────── 导入：幂等、快照、指纹 ─────────────────────────

test('导入把标签、别名、用户分类、源库指纹一起写进插件库', async () => {
  const srcDir = tempDir()
  const { handle, dir } = await tempPluginDb()
  try {
    const path = createStudioDb(srcDir)
    const result = await importStudioSource({
      handle,
      sourceConfig: { source_id: 'studio-tags', type: STUDIO_SOURCE_TYPE, path },
    })

    assert.equal(result.source_id, 'studio-tags')
    assert.equal(result.adapter, STUDIO_ADAPTER)
    assert.equal(result.imported, FIXTURE_ROWS.length)
    assert.equal(result.aliases, 8)
    assert.equal(result.unchanged, false)

    const rows = handle.all('SELECT name, zh_name, deprecated, tag_group, translation_status FROM tags WHERE source_id = ? ORDER BY name', 'studio-tags')
    assert.equal(rows.length, FIXTURE_ROWS.length)
    const maid = rows.find((row) => row.name === 'maid')
    assert.equal(maid.zh_name, '女仆')
    assert.equal(maid.tag_group, '服装与饰品')
    assert.equal(maid.translation_status, 'manual')
    assert.equal(rows.find((row) => row.name === 'old_tag').deprecated, 1)
    assert.equal(rows.find((row) => row.name === 'long_hair').zh_name, null)

    const meta = readSourceMeta(handle, 'studio-tags')
    assert.equal(meta.adapter, STUDIO_ADAPTER)
    assert.equal(meta.adapter_version, STUDIO_ADAPTER_VERSION)
    assert.equal(meta.fingerprint, sha256(path))
    assert.equal(meta.bytes, statSync(path).size)
    assert.equal(meta.row_count, FIXTURE_ROWS.length)
    assert.equal(meta.deprecated_count, 1)
    assert.equal(meta.imported_row_count, FIXTURE_ROWS.length)

    const categories = listSourceUserCategories(handle, 'studio-tags')
    assert.equal(categories.length, FIXTURE_USER_CATEGORIES.length)
    assert.equal(categories.find((c) => c.name === 'BDSM 游戏').tag_count, 2)
  } finally {
    closeQuietly(handle)
    cleanup(dir)
    cleanup(srcDir)
  }
})

test('源文件没变时重复导入直接跳过，标签不重复、别名不重复', async () => {
  const srcDir = tempDir()
  const { handle, dir } = await tempPluginDb()
  try {
    const path = createStudioDb(srcDir)
    const sourceConfig = { source_id: 'studio-tags', type: STUDIO_SOURCE_TYPE, path }
    await importStudioSource({ handle, sourceConfig })
    const tagsBefore = handle.get('SELECT COUNT(*) AS n FROM tags WHERE source_id = ?', 'studio-tags').n
    const aliasesBefore = handle.get('SELECT COUNT(*) AS n FROM tag_aliases WHERE source_id = ?', 'studio-tags').n

    const second = await importStudioSource({ handle, sourceConfig })
    assert.equal(second.unchanged, true)
    assert.equal(second.imported, 0)
    assert.equal(second.diagnostics.some((d) => d.error_code === 'KB_IMPORT_SOURCE_UNCHANGED'), true)

    assert.equal(handle.get('SELECT COUNT(*) AS n FROM tags WHERE source_id = ?', 'studio-tags').n, tagsBefore)
    assert.equal(handle.get('SELECT COUNT(*) AS n FROM tag_aliases WHERE source_id = ?', 'studio-tags').n, aliasesBefore)
  } finally {
    closeQuietly(handle)
    cleanup(dir)
    cleanup(srcDir)
  }
})

test('force 跳过指纹比对，重新导入一遍', async () => {
  const srcDir = tempDir()
  const { handle, dir } = await tempPluginDb()
  try {
    const path = createStudioDb(srcDir)
    const sourceConfig = { source_id: 'studio-tags', type: STUDIO_SOURCE_TYPE, path }
    await importStudioSource({ handle, sourceConfig })
    const forced = await importStudioSource({ handle, sourceConfig, force: true })
    assert.equal(forced.unchanged, false)
    assert.equal(forced.imported, FIXTURE_ROWS.length)
    assert.equal(handle.get('SELECT COUNT(*) AS n FROM tags WHERE source_id = ?', 'studio-tags').n, FIXTURE_ROWS.length)
  } finally {
    closeQuietly(handle)
    cleanup(dir)
    cleanup(srcDir)
  }
})

test('新源库导入失败时，旧快照原样留在库里', async () => {
  const goodDir = tempDir()
  const badDir = tempDir()
  const { handle, dir } = await tempPluginDb()
  try {
    const good = createStudioDb(goodDir)
    await importStudioSource({ handle, sourceConfig: { source_id: 'studio-tags', type: STUDIO_SOURCE_TYPE, path: good } })
    const tagsBefore = handle.get('SELECT COUNT(*) AS n FROM tags WHERE source_id = ?', 'studio-tags').n
    const metaBefore = readSourceMeta(handle, 'studio-tags')

    const bad = createStudioDb(badDir, { dropTagsTable: true })
    await assert.rejects(() => importStudioSource({
      handle,
      sourceConfig: { source_id: 'studio-tags', type: STUDIO_SOURCE_TYPE, path: bad },
      force: true,
    }))

    assert.equal(handle.get('SELECT COUNT(*) AS n FROM tags WHERE source_id = ?', 'studio-tags').n, tagsBefore)
    const metaAfter = readSourceMeta(handle, 'studio-tags')
    assert.equal(metaAfter.fingerprint, metaBefore.fingerprint, '失败不能把指纹改成新文件的')
    assert.equal(metaAfter.imported_at, metaBefore.imported_at)
  } finally {
    closeQuietly(handle)
    cleanup(dir)
    cleanup(goodDir)
    cleanup(badDir)
  }
})

test('导入全过程不写源库：导入前后源文件 sha256 完全一致', async () => {
  const srcDir = tempDir()
  const { handle, dir } = await tempPluginDb()
  try {
    const path = createStudioDb(srcDir)
    const before = sha256(path)
    await importStudioSource({ handle, sourceConfig: { source_id: 'studio-tags', type: STUDIO_SOURCE_TYPE, path } })
    assert.equal(sha256(path), before)
    assert.equal(readSourceMeta(handle, 'studio-tags').fingerprint, before)
  } finally {
    closeQuietly(handle)
    cleanup(dir)
    cleanup(srcDir)
  }
})

// ───────────────────────── 查询：模型词表与补充词典分开 ─────────────────────────

/** 造一个「模型词表 + 工作室词库」的库：模型词表里只有 1girl。 */
async function dualSourceKb({ studioFallback }) {
  const srcDir = tempDir()
  const { handle, dir } = await tempPluginDb()
  const path = createStudioDb(srcDir)
  handle.run(
    `INSERT INTO tags (name, canonical_name, source_id, native_category, post_count, zh_name, kind, updated_at)
     VALUES ('1girl', '1girl', 'model-tags', 'general', 900000, '一名女性角色', 'general', '2026-01-01T00:00:00.000Z')`,
  )
  await importStudioSource({ handle, sourceConfig: { source_id: 'studio-tags', type: STUDIO_SOURCE_TYPE, path } })
  const config = {
    schema_version: '2.1',
    sources: [
      { source_id: 'model-tags', type: 'local_file', enabled: true, format: 'csv', path: 'res/model.csv' },
      { source_id: 'studio-tags', type: STUDIO_SOURCE_TYPE, enabled: true, path },
    ],
    lookup: { mode: studioFallback ? 'local_with_studio' : 'local_only', studio_fallback: studioFallback },
    categories: [],
    storage: { database_path: 'data/knowledge.sqlite3' },
  }
  const kb = createKnowledgeBase({ handle, config })
  return {
    kb,
    handle,
    config,
    path,
    close() {
      closeQuietly(handle)
      cleanup(dir)
      cleanup(srcDir)
    },
  }
}

test('没打开 fallback 时，工作室独有的词对模型词表来说仍然是没收录', async () => {
  const bundle = await dualSourceKb({ studioFallback: false })
  try {
    assert.equal(bundle.kb.mode, 'local_only')
    const task = bundle.kb.beginTask()
    const modelHit = await task.lookup('1girl')
    assert.equal(modelHit.status, 'hit')
    assert.equal(modelHit.source, 'local')
    assert.equal(modelHit.source_id, 'model-tags')

    const studioOnly = await task.lookup('maid')
    assert.equal(studioOnly.status, 'miss', 'studio 里有 maid，但没开 fallback，就不能算模型词表命中')
    assert.equal(studioOnly.reason, 'local_miss')
    assert.equal(studioOnly.fallback, false)
  } finally {
    bundle.close()
  }
})

test('打开 fallback 后，工作室独有的词命中并标明来源与命中方式', async () => {
  const bundle = await dualSourceKb({ studioFallback: true })
  try {
    assert.equal(bundle.kb.mode, 'local_with_studio')
    const task = bundle.kb.beginTask()

    const hit = await task.lookup('maid')
    assert.equal(hit.status, 'hit')
    assert.equal(hit.source, 'studio')
    assert.equal(hit.fallback, true)
    assert.equal(hit.source_id, 'studio-tags')
    assert.equal(hit.tag.zh_name, '女仆')

    // 模型词表优先：两边都有的词还是算模型词表命中。
    const both = await task.lookup('1girl')
    assert.equal(both.source, 'local')
    assert.equal(both.fallback, false)

    const stats = task.stats()
    assert.deepEqual(stats.studio_sources, ['studio-tags'])
    assert.equal(stats.studio_fallback, true)
  } finally {
    bundle.close()
  }
})

test('只配了工作室源也敢开 fallback：词表健康度不能把补充词典判成空库', async () => {
  const srcDir = tempDir()
  const { handle, dir } = await tempPluginDb()
  try {
    const path = createStudioDb(srcDir)
    await importStudioSource({ handle, sourceConfig: { source_id: 'studio-tags', type: STUDIO_SOURCE_TYPE, path } })
    const kb = createKnowledgeBase({
      handle,
      config: {
        sources: [{ source_id: 'studio-tags', type: STUDIO_SOURCE_TYPE, enabled: true, path }],
        lookup: { studio_fallback: true },
      },
    })
    // 模型词表一条都没有，但补充词典有数据——这时必须算"可查"，
    // 否则任务层会把每次查询标成 not_queried，fallback 等于白接。
    const health = kb.health()
    assert.equal(health.tag_count, 0)
    assert.equal(health.studio_tag_count, FIXTURE_ROWS.length)
    assert.equal(health.state, 'available')

    const task = kb.beginTask()
    const hit = await task.lookup('maid')
    assert.equal(hit.status, 'hit')
    assert.equal(hit.source, 'studio')
    assert.equal(hit.fallback, true)

    // 反过来，没开 fallback 时只有工作室源就等于没有词表可用。
    const off = createKnowledgeBase({
      handle,
      config: {
        sources: [{ source_id: 'studio-tags', type: STUDIO_SOURCE_TYPE, enabled: true, path }],
        lookup: { studio_fallback: false },
      },
    })
    assert.equal(off.health().state, 'empty')
    assert.equal((await off.beginTask().lookup('maid')).status, 'not_queried')
  } finally {
    closeQuietly(handle)
    cleanup(dir)
    cleanup(srcDir)
  }
})

test('工作室里标了废弃的词，即使开了 fallback 也查不到', async () => {
  const bundle = await dualSourceKb({ studioFallback: true })
  try {
    const task = bundle.kb.beginTask()
    const deprecated = await task.lookup('old_tag')
    assert.equal(deprecated.status, 'miss', '废弃词条留在库里是为了能解释它，不是为了能被命中')
  } finally {
    bundle.close()
  }
})

test('别名命中同样受 fallback 开关约束', async () => {
  const off = await dualSourceKb({ studioFallback: false })
  try {
    const task = off.kb.beginTask()
    assert.equal((await task.lookup('女仆装')).status, 'miss')
  } finally {
    off.close()
  }

  const on = await dualSourceKb({ studioFallback: true })
  try {
    const task = on.kb.beginTask()
    const hit = await task.lookup('女仆装')
    assert.equal(hit.status, 'hit')
    assert.equal(hit.source, 'studio')
    assert.equal(hit.via_alias, true)
    assert.equal(hit.tag.name, 'maid')
  } finally {
    on.close()
  }
})

test('searchStudio 能按中文检索，命中结果带中文名与分组', async () => {
  const bundle = await dualSourceKb({ studioFallback: true })
  try {
    const hits = bundle.kb.searchStudio('女仆')
    assert.ok(hits.length >= 1)
    const maid = hits.find((hit) => hit.name === 'maid')
    assert.equal(maid.zh_name, '女仆')
    assert.equal(maid.tag_group, '服装与饰品')

    const byEn = bundle.kb.searchStudio('maid')
    assert.ok(byEn.some((hit) => hit.name === 'maid'))
    assert.deepEqual(bundle.kb.searchStudio(''), [])
  } finally {
    bundle.close()
  }
})

// ───────────────────────── 编译：接进来但不改结果 ─────────────────────────

test('工作室命中对编译等同未命中，只多一条提示，正词一个字都不变', async () => {
  const bundle = await dualSourceKb({ studioFallback: true })
  try {
    const terms = [{ text: 'maid', notes: [] }]
    const resolved = await resolveTerms(terms, { kb: bundle.kb, profile: {} })
    const term = resolved.terms[0]

    assert.equal(term.text, 'maid', '补充词典不能替模型词表改词')
    assert.equal(term.kb.status, 'miss')
    assert.equal(term.kb.fallback, true)
    assert.equal(term.kb.canonical_name, null, 'studio 的分类体系不能拿来补全模型分类')
    assert.deepEqual(term.kb.categories, [])
    assert.equal(term.kb.studio.zh_name, '女仆')
    assert.equal(term.kb.studio.translation_status, 'manual')
    assert.equal(term.kb.studio.deprecated, false)
    assert.equal(resolved.stats.studio_hints, 1)
    assert.equal(resolved.diagnostics.some((d) => d.error_code === 'COMPILE_STUDIO_SUPPLEMENT_HINT'), true)
  } finally {
    bundle.close()
  }
})

test('没开 fallback 时，工作室数据对编译完全不可见', async () => {
  const bundle = await dualSourceKb({ studioFallback: false })
  try {
    const resolved = await resolveTerms([{ text: 'maid', notes: [] }], { kb: bundle.kb, profile: {} })
    const term = resolved.terms[0]
    assert.equal(term.text, 'maid')
    assert.equal(term.kb.status, 'miss')
    assert.equal(term.kb.fallback, false)
    assert.equal(term.kb.studio, undefined)
    assert.equal(resolved.stats.studio_hints, 0)
    assert.equal(resolved.diagnostics.some((d) => d.error_code === 'COMPILE_STUDIO_SUPPLEMENT_HINT'), false)
  } finally {
    bundle.close()
  }
})

// ───────────────────────── 配置：外部路径只给 studio 放行 ─────────────────────────

function baseKbDocument(overrides = {}) {
  return {
    schema_version: '2.1',
    storage: { database_path: 'data/knowledge.sqlite3', create_if_missing: true },
    lookup: { mode: 'local_only', studio_fallback: false },
    sources: [
      { source_id: 'model-tags', type: 'local_file', enabled: true, format: 'csv', path: 'res/model.csv' },
    ],
    categories: [],
    ...overrides,
  }
}

test('studio_sqlite 可以用外部绝对路径，local_file 不行', () => {
  const studioOk = crossValidateKnowledgeBase(
    baseKbDocument({
      sources: [
        { source_id: 'model-tags', type: 'local_file', enabled: true, format: 'csv', path: 'res/model.csv' },
        { source_id: 'studio-tags', type: 'studio_sqlite', enabled: true, path: 'G:/绘画工作室/绘画工作室-公开版-2026-11-10/data/tags.sqlite' },
      ],
    }),
    { config_file: 'knowledge-base' },
  )
  assert.deepEqual(studioOk.filter((item) => item.error_code === 'CONFIG_PATH_UNSAFE'), [])

  const localBad = crossValidateKnowledgeBase(
    baseKbDocument({
      sources: [
        { source_id: 'model-tags', type: 'local_file', enabled: true, format: 'csv', path: 'G:/词表/model.csv' },
      ],
    }),
    { config_file: 'knowledge-base' },
  )
  assert.equal(localBad.some((item) => item.error_code === 'CONFIG_PATH_UNSAFE'), true)
})

test('studio_sqlite 仍然拦 URL 与 .. 逃逸，外部路径不是免检通道', () => {
  for (const path of ['https://example.com/tags.sqlite', '../tags.sqlite', '~/tags.sqlite']) {
    const out = crossValidateKnowledgeBase(
      baseKbDocument({
        sources: [
          { source_id: 'model-tags', type: 'local_file', enabled: true, format: 'csv', path: 'res/model.csv' },
          { source_id: 'studio-tags', type: 'studio_sqlite', enabled: true, path },
        ],
      }),
      { config_file: 'knowledge-base' },
    )
    assert.equal(
      out.some((item) => item.error_code === 'CONFIG_PATH_UNSAFE'),
      true,
      `studio 路径 ${path} 应当被拦下`,
    )
  }
})

test('未知的数据源类型直接报错，并说明只有两种取值', () => {
  const out = crossValidateKnowledgeBase(
    baseKbDocument({
      sources: [
        { source_id: 'model-tags', type: 'local_file', enabled: true, format: 'csv', path: 'res/model.csv' },
        { source_id: 'weird', type: 'remote_api', enabled: true, path: 'x' },
      ],
    }),
    { config_file: 'knowledge-base' },
  )
  const error = out.find((item) => item.error_code === 'KB_SOURCE_MISSING_FIELD' && String(item.message).includes('remote_api'))
  assert.ok(error)
  assert.match(String(error.suggested_fix), /studio_sqlite/)
})

test('studio_sqlite 写了 column_map 会明确提示这个字段不生效', () => {
  const out = crossValidateKnowledgeBase(
    baseKbDocument({
      sources: [
        { source_id: 'model-tags', type: 'local_file', enabled: true, format: 'csv', path: 'res/model.csv' },
        { source_id: 'studio-tags', type: 'studio_sqlite', enabled: true, path: 'data/studio/tags.sqlite', column_map: { tag: 0 } },
      ],
    }),
    { config_file: 'knowledge-base' },
  )
  assert.equal(out.some((item) => item.error_code === 'KB_SOURCE_FIELD_IGNORED'), true)
})

test('默认配置里工作室源是关着的，且没有写死任何本机路径', () => {
  const document = JSON.parse(readFileSync(join(PACKAGE_DIR, 'configs', 'knowledge-base.default.json'), 'utf8'))
  assert.equal(document.schema_version, '2.1')
  assert.equal(document.lookup.studio_fallback, false)
  const studio = document.sources.find((source) => source.type === STUDIO_SOURCE_TYPE)
  assert.ok(studio, '默认配置要给用户留一个工作室源的样板')
  assert.equal(studio.enabled, false, '默认不能替用户打开外部数据源')
  for (const source of document.sources) {
    assert.equal(/^[a-zA-Z]:[\\/]/.test(String(source.path)), false, `${source.source_id} 的路径不该写死盘符`)
  }
  assert.deepEqual(
    crossValidateKnowledgeBase(document, { config_file: 'knowledge-base' }).filter((item) => item.severity === 'error'),
    [],
  )
})

// ───────────────────────── 发布边界与 schema 迁移 ─────────────────────────

test('发布包里不带任何数据库文件，插件只提供导入器', () => {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
  for (const entry of pkg.files ?? []) {
    assert.equal(entry.startsWith('data'), false, `files 白名单里不该出现 ${entry}`)
  }
  assert.equal(
    (pkg.files ?? []).some((entry) => /\.(sqlite3?|db)$/i.test(entry)),
    false,
    '发行包里不能带 sqlite 文件',
  )
})

test('2.0 的旧库打开后自动迁到 2.1，新列补齐且留下迁移诊断', async () => {
  const dir = tempDir('dsh-kb-old-')
  const path = join(dir, 'k.sqlite3')
  const legacy = new DatabaseSync(path)
  try {
    legacy.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tags (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        source_id TEXT NOT NULL,
        native_category TEXT,
        post_count INTEGER,
        zh_name TEXT,
        kind TEXT NOT NULL DEFAULT 'general',
        updated_at TEXT NOT NULL,
        UNIQUE (source_id, name)
      );
    `)
    legacy.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run(META_KEYS.SCHEMA_VERSION, '2.0')
  } finally {
    legacy.close()
  }

  let handle = null
  try {
    handle = await openKnowledgeDatabase({ path, createIfMissing: false })
    assert.equal(readMeta(handle, META_KEYS.SCHEMA_VERSION), KB_SCHEMA_VERSION)
    const columns = handle.all('PRAGMA table_info(tags)').map((row) => row.name)
    for (const column of ['deprecated', 'tag_group', 'translation_status']) {
      assert.ok(columns.includes(column), `迁移后缺少 ${column} 列`)
    }
    assert.equal(
      (handle.migrationDiagnostics ?? []).some((item) => item.error_code === 'CONFIG_SCHEMA_VERSION_MIGRATED'),
      true,
    )
  } finally {
    closeQuietly(handle)
    cleanup(dir)
  }
})

test('库里声明了插件不认识的 schema 版本时，宁可不打开也不乱迁', async () => {
  const dir = tempDir('dsh-kb-future-')
  const path = join(dir, 'k.sqlite3')
  try {
    const handle = await openKnowledgeDatabase({ path, createIfMissing: true })
    writeMeta(handle, META_KEYS.SCHEMA_VERSION, '9.9')
    closeQuietly(handle)

    await assert.rejects(
      () => openKnowledgeDatabase({ path, createIfMissing: false }),
      (error) => {
        assert.equal(error.code, 'KB_SCHEMA_VERSION_MISMATCH')
        return true
      },
    )
  } finally {
    cleanup(dir)
  }
})

// ───────────────────────── 模型档案没有被这次接入带跑偏 ─────────────────────────

test('三份模型档案都不引用工作室数据，词表边界没被扩大', () => {
  const dir = join(PACKAGE_DIR, 'configs', 'model-profiles')
  const files = ['anima.json', 'illustrious.json', 'moss.json']
  for (const file of files) {
    const raw = readFileSync(join(dir, file), 'utf8')
    const profile = JSON.parse(raw)
    assert.equal(raw.includes('studio'), false, `${file} 不该引用工作室数据源`)
    assert.equal(profile.tag_mapping?.unknown_tag_policy, 'description_only', `${file} 的未知词策略不该变`)
  }

  const anima = JSON.parse(readFileSync(join(dir, 'anima.json'), 'utf8'))
  assert.deepEqual(anima.aliases, ['animagine-xl-4.0', 'AnimaImage', 'animagine', 'animagine-xl'])
  assert.equal(anima.tag_standard.word_style, 'prose')
  assert.equal(anima.tag_standard.character_format, '{name} ({series})')

  const illustrious = JSON.parse(readFileSync(join(dir, 'illustrious.json'), 'utf8'))
  assert.equal(illustrious.tag_standard.word_style, 'spaced')

  const moss = JSON.parse(readFileSync(join(dir, 'moss.json'), 'utf8'))
  assert.equal(moss.tag_standard.word_style, 'caption')
  assert.equal(moss.tag_standard.caption_language, 'en')

  // 接入第三类数据源不该顺手放宽任何一份档案的兼容性声明：
  // 置信度等级、负向条数、禁用词都是原样。
  assert.equal(anima.tag_standard.source_confidence.level, 'A')
  assert.equal(anima.tag_standard.negative.terms.length, 18)
  assert.equal(anima.tag_standard.negative.max_terms, 30)
  assert.equal(illustrious.tag_standard.source_confidence.level, 'B')
  assert.equal(illustrious.tag_standard.negative.terms.length, 11)
  assert.equal(moss.tag_standard.source_confidence.level, 'A')
  assert.equal(moss.tag_standard.negative.terms.length, 4)
  assert.equal(moss.tag_standard.negative.max_terms, 6)
  // Anima 与 Animagine XL 4.0 是同一份档案，旧名只能出现在别名里。
  assert.equal(anima.config_id, 'anima')
  assert.equal(anima.aliases.includes('animagine-xl-4.0'), true)
})

// ───────────────────────── 源文件不在了也要能跑 ─────────────────────────

test('工作室词库文件缺失时只报警告，分析链路照常', () => {
  const out = studioSourceDiagnostics({
    sources: [
      { source_id: 'model-tags', type: 'local_file', enabled: true, format: 'csv', path: 'res/model.csv' },
      { source_id: 'studio-tags', type: 'studio_sqlite', enabled: true, path: 'G:/不存在的目录/tags.sqlite' },
    ],
  })
  assert.equal(out.length, 1, '只有工作室源会走这条检查')
  assert.equal(out[0].error_code, 'KB_STUDIO_SOURCE_MISSING')
  assert.equal(out[0].severity, 'warning', '缺文件是警告不是错误：没有它模型词表照样能用')
  assert.equal(out[0].field_path, '/sources/studio-tags/path')
  assert.match(out[0].message, /不存在/)
  assert.ok(out[0].suggested_fix)
})

test('关掉的工作室源不产生任何提示，空 path 才会单独报一条', () => {
  assert.deepEqual(
    studioSourceDiagnostics({
      sources: [{ source_id: 'studio-tags', type: 'studio_sqlite', enabled: false, path: 'G:/任意/tags.sqlite' }],
    }),
    [],
    '默认配置里那条关着的源不该让每次分析都多一条噪音',
  )

  const empty = studioSourceDiagnostics({
    sources: [{ source_id: 'studio-tags', type: 'studio_sqlite', enabled: true }],
  })
  assert.equal(empty.length, 1)
  assert.match(empty[0].message, /没有填 path/)
})

test('诊断报告：没导入过、源库变了、文件不见了，三种状态分得开', async () => {
  const srcDir = tempDir()
  const { handle, dir } = await tempPluginDb()
  try {
    const path = createStudioDb(srcDir)
    const config = {
      sources: [{ source_id: 'studio-tags', type: STUDIO_SOURCE_TYPE, enabled: true, path }],
    }

    // 一、还没导入。
    const before = await inspectSources({ config, handle })
    assert.equal(before.sources[0].status, 'declared')
    assert.equal(before.sources[0].stale, true)
    assert.equal(before.sources[0].imported, null)
    assert.equal(before.diagnostics.some((d) => d.error_code === 'KB_STUDIO_NOT_IMPORTED'), true)
    assert.equal(before.sources[0].rows, FIXTURE_ROWS.length)

    // 二、导入之后指纹一致，不再算过期。
    await importStudioSource({ handle, sourceConfig: config.sources[0] })
    const after = await inspectSources({ config, handle })
    assert.equal(after.sources[0].stale, false)
    assert.equal(after.sources[0].imported.fingerprint, sha256(path))
    assert.equal(after.sources[0].imported.rows, FIXTURE_ROWS.length)
    assert.equal(after.diagnostics.some((d) => d.error_code?.startsWith('KB_STUDIO_')), false)

    // 三、源库又加了一行，指纹变了，报告要指出插件库里还是旧快照。
    const mutate = new DatabaseSync(path)
    try {
      mutate.prepare(
        "INSERT INTO tags (id, en, zh, category, post_count, deprecated, updated_at, tag_group, aliases, translation_status) VALUES (99, 'new_tag', '新词', 'general', 1, 0, '2026-02-01T00:00:00.000Z', '待归类', '', 'draft')",
      ).run()
    } finally {
      mutate.close()
    }
    const stale = await inspectSources({ config, handle })
    assert.equal(stale.sources[0].stale, true)
    assert.equal(stale.diagnostics.some((d) => d.error_code === 'KB_STUDIO_STALE'), true)
    assert.equal(stale.sources[0].rows, FIXTURE_ROWS.length + 1)

    // 四、文件被挪走。
    const missing = await inspectSources({
      config: { sources: [{ ...config.sources[0], path: join(srcDir, '没这个文件.sqlite') }] },
      handle,
    })
    assert.equal(missing.sources[0].status, 'file_missing')
    assert.equal(missing.sources[0].exists, false)
    assert.equal(missing.diagnostics.some((d) => d.severity === 'warning'), true)
  } finally {
    closeQuietly(handle)
    cleanup(dir)
    cleanup(srcDir)
  }
})

// ───────────────────────── 工具层：检索、解释、词篮 ─────────────────────────
//
// 这三个工具是「让人能用中文找词」的入口。它们读同一份词库，但分工不同：
// search_tags 负责"有哪些词"，explain_tag 负责"这个词是什么"，
// compile_tag_basket 负责"我挑的这几个词怎么变成提示词"。
// 所以这里测的不是函数返回值，是这三件事有没有分清楚。

const SILENT_LOGGER = { debug() {}, info() {}, warn() {}, error() {} }

/** 只提供工具真正会用到的那几个方法，不假装自己是个完整 runtime。 */
function fakeRuntime({ kb = null, handle = null, config = null, store = null } = {}) {
  return {
    logger: SILENT_LOGGER,
    pluginConfig: {},
    async getKnowledgeBase() {
      if (!kb) throw Object.assign(new Error('标签知识库没有打开'), { code: 'KB_DATABASE_UNAVAILABLE' })
      return { kb, handle, config }
    },
    async getConfigStore() {
      if (!store) throw new Error('测试里没有给配置仓库')
      return store
    },
  }
}

/** 用真实的 configs/ 加载一次配置仓库；dataDir 走临时目录，不读本机用户覆盖。 */
async function realConfigStore() {
  const dataDir = tempDir('dsh-tools-config-')
  const store = createConfigStore({ configDir: join(PACKAGE_DIR, 'configs'), dataDir, logger: null })
  await store.get()
  return { store, dataDir }
}

/**
 * 造一个「工作室发行包」布局：`data/tags.sqlite` + 同级 `ui/` 两份分类树种子。
 * 分类树的位置是从词库路径推出来的，所以布局必须真的长这样。
 *
 * userCategories 默认取 FIXTURE_USER_CATEGORIES（ID 1、2 与种子里的「视觉特征 / 画面构图与风格」
 * 不同名），用来模拟「种子与源库版本对不上」；要测正常层级就传 TREE_USER_CATEGORIES。
 */
function createStudioPackage({ rows = FIXTURE_ROWS, userCategories = FIXTURE_USER_CATEGORIES } = {}) {
  const root = tempDir('dsh-studio-pkg-')
  mkdirSync(join(root, 'data'), { recursive: true })
  mkdirSync(join(root, 'ui'), { recursive: true })
  const dbPath = createStudioDb(join(root, 'data'), { name: 'tags.sqlite', rows, userCategories })
  writeFileSync(
    join(root, 'ui', 'visual-index-seed.json'),
    JSON.stringify({
      1: { name: '视觉特征', parent: null },
      2: { name: '画面构图与风格', parent: 1 },
      3: { name: '画面构图', parent: 2 },
    }),
  )
  writeFileSync(
    join(root, 'ui', 'wiki-section-seed.json'),
    JSON.stringify({ revision: 'fixture-2026-11-11', nodes: { 4: { name: '构图', parent: 3 } } }),
  )
  return { root, dbPath }
}

test('search_tags：中文检索落在补充词典上，每条结果标明来源与命中字段', async () => {
  const bundle = await dualSourceKb({ studioFallback: true })
  try {
    const result = await runSearchTags(fakeRuntime(bundle), { query: '女仆', limit: 5 })
    assert.ok(result.status.startsWith('ok'), `状态应为 ok，实际 ${result.status}`)

    const maid = result.results.find((hit) => hit.tag === 'maid')
    assert.ok(maid, '女仆 应当能查到 maid')
    assert.equal(maid.source, 'studio')
    assert.equal(maid.source_id, 'studio-tags')
    assert.equal(maid.matched_field, 'zh_name')
    assert.equal(maid.zh_name, '女仆')
    // 中文名只是检索入口，标签身份还是英文名：结果里两个都带着。
    assert.equal(maid.translation_status, 'manual')
    assert.equal(result.by_source.studio >= 1, true)
    assert.equal(result.mode, 'local_with_studio')
  } finally {
    bundle.close()
  }
})

test('search_tags：只挂模型词表时，中文查不到会说清楚下一步怎么查', async () => {
  const bundle = await dualSourceKb({ studioFallback: true })
  try {
    // 只留模型词表：把 studio 源从配置里拿掉，检索就没有中文可查了。
    const kb = createKnowledgeBase({
      handle: bundle.handle,
      config: { ...bundle.config, sources: [bundle.config.sources[0]] },
    })
    const result = await runSearchTags(fakeRuntime({ kb, handle: bundle.handle, config: bundle.config }), {
      query: '女仆',
    })
    assert.equal(result.results.length, 0)
    assert.equal(result.total, 0)
    const note = result.diagnostics.find((item) => item.error_code === 'KB_SEARCH_NO_RESULTS')
    assert.ok(note, '查不到要有一条说明，而不是安静返回空数组')
    assert.equal(note.severity, 'info')
    // 缺源诊断已经改成"有本地快照就不提源文件"，所以这里不能再把人往
    // "去接上工作室补充词典"引——那句话说出去就等于承认中文能力依赖外部目录。
    assert.doesNotMatch(note.suggested_fix, /工作室|studio/)
    assert.match(note.suggested_fix, /英文标签名|分类树/)
  } finally {
    bundle.close()
  }
})

test('search_tags：不给检索词直接失败，不去查一遍空字符串', async () => {
  const result = await runSearchTags(fakeRuntime({}), { query: '   ' })
  assert.equal(result.status, 'failed')
  assert.equal(result.diagnostics[0].error_code, 'KB_SEARCH_QUERY_REQUIRED')
})

test('search_tags：分类树从本地库里读，命中分支带完整路径', async () => {
  // 种子与源库同名，导入时才会接出 1 → 2 → 3 → 4 的层级。
  const pkg = createStudioPackage({ userCategories: TREE_USER_CATEGORIES })
  const { handle, dir } = await tempPluginDb()
  try {
    await importStudioSource({
      handle,
      sourceConfig: { source_id: 'studio-tags', type: STUDIO_SOURCE_TYPE, path: pkg.dbPath },
    })
    // 导入之后把源库删掉：树必须仍然能从本地库里读出来。
    rmSync(pkg.dbPath, { force: true })
    const config = {
      schema_version: '2.3',
      sources: [{ source_id: 'studio-tags', type: STUDIO_SOURCE_TYPE, enabled: false, path: pkg.dbPath }],
      lookup: { mode: 'local_only', studio_fallback: false },
      categories: [],
    }
    const kb = createKnowledgeBase({ handle, config })
    const result = await runSearchTags(fakeRuntime({ kb, handle, config }), { query: '构图', scope: 'tree' })

    assert.equal(result.tree.ok, true, '关掉补充词典不影响翻分支')
    assert.equal(result.tree.source, 'database', '树来自已导入的分类表，不是运行时读种子文件')
    const hit = result.tree.hits.find((item) => item.name === '构图')
    assert.ok(hit)
    assert.deepEqual(hit.path, ['视觉特征', '画面构图与风格', '画面构图', '构图'])
    // scope=tree 不查词表：这里 results 一定是空的，不会偷偷多查一次。
    assert.equal(result.results.length, 0)
  } finally {
    closeQuietly(handle)
    cleanup(dir)
    cleanup(pkg.root)
  }
})

test('explain_tag：拿中文名也能解释出英文标签，并说明是哪种翻译状态', async () => {
  const bundle = await dualSourceKb({ studioFallback: true })
  try {
    const result = await runExplainTag(fakeRuntime(bundle), { tag: '女仆' })
    assert.equal(result.found, true)
    assert.equal(result.hits.length, 1)
    const [hit] = result.hits
    assert.equal(hit.via, 'zh_name')
    assert.equal(hit.source, 'studio')
    assert.equal(hit.tag.name, 'maid')
    assert.equal(hit.tag.zh_name, '女仆')
    assert.equal(hit.tag.translation_status, 'manual')
  } finally {
    bundle.close()
  }
})

test('explain_tag：不点名档案就不猜写法；点名了才给出这个档案会怎么写', async () => {
  const bundle = await dualSourceKb({ studioFallback: true })
  const { store, dataDir } = await realConfigStore()
  try {
    const runtime = fakeRuntime({ ...bundle, store })

    const plain = await runExplainTag(runtime, { tag: 'maid' })
    assert.equal(plain.found, true)
    assert.equal(plain.rendering, null, '没点名档案就不该有渲染结果')

    const illustrious = await runExplainTag(runtime, { tag: 'maid', target_profile: 'illustrious' })
    assert.equal(illustrious.rendering.target_profile, 'illustrious')
    assert.equal(illustrious.rendering.word_style, 'spaced')
    assert.equal(illustrious.rendering.emitted, 'maid')

    const anima = await runExplainTag(runtime, { tag: 'maid', target_profile: 'anima' })
    assert.equal(anima.rendering.word_style, 'prose')
  } finally {
    bundle.close()
    cleanup(dataDir)
  }
})

test('explain_tag：查不到的词给出近义词，而不是只回一个 found:false', async () => {
  const bundle = await dualSourceKb({ studioFallback: true })
  try {
    const result = await runExplainTag(fakeRuntime(bundle), { tag: '女' })
    assert.equal(result.found, false)
    assert.equal(result.diagnostics.some((item) => item.error_code === 'KB_EXPLAIN_MISS'), true)
    assert.ok(result.suggestions.length > 0, '应当给出近义词')
  } finally {
    bundle.close()
  }
})

test('compile_tag_basket：中文词换成英文名再进提示词，并把换名逐条列出来', async () => {
  const bundle = await dualSourceKb({ studioFallback: true })
  const { store, dataDir } = await realConfigStore()
  try {
    const runtime = fakeRuntime({ ...bundle, store })
    const result = await runCompileBasket(runtime, {
      tags: ['1girl', '女仆', 'long_hair'],
      target_profile: 'illustrious',
    })

    assert.ok(result.status.startsWith('ok'), `状态应为 ok，实际 ${result.status}`)
    assert.match(result.positive, /maid/)
    assert.doesNotMatch(result.positive, /女仆/, '中文名不该原样写进正向提示词')

    const renamed = result.basket.renamed
    assert.deepEqual(renamed, [{ from: '女仆', to: 'maid' }])

    // 用户敲的词和最终写进去的词都留着：只看 terms 会以为 女仆 没进提示词。
    // status 仍是 miss——中文名不是标签身份，任务层只查英文名与别名；
    // 换名发生在编译前一步，所以看的是 emitted。
    const term = result.terms.find((item) => item.text === '女仆')
    assert.equal(term.status, 'miss')
    assert.equal(term.emitted, 'maid')
  } finally {
    bundle.close()
    cleanup(dataDir)
  }
})

test('compile_tag_basket：空词篮直接失败，不拿空 IR 去编译一遍', async () => {
  const result = await runCompileBasket(fakeRuntime({}), { tags: [] })
  assert.equal(result.status, 'failed')
  assert.equal(result.diagnostics[0].error_code, 'COMPILE_BASKET_TAGS_REQUIRED')
})

test('compile_tag_basket：Caption 档案编不出词篮时，把原因说成人话', async () => {
  const bundle = await dualSourceKb({ studioFallback: true })
  const { store, dataDir } = await realConfigStore()
  try {
    const result = await runCompileBasket(fakeRuntime({ ...bundle, store }), {
      tags: ['1girl', 'long_hair'],
      target_profile: 'moss',
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.positive, '')
    // 编译层那句是给图片反推写的，工具层必须补一句针对词篮的。
    const hint = result.diagnostics.find((item) => item.error_code === 'COMPILE_BASKET_CAPTION_NEEDS_FACTS')
    assert.ok(hint, '应当有一条针对词篮的 Caption 说明')
    assert.equal(hint.severity, 'info')
    assert.match(hint.message, /词篮是标签流/)
    assert.match(hint.suggested_fix, /illustrious/)
  } finally {
    bundle.close()
    cleanup(dataDir)
  }
})

test('反推结果默认不带词典解释，只有显式要了才带', () => {
  const base = {
    taskId: 'task-1',
    diagnostics: [],
    profileRequest: {
      profile: { config_id: 'illustrious', display_name: 'Illustrious' },
      entry: { schema_version: '1.0' },
      variant: null,
    },
    presetResult: { entry: { config_id: 'detail-standard', schema_version: '1.0' } },
    snapshot: { knowledgeBase: null },
    analysis: {
      ir: { image: { width: 832, height: 1216, aspect_ratio: '13:19' } },
      coverage: { ratio: 0.9 },
      stats: { reviews_run: 0 },
    },
    compiled: {
      target_profile: 'illustrious',
      detail_level: 'detail-standard',
      register: 'tag',
      prompts: { positive: 'a, b, c', description: '句子版正稿', negative: 'lowres' },
      slots: [],
      aliases: {},
      dropped: [],
      stats: { tags: 3 },
      explanations: [
        { tag: 'maid', status: 'miss', source: 'studio', source_id: 'studio-tags', zh: '女仆', supplement_only: true },
      ],
    },
    knowledge: { kb: null },
    experience: null,
    include_ir: false,
  }

  const silent = buildAnalysisEnvelope(base)
  assert.equal(Object.hasOwn(silent.result, 'explanations'), false)

  const asked = buildAnalysisEnvelope({ ...base, include_explanations: true })
  assert.equal(asked.result.explanations.length, 1)
  assert.equal(asked.result.explanations[0].zh, '女仆')
  assert.equal(asked.result.explanations[0].supplement_only, true)
})

// ───────────────────────── 工作室分类树 ─────────────────────────

/**
 * 与 dualSourceKb 的区别：这里造的是完整发行包布局（data/ + ui/），
 * 所以分类树读得到；模型词表侧用两条真名带家族名的源，方便测档案过滤。
 */
async function packageKb({ userCategories = TREE_USER_CATEGORIES, studioFallback = true } = {}) {
  const pkg = createStudioPackage({ userCategories })
  const { handle, dir } = await tempPluginDb()
  for (const sourceId of ['illustrious-tags', 'anima-tags']) {
    handle.run(
      `INSERT INTO tags (name, canonical_name, source_id, native_category, post_count, zh_name, kind, updated_at)
       VALUES ('1girl', '1girl', ?, 'general', 900000, '一名女性角色', 'general', '2026-01-01T00:00:00.000Z')`,
      sourceId,
    )
  }
  await importStudioSource({
    handle,
    sourceConfig: { source_id: 'studio-tags', type: STUDIO_SOURCE_TYPE, path: pkg.dbPath },
  })
  const config = {
    schema_version: '2.1',
    sources: [
      { source_id: 'illustrious-tags', type: 'local_file', enabled: true, format: 'csv', path: 'res/illustrious.csv' },
      { source_id: 'anima-tags', type: 'local_file', enabled: true, format: 'csv', path: 'res/anima.csv' },
      { source_id: 'studio-tags', type: STUDIO_SOURCE_TYPE, enabled: true, path: pkg.dbPath },
    ],
    lookup: { mode: studioFallback ? 'local_with_studio' : 'local_only', studio_fallback: studioFallback },
    categories: [],
    storage: { database_path: 'data/knowledge.sqlite3' },
  }
  const kb = createKnowledgeBase({ handle, config })
  return {
    kb,
    handle,
    config,
    pkg,
    close() {
      closeQuietly(handle)
      cleanup(dir)
      cleanup(pkg.root)
    },
  }
}

test('分类树：工作室分类按 ID 存进独立表，不进编译槽位', async () => {
  const pkg = createStudioPackage({ userCategories: TREE_USER_CATEGORIES })
  const { handle, dir } = await tempPluginDb()
  try {
    const result = await importStudioSource({
      handle,
      sourceConfig: { source_id: 'studio-tags', type: STUDIO_SOURCE_TYPE, path: pkg.dbPath },
    })
    assert.equal(result.studio_categories, 4)
    assert.equal(result.studio_category_links, 5)
    assert.deepEqual(countStudioCategories(handle, 'studio-tags'), { categories: 4, links: 5 })

    const tree = listStudioCategories(handle, 'studio-tags')
    assert.deepEqual(tree.map((node) => node.studio_id), ['1', '2', '3', '4'])
    assert.deepEqual(tree.map((node) => node.depth), [0, 1, 2, 3])
    assert.equal(tree[3].name, '构图')
    assert.equal(tree[3].parent_id, '3')
    assert.equal(tree[3].origin, 'wiki_section')
    assert.equal(tree[3].tag_count, 2)

    assert.deepEqual(
      studioCategoryPath(handle, 'studio-tags', '4').map((node) => node.name),
      ['视觉特征', '画面构图与风格', '画面构图', '构图'],
    )
    assert.deepEqual(studioCategoryTagNames(handle, 'studio-tags', '2'), ['maid'])
    assert.deepEqual(
      studioCategoriesForTag(handle, 'studio-tags', 'maid').map((node) => node.name),
      ['画面构图与风格', '画面构图', '构图'],
    )
    // 只给根节点：parentId 传 null 表示"只要根"，不能把整棵树都倒出来。
    assert.deepEqual(listStudioCategories(handle, 'studio-tags', { parentId: null }).map((node) => node.studio_id), ['1'])
    // 分类名不是标签身份：这些分支一个都不该出现在 tag_categories 里（那里是编译槽位）。
    const compiled = handle.all('SELECT DISTINCT category FROM tag_categories').map((row) => String(row.category))
    assert.equal(compiled.includes('构图'), false)
  } finally {
    closeQuietly(handle)
    cleanup(dir)
    cleanup(pkg.root)
  }
})

test('分类树：种子与源库名字对不上时，宁可不接父子关系', async () => {
  // 默认夹具的 user_categories 是「BDSM 游戏 / 主要」，与种子里的「视觉特征 / 画面构图与风格」ID 撞车但不同名。
  const pkg = createStudioPackage()
  const tree = await readStudioCategories({ path: pkg.dbPath })
  try {
    assert.equal(tree.stats.seed_nodes, 4)
    assert.equal(tree.stats.seed_mismatch, 2, 'ID 对上但名字对不上的那两个要数出来')
    // 1、2 名字对不上，不接父子；3 的父节点是 2，但 2 不可信，所以 3 也只能当根。
    assert.equal(tree.categories.find((node) => node.studio_id === '1').parent_id, null)
    assert.equal(tree.categories.find((node) => node.studio_id === '3').parent_id, null)
    // 种子里独有的 4 挂到同样来自种子的 3 下面：名字一致的那层关系照用。
    assert.equal(tree.categories.find((node) => node.studio_id === '4').parent_id, '3')
    assert.equal(tree.stats.roots, 3)
    assert.equal(tree.stats.depth_max, 1)
  } finally {
    cleanup(pkg.root)
  }
})

test('分类树：导入过一次再导入，分类树跟着源库一起换，不留旧分支', async () => {
  const pkg = createStudioPackage({ userCategories: TREE_USER_CATEGORIES })
  const { handle, dir } = await tempPluginDb()
  try {
    await importStudioSource({
      handle,
      sourceConfig: { source_id: 'studio-tags', type: STUDIO_SOURCE_TYPE, path: pkg.dbPath },
    })
    assert.equal(countStudioCategories(handle, 'studio-tags').categories, 4)

    // 换成一个没有分类的源库，强制重导：旧分支必须清掉，否则会挂在树上骗人。
    const bare = createStudioDb(tempDir(), { userCategories: null })
    await importStudioSource({
      handle,
      sourceConfig: { source_id: 'studio-tags', type: STUDIO_SOURCE_TYPE, path: bare },
      force: true,
    })
    assert.deepEqual(countStudioCategories(handle, 'studio-tags'), { categories: 0, links: 0 })
  } finally {
    closeQuietly(handle)
    cleanup(dir)
    cleanup(pkg.root)
  }
})

test('search_tags：按工作室分类过滤，结果带上它挂在哪几个分支下', async () => {
  const bundle = await packageKb()
  try {
    const hit = await runSearchTags(fakeRuntime(bundle), { query: '女仆', category: '构图' })
    assert.ok(hit.status.startsWith('ok'), `状态应为 ok，实际 ${hit.status}`)
    // 传名字是模糊匹配：画面构图、画面构图与风格都含「构图」，三个分支一起算。
    assert.equal(hit.category.matched.length, 3)
    assert.ok(hit.category.matched.some((item) => item.name === '构图'))
    assert.equal(hit.results.length, 1)
    assert.equal(hit.results[0].tag, 'maid')
    assert.deepEqual(hit.results[0].studio_categories, ['画面构图与风格', '画面构图', '构图'])

    // 「视觉特征」下只挂 1girl，女仆不在里面：分类过滤要真的把词挡掉。
    const miss = await runSearchTags(fakeRuntime(bundle), { query: '女仆', category: '视觉特征' })
    assert.equal(miss.results.length, 0)

    // 分类名打错时不静默变成"不过滤"，要说一声。
    const typo = await runSearchTags(fakeRuntime(bundle), { query: '女仆', category: '不存在的分支' })
    assert.ok(typo.diagnostics.some((item) => item.error_code === 'KB_SEARCH_CATEGORY_NOT_FOUND'))
    assert.equal(typo.results.length, 1, '找不到分类就不过滤，词还是要照常查出来')
  } finally {
    bundle.close()
  }
})

test('search_tags：废弃词默认不出现，要的时候才给', async () => {
  const bundle = await packageKb()
  try {
    const normal = await runSearchTags(fakeRuntime(bundle), { query: '旧标签' })
    assert.equal(normal.deprecated, 'exclude')
    assert.equal(normal.results.length, 0)

    const only = await runSearchTags(fakeRuntime(bundle), { query: '旧标签', deprecated: 'only' })
    assert.equal(only.results.length, 1)
    assert.equal(only.results[0].tag, 'old_tag')
    assert.equal(only.results[0].deprecated, true)

    const all = await runSearchTags(fakeRuntime(bundle), { query: '旧标签', deprecated: 'include' })
    assert.equal(all.results.length, 1)
  } finally {
    bundle.close()
  }
})

test('search_tags：翻译状态能筛，机器初稿与已审核分开看', async () => {
  const bundle = await packageKb()
  try {
    const reviewed = await runSearchTags(fakeRuntime(bundle), { query: '一名女性角色', translation_status: 'wiki_definition_reviewed' })
    assert.equal(reviewed.results.length, 1)
    assert.equal(reviewed.results[0].tag, '1girl')

    // 同一个词，按 curated 筛就什么都没有：翻译状态是筛子，不是排序权重。
    const curated = await runSearchTags(fakeRuntime(bundle), { query: '一名女性角色', translation_status: 'curated' })
    assert.equal(curated.results.length, 0)
  } finally {
    bundle.close()
  }
})

test('search_tags：模型词表重叠情况逐条标明，post_count 只是作品数', async () => {
  const bundle = await packageKb()
  try {
    const overlap = await runSearchTags(fakeRuntime(bundle), { query: '1girl', limit: 5 })
    const studioHit = overlap.results.find((item) => item.source === 'studio')
    assert.ok(studioHit, 'studio 里也有 1girl')
    assert.equal(studioHit.model_overlap, true)
    assert.deepEqual(studioHit.model_sources.sort(), ['anima-tags', 'illustrious-tags'])
    assert.equal(overlap.overlap_count >= 1, true)
    // 作品数原样带出来，但不额外解释成"质量分"。
    assert.equal(studioHit.post_count, 1000)

    const lonely = await runSearchTags(fakeRuntime(bundle), { query: '女仆' })
    assert.equal(lonely.results[0].model_overlap, false)
    assert.deepEqual(lonely.results[0].model_sources, [])
  } finally {
    bundle.close()
  }
})

test('search_tags：档案只收窄模型词表那一侧，补充词典不受影响', async () => {
  const bundle = await packageKb()
  try {
    const anima = await runSearchTags(fakeRuntime(bundle), { query: '1girl', profile: 'anima' })
    assert.equal(anima.profile.matched, true)
    assert.deepEqual(anima.profile.model_sources, ['anima-tags'])
    assert.deepEqual(anima.by_source.model, 1)
    // studio 侧不按档案过滤：它解释的是词本身，不服务某个模型。
    assert.equal(anima.by_source.studio, 1)

    // MOSS 是 Caption 档案，没有自己的标签词表：模型侧清空，补充词典照查。
    const moss = await runSearchTags(fakeRuntime(bundle), { query: '1girl', profile: 'moss' })
    assert.equal(moss.profile.matched, true)
    assert.deepEqual(moss.profile.model_sources, [])
    assert.equal(moss.by_source.model, undefined)
    assert.equal(moss.by_source.studio, 1)

    const unknown = await runSearchTags(fakeRuntime(bundle), { query: '1girl', profile: 'whatever' })
    assert.equal(unknown.profile.matched, false)
    assert.ok(unknown.diagnostics.some((item) => item.error_code === 'KB_SEARCH_PROFILE_VOCAB_UNKNOWN'))
    assert.equal(unknown.by_source.model, 2, '认不出档案就不过滤模型词表')
  } finally {
    bundle.close()
  }
})

// ───────────────────────── 词典只解释，不造事实 ─────────────────────────

// 把正向提示词拆成词，去掉权重括号，方便逐词比对。
function promptTerms(positive) {
  return String(positive)
    .split(',')
    .map((item) => item.trim())
    .map((item) => item.replace(/^\((.*):[\d.]+\)$/, '$1').trim())
    .filter(Boolean)
}

test('反推：工作室词表只解释 IR 里已有的观察，不会把没看见的词补进提示词', async () => {
  const bundle = await dualSourceKb({ studioFallback: true })
  const { store, dataDir } = await realConfigStore()
  try {
    const { profile } = resolveProfileRequest(store, { profile_id: 'illustrious' })
    // IR 里只有观察到的两个词。studio 词表里还有 maid / highres / 女仆 等，
    // 它们一个都不该出现在正向提示词里——词库不是素材库。
    const ir = createIR({
      taskId: 't-studio-ground',
      image: { width: 832, height: 1216, aspect_ratio: '13:19' },
      provenance: { source: 'vision', model: 'fixture' },
    })
    addFeature(ir, 'subject', 'count', { value: '1girl', confidence: 0.95, importance: 1, source: 'vision' })
    addFeature(ir, 'appearance', 'hair_length', { value: 'long_hair', confidence: 0.9, importance: 1, source: 'vision' })

    const compiled = await compilePrompt({ ir, profile, kb: bundle.kb })
    const terms = promptTerms(compiled.prompts.positive)

    assert.deepEqual(terms.slice(0, 2), ['1girl', 'long hair'])
    // 工作室里有、但这张图没观察到的词，一个都不能被"补"进来。
    assert.equal(terms.includes('maid'), false, `没看见 maid，就不能写进提示词：${compiled.prompts.positive}`)
    assert.equal(terms.includes('女仆'), false, '更不该把中文名写进提示词')
    assert.equal(terms.includes('highres'), false)
    // 观察之外的词只能来自档案自带的质量块，不能是词库里翻出来的。
    const quality = new Set([...compiled.quality_block, 'newest'])
    const extras = terms.slice(2)
    assert.equal(extras.every((item) => quality.has(item)), true, `正向提示词里多出了观察之外的词：${compiled.prompts.positive}`)

    // 解释里可以出现 studio 的线索，但那只是解释，不是提示词。
    const studioHints = compiled.explanations.filter((item) => item.source === 'studio')
    assert.equal(studioHints.length, 1, 'IR 里那个 studio 认识的词，能给出解释')
    assert.equal(studioHints[0].tag, 'long_hair')
    assert.equal(studioHints[0].source_id, 'studio-tags')
    assert.equal(studioHints[0].supplement_only, true)
    // 这一行在 fixture 里故意没有中文名：没有就报 null，不许拿别的词顶上。
    assert.equal(studioHints[0].zh, null)
    assert.equal(studioHints[0].translation_status, 'machine_draft_1')

    // 换一个 fixture 里有中文名的词：解释能带出中文，提示词里仍然只有它自己。
    const ir2 = createIR({ taskId: 't-studio-zh', image: { width: 640, height: 640, aspect_ratio: '1:1' } })
    addFeature(ir2, 'clothing', 'outfit', { value: 'maid', confidence: 0.9, importance: 1, source: 'vision' })
    const compiled2 = await compilePrompt({ ir: ir2, profile, kb: bundle.kb })
    const hint = compiled2.explanations.find((item) => item.tag === 'maid')
    assert.equal(hint.zh, '女仆')
    assert.equal(hint.source_id, 'studio-tags')
    assert.equal(hint.supplement_only, true)
    assert.equal(hint.status, 'miss', 'studio 认出来不等于模型词表认这个词')
    assert.equal(promptTerms(compiled2.prompts.positive).includes('女仆'), false)
  } finally {
    bundle.close()
    cleanup(dataDir)
  }
})

test('反推：studio 命中能帮 IR 里的词认出别名，但不会替它改名或加词', async () => {
  const bundle = await dualSourceKb({ studioFallback: true })
  const { store, dataDir } = await realConfigStore()
  try {
    const { profile } = resolveProfileRequest(store, { profile_id: 'illustrious' })
    // 视觉分析报的是 maid_uniform，在工作室词库里它是 maid 的别名。
    // 认出别名是解释，改不改写是编译的事：这里没有显式 fallback，所以提示词照原样写。
    const ir = createIR({ taskId: 't-studio-alias', image: { width: 512, height: 512, aspect_ratio: '1:1' } })
    addFeature(ir, 'clothing', 'outfit', { value: 'maid_uniform', confidence: 0.8, importance: 1, source: 'vision' })

    const compiled = await compilePrompt({ ir, profile, kb: bundle.kb })
    const terms = promptTerms(compiled.prompts.positive)

    assert.equal(terms.includes('maid uniform'), true, `原词要照写：${compiled.prompts.positive}`)
    assert.equal(terms.includes('maid'), false, `不能自己换成规范名：${compiled.prompts.positive}`)
    assert.equal(terms.includes('女仆装'), false, '别名里的中文不该被当成新词写进去')
    const quality = new Set([...compiled.quality_block, 'newest'])
    assert.equal(terms.slice(1).every((item) => quality.has(item)), true, `正向提示词里多出了观察之外的词：${compiled.prompts.positive}`)

    const hint = compiled.explanations.find((item) => item.tag === 'maid_uniform')
    assert.ok(hint, '这个词要有解释')
    assert.equal(hint.via_alias, true, '要说明它是靠别名认出来的')
    assert.equal(hint.supplement_only, true)
    assert.equal(hint.canonical, null, '没进编译的词不给规范名，免得被当成已归一')
    assert.equal(hint.deprecated, false)
  } finally {
    bundle.close()
    cleanup(dataDir)
  }
})

// ───────────────────────── MOSS：只写看见的事实 ─────────────────────────

test('MOSS：Caption 只写 IR 里的事实，工作室词表不许往里面塞词', async () => {
  const bundle = await dualSourceKb({ studioFallback: true })
  const { store, dataDir } = await realConfigStore()
  try {
    const { profile } = resolveProfileRequest(store, { profile_id: 'moss' })
    // 只有一个人物、一件衣服、一种发色。工作室词库里还有 long_hair（长发）等词，
    // 它们不在这张图里，就不能出现在 Caption 里。
    const ir = {
      schema_version: '1.0',
      image: { width: 1024, height: 1024 },
      entities: [{ entity_id: 'e1', kind: 'person', label: 'girl', count: 1, importance: 0.9, region: [0.2, 0.1, 0.8, 0.95] }],
      relations: [],
      features: [
        { category: 'subject', key: 'count', value: '1girl', confidence: 0.9, status: 'confirmed' },
        { category: 'appearance', key: 'hair_color', value: 'black hair', entity_id: 'e1', confidence: 0.8, status: 'confirmed' },
        { category: 'clothing', key: 'upper_body', value: 'maid', entity_id: 'e1', confidence: 0.7, status: 'confirmed' },
      ],
      uncertainties: [],
    }

    const out = await compilePrompt({ ir, profile, kb: bundle.kb })
    const text = String(out.prompts.positive)

    assert.equal(out.register, 'caption')
    assert.equal(out.caption.ok, true, `Caption 应该写得出来：${JSON.stringify(out.caption.facts_dropped)}`)
    assert.equal(out.caption.language, 'en', 'MOSS 的语言由档案定，不由词库定')
    assert.ok(text.includes('black hair'))
    assert.ok(text.includes('maid'), '看见的衣服要写进去')

    // 词库里认识、但这张图没有的词，一个都不许混进 Caption。
    assert.equal(text.includes('long hair'), false, `没看见长发：${text}`)
    assert.equal(text.includes('长发'), false, '更不许把中文名写进去')
    assert.equal(text.includes('masterpiece'), false, 'Caption 不是标签流，不塞质量词')
    assert.equal(text.includes('女仆'), false)

    // 解释照样给，只是解释不参与写作。
    const hint = out.explanations.find((item) => item.tag === 'maid')
    assert.equal(hint.source, 'studio')
    assert.equal(hint.zh, '女仆')
    assert.equal(hint.supplement_only, true)
    // grounding 要能说清每个词来自哪条观察。
    assert.equal(out.caption.grounding.ok, true)
  } finally {
    bundle.close()
    cleanup(dataDir)
  }
})

// ───────────────────────── 三个新工具的参数契约 ─────────────────────────

// 参数 schema 一旦漂移，调用方按老参数传就会静默失效。这里钉住参数名与哈希。
const STUDIO_TOOL_CONTRACT = {
  search_tags: {
    properties: ['query', 'limit', 'scope', 'include_deprecated', 'deprecated', 'translation_status', 'category', 'profile'],
    required: ['query'],
    sha256: '5ba6c7e49fed9f802cf6a0d5f8f84f613d0fd600f88ef9fa3a838ec5f7e598c6',
  },
  explain_tag: {
    properties: ['tag', 'target_profile', 'slot'],
    required: ['tag'],
    sha256: '9ecdf64247c1aca005d2a3ccecf88b5e433b085f7d8d5a08a066686c8b750b31',
  },
  compile_tag_basket: {
    properties: ['tags', 'target_profile', 'detail_level', 'include_negative', 'character', 'pose_control'],
    required: ['tags'],
    sha256: 'a5c29182db3437c73f061b651b105838373b40baa546ec812445e1d0073619e2',
  },
}

function canonicalJsonText(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonText).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonText(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function schemaHash(parameters) {
  return createHash('sha256').update(canonicalJsonText(parameters)).digest('hex')
}

test('三个新工具的参数名与 Schema 哈希钉死，改动必须是有意的', () => {
  const registered = []
  const ctx = { tools: { register(definition) { registered.push(definition); return () => {} } } }
  registerAllTools(ctx, { logger: SILENT_LOGGER })

  for (const [name, expected] of Object.entries(STUDIO_TOOL_CONTRACT)) {
    const definition = registered.find((item) => item.name === name)
    assert.ok(definition, `${name} 没有注册`)
    const parameters = definition.parameters
    assert.equal(parameters?.type, 'object')
    assert.equal(parameters?.additionalProperties, false, `${name} 必须禁止未知参数`)
    assert.deepEqual([...Object.keys(parameters.properties ?? {})].sort(), [...expected.properties].sort(), `${name} 的参数名变了`)
    assert.deepEqual(parameters.required ?? null, expected.required, `${name} 的 required 变了`)
    assert.equal(schemaHash(parameters), expected.sha256, `${name} 的参数 Schema 内容变了（枚举、范围或描述被改过）`)
  }
})

// ───────────────────────── 断开源：迁移之后不再需要原目录 ─────────────────────────

// 随包中文对照表的迷你版：8 列与 res/studio-zh.csv 完全一致。
const OFFLINE_ZH_CSV = [
  'tag,zh_name,aliases,translation_status,deprecated,tag_group,native_category,post_count',
  'maid,女仆,女仆装,machine_draft_1,0,服装与饰品,general,900',
  'long_hair,长发,长头发,curated,0,发型,general,800',
  'old_tag,旧标签,,draft,1,待归类,general,10',
].join('\n') + '\n'

/**
 * 造一套"插件自己的库"：模型词表 + 工作室词库 + 随包中文对照表。
 * 三份数据都导进插件库之后，pkg.root（工作室原目录）就可以删掉了。
 */
async function offlineBundle() {
  const pkg = createStudioPackage({ userCategories: TREE_USER_CATEGORIES })
  const work = tempDir('dsh-offline-')
  const modelCsv = join(work, 'model.csv')
  writeFileSync(modelCsv, '1girl,0,,900000\n')
  const zhCsv = join(work, 'zh.csv')
  writeFileSync(zhCsv, OFFLINE_ZH_CSV)

  const { handle, dir } = await tempPluginDb()
  const config = {
    schema_version: '2.3',
    sources: [
      { source_id: 'model-tags', type: 'local_file', role: 'model', enabled: true, format: 'csv', path: modelCsv },
      { source_id: 'studio-tags', type: STUDIO_SOURCE_TYPE, enabled: true, path: pkg.dbPath },
      { source_id: 'studio-zh', type: 'local_file', role: 'supplement', enabled: true, format: 'csv', path: zhCsv },
    ],
    lookup: { mode: 'local_with_studio', studio_fallback: true },
    categories: [],
    storage: { database_path: join(dir, 'k.sqlite3') },
  }

  for (const source of config.sources) {
    if (source.type === STUDIO_SOURCE_TYPE) await importStudioSource({ handle, sourceConfig: source })
    else await importLocalFileSource({ handle, sourceConfig: source })
  }

  const bundle = {
    pkg,
    work,
    dir,
    handle,
    config,
    kb: createKnowledgeBase({ handle, config }),
    studioSource: () => config.sources.find((source) => source.type === STUDIO_SOURCE_TYPE),
    countStudioTags() {
      return bundle.handle.get('SELECT COUNT(*) AS n FROM tags WHERE source_id = ?', 'studio-tags').n
    },
    /** 模拟插件重启：关掉库再按同一个文件打开。 */
    async restart() {
      closeQuietly(bundle.handle)
      bundle.handle = await openKnowledgeDatabase({ path: join(bundle.dir, 'k.sqlite3') })
      bundle.kb = createKnowledgeBase({ handle: bundle.handle, config })
    },
    close() {
      closeQuietly(bundle.handle)
      cleanup(dir)
      cleanup(work)
      cleanup(pkg.root)
    },
  }
  return bundle
}

/** 四类中文能力各跑一次，结果原样返回，供"断开前 / 断开后 / 重启后"三方对比。 */
async function offlineCapabilities(bundle, store) {
  const runtime = fakeRuntime({ kb: bundle.kb, handle: bundle.handle, config: bundle.config, store })
  const search = await runSearchTags(runtime, { query: '女仆', limit: 5 })
  const explain = await runExplainTag(runtime, { tag: '长发' })
  const tree = await runSearchTags(runtime, { query: '构图', scope: 'tree', limit: 5 })
  const basket = await runCompileBasket(runtime, { tags: ['女仆'], target_profile: 'illustrious' })
  return { search, explain, tree, basket }
}

/** 只比对"能力还在不在"的那几个字段，不比对诊断文案与耗时。 */
function snapshotCapabilities({ search, explain, tree, basket }) {
  return {
    search: {
      status: search.status,
      total: search.total,
      hits: (search.results ?? []).map((hit) => `${hit.source}:${hit.source_id}:${hit.tag}:${hit.zh_name}`),
    },
    explain: {
      status: explain.status,
      found: explain.found,
      tag: explain.hits?.[0]?.tag?.name ?? null,
      via: explain.hits?.[0]?.via ?? null,
      zh: explain.hits?.[0]?.tag?.zh_name ?? null,
    },
    tree: {
      status: tree.status,
      source: tree.tree?.source ?? null,
      nodes: tree.tree?.stats?.nodes ?? 0,
      first: tree.tree?.hits?.[0]?.name ?? null,
    },
    basket: {
      status: basket.status,
      positive: basket.positive ?? null,
      renamed: basket.basket?.renamed ?? [],
    },
  }
}

test('断开源：工作室目录整个删掉之后，中文检索 / 解释 / 分类树 / 中文词篮照常', async () => {
  const bundle = await offlineBundle()
  const { store, dataDir } = await realConfigStore()
  try {
    const before = snapshotCapabilities(await offlineCapabilities(bundle, store))
    assert.equal(before.search.total > 0, true, '导入之后中文就该能查')
    assert.equal(before.explain.tag, 'long_hair')
    assert.equal(before.tree.nodes, 4)
    assert.equal(before.basket.status, 'ok')

    // 原目录不可访问：整棵工作室包删掉（用户的原项目不在测试里，这里删的是临时 fixture）
    rmSync(bundle.pkg.root, { recursive: true, force: true })
    assert.equal(existsSync(bundle.pkg.root), false)

    const after = snapshotCapabilities(await offlineCapabilities(bundle, store))
    assert.deepEqual(after, before, '断开源之后四类能力的结果必须与断开前一致')

    // 命中的来源仍然是导入进去的那个源，不是"随包表顶上"
    const maid = (await runSearchTags(fakeRuntime({ kb: bundle.kb, handle: bundle.handle, config: bundle.config, store }), {
      query: '女仆',
    })).results.find((hit) => hit.tag === 'maid')
    assert.equal(maid.source, 'studio')
    assert.equal(maid.source_id, 'studio-tags')
    assert.equal(maid.translation_status, 'manual')
  } finally {
    bundle.close()
    cleanup(dataDir)
  }
})

test('断开源：插件重启之后，四类能力的结果与断开前一致', async () => {
  const bundle = await offlineBundle()
  const { store, dataDir } = await realConfigStore()
  try {
    const before = snapshotCapabilities(await offlineCapabilities(bundle, store))
    rmSync(bundle.pkg.root, { recursive: true, force: true })

    await bundle.restart()

    const after = snapshotCapabilities(await offlineCapabilities(bundle, store))
    assert.deepEqual(after, before, '重启只是重新打开库文件，结果不该变')
  } finally {
    bundle.close()
    cleanup(dataDir)
  }
})

test('断开源：重复导入不重复，源库坏掉时旧数据照样能查', async () => {
  const bundle = await offlineBundle()
  try {
    const before = bundle.countStudioTags()

    const again = await importStudioSource({ handle: bundle.handle, sourceConfig: bundle.studioSource() })
    assert.equal(again.unchanged, true, '源库指纹没变就该跳过')
    assert.equal(bundle.countStudioTags(), before, '重复导入不能把行数翻倍')

    // 把源库写坏：更新失败，但库里已有的数据一个字节都不该少
    writeFileSync(bundle.pkg.dbPath, 'not a sqlite database at all')
    await assert.rejects(
      () => importStudioSource({ handle: bundle.handle, sourceConfig: bundle.studioSource(), force: true }),
      '坏掉的源库必须报错，而不是安静地清空',
    )
    assert.equal(bundle.countStudioTags(), before)

    const search = await runSearchTags(fakeRuntime({ kb: bundle.kb, handle: bundle.handle, config: bundle.config }), {
      query: '女仆',
      limit: 5,
    })
    assert.equal(search.total > 0, true, '更新失败之后，已导入的中文检索仍然可用')
  } finally {
    bundle.close()
  }
})

// ───────────────────────── 两种模式：图片反推 / 基于用户标签的编写 ─────────────────────────

test('中文需求：拆成词 → 查成英文规范名 → 编译成提示词，整条链路可用', async () => {
  const bundle = await offlineBundle()
  const { store, dataDir } = await realConfigStore()
  try {
    const runtime = fakeRuntime({ kb: bundle.kb, handle: bundle.handle, config: bundle.config, store })

    // 用户原话是「一个穿女仆装的长发女孩」。现在没有把自由文本直接改成提示词的能力，
    // 能走的是：人（或对话模型）把需求拆成词 → search_tags 查成英文规范名 → 编译。
    const wanted = ['女仆', '长发']
    const looked = []
    for (const term of wanted) {
      const hit = await runSearchTags(runtime, { query: term, limit: 1, profile: 'illustrious' })
      assert.equal(hit.status, 'ok', `${term} 应该查得到`)
      looked.push(hit.results[0].tag)
    }
    assert.deepEqual(looked, ['maid', 'long_hair'])

    // 直接拿中文原词交进词篮也可以：换名发生在编译前一步，换过哪些会列出来
    const basket = await runCompileBasket(runtime, { tags: wanted, target_profile: 'illustrious' })
    assert.equal(basket.status, 'ok')
    assert.match(basket.positive, /maid/)
    assert.match(basket.positive, /long hair/)
    assert.deepEqual(basket.basket.renamed, [
      { from: '女仆', to: 'maid' },
      { from: '长发', to: 'long_hair' },
    ])

    // 同一篮词交给 Caption 档案：它没有自然语言事实可写，必须失败并说清为什么
    const caption = await runCompileBasket(runtime, { tags: wanted, target_profile: 'moss' })
    assert.equal(caption.status, 'failed')
    assert.equal(
      caption.diagnostics.some((note) => note.error_code === 'COMPILE_BASKET_CAPTION_NEEDS_FACTS'),
      true,
      'Caption 档案要的是图里的事实，词篮给不出来，得说清楚',
    )
  } finally {
    bundle.close()
    cleanup(dataDir)
  }
})
