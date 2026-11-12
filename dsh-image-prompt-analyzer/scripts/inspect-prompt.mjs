#!/usr/bin/env node

/**
 * 编译产物检查工具：把「这次改动动到默认输出了吗」和「一条观察去了哪里」
 * 变成一条命令。
 *
 * 为什么要单独有这个脚本：这两件事以前散在十几份一次性脚本里
 * （冻结基线算哈希的、打印台账的、按通道摊差额的、逐条解释去向的），
 * 每轮都重写一遍，参数和口径各写各的。合并成一个入口之后，
 * 「基线没变」与「这条观察在哪一步消失」用的是同一份代码、同一套口径。
 *
 * 它不生成图片，也不评价生成效果——本机没有生成后端。
 * 这里能回答的只有：成品文本变没变、某条观察进了哪个通道、没进的理由是什么。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compilePrompt } from '../lib/compile/index.js'
import { openKnowledgeDatabase } from '../lib/kb/db.js'
import { resolveDataPath, scriptDataDir } from '../lib/paths.js'
import { createKnowledgeBase } from '../lib/kb/index.js'
import { CHANNELS, DISPOSITIONS, explainFact } from '../lib/trace/ledger.js'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

const USAGE = [
  '用法：',
  '  node scripts/inspect-prompt.mjs baseline --ir PATH [选项]',
  '  node scripts/inspect-prompt.mjs ledger   --ir PATH [选项]',
  '  node scripts/inspect-prompt.mjs explain  --ir PATH [fact_id ...] [选项]',
  '  node scripts/inspect-prompt.mjs channels --ir PATH [选项]',
  '',
  '子命令：',
  '  baseline  编译一次，打印四份成品（标签版/默认描述/负向/候选描述）的哈希与长度。',
  '            这是「默认输出有没有被动过」的判据：只看这四个哈希，不看别的。',
  '  ledger    打印事实台账统计、逐条去向，以及 fidelity 的三通道审计。',
  '  explain   把指定观察的去向翻成人话；不给 fact_id 时列出所有非 retained 的。',
  '  channels  按通道摊开差额：描述版有而标签版没有的那些，各自卡在哪一步。',
  '',
  '选项：',
  '  --ir PATH           要编译的 IR（必填）。传证据层之后的 IR 才代表当前输出。',
  '  --ir-before PATH    证据层之前的 IR 快照。只影响台账里「证据层改写过吗」，',
  '                      不参与编译；不给就如实记成 unavailable，不假装完整。',
  '  --profile ID        模型档案，默认 illustrious。读 configs/model-profiles/<ID>.json。',
  '  --preset ID         细节密度预设，默认 detail-standard。读 configs/presets/<ID>.json。',
  '  --db PATH           知识库路径，默认取 configs/knowledge-base.default.json 里的配置。',
  '  --kb-config PATH    知识库配置，默认 configs/knowledge-base.default.json。',
  '  --no-kb             不挂知识库。用来对比「有词库」与「没词库」两版输出。',
  '  --expect HASH       只在 baseline 用：四份哈希与给定的 key=value 不符时以 1 退出。',
  '                      形如 --expect positive=8721b8d7c244b646,description=6489404ce180fe4c。',
  '  --json              输出机器可读 JSON，不打印人话报告。',
  '  --help              打印这段说明。',
].join('\n')

function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const eq = token.indexOf('=')
    if (eq > 0) {
      args[token.slice(2, eq).replace(/-/g, '_')] = token.slice(eq + 1)
      continue
    }
    const key = token.slice(2).replace(/-/g, '_')
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = next
      index += 1
    }
  }
  return args
}

function resolveFromPackage(value) {
  return isAbsolute(value) ? value : resolve(PACKAGE_DIR, value)
}

/**
 * 用户传进来的文件路径按当前工作目录解析，不按包目录。
 * 包目录只用来找自带配置——把 `--ir ir.json` 解析到包里会让人以为文件不存在。
 */
function resolveUserPath(value) {
  return isAbsolute(value) ? value : resolve(process.cwd(), value)
}

function log(message) {
  process.stdout.write(`${message}\n`)
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  return 2
}

/** 与各轮基线脚本一致的短哈希：sha256 前 16 位十六进制。 */
function shortHash(text) {
  return createHash('sha256').update(text ?? '', 'utf8').digest('hex').slice(0, 16)
}

function readJson(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} 不存在：${path}`)
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * 组装一次编译所需的全部输入。
 *
 * 知识库缺失时传 `kb: null` 而不是空壳对象：编译层会把「没有可查的词表」
 * 如实记成 kb_health.unavailable，而空壳对象会被读成「查了但都没命中」——
 * 那是两件完全不同的事。
 */
/**
 * 按档案名找文件：先按文件名直找，找不到再按 aliases 反查。
 * 旧名（animagine-xl-4.0 / AnimaImage）在档案的 aliases 里登记过，
 * 所以命令行里用旧名照样能跑——改名不该让旧的检查命令失效。
 */
function resolveProfileFile(profileId) {
  const direct = resolveFromPackage(`configs/model-profiles/${profileId}.json`)
  if (existsSync(direct)) return { path: direct, requested: profileId, config_id: null }
  const dir = resolveFromPackage('configs/model-profiles')
  const wanted = profileId.trim().toLowerCase().replace(/[-_.\s]+/g, '')
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).filter((item) => item.toLowerCase().endsWith('.json')).sort()) {
      const candidate = join(dir, name)
      let document
      try {
        document = JSON.parse(readFileSync(candidate, 'utf8'))
      } catch {
        continue
      }
      const aliases = Array.isArray(document?.aliases) ? document.aliases : []
      const hit = [document?.config_id, ...aliases].some(
        (item) => typeof item === 'string' && item.trim().toLowerCase().replace(/[-_.\s]+/g, '') === wanted,
      )
      if (hit) return { path: candidate, requested: profileId, config_id: document?.config_id ?? null }
    }
  }
  throw new Error(`找不到模型档案 ${profileId}：configs/model-profiles/ 下既没有同名文件，也没有哪份档案把它登记为别名。`)
}

async function prepare(args) {
  if (!args.ir || args.ir === true) {
    throw new Error('缺少 --ir PATH。要编译的 IR 是必填项。')
  }
  const ir = readJson(resolveUserPath(String(args.ir)), 'IR')
  const irBeforeEvidence =
    args.ir_before && args.ir_before !== true ? readJson(resolveUserPath(String(args.ir_before)), '证据层之前的 IR') : null

  const profileId = String(args.profile ?? 'illustrious')
  const presetId = String(args.preset ?? 'detail-standard')
  const profileFile = resolveProfileFile(profileId)
  const profile = readJson(profileFile.path, `模型档案 ${profileId}`)
  const preset = readJson(resolveFromPackage(`configs/presets/${presetId}.json`), `预设 ${presetId}`)

  let kb = null
  let kbStatus = 'not_used'
  if (!args.no_kb) {
    const kbConfigPath = resolveUserPath(String(args.kb_config ?? resolveFromPackage('configs/knowledge-base.default.json')))
    const kbConfig = readJson(kbConfigPath, '知识库配置')
    // 配置里的相对路径按用户数据目录解析（词库在那儿，跨升级保留），
    // 命令行给的 --db 按当前目录解析（那是用户在说"这个文件"）。
    const dbPath =
      args.db && args.db !== true
        ? resolveUserPath(String(args.db))
        : resolveDataPath(kbConfig.storage?.database_path ?? 'knowledge.sqlite3', scriptDataDir())
    if (!existsSync(dbPath)) {
      // 库文件不在就明确说不在。造一个空库会让每次查询都 miss，
      // 而 miss 与「根本没有库」在报告里必须能区分开。
      kbStatus = `missing:${dbPath}`
    } else {
      const handle = await openKnowledgeDatabase({ path: dbPath, readonly: true, createIfMissing: false })
      kb = createKnowledgeBase({ handle, config: kbConfig })
      kbStatus = `used:${dbPath}`
    }
  }

  const compiled = await compilePrompt({
    ir,
    irBeforeEvidence,
    profile,
    preset,
    kb,
    includeNegative: true,
  })
  return { ir, irBeforeEvidence, profile, preset, kb, kbStatus, compiled }
}

/** 四份成品。候选描述版可能不存在（旧版本产物），缺失时如实留空。 */
function promptRows(compiled) {
  return [
    ['positive', compiled?.prompts?.positive ?? ''],
    ['description', compiled?.prompts?.description ?? ''],
    ['negative', compiled?.prompts?.negative ?? ''],
    ['candidate', compiled?.description_candidate?.text ?? ''],
  ]
}

function runBaseline(ctx, args) {
  const rows = promptRows(ctx.compiled)
  const hashes = {}
  if (!args.json) {
    log(`IR：${args.ir}`)
    log(`档案：${ctx.profile.config_id ?? '?'} | 预设：${ctx.preset.config_id ?? '?'} | 知识库：${ctx.kbStatus}`)
    log('')
    for (const [key, text] of rows) {
      hashes[key] = shortHash(text)
      log(`${key.padEnd(12)} ${hashes[key]}  ${String(text.length).padStart(5)}ch`)
    }
    const ledger = ctx.compiled?.fact_ledger
    if (ledger?.stats) {
      log('')
      log(`台账：${ledger.records?.length ?? 0} 条，唯一身份 ${new Set((ledger.records ?? []).map((r) => r.fact_id)).size} 个`)
    }
  } else {
    for (const [key, text] of rows) hashes[key] = shortHash(text)
  }

  // --expect：把「基线没变」变成一个可自动判定的条件，而不是靠肉眼看四个哈希。
  let mismatch = []
  if (args.expect && args.expect !== true) {
    for (const pair of String(args.expect).split(',')) {
      const [key, want] = pair.split('=')
      if (!key || !want) continue
      const got = hashes[key.trim()]
      if (got !== want.trim()) mismatch.push(`${key.trim()}: 期望 ${want.trim()}，实际 ${got}`)
    }
    if (mismatch.length > 0) {
      for (const line of mismatch) process.stderr.write(`不一致 ${line}\n`)
      return 1
    }
    if (!args.json) log('\n四份哈希与 --expect 一致。')
  }

  if (args.json) log(JSON.stringify({ kb: ctx.kbStatus, hashes, rows: Object.fromEntries(rows) }, null, 2))
  return 0
}

const DISPOSITION_LABEL = {
  [DISPOSITIONS.RETAINED]: '保留',
  [DISPOSITIONS.REWRITTEN]: '改写',
  [DISPOSITIONS.DROPPED]: '丢弃',
  [DISPOSITIONS.UNKNOWN]: '未到达',
}

function flagsOf(record) {
  const inSet = new Set(record.channels ?? [])
  return [inSet.has(CHANNELS.TAGS) ? 'T' : '-', inSet.has(CHANNELS.DESCRIPTION) ? 'D' : '-', inSet.has(CHANNELS.CANDIDATE) ? 'C' : '-'].join('')
}

function runLedger(ctx, args) {
  const ledger = ctx.compiled?.fact_ledger
  if (!ledger) return fail('这次编译没有产出事实台账。')
  if (args.json) {
    log(JSON.stringify({ stats: ledger.stats, fidelity: ctx.compiled.fidelity }, null, 2))
    return 0
  }

  log('=== 台账统计 ===')
  log(JSON.stringify(ledger.stats, null, 2))
  log(`join_basis：${ledger.join_basis ?? '?'} | 证据层快照：${ledger.evidence_available ? '有' : '无（如实记 unavailable）'}`)

  const records = ledger.records ?? []
  log('')
  log('=== 逐条去向（T=标签版 D=默认描述版 C=候选描述版）===')
  for (const record of records) {
    const label = DISPOSITION_LABEL[record.disposition] ?? record.disposition
    const where = record.disposition === DISPOSITIONS.RETAINED ? '' : ` @${record.dropped_at ?? record.rewritten_at ?? '?'}`
    log(`  ${flagsOf(record)} [${label}${where}] ${record.fact_id}  "${String(record.text ?? '').slice(0, 52)}"`)
  }

  const fidelity = ctx.compiled?.fidelity
  if (!fidelity) return 0
  log('')
  log('=== fidelity（词面保留指标）===')
  log(`status：${fidelity.status} | score：${fidelity.score ?? 'null'} | 口径：${fidelity.score_scope ?? '?'}`)
  log(`判据：score=${fidelity.lost_basis ?? '?'} | channels=${fidelity.channel_basis ?? '?'}（两套数不可互相换算）`)
  // 通道按这次编译实际产出的那些打印，不按写死的三通道列表：
  // Caption 档只有一个成品，硬列三个会让它看起来"缺了两路"。
  for (const channel of Object.values(fidelity.channels ?? {})) {
    const key = channel.channel ?? '?'
    const score = channel.score === null || channel.score === undefined ? 'null' : channel.score
    log(`  ${key.padEnd(12)} ${channel.kept}/${channel.checked} = ${score}  [${channel.status}] 判据 ${channel.basis}${channel.unmatched > 0 ? ` 未对上 ${channel.unmatched}` : ''}`)
  }
  if (fidelity.reconciliation) {
    const r = fidelity.reconciliation
    log(`  对账：台账重要 ${r.ledger_important} = 受审计 ${r.audited} + 排除 ${r.excluded_from_audit}`)
    if (Array.isArray(r.excluded_from_audit_detail ?? r.excluded)) {
      for (const item of r.excluded_from_audit_detail ?? []) log(`    排除 ${item.fact_id ?? item.key ?? '?'}：${item.reason ?? '?'}`)
    }
  }
  if (fidelity.retention_claim) {
    log(`保留声明：${fidelity.retention_claim.allowed ? '允许' : '不允许'}——${fidelity.retention_claim.reason}`)
  }
  return 0
}

function runExplain(ctx, args) {
  const ledger = ctx.compiled?.fact_ledger
  if (!ledger) return fail('这次编译没有产出事实台账。')
  const records = ledger.records ?? []
  const wanted = args._.slice(1).filter((item) => !String(item).startsWith('--'))

  if (wanted.length > 0) {
    let missing = 0
    for (const key of wanted) {
      const hit = records.filter((record) => record.fact_id === key || String(record.fact_id).includes(key))
      if (hit.length === 0) {
        log(`${key}：台账里没有这条观察。`)
        missing += 1
        continue
      }
      for (const record of hit) log(explainFact(record))
    }
    return missing === wanted.length ? 1 : 0
  }

  // 不给 fact_id 时列出所有"没走到终点"的：这三类是每轮真正要看的东西。
  const groups = [
    [DISPOSITIONS.DROPPED, '被丢弃的'],
    [DISPOSITIONS.REWRITTEN, '被改写的'],
    [DISPOSITIONS.UNKNOWN, '未到达的'],
  ]
  let any = false
  for (const [disposition, title] of groups) {
    const list = records.filter((record) => record.disposition === disposition)
    if (list.length === 0) continue
    any = true
    log(`=== ${title}（${list.length} 条）===`)
    for (const record of list) log(explainFact(record))
    log('')
  }

  const partial = records.filter((record) => Array.isArray(record.dropped_phrases) && record.dropped_phrases.length > 0)
  if (partial.length > 0) {
    any = true
    log(`=== 观察仍在、但有分句没写进去（${partial.length} 条）===`)
    for (const record of partial) log(explainFact(record))
    log('')
  }

  if (!any) log('台账里没有任何丢弃、改写或分句损失：每条观察都有去处。')
  return 0
}

function runChannels(ctx) {
  const ledger = ctx.compiled?.fact_ledger
  if (!ledger) return fail('这次编译没有产出事实台账。')
  const records = ledger.records ?? []
  const inSet = (record, channel) => Array.isArray(record.channels) && record.channels.includes(channel)

  log(`=== 总览 === 台账 ${records.length} 条`)
  const fidelity = ctx.compiled?.fidelity
  const measuredChannels = new Set(Object.keys(fidelity?.channels ?? {}))
  if (fidelity?.channels) {
    for (const channel of Object.values(fidelity.channels)) {
      log(`  ${String(channel.channel ?? '?').padEnd(12)} ${channel.kept}/${channel.checked}  [${channel.status}] 判据 ${channel.basis}`)
    }
  }

  // 差额必须按「为什么」分组，而不是只报条数：
  // 同样少 11 条，"按规则挡的"和"意外丢的"要修的地方完全不同。
  //
  // 只算这次编译真的产出过的通道：Caption 档只有一个成品，拿它去跟不存在的
  // 标签版比差额，只会报出三个"0 条"的假结论。
  const gaps = [
    { title: '描述版有、标签版没有', have: CHANNELS.DESCRIPTION, lack: CHANNELS.TAGS },
    { title: '标签版有、候选描述版没有', have: CHANNELS.TAGS, lack: CHANNELS.CANDIDATE },
    { title: '描述版有、候选描述版没有', have: CHANNELS.DESCRIPTION, lack: CHANNELS.CANDIDATE },
  ].filter((gap) => measuredChannels.has(gap.have) && measuredChannels.has(gap.lack))
  if (gaps.length === 0 && measuredChannels.size > 0) {
    log('')
    log(`=== 通道差额 === 这个档案只有一个成品（${[...measuredChannels].join('、')}），没有可比的第二路。`)
  }
  for (const gap of gaps) {
    const list = records.filter((record) => inSet(record, gap.have) && !inSet(record, gap.lack))
    log('')
    log(`=== ${gap.title}：${list.length} 条 ===`)
    if (list.length === 0) {
      log('  （无）')
      continue
    }
    const byReason = new Map()
    for (const record of list) {
      const note = record.channel_notes?.[gap.lack]
      const reason =
        record.disposition === DISPOSITIONS.DROPPED
          ? `丢弃@${record.dropped_at}（${record.dropped_reason}）`
          : record.disposition === DISPOSITIONS.REWRITTEN
            ? `改写@${record.rewritten_at}`
            : record.disposition === DISPOSITIONS.UNKNOWN
              ? '未到达'
              : (note ?? '保留但没进这个通道')
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
    }
    for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1])) {
      log(`  ${String(count).padStart(3)}  ${reason}`)
    }
    for (const record of list.slice(0, 40)) {
      const note = record.channel_notes?.[gap.lack]
      log(`    [${record.fact_id}] "${String(record.text ?? '').slice(0, 48)}" imp=${record.importance ?? '?'}${note ? ` ← ${note}` : ''}`)
    }
    if (list.length > 40) log(`    …另有 ${list.length - 40} 条未列出`)
  }
  return 0
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    log(USAGE)
    return 0
  }
  const command = args._[0]
  if (!command) return fail(`缺少子命令。\n\n${USAGE}`)

  const handlers = { baseline: runBaseline, ledger: runLedger, explain: runExplain, channels: runChannels }
  const handler = handlers[command]
  if (!handler) return fail(`不认识的子命令：${command}\n\n${USAGE}`)

  let ctx
  try {
    ctx = await prepare(args)
  } catch (error) {
    return fail(String(error?.message ?? error))
  }
  return handler(ctx, args)
}

process.exitCode = await main()
