// ============================================================================
// verify-mirror —— 用**真实数据**验证"镜像计价"算得对不对
// ============================================================================
// 为什么需要它:
//   「工作中持续跳」的数字不再重复上一轮,而是宿主按**挂件自己的公式**逐条
//   assistant/message 累加出来的(见 lib/index.js 的 DMG_PRICING 段)。那份价目表
//   和峰谷规则是**照抄**挂件源码的常量 —— 官方一调价、或挂件改了规则,抄来的就会变旧。
//   单元测试只能证明"我实现的和我以为的一致",证明不了"和挂件算的钱一致"。
//
// 它是怎么验的(两边都是真实数据,没有自造样本):
//   ① 会话日志 $DSH_HOME/sessions/**/session.v4.jsonl.zstd —— 每条 assistant/message 都带
//      usage(inputTokens / cacheReadTokens / outputTokens)与 time;
//   ② 挂件账本 $DSH_HOME/.dshw-usage.json —— 挂件自己算出来的**每轮真实金额与 token**。
//   把①按轮聚合、用 lib/index.js 里**真实的**镜像函数算一遍,再与②逐轮对比。
//   匹配靠 token 总数(两边口径相同:input + cacheRead + output,都不含 cacheWrite)。
//
// 用法:
//   node tools/verify-mirror.mjs                        # 自动找最新的会话日志
//   node tools/verify-mirror.mjs --session <日志路径>
//   node tools/verify-mirror.mjs --ledger <账本路径>
//   node tools/verify-mirror.mjs --all                  # 把所有会话日志都算上(匹配率更高)
//
// 退出码:0 = 全部匹配且偏差在容忍内;1 = 有匹配的轮次偏差超阈值(该更新价目表了);
//         2 = 一份都没匹配上(通常是日志被滚动过 / 账本是别的会话的)。
//
// 关于"匹配不上的账本记录":账本是**全局**的(跨会话、跨工作区),而每份会话日志只覆盖
// 自己那个会话,所以对不上是正常的 —— 用 --all 会好很多。
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB = path.resolve(HERE, '..', 'lib', 'index.js')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const TOLERANCE = 0.005   // 0.5%:超过就认为镜像该更新了

// ---------------- 参数 ----------------
const argv = process.argv.slice(2)
function argOf(name) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null
}
const ALL = argv.indexOf('--all') >= 0
const LEDGER = argOf('--ledger') || path.join(DSH_HOME, '.dshw-usage.json')

// ---------------- ① 从 lib/index.js 里取出**真实的**镜像函数 ----------------
// 刻意不复制一份实现到这里:那样工具本身就会和实现漂移,验证就失去意义了。
// 取源码切片再用 data: URL 导入,拿到的是当前这份代码里的常量与函数本体。
async function loadMirror() {
  const src = fs.readFileSync(LIB, 'utf8')
  const start = src.indexOf('const DMG_PEAK_HOURS')
  const end = src.indexOf('function readPackageVersion')
  if (start < 0 || end <= start) {
    throw new Error('在 ' + LIB + ' 里找不到 DMG_PEAK_HOURS / readPackageVersion 这两处锚点 —— '
      + '如果重构过镜像计价那段,请同步更新本工具')
  }
  const code = src.slice(start, end)
    + "\nexport { dmgIsPeakTime, dmgPriceFor, dmgCostOfMessage, dmgUsageTokens, DMG_PRICING, dmgPeakProbe }"
  const url = 'data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64')
  return import(url)
}

// ---------------- ② 读多帧 zstd 的会话日志 ----------------
// DSH 的会话日志是**一串拼接的 zstd 帧**(每次 append 一帧),不是单个帧。
// Node 的 zstdDecompressSync 只吃一帧,流式接口也在第一帧后就停 —— 所以按魔数切开逐帧解。
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function readSessionLines(file) {
  const buf = fs.readFileSync(file)
  const out = []
  let pos = 0
  let frames = 0
  while (pos < buf.length && frames < 200000) {
    let end = buf.indexOf(ZSTD_MAGIC, pos + 4)
    let plain = null
    // 贪心回退:魔数可能碰巧出现在帧内,那样切出来的片段解不开,就把切点往后挪
    for (;;) {
      try {
        plain = zlib.zstdDecompressSync(end < 0 ? buf.subarray(pos) : buf.subarray(pos, end))
        break
      } catch (err) { plain = null }
      if (end < 0) break
      end = buf.indexOf(ZSTD_MAGIC, end + 4)
    }
    if (!plain) break
    const text = plain.toString('utf8')
    for (const line of text.split('\n')) if (line.trim()) out.push(line)
    frames++
    pos = end < 0 ? buf.length : end
  }
  return out
}

function findSessionLogs() {
  const root = path.join(DSH_HOME, 'sessions')
  const found = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let items = []
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch (err) { return }
    for (const it of items) {
      const p = path.join(dir, it.name)
      if (it.isDirectory()) walk(p, depth + 1)
      else if (it.name.indexOf('.jsonl') >= 0) {
        try { found.push({ p, mtime: fs.statSync(p).mtimeMs }) } catch (err) {}
      }
    }
  }
  walk(root, 0)
  found.sort((a, b) => b.mtime - a.mtime)
  return found.map((x) => x.p)
}

// ---------------- 主流程 ----------------
async function main() {
  const mirror = await loadMirror()
  const { dmgCostOfMessage, dmgUsageTokens, dmgIsPeakTime, dmgPeakProbe } = mirror

  console.log('镜像来源 : ' + LIB)
  console.log('账本     : ' + LEDGER)

  // 先自检峰谷规则(探针自带期望值),规则错了后面全都不用看了。
  // 注意要用 dmgPeakProbe()(它才算 peak)而不是 DMG_PEAK_PROBE(那是原始定义,只有 expect)。
  const probe = dmgPeakProbe()
  const probeBad = probe.filter((x) => x.peak !== x.expect)
  console.log('峰谷探针 : ' + (probeBad.length === 0
    ? (probe.length + ' 条全部符合期望')
    : ('有 ' + probeBad.length + ' 条不符 ← 规则该更新了:' + probeBad.map((x) => x.label).join(' / '))))
  console.log('当前峰谷 : ' + (dmgIsPeakTime(Math.floor(Date.now() / 1000)) ? '高峰' : '空闲'))
  console.log('')

  if (!fs.existsSync(LEDGER)) {
    console.log('读不到账本:' + LEDGER + '(挂件没装或还没产生记录)')
    process.exit(2)
  }
  const ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8'))
  const events = (ledger.events || []).filter((e) => Number(e.cost) > 0 && Number(e.tokens) > 0)

  const logs = ALL ? findSessionLogs() : [argOf('--session') || findSessionLogs()[0]].filter(Boolean)
  if (!logs.length) {
    console.log('找不到会话日志(' + path.join(DSH_HOME, 'sessions') + ')')
    process.exit(2)
  }

  // 按**轮**聚合 —— 必须与账本口径一致:账本每条记录是一轮(某模型)的合计,
  // 而日志里同一轮有很多条 assistant/message。所以键是"日志文件 + 轮次"。
  const turns = new Map()
  for (const file of logs) {
    let lines = []
    try { lines = readSessionLines(file) } catch (err) {
      console.log('跳过 ' + path.basename(path.dirname(file)) + ': ' + err.message)
      continue
    }
    for (const line of lines) {
      let o = null
      try { o = JSON.parse(line) } catch (err) { continue }
      if (o.type !== 'assistant/message' || !o.data || !o.data.usage) continue
      const usage = o.data.usage
      const model = (o.data.message && o.data.message.source && o.data.message.source.model) || ''
      const at = Number(o.time) || Date.now()
      const key = file + '#' + String(o.data.turn)
      let g = turns.get(key)
      if (!g) { g = { file, turn: o.data.turn, tokens: 0, cost: 0, models: new Set(), lastAt: 0 }; turns.set(key, g) }
      g.tokens += dmgUsageTokens(usage)
      g.cost += dmgCostOfMessage(model, usage, at)
      if (model) g.models.add(model)
      g.lastAt = Math.max(g.lastAt, at)
    }
  }
  const groups = [...turns.values()]

  console.log('会话日志 : ' + logs.length + ' 份,聚合出 ' + groups.length + ' 轮')
  console.log('账本记录 : ' + events.length + ' 条')
  console.log('')
  console.log('  轮次(时间 #轮号)        我的 token     我的金额        账本 token      账本金额        偏差')
  console.log('  ' + '-'.repeat(96))

  let matched = 0
  let worst = 0
  let worstRow = ''
  let over = 0
  for (const e of events) {
    // 匹配键 = token 总数(两边口径相同:input + cacheRead + output,都不含 cacheWrite)
    const mine = groups.find((g) => g.tokens === Number(e.tokens))
    if (!mine) continue
    matched++
    const rel = Math.abs(mine.cost - Number(e.cost)) / Number(e.cost)
    if (rel > worst) { worst = rel; worstRow = 'token=' + e.tokens }
    if (rel > TOLERANCE) over++
    const when = new Date(mine.lastAt || Number(e.ts) || 0).toISOString().slice(0, 16).replace('T', ' ')
    console.log('  ' + (when + '  #' + mine.turn).padEnd(24)
      + String(mine.tokens).padEnd(15) + mine.cost.toFixed(8).padEnd(16)
      + String(e.tokens).padEnd(16) + Number(e.cost).toFixed(8).padEnd(16)
      + (rel * 100).toFixed(4) + '%')
  }

  console.log('')
  if (!matched) {
    console.log('一份都没匹配上。账本是全局的(跨会话/跨工作区),单看某一份日志常常对不上 ——')
    console.log('加 --all 把所有会话日志都算上会好很多。也可能日志已被滚动。')
    process.exit(2)
  }
  console.log('匹配 ' + matched + ' 轮;最大偏差 ' + (worst * 100).toFixed(4) + '%'
    + (worstRow ? '(' + worstRow + ')' : ''))
  if (probeBad > 0) {
    console.log('⚠ 峰谷探针有 ' + probeBad + ' 条不符 —— 镜像的峰谷规则该更新了。')
    process.exit(1)
  }
  if (over > 0) {
    console.log('⚠ 有 ' + over + ' 轮偏差超过 ' + (TOLERANCE * 100) + '% —— '
      + '多半是官方调价了,请更新 lib/index.js 的 DMG_PRICING(以及 dsh-whale-widget 自己那份)。')
    process.exit(1)
  }
  console.log('✓ 镜像计价与挂件账本逐轮一致 —— 持续模式跳的数字就是挂件口径的真实花费。')
}

main().catch((err) => {
  console.error('verify-mirror 自身异常: ' + (err && err.stack ? err.stack : err))
  process.exit(3)
})
