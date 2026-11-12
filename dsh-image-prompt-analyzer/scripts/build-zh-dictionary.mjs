#!/usr/bin/env node
// 从工作室词库导出一份「中文对照表」，随插件包发布（res/studio-zh.csv）。
//
// 为什么要有这个文件：插件自带的模型词表（res/illustrious_tags_no_artist.csv、
// res/anima_tags_no_artist.csv）只有英文名、原生分类、别名和作品数，没有中文。
// 中文检索、中文解释、中文词篮编译全靠中文名。如果中文只存在于用户机器上的
// 工作室目录里，那「换个地方装插件」就等于把中文能力弄丢了。
//
// 这份表只保留有中文名的行，字段与导入器的 column_map 对齐：
//   tag,zh_name,aliases,translation_status,deprecated,tag_group,native_category,post_count
//
// 用法：
//   node scripts/build-zh-dictionary.mjs <path-to-tags.sqlite> [--out res/studio-zh.csv]
//
// 源库只读打开，不写它。

import { DatabaseSync } from 'node:sqlite'
import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const HEADER = [
  'tag',
  'zh_name',
  'aliases',
  'translation_status',
  'deprecated',
  'tag_group',
  'native_category',
  'post_count',
]

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value)
  if (!/[",\r\n]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

function parseArgs(argv) {
  const args = { source: null, out: 'res/studio-zh.csv' }
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (item === '--out') {
      args.out = argv[i + 1]
      i += 1
    } else if (!args.source) {
      args.source = item
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!args.source) {
  console.error('用法：node scripts/build-zh-dictionary.mjs <path-to-tags.sqlite> [--out res/studio-zh.csv]')
  process.exit(2)
}

const sourcePath = resolve(args.source)
const outPath = resolve(args.out)
const db = new DatabaseSync(sourcePath, { readOnly: true })

// 逐列兜底：老版本词库可能没有 translation_status / tag_group / aliases。
const columns = new Set(db.prepare('PRAGMA table_info(tags)').all().map((row) => row.name))
for (const required of ['en', 'zh']) {
  if (!columns.has(required)) {
    console.error(`源库的 tags 表缺少 ${required} 列，无法导出中文对照表。`)
    process.exit(1)
  }
}
const pick = (name) => (columns.has(name) ? name : `NULL AS ${name}`)
const sql = `
  SELECT en AS tag, zh AS zh_name, ${pick('aliases')}, ${pick('translation_status')},
         ${pick('deprecated')}, ${pick('tag_group')}, ${pick('category')} AS native_category,
         ${pick('post_count')}
    FROM tags
   WHERE zh IS NOT NULL AND TRIM(zh) <> ''
   ORDER BY post_count DESC NULLS LAST, en ASC
`
const rows = db.prepare(sql).all()
db.close()

mkdirSync(dirname(outPath), { recursive: true })
const stream = createWriteStream(outPath, { encoding: 'utf8' })
stream.write(`${HEADER.join(',')}\n`)
let written = 0
for (const row of rows) {
  stream.write(
    [
      row.tag,
      row.zh_name,
      row.aliases ?? '',
      row.translation_status ?? '',
      row.deprecated === null || row.deprecated === undefined ? '' : Number(row.deprecated) === 1 ? '1' : '0',
      row.tag_group ?? '',
      row.native_category ?? '',
      row.post_count ?? '',
    ]
      .map(csvCell)
      .join(',') + '\n',
  )
  written += 1
}
stream.end(() => {
  console.log(`已写出 ${outPath}：${written} 条带中文名的标签。`)
})
