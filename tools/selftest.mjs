// ============================================================================
// dsh-damage-number —— 自测台
// ============================================================================
// 不是"复制一份逻辑再测":这里用 node:vm + DOM 打桩**真实执行** assets/overlay.js,
// 所以验证的就是将来跑在浏览器里的那份代码。
//
// 跑法:  node tools/selftest.mjs
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

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

function makeHarness(opts) {
  const storage = (opts && opts.storage) || makeStorage()
  const state = {
    turn: { ok: true, seq: 0, amount: null, tokens: null, ts: null },
    turnFail: false,
    cfg: null,
    cfgFail: false,
    whalePresent: true,
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

  const sandbox = {
    document,
    window: { innerWidth: 1200, innerHeight: 800, localStorage: storage },
    localStorage: storage,
    console,
    fetch: async (url) => {
      const u = String(url)
      if (u.indexOf('/dsh-whale/last-turn.json') >= 0) {
        if (state.turnFail) return { ok: false, status: 500, json: async () => null }
        return { ok: true, status: 200, json: async () => state.turn }
      }
      if (u.indexOf('/dsh-dmg/config.json') >= 0) {
        if (state.cfgFail) return { ok: false, status: 404, json: async () => null }
        return { ok: true, status: 200, json: async () => state.cfg }
      }
      return { ok: false, status: 404, json: async () => null }
    },
    setInterval(fn, ms) { return 1 },
    setTimeout(fn, ms) { return 1 },
  }

  const ctx = vm.createContext(sandbox)
  vm.runInContext('globalThis.__randQueue = []; Math.random = function () {'
    + ' return globalThis.__randQueue.length ? globalThis.__randQueue.shift() : 0.5; };', ctx)
  // 拿到上下文里那个数组的**真实引用**,避免跨 realm 属性同步的不确定性
  const randQueue = vm.runInContext('globalThis.__randQueue', ctx)
  const setRand = (v) => { randQueue.length = 0; randQueue.push(v) }

  vm.runInContext(fs.readFileSync(OVERLAY, 'utf8'), ctx, { filename: 'overlay.js' })

  return {
    state, sandbox, ctx, body, whaleImg, setRand, storage,
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
  eq(anim.frames.length, 4, '4 段关键帧(弹出 → 过冲 → 落定 → 上浮淡出)')
  eq(anim.frames[0].opacity, 0, '起始透明')
  eq(anim.frames[1].opacity, 1, '过冲帧已不透明')
  ok(String(anim.frames[1].transform).indexOf('scale(1.28)') >= 0, '过冲缩放 1.28(弹出感)')
  eq(anim.frames[3].opacity, 0, '末帧淡出为 0')
  ok(String(anim.frames[3].transform).indexOf('translateY(-96.0px)') >= 0, '末帧上浮 96px')
  ok(String(anim.frames[3].transform).indexOf('%') < 0, '关键帧只用 px(不与百分比混插)')
  eq(anim.timing.duration, 1200, '时长 1200ms')
  eq(anim.timing.fill, 'forwards', 'fill:forwards')

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
