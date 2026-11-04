
import { SEVERITY, diagnostic } from '../../diagnostics.js'
import { READER_CODES } from './codes.js'

const HEADER_SYNONYMS = Object.freeze({
  tag: ['tag', '标签', '名称', 'name'],
  aliases: ['aliases', '别名'],
  zh_name: ['zh', 'zh_name', '中文', '中文名', '翻译'],
  category: ['category', '大类', '分类'],
  subcategory: ['subcategory', '子类'],
  native_category: ['native_category', '类别', 'category_id'],
  post_count: ['post_count', '作品数', 'count'],
})

const FIELDS = Object.freeze([
  'tag',
  'native_category',
  'post_count',
  'aliases',
  'zh_name',
  'category',
  'subcategory',
])

const DEFAULT_COLUMNS = Object.freeze({
  tag: 0,
  native_category: 1,
  post_count: 2,
  aliases: 3,
  zh_name: 4,
  category: 5,
  subcategory: 6,
})

function normalizeHeaderName(value) {
  return String(value ?? '').toLowerCase().replace(/[\s_-]+/g, '')
}

function matchesSynonyms(cell, synonyms) {
  const normalized = normalizeHeaderName(cell)
  return synonyms.some((synonym) => normalizeHeaderName(synonym) === normalized)
}

function looksLikeHeader(cells) {
  const allSynonyms = Object.values(HEADER_SYNONYMS)
  return cells.some((cell) => allSynonyms.some((synonyms) => matchesSynonyms(cell, synonyms)))
}

function parseMatrix(text, delimiter) {
  const matrix = []
  let row = []
  let field = ''
  let inQuotes = false
  let quoteStartLine = 0
  let line = 1
  let index = 0

  while (index < text.length) {
    const char = text[index]

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        inQuotes = false
        index += 1
        continue
      }
      if (char === '\n') line += 1
      field += char
      index += 1
      continue
    }

    if (char === '"' && field === '') {
      inQuotes = true
      quoteStartLine = line
      index += 1
      continue
    }

    if (char === delimiter) {
      row.push(field)
      field = ''
      index += 1
      continue
    }

    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(field)
      matrix.push(row)
      row = []
      field = ''
      line += 1
      index += 1
      continue
    }

    field += char
    index += 1
  }

  if (inQuotes) {
    return { matrix, error: `第 ${quoteStartLine} 行开始的引号字段没有闭合。` }
  }

  if (field !== '' || row.length > 0) {
    row.push(field)
    matrix.push(row)
  }
  return { matrix, error: null }
}

function resolveColumnRef(ref, header) {
  if (typeof ref === 'number') return Number.isInteger(ref) && ref >= 0 ? ref : -1
  if (typeof ref !== 'string') return -1
  const trimmed = ref.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  if (!header) return -1
  const target = normalizeHeaderName(trimmed)
  const found = header.findIndex((cell) => normalizeHeaderName(cell) === target)
  return found
}

function mapBySynonyms(header) {
  const mapping = {}
  for (const field of FIELDS) {
    const found = header.findIndex((cell) => matchesSynonyms(cell, HEADER_SYNONYMS[field]))
    if (found >= 0) mapping[field] = found
  }
  return mapping
}

function buildRow(cells, mapping) {
  const value = (field) => {
    const column = mapping[field]
    if (column === undefined || column < 0 || column >= cells.length) return ''
    return String(cells[column] ?? '')
  }
  const tag = value('tag').trim()
  const rawAliases = value('aliases')
  const aliases = rawAliases
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean)
  const postCountText = value('post_count').trim()
  const postCount = /^[+-]?\d+(?:\.\d+)?$/.test(postCountText) ? Number(postCountText) : null
  return {
    tag,
    aliases,
    zh_name: value('zh_name').trim() || null,
    category: value('category').trim() || null,
    subcategory: value('subcategory').trim() || null,
    native_category: value('native_category').trim() || null,
    post_count: postCount,
  }
}

export function parseCsvText(text, { hasHeader = 'auto', delimiter = ',', columnMap = null } = {}) {
  const diagnostics = []
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  const resolvedDelimiter = typeof delimiter === 'string' && delimiter.length > 0 ? delimiter[0] : ','
  const { matrix, error } = parseMatrix(source, resolvedDelimiter)

  if (error) {
    diagnostics.push(
      diagnostic({
        error_code: READER_CODES.FILE_UNREADABLE,
        severity: SEVERITY.ERROR,
        field_path: '/text',
        message: `CSV 结构损坏：${error}`,
        suggested_fix: '用表格软件重新导出 CSV；引号字段必须成对，字段内的引号要写成两个双引号。',
      }),
    )
    return { ok: false, header: null, rows: [], skipped: 0, diagnostics }
  }

  const nonEmpty = []
  let skipped = 0
  for (const cells of matrix) {
    if (cells.every((cell) => String(cell).trim() === '')) {
      skipped += 1
      continue
    }
    nonEmpty.push(cells)
  }

  const autoHeader = hasHeader === 'auto' ? nonEmpty.length > 0 && looksLikeHeader(nonEmpty[0]) : hasHeader === true
  const header = autoHeader && nonEmpty.length > 0 ? nonEmpty[0].map((cell) => String(cell)) : null
  const dataRows = autoHeader ? nonEmpty.slice(1) : nonEmpty

  let mapping
  if (columnMap !== null && columnMap !== undefined) {
    if (typeof columnMap !== 'object' || Array.isArray(columnMap)) {
      diagnostics.push(
        diagnostic({
          error_code: READER_CODES.COLUMN_MAP_INVALID,
          severity: SEVERITY.WARNING,
          field_path: '/columnMap',
          message: 'columnMap 必须是「逻辑字段 → 列下标或表头名」的对象。',
          suggested_fix: '例如 {"tag": 0, "post_count": "count"}；不清楚列序时把 columnMap 设为 null 让读取器自动识别。',
        }),
      )
      mapping = header ? mapBySynonyms(header) : { ...DEFAULT_COLUMNS }
    } else {
      mapping = header ? mapBySynonyms(header) : { ...DEFAULT_COLUMNS }
      for (const [field, ref] of Object.entries(columnMap)) {
        if (!FIELDS.includes(field)) {
          diagnostics.push(
            diagnostic({
              error_code: READER_CODES.COLUMN_MAP_INVALID,
              severity: SEVERITY.WARNING,
              field_path: `/columnMap/${field}`,
              message: `columnMap 里出现了未知字段：${field}`,
              suggested_fix: `可用字段：${FIELDS.join(', ')}。`,
            }),
          )
          continue
        }
        const column = resolveColumnRef(ref, header)
        if (column < 0) {
          delete mapping[field]
          diagnostics.push(
            diagnostic({
              error_code: READER_CODES.COLUMN_MAP_INVALID,
              severity: SEVERITY.WARNING,
              field_path: `/columnMap/${field}`,
              message: `字段 ${field} 的列引用 ${JSON.stringify(ref)} 解析不了${header ? '' : '（没有表头时只能写数字下标）'}。`,
              suggested_fix: '改成 0 基数字下标，或与表头完全对应的列名。',
            }),
          )
          continue
        }
        mapping[field] = column
      }
    }
  } else {
    mapping = header ? mapBySynonyms(header) : { ...DEFAULT_COLUMNS }
  }

  if (mapping.tag === undefined || mapping.tag < 0) {
    diagnostics.push(
      diagnostic({
        error_code: READER_CODES.COLUMN_MAP_INVALID,
        severity: SEVERITY.WARNING,
        field_path: '/columnMap/tag',
        message: '没有找到标签名列（tag），无法构造标签记录。',
        suggested_fix: '给 columnMap.tag 指定列下标或表头名，或把标签列命名为 tag / 标签 / 名称 / name 之一。',
      }),
    )
  }

  const rows = []
  for (const cells of dataRows) {
    const row = buildRow(cells, mapping)
    if (!row.tag) {
      skipped += 1
      continue
    }
    rows.push(row)
  }

  return {
    ok: mapping.tag !== undefined && mapping.tag >= 0,
    header,
    rows,
    skipped,
    diagnostics,
  }
}
