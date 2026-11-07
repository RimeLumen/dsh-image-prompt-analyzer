
// 只读文件头判断"这到底是什么图、多大"。
// HTTP 的 Content-Type 由对方填写，写错或缺失都不该让超限的图落盘；
// 这里按魔数确认格式，再从头部读出真实宽高。

export const IMAGE_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function asBytes(input) {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  return null
}

function matches(bytes, offset, pattern) {
  if (bytes.byteLength < offset + pattern.length) return false
  for (let index = 0; index < pattern.length; index += 1) {
    if (bytes[offset + index] !== pattern[index]) return false
  }
  return true
}

function uint16BE(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function uint32BE(bytes, offset) {
  return ((bytes[offset] << 24) >>> 0) + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])
}

function uint24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

function sniffPng(bytes) {
  if (!matches(bytes, 0, PNG_SIGNATURE) || bytes.byteLength < 24) return null
  // IHDR 必须是第一个块，宽高紧跟在 8 字节块头之后。
  if (!matches(bytes, 12, [0x49, 0x48, 0x44, 0x52])) return null
  return { mediaType: 'image/png', width: uint32BE(bytes, 16), height: uint32BE(bytes, 20) }
}

function sniffJpeg(bytes) {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 9 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    // 填充字节与无长度的标记：跳过，不算段。
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += marker === 0xff ? 1 : 2
      continue
    }
    const length = uint16BE(bytes, offset + 2)
    if (length < 2) return null
    // SOF0-SOF15 里除了 DHT/JPG/DAC 三个，其余都带帧尺寸。
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrameHeader) {
      return { mediaType: 'image/jpeg', width: uint16BE(bytes, offset + 7), height: uint16BE(bytes, offset + 5) }
    }
    if (marker === 0xd9 || marker === 0xda) return null
    offset += 2 + length
  }
  return null
}

function sniffGif(bytes) {
  if (!matches(bytes, 0, [0x47, 0x49, 0x46, 0x38]) || bytes.byteLength < 10) return null
  if (bytes[4] !== 0x37 && bytes[4] !== 0x39) return null
  if (bytes[5] !== 0x61) return null
  return { mediaType: 'image/gif', width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) }
}

function sniffWebp(bytes) {
  if (!matches(bytes, 0, [0x52, 0x49, 0x46, 0x46]) || !matches(bytes, 8, [0x57, 0x45, 0x42, 0x50])) return null
  if (bytes.byteLength < 30) return null
  if (matches(bytes, 12, [0x56, 0x50, 0x38, 0x58])) {
    return { mediaType: 'image/webp', width: uint24LE(bytes, 24) + 1, height: uint24LE(bytes, 27) + 1 }
  }
  if (matches(bytes, 12, [0x56, 0x50, 0x38, 0x4c])) {
    if (bytes[20] !== 0x2f) return null
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)
    return {
      mediaType: 'image/webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    }
  }
  if (matches(bytes, 12, [0x56, 0x50, 0x38, 0x20])) {
    // 有损 WebP：3 字节帧标记之后是同步码 9d 01 2a，再往后 14 位宽、14 位高。
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null
    return {
      mediaType: 'image/webp',
      width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
    }
  }
  return null
}

/**
 * 返回 `{ mediaType, width, height }`；不是可识别的图片就返回 null。
 * 宽高为 0 也当识别失败——那说明头部是坏的，没法据此判断是否超限。
 */
export function sniffImage(input) {
  const bytes = asBytes(input)
  if (!bytes || bytes.byteLength < 10) return null
  const info = sniffPng(bytes) ?? sniffJpeg(bytes) ?? sniffGif(bytes) ?? sniffWebp(bytes)
  if (!info) return null
  if (!Number.isFinite(info.width) || !Number.isFinite(info.height)) return null
  if (info.width <= 0 || info.height <= 0) return null
  return info
}
