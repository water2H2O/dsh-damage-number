// ============================================================================
// dsh-damage-number —— 自测台
// ============================================================================
// 不是"复制一份逻辑再测":这里用 node:vm + DOM 打桩**真实执行** assets/overlay.js,
// 所以验证的就是将来跑在浏览器里的那份代码。
//
// 跑法:  node tools/selftest.mjs
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OVERLAY = path.resolve(HERE, '..', 'assets', 'overlay.js')

// ---------------- 断言 ----------------
let passed = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('  \u2713 ' + label); return }
  failures.push(label + (extra ? '  \u2190 ' + extra : ''))
  console.log('  \u2717 ' + label + (extra ? '  \u2190 ' + extra : ''))
}
function eq(actual, expected, label) {
  ok(actual === expected, label, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected))
}
function near(actual, expected, tol, label) {
  ok(Math.abs(actual - expected) <= tol, label, 'got ' + actual + ', want ~' + expected)
}
function section(t) { console.log('\n' + t) }

// ---------------- DOM 打桩 ----------------
function makeEl(tag) {
  const el = {
    tagName: tag, id: '', className: '', textContent: '', children: [], parentNode: null,
    style: { cssText: '', setProperty() {} },
    __rect: null, __finish: null, __anim: null,
    appendChild(c) { c.parentNode = el; el.children.push(c); return c },
    removeChild(c) {
      const i = el.children.indexOf(c)
      if (i >= 0) el.children.splice(i, 1)
      c.parentNode = null
      return c
    },
    getBoundingClientRect() { return el.__rect || { left: 0, top: 0, width: 0, height: 0 } },
    addEventListener() {},
    animate(frames, timing) {
      el.__anim = { frames, timing }
      return { addEventListener(type, fn) { if (type === 'finish') el.__finish = fn } }
    },
    querySelector() { return null },
  }
  return el
}

function makeStorage() {
  const map = new Map()
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null },
    setItem(k, v) { map.set(k, String(v)) },
    removeItem(k) { map.delete(k) },
    __map: map,
  }
}

// 可控的 EventSource 打桩:记录实例,并允许手动触发 hello/turn/onopen/onerror
function makeEventSourceStub() {
  const instances = []
  function ES(url) {
    const listeners = {}
    const inst = {
      url: url, closed: false, onopen: null, onerror: null,
      addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn) },
      close() { inst.closed = true },
      __fire(t, data) {
        const list = listeners[t] || []
        for (const fn of list) fn({ data: typeof data === 'string' ? data : JSON.stringify(data) })
      },
      __open() { if (inst.onopen) inst.onopen() },
      __error() { if (inst.onerror) inst.onerror() },
    }
    instances.push(inst)
    return inst
  }
  ES.instances = instances
  return ES
}

function makeHarness(opts) {
  const storage = (opts && opts.storage) || makeStorage()
  const ES = (opts && opts.eventSource) || null
  const state = {
    turn: { ok: true, seq: 0, amount: null, tokens: null, ts: null },
    turnFail: false,
    cfg: null,
    cfgFail: false,
    whalePresent: true,
    activity: { ok: true, working: false, mainWorking: false, since: null, sessions: 0 },
    activityFail: false,
    activityCalls: 0,
    puts: [],
    stripKeys: null,
  }

  const body = makeEl('body')
  const docEl = makeEl('html')
  const whaleImg = makeEl('img')
  whaleImg.__rect = { left: 1000, top: 700, width: 200, height: 200 }

  const document = {
    readyState: 'complete',
    body, documentElement: docEl,
    createElement: (t) => makeEl(t),
    addEventListener() {},
    getElementById(id) {
      const walk = (n) => {
        for (const c of n.children) {
          if (c.id === id) return c
          const hit = walk(c)
          if (hit) return hit
        }
        return null
      }
      return walk(body) || walk(docEl)
    },
    querySelector(sel) {
      if (sel.indexOf('dshwv') >= 0) return state.whalePresent ? whaleImg : null
      return null
    },
  }

  // ---- 虚拟时钟 ----
  // 之前这里 setInterval 只是 `return 1`、回调**永远不会被执行** ——
  // 于是「监督器定时器 → shouldBurst → burstTick」这条持续模式的主路径一次都没被测过,
  // 只测了 shouldBurst() 这个纯判断。现在把定时器和 Date.now 都接到同一个虚拟时钟上,
  // 测试可以自己"把时间往前推"来驱动真实路径。
  const clock = { now: 1700000000000, id: 0, timers: new Map() }
  function setTimer(fn, ms, repeat) {
    const id = ++clock.id
    const delay = Math.max(0, Number(ms) || 0)
    clock.timers.set(id, { fn: fn, ms: delay, repeat: repeat, next: clock.now + delay })
    return id
  }
  function advance(ms) {
    const target = clock.now + Math.max(0, Number(ms) || 0)
    let guard = 0
    for (;;) {
      if (guard++ > 20000) throw new Error('虚拟时钟:定时器疑似自激(超过 20000 次回调)')
      let pickId = null
      let pick = null
      for (const [id, t] of clock.timers) {
        if (t.next <= target && (pick === null || t.next < pick.next)) { pick = t; pickId = id }
      }
      if (pick === null) break
      clock.now = pick.next
      if (pick.repeat) pick.next = clock.now + pick.ms
      else clock.timers.delete(pickId)
      try { pick.fn() } catch (err) {}
    }
    clock.now = target
  }

  const sandbox = {
    document,
    window: { innerWidth: 1200, innerHeight: 800, localStorage: storage },
    localStorage: storage,
    console,
    __clock: clock,
    fetch: async (url, o) => {
      const u = String(url)
      const method = (o && o.method) || 'GET'
      if (u.indexOf('/dsh-whale/last-turn.json') >= 0) {
        if (state.turnFail) return { ok: false, status: 500, json: async () => null }
        return { ok: true, status: 200, json: async () => state.turn }
      }
      if (u.indexOf('/dsh-dmg/config.json') >= 0) {
        if (method === 'PUT') {
          let body = null
          try { body = JSON.parse(o.body) } catch (err) {}
          state.puts.push(body)
          // 模拟"旧宿主的 sanitize() 不认识某些键" → 静默丢掉它们
          let stored = body
          if (state.stripKeys && state.stripKeys.length) {
            stored = Object.assign({}, body)
            for (const k of state.stripKeys) delete stored[k]
          }
          state.cfg = stored
          return { ok: true, status: 200, json: async () => ({ ok: true, config: stored, file: 'x' }) }
        }
        if (state.cfgFail) return { ok: false, status: 404, json: async () => null }
        return { ok: true, status: 200, json: async () => state.cfg }
      }
      if (u.indexOf('/dsh-dmg/activity.json') >= 0) {
        if (state.activityFail) return { ok: false, status: 404, json: async () => null }
        state.activityCalls++
        return { ok: true, status: 200, json: async () => state.activity }
      }
      return { ok: false, status: 404, json: async () => null }
    },
    setInterval(fn, ms) { return setTimer(fn, ms, true) },
    setTimeout(fn, ms) { return setTimer(fn, ms, false) },
    clearInterval(id) { clock.timers.delete(id) },
    clearTimeout(id) { clock.timers.delete(id) },
  }

  const ctx = vm.createContext(sandbox)
  if (ES) sandbox.window.EventSource = ES
  // Date.now 也必须接到虚拟时钟:否则定时器走了 10 秒而 Date.now() 还是真实时间,
  // shouldBurst 永远算不出"已经过了间隔" —— 这正是"定时器没被测过"会漏掉的那类错。
  vm.runInContext('Date.now = function () { return globalThis.__clock.now }', ctx)
  vm.runInContext('globalThis.__randQueue = []; Math.random = function () {'
    + ' return globalThis.__randQueue.length ? globalThis.__randQueue.shift() : 0.5; };', ctx)
  // 拿到上下文里那个数组的**真实引用**,避免跨 realm 属性同步的不确定性
  const randQueue = vm.runInContext('globalThis.__randQueue', ctx)
  const setRand = (v) => { randQueue.length = 0; randQueue.push(v) }

  vm.runInContext(fs.readFileSync(OVERLAY, 'utf8'), ctx, { filename: 'overlay.js' })

  return {
    state, sandbox, ctx, body, whaleImg, setRand, storage, ES, clock, advance,
    hook: sandbox.window.__dshDmgNumber,
    layer: () => document.getElementById('dsh-dmg-layer'),
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

// ============================================================================
async function main() {
  console.log('dsh-damage-number self-test')
  console.log('  目标: ' + OVERLAY)

  section('1. 加载与初始化')
  const H = makeHarness()
  eq(H.sandbox.window.__dshDmgNumberLoaded, true, 'window.__dshDmgNumberLoaded 置位(防重复注入)')
  ok(!!H.hook, 'window.__dshDmgNumber 调试钩子已暴露')
  await flush(); await flush()
  ok(!!H.layer(), '浮层层 #dsh-dmg-layer 已挂到 body')
  eq(H.layer().children.length, 0, '首次观测只立基准,不弹数字')

  section('2. rollDamage 区间与概率(纯函数)')
  const roll = H.hook.roll
  eq(roll(0).reason, 'no-cost', '金额 0 → 不跳(no-cost)')
  eq(roll(-1).reason, 'no-cost', '负金额 → 不跳(no-cost)')
  eq(roll(0.009).reason, 'below-min', '低于下限 0.01 → 不跳(below-min)')
  eq(roll(0.009).p, 0, '低于下限 → 概率 0')
  eq(roll(0.1).p, 1, '恰好达到上限 0.10 → 概率 1(必定跳)')
  eq(roll(0.5).p, 1, '超过上限 → 概率 1')
  near(roll(0.01).p, 0.25, 1e-9, '下限处 → 概率 = minProbability(0.25)')
  near(roll(0.055).p, 0.625, 1e-9, '区间中点 0.055 → 概率 0.625(线性递增)')
  near(roll(0.0775).p, 0.8125, 1e-9, '区间 75% 处 → 概率 0.8125')

  section('3. 概率边界精确性(受控随机数)')
  H.setRand(0.6249)
  eq(roll(0.055).hit, true, '随机数 0.6249 < p(0.625) → 命中')
  H.setRand(0.6251)
  eq(roll(0.055).hit, false, '随机数 0.6251 > p(0.625) → 不命中')
  H.setRand(0.999999)
  eq(roll(0.1).hit, true, '上限处即使随机数接近 1 也必定命中')
  eq(H.hook.getConfig().minAmount, 0.01, '（区间参数未被污染）')

  section('4. 区间退化(上下限相等 = 纯阈值)')
  H.hook.setConfig({ minAmount: 0.05, maxAmount: 0.05, minProbability: 0 })
  H.setRand(0.99)
  eq(roll(0.05).hit, true, '阈值模式下恰好达到阈值 → 必定命中')
  eq(roll(0.049).reason, 'below-min', '阈值模式下差一点 → below-min')
  H.hook.setConfig({ minAmount: 0.01, maxAmount: 0.1, minProbability: 0.25 })

  section('5. 总开关')
  H.hook.setConfig({ enabled: false })
  H.state.turn = { ok: true, seq: 100, amount: 9.99, tokens: 1, ts: 1 }
  eq(await H.hook.tick(), null, 'enabled:false 时即使金额很大也不判定')
  eq(H.layer().children.length, 0, 'enabled:false 时不生成任何节点')
  H.hook.setConfig({ enabled: true })

  section('6. tick 轮询:seq 驱动')
  H.hook.reset()
  H.state.turn = { ok: true, seq: 5, amount: 0.2, tokens: 1, ts: 1 }
  eq(await H.hook.tick(), null, '重置后首次 tick 只立基准(seq=5),不弹')
  eq(H.layer().children.length, 0, '基准轮不产生节点')
  eq(await H.hook.tick(), null, '同一 seq 重复轮询 → 不重复弹')

  H.state.turn = { ok: true, seq: 6, amount: 0.001, tokens: 1, ts: 2 }
  const r6 = await H.hook.tick()
  eq(r6 && r6.hit, false, '新 seq 但金额低于下限 → 判定为不跳')
  eq(H.layer().children.length, 0, '低于下限不生成节点')

  H.state.turn = { ok: true, seq: 7, amount: 0.5, tokens: 1, ts: 3 }
  const r7 = await H.hook.tick()
  eq(r7 && r7.hit, true, '新 seq 且超过上限 → 命中')
  eq(H.layer().children.length, 1, '生成 1 个飘字节点')

  H.state.turn = { ok: true, seq: 3, amount: 0.5, tokens: 1, ts: 4 }
  eq(await H.hook.tick(), null, 'seq 回退(挂件重启)→ 只重立基准,不弹')
  eq(H.layer().children.length, 1, 'seq 回退不新增节点')

  section('7. 数据源不可达时保持安静')
  H.state.turnFail = true
  eq(await H.hook.tick(), null, 'last-turn.json 500 → 返回 null,不抛异常')
  H.state.turnFail = false
  H.state.turn = { ok: false, seq: 0 }
  eq(await H.hook.tick(), null, 'ok:false 的载荷 → 忽略')

  section('8. config.json 404 时保留默认配置')
  H.setRand(0.5)
  H.state.cfgFail = true
  await H.hook.loadConfig()
  eq(H.hook.getConfig().maxAmount, 0.1, '取不到配置 → 保留默认 maxAmount=0.1')
  H.state.cfgFail = false

  section('9. 配置热更新(界面改配置后 30 秒内生效)')
  H.state.cfg = { minAmount: 0.5, maxAmount: 1, minProbability: 0, fontSizePx: 44, color: '#00aa00' }
  await H.hook.loadConfig()
  const applied = H.hook.getConfig()
  eq(applied.minAmount, 0.5, 'loadConfig 生效:minAmount')
  eq(applied.maxAmount, 1, 'loadConfig 生效:maxAmount')
  eq(applied.fontSizePx, 44, 'loadConfig 生效:fontSizePx')
  eq(applied.prefix, '-¥', '未在配置里出现的键回落默认值(prefix)')
  H.state.cfg = null
  await H.hook.loadConfig()
  eq(H.hook.getConfig().minAmount, 0.5, '载荷为 null(畸形响应)→ 保留上一次有效配置,不静默回退')
  H.state.cfg = {}
  await H.hook.loadConfig()
  eq(H.hook.getConfig().minAmount, 0.01, '载荷为空对象 → 回到默认区间')

  section('10. spawn 落点与文本')
  H.hook.setConfig({ prefix: '-¥', decimals: 2, jitterX: 0.18 })
  H.setRand(0.5)
  const n1 = H.hook.spawn(0.05)
  eq(n1.children[0].textContent, '-¥0.05', '文本 = 前缀 + 金额(2 位小数)')
  eq(n1.style.left, '1100px', '落点 X = 鲸鱼图 left + 50% 宽(1100)')
  eq(n1.style.top, '724px', '落点 Y = 鲸鱼图 top + 12% 高(724)')
  ok(String(n1.style.transform).indexOf('rotate(0.00deg)') >= 0, '随机数 0.5 → 无抖动、无旋转')

  const n2 = H.hook.spawn(0.004)
  eq(n2.children[0].textContent, '-¥0.004', '小于半分钱时补到 3 位小数(不显示成 0.00)')

  section('11. 动效关键帧与清理')
  const anim = n1.children[0].__anim
  ok(!!anim, '使用了 Web Animations API(inner.animate)')
  const tyOf = (f) => {
    const m = /translateY\((-?[\d.]+)px\)/.exec(String(f.transform))
    return m ? parseFloat(m[1]) : NaN
  }
  eq(anim.frames.length, 5, '5 段关键帧(弹出 → 过冲 → 落定 → 缓慢上浮 → 淡出)')
  eq(anim.frames[0].opacity, 0, '起始透明')
  eq(anim.frames[1].opacity, 1, '过冲帧已不透明')
  ok(String(anim.frames[1].transform).indexOf('scale(1.28)') >= 0, '过冲缩放 1.28(弹出感)')
  eq(anim.frames[4].opacity, 0, '末帧淡出为 0')
  ok(String(anim.frames[4].transform).indexOf('translateY(-96.0px)') >= 0, '末帧停在完整上浮距离上')
  ok(String(anim.frames[4].transform).indexOf('%') < 0, '关键帧只用 px(不与百分比混插)')
  eq(anim.timing.duration, 1800, '默认时长 1800ms')
  eq(anim.timing.fill, 'forwards', 'fill:forwards')

  // ——「滑动太快 / 显示时间太短」的回归守卫 ——
  // 旧版:可见窗口只有约 0.7 个时长,主段速度 ≈78px/s。这三条把它钉住,防止再改回去。
  eq(anim.frames[3].opacity, 1, '倒数第二帧仍然完全可见')
  const holdSpan = anim.frames[3].offset - anim.frames[2].offset
  ok(holdSpan >= 0.45, '主可见段至少占时长的 45%', 'span=' + holdSpan)
  const visibleSpan = anim.frames[3].offset - anim.frames[1].offset
  ok(visibleSpan >= 0.65, '完全不透明的时间窗 ≥ 时长的 65%', 'span=' + visibleSpan)
  const driftPx = Math.abs(tyOf(anim.frames[3])) - Math.abs(tyOf(anim.frames[2]))
  const driftMs = holdSpan * anim.timing.duration
  const speed = driftPx / driftMs * 1000
  ok(speed < 70, '主可见段上浮速度 < 70px/s(慢于旧版 ≈78px/s)', speed.toFixed(1) + 'px/s')

  const layerNow = H.layer()
  const before = layerNow.children.length
  n1.children[0].__finish()
  eq(layerNow.children.length, before - 1, '动画 finish 后节点被移除')

  section('12. 堆叠上限')
  H.hook.setConfig({ maxStack: 3 })
  for (let i = 0; i < 6; i++) H.hook.spawn(0.2)
  ok(H.layer().children.length <= 3, 'maxStack=3 时同屏节点不超过 3', 'actual=' + H.layer().children.length)
  H.hook.setConfig({ maxStack: 6 })

  section('13. 鲸鱼不存在时优雅降级')
  H.state.whalePresent = false
  let threw = null
  let n3 = null
  try { n3 = H.hook.spawn(0.2) } catch (err) { threw = err }
  eq(threw, null, '找不到鲸鱼元素时不抛异常')
  ok(!!n3, '仍然生成节点(回落到视口右下角)')
  eq(n3.style.left, '1120px', '回落位置 = innerWidth(1200) - 80')
  H.state.whalePresent = true

  section('14. 鲸鱼被拖动后落点跟随')
  H.whaleImg.__rect = { left: 60, top: 300, width: 400, height: 400 }
  H.setRand(0.5)
  const n4 = H.hook.spawn(0.2)
  eq(n4.style.left, '260px', '新位置 X = 60 + 400*0.5')
  eq(n4.style.top, '348px', '新位置 Y = 300 + 400*0.12')

  section('15. seq 持久化:刷新页面不漏掉刚结束的那一轮')
  const shared = makeStorage()
  const A = makeHarness({ storage: shared })
  // 注意:必须在启动 tick 的微任务之前就位,否则启动轮会用默认 seq=0 立基准
  A.state.turn = { ok: true, seq: 42, amount: 0.9, tokens: 1, ts: 1 }
  await flush(); await flush()
  eq(A.hook.getBaseline(), 42, '本机首次运行:只立基准(seq=42)')
  eq(A.layer().children.length, 0, '首次运行不把历史轮次补弹一遍')
  eq(shared.getItem('dshw-dmg-last-seq'), '42', '基准 seq 已持久化到 localStorage')

  // 同一台机器重开页面(共用同一个 localStorage),期间又结束了一轮 43
  const B = makeHarness({ storage: shared })
  B.state.turn = { ok: true, seq: 43, amount: 0.9, tokens: 1, ts: 2 }
  await flush(); await flush()
  eq(B.layer().children.length, 1, '页面重开后,启动轮就把那一轮补上了(没漏)')
  eq(shared.getItem('dshw-dmg-last-seq'), '43', '记忆推进到 43')

  // 记忆里的 seq 比 host 的还大(host 重置 / 文件丢失)→ 只拉齐,不弹
  const C = makeHarness({ storage: shared })
  shared.setItem('dshw-dmg-last-seq', '100')
  C.state.turn = { ok: true, seq: 3, amount: 0.9, tokens: 1, ts: 3 }
  await flush(); await flush()
  eq(C.hook.getBaseline(), 3, 'seq 落后于记忆(host 重置)→ 基准拉齐到 3')
  eq(C.layer().children.length, 0, '拉齐时不产生节点(不用陈旧基准乱跳)')

  section('16. localStorage 不可用时退化(隐私模式)')
  const noStore = {
    getItem() { throw new Error('denied') },
    setItem() { throw new Error('denied') },
    removeItem() { throw new Error('denied') },
  }
  const D = makeHarness({ storage: noStore })
  D.state.turn = { ok: true, seq: 900, amount: 0.9, tokens: 1, ts: 1 }
  await flush(); await flush()
  eq(D.hook.getBaseline(), 900, '存储被禁时仍能在本次会话内立基准')
  eq(D.layer().children.length, 0, '存储被禁不导致异常或误弹')
  D.state.turn = { ok: true, seq: 901, amount: 0.9, tokens: 1, ts: 2 }
  eq((await D.hook.tick()) && true, true, '存储被禁时后续轮次照常判定')

  section('17. 宿主与前端的两份默认配置逐字段一致')
  // lib/index.js 的 DEFAULT_CONFIG 与 assets/overlay.js 的 DEFAULT_CFG 是两份独立字面量,
  // 一个"全新安装的默认值"、一个"取不到配置时的兜底"。它们一旦漂移,行为就会在
  // "装了插件"和"配置读失败"两种情况下不一样 —— 这条断言专门钉住这个风险。
  // 真实现与两份默认值都在 lib/index.js(宿主半区单文件,与 dsh-whale-widget 同结构)
  const hostSrc = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'index.js'), 'utf8')
  function extractObjectLiteral(src, marker) {
    const i = src.indexOf(marker)
    if (i < 0) return null
    const start = src.indexOf('{', i)
    let depth = 0
    for (let j = start; j < src.length; j++) {
      if (src[j] === '{') depth++
      else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1) }
    }
    return null
  }
  const hostLiteral = extractObjectLiteral(hostSrc, 'const DEFAULT_CONFIG =')
  ok(!!hostLiteral, '成功取出宿主侧 DEFAULT_CONFIG 字面量')
  const hostCfg = vm.runInNewContext('(' + hostLiteral + ')')

  const fresh = makeHarness()
  const clientCfg = fresh.hook.getConfig()   // 尚未读到配置 → 就是前端 DEFAULT_CFG 本身
  const keysHost = Object.keys(hostCfg).sort()
  const keysClient = Object.keys(clientCfg).sort()
  eq(JSON.stringify(keysClient), JSON.stringify(keysHost), '两侧键集合一致')
  const drift = []
  for (const k of keysHost) {
    if (JSON.stringify(hostCfg[k]) !== JSON.stringify(clientCfg[k])) {
      drift.push(k + ' host=' + JSON.stringify(hostCfg[k]) + ' client=' + JSON.stringify(clientCfg[k]))
    }
  }
  eq(drift.length, 0, '两侧默认值逐字段一致', drift.join(' | '))
  eq(hostCfg.maxAmount, 0.1, '（抽查)宿主默认区间上限 = 0.1')

  section('18. SSE 推送:turn/end 即时触发')
  const E1 = makeEventSourceStub()
  const S1 = makeHarness({ eventSource: E1 })
  S1.state.turn = { ok: true, seq: 1, amount: 0.5, tokens: 1, ts: 1 }
  await flush(); await flush()
  eq(E1.instances.length, 1, '建立了 1 条 SSE 连接')
  eq(E1.instances[0].url, '/dsh-dmg/events', '连到 /dsh-dmg/events')
  eq(S1.hook.getRuntime().sseState, 'connecting', '建连后先标记「连接中」')
  const es1 = E1.instances[0]
  es1.__fire('hello', { ok: true, version: '0.2.0' })
  eq(S1.hook.getRuntime().sseReady, true, '收到 hello 握手帧 → 通道确认可用')
  eq(S1.hook.getRuntime().sseState, 'ready', '状态变为 ready')
  eq(S1.layer().children.length, 0, '握手本身不会凭空生成数字')

  S1.state.turn = { ok: true, seq: 2, amount: 0.5, tokens: 1, ts: 2 }
  es1.__fire('turn', { isSubagent: false, turn: 2 })
  await flush(); await flush()
  eq(S1.layer().children.length, 1, '收到 turn 事件后立刻取数并触发(上限金额必跳)')
  eq(S1.hook.getRuntime().lastTrigger, 'push', '触发来源记为 push(而不是 poll)')

  section('19. SSE 重连也会补一次,断线不丢轮次')
  S1.state.turn = { ok: true, seq: 3, amount: 0.5, tokens: 1, ts: 3 }
  es1.__error()
  eq(S1.hook.getRuntime().sseState, 'reconnecting', 'onerror → 状态为「重连中」(靠轮询顶着)')
  es1.__open()
  await flush(); await flush()
  eq(S1.hook.getRuntime().sseReady, true, '重连成功后恢复 ready')
  eq(S1.layer().children.length, 2, '重连时立刻补取了断线期间结束的那一轮')

  section('20. mainSessionOnly:子代理轮次不当成一整轮对话')
  const E2 = makeEventSourceStub()
  const S2 = makeHarness({ eventSource: E2 })
  S2.state.turn = { ok: true, seq: 10, amount: 0.5, tokens: 1, ts: 1 }
  await flush(); await flush()
  S2.hook.setConfig({ mainSessionOnly: true })
  const es2 = E2.instances[0]
  eq(es2.closed, false, '改配置不会把已有连接关掉')

  S2.state.turn = { ok: true, seq: 11, amount: 0.5, tokens: 1, ts: 2 }
  es2.__fire('turn', { isSubagent: true, turn: 11 })
  await flush(); await flush()
  eq(S2.layer().children.length, 0, '子代理的 turn/end 不即时触发')

  S2.state.turn = { ok: true, seq: 12, amount: 0.5, tokens: 1, ts: 3 }
  es2.__fire('turn', { isSubagent: false, turn: 12 })
  await flush(); await flush()
  eq(S2.layer().children.length, 1, '主会话的 turn/end 照常即时触发')

  section('21. pushEnabled 可关闭、可再打开')
  const E3 = makeEventSourceStub()
  const S3 = makeHarness({ eventSource: E3 })
  await flush(); await flush()
  eq(E3.instances.length, 1, '默认开启推送 → 建立连接')
  S3.hook.setConfig({ pushEnabled: false })
  eq(E3.instances[0].closed, true, '关闭推送 → 连接被关闭')
  eq(S3.hook.getRuntime().sseState, 'off', '状态为 off(此时全靠轮询)')
  S3.hook.setConfig({ pushEnabled: true })
  eq(E3.instances.length, 2, '再次开启 → 重新建立连接')

  section('22. 浏览器不支持 EventSource 时安静退化')
  const S4 = makeHarness()   // 不给 EventSource
  await flush(); await flush()
  eq(S4.hook.getRuntime().sseState, 'unsupported', '没有 EventSource → 标记 unsupported')
  eq(S4.hook.getRuntime().pollMs, 2000, '兜底轮询照常存在(默认 2000ms)')

  section('22b. 持续模式(mode=working):工作期间按间隔无条件跳动')
  const E5 = makeEventSourceStub()
  const W = makeHarness({ eventSource: E5 })
  W.state.turn = { ok: true, seq: 3, amount: 0.07, tokens: 1, ts: 1 }
  await flush(); await flush()
  eq(W.hook.getRuntime().lastKnownAmount, 0.07, '启动读数就记住了上一轮的真实金额')
  eq(W.hook.getRuntime().mode, 'turnEnd', '默认仍是「每轮结束时」')
  eq(W.hook.getRuntime().supervisorOn, false, '默认模式下不启动监督器')
  eq(W.hook.getRuntime().activityPollOn, false, '默认模式下不发活动轮询(零多余请求)')
  eq(W.state.activityCalls, 0, '默认模式下确实一个 activity 请求都没发')

  W.hook.setConfig({ mode: 'working', tickSec: 5 })
  eq(W.hook.getRuntime().mode, 'working', '已切到持续模式')
  eq(W.hook.getRuntime().supervisorOn, true, '监督器启动')
  eq(W.hook.getRuntime().activityPollOn, true, '活动轮询启动')
  eq(W.hook.getRuntime().lastBurstAt, 0, '还没在干活 → 不开始计时')
  eq(W.hook.shouldBurst(Date.now() + 999999), false, '没在干活时再久也不跳')

  W.state.activity = { ok: true, working: true, mainWorking: true, since: 1, sessions: 1 }
  await W.hook.syncActivity()
  const w0 = W.hook.getRuntime()
  eq(w0.working, true, '读到 working=true')
  ok(w0.lastBurstAt > 0, '开始干活时记下起跳时刻')
  eq(W.hook.shouldBurst(w0.lastBurstAt + 1000), false, '不到间隔(5s)不跳')
  eq(W.hook.shouldBurst(w0.lastBurstAt + 4999), false, '差 1ms 也还不跳')
  eq(W.hook.shouldBurst(w0.lastBurstAt + 5000), true, '满 5 秒该跳')

  const beforeW = W.layer().children.length
  eq(W.hook.burstTick(), true, 'burstTick 无条件跳一次(不做概率判定)')
  eq(W.layer().children.length, beforeW + 1, '生成了节点')
  eq(W.hook.getRuntime().lastTrigger, 'working', '触发来源标记为 working')
  const wNode = W.layer().children[W.layer().children.length - 1]
  eq(wNode.children[0].textContent, '-¥0.07', '数字 = 上一轮真实金额(原样重复,零估算)')

  W.state.activity = { ok: true, working: false, mainWorking: false, since: null, sessions: 0 }
  await W.hook.syncActivity()
  eq(W.hook.getRuntime().working, false, '读到 working=false')
  eq(W.hook.shouldBurst(Date.now() + 999999), false, '停止干活后不再跳')

  W.hook.setConfig({ mainSessionOnly: true })
  W.state.activity = { ok: true, working: true, mainWorking: false, since: 1, sessions: 1 }
  await W.hook.syncActivity()
  eq(W.hook.getRuntime().working, false, '「仅主会话」时只有子代理在跑 → 不算我在干活')
  W.state.activity = { ok: true, working: true, mainWorking: true, since: 1, sessions: 2 }
  await W.hook.syncActivity()
  eq(W.hook.getRuntime().working, true, '主会话也在跑 → 照常跳')

  section('22c. 持续模式:读不到金额时宁可不跳,也不编数字')
  const W2 = makeHarness()
  await flush(); await flush()
  eq(W2.hook.getRuntime().lastKnownAmount, null, '此前没读到过任何金额')
  W2.hook.setConfig({ mode: 'working' })
  eq(W2.hook.burstTick(), false, '没有已知金额 → burstTick 拒绝')
  eq(W2.layer().children.length, 0, '也确实没有生成任何节点')

  section('22d. 持续模式:关掉总开关就彻底安静')
  const W3 = makeHarness({ eventSource: makeEventSourceStub() })
  W3.state.turn = { ok: true, seq: 9, amount: 0.2, tokens: 1, ts: 1 }
  await flush(); await flush()
  W3.hook.setConfig({ mode: 'working' })
  await W3.hook.syncActivity()
  eq(W3.hook.getRuntime().supervisorOn, true, '开着时监督器在跑')
  W3.hook.setConfig({ enabled: false })
  eq(W3.hook.getRuntime().supervisorOn, false, '总开关关掉 → 监督器停')
  eq(W3.hook.getRuntime().activityPollOn, false, '活动轮询也停')
  eq(W3.hook.burstTick(), false, '总开关关掉后 burstTick 也不跳')
  W3.hook.setConfig({ enabled: true, mode: 'turnEnd' })
  eq(W3.hook.getRuntime().supervisorOn, false, '切回「每轮结束时」→ 监督器同样停')

  section('22e. 保存时检测"宿主把键丢掉了"(版本不匹配不能被静默吞掉)')
  const S7 = makeHarness()
  await flush(); await flush()
  S7.state.stripKeys = ['mode', 'tickSec']   // 模拟旧宿主:sanitize() 不认识这两个键
  let dropErr = null
  try {
    await S7.hook.saveConfig({ mode: 'working', tickSec: 3 })
  } catch (err) { dropErr = err }
  ok(!!dropErr, '抛错,而不是"看起来保存成功"')
  eq(JSON.stringify(dropErr && dropErr.droppedKeys), JSON.stringify(['mode', 'tickSec']),
    '明确点名被丢掉的键')
  ok(String(dropErr && dropErr.message).indexOf('重启') >= 0, '错误信息给出可操作的指引')

  S7.state.stripKeys = null
  let okErr = null
  try { await S7.hook.saveConfig({ mode: 'working', tickSec: 3 }) } catch (err) { okErr = err }
  eq(okErr, null, '宿主正常接受时不再报错')
  eq(S7.hook.getConfig().mode, 'working', '并且真的生效了')
  eq(S7.hook.getConfig().tickSec, 3, '间隔也生效了')

  // ==========================================================================
  // 关键:驱动虚拟时钟,让**定时器回调真的被执行**。
  // 这一节存在的理由:之前 setInterval 的桩只是 return 1,回调永不执行 ——
  // 「监督器 → shouldBurst → burstTick」这条持续模式主路径一次都没跑过,
  // 于是"设置对了、金额也有,但就是不跳"这类问题测试根本看不见。
  // ==========================================================================
  section('22f. 持续模式:驱动虚拟时钟,验证定时器路径真的会跳')
  const E7 = makeEventSourceStub()
  const W4 = makeHarness({ eventSource: E7 })
  W4.state.turn = { ok: true, seq: 5, amount: 0.09, tokens: 1, ts: 1 }
  await flush(); await flush()
  W4.hook.setConfig({ mode: 'working', tickSec: 2 })
  W4.state.activity = { ok: true, working: true, mainWorking: true, since: 1, sessions: 1 }
  await W4.hook.syncActivity()
  const w4base = W4.layer().children.length
  eq(W4.hook.getRuntime().working, true, '已进入「工作中」')
  eq(W4.hook.getRuntime().lastKnownAmount, 0.09, '已拿到上一轮金额')
  eq(W4.hook.getRuntime().supervisorOn, true, '监督器在跑')

  W4.advance(1900)
  eq(W4.layer().children.length, w4base, '不到 2 秒不跳')
  W4.advance(300)                      // 累计 2.2s
  eq(W4.layer().children.length, w4base + 1, '越过间隔后跳了一次(定时器路径通了)')
  W4.advance(2000)                     // 累计 4.2s
  eq(W4.layer().children.length, w4base + 2, '每满一个间隔再跳一次')
  W4.advance(3000)
  ok(W4.layer().children.length >= w4base + 3, '是持续输出,不是只跳一次',
    'nodes=' + W4.layer().children.length)
  const w4texts = W4.layer().children.map((n) => n.children[0].textContent)
  eq(w4texts[0], '-¥0.09', '跳的数字 = 上一轮真实金额')

  W4.state.activity = { ok: true, working: false, mainWorking: false, since: null, sessions: 0 }
  await W4.hook.syncActivity()
  eq(W4.hook.getRuntime().working, false, '已退出「工作中」')
  const w4stop = W4.layer().children.length
  W4.advance(10000)
  eq(W4.layer().children.length, w4stop, '停止干活后时间继续走也不再跳')

  section('22g. 持续模式:活动轮询自己也会把 working 拉起来(不依赖 SSE)')
  const E8 = makeEventSourceStub()
  const W5 = makeHarness({ eventSource: E8 })
  W5.state.turn = { ok: true, seq: 2, amount: 0.05, tokens: 1, ts: 1 }
  await flush(); await flush()
  W5.hook.setConfig({ mode: 'working', tickSec: 1 })
  eq(W5.hook.getRuntime().working, false, '一开始没有在干活')
  // 宿主说在干活,但**不推 SSE frame** —— 只靠 3 秒的活动轮询
  W5.state.activity = { ok: true, working: true, mainWorking: true, since: 1, sessions: 1 }
  W5.advance(3100)
  await flush(); await flush()
  eq(W5.hook.getRuntime().working, true, '轮询把 working 拉起来了(SSE 不是必需品)')
  const w5base = W5.layer().children.length
  // 注意窗口要留够:监督器每 500ms 才检查一次,所以"满一个间隔"和"下一次检查"之间
  // 最多再差 500ms —— 只推 1100ms 会正好错过第一个可跳的检查点(这也是虚拟时钟教会我们的事)。
  W5.advance(2100)
  ok(W5.layer().children.length > w5base, '随后就开始按间隔跳了',
    'nodes=' + W5.layer().children.length)

  // ==========================================================================
  // 宿主半区:真实加载 lib/index.js 并跑一遍 apply(),验证路由注册与 SSE 广播。
  // 这是"消耗几毫秒就到"那条链路里**宿主侧**的全部关键行为。
  // ==========================================================================
  section('23. 宿主半区:真实加载 lib/index.js')
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdmg-'))
  process.env.DSH_HOME = tmpHome   // 必须在 import 之前设置:宿主半区在模块顶层读它
  const indexPath = path.resolve(HERE, '..', 'lib', 'index.js')
  const hostPlugin = (await import(pathToFileURL(indexPath).href + '?t=' + Date.now())).default
  eq(hostPlugin.name, 'damage-number', '插件名正确')
  eq(typeof hostPlugin.apply, 'function', '暴露 apply')

  section('24. 宿主半区:路由注册与订阅')
  const routes = []
  const taps = []
  const listeners = {}
  // 可切换的"宿主信任栅栏"替身:enabled 决定它存不存在,fn 决定它对请求返回什么
  const connState = { enabled: true, fn: () => null }
  const fakeCtx = {
    webServer: {
      register(route) { routes.push(route); return () => {} },
      tapIndex(fn) { taps.push(fn); return () => {} },
    },
    get(name) {
      if (name !== 'connection') return undefined
      if (!connState.enabled) return undefined
      return { requestRejection: (req) => connState.fn(req) }
    },
  }
  const fakeRoot = {
    effect(fn) { try { fn() } catch (err) {} return () => {} },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return () => {} },
    inject(services, cb) { cb(fakeCtx) },
  }
  await hostPlugin.apply(fakeRoot)
  const paths = routes.map((r) => r.path).sort()
  eq(JSON.stringify(paths), JSON.stringify([
    '/dsh-dmg/activity.json', '/dsh-dmg/config.json', '/dsh-dmg/events',
    '/dsh-dmg/overlay.js', '/dsh-dmg/panel.js', '/dsh-dmg/status.json',
  ]), 'apply() 注册了全部 6 条路由')
  eq((listeners['session/event'] || []).length, 1, '订阅了 session/event(turn/end 即时推送的来源)')
  eq((listeners['webserver/index-inject'] || []).length, 1, '订阅了 webserver/index-inject(桌面端注入通道)')
  eq(taps.length, 1, '注册了 tapIndex(web 形态注入)')

  section('25. 宿主半区:SSE 连接与 turn/end 广播')
  const eventsRoute = routes.filter((r) => r.path === '/dsh-dmg/events')[0]
  const mkRes = () => ({
    statusCode: 0, headers: null, frames: [], ended: false,
    writeHead(c, h) { this.statusCode = c; this.headers = h },
    write(s) { this.frames.push(String(s)) },
    end() { this.ended = true },
    on() {},
  })
  const sseReq = { method: 'GET', headers: { host: '127.0.0.1:3080' }, on() {} }
  const sse = mkRes()
  await eventsRoute.handler(sseReq, sse)
  eq(sse.statusCode, 200, 'SSE 路由返回 200')
  ok(String(sse.headers['Content-Type']).indexOf('text/event-stream') >= 0, 'Content-Type = text/event-stream')
  ok(sse.frames.join('').indexOf('event: hello') >= 0, '建连先发握手帧')

  const fire = (session, event) => {
    for (const fn of listeners['session/event']) fn(session, event)
  }
  sse.frames.length = 0
  fire({ id: 's1', header: {} }, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
  const frame = sse.frames.join('')
  ok(frame.indexOf('event: turn') >= 0, '主会话 turn/end → 立刻广播 turn 帧')
  ok(frame.indexOf('"isSubagent":false') >= 0, '广播载荷带 isSubagent=false')
  ok(frame.indexOf('"turn":3') >= 0, '广播载荷带轮次号')

  sse.frames.length = 0
  fire({ id: 's2', header: { origin: 'subagent' } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  ok(sse.frames.join('').indexOf('event: turn') >= 0, '默认(不筛会话)时子代理轮次同样广播')
  ok(sse.frames.join('').indexOf('"isSubagent":true') >= 0, '子代理轮次被正确标记')

  fire({ id: 's1', header: {} }, { type: 'assistant/message', data: { turn: 1, usage: { inputTokens: 1 } } })
  eq(sse.frames.join('').split('event: turn').length - 1, 1, '非 turn/end 的事件不广播 turn 帧')
  // ⚠️ 清理:assistant/message 现在会把该会话标记成"在干活"(见 26c),所以这里必须收尾,
  //    否则后面几节会带着一个"永远忙碌"的会话开始,断言全部错位。
  fire({ id: 's1', header: {} }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  sse.frames.length = 0

  section('26. 宿主半区:mainSessionOnly 让子代理不再即时触发')
  const cfgRoute = routes.filter((r) => r.path === '/dsh-dmg/config.json')[0]
  const putBody = JSON.stringify({ mainSessionOnly: true })
  const putRes = mkRes()
  await cfgRoute.handler({
    method: 'PUT',
    headers: { host: '127.0.0.1:3080' },
    on(ev, fn) { if (ev === 'data') fn(Buffer.from(putBody)); if (ev === 'end') fn() },
  }, putRes)
  eq(putRes.statusCode, 200, 'PUT 配置返回 200')
  const saved = JSON.parse(fs.readFileSync(path.join(tmpHome, '.dshdmg.json'), 'utf8'))
  eq(saved.mainSessionOnly, true, '配置已落到 $DSH_HOME/.dshdmg.json')
  eq(saved.minAmount, 0.01, '未提供的键保持默认值')

  sse.frames.length = 0
  fire({ id: 's3', header: { parentSession: 'p' } }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  ok(sse.frames.join('').indexOf('event: turn') < 0, 'mainSessionOnly=true 后子代理轮次不再广播 turn 帧')
  ok(sse.frames.join('').indexOf('event: activity') >= 0,
    '但活动状态帧照常广播(它不受会话过滤影响:子代理在跑也是"在干活")')
  sse.frames.length = 0
  fire({ id: 's4', header: {} }, { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })
  ok(sse.frames.join('').indexOf('event: turn') >= 0, '主会话仍然照常广播')

  section('26b. 宿主半区:活动状态(turn/start → working)')
  const actRoute = routes.filter((r) => r.path === '/dsh-dmg/activity.json')[0]
  const readActivity = async () => {
    const r = mkRes()
    let body = ''
    r.end = (s) => { body = String(s || ''); r.ended = true }
    await actRoute.handler({ method: 'GET', headers: { host: '127.0.0.1:3080' }, on() {} }, r)
    return JSON.parse(body)
  }
  eq((listeners['session/disposed'] || []).length, 1, '订阅了 session/disposed(防止永远卡在"工作中")')
  let act = await readActivity()
  eq(act.ok, true, 'activity.json 可用')
  eq(act.working, false, '初始没有轮次在跑')

  sse.frames.length = 0
  fire({ id: 'm1', header: {} }, { type: 'turn/start', data: { turn: 7 } })
  ok(sse.frames.join('').indexOf('event: activity') >= 0, 'turn/start 立刻推 activity 帧')
  act = await readActivity()
  eq(act.working, true, 'turn/start 后 working=true')
  eq(act.mainWorking, true, '主会话在跑 → mainWorking=true')
  eq(act.sessions, 1, '1 个会话在跑')

  fire({ id: 's1', header: { origin: 'subagent' } }, { type: 'turn/start', data: { turn: 1 } })
  act = await readActivity()
  eq(act.sessions, 2, '子代理也在跑 → 2 个会话')
  eq(act.mainWorking, true, 'mainWorking 仍为 true')

  fire({ id: 'm1', header: {} }, { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
  act = await readActivity()
  eq(act.working, true, '主会话结束了但子代理还在 → working 仍为 true')
  eq(act.mainWorking, false, '主会话已结束 → mainWorking=false(「仅主会话」据此停跳)')

  const disposed = (s) => { for (const fn of listeners['session/disposed']) fn(s) }
  disposed({ id: 's1', header: { origin: 'subagent' } })
  act = await readActivity()
  eq(act.working, false, '会话被销毁也会摘掉,不会永远卡在"工作中"')
  eq(act.sessions, 0, '已清空')

  fire({ id: 'm2', header: {} }, { type: 'turn/start', data: { turn: 1 } })
  fire({ id: 'm2', header: {} }, { type: 'turn/start', data: { turn: 2 } })
  act = await readActivity()
  eq(act.sessions, 1, '同一会话连续 turn/start 不会重复计数')
  fire({ id: 'm2', header: {} }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  act = await readActivity()
  eq(act.working, false, '结束即清零')

  const statusRoute = routes.filter((r) => r.path === '/dsh-dmg/status.json')[0]
  const sr = mkRes()
  let sbody = ''
  sr.end = (s) => { sbody = String(s || '') }
  await statusRoute.handler({ method: 'GET', headers: { host: '127.0.0.1:3080' }, on() {} }, sr)
  const sj = JSON.parse(sbody)
  ok(sj.activity && typeof sj.activity.working === 'boolean', 'status.json 也带上了活动状态')

  section('26c. 宿主半区:没有 turn/start 也能凭其它活动认出"在干活"')
  for (const id of ['m1', 'm2', 's1', 'x1']) {
    fire({ id: id, header: {} }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  }
  act = await readActivity()
  eq(act.working, false, '先清空到"闲着"')

  sse.frames.length = 0
  fire({ id: 'x1', header: {} }, { type: 'step/start', data: { turn: 1 } })   // 刻意不发 turn/start
  act = await readActivity()
  eq(act.working, true, 'step/start 也能把 working 拉起来(不依赖 turn/start)')
  ok(sse.frames.join('').indexOf('event: activity') >= 0, '状态从闲变忙时照常推 activity 帧')

  sse.frames.length = 0
  for (let i = 0; i < 50; i++) {
    fire({ id: 'x1', header: {} }, { type: 'assistant/message', data: { turn: 1, usage: {} } })
  }
  eq(sse.frames.length, 0, '已在"工作中"时后续活动事件一帧都不推(标记幂等,不会打爆 SSE)')
  act = await readActivity()
  eq(act.working, true, '高频活动之后仍然在"工作中"')
  eq(act.sessions, 1, '而且只有一个会话被计入')

  fire({ id: 'x1', header: {} }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  act = await readActivity()
  eq(act.working, false, 'turn/end 负责收尾')

  section('27. 宿主半区:信任栅栏的四种情形(与 dsh-whale-widget 同款语义)')
  // 设计要点:宿主栅栏**可用**时,非回环 Host 交给它判 —— 它才知道 dsh 自己的 --trusted-host
  // 声明了谁;插件只在"确实没有栅栏"时才回落到自己的回环校验(否则会把宿主已信任的权威误拒)。
  const evilReq = { method: 'GET', headers: { host: 'evil.example.com' }, on() {} }
  connState.enabled = true
  connState.fn = () => null
  const f1 = mkRes()
  await eventsRoute.handler(evilReq, f1)
  eq(f1.statusCode, 200, '栅栏可用且放行 → 跟随栅栏(非回环 Host 由它判)')

  connState.fn = () => 401
  const f2 = mkRes()
  await eventsRoute.handler(evilReq, f2)
  eq(f2.statusCode, 401, '栅栏拒绝 → 原样透传它的状态码')
  eq(f2.frames.length, 0, '被拒的请求拿不到任何帧')

  connState.fn = () => { throw new Error('fence boom') }
  const f3 = mkRes()
  await eventsRoute.handler(evilReq, f3)
  eq(f3.statusCode, 403, '栅栏自己抛异常 → fail-closed 按拒绝处理(不静默放行)')

  connState.enabled = false
  const f4 = mkRes()
  await eventsRoute.handler(evilReq, f4)
  eq(f4.statusCode, 403, '栅栏不可用 → 插件自带校验拒绝非回环 Host')

  connState.enabled = true
  connState.fn = () => null
  const f5 = mkRes()
  await eventsRoute.handler({
    method: 'GET', headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }, on() {},
  }, f5)
  eq(f5.statusCode, 403, 'cross-site 标记一律拒(与栅栏无关)')

  const f6 = mkRes()
  await eventsRoute.handler({
    method: 'GET', headers: { host: '127.0.0.1:3080', origin: 'https://evil.example.com' }, on() {},
  }, f6)
  eq(f6.statusCode, 403, 'Origin 与 Host 不同源一律拒(403)')
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch (err) {}

  console.log('\n' + '='.repeat(58))
  if (failures.length === 0) {
    console.log('全部通过: ' + passed + ' 项断言')
    process.exit(0)
  }
  console.log('通过 ' + passed + ' 项,失败 ' + failures.length + ' 项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}

main().catch((err) => {
  console.error('自测台自身异常:', err)
  process.exit(2)
})
