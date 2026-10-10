// ============================================================================
// dsh-damage-number —— 宿主半区
// ============================================================================
// 职责(刻意做小):
//   ① 把浏览器半区 assets/{overlay,panel}.js 注册成只读路由;
//   ② 通过 webserver/index-inject 的结构化行 + tapIndex 两条通道把脚本注入页面
//      (桌面端 Electron 只认前者,普通 dsh web 两者皆可);
//   ③ 读写配置 $DSH_HOME/.dshdmg.json(GET 只读、PUT 仅限本机回环);
//   ④ **订阅 session/event,在 turn/end 的同一刻用 SSE 叫醒前端**。
//
// 为什么要有 ④:每轮金额的唯一真相仍在小鲸鱼挂件(它算峰谷价与缓存命中折算),
// 挂件在收到 turn/end 时是**立即**结算并刷新 /dsh-whale/last-turn.json 的;
// 真正拖慢手感的是浏览器侧"每 1 秒问一次"。这里改成:宿主在 turn/end 的同一个事件里
// 主动推一条 SSE,前端收到就立刻取数 —— 延迟从「最多 1000ms」变成「一次本机往返 ≈ 几毫秒」。
// 金额口径没有任何复制,挂件没装时这里推的信号也只是让前端白问一次(前端会安静忽略)。
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')
const ASSETS_DIR = path.join(PACKAGE_ROOT, 'assets')
const PACKAGE_FILE = path.join(PACKAGE_ROOT, 'package.json')

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = path.join(DSH_HOME, '.dshdmg.json')

const ROUTE_PREFIX = '/dsh-dmg'
const OVERLAY_SRC = ROUTE_PREFIX + '/overlay.js'
const PANEL_SRC = ROUTE_PREFIX + '/panel.js'
const CONFIG_ROUTE = ROUTE_PREFIX + '/config.json'
const STATUS_ROUTE = ROUTE_PREFIX + '/status.json'
const EVENTS_ROUTE = ROUTE_PREFIX + '/events'
const ACTIVITY_ROUTE = ROUTE_PREFIX + '/activity.json'

const INJECT_SRCS = [OVERLAY_SRC, PANEL_SRC]

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

// SSE 心跳间隔:只为穿过可能存在的反向代理,并让前端能感知"通道还活着"
const SSE_PING_MS = 20000

// 与前端 assets/overlay.js 的 DEFAULT_CFG **必须逐字段一致**:
// 宿主是"全新安装的默认值",前端是"取不到 config.json 时的兜底"。
// (tools/selftest.mjs 第 17 节会自动逐字段比对这两份,漂移会直接测试失败)
const DEFAULT_CONFIG = {
  enabled: true,
  // —— 跳动模式 ——
  //   'turnEnd' : 只在每轮结束时按区间概率跳一次(原行为)
  //   'working' : 对话进行期间每 tickSec 秒跳一次,数字 = **本轮到目前为止的真实花费**
  //               (镜像计价,见下方 DMG_PRICING);每轮结束那一次仍按区间概率判定
  mode: 'turnEnd',
  tickSec: 5,
  // 持续模式每次跳的数字口径:
  //   'turnTotal'     —— 本轮累计花费(数字递增,像血量一直在掉)
  //   'intervalDelta' —— 距上次跳动这段时间新增的花费(像持续掉血的小数字)
  tickAmount: 'turnTotal',
  // —— 伤害区间(人民币元)——
  // 低于 minAmount:不跳;区间内:概率从 minProbability 线性升到 1;达到 maxAmount:必定跳。
  minAmount: 0.01,
  maxAmount: 0.1,
  minProbability: 0.25,
  // —— 触发通道 ——
  // pushEnabled:用宿主 SSE 即时叫醒(关掉则退回纯轮询)
  // mainSessionOnly:只对**主会话**的轮次即时触发/计入"工作中"(子代理不当"一轮对话")
  // pollMs:兜底轮询间隔(SSE 断开或不可用时才是主要通道)
  pushEnabled: true,
  mainSessionOnly: false,
  pollMs: 2000,
  // —— 外观 ——
  prefix: '-¥',
  decimals: 2,
  color: '#ff3b30',
  strokeColor: '#ffffff',
  strokeWidth: 3,
  fontSizePx: 30,
  // —— 动效 ——
  // riseMs 是**总时长**:弹出后有一段近乎静止的停留(见 overlay.js 的关键帧),
  // 所以它同时决定了"看起来飘多快"和"能看清多久"。
  risePx: 96,
  riseMs: 1800,
  // —— 落点(相对鲸鱼精灵图宽/高的比例,0.5/0.12 ≈ 头顶)——
  headOffsetX: 0.5,
  headOffsetY: 0.12,
  jitterX: 0.18,
  maxStack: 6,
}

// ============================================================================
// 「本轮进行中的金额」——镜像 dsh-whale-widget 自己的算法
// ============================================================================
// 背景:挂件**没有**暴露"进行中的金额"(它的 turnAggs 只在内存里,turn/end 才结算落盘),
// 所以持续模式一开始只能重复"上一轮的真实金额" —— 那看起来很假(整轮都在跳同一个数)。
// 但其实没必要估算:挂件算钱用到的三样东西,我们都能拿到 ——
//   ① 每条 assistant/message 的 usage(inputTokens / cacheReadTokens / outputTokens)
//      —— 与挂件监听的是**同一个**事件流;
//   ② 价目表与峰谷规则 —— 它们是挂件源码里的**常量**(lib/index.js,不是 assets):
//        PEAK_HOURS / BASE_PRICE / PRO_PRICE / PRICING / HOLIDAY_VALLEY /
//        WEEKEND_VALLEY_FROM_SEC / HOLIDAY_VALLEY_FROM_SEC / isPeakTime()
//   ③ 计费公式(lib/index.js:897-899,逐字照抄):
//        const off = isPeakTime(now) ? 1 : 0            // 价目数组是 [空闲价, 高峰价]
//        cost = (cache/1e6)*p.hit[off] + (input/1e6)*p.miss[off] + (output/1e6)*p.out[off]
//
// ⚠️ 这是**镜像**不是引用:挂件改价目/改规则,这里必须跟着改。
//    为了不让它**静默**不一致,前端每轮结束都会把"我算的本轮累计"和挂件给的真实金额比一次,
//    偏差超阈值就打警告(assets/overlay.js 的 checkLiveDrift)。
//    自定义 API 模型的单价存在挂件内存里、读不到,这类模型会退回内置 _default —— 正是自检要覆盖的情形。
const DMG_PEAK_HOURS = [[9, 12], [14, 18]]
const DMG_PRICE_FLASH = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }
const DMG_PRICE_PRO = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }
const DMG_PRICING = {
  'deepseek-flash': DMG_PRICE_FLASH,
  'deepseek-v4-flash-vision-exp': DMG_PRICE_FLASH,
  'deepseek-v4-flash': DMG_PRICE_FLASH,
  'deepseek-v4-pro': DMG_PRICE_PRO,
  _default: DMG_PRICE_FLASH,
}
// 2026 年**放假**日期(调休上班日全落在周末,本来就按谷价,无需单列)。
// ⚠️ 每年 11 月国务院发布次年安排后要在这里补下一年 —— 与挂件的 HOLIDAY_VALLEY 同步。
//    漏了只影响节假日当天的"进行中金额"(会按高峰估价);每轮结束那个数永远是挂件给的真值。
const DMG_HOLIDAY_VALLEY = {
  '2026-01-01': 1, '2026-01-02': 1, '2026-01-03': 1,
  '2026-02-15': 1, '2026-02-16': 1, '2026-02-17': 1, '2026-02-18': 1, '2026-02-19': 1,
  '2026-02-20': 1, '2026-02-21': 1, '2026-02-22': 1, '2026-02-23': 1,
  '2026-04-04': 1, '2026-04-05': 1, '2026-04-06': 1,
  '2026-05-01': 1, '2026-05-02': 1, '2026-05-03': 1, '2026-05-04': 1, '2026-05-05': 1,
  '2026-06-19': 1, '2026-06-20': 1, '2026-06-21': 1,
  '2026-09-25': 1, '2026-09-26': 1, '2026-09-27': 1,
  '2026-10-01': 1, '2026-10-02': 1, '2026-10-03': 1, '2026-10-04': 1,
  '2026-10-05': 1, '2026-10-06': 1, '2026-10-07': 1,
}
const DMG_WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000)  // 北京 2026-08-23 00:00
const DMG_HOLIDAY_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 8, 18, 16, 0, 0) / 1000) // 北京 2026-09-19 00:00

function dmgIsPeakTime(timeSec) {
  const n = Number(timeSec)
  if (!isFinite(n)) return false
  const bj = new Date(n * 1000 + 8 * 3600 * 1000)   // 平移到"北京日历"再用 UTC 读
  if (n >= DMG_WEEKEND_VALLEY_FROM_SEC) {
    const dow = bj.getUTCDay()
    if (dow === 0 || dow === 6) return false
  }
  if (n >= DMG_HOLIDAY_VALLEY_FROM_SEC) {
    try { if (DMG_HOLIDAY_VALLEY[bj.toISOString().slice(0, 10)]) return false } catch (err) {}
  }
  const hour = bj.getUTCHours()
  for (const [start, end] of DMG_PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}

// 与挂件的 priceFor() 同序:先按模型名子串匹配(跳过 _default),全不中则用 _default
function dmgPriceFor(model) {
  const m = String(model || '').toLowerCase()
  for (const key of Object.keys(DMG_PRICING)) {
    if (key === '_default') continue
    if (m.indexOf(key) !== -1) return DMG_PRICING[key]
  }
  return DMG_PRICING._default
}

function dmgRoundMoney(v) {
  const n = Number(v)
  if (!isFinite(n)) return 0
  return Math.round(n * 1e8) / 1e8
}

// 峰谷规则的自检探针:固定几个时刻,把"我这边的判断"摆到 status.json 里。
// 评审/排查时一眼就能看出镜像有没有变旧(测试台也据此断言规则正确)。
// 期望值:工作日 9-12 / 14-18 北京 = 高峰;其余(含周末与法定节假日)= 谷。
const DMG_PEAK_PROBE = [
  { label: '工作日 10:00(北京)', at: Date.UTC(2026, 9, 9, 2, 0, 0), expect: true },
  { label: '工作日 13:00(北京)', at: Date.UTC(2026, 9, 9, 5, 0, 0), expect: false },
  { label: '工作日 15:00(北京)', at: Date.UTC(2026, 9, 9, 7, 0, 0), expect: true },
  { label: '工作日 20:00(北京)', at: Date.UTC(2026, 9, 9, 12, 0, 0), expect: false },
  { label: '周六 10:00(北京)', at: Date.UTC(2026, 9, 10, 2, 0, 0), expect: false },
  { label: '国庆 10/02 10:00', at: Date.UTC(2026, 9, 2, 2, 0, 0), expect: false },
  { label: '周末谷价生效前的周五 10:00', at: Date.UTC(2026, 7, 21, 2, 0, 0), expect: true },
]
function dmgPeakProbe() {
  return DMG_PEAK_PROBE.map((x) => {
    const at = Math.floor(x.at / 1000)
    return { label: x.label, at: at, peak: dmgIsPeakTime(at), expect: x.expect }
  })
}

// 单条 assistant/message 的花费(与挂件 lib/index.js:899 同式)
function dmgCostOfMessage(model, usage, atMs) {
  if (!usage || typeof usage !== 'object') return 0
  const p = dmgPriceFor(model)
  const off = dmgIsPeakTime(Math.floor(Number(atMs) / 1000)) ? 1 : 0
  const input = Number(usage.inputTokens) || 0
  const cache = Number(usage.cacheReadTokens) || 0
  const output = Number(usage.outputTokens) || 0   // DSH 的 outputTokens 已含 reasoningTokens,不再单加
  return (cache / 1e6) * p.hit[off] + (input / 1e6) * p.miss[off] + (output / 1e6) * p.out[off]
}

function dmgUsageTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0
  return (Number(usage.inputTokens) || 0)
    + (Number(usage.cacheReadTokens) || 0)
    + (Number(usage.outputTokens) || 0)
}

function readPackageVersion() {
  try {
    const j = JSON.parse(fs.readFileSync(PACKAGE_FILE, 'utf8'))
    return (j && j.version) || '0.0.0'
  } catch (err) {
    return '0.0.0'
  }
}

// 只保留已知键,避免用户手改配置文件时塞进任意字段
function sanitize(patch) {
  const out = {}
  if (!patch || typeof patch !== 'object') return out
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) out[k] = patch[k]
  }
  return out
}

function readConfig() {
  let saved = {}
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    if (j && typeof j === 'object') saved = sanitize(j)
  } catch (err) {}
  return Object.assign({}, DEFAULT_CONFIG, saved)
}

function writeConfig(patch) {
  const next = Object.assign(readConfig(), sanitize(patch))
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
    const tmp = CONFIG_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fs.renameSync(tmp, CONFIG_FILE) // 原子替换,避免半截文件
  } catch (err) {
    throw new Error('写入配置失败: ' + String((err && err.message) || err))
  }
  return next
}

// 前端脚本按 mtime 热读取:改 assets/*.js 后硬刷新页面即生效,不用重启宿主
const assetCache = new Map() // filePath -> { mtimeMs, text }
function loadAssetText(fileName) {
  const filePath = path.join(ASSETS_DIR, fileName)
  const st = fs.statSync(filePath)
  const hit = assetCache.get(filePath)
  if (!hit || hit.mtimeMs !== st.mtimeMs) {
    assetCache.set(filePath, { mtimeMs: st.mtimeMs, text: fs.readFileSync(filePath, 'utf8') })
  }
  return assetCache.get(filePath).text
}

// 桌面端(Electron)唯一能生效的注入通道:结构化 script 行的 **内联** 形式。
// 为什么不直接推 script-src 行:页面侧解释器对 script-src 是"加载失败即 reject 整个 boot",
// 而我们自己的 <script src> 带 onerror 兜底,路由不在时也不会拖垮页面启动。
// 旗标**由这一行自己同步置位**(而不是指望被异步加载的脚本),否则同一份行被求值两次会注入两套脚本。
const INLINE_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;'
  + 'if(window.__dshDmgInjected)return;window.__dshDmgInjected=1;'
  + 'var a=' + JSON.stringify(INJECT_SRCS) + ';'
  + 'for(var i=0;i<a.length;i++){var s=document.createElement("script");s.src=a[i];s.onerror=function(){};d.appendChild(s)}'
  + '}catch(e){}})()'

function readJsonBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limitBytes) {
        reject(new Error('body too large'))
        try { req.destroy() } catch (err) {}
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) return resolve({})
      try {
        const j = JSON.parse(raw)
        resolve(j && typeof j === 'object' ? j : {})
      } catch (err) {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

export default {
  name: 'damage-number',

  // apply() 立即执行、**第一件事就是注册注入行**:桌面端的注入表可能是在宿主启动/首次渲染时
  // 一次性收集的,订阅一旦晚于那次收集,这一行就永远进不了表(小鲸鱼挂件 issue #152/#153 的竞态)。
  // 注入行不依赖任何服务,所以它可以、也应该跑在任何 inject 之前。
  apply(root) {
    const version = readPackageVersion()
    const rowDisposers = []
    root.effect(() => () => {
      for (const d of rowDisposers) { try { d() } catch (err) {} }
    })

    // —— SSE 客户端表与广播(在 apply 作用域,好让 session 监听器直接用)——
    const sseClients = new Set()
    let ssePingTimer = null
    let lastTurnEnd = null // 最近一次 turn/end 的元信息,供 status.json 自查
    // 正在进行的轮次:sessionId -> { since, isSubagent, turn }
    // 「工作中持续跳动」靠它判断"现在有没有在干活"。turn/end 与 session/disposed 都会清掉,
    // 所以不会因为某个会话没走到 turn/end 就永远停在"工作中"。
    const activeTurns = new Map()

    // 本轮**进行中**的累计(镜像计价,见文件上方 DMG_PRICING 那段说明)。
    // sessionId -> { turn, tokens, cost, byModel, since, lastTs, isSubagent }
    const liveTurns = new Map()

    function bumpLive(sessionId, event, isSubagent) {
      const d = (event && event.data) || {}
      const usage = d.usage
      if (!usage || typeof usage !== 'object') return
      const turn = Number(d.turn)
      if (!isFinite(turn)) return
      let agg = liveTurns.get(sessionId)
      if (!agg || agg.turn !== turn) {
        // 新的一轮:重新起算(旧值不必留,结算数永远以挂件给的为准)
        agg = { turn, tokens: 0, cost: 0, byModel: {}, since: Date.now(), lastTs: null, isSubagent: !!isSubagent }
        liveTurns.set(sessionId, agg)
      }
      const model = (d.message && d.message.source && d.message.source.model) || ''
      const cost = dmgCostOfMessage(model, usage, Date.now())
      agg.tokens += dmgUsageTokens(usage)
      agg.cost = dmgRoundMoney(agg.cost + dmgRoundMoney(cost))
      if (model) agg.byModel[model] = dmgRoundMoney((agg.byModel[model] || 0) + dmgRoundMoney(cost))
      agg.lastTs = Date.now()
    }

    // 取"最像当前这一轮"的那个会话。评分顺序很重要:
    //   ① **正在进行的会话**优先 —— 否则主会话上一轮刚结束、子代理这一轮刚开始时,
    //      会把主会话那个"已完成的旧总额"当成进行中的金额报出去(前端就会跳一个陈旧的大数);
    //   ② 主会话优先于子代理(子代理一轮通常远小于主会话);
    //   ③ 再看 token 量。
    function liveSnapshot() {
      let best = null
      let bestId = null
      let bestActive = false
      for (const [id, a] of liveTurns) {
        const active = activeTurns.has(id)
        const score = (x, act) => (act ? 1e30 : 0) + (x.isSubagent ? 0 : 1e15) + x.tokens
        if (best === null || score(a, active) > score(best, bestActive)) {
          best = a
          bestId = id
          bestActive = active
        }
      }
      if (!best) return null
      return {
        sessionId: bestId,
        turn: best.turn,
        tokens: best.tokens,
        amount: best.cost,
        active: bestActive,
        isSubagent: !!best.isSubagent,
        ts: best.lastTs,
      }
    }

    function broadcast(eventName, payload) {
      if (sseClients.size === 0) return
      let frame
      try {
        frame = 'event: ' + eventName + '\ndata: ' + JSON.stringify(payload) + '\n\n'
      } catch (err) { return }
      for (const res of Array.from(sseClients)) {
        try { res.write(frame) } catch (err) { sseClients.delete(res) }
      }
    }

    function isSubagentSession(session) {
      // 子代理会话的判定:DSH 在 SessionHeader 上给了 origin / parentSession / delegationDepth 三个信号
      const header = (session && session.header) || {}
      return header.origin === 'subagent'
        || !!header.parentSession
        || Number(header.delegationDepth) > 0
    }

    function activitySnapshot() {
      let since = null
      let mainSessions = 0
      for (const a of activeTurns.values()) {
        if (!a.isSubagent) mainSessions++
        if (since === null || a.since < since) since = a.since
      }
      return {
        working: activeTurns.size > 0,
        mainWorking: mainSessions > 0,
        since: since,
        sessions: activeTurns.size,
        // 「本轮进行中」的镜像计价结果:前端持续模式就跳这个数字(不再是上一轮的旧金额)
        live: liveSnapshot(),
      }
    }

    function noteActivity() {
      try {
        const cfg = readConfig()
        if (cfg.pushEnabled === false) return
        broadcast('activity', activitySnapshot())
      } catch (err) {}
    }

    // —— ④ 订阅会话事件流:记"正在干活"、turn/end 推"去取数" ——
    // 金额仍由挂件算,这里只负责"叫醒"和"现在是否在干活"。
    // 注意订阅挂在 root 上(不依赖任何服务就绪),与 webserver/index-inject 同一层。
    //
    // 「在不在干活」刻意**不**只认 turn/start:任何一个会话活动事件都足以证明"正在干活",
    // 而收尾只由 turn/end / session/disposed 负责。理由:
    //   · 真实会话日志里 turn/start 确实存在(实测 8 次),但把它当成**唯一**信号太脆 ——
    //     事件类型表里声明了不等于每条执行路径都会写它;
    //   · 标记是幂等的(已在集合里就不再改动),所以 step/start 这类高频事件(实测 387 次/会话)
    //     **不会**把 SSE 打爆 —— 只有状态真的从"闲"变"忙"时才广播一帧。
    // 效果:即使某个版本不写 turn/start,第一次 step/start 也会把 working 拉起来。
    const ACTIVITY_MARK_TYPES = {
      'turn/start': 1,
      'step/start': 1,
      'assistant/message': 1,
      'tool/call': 1,
      'tool/result': 1,
      'user/message': 1,
    }

    rowDisposers.push(root.on('session/event', (session, event) => {
      try {
        if (!event || !event.type) return
        const type = event.type
        const sessionId = (session && session.id) || 'default'
        const isSubagent = isSubagentSession(session)

        // ①「本轮进行中的金额」:每条 assistant/message 都按挂件同式累加。
        //    放在活动标记之前 —— 否则会因为标记分支提前 return 而漏掉累计。
        if (type === 'assistant/message') bumpLive(sessionId, event, isSubagent)

        // ② 活动标记 / 收尾
        if (ACTIVITY_MARK_TYPES[type] === 1) {
          if (activeTurns.has(sessionId)) return   // 已经在"工作中":幂等,不重复广播
          activeTurns.set(sessionId, {
            since: Date.now(),
            isSubagent: isSubagent,
            turn: (event.data && event.data.turn) != null ? event.data.turn : null,
          })
          // turn/start 是首选信号;若它缺席,这里也会被 step/start 之类的首次活动点亮
          noteActivity()
          return
        }

        if (type !== 'turn/end') return
        activeTurns.delete(sessionId)
        lastTurnEnd = {
          ts: Date.now(),
          sessionId: (session && session.id) || null,
          isSubagent: isSubagent,
          turn: (event.data && event.data.turn) != null ? event.data.turn : null,
          reason: (event.data && event.data.reason && event.data.reason.kind) || null,
        }
        const cfg = readConfig()
        if (cfg.pushEnabled === false) return
        // 活动状态先推:前端据此停掉"工作中间隔跳动",再处理结算那一次
        broadcast('activity', activitySnapshot())
        if (cfg.mainSessionOnly === true && isSubagent) return
        broadcast('turn', lastTurnEnd)
      } catch (err) {}
    }))

    // 会话被销毁时也要摘掉,否则一个没走到 turn/end 的会话会让前端一直以为"还在干活"
    rowDisposers.push(root.on('session/disposed', (session) => {
      try {
        const sessionId = (session && session.id) || 'default'
        if (activeTurns.delete(sessionId)) noteActivity()
      } catch (err) {}
    }))

    // —— 通道 ①:结构化注入行(桌面端唯一通道)——
    rowDisposers.push(root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        for (const row of table) {
          if (!row) continue
          if (row.kind === 'script-src' && INJECT_SRCS.indexOf(row.src) >= 0) return
          if (row.kind === 'script' && typeof row.text === 'string'
            && row.text.indexOf(OVERLAY_SRC) >= 0) return
        }
        table.push({ kind: 'script', placement: 'body', text: INLINE_ROW_TEXT })
      } catch (err) {}
    }))

    // —— 通道 ② / 路由:等 webServer 就绪 ——
    // 只把 webServer 写进 inject(硬依赖);connection 是**可选**服务,必须用 ctx.get 读,
    // 绝不能进 inject —— 老宿主没有它,一进 inject 整个插件就永远等不到服务、完全不 apply。
    root.inject(['webServer'], (ctx) => {
      const disposers = []
      root.effect(() => () => {
        for (const d of disposers) { try { d() } catch (err) {} }
        // 关掉所有还挂着的 SSE 连接并停心跳,避免热重载后留下僵尸连接
        try { if (ssePingTimer) { clearInterval(ssePingTimer); ssePingTimer = null } } catch (err) {}
        for (const res of Array.from(sseClients)) {
          sseClients.delete(res)
          try { res.end() } catch (err) {}
        }
      })

      // ---- 信任栅栏(与 dsh-whale-widget 同款三层策略,精简版)----
      // ① 插件自校验(永远先跑):Host 必须回环或显式声明;cross-site 一律拒;带 Origin 必须同源。
      // ② 宿主的 connection.requestRejection 可用 → 委托它(它内含浏览器鉴权 401)。
      // ③ 栅栏抛异常 → 按拒绝处理(fail-closed),不静默放行。
      const TRUSTED_AUTHORITIES = String(
        process.env.DSH_DMG_TRUSTED_HOSTS || process.env.DSHW_TRUSTED_HOSTS || ''
      ).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

      function isLoopbackHostname(hn) {
        const h = String(hn || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
        if (!h) return false
        if (h === 'localhost' || h.endsWith('.localhost')) return true
        if (h === '::1') return true
        const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
        if (!m) return false
        if (Number(m[1]) !== 127) return false
        return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
      }

      function selfRejection(req, opts) {
        try {
          const headers = (req && req.headers) || {}
          let hostUrl = null
          try { hostUrl = new URL('http://' + String(headers.host || '')) } catch (err) { return 403 }
          const hostname = hostUrl.hostname
          const authority = hostUrl.host
          if (!isLoopbackHostname(hostname)) {
            const listed = TRUSTED_AUTHORITIES.some((e) => (e.indexOf(':') >= 0 ? e === authority.toLowerCase() : e === hostname.toLowerCase()))
            const fenceAvailable = !!(opts && opts.fenceAvailable)
            if (!listed && !fenceAvailable) return 403
          }
          if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403
          const origin = headers.origin
          if (typeof origin === 'string' && origin && origin !== 'null') {
            let originUrl = null
            try { originUrl = new URL(origin) } catch (err) { return 403 }
            if (originUrl.host.toLowerCase() !== authority.toLowerCase()) return 403
          }
          return null
        } catch (err) { return 403 }
      }

      function connectionFence() {
        try {
          const conn = ctx.get('connection') || ctx.connection
          return conn && typeof conn.requestRejection === 'function' ? conn : null
        } catch (err) { return null }
      }

      // 写请求(改配置)只允许来自本机回环 —— 与挂件 0.3.15 起的安全策略一致。
      // 本插件不接触任何凭据,这条是纵深防御:配置能被任意 Web 会话改写本身就不该发生。
      const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
      function writeRejection(req) {
        try {
          const method = String((req && req.method) || 'GET').toUpperCase()
          if (!WRITE_METHODS.has(method)) return null
          const headers = (req && req.headers) || {}
          let hostUrl = null
          try { hostUrl = new URL('http://' + String(headers.host || '')) } catch (err) { return 403 }
          return isLoopbackHostname(hostUrl.hostname) ? null : 403
        } catch (err) { return 403 }
      }

      function rejected(req, res) {
        const deny = (code) => {
          try { res.statusCode = code || 403; res.end() } catch (err) {}
          return true
        }
        const conn = connectionFence()
        const self = selfRejection(req, { fenceAvailable: !!conn })
        if (self !== null) return deny(self)
        const write = writeRejection(req)
        if (write !== null) return deny(write)
        if (!conn) return false
        let code
        try {
          code = conn.requestRejection(req)
        } catch (err) {
          return deny(403)
        }
        if (code === undefined || code === null || code === false) return false
        return deny(typeof code === 'number' ? code : 403)
      }

      function registerRoute(route) {
        const inner = route && route.handler
        const wrapped = Object.assign({}, route, {
          handler: async (req, res) => {
            if (rejected(req, res)) return
            return inner(req, res)
          },
        })
        return ctx.webServer.register(wrapped)
      }

      // 静态前端资源的统一出口
      function serveAsset(fileName) {
        return (req, res) => {
          try {
            const text = loadAssetText(fileName)
            res.writeHead(200, {
              'Content-Type': 'application/javascript; charset=utf-8',
              'Cache-Control': 'no-store',
            })
            res.end(text)
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end(fileName + ' unavailable: ' + String((err && err.message) || err))
          }
        }
      }

      // ---- 路由 ----

      disposers.push(registerRoute({
        kind: 'exact', path: OVERLAY_SRC, handler: serveAsset('overlay.js'),
      }))
      disposers.push(registerRoute({
        kind: 'exact', path: PANEL_SRC, handler: serveAsset('panel.js'),
      }))

      // —— SSE:turn/end 的即时叫醒通道 ——
      // 前端只把它当"现在去取一次数"的信号,不从这里拿金额(金额永远来自挂件)。
      disposers.push(registerRoute({
        kind: 'exact',
        path: EVENTS_ROUTE,
        handler: (req, res) => {
          try {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-store, no-transform',
              Connection: 'keep-alive',
              'X-Accel-Buffering': 'no',
            })
            // 握手帧:前端据此确认通道真的通了(而不是被中间层吞掉)
            res.write('event: hello\ndata: {"ok":true,"version":' + JSON.stringify(version) + '}\n\n')
            sseClients.add(res)
            let closed = false
            const drop = () => {
              if (closed) return
              closed = true
              sseClients.delete(res)
              try { res.end() } catch (err) {}
            }
            req.on('close', drop)
            req.on('error', drop)
            res.on('close', drop)
            res.on('error', drop)
            // 心跳:让反代/客户端能发现半死连接
            if (!ssePingTimer) {
              ssePingTimer = setInterval(() => {
                broadcast('ping', { t: Date.now(), clients: sseClients.size })
              }, SSE_PING_MS)
              try { if (ssePingTimer && typeof ssePingTimer.unref === 'function') ssePingTimer.unref() } catch (err) {}
            }
          } catch (err) {
            try { res.statusCode = 500; res.end() } catch (e2) {}
          }
        },
      }))

      // 「现在有没有在干活」——仅供「工作中持续跳动」用;前端每 3 秒取一次(很小的 JSON)。
      // 为什么还要一条轮询路由:SSE 只是让反应更快,真正可信的状态源是这里 ——
      // 这样一来即使某次 activity 帧丢了、或 SSE 压根没连上,也不会一直以为"还在干活"而空跳。
      disposers.push(registerRoute({
        kind: 'exact',
        path: ACTIVITY_ROUTE,
        handler: (req, res) => {
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(Object.assign({ ok: true }, activitySnapshot())))
        },
      }))

      // 配置:GET 读、PUT/POST 改(仅本机)
      disposers.push(registerRoute({
        kind: 'exact',
        path: CONFIG_ROUTE,
        handler: async (req, res) => {
          const method = String((req && req.method) || 'GET').toUpperCase()
          if (method === 'GET' || method === 'HEAD') {
            res.writeHead(200, JSON_HEADERS)
            res.end(JSON.stringify(readConfig()))
            return
          }
          if (method === 'PUT' || method === 'POST' || method === 'PATCH') {
            try {
              const body = await readJsonBody(req)
              const next = writeConfig(body)
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify({ ok: true, config: next, file: CONFIG_FILE }))
            } catch (err) {
              res.writeHead(400, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
            }
            return
          }
          res.writeHead(405, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
        },
      }))

      // 自查路由:一眼看清插件版本、配置落点、数据源、推送通道状态
      disposers.push(registerRoute({
        kind: 'exact',
        path: STATUS_ROUTE,
        handler: (req, res) => {
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({
            ok: true,
            plugin: 'dsh-damage-number',
            version,
            overlaySrc: OVERLAY_SRC,
            panelSrc: PANEL_SRC,
            eventsSrc: EVENTS_ROUTE,
            activitySrc: ACTIVITY_ROUTE,
            configFile: CONFIG_FILE,
            configExists: fs.existsSync(CONFIG_FILE),
            config: readConfig(),
            dataSource: '/dsh-whale/last-turn.json',
            // 推送侧自查:sseClients > 0 说明至少有一个页面真的把 SSE 挂上了
            sseClients: sseClients.size,
            // "工作中持续跳动"的状态源:working=true 说明现在有轮次正在进行
            activity: activitySnapshot(),
            // 镜像计价的可见性:前端跳的就是 live.amount;自检时和挂件给的真实金额对比
            pricingMirror: {
              source: 'dsh-whale-widget lib/index.js (isPeakTime + PRICING + 计费公式)',
              models: Object.keys(DMG_PRICING).filter((k) => k !== '_default'),
              peakHours: DMG_PEAK_HOURS,
              holidayDates: Object.keys(DMG_HOLIDAY_VALLEY).length,
              nowIsPeak: dmgIsPeakTime(Math.floor(Date.now() / 1000)),
              // 固定时刻的峰谷自检:peak 必须等于 expect,否则说明镜像的峰谷规则该更新了
              probe: dmgPeakProbe(),
            },
            lastTurnEnd,
            trustedHosts: TRUSTED_AUTHORITIES,
            connectionFence: !!connectionFence(),
          }))
        },
      }))

      // —— 通道 ③:index HTML 变换(普通 dsh web 形态;桌面端不经过这里,故与 ① 并存)——
      try {
        disposers.push(ctx.webServer.tapIndex((html) => {
          if (typeof html !== 'string') return html
          if (html.indexOf(OVERLAY_SRC) !== -1) return html
          const tags = INJECT_SRCS.map((s) => '<script defer src="' + s + '"></script>').join('')
          if (html.indexOf('</body>') !== -1) return html.replace('</body>', tags + '</body>')
          return html + tags
        }))
      } catch (err) {}
    })
  },
}
