/**
 * 色彩制式预检：在调用视觉模型之前，先用像素统计判定这张图到底是什么色彩制式。
 *
 * 为什么要单独一层：模型是按题材先验给颜色的 —— 看到少女就写 blonde hair，
 * 看到夜景就写 blue tone，哪怕整张图根本没有色相。事后删词只能补救表面，
 * 而"这是彩图还是黑白灰"会决定后面所有观察该怎么写：
 * 单色图该写明度层次，彩图该写色相关系，双色调该写那两个色相怎么配。
 *
 * 所以判定放在管线最前面，结论既进提示词（模型必须先回答 color_mode），
 * 也进 IR provenance（编译层据此压色相、证据层据此删色相词）。
 */

export const COLOR_MODES = Object.freeze(['color', 'greyscale', 'duotone', 'spot_color'])

export const COLOR_MODE_LABELS = Object.freeze({
  color: '彩图',
  greyscale: '黑白灰图',
  duotone: '双色调图',
  spot_color: '灰底局部彩色',
})

function num(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** 双色调/单色偏色都靠主色色相说话，纯灰的主色 hue 没有意义。 */
function dominantHues(metrics) {
  const palette = Array.isArray(metrics?.palette) ? metrics.palette : []
  return palette
    .filter((entry) => entry && Number.isFinite(Number(entry.hue)) && num(entry.share, 0) >= 0.05)
    .map((entry) => ({ hue: Number(entry.hue), share: num(entry.share, 0) }))
}

function hexSaturation(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim())
  if (!match) return null
  const value = match[1]
  const r = parseInt(value.slice(0, 2), 16) / 255
  const g = parseInt(value.slice(2, 4), 16) / 255
  const b = parseInt(value.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max <= 0) return 0
  return (max - min) / max
}

/**
 * "灰底 + 一小块彩色"和"整体发灰的彩照"靠占比分不开：两者无彩像素都很多。
 * 真正的区别在那块彩色本身够不够艳 —— 局部彩色是饱和的，褪色彩照不是。
 */
function maxPaletteSaturation(metrics) {
  const palette = Array.isArray(metrics?.palette) ? metrics.palette : []
  let max = 0
  for (const entry of palette) {
    if (num(entry?.share, 0) < 0.03) continue
    const sat = hexSaturation(entry?.hex)
    if (sat !== null && sat > max) max = sat
  }
  return max
}

/**
 * 四分类。
 *
 * 阈值依据：`mono_ratio` 是饱和度 ≤ 20/255 的像素占比，`colorfulness` 是 Hasler–Süsstrunk 指标。
 * 两者必须一起看 —— 低饱和彩照 mono_ratio 高但 colorfulness 不低；
 * 深色为主的彩图 colorfulness 低但 mono_ratio 也不高。
 *
 * 拿不准时一律往"彩图"落：误判成单色会删掉全部色相观察（后果严重），
 * 误判成彩图最多是没压住色相（后果轻微）。所以单色的门槛定得很硬。
 */
export function classifyColorMode(metrics) {
  if (!metrics || typeof metrics !== 'object') {
    return {
      color_mode: null,
      confidence: 0,
      tint: 'neutral',
      evidence: {},
      reason: '像素指标不可用（缺少 PIL / numpy），色彩制式只能由模型自己判断。',
    }
  }
  const monoRatio = num(metrics.mono_ratio)
  const colorfulness = num(metrics.colorfulness)
  const satMean = num(metrics.sat_mean)
  const verdict = metrics.verdict && typeof metrics.verdict === 'object' ? metrics.verdict : {}
  const nearDuotone = verdict.near_duotone === true

  let colorMode = 'color'
  let confidence = 0.6
  let reason = ''

  if (monoRatio >= 0.98 || (monoRatio >= 0.9 && colorfulness < 9)) {
    colorMode = 'greyscale'
    confidence = monoRatio >= 0.995 ? 0.95 : 0.85
    reason = `无彩像素占 ${(monoRatio * 100).toFixed(1)}%、colorfulness ${colorfulness.toFixed(1)}：画面里没有可用的色相信息。`
  } else if (nearDuotone) {
    colorMode = 'duotone'
    confidence = 0.75
    reason = '两个主色占绝大多数、其余落在灰阶上：双色调。'
  } else if (monoRatio >= 0.85 && colorfulness >= 8 && maxPaletteSaturation(metrics) >= 0.35) {
    colorMode = 'spot_color'
    confidence = 0.7
    reason = `无彩像素占 ${(monoRatio * 100).toFixed(1)}%，但主色里有一块高饱和彩色：灰底 + 局部彩色。`
  } else {
    colorMode = 'color'
    confidence = monoRatio <= 0.3 ? 0.9 : 0.65
    reason = `无彩像素只占 ${(monoRatio * 100).toFixed(1)}%、colorfulness ${colorfulness.toFixed(1)}：彩图。`
  }

  const tint = classifyTint(metrics, colorMode)
  if (tint !== 'neutral') {
    reason += tint === 'warm' ? ' 有棕褐/暖色偏。' : ' 有冷色偏（青蓝）。'
  }

  return {
    color_mode: colorMode,
    confidence,
    tint,
    evidence: { mono_ratio: monoRatio, colorfulness, sat_mean: satMean, near_duotone: nearDuotone },
    reason,
  }
}

/**
 * 色偏只看"有彩的那一小部分"往哪个方向偏；纯灰不该被判成暖或冷。
 *
 * 单色图也不一定是中性灰：棕褐（sepia，暖）与蓝灰（cyanotype，冷）都是单色，
 * 写 black and white 会让成品偏掉，所以这里要单独把 warm / cool 分出来。
 */
function classifyTint(metrics, colorMode) {
  if (colorMode === 'color') return 'neutral'
  if (num(metrics?.sat_mean) < 0.03) return 'neutral'
  const hues = dominantHues(metrics)
  if (hues.length === 0) return 'neutral'
  const totalShare = hues.reduce((sum, entry) => sum + entry.share, 0) || 1
  const meanHue = hues.reduce((sum, entry) => sum + entry.hue * entry.share, 0) / totalShare
  const spread = Math.max(...hues.map((entry) => entry.hue)) - Math.min(...hues.map((entry) => entry.hue))
  // 色相散得太开说明是零散彩点，不是统一偏色，别硬贴色偏。
  if (spread > 90) return 'neutral'
  if (meanHue >= 10 && meanHue <= 65) return 'warm'
  if (meanHue >= 170 && meanHue <= 265) return 'cool'
  return 'neutral'
}

export function colorModeLabel(colorMode) {
  return COLOR_MODE_LABELS[colorMode] ?? '未判定'
}

/** 无彩制式：不允许出现任何色相词。证据层与编译层共用这一个判断。 */
export function isHueless(colorMode) {
  return colorMode === 'greyscale' || colorMode === 'duotone'
}

/** 喂给阶段 A 的"第 0 步"说明：判定结论 + 它约束了什么。 */
export function colorModePromptLines(preflight) {
  const mode = preflight?.color_mode ?? null
  if (!mode) {
    return [
      '## 第 0 步：色彩制式（先定这个，再谈其他）',
      '- 程序拿不到像素统计，你必须自己先判断这张图是彩图还是黑白灰图，并把它写进 color_mode。',
    ]
  }
  const lines = [
    '## 第 0 步：色彩制式（程序已判定，这是确定性结论，不要推翻）',
    `- color_mode = "${mode}"（${colorModeLabel(mode)}），置信度 ${Number(preflight.confidence ?? 0).toFixed(2)}。`,
    `- 依据：${preflight.reason ?? ''}`,
    `- 色偏：${preflight.tint ?? 'neutral'}（neutral=中性灰 / warm=棕褐暖调 / cool=青蓝冷调）。`,
  ]
  if (isHueless(mode)) {
    lines.push(
      '- **这是无彩图**：整张图只有明度，没有色相。所以 D5 只能写明度层次、对比关系、色偏（若 tint 非 neutral），**一个色相词都不许出现**（red / blue / blonde / pink / golden 之类全部禁止）；描述材质、光影、氛围时同样不许借颜色说话（写 "specular highlight" 而不是 "white highlight"，写 "deep shadow" 而不是 "black"）。',
      '- 主体身份也要按无彩写：头发只写明度与形状（pale hair / dark hair 这种仍可，但 pale blonde 不许），眼睛不写颜色。',
    )
  } else if (mode === 'duotone') {
    lines.push(
      '- **这是双色调图**：只允许出现那两个主色的色相（其余一律用明度描述），并说明两者的比例与分工（谁打底、谁做高光）。',
    )
  } else if (mode === 'spot_color') {
    lines.push(
      '- **这是灰底局部彩色图**：只有那一小块区域允许写色相，并必须指明"彩色出现在哪里"；画面其余部分一律按明度描述。',
    )
  } else {
    lines.push('- 这是彩图：颜色结论要有像素依据（写 "deep teal shadow" 而不是笼统的 "dark colors"）。')
  }
  lines.push(
    `- 输出 JSON 的第一个键必须是 "color_mode"，值写 "${mode}"；写别的值会被判为自相矛盾。`,
  )
  return lines
}
