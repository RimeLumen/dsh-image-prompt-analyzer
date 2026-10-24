#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DSH 图像提示词逆向插件 —— 唯一的 Python 入口。

为什么图像解码要单独走 Python：

- Pillow 是本机唯一已验证可用的成熟解码器（Pillow 12.1.1 / Python 3.10.6）。
- Node 侧不引入任何原生图像模块（`sharp` 等），避免 Windows 编译链风险。
- 一次分析**只调用一次**本脚本，把"格式校验 → 解码 → 方向校正 → alpha 处理 →
  尺寸限制 → 局部裁剪"一次做完，避免多次进程启动与多次全图解码。

协议（与 §4.3 一致，不额外发明字段）：

  请求：JSON 走 stdin，形如
    {"op": "prepare", "src": "...", "out_dir": "...", "max_edge": 4096, ...}
  响应：JSON 走 stdout，形如
    {"ok": true, "image": {...}, "crops": [...], "warnings": [...]}
        {"ok": false, "error": {"code": "...", "message": "...", "detail": "..."}}
  stderr：只用于人可读的错误摘要，**永远不承载协议数据**。

硬约束（文档 §8 / §11）：

- **绝不修改用户原图**：本脚本对 `src` 只读打开，所有写操作都发生在 `out_dir` 下。
- **透明像素不得被当成背景**：alpha 通道原样保留，透明比例单独回报，
  不把透明区合成成某个颜色。
- **不把转换后的预览图称为原始 RAW 数据**：响应里用 `normalized_path`，
  并单独回报 `src_format` 与 `decoded_via`，调用方不得把前者当成后者。
- 临时文件的生命周期由 Node 侧按 `temp_ttl_minutes` 清扫，本脚本只负责创建。
"""

import io
import json
import os
import sys
import traceback

# Pillow 的像素炸弹阈值：设成调用方给的 max_pixels 后，超限会抛
# DecompressionBombError，这样"拒绝超大图"发生在真正解码之前。
try:
    from PIL import Image, ImageOps, UnidentifiedImageError

    PILLOW_AVAILABLE = True
    try:
        import PIL

        PILLOW_VERSION = getattr(PIL, "__version__", "unknown")
    except Exception:  # pragma: no cover - 只在 Pillow 自身损坏时触发
        PILLOW_VERSION = "unknown"
except Exception:  # pragma: no cover
    Image = None
    ImageOps = None
    PILLOW_AVAILABLE = False
    PILLOW_VERSION = None

    class UnidentifiedImageError(Exception):
        """Pillow 缺失时的占位异常，保证模块可导入。"""


try:
    import rawpy

    RAWPY_AVAILABLE = True
    RAWPY_VERSION = getattr(rawpy, "__version__", "unknown")
except Exception:
    rawpy = None
    RAWPY_AVAILABLE = False
    RAWPY_VERSION = None


# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

#: 第一版支持的位图格式（对应 Node 侧 `image.allowed_formats` 的取值）。
BITMAP_FORMATS = ("PNG", "JPEG", "WEBP", "BMP")

#: RAW 扩展名。RAW 是独立解码路径，不属于 Pillow 的能力范围。
RAW_EXTENSIONS = (
    ".cr2", ".cr3", ".crw", ".nef", ".nrw", ".arw", ".srf", ".sr2",
    ".dng", ".raf", ".rw2", ".orf", ".pef", ".srw", ".raw", ".rwl",
    ".3fr", ".erf", ".mef", ".mos", ".mrw", ".x3f",
)

#: 魔数签名 → 规范化格式名。用于在解码前判断"这到底是什么文件"。
#: 注意：扩展名不可信，一个叫 `a.png` 的文件完全可能是 JPEG。
MAGIC_SIGNATURES = (
    (b"\x89PNG\r\n\x1a\n", "PNG"),
    (b"\xff\xd8\xff", "JPEG"),
    (b"BM", "BMP"),
    (b"GIF87a", "GIF"),
    (b"GIF89a", "GIF"),
    (b"II*\x00", "TIFF"),
    (b"MM\x00*", "TIFF"),
)

#: 第一版不支持的、但值得单独说明的格式（否则用户只看到"无法识别"）。
KNOWN_UNSUPPORTED = {
    "GIF": "GIF 属于多帧格式，第一版只按单帧处理位图，尚未支持。",
    "TIFF": "TIFF 第一版未支持；请先转成 PNG 或 JPEG。",
}

#: 错误码 → 人可读的修复建议。Node 侧把 code 透传给模型，这里的 detail 只作补充。
ERROR_CODES = (
    "IMAGE_NOT_FOUND",
    "IMAGE_NOT_READABLE",
    "UNSUPPORTED_FORMAT",
    "RAW_DECODER_MISSING",
    "IMAGE_TOO_LARGE",
    "IMAGE_CORRUPT",
    "DECODE_FAILED",
    "BAD_REQUEST",
    "INTERNAL_ERROR",
)


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------

def emit(payload):
    """把响应写成 stdout 上的一行 JSON。

    **必须显式按 UTF-8 写字节**：Windows 上 `sys.stdout` 的编码跟随控制台代码页
    （中文系统是 GBK），直接 `sys.stdout.write` 会把中文诊断文本写成 GBK 字节，
    Node 侧按 UTF-8 解析就会炸。协议是 UTF-8，这一点不能依赖环境默认值。
    """
    sys.stdout.buffer.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    sys.stdout.buffer.flush()


def fail(code, message, detail=None):
    """构造失败响应并退出。退出码固定为 0——协议层的成败由 `ok` 字段表达，
    非零退出码留给"脚本自己崩了"这种 Node 侧无法解释的情况。"""
    if code not in ERROR_CODES:
        code = "INTERNAL_ERROR"
    emit({"ok": False, "error": {"code": code, "message": message, "detail": detail}})
    sys.exit(0)


def warn_to_stderr(message):
    """stderr 只写人可读摘要，绝不承载协议数据。

    同样显式按 UTF-8 写字节，并且把无法编码的字符替换掉——诊断文本写不出去
    绝不能变成新的失败原因。
    """
    try:
        sys.stderr.buffer.write((str(message) + "\n").encode("utf-8", "replace"))
        sys.stderr.buffer.flush()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 格式探测
# ---------------------------------------------------------------------------

def sniff_format(path, head):
    """按魔数判断真实格式。返回 (format_name, is_raw)。

    扩展名只用于判断"是不是 RAW"——RAW 没有统一魔数，只能靠扩展名 + rawpy 探测。
    """
    ext = os.path.splitext(path)[1].lower()
    if ext in RAW_EXTENSIONS:
        return "RAW", True
    for signature, name in MAGIC_SIGNATURES:
        if head.startswith(signature):
            return name, False
    # WebP 的签名是 RIFF....WEBP，需要看第 8–12 字节。
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "WEBP", False
    return None, False


def detect_alpha(image):
    """判断是否带有效 alpha 通道。

    两个条件任一成立即算带 alpha：色彩模式自带 alpha，或 info 里有 transparency 键
    （调色板图用 `transparency` 表示透明索引，模式仍是 P）。
    """
    if image.mode in ("RGBA", "LA", "PA"):
        return True
    if image.mode == "P" and "transparency" in image.info:
        return True
    return "transparency" in image.info


def alpha_stats(image):
    """回报透明像素占比。用于让下游知道"背景里有大片透明"，而不是去猜背景色。"""
    try:
        if image.mode in ("RGBA", "LA"):
            alpha = image.getchannel("A")
            histogram = alpha.histogram()
            total = sum(histogram)
            if total == 0:
                return 0.0, 1.0
            transparent = histogram[0]
            opaque = histogram[255]
            return round(transparent / total, 4), round(opaque / total, 4)
        if image.mode == "P" and "transparency" in image.info:
            rgba = image.convert("RGBA")
            return alpha_stats(rgba)
    except Exception:
        pass
    return 0.0, 1.0


def read_exif_orientation(image):
    """读出 EXIF 方向标记（0x0112）。读不到就返回 1（表示"正常方向"）。"""
    try:
        exif = image.getexif()
        if not exif:
            return 1
        value = exif.get(0x0112)
        if isinstance(value, int) and 1 <= value <= 8:
            return value
    except Exception:
        pass
    return 1


# ---------------------------------------------------------------------------
# op: probe
# ---------------------------------------------------------------------------

def op_probe(request):
    """回报本机解码能力。Node 侧据此决定要不要走 RAW、要不要报环境问题。"""
    emit(
        {
            "ok": True,
            "python": {
                "version": sys.version.split()[0],
                "executable": sys.executable,
                "platform": sys.platform,
            },
            "pillow": {"available": PILLOW_AVAILABLE, "version": PILLOW_VERSION},
            "rawpy": {"available": RAWPY_AVAILABLE, "version": RAWPY_VERSION},
            "bitmap_formats": list(BITMAP_FORMATS),
            "raw_extensions": list(RAW_EXTENSIONS),
            "warnings": [] if PILLOW_AVAILABLE else ["Pillow 不可用：所有位图解码都会失败。"],
        }
    )


# ---------------------------------------------------------------------------
# op: prepare
# ---------------------------------------------------------------------------

def require_int(request, key, default):
    value = request.get(key, default)
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        fail("BAD_REQUEST", "参数 %s 必须是数字，实际是 %r。" % (key, value))
    return int(value)


def op_prepare(request):
    if not PILLOW_AVAILABLE:
        fail(
            "DECODE_FAILED",
            "Pillow 不可用，无法解码任何位图。",
            "本机 python 里没有可导入的 PIL/Pillow。请安装 Pillow，或用 configs 之外的 python.executable 指向正确的解释器。",
        )

    src = request.get("src")
    if not isinstance(src, str) or src.strip() == "":
        fail("BAD_REQUEST", "缺少 src。", "src 必须是待分析图片的绝对路径。")

    out_dir = request.get("out_dir")
    if not isinstance(out_dir, str) or out_dir.strip() == "":
        fail("BAD_REQUEST", "缺少 out_dir。", "out_dir 是临时输出目录，由 Node 侧在 data/tmp 下创建。")

    max_edge = require_int(request, "max_edge", 4096)
    max_pixels = require_int(request, "max_pixels", 16777216)
    max_bytes = require_int(request, "max_bytes", 33554432)
    allowed_formats = request.get("allowed_formats") or list(BITMAP_FORMATS)
    raw_enabled = bool(request.get("raw_enabled", False))
    keep_temp_files = bool(request.get("keep_temp_files", True))
    crops_request = request.get("crops") or []

    warnings = []

    # ---- 1. 存在性与可读性 -------------------------------------------------
    if not os.path.exists(src):
        fail("IMAGE_NOT_FOUND", "找不到图片：%s" % src, "确认路径拼写；路径必须是本机可访问的绝对路径。")
    if not os.path.isfile(src):
        fail("IMAGE_NOT_READABLE", "路径不是普通文件：%s" % src, "请指向一个图片文件，而不是目录或设备。")
    if not os.access(src, os.R_OK):
        fail("IMAGE_NOT_READABLE", "文件不可读：%s" % src, "检查文件权限；本插件不会尝试提权。")

    # ---- 2. 字节数上限（在读进内存之前） -----------------------------------
    size_bytes = os.path.getsize(src)
    if size_bytes > max_bytes:
        fail(
            "IMAGE_TOO_LARGE",
            "文件 %d 字节，超过上限 %d 字节。" % (size_bytes, max_bytes),
            "调大 configs 之外的 image.max_bytes，或先自行缩小图片。本插件不会为了读它而先整份载入内存。",
        )
    if size_bytes == 0:
        fail("IMAGE_CORRUPT", "文件长度为 0：%s" % src, "文件是空的，不是有效图片。")

    # ---- 3. 格式探测（解码之前，靠魔数而非扩展名） -------------------------
    with open(src, "rb") as handle:
        head = handle.read(32)

    fmt, is_raw = sniff_format(src, head)
    if fmt is None:
        fail(
            "UNSUPPORTED_FORMAT",
            "无法从文件头识别出图片格式：%s" % os.path.basename(src),
            "第一版支持 %s。扩展名不可信，本插件按文件头判断。"
            % "、".join(list(BITMAP_FORMATS) + ["RAW（需 rawpy）"]),
        )

    if is_raw:
        if not raw_enabled:
            fail(
                "UNSUPPORTED_FORMAT",
                "这是一个 RAW 文件，但第一版默认关闭 RAW 支持。",
                "把插件配置的 image.raw_enabled 设为 true 后重试；本机 rawpy 是否可用由 probe 回报。",
            )
        if not RAWPY_AVAILABLE:
            fail(
                "RAW_DECODER_MISSING",
                "需要 rawpy 才能解码 RAW，但本机没有安装 rawpy。",
                "安装 rawpy（它会带入 LibRaw 原生库），或先把 RAW 转成 PNG/JPEG 再分析。本插件不会静默降级成读一个不完整的结果。",
            )

    if not is_raw and fmt not in allowed_formats:
        detail = KNOWN_UNSUPPORTED.get(fmt)
        fail(
            "UNSUPPORTED_FORMAT",
            "格式 %s 不在允许列表内。" % fmt,
            detail or ("允许的格式：%s。" % "、".join(allowed_formats)),
        )

    # ---- 4. 解码 -----------------------------------------------------------
    # Pillow 的像素炸弹阈值设成调用方的上限，让超限在解码前就抛。
    Image.MAX_IMAGE_PIXELS = max_pixels
    decoded_via = "rawpy" if is_raw else "pillow"

    try:
        if is_raw:
            image = decode_raw(src, max_pixels)
        else:
            image = Image.open(src)
            # 惰性 open：这里只读了文件头，尺寸已知但像素还没解。
            image.load()
    except Image.DecompressionBombError:
        fail(
            "IMAGE_TOO_LARGE",
            "图片像素数超过上限 %d。" % max_pixels,
            "调大 configs 之外的 image.max_pixels，或先自行缩小图片。",
        )
    except UnidentifiedImageError:
        # 走到这里说明文件头已被认出、且格式在允许列表内，所以「Pillow 认不出」
        # 只可能是内容损坏或被截断——不能用 UNSUPPORTED_FORMAT，那会让调用方
        # 误以为"这个格式不支持"而放弃一个其实支持、只是文件坏了的输入。
        fail(
            "DECODE_FAILED",
            "文件内容已损坏或不完整，无法解码：%s" % os.path.basename(src),
            "文件头看起来像 %s，但内容不完整或不是真正的该格式。" % (fmt or "未知格式"),
        )
    except MemoryError:
        fail("IMAGE_TOO_LARGE", "解码时内存不足。", "图片对本机内存而言过大，请先缩小。")
    except Exception as exc:  # noqa: BLE001 - 统一转成结构化错误码
        fail("IMAGE_CORRUPT", "解码失败：%s" % exc, traceback.format_exc(limit=3))

    # ---- 5. 方向校正 + alpha 处理 ------------------------------------------
    orientation = read_exif_orientation(image)
    if orientation != 1:
        try:
            image = ImageOps.exif_transpose(image)
            warnings.append("已按 EXIF 方向标记 %d 旋转画面。" % orientation)
        except Exception as exc:  # noqa: BLE001
            warnings.append("EXIF 方向标记是 %d，但校正失败：%s" % (orientation, exc))
            orientation = 1

    has_alpha = detect_alpha(image)
    transparent_ratio, opaque_ratio = alpha_stats(image)

    # 透明通道**不合成、不填充背景色**：合成会让透明区变成一个真实存在的背景，
    # 下游就会把它当成"背景是白色/黑色"来写提示词（文档 §8）。
    if image.mode not in ("RGB", "RGBA", "L"):
        if has_alpha:
            image = image.convert("RGBA")
        else:
            image = image.convert("RGB")
    if not has_alpha and image.mode == "RGBA":
        # 模式带 alpha 但实际没有透明信息：转回 RGB，避免下游误判。
        image = image.convert("RGB")
        has_alpha = False

    src_width, src_height = image.size
    src_pixels = src_width * src_height
    if src_pixels > max_pixels:
        fail(
            "IMAGE_TOO_LARGE",
            "图片是 %d×%d = %d 像素，超过上限 %d。" % (src_width, src_height, src_pixels, max_pixels),
            "调大 configs 之外的 image.max_pixels，或先自行缩小图片。",
        )

    # ---- 6. 尺寸归一（等比缩小，不裁剪、不改画幅比例） ---------------------
    scale = 1.0
    longest = max(src_width, src_height)
    if longest > max_edge:
        scale = max_edge / float(longest)
        target = (max(1, int(round(src_width * scale))), max(1, int(round(src_height * scale))))
        image = image.resize(target, Image.LANCZOS)
        warnings.append("最长边 %d 超过上限 %d，已等比缩小到 %d×%d。" % (longest, max_edge, target[0], target[1]))

    width, height = image.size

    # ---- 7. 落盘 -----------------------------------------------------------
    try:
        os.makedirs(out_dir, exist_ok=True)
    except Exception as exc:  # noqa: BLE001
        fail("INTERNAL_ERROR", "无法创建输出目录 %s：%s" % (out_dir, exc))

    normalized_path = os.path.join(out_dir, "normalized.png")
    try:
        # 一律存 PNG：无损，且能原样保住 alpha。
        image.save(normalized_path, format="PNG", optimize=False)
    except Exception as exc:  # noqa: BLE001
        fail("INTERNAL_ERROR", "无法写出归一化图片：%s" % exc, traceback.format_exc(limit=3))

    # ---- 8. 局部裁剪（归一化坐标 → 像素坐标） ------------------------------
    crops = []
    for index, item in enumerate(crops_request):
        if not isinstance(item, dict):
            warnings.append("第 %d 个裁剪请求不是对象，已跳过。" % index)
            continue
        crop_id = item.get("id") or ("crop_%d" % index)
        box = item.get("box")
        if not (isinstance(box, (list, tuple)) and len(box) == 4):
            warnings.append("裁剪 %s 的 box 不是四元素数组，已跳过。" % crop_id)
            continue
        try:
            x0, y0, x1, y1 = (float(v) for v in box)
        except (TypeError, ValueError):
            warnings.append("裁剪 %s 的 box 含非数字，已跳过。" % crop_id)
            continue

        # 归一化坐标先夹到 [0,1]，再换算成像素；同时允许调用方给反序的框。
        left, right = sorted((max(0.0, min(1.0, x0)), max(0.0, min(1.0, x1))))
        top, bottom = sorted((max(0.0, min(1.0, y0)), max(0.0, min(1.0, y1))))
        if right - left <= 0 or bottom - top <= 0:
            warnings.append("裁剪 %s 的框在夹取后面积为 0，已跳过。" % crop_id)
            continue

        px_box = (
            int(left * width),
            int(top * height),
            max(int(left * width) + 1, int(round(right * width))),
            max(int(top * height) + 1, int(round(bottom * height))),
        )
        px_box = (px_box[0], px_box[1], min(px_box[2], width), min(px_box[3], height))
        if px_box[2] - px_box[0] < 8 or px_box[3] - px_box[1] < 8:
            warnings.append("裁剪 %s 在归一化图上不足 8 像素，已跳过。" % crop_id)
            continue

        crop_path = os.path.join(out_dir, "crop_%s.png" % crop_id)
        try:
            image.crop(px_box).save(crop_path, format="PNG", optimize=False)
        except Exception as exc:  # noqa: BLE001
            warnings.append("裁剪 %s 写出失败：%s" % (crop_id, exc))
            continue

        crops.append(
            {
                "id": crop_id,
                "path": crop_path,
                "width": px_box[2] - px_box[0],
                "height": px_box[3] - px_box[1],
                # 回报实际使用的归一化框，供 IR 的 region 字段直接引用。
                "box": [
                    round(px_box[0] / float(width), 4),
                    round(px_box[1] / float(height), 4),
                    round(px_box[2] / float(width), 4),
                    round(px_box[3] / float(height), 4),
                ],
            }
        )

    if not keep_temp_files:
        warnings.append("keep_temp_files 为 false，但归一化图仍需落盘供视觉后端读取；临时文件将在 TTL 到期后被清扫。")

    # ---- 9. 响应 -----------------------------------------------------------
    emit(
        {
            "ok": True,
            "image": {
                "width": width,
                "height": height,
                "source_width": src_width,
                "source_height": src_height,
                "aspect_ratio": aspect_ratio(width, height),
                "has_alpha": bool(has_alpha),
                "transparent_ratio": transparent_ratio,
                "opaque_ratio": opaque_ratio,
                "src_format": fmt,
                "decoded_via": decoded_via,
                "normalized_path": normalized_path,
                "orientation_applied": orientation,
                "scale": round(scale, 6),
                "size_bytes": size_bytes,
                "mode": image.mode,
            },
            "crops": crops,
            "warnings": warnings,
        }
    )


def decode_raw(path, max_pixels):
    """RAW 解码路径。第一版默认关闭，仅在 raw_enabled 且 rawpy 可用时走到这里。

    返回的是**转换后的位图**，不是原始 RAW 数据；调用方在响应里用
    `decoded_via: "rawpy"` 与 `normalized_path` 区分二者（文档 §8）。
    """
    with rawpy.imread(path) as raw:
        rgb = raw.postprocess(use_camera_wb=True, no_auto_bright=False, output_bps=8)
    image = Image.fromarray(rgb)
    if image.size[0] * image.size[1] > max_pixels:
        fail(
            "IMAGE_TOO_LARGE",
            "RAW 解码后是 %d×%d，超过上限 %d 像素。" % (image.size[0], image.size[1], max_pixels),
            "调大 image.max_pixels 或 image.max_edge。",
        )
    return image


def aspect_ratio(width, height):
    """把画幅比例化简成 `w:h`。用于 IR 的 `image.aspect_ratio`。"""
    from math import gcd

    divisor = gcd(width, height) or 1
    return "%d:%d" % (width // divisor, height // divisor)


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def main():
    raw = sys.stdin.buffer.read()
    if not raw:
        fail("BAD_REQUEST", "stdin 是空的。", "请求必须是 JSON，例如 {\"op\": \"probe\"}。")
    try:
        request = json.loads(raw.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        fail("BAD_REQUEST", "请求不是合法 JSON：%s" % exc)

    if not isinstance(request, dict):
        fail("BAD_REQUEST", "请求的顶层必须是对象。")

    op = request.get("op")
    if op == "probe":
        op_probe(request)
    elif op == "prepare":
        op_prepare(request)
    else:
        fail("BAD_REQUEST", "未知的 op：%r" % (op,), "第一版只实现 probe 与 prepare。")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001 - 任何未预期异常都要变成结构化响应
        warn_to_stderr(traceback.format_exc())
        fail("INTERNAL_ERROR", "解码脚本内部错误。", traceback.format_exc(limit=5))
