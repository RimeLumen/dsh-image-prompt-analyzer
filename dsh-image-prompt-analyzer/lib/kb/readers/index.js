
import { readFile } from 'node:fs/promises'

import { SEVERITY, diagnostic } from '../../diagnostics.js'
import { READER_CODES } from './codes.js'
import { parseCsvText } from './csv.js'
import { readDocxText } from './docx.js'
import { readMarkdownLines } from './md.js'
import { readPdfText } from './pdf.js'
import { readTextLines } from './txt.js'
import { readXlsxRows } from './xlsx.js'

const FORMAT_ALIASES = Object.freeze({
  markdown: 'md',
  text: 'txt',
  'text/plain': 'txt',
  'text/markdown': 'md',
  plain: 'txt',
})

function normalizeFormat(format) {
  const raw = String(format ?? '').trim().toLowerCase().replace(/^\.+/, '')
  if (raw === '') return ''
  return FORMAT_ALIASES[raw] ?? raw
}

function inferFormat(filePath) {
  const match = /\.([A-Za-z0-9]+)\s*$/.exec(String(filePath ?? ''))
  return match ? normalizeFormat(match[1]) : ''
}

function failure(errorCode, fieldPath, message, suggestedFix) {
  return {
    ok: false,
    rows: [],
    skipped: 0,
    diagnostics: [
      diagnostic({
        error_code: errorCode,
        severity: SEVERITY.ERROR,
        field_path: fieldPath,
        message,
        suggested_fix: suggestedFix,
      }),
    ],
  }
}

function emptyResult(diagnostics) {
  if (diagnostics.length > 0) return { ok: false, rows: [], skipped: 0, diagnostics }
  return failure(
    READER_CODES.EMPTY_TABLE,
    '/rows',
    '文件解析成功，但没有读到任何数据行。',
    '确认文件不是空表；如果第一行是表头，检查表头后面是否还有数据。',
  )
}

async function readTextContent(filePath, readText) {
  if (typeof readText === 'function') return String(await readText(filePath))
  return readFile(filePath, 'utf8')
}

async function readBytes(filePath) {
  return readFile(filePath)
}

function textToRows(text) {
  return String(text)
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

export async function readLocalFile({
  path: filePath,
  format,
  readText,
  hasHeader = 'auto',
  delimiter = ',',
  columnMap = null,
} = {}) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    return failure(
      READER_CODES.FILE_UNREADABLE,
      '/path',
      '没有给出要读取的文件路径。',
      '给 readLocalFile 传入非空的 path。',
    )
  }

  const selected = normalizeFormat(format) || inferFormat(filePath)
  if (selected === '') {
    return failure(
      READER_CODES.FORMAT_UNSUPPORTED,
      '/format',
      `无法判断 ${filePath} 的格式。`,
      '显式传入 format（csv/xlsx/docx/pdf/txt/md）或使用带扩展名的文件路径。',
    )
  }

  try {
    switch (selected) {
      case 'csv': {
        const text = (await readBytes(filePath)).toString('utf8')
        const parsed = parseCsvText(text, { hasHeader, delimiter, columnMap })
        if (!parsed.ok) {
          return { ok: false, rows: [], skipped: parsed.skipped, diagnostics: parsed.diagnostics }
        }
        if (parsed.rows.length === 0) return emptyResult(parsed.diagnostics)
        return { ok: true, rows: parsed.rows, skipped: parsed.skipped, diagnostics: parsed.diagnostics }
      }
      case 'xlsx': {
        const result = readXlsxRows(await readBytes(filePath))
        if (result.rows.length === 0) return emptyResult(result.diagnostics)
        return { ok: true, rows: result.rows, skipped: 0, diagnostics: result.diagnostics }
      }
      case 'docx': {
        const result = readDocxText(await readBytes(filePath))
        if (result.rows.length === 0) return emptyResult(result.diagnostics)
        return { ok: true, rows: result.rows, skipped: 0, diagnostics: result.diagnostics }
      }
      case 'pdf': {
        const result = readPdfText(await readBytes(filePath))
        const rows = textToRows(result.text)
        if (result.diagnostics.length > 0 || rows.length === 0) {
          return { ok: false, rows, skipped: 0, diagnostics: result.diagnostics.length > 0 ? result.diagnostics : emptyResult([]).diagnostics }
        }
        return { ok: true, rows, skipped: 0, diagnostics: result.diagnostics }
      }
      case 'txt': {
        const text = await readTextContent(filePath, readText)
        const result = readTextLines(text)
        if (result.rows.length === 0) return emptyResult([])
        return { ok: true, rows: result.rows, skipped: result.skipped, diagnostics: [] }
      }
      case 'md': {
        const text = await readTextContent(filePath, readText)
        const result = readMarkdownLines(text)
        if (result.rows.length === 0) return emptyResult([])
        return { ok: true, rows: result.rows, skipped: result.skipped, diagnostics: [] }
      }
      default: {
        return failure(
          READER_CODES.FORMAT_UNSUPPORTED,
          '/format',
          `不支持的格式 ${JSON.stringify(selected)}；目前支持 csv/xlsx/docx/pdf/txt/md。`,
          '把 format 改成受支持的格式，或先转换成 CSV 再导入。',
        )
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return failure(
      READER_CODES.FILE_UNREADABLE,
      '/path',
      `读取 ${filePath} 失败：${message}`,
      '确认文件存在、可读且没有被其它程序占用；二进制格式还要确认没有加密或损坏。',
    )
  }
}
