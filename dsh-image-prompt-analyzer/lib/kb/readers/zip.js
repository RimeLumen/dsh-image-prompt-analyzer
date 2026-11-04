
import { inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

function findEndOfCentralDirectory(buffer) {
  const start = Math.max(0, buffer.length - 0xffff - 22)
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  return -1
}

function decodeEntryName(bytes, flags) {
  return bytes.toString((flags & 0x0800) !== 0 ? 'utf8' : 'latin1')
}

export function readZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error('不是有效的 ZIP：内容为空或短于 EOCD 记录')
  }
  const eocd = findEndOfCentralDirectory(buffer)
  if (eocd < 0) throw new Error('不是有效的 ZIP：找不到中央目录结束标记')

  const totalEntries = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (centralOffset + centralSize > buffer.length) {
    throw new Error('ZIP 中央目录越界：文件可能被截断')
  }

  const entries = new Map()
  let offset = centralOffset
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error(`ZIP 中央目录第 ${index + 1} 项损坏`)
    }
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const nameBytes = buffer.subarray(offset + 46, offset + 46 + nameLength)
    const name = decodeEntryName(nameBytes, flags)

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`ZIP 条目 ${name} 的本地文件头损坏`)
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buffer.length) throw new Error(`ZIP 条目 ${name} 的数据被截断`)

    const raw = buffer.subarray(dataStart, dataEnd)
    if (method === 0) {
      entries.set(name, Buffer.from(raw))
    } else if (method === 8) {
      entries.set(name, inflateRawSync(raw))
    } else {
      throw new Error(`ZIP 条目 ${name} 使用了不支持的压缩方法（${method}），只支持 stored/deflate`)
    }

    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}
