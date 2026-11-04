
import { inflateRawSync, inflateSync } from 'node:zlib'

import { SEVERITY, diagnostic } from '../../diagnostics.js'
import { READER_CODES } from './codes.js'

const MIN_TEXT_CHARS = 20
const MAX_CMAP_RANGE = 65536

function readLiteralString(text, start) {
  const bytes = []
  let depth = 1
  let index = start + 1
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') {
      const next = text[index + 1]
      index += 2
      if (next === 'n') bytes.push(0x0a)
      else if (next === 'r') bytes.push(0x0d)
      else if (next === 't') bytes.push(0x09)
      else if (next === 'b') bytes.push(0x08)
      else if (next === 'f') bytes.push(0x0c)
      else if (next === '(' || next === ')' || next === '\\') bytes.push(next.charCodeAt(0))
      else if (next === '\n') continue
      else if (next === '\r') {
        if (text[index] === '\n') index += 1
      } else if (next >= '0' && next <= '7') {
        let octal = next
        while (octal.length < 3 && text[index] >= '0' && text[index] <= '7') {
          octal += text[index]
          index += 1
        }
        bytes.push(Number.parseInt(octal, 8) & 0xff)
      } else if (next !== undefined) {
        bytes.push(next.charCodeAt(0) & 0xff)
      }
      continue
    }
    if (char === '(') {
      depth += 1
      bytes.push(0x28)
      index += 1
      continue
    }
    if (char === ')') {
      depth -= 1
      index += 1
      if (depth === 0) break
      bytes.push(0x29)
      continue
    }
    bytes.push(char.charCodeAt(0) & 0xff)
    index += 1
  }
  return { bytes: Buffer.from(bytes), next: index }
}

function readHexString(text, start) {
  let index = start + 1
  let hex = ''
  while (index < text.length && text[index] !== '>') {
    if (/[0-9A-Fa-f]/.test(text[index])) hex += text[index]
    index += 1
  }
  if (index < text.length) index += 1
  if (hex.length % 2 === 1) hex += '0'
  return { bytes: Buffer.from(hex, 'hex'), next: index }
}

function skipDictionary(text, start) {
  let depth = 0
  let index = start
  while (index < text.length) {
    if (text.startsWith('<<', index)) {
      depth += 1
      index += 2
      continue
    }
    if (text.startsWith('>>', index)) {
      depth -= 1
      index += 2
      if (depth === 0) return index
      continue
    }
    index += 1
  }
  return index
}

function tokenizeContent(text) {
  const tokens = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '\u0000' || /\s/.test(char)) {
      index += 1
      continue
    }
    if (char === '%') {
      while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index += 1
      continue
    }
    if (char === '(') {
      const result = readLiteralString(text, index)
      tokens.push({ type: 'string', bytes: result.bytes })
      index = result.next
      continue
    }
    if (char === '<' && text[index + 1] === '<') {
      index = skipDictionary(text, index)
      continue
    }
    if (char === '<') {
      const result = readHexString(text, index)
      tokens.push({ type: 'string', bytes: result.bytes })
      index = result.next
      continue
    }
    if (char === '>') {
      index += 1
      continue
    }
    if (char === '[') {
      tokens.push({ type: 'open-array' })
      index += 1
      continue
    }
    if (char === ']') {
      const items = []
      while (tokens.length > 0 && tokens[tokens.length - 1].type !== 'open-array') {
        items.unshift(tokens.pop())
      }
      if (tokens.length > 0) tokens.pop()
      tokens.push({ type: 'array', items })
      index += 1
      continue
    }
    if (char === '/') {
      let end = index + 1
      while (end < text.length && !/[\s()<>\[\]{}\/%]/.test(text[end])) end += 1
      tokens.push({ type: 'name', value: text.slice(index + 1, end) })
      index = end
      continue
    }
    if (char === "'" || char === '"') {
      tokens.push({ type: 'op', value: char })
      index += 1
      continue
    }
    if (/[A-Za-z*]/.test(char)) {
      let end = index + 1
      while (end < text.length && /[A-Za-z*0-9]/.test(text[end])) end += 1
      tokens.push({ type: 'op', value: text.slice(index, end) })
      index = end
      continue
    }
    const numberMatch = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(text.slice(index, index + 32))
    if (numberMatch) {
      tokens.push({ type: 'number', value: Number(numberMatch[0]) })
      index += numberMatch[0].length
      continue
    }
    index += 1
  }
  return tokens
}

function decodeUtf16BeHex(hex) {
  let output = ''
  for (let index = 0; index + 4 <= hex.length; index += 4) {
    output += String.fromCharCode(Number.parseInt(hex.slice(index, index + 4), 16))
  }
  return output
}

function parseToUnicodeCMap(text) {
  const map = new Map()
  let byteLength = 0

  const codeSpace = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text)
  if (codeSpace) {
    const first = /<([0-9A-Fa-f]+)>/.exec(codeSpace[1])
    if (first && first[1].length > 0) byteLength = Math.max(1, Math.ceil(first[1].length / 2))
  }

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    const pattern = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g
    let match
    while ((match = pattern.exec(block[1])) !== null) {
      map.set(Number.parseInt(match[1], 16), decodeUtf16BeHex(match[2]))
      if (byteLength === 0) byteLength = Math.max(1, Math.ceil(match[1].length / 2))
    }
  }

  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const pattern = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g
    let match
    while ((match = pattern.exec(block[1])) !== null) {
      const low = Number.parseInt(match[1], 16)
      const high = Number.parseInt(match[2], 16)
      if (byteLength === 0) byteLength = Math.max(1, Math.ceil(match[1].length / 2))
      if (match[3] !== undefined) {
        const base = Number.parseInt(match[3].slice(-4), 16)
        const span = Math.min(high - low, MAX_CMAP_RANGE)
        for (let offset = 0; offset <= span; offset += 1) {
          map.set(low + offset, String.fromCharCode(base + offset))
        }
      } else if (match[4] !== undefined) {
        const destinations = [...match[4].matchAll(/<([0-9A-Fa-f]*)>/g)].map((item) => decodeUtf16BeHex(item[1]))
        destinations.forEach((destination, offset) => {
          if (low + offset <= high) map.set(low + offset, destination)
        })
      }
    }
  }

  return { map, byteLength: byteLength || 1 }
}

function decodeWithCMap(bytes, cmap) {
  const width = cmap.byteLength
  if (width <= 0) return bytes.toString('latin1')
  let output = ''
  for (let index = 0; index + width <= bytes.length; index += width) {
    let code = 0
    for (let offset = 0; offset < width; offset += 1) {
      code = code * 256 + bytes[index + offset]
    }
    const mapped = cmap.map.get(code)
    if (mapped !== undefined) output += mapped
    else if (width === 1) output += String.fromCharCode(code)
  }
  return output
}

function printableRatio(text) {
  if (text.length === 0) return 1
  let printable = 0
  for (const char of text) {
    const code = char.charCodeAt(0)
    if (code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0x7e) || code > 0xa0) printable += 1
  }
  return printable / text.length
}

function decodePdfString(bytes, cmap) {
  if (!cmap) return bytes.toString('latin1')
  const decoded = decodeWithCMap(bytes, cmap)
  if (cmap.byteLength > 1) {
    const expected = bytes.length / cmap.byteLength
    const yieldRatio = expected > 0 ? decoded.length / expected : 1
    const ascii = bytes.toString('latin1')
    if (yieldRatio < 0.6 && printableRatio(ascii) > 0.9) return ascii
  }
  return decoded
}

function extractTextFromContent(content, resolveCMap) {
  const tokens = tokenizeContent(content)
  let output = ''
  let operands = []
  let fontName = null

  const lastString = () => {
    for (let index = operands.length - 1; index >= 0; index -= 1) {
      if (operands[index].type === 'string') return operands[index]
    }
    return null
  }

  for (const token of tokens) {
    if (token.type !== 'op') {
      operands.push(token)
      continue
    }
    switch (token.value) {
      case 'Tf': {
        for (let index = operands.length - 1; index >= 0; index -= 1) {
          if (operands[index].type === 'name') {
            fontName = operands[index].value
            break
          }
        }
        break
      }
      case 'Tj': {
        const string = lastString()
        if (string) output += decodePdfString(string.bytes, resolveCMap(fontName))
        break
      }
      case 'TJ': {
        let array = null
        for (let index = operands.length - 1; index >= 0; index -= 1) {
          if (operands[index].type === 'array') {
            array = operands[index]
            break
          }
        }
        if (array) {
          for (const item of array.items) {
            if (item.type === 'string') output += decodePdfString(item.bytes, resolveCMap(fontName))
          }
        }
        break
      }
      case "'":
      case '"': {
        const string = lastString()
        if (string) output += `\n${decodePdfString(string.bytes, resolveCMap(fontName))}`
        break
      }
      default:
        break
    }
    operands = []
  }
  return output
}

function scanObjects(buffer) {
  const source = buffer.toString('latin1')
  const objects = []
  const pattern = /(\d+)\s+(\d+)\s+obj\b/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    const number = Number(match[1])
    const bodyStart = match.index + match[0].length
    const endObject = source.indexOf('endobj', bodyStart)
    const bodyEnd = endObject < 0 ? source.length : endObject
    const body = source.slice(bodyStart, bodyEnd)
    const streamKeyword = /\bstream\b/.exec(body)
    if (!streamKeyword) {
      objects.push({ number, dict: body, raw: null })
      continue
    }
    const dict = body.slice(0, streamKeyword.index)
    let dataStart = bodyStart + streamKeyword.index + 'stream'.length
    if (source[dataStart] === '\r') dataStart += 1
    if (source[dataStart] === '\n') dataStart += 1
    let dataEnd = source.indexOf('endstream', dataStart)
    if (dataEnd < 0) dataEnd = bodyEnd
    let raw = buffer.subarray(dataStart, dataEnd)
    if (raw.length > 0 && raw[raw.length - 1] === 0x0a) raw = raw.subarray(0, raw.length - 1)
    if (raw.length > 0 && raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, raw.length - 1)
    objects.push({ number, dict, raw })
  }
  return objects
}

function decodeStream(raw, dict) {
  if (!raw) return null
  if (!/\/Filter\s*(?:\[\s*)?\/FlateDecode\b/.test(dict)) return raw
  try {
    return inflateSync(raw)
  } catch {
    try {
      return inflateRawSync(raw)
    } catch {
      return null
    }
  }
}

export function readPdfText(buffer) {
  const diagnostics = []
  const safeBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '')
  const objects = scanObjects(safeBuffer)
  const streams = new Map()
  for (const object of objects) {
    if (!object.raw) continue
    const decoded = decodeStream(object.raw, object.dict)
    if (decoded) streams.set(object.number, decoded)
  }

  const fontToUnicode = new Map()
  for (const object of objects) {
    if (!/\/Type\s*\/Font\b/.test(object.dict)) continue
    const reference = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(object.dict)
    if (reference) fontToUnicode.set(object.number, Number(reference[1]))
  }

  const parsedCMaps = new Map()
  const parseCMap = (number) => {
    if (parsedCMaps.has(number)) return parsedCMaps.get(number)
    const bytes = streams.get(number)
    if (!bytes) return null
    const text = bytes.toString('latin1')
    if (!/beginbfchar|beginbfrange/.test(text)) return null
    const cmap = parseToUnicodeCMap(text)
    parsedCMaps.set(number, cmap)
    return cmap
  }

  const nameToCMap = new Map()
  for (const object of objects) {
    const block = /\/Font\s*<<([\s\S]*?)>>/.exec(object.dict)
    if (!block) continue
    const pattern = /\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g
    let match
    while ((match = pattern.exec(block[1])) !== null) {
      const fontNumber = Number(match[2])
      const unicodeNumber = fontToUnicode.get(fontNumber)
      const cmap = unicodeNumber === undefined ? null : parseCMap(unicodeNumber)
      if (cmap) nameToCMap.set(match[1], cmap)
    }
  }

  const fallbackCMaps = []
  for (const [number, bytes] of streams) {
    if (parsedCMaps.has(number)) continue
    if (/beginbfchar|beginbfrange/.test(bytes.toString('latin1'))) {
      const cmap = parseCMap(number)
      if (cmap) fallbackCMaps.push(cmap)
    }
  }
  const fallbackCMap = fallbackCMaps.length === 1 ? fallbackCMaps[0] : null
  const resolveCMap = (name) => nameToCMap.get(name) ?? fallbackCMap

  let text = ''
  for (const [, bytes] of streams) {
    const content = bytes.toString('latin1')
    if (!/\bTj\b|\bTJ\b|\bBT\b/.test(content)) continue
    if (printableRatio(content.slice(0, 2048)) < 0.85) continue
    text += extractTextFromContent(content, resolveCMap)
  }

  let pages = 0
  for (const object of objects) {
    if (/\/Type\s*\/Page\b/.test(object.dict)) pages += 1
  }
  if (pages === 0) {
    const count = /\/Type\s*\/Pages\b[^]*?\/Count\s+(\d+)/.exec(objects.map((object) => object.dict).join('\n'))
    if (count) pages = Number(count[1])
  }

  if (text.trim().length < MIN_TEXT_CHARS) {
    diagnostics.push(
      diagnostic({
        error_code: READER_CODES.PDF_NO_TEXT,
        severity: SEVERITY.ERROR,
        field_path: '/text',
        message: `PDF 里只提取到 ${text.trim().length} 个字符（少于 ${MIN_TEXT_CHARS}），判定为没有文本层。`,
        suggested_fix: '这个 PDF 可能是扫描件或纯图片；先做 OCR，或改用带文本层的导出文件。',
      }),
    )
  }

  return { text, pages, diagnostics }
}
