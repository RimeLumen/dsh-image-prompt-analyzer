
import { SEVERITY, diagnostic } from '../../diagnostics.js'
import { READER_CODES } from './codes.js'
import { readZipEntries } from './zip.js'

function decodeXmlEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function readAttributes(source) {
  const attributes = {}
  const pattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    attributes[match[1]] = decodeXmlEntities(match[2] ?? match[3] ?? '')
  }
  return attributes
}

function getPart(entries, partPath) {
  if (entries.has(partPath)) return entries.get(partPath)
  const target = partPath.toLowerCase()
  for (const [name, data] of entries) {
    if (name.toLowerCase() === target) return data
  }
  return null
}

function joinTextRuns(fragment) {
  const withoutPhonetic = String(fragment).replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')
  let text = ''
  const pattern = /<t\b[^>]*>([\s\S]*?)<\/t>/g
  let match
  while ((match = pattern.exec(withoutPhonetic)) !== null) {
    text += decodeXmlEntities(match[1])
  }
  return text
}

function readSharedStrings(xmlText) {
  const strings = []
  const pattern = /<si\b[^>]*>([\s\S]*?)<\/si>/g
  let match
  while ((match = pattern.exec(xmlText)) !== null) {
    strings.push(joinTextRuns(match[1]))
  }
  return strings
}

function columnIndexFromReference(reference) {
  const match = /^\s*([A-Za-z]+)/.exec(String(reference ?? ''))
  if (!match) return -1
  let index = 0
  for (const char of match[1].toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 64)
  }
  return index - 1
}

function readCellValue(cellBody, attributes, sharedStrings) {
  const type = attributes.t ?? ''
  if (type === 'inlineStr') {
    const inline = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(cellBody)
    return inline ? joinTextRuns(inline[1]) : ''
  }
  const value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cellBody)
  const raw = value ? decodeXmlEntities(value[1]) : ''
  if (type === 's') {
    const index = Number.parseInt(raw.trim(), 10)
    return Number.isInteger(index) && index >= 0 && index < sharedStrings.length ? sharedStrings[index] : ''
  }
  if (type === 'b') return raw.trim() === '1' ? 'TRUE' : raw.trim() === '0' ? 'FALSE' : raw
  return raw
}

function readWorksheetRows(xmlText, sharedStrings) {
  const rows = []
  const rowPattern = /<row\b([^>]*)>([\s\S]*?)<\/row>/g
  let rowMatch
  while ((rowMatch = rowPattern.exec(xmlText)) !== null) {
    const cells = []
    let nextColumn = 0
    const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    let cellMatch
    while ((cellMatch = cellPattern.exec(rowMatch[2])) !== null) {
      const attributes = readAttributes(cellMatch[1])
      const referenced = columnIndexFromReference(attributes.r)
      const column = referenced >= 0 ? referenced : nextColumn
      while (cells.length < column) cells.push('')
      cells[column] = readCellValue(cellMatch[2] ?? '', attributes, sharedStrings)
      nextColumn = column + 1
    }
    if (cells.length > 0 && cells.some((cell) => cell !== '')) rows.push(cells)
  }
  return rows
}

function resolveTargetPath(target) {
  const normalized = String(target).replace(/\\/g, '/')
  if (normalized.startsWith('/')) return normalized.slice(1)
  if (normalized.startsWith('xl/')) return normalized
  const parts = normalized.split('/')
  const output = ['xl']
  for (const part of parts) {
    if (part === '..') output.pop()
    else if (part !== '.' && part !== '') output.push(part)
  }
  return output.join('/')
}

function readSheetEntries(xmlText) {
  const sheets = []
  const pattern = /<sheet\b([^>]*)\/?>/g
  let match
  while ((match = pattern.exec(xmlText)) !== null) {
    const attributes = readAttributes(match[1])
    sheets.push({ name: attributes.name ?? '', rid: attributes['r:id'] ?? attributes.id ?? '' })
  }
  return sheets
}

function readRelationships(xmlText) {
  const relationships = new Map()
  const pattern = /<Relationship\b([^>]*)\/?>/g
  let match
  while ((match = pattern.exec(xmlText)) !== null) {
    const attributes = readAttributes(match[1])
    if (attributes.Id && attributes.Target) {
      relationships.set(attributes.Id, resolveTargetPath(attributes.Target))
    }
  }
  return relationships
}

export function readXlsxRows(buffer, { sheetName = null } = {}) {
  const diagnostics = []
  let entries
  try {
    entries = readZipEntries(buffer)
  } catch (error) {
    diagnostics.push(
      diagnostic({
        error_code: READER_CODES.FILE_UNREADABLE,
        severity: SEVERITY.ERROR,
        field_path: '/buffer',
        message: `无法解包 XLSX：${error instanceof Error ? error.message : String(error)}`,
        suggested_fix: '确认文件是未加密的 .xlsx；损坏的文件请用表格软件另存后再导入。',
      }),
    )
    return { rows: [], header: null, diagnostics }
  }

  const workbookPart = getPart(entries, 'xl/workbook.xml')
  if (!workbookPart) {
    diagnostics.push(
      diagnostic({
        error_code: READER_CODES.FILE_UNREADABLE,
        severity: SEVERITY.ERROR,
        field_path: '/xl/workbook.xml',
        message: 'XLSX 里找不到 xl/workbook.xml，不是有效的工作簿。',
        suggested_fix: '用表格软件打开后另存为 .xlsx，再重新导入。',
      }),
    )
    return { rows: [], header: null, diagnostics }
  }

  const sheets = readSheetEntries(workbookPart.toString('utf8'))
  const selected = sheetName === null || sheetName === undefined
    ? sheets[0]
    : sheets.find((sheet) => sheet.name === sheetName)

  if (!selected) {
    diagnostics.push(
      diagnostic({
        error_code: READER_CODES.SHEET_MISSING,
        severity: SEVERITY.ERROR,
        field_path: '/sheetName',
        message: sheetName === null || sheetName === undefined
          ? '工作簿里没有任何工作表。'
          : `工作簿里没有名为 ${JSON.stringify(sheetName)} 的工作表；现有工作表：${sheets.map((sheet) => sheet.name).join(', ') || '无'}。`,
        suggested_fix: '把 sheetName 改成工作簿里真实存在的工作表名，或留空使用第一个工作表。',
      }),
    )
    return { rows: [], header: null, diagnostics }
  }

  const relationshipsPart = getPart(entries, 'xl/_rels/workbook.xml.rels')
  const relationships = relationshipsPart
    ? readRelationships(relationshipsPart.toString('utf8'))
    : new Map()
  const index = Math.max(0, sheets.indexOf(selected))
  const sheetPath = relationships.get(selected.rid) ?? `xl/worksheets/sheet${index + 1}.xml`
  const sheetPart = getPart(entries, sheetPath)
  if (!sheetPart) {
    diagnostics.push(
      diagnostic({
        error_code: READER_CODES.FILE_UNREADABLE,
        severity: SEVERITY.ERROR,
        field_path: `/${sheetPath}`,
        message: `XLSX 里找不到工作表部件 ${sheetPath}。`,
        suggested_fix: '确认工作簿没有被截断；损坏时重新导出。',
      }),
    )
    return { rows: [], header: null, diagnostics }
  }

  const sharedStringsPart = getPart(entries, 'xl/sharedStrings.xml')
  const sharedStrings = sharedStringsPart ? readSharedStrings(sharedStringsPart.toString('utf8')) : []
  const rows = readWorksheetRows(sheetPart.toString('utf8'), sharedStrings)

  return { rows, header: rows.length > 0 ? rows[0] : null, diagnostics }
}
