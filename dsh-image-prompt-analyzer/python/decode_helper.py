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

import colorsys
import io
import json
import math
import os
import sys
import traceback

# Pillow 的像素炸弹阈值：设成调用方给的 max_pixels 后，超限会抛
# DecompressionBombError，这样"拒绝超大图"发生在真正解码之前。
try:
    import numpy as np

    NUMPY_AVAILABLE = True
except Exception:  # pragma: no cover - numpy 缺失时几何指标退化为 None
    np = None
    NUMPY_AVAILABLE = False

try:
    from PIL import Image, ImageOps, UnidentifiedImageError

    try:
        from PIL import ImageFilter, ImageStat
    except Exception:  # pragma: no cover - 只在 Pillow 被裁剪时触发
        ImageFilter = None
        ImageStat = None

    PILLOW_AVAILABLE = True
    try:
        import PIL

        PILLOW_VERSION = getattr(PIL, "__version__", "unknown")
    except Exception:  # pragma: no cover - 只在 Pillow 自身损坏时触发
        PILLOW_VERSION = "unknown"
except Exception:  # pragma: no cover
    Image = None
    ImageOps = None
    ImageFilter = None
    ImageStat = None
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


def _percentile_from_histogram(histogram, fraction, total):
    """从 256 桶直方图里取分位点，返回 0–1 的亮度值。"""
    target = max(1.0, fraction * total)
    seen = 0
    for index, count in enumerate(histogram):
        seen += count
        if seen >= target:
            return index / 255.0
    return 1.0


def image_metrics(image, sample_edge=256):
    """像素级预检：只给**可测量**的结论，不给审美判断。

    为什么要有这一层：视觉模型对"这是不是黑白图""有没有雾"的判断会被题材先验
    带偏——人像一律给发色，街景一律给雨夜。像素统计是确定性的，把它当证据写进
    阶段 A 的提示，才能压住这类幻觉。这里给的每个数都能被复算，不会被模型改写。
    """
    if ImageFilter is None or ImageStat is None:
        return None
    try:
        sample = image.copy()
        if sample.mode in ("RGBA", "LA", "P"):
            sample = sample.convert("RGBA")
            background = Image.new("RGBA", sample.size, (128, 128, 128, 255))
            sample = Image.alpha_composite(background, sample)
        sample.thumbnail((sample_edge, sample_edge), Image.LANCZOS)
        rgb = sample.convert("RGB")
    except Exception:  # noqa: BLE001 - 指标算不出来不该阻断解码
        return None

    luma = rgb.convert("L")
    luma_hist = luma.histogram()
    total = float(sum(luma_hist)) or 1.0
    luma_mean = sum(index * count for index, count in enumerate(luma_hist)) / total / 255.0
    variance = (
        sum(((index / 255.0 - luma_mean) ** 2) * count for index, count in enumerate(luma_hist)) / total
    )
    luma_std = math.sqrt(max(variance, 0.0))

    saturation_hist = rgb.convert("HSV").split()[1].histogram()
    sat_total = float(sum(saturation_hist)) or 1.0
    sat_mean = sum(index * count for index, count in enumerate(saturation_hist)) / sat_total / 255.0
    # S ≤ 20/255（约 8%）视为"无彩"，这个比例最能区分黑白图与低饱和彩图。
    mono_ratio = sum(saturation_hist[:21]) / sat_total

    stats = ImageStat.Stat(rgb)
    mean_r, mean_g, mean_b = stats.mean[0], stats.mean[1], stats.mean[2]
    # Hasler–Süsstrunk colorfulness：对"整体有色但偏灰"比平均饱和度更稳。
    #
    # 这里必须用 **R−G 与 ½(R+G)−B 这两张图各自的统计量**，不是"R 的标准差减 G 的标准差"。
    # 旧实现写的是 std_r - std_g：那是两个标准差的差，跟"差图的标准差"根本不是一回事
    #（σ_{R−G} ≠ σ_R − σ_G）。实测后果是系统性低估——红绿蓝六条纯色条并排的图，
    # 每个通道的分布一模一样，std_r - std_g 正好为 0，算出来 colorfulness 只有 2.2，
    # 而按定义算是 277.7；这直接骗过下面 `colorfulness < 9` 的单色判定与
    # `colorfulness < 26` 的双色调判定。现在按定义把两张差图真的算出来再取均值与标准差。
    np_rgb = np.asarray(rgb, dtype=np.float32)
    rg = np_rgb[:, :, 0] - np_rgb[:, :, 1]
    yb = 0.5 * (np_rgb[:, :, 0] + np_rgb[:, :, 1]) - np_rgb[:, :, 2]
    rg_std = float(rg.std())
    yb_std = float(yb.std())
    rg_mean = float(rg.mean())
    yb_mean = float(yb.mean())
    colorfulness = math.sqrt(rg_std ** 2 + yb_std ** 2) + 0.3 * math.sqrt(rg_mean ** 2 + yb_mean ** 2)

    edge_energy = ImageStat.Stat(luma.filter(ImageFilter.FIND_EDGES)).mean[0]
    luma_p01 = _percentile_from_histogram(luma_hist, 0.01, total)
    luma_p99 = _percentile_from_histogram(luma_hist, 0.99, total)
    dark_ratio = sum(luma_hist[:32]) / total
    bright_ratio = sum(luma_hist[225:]) / total

    # 雾/霾的物理表现：局部对比被散射吃掉（边缘能量低）+ 黑场被抬起来（p01 高）。
    # 早期版本把这两项乘上"去饱和系数"，实测会把蓝灰色的真实雾景压到阈值以下
    #（雾里仍然有颜色，只是对比度低），所以改成加权和；去饱和只做温和修正。
    # 单色图另算：无彩像素占绝大多数时，饱和度无法区分"雾"与"黑白照"，直接判否。
    scatter = max(0.0, 1.0 - min(1.0, edge_energy / 26.0))
    lift = max(0.0, min(1.0, (luma_p01 - 0.12) / 0.45))
    desaturation = max(0.0, 1.0 - min(1.0, sat_mean / 0.35))
    haze = (0.65 * scatter + 0.35 * lift) * (0.5 + 0.5 * desaturation)

    palette = []
    try:
        small = rgb.resize((64, 64), Image.LANCZOS)
        colors = small.getcolors(64 * 64) or []
        colors.sort(key=lambda item: item[0], reverse=True)
        color_total = float(sum(count for count, _ in colors)) or 1.0
        for count, color in colors[:4]:
            hue_deg = round(colorsys.rgb_to_hsv(color[0] / 255.0, color[1] / 255.0, color[2] / 255.0)[0] * 360.0)
            palette.append(
                {
                    "hex": "#%02x%02x%02x" % (color[0], color[1], color[2]),
                    "share": round(count / color_total, 3),
                    "hue": hue_deg,
                }
            )
    except Exception:  # noqa: BLE001
        palette = []

    monochrome = bool(colorfulness < 9.0 and mono_ratio >= 0.9)
    # 单色图曾经被判"不可能是雾"，理由是"饱和度为 0 是色彩制式造成的"——但那只
    # 说明去饱和那半项失效，亮度证据（黑场被抬起 + 局部对比被吃掉）完全独立于
    # 色彩制式。灰阶雾景图因此被整类漏判，这是"雾气质感完全没有"的直接原因。
    # 现在的做法：单色图不再归零，只是把去饱和那半项换成中性权重 1.0（它既不能
    # 证明有雾，也不能反驳有雾），判断交给 brightness 证据。
    if monochrome:
        haze = 0.65 * scatter + 0.35 * lift
    hazy = bool(haze >= 0.5 and edge_energy < 18.0)
    # 双色调（棕褐/青橙这类）：两个主色占比高、色相明显不同、整体仍偏灰。
    near_duotone = False
    if not monochrome and len(palette) >= 2:
        top_share = palette[0]["share"] + palette[1]["share"]
        hue_gap = abs(palette[0]["hue"] - palette[1]["hue"])
        hue_gap = min(hue_gap, 360 - hue_gap)
        near_duotone = bool(top_share >= 0.7 and hue_gap >= 25 and colorfulness < 26)

    return {
        "sample_edge": sample_edge,
        "luma_mean": round(luma_mean, 4),
        "luma_std": round(luma_std, 4),
        "luma_p01": round(luma_p01, 4),
        "luma_p99": round(luma_p99, 4),
        "dark_ratio": round(dark_ratio, 4),
        "bright_ratio": round(bright_ratio, 4),
        "sat_mean": round(sat_mean, 4),
        "mono_ratio": round(mono_ratio, 4),
        "colorfulness": round(colorfulness, 2),
        "edge_energy": round(edge_energy, 2),
        "haze_score": round(haze, 4),
        "palette": palette,
        "verdict": {
            "monochrome": monochrome,
            "near_duotone": near_duotone,
            "hazy": hazy,
        },
    }


def frame_geometry(image, sample_edge=384):
    """量出画面的几何事实：主体落在哪、占多大、画面左右对称到什么程度、最亮处在哪。

    为什么要在像素层量：构图是最容易被"看起来像"骗过的一维。模型看到竖幅人像，
    一律说"居中构图、全身景别"，但主体到底偏左 12% 还是居中、头顶留白占几成、
    画面重心在上半还是下半，这些是可以直接算出来的。给模型数字，它就不必猜。
    """
    if ImageFilter is None or not NUMPY_AVAILABLE:
        return None
    try:
        sample = image.convert("L")
        sample.thumbnail((sample_edge, sample_edge), Image.LANCZOS)
        pixels = np.asarray(sample, dtype=np.float32)
        height, width = pixels.shape

        # 显著性 = 与"大幅模糊后的自己"的差：背景近似平滑，主体轮廓会突出。
        blurred = np.asarray(sample.filter(ImageFilter.GaussianBlur(24)), dtype=np.float32)
        saliency = np.abs(pixels - blurred)
        threshold = max(18.0, float(np.percentile(saliency, 92)))
        mask = saliency >= threshold
        rows = np.nonzero(mask.any(axis=1))[0]
        cols = np.nonzero(mask.any(axis=0))[0]
        if rows.size == 0 or cols.size == 0:
            return None

        x0 = float(cols.min()) / width
        x1 = float(cols.max() + 1) / width
        y0 = float(rows.min()) / height
        y1 = float(rows.max() + 1) / height
        area_ratio = float(mask.mean())

        weights = saliency[mask]
        weight_sum = float(weights.sum()) or 1.0
        centroid_x = float((np.nonzero(mask)[1] * weights).sum() / weight_sum) / width
        centroid_y = float((np.nonzero(mask)[0] * weights).sum() / weight_sum) / height

        offset_x = centroid_x - 0.5
        if abs(offset_x) <= 0.06:
            placement = "centered"
        elif offset_x < 0:
            placement = "left"
        else:
            placement = "right"

        # 对称度只在主体所占的那块区域里量，不能拿整幅比。
        #
        # 整幅比会被背景吃掉：高调逆光/纯色雾背景的左右两侧几乎一模一样，
        # 哪怕人物明明侧着身子、头发整片甩向一边，整幅对称度照样能到 0.89，
        # 于是提示词里"低于 0.85 不许写 symmetrical composition"这道闸门形同虚设，
        # 模型就会写出 symmetric left-right balance —— 而这句话正是把侧身掰回正对的主力。
        # 只比主体框内的像素，背景的平坦亮面不参与，量出来才和"人物是不是对称"相关。
        box_h = rows.max() + 1 - rows.min()
        box_w = cols.max() + 1 - cols.min()
        if box_h >= 8 and box_w >= 8:
            region = pixels[rows.min() : rows.max() + 1, cols.min() : cols.max() + 1]
            symmetry = 1.0 - float(np.abs(region - region[:, ::-1]).mean()) / 255.0
        else:
            # 主体框小到没有统计意义（例如极小的贴图或纯色图），退回整幅比。
            symmetry = 1.0 - float(np.abs(pixels - pixels[:, ::-1]).mean()) / 255.0

        # 最亮处 = 光源方向（逆光/顶光/侧光的判据之一）。
        glow = np.asarray(sample.filter(ImageFilter.GaussianBlur(8)), dtype=np.float32)
        bright_index = np.unravel_index(int(np.argmax(glow)), glow.shape)

        band_edges = [int(height * index / 5.0) for index in range(6)]
        bands = [
            round(float(pixels[band_edges[i] : band_edges[i + 1]].mean()) / 255.0, 3)
            for i in range(5)
        ]

        return {
            "subject_box": [round(x0, 3), round(y0, 3), round(x1, 3), round(y1, 3)],
            "subject_area_ratio": round(area_ratio, 3),
            "subject_centroid": [round(centroid_x, 3), round(centroid_y, 3)],
            "placement": placement,
            "offset_x": round(offset_x, 3),
            "offset_y": round(centroid_y - 0.5, 3),
            "margin_top": round(y0, 3),
            "margin_bottom": round(1.0 - y1, 3),
            "margin_left": round(x0, 3),
            "margin_right": round(1.0 - x1, 3),
            "symmetry": round(symmetry, 3),
            "brightest_point": [round(float(bright_index[1]) / width, 3), round(float(bright_index[0]) / height, 3)],
            "band_luma": bands,
        }
    except Exception:  # noqa: BLE001 - 指标算不出来不该阻断解码
        return None


def silhouette_metrics(image, sample_edge=256):
    """判断画面是不是"剪影"：一个接近纯黑的连通块，被亮背景包住。

    为什么单独做这一项：模型看到深色主体 + 亮背景，就会写 silhouette；
    但"深色主体"和"剪影"不是一回事——剪影要求主体内部几乎没有明度层次，
    并且边缘被背景的亮光包住。这张图恰好介于二者之间（主体最暗 38/255，
    不是纯黑，内部还有衣褶与腿部轮廓），所以程序必须把"有多黑""占多大"
    这些数算出来，让观察者不能凭印象下结论。
    """
    if ImageFilter is None:
        return None
    try:
        sample = image.convert("L")
        sample.thumbnail((sample_edge, sample_edge), Image.LANCZOS)
        histogram = sample.histogram()
        total = float(sum(histogram)) or 1.0

        def share(upto):
            return sum(histogram[:upto]) / total

        def share_from(start):
            return sum(histogram[start:]) / total

        # 主体黑度分三档：真正的纯黑（<0.25）与"深灰到中灰"要分开报。
        dark_ratio = share(64)
        deep_dark_ratio = share(40)
        mid_dark_ratio = sum(histogram[64:128]) / total
        bright_ratio = share_from(200)

        # 主体最大暗块占画面的比例：粗网格 + 连通域，够用来判断"主体占主体"。
        small = sample.resize((64, 64), Image.LANCZOS)
        pixels = list(small.getdata())
        threshold = 128
        seen = [False] * (64 * 64)
        largest = 0
        for index in range(64 * 64):
            if seen[index] or pixels[index] >= threshold:
                continue
            stack = [index]
            seen[index] = True
            size = 0
            while stack:
                current = stack.pop()
                size += 1
                row, col = divmod(current, 64)
                for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                    nr, nc = row + dr, col + dc
                    if 0 <= nr < 64 and 0 <= nc < 64:
                        neighbor = nr * 64 + nc
                        if not seen[neighbor] and pixels[neighbor] < threshold:
                            seen[neighbor] = True
                            stack.append(neighbor)
            largest = max(largest, size)
        subject_share = largest / (64.0 * 64.0)

        # 剪影的两个必要条件：暗块足够大，且暗块内部没有多少中间调。
        silhouette = bool(subject_share >= 0.20 and deep_dark_ratio >= 0.02 and bright_ratio >= 0.25)
        return {
            "dark_ratio": round(dark_ratio, 4),
            "deep_dark_ratio": round(deep_dark_ratio, 4),
            "mid_dark_ratio": round(mid_dark_ratio, 4),
            "bright_ratio": round(bright_ratio, 4),
            "subject_share": round(subject_share, 4),
            "silhouette": silhouette,
        }
    except Exception:  # noqa: BLE001 - 指标算不出来不该阻断解码
        return None


def face_region_profile(image, geometry):
    """量人物头部那块区域的明度档位：暗部核心有多黑、近黑像素占多少。

    为什么必须单独量脸：逆光与剪影图里"脸很暗"和"脸是纯黑"是两件事，而观察者
    几乎一律写成后者（face in shadow / unreadable），于是编译出来的提示词把一张
    还带着五官层次与明度渐变的暗灰脸压成一块黑板。整图统计救不了这个错——亮背景
    会把均值拉到 0.6 以上，看起来"脸很亮"；真正要看的是头部**暗部核心**的亮度。

    取头部候选框 = 主体框顶部 22%、水平内缩 20%（避开飘发与外扩的肩）。在这个框
    里排序取最暗的 10% 求均值，就是脸最黑处的实际亮度；再报近黑占比作为"是否真的
    被压成纯黑"的判据。

    **这只是候选区域，不是脸部检测**：subject_box 来自显著性掩膜（|像素−模糊| 的高分位），
    它标的是"画面里最抢眼的那块"，不是"人物"、更不是"脸"。所以返回值里带
    `region_verified: False` 与 `region_source`，下游必须据此把明度当成**候选证据**，
    不能据此断言"五官可辨"。要真确认，得另有脸部检测或复核确认。
    """
    if ImageFilter is None or not NUMPY_AVAILABLE or not isinstance(geometry, dict):
        return None
    box = geometry.get("subject_box")
    if not isinstance(box, (list, tuple)) or len(box) != 4:
        return None
    try:
        x0, y0, x1, y1 = (float(value) for value in box)
        width, height = image.size
        inset = (x1 - x0) * 0.20
        left = int((x0 + inset) * width)
        right = int((x1 - inset) * width)
        top = int(y0 * height)
        bottom = int((y0 + (y1 - y0) * 0.22) * height)
        if right - left < 8 or bottom - top < 8:
            return None

        crop = np.asarray(image.convert("L"), dtype=np.float32)[top:bottom, left:right] / 255.0
        if crop.size == 0:
            return None
        flat = np.sort(crop.ravel())
        core = flat[: max(1, flat.size // 10)]

        dark_core = float(core.mean())
        black_share = float((flat < 0.06).mean())
        mid_share = float(((flat >= 0.10) & (flat < 0.35)).mean())

        # 三档，按暗部核心亮度分：纯黑 < 0.08，暗但有层次 < 0.30，暗部带光 >= 0.30。
        if black_share >= 0.15 and dark_core <= 0.08:
            band = "blackout"
        elif dark_core < 0.08:
            band = "near_black"
        elif dark_core < 0.30:
            band = "shadowed"
        else:
            band = "lit"

        return {
            "box": [round(left / width, 3), round(top / height, 3), round(right / width, 3), round(bottom / height, 3)],
            "dark_core_luma": round(dark_core, 3),
            "black_share": round(black_share, 3),
            "mid_dark_share": round(mid_share, 3),
            "band": band,
            "blackout": band == "blackout",
            # 这块区域是从显著性框切出来的候选，不是脸部检测的结果。
            # 下游只能把它当"候选区域的明度"，不能据此裁决五官是否可辨。
            "region_verified": False,
            "region_source": "subject_box_top_22pct",
        }
    except Exception:  # noqa: BLE001 - 指标算不出来不该阻断解码
        return None


def background_profile(image, sample_edge=256, haze=0.0, diffuse=False):
    """量出"背景"到底是什么：取样的亮度、纯净度、均匀度、渐变程度与细节量。

    为什么要由程序量：环境是反推里最容易跑偏、又最难靠文字纠正的一维。
    模型写的 "bright background" 是形容词，生成端不认识；真正能控住画面四周的是
    white background / simple background / gradient background 这几个标签。
    但该写哪一个取决于像素——四周是近白纯场、是带渐变的高调亮场、是一块平涂色、
    还是塞满东西的实景，四者对应的标签完全不同，凭印象选一定错。

    取样范围刻意避开画面下半：全身像的底部是地面与脚，把它算进"背景"会让一张
    纯白背景图被判成灰背景。所以取顶部横带 + 左右两条竖带（不含下半）。
    """
    if not NUMPY_AVAILABLE or ImageFilter is None:
        return None
    try:
        rgb = image.convert("RGB")
        rgb.thumbnail((sample_edge, sample_edge), Image.LANCZOS)
        arr = np.asarray(rgb, dtype=np.float32)
        height, width, _ = arr.shape
        if height < 12 or width < 12:
            return None

        top_band = max(1, int(round(height * 0.18)))
        side_w = max(1, int(round(width * 0.12)))
        side_top = top_band
        side_bottom = max(side_top + 1, int(round(height * 0.75)))
        mask = np.zeros((height, width), dtype=bool)
        mask[:top_band, :] = True
        mask[side_top:side_bottom, :side_w] = True
        mask[side_top:side_bottom, width - side_w :] = True

        luma = (0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]) / 255.0
        top = arr.max(axis=2)
        sat = (top - arr.min(axis=2)) / np.maximum(top, 1.0)
        values = luma[mask]
        sats = sat[mask]
        if values.size == 0:
            return None

        near_white = float((values >= 0.93).mean())
        bright = float((values >= 0.85).mean())
        dark = float((values <= 0.25).mean())
        luma_mean = float(values.mean())
        luma_std = float(values.std())
        sat_mean = float(sats.mean())
        # 顶部与左右分别求均值：差值大说明是"有方向的渐变"，差值小才是平场。
        edges = {
            "top": float(luma[:top_band, :].mean()),
            "left": float(luma[side_top:side_bottom, :side_w].mean()),
            "right": float(luma[side_top:side_bottom, width - side_w :].mean()),
        }
        spread = max(edges.values()) - min(edges.values())
        # 用分位差而不是标准差判"平场"：主体边缘会漏进取样带，标准差被少数暗像素拖大，
        # 一张纯白背景图会被误判成渐变。p90-p10 只看中间 80% 的像素，抗这种污染。
        p10, p90 = (float(x) for x in np.percentile(values, [10, 90]))
        flat = bool((p90 - p10) <= 0.08 and spread <= 0.10)
        gy, gx = np.gradient(luma)
        detail = float((np.sqrt(gx**2 + gy**2) * 255.0)[mask].mean())

        # 雾光场：亮、有渐变、饱和度低，但近白占比不高——也就是"背景是光与雾，
        # 不是一张白纸"。只靠 near_white 判会把它归成 high_key，然后补一个
        # white background，生成端就会给你一片纯白纸，光影与空气全丢。
        misty = bool(
            haze >= 0.28
            and luma_mean >= 0.55
            and near_white < 0.45
            and (not flat or diffuse)
        )

        if near_white >= 0.45:
            kind = "white"
        elif misty:
            kind = "hazy"
        elif luma_mean >= 0.72 and sat_mean <= 0.08:
            kind = "high_key"
        elif dark >= 0.5:
            kind = "dark"
        elif flat and sat_mean >= 0.10:
            kind = "solid"
        elif detail >= 6.0:
            kind = "scene"
        else:
            kind = "soft"

        # 只输出有像素依据的标签：没证据就不写，宁可少一个控制词，也不要凭空造环境。
        tags = []
        if kind == "white":
            tags.append("white background")
        elif kind == "hazy":
            # 雾光场能控住的不是颜色而是"光在空气里"：亮背景 + 雾 + 渐变。
            tags.append("bright_background" if luma_mean >= 0.70 else "grey_background")
            tags.append("fog" if haze >= 0.50 else "haze")
            if not flat:
                tags.append("gradient_background")
        elif kind == "high_key":
            tags.append("white background" if near_white >= 0.18 else "grey background")
        elif kind == "dark" and luma_mean <= 0.12:
            tags.append("black background")
        if kind not in ("scene", "hazy"):
            tags.append("simple background")
        if not flat and kind in ("white", "high_key", "solid"):
            tags.append("gradient background")
        if kind == "scene" and detail <= 12.0:
            tags.append("blurry background")

        return {
            "kind": kind,
            "tags": tags,
            "evidence": {
                "near_white_ratio": round(near_white, 4),
                "bright_ratio": round(bright, 4),
                "dark_ratio": round(dark, 4),
                "luma_mean": round(luma_mean, 4),
                "luma_std": round(luma_std, 4),
                "sat_mean": round(sat_mean, 4),
                "edge_spread": round(spread, 4),
                "detail": round(detail, 2),
                "haze": round(float(haze), 4),
                "diffuse": bool(diffuse),
                "misty": misty,
                "flat": flat,
            },
        }
    except Exception:  # noqa: BLE001 - 背景测不出来不该阻断解码
        return None



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
    # 像素预检（黑白/双色调/雾霾）在这里算：解码只做一次，指标顺手就拿到了。
    metrics = image_metrics(image)
    if isinstance(metrics, dict):
        geometry = frame_geometry(image)
        if geometry is not None:
            metrics["geometry"] = geometry
        # 朦胧感 = 黑场被抬高 + 对比被压低 + 边缘发软。三项独立于色彩制式，
        # 因此灰阶图同样成立；这是"灰蒙蒙"与"干净的高调"之间的分界。
        p01 = float(metrics.get("luma_p01") or 0.0)
        std = float(metrics.get("luma_std") or 0.0)
        edge = float(metrics.get("edge_energy") or 0.0)
        lifted = p01 >= 0.18
        flat = std <= 0.24
        soft = edge <= 18.0
        metrics["diffusion"] = {
            "lifted_black": bool(lifted),
            "low_contrast": bool(flat),
            "soft_edges": bool(soft),
            "score": round((float(lifted) + float(flat) + float(soft)) / 3.0, 3),
            "diffuse": bool(lifted and flat and soft),
        }
    silhouette = silhouette_metrics(image)
    if isinstance(metrics, dict) and silhouette is not None:
        metrics["silhouette"] = silhouette
        verdict = metrics.get("verdict")
        if isinstance(verdict, dict):
            verdict["silhouette"] = silhouette["silhouette"]
    background = background_profile(image, haze=float(metrics.get("haze_score") or 0.0), diffuse=bool((metrics.get("diffusion") or {}).get("diffuse")))
    if isinstance(metrics, dict) and background is not None:
        metrics["background"] = background
    # 头部明度：脸"暗"与脸"纯黑"的分界。整图均值在这里没有意义（亮背景会把它抬高），
    # 必须取头部框的暗部核心。拿不到主体框就留空，让编译层保持沉默。
    face = face_region_profile(image, (metrics or {}).get("geometry"))
    if isinstance(metrics, dict) and face is not None:
        metrics["face"] = face
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
                "metrics": metrics,
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
