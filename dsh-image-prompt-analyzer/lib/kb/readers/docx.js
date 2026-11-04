
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

function getPart(entries, partPath) {
  if (entries.has(partPath)) return entries.get(partPath)
  const target = partPath.toLowerCase()
  for (const [name, data] of entries) {
    if (name.toLowerCase() === target) return data
  }
  return null
}

function paragraphText(fragment) {
  let text = ''
  const pattern = /<w:t(?=[\s>])[^>]*>([\s\S]*?)<\/w:t>/g
  let match
  while ((match = pattern.exec(fragment)) !== null) {
    text += decodeXmlEntities(match[1])
  }
  return text
}

export function readDocxText(buffer) {
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
        message: `无法解包 DOCX：${error instanceof Error ? error.message : String(error)}`,
        suggested_fix: '确认文件是未加密的 .docx；损坏的文件请用 Word 另存后再导入。',
      }),
    )
    return { paragraphs: [], rows: [], diagnostics }
  }

  const documentPart = getPart(entries, 'word/document.xml')
  if (!documentPart) {
    diagnostics.push(
      diagnostic({
        error_code: READER_CODES.FILE_UNREADABLE,
        severity: SEVERITY.ERROR,
        field_path: '/word/document.xml',
        message: 'DOCX 里找不到 word/document.xml，不是有效的 Word 文档。',
        suggested_fix: '用 Word 打开后另存为 .docx，再重新导入。',
      }),
    )
    return { paragraphs: [], rows: [], diagnostics }
  }

  const xml = documentPart.toString('utf8')
  const paragraphs = []
  const pattern = /<w:p(?=[\s>])[^>]*>([\s\S]*?)<\/w:p>/g
  let match
  while ((match = pattern.exec(xml)) !== null) {
    paragraphs.push(paragraphText(match[1]))
  }

  const rows = paragraphs.filter((text) => text.trim() !== '')
  if (rows.length === 0) {
    diagnostics.push(
      diagnostic({
        error_code: READER_CODES.DOCX_NO_TEXT,
        severity: SEVERITY.ERROR,
        field_path: '/word/document.xml',
        message: 'DOCX 正文里没有任何文本（可能只有图片或空段落）。',
        suggested_fix: '确认文档里有可复制的文字；图片内容需要先做 OCR。',
      }),
    )
  }

  return { paragraphs, rows, diagnostics }
}
