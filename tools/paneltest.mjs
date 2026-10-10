// ============================================================================
// dsh-damage-number —— 设置面板自测台
// ============================================================================
// 覆盖两件最容易悄悄坏掉的事:
//   ① 把「受击提示设置」入口行**插进小鲸鱼面板的正确位置**(它依赖鲸鱼的 DOM 锚点);
//   ② 界面上的「分」与配置里的「元」之间的换算,以及保存时 PUT 出去的载荷。
//
// 跑法:  node tools/paneltest.mjs
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 允许指向别处的 assets —— 用来对"回归用例本身"做反向验证:
// 把修复退回去、确认这套断言真的会失败(runaway),才证明它不是碰巧通过。
const ASSETS = process.env.DSH_DMG_ASSETS
  ? path.resolve(process.env.DSH_DMG_ASSETS)
  : path.resolve(HERE, '..', 'assets')

// ---------------- 断言 ----------------
let passed = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('  \u2713 ' + label); return }
  failures.push(label + (extra ? '  \u2190 ' + extra : ''))
  console.log('  \u2717 ' + label + (extra ? '  \u2190 ' + extra : ''))
}
function eq(a, b, label) { ok(a === b, label, 'got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b)) }
function near(a, b, tol, label) { ok(Math.abs(a - b) <= tol, label, 'got ' + a + ', want ~' + b) }
function section(t) { console.log('\n' + t) }

// ---------------- 极简 DOM 打桩 ----------------
function matchSimple(el, sel) {
  const s = String(sel || '').trim()
  if (!s) return false
  if (s[0] === '#') return el.id === s.slice(1)
  if (s[0] === '.') return String(el.className || '').split(/\s+/).filter(Boolean).indexOf(s.slice(1)) >= 0
  return String(el.tagName || '').toLowerCase() === s.toLowerCase()
}

// ⚠️ 这个桩必须**自带变更派发**,否则 panel.js 会静默走 MutationObserver 的兜底分支,
//    主路径永远测不到 —— 那正是"点开全局设置卡死整个 harness"这条致命 bug 溜过去的原因。
//    makeEl 的每次 childList 变更都会通知派发器;派发器用**有上限**的循环模拟"回调又产生变更",
//    超限即判定为失控(runaway),把"卡死"变成可断言的失败。
function makeEl(tag, notify) {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: '', className: '', innerHTML: '', title: '',
    type: '', value: '', checked: false, disabled: false,
    min: '', max: '', step: '',
    children: [], parentNode: null, __attrs: {}, __listeners: {}, __text: '',
    style: { cssText: '', zIndex: '', setProperty() {} },
    setAttribute(k, v) { el.__attrs[k] = String(v) },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el.__attrs, k) ? el.__attrs[k] : null },
    appendChild(c) {
      c.parentNode = el
      el.children.push(c)
      if (notify) notify({ target: el, addedNodes: [c], removedNodes: [] })
      return c
    },
    insertBefore(c, ref) {
      c.parentNode = el
      const i = el.children.indexOf(ref)
      if (i < 0) el.children.push(c)
      else el.children.splice(i, 0, c)
      if (notify) notify({ target: el, addedNodes: [c], removedNodes: [] })
      return c
    },
    removeChild(c) {
      const i = el.children.indexOf(c)
      if (i >= 0) el.children.splice(i, 1)
      c.parentNode = null
      if (notify) notify({ target: el, addedNodes: [], removedNodes: [c] })
      return c
    },
    addEventListener(type, fn) { (el.__listeners[type] = el.__listeners[type] || []).push(fn) },
    removeEventListener() {},
    __fire(type, evt) {
      const list = el.__listeners[type] || []
      for (const fn of list) fn(Object.assign({ target: el, stopPropagation() {} }, evt || {}))
    },
    querySelectorAll(sel) {
      const out = []
      const walk = (n) => {
        for (const c of n.children) {
          if (matchSimple(c, sel)) out.push(c)
          walk(c)
        }
      }
      walk(el)
      return out
    },
    querySelector(sel) { const r = el.querySelectorAll(sel); return r.length ? r[0] : null },
  }
  // 真实 DOM:给 textContent 赋值会先清空子节点再插一个文本节点 ——
  // 即使内容与原来**完全相同**,它依然是一次 childList 变更。这条语义必须忠实,否则测不出风暴。
  Object.defineProperty(el, 'textContent', {
    get() { return el.__text },
    set(v) {
      const s = String(v == null ? '' : v)
      const removed = el.children.slice()
      for (const c of removed) c.parentNode = null
      el.children.length = 0
      el.__text = s
      if (notify) notify({ target: el, addedNodes: [], removedNodes: removed })
    },
  })
  return el
}

function allText(el) {
  let s = String(el.textContent || '')
  for (const c of el.children) s += ' ' + allText(c)
  return s
}

function makeSandbox(opts) {
  opts = opts || {}
  const storageMap = new Map()
  const storage = {
    getItem(k) { return storageMap.has(k) ? storageMap.get(k) : null },
    setItem(k, v) { storageMap.set(k, String(v)) },
    removeItem(k) { storageMap.delete(k) },
  }

  // ---- 变更派发 + 有上限的"微任务/帧"排空 ----
  // runaway=true 就代表真实浏览器里的那种**微任务风暴**(主线程被占死、整个页面卡住)。
  const mo = { observers: [], queue: [], pending: false, delivering: false, runaway: false, MAX: 400, deliveries: 0 }
  const raf = { queue: [], draining: false, runaway: false, MAX: 400, runs: 0 }
  let bodyRef = null
  function inDoc(n) {
    let p = n
    while (p) { if (p === bodyRef) return true; p = p.parentNode }
    return false
  }
  function notifyMutation(rec) {
    if (!mo.observers.length) return
    if (!rec || !inDoc(rec.target)) return   // 忠实于"只观察被观察子树":游离节点上的变更不算
    mo.queue.push(rec)
    mo.pending = true
    if (mo.delivering) return
    mo.delivering = true
    let guard = 0
    while (mo.pending && guard < mo.MAX) {
      guard++
      mo.pending = false
      const recs = mo.queue.slice()
      mo.queue.length = 0
      for (const o of mo.observers) {
        if (o.disconnected) continue
        try { o.cb(recs) } catch (err) {}
      }
      mo.deliveries++
    }
    mo.delivering = false
    if (guard >= mo.MAX) mo.runaway = true
  }
  function MutationObserverStub(cb) {
    const inst = {
      cb, disconnected: false, observing: false,
      observe() { inst.observing = true },
      disconnect() { inst.disconnected = true },
      takeRecords() { return [] },
    }
    mo.observers.push(inst)
    return inst
  }
  function rafStub(fn) {
    raf.queue.push(fn)
    if (raf.draining) return 1
    raf.draining = true
    let guard = 0
    while (raf.queue.length && guard < raf.MAX) {
      guard++
      const f = raf.queue.shift()
      try { f() } catch (err) {}
      raf.runs++
    }
    raf.draining = false
    if (guard >= raf.MAX) raf.runaway = true
    return 1
  }

  const body = makeEl('body', notifyMutation)
  bodyRef = body
  const document = {
    readyState: 'complete',
    body,
    documentElement: body,
    createElement: (t) => makeEl(t, notifyMutation),
    createElementNS: (ns, t) => makeEl(t, notifyMutation),
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
      return walk(body)
    },
    querySelector(sel) { return body.querySelector(sel) },
    querySelectorAll(sel) { return body.querySelectorAll(sel) },
  }

  const net = { puts: [], cfg: opts.cfg || null, turn: { ok: true, seq: 1, amount: 0.05, tokens: 1, ts: 1 }, stripKeys: null }
  const registered = []

  const win = {
    innerWidth: 1200, innerHeight: 800,
    localStorage: storage,
    MutationObserver: MutationObserverStub,
    requestAnimationFrame: rafStub,
    dshwRegisterMask(el) { registered.push(el); return function () {} },
    getComputedStyle(el) { return { zIndex: (el && el.style && el.style.zIndex) || 'auto' } },
  }

  // ---- 虚拟时钟 ----
  // 专门为了验证「panel.js 等不到 overlay 时会不会放弃」:旧实现等 10 秒就 return,
  // 面板从此永久失效且一声不吭。有了可控时钟,测试可以把时间推过那个点再看它还认不认。
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
      if (guard++ > 50000) throw new Error('虚拟时钟:定时器疑似自激')
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
    document, window: win, localStorage: storage, console, __clock: clock,
    setInterval(fn, ms) { return setTimer(fn, ms, true) },
    setTimeout(fn, ms) { return setTimer(fn, ms, false) },
    clearInterval(id) { clock.timers.delete(id) },
    clearTimeout(id) { clock.timers.delete(id) },
    fetch: async (url, o) => {
      const u = String(url)
      const method = (o && o.method) || 'GET'
      if (u.indexOf('/dsh-whale/last-turn.json') >= 0) {
        return { ok: true, status: 200, json: async () => net.turn }
      }
      if (u.indexOf('/dsh-dmg/config.json') >= 0) {
        if (method === 'PUT') {
          let body = null
          try { body = JSON.parse(o.body) } catch (err) {}
          net.puts.push(body)
          let stored = body
          if (net.stripKeys && net.stripKeys.length) {   // 模拟旧宿主静默丢掉不认识的键
            stored = Object.assign({}, body)
            for (const k of net.stripKeys) delete stored[k]
          }
          net.cfg = stored
          return { ok: true, status: 200, json: async () => ({ ok: true, config: stored, file: 'x' }) }
        }
        return { ok: true, status: 200, json: async () => net.cfg }
      }
      return { ok: false, status: 404, json: async () => null }
    },
  }

  const ctx = vm.createContext(sandbox)
  vm.runInContext('Date.now = function () { return globalThis.__clock.now }', ctx)
  vm.runInContext('Math.random = function(){ return 0.5 }', ctx)

  return { sandbox, ctx, document, body, win, net, registered, storage, mo, raf, advance }
}

// 造一个"小鲸鱼提示与音效设置面板"的样子
function makeWhalePanel(body) {
  const mask = makeEl('div'); mask.className = 'dshwv-bubmask'
  mask.style.zIndex = '30000'
  const card = makeEl('div'); card.className = 'dshwv-bubcard'
  const title = makeEl('div'); title.className = 'dshwv-bubtitle'; title.textContent = '提示与音效设置'
  card.appendChild(title)
  for (const t of ['按压音效', '每轮消耗提示', '提问提示', '授权提示']) {
    const e = makeEl('div'); e.className = 'dshwv-fold'; e.textContent = t
    card.appendChild(e)
  }
  const btns = makeEl('div'); btns.className = 'dshwv-bubbtns'
  card.appendChild(btns)
  mask.appendChild(card)
  body.appendChild(mask)
  return { mask, card, title, btns }
}

function loadAssets(S) {
  vm.runInContext(fs.readFileSync(path.join(ASSETS, 'overlay.js'), 'utf8'), S.ctx, { filename: 'overlay.js' })
  vm.runInContext(fs.readFileSync(path.join(ASSETS, 'panel.js'), 'utf8'), S.ctx, { filename: 'panel.js' })
}

const flush = () => new Promise((r) => setTimeout(r, 0))

// ============================================================================
async function main() {
  console.log('dsh-damage-number panel self-test')

  section('1. 面板加载与钩子')
  const S = makeSandbox()
  const whale = makeWhalePanel(S.body)   // 鲸鱼面板先存在,再看我们能不能挂上去
  loadAssets(S)
  await flush()
  const hook = S.win.__dshDmgNumber
  ok(!!hook, 'overlay.js 暴露了 window.__dshDmgNumber')
  ok(typeof hook.openPanel === 'function', 'panel.js 挂上了 hook.openPanel')
  ok(!!hook.panel, 'panel.js 暴露了 hook.panel 调试面')

  section('2. 入口行注入到鲸鱼面板')
  const entry = whale.card.querySelector('#dsh-dmg-entry')
  ok(!!entry, '入口行已插入鲸鱼面板')
  const wrap = entry && entry.parentNode
  const iWrap = whale.card.children.indexOf(wrap)
  const iBtns = whale.card.children.indexOf(whale.btns)
  ok(iWrap >= 0 && iBtns >= 0 && iWrap === iBtns - 1,
    '入口行插在「取消/恢复默认/保存」那一行之前', 'wrap@' + iWrap + ' btns@' + iBtns)
  eq(entry.__summary.textContent, '1 分–10 分 · 25%→100%', '入口行摘要 = 当前区间与概率')
  eq(entry.__check.checked, true, '入口行勾选框 = 总开关(默认开)')
  ok(allText(entry).indexOf('受击提示设置') >= 0, '入口行显示「受击提示设置」')

  section('3. 单位换算(分 ↔ 元)')
  const P = hook.panel
  eq(P.fenOf(0.01), 1, '0.01 元 = 1 分')
  eq(P.fenOf(0.1), 10, '0.1 元 = 10 分')
  eq(P.fenOf(0.055), 5.5, '0.055 元 = 5.5 分')
  eq(P.yuanOf(2), 0.02, '2 分 = 0.02 元')
  eq(P.yuanOf(5.5), 0.055, '5.5 分 = 0.055 元')
  near(P.yuanOf(P.fenOf(0.077)), 0.077, 1e-9, '元 → 分 → 元 往返无损')
  eq(P.fenText(0.01), '1 分', 'fenText(0.01)')

  section('4. 概率公式')
  eq(P.probAt(0.005, 0.01, 0.1, 0.25), 0, '低于下限 → 0')
  near(P.probAt(0.01, 0.01, 0.1, 0.25), 0.25, 1e-9, '下限处 → minProbability')
  near(P.probAt(0.055, 0.01, 0.1, 0.25), 0.625, 1e-9, '中点 → 0.625')
  eq(P.probAt(0.1, 0.01, 0.1, 0.25), 1, '达到上限 → 1')
  eq(P.probAt(9, 0.01, 0.1, 0.25), 1, '超过上限 → 1')
  eq(P.probAt(0.05, 0.05, 0.05, 0), 1, '上下限相等(纯阈值)→ 达到即 1')
  eq(P.probAt(0.04, 0.05, 0.05, 0), 0, '纯阈值模式下差一点 → 0')
  eq(P.curvePoints, undefined, '概率曲线的采样函数已随界面一起删掉(不留死代码)')

  section('5. 摘要文本')
  eq(P.summaryText({ enabled: false }), '已关闭', '关闭时摘要显示「已关闭」')
  eq(P.summaryText({ enabled: true, minAmount: 0.02, maxAmount: 0.2, minProbability: 0.5 }),
    '2 分–20 分 · 50%→100%', '自定义配置的摘要')

  section('6. 保存载荷换算与夹取(只产出界面暴露的键)')
  const patch = P.buildPatch({
    enabled: true, mode: 'working', tickSec: 7, minFen: 2, maxFen: 20, minPct: 50,
    riseMs: 1800, jitterPct: 18,
    // 下面这些界面上已经没有控件了,故意一起传进来,验证它们不会被写进补丁
    pushEnabled: false, mainSessionOnly: true, pollMs: 10, prefix: 'X', decimals: 5,
    color: '#000000', strokeColor: '#111111', strokeWidth: 9, fontSizePx: 99,
    risePx: 5, maxStack: 19,
  })
  eq(patch.minAmount, 0.02, '下限 2 分 → minAmount 0.02 元')
  eq(patch.maxAmount, 0.2, '上限 20 分 → maxAmount 0.2 元')
  eq(patch.minProbability, 0.5, '50% → minProbability 0.5')
  eq(patch.mode, 'working', '模式原样带上')
  eq(patch.tickSec, 7, '间隔原样带上')
  eq(patch.jitterX, 0.18, '界面填 18% → jitterX 0.18')
  eq(patch.riseMs, 1800, '显示时长原样带上')
  ok(!('pollMs' in patch) && !('prefix' in patch) && !('maxStack' in patch),
    '界面之外的键一律不进补丁(否则会把用户手改的配置冲掉)')
  eq(Object.keys(patch).length, 8, '补丁恰好只有这 8 个键', Object.keys(patch).join(','))
  eq(P.buildPatch({ jitterPct: 100 }).jitterX, 1, '横向偏移 100% → jitterX 1')
  eq(P.buildPatch({ mode: '乱填' }).mode, 'turnEnd', '非法模式回落到 turnEnd')
  eq(P.buildPatch({ tickSec: 99999 }).tickSec, 3600, '间隔超上限被夹到 3600s')
  eq(P.buildPatch({ tickSec: 0 }).tickSec, 5, '间隔填 0 → 回落默认 5s')
  eq(P.buildPatch({ riseMs: 100 }).riseMs, 200, '显示时长低于下限被夹到 200ms')
  eq(P.buildPatch({ minPct: 300 }).minProbability, 1, '概率 >100% 被夹到 1')

  section('7. 打开设置卡片')
  hook.panel.open()
  ok(hook.panel.isOpen(), '卡片已打开')
  const myMask = S.body.querySelectorAll('.dshwv-bubmask').filter((m) => m.getAttribute('data-dsh-dmg'))[0]
  ok(!!myMask, '卡片遮罩带 data-dsh-dmg 标记(便于与鲸鱼的面板区分)')
  ok(S.registered.indexOf(myMask) >= 0, '已用 window.dshwRegisterMask 登记层级')
  ok(parseInt(myMask.style.zIndex, 10) > 30000,
    '层级严格高于鲸鱼面板(30000),卡片不会被它盖住', myMask.style.zIndex)
  const myCard = myMask.querySelector('.dshwv-bubcard')
  ok(!!myCard, '卡片本体存在')
  ok(allText(myCard).indexOf('受击提示设置') >= 0, '卡片标题正确')

  const numInputs = myCard.querySelectorAll('input').filter((i) => i.type === 'number')
  eq(numInputs[0].value, '1', '下限输入框预填 1 分')
  eq(numInputs[1].value, '10', '上限输入框预填 10 分')
  eq(numInputs[2].value, '25', '概率输入框预填 25%')

  section('7b. 界面瘦身:只留 6 个数字框 + 1 个下拉 + 4 个按钮')
  // ⚠️ 这一节是"反向守卫":它钉住的是**不该出现在界面里的东西**。
  // 以后想加回某个控件,必须先想清楚是不是又把它塞回面板了。
  eq(numInputs.length, 6, '数字输入框恰好 6 个(区间2 + 概率 + 间隔 + 时长 + 偏移)')
  eq(numInputs[3].value, '5', '间隔预填 5 秒')
  eq(numInputs[3].disabled, true, '「每轮结束时」模式下间隔不可用')
  eq(numInputs[4].value, '1800', '显示时长预填 1800ms')
  eq(numInputs[5].value, '18', '横向偏移按百分比展示(默认 18%)')

  const sels = myCard.querySelectorAll('select')
  eq(sels.length, 1, '只有 1 个下拉(模式)')
  eq(sels[0].children.length, 2, '模式有两个选项')
  eq(sels[0].value, 'turnEnd', '默认「每轮结束时」')

  const allBtns = myCard.querySelectorAll('button')
  eq(allBtns.length, 4, '按钮恰好 4 个(预览 / 取消 / 恢复默认 / 保存)', allBtns.map((b) => b.textContent).join('/'))

  eq(myCard.querySelectorAll('svg').length, 0, '概率曲线已移出界面')
  eq(myCard.querySelectorAll('input').filter((i) => i.type === 'color').length, 0, '取色控件已移出界面')
  eq(myCard.querySelectorAll('input').filter((i) => i.type === 'text').length, 0, '文本输入已移出界面')
  eq(myCard.querySelectorAll('div').filter((d) => d.style && d.style.display === 'none'
    && d.querySelectorAll('input').length > 0).length, 0, '没有"默认折起"的分组了(内容直接拿掉,不是藏起来)')
  ok(allText(myCard).indexOf('高级') < 0, '不再有「高级」折叠区')
  ok(allText(myCard).indexOf('触发通道') < 0, '「触发通道」已移出界面')
  ok(allText(myCard).indexOf('描边') < 0, '描边设置已移出界面')
  ok(allText(myCard).indexOf('试算') < 0, '试算已移出界面')
  ok(allText(myCard).indexOf('每轮结束时按区间概率跳一次') >= 0, '保留了当前模式的规则说明')

  // 切换模式:说明文字与间隔可用性都要跟着变
  sels[0].value = 'working'
  sels[0].__fire('change')
  eq(numInputs[3].disabled, false, '切到持续模式后间隔可用了')
  ok(allText(myCard).indexOf('干活期间每 5 秒跳一次') >= 0, '说明文字切换成持续模式的规则')
  ok(allText(myCard).indexOf('本轮到目前为止的真实花费') >= 0,
    '并且明说持续模式跳的是"本轮目前为止的真实花费"(不是重复上一轮那个数)')

  section('8. 预览按钮不花钱')
  const before = hook.getRuntime().onScreen
  const previewBtns = myCard.querySelectorAll('button').filter((b) => String(b.textContent).indexOf('预览') === 0)
  eq(previewBtns.length, 1, '只剩 1 个预览按钮')
  previewBtns[0].__fire('click')
  eq(hook.getRuntime().onScreen, before + 1, '点「预览一下」后就地飘出一个数字(未发任何请求)')
  eq(S.net.puts.length, 0, '预览不产生任何写请求')

  section('10. 保存:PUT 载荷正确 + 入口行摘要刷新')
  const okBtn = myCard.querySelectorAll('button').filter((b) => String(b.textContent) === '保存')[0]
  ok(!!okBtn, '找到「保存」按钮')
  numInputs[0].value = '2'       // 下限改成 2 分
  numInputs[2].value = '40'      // 概率改成 40%
  okBtn.__fire('click')
  await flush(); await flush()
  eq(S.net.puts.length, 1, '保存发出了 1 个 PUT')
  eq(S.net.puts[0].minAmount, 0.02, 'PUT 载荷:下限 = 0.02 元')
  eq(S.net.puts[0].minProbability, 0.4, 'PUT 载荷:概率 = 0.4')
  eq(S.net.puts[0].enabled, true, 'PUT 载荷:开关保留')
  eq(S.net.puts[0].mode, 'working', 'PUT 载荷:模式带上了刚才选的持续模式')
  ok(S.net.puts[0].pushEnabled === true && S.net.puts[0].pollMs === 2000,
    '界面外的键由现有配置兜底,原样保留(不会被这次保存清掉)')
  eq(hook.getConfig().minAmount, 0.02, '保存成功后本地配置立即生效')
  eq(hook.getConfig().mode, 'working', '本地配置的模式也立刻生效')
  eq(entry.__summary.textContent, '2 分–10 分 · 40%→100%', '入口行摘要跟着刷新')
  ok(!hook.panel.isOpen(), '保存成功后卡片自动关闭')

  section('10b. 间隔的夹取是端到端生效的(界面 → 载荷 → 运行时)')
  hook.panel.open()
  const card2 = S.body.querySelectorAll('.dshwv-bubmask')
    .filter((m) => m.getAttribute('data-dsh-dmg'))[0].querySelector('.dshwv-bubcard')
  const ni2 = card2.querySelectorAll('input').filter((i) => i.type === 'number')
  eq(ni2.length, 6, '数字控件仍然是 6 个')
  ni2[3].value = '0.1'           // 间隔填到下限以下
  card2.querySelectorAll('button').filter((b) => String(b.textContent) === '保存')[0].__fire('click')
  await flush(); await flush()
  eq(S.net.puts.length, 2, '第二次保存发出了 PUT')
  eq(S.net.puts[1].tickSec, 0.5, '界面填 0.1 秒 → 载荷被夹到 0.5 秒')
  eq(hook.getConfig().tickSec, 0.5, '夹取结果真的落到了本地配置上')
  ok(!hook.panel.isOpen(), '第二次保存后卡片也关闭了')

  section('10c. 宿主把键丢掉时,面板要明说"重启客户端"而不是静默成功')
  hook.panel.open()
  const card3 = S.body.querySelectorAll('.dshwv-bubmask')
    .filter((m) => m.getAttribute('data-dsh-dmg'))[0].querySelector('.dshwv-bubcard')
  S.net.stripKeys = ['mode', 'tickSec']   // 模拟旧宿主
  const mode3 = card3.querySelectorAll('select')[0]
  mode3.value = 'working'
  mode3.__fire('change')
  card3.querySelectorAll('button').filter((b) => String(b.textContent) === '保存')[0].__fire('click')
  await flush(); await flush()
  const msg3 = allText(card3)
  ok(msg3.indexOf('宿主没接受这些键') >= 0, '明确说出宿主没接受键')
  ok(msg3.indexOf('mode') >= 0 && msg3.indexOf('tickSec') >= 0, '点名具体是哪些键')
  ok(msg3.indexOf('重启') >= 0, '给出可操作的指引:重启客户端')
  ok(msg3.indexOf('局域网') < 0, '不会把"版本不匹配"误报成"回环/权限"问题')
  ok(hook.panel.isOpen(), '保存失败时卡片保持打开,方便改回去')
  S.net.stripKeys = null
  hook.panel.close()

  section('11. 入口行勾选框 = 总开关(立即保存)')
  entry.__check.checked = false
  entry.__check.__fire('change')
  await flush(); await flush()
  eq(S.net.puts.length, 4, '勾选框变化触发了 1 个 PUT(前 3 个来自 10/10b/10c)')
  eq(S.net.puts[3].enabled, false, 'PUT 载荷:enabled = false')
  eq(entry.__summary.textContent, '已关闭', '入口行摘要立即显示「已关闭」')

  section('12. 鲸鱼面板不存在时不崩、且可手动补挂')
  const S2 = makeSandbox()
  loadAssets(S2)
  await flush()
  const hook2 = S2.win.__dshDmgNumber
  ok(!!hook2.panel, '没有鲸鱼面板时 panel.js 依然正常加载')
  eq(hook2.panel.entry(), null, '此时没有入口行(但不报错)')
  const whale2 = makeWhalePanel(S2.body)      // 面板后出现
  hook2.panel.tryInject()                     // MutationObserver 在真实浏览器里会自动做这件事
  const entry2 = whale2.card.querySelector('#dsh-dmg-entry')
  ok(!!entry2, '面板后出现时能补挂入口行')
  ok(hook2.panel.open() && hook2.panel.isOpen(), '没有鲸鱼面板时也能直接 openPanel()')

  section('13. 鲸鱼把面板抬得更高时我们跟着抬(不被盖住)')
  hook2.panel.close()
  whale2.mask.style.zIndex = '40000'
  hook2.panel.open()
  const m2 = S2.body.querySelectorAll('.dshwv-bubmask').filter((m) => m.getAttribute('data-dsh-dmg'))[0]
  eq(m2.style.zIndex, '40050', '鲸鱼面板 40000 → 我们自动跟到 40050')
  hook2.panel.close()

  // ==========================================================================
  // 关键回归:致命 bug —— "点开全局设置整个 harness 卡死"
  // 根因:MutationObserver 回调里 `el.textContent = x` 即使内容不变也永远是一次 childList 变更,
  //       于是 回调 → 写 DOM → 再派发 → 回调 … 微任务队列永远排不空,主线程被占死。
  // 这里用真实派发 + 有上限的排空来复现那种"风暴",失控会被标成 runaway。
  // ==========================================================================
  section('14. 关键回归:observer 回调绝不能自激成微任务风暴')
  const S5 = makeSandbox()
  loadAssets(S5)                      // 先加载,此时还没有鲸鱼面板
  await flush()
  const hook5 = S5.win.__dshDmgNumber
  ok(!S5.mo.runaway && !S5.raf.runaway, '无面板时一切平静')

  const whale5 = makeWhalePanel(S5.body)   // ← 等价于用户点开「全局设置」的那一刻
  eq(!!whale5.card.querySelector('#dsh-dmg-entry'), true, '面板出现后入口行被注入')
  ok(!S5.mo.runaway, '注入过程没有把 observer 打成一团(runaway 必须为 false)')
  ok(!S5.raf.runaway, 'rAF 合并没有失控')

  // 页面持续活动:200 次普通 DOM 变更。旧实现会在这里被反复点燃。
  const scansBefore = hook5.panel.scanCount()
  for (let i = 0; i < 200; i++) {
    const d = S5.document.createElement('div')
    d.textContent = 'churn ' + i
    S5.body.appendChild(d)
  }
  ok(!S5.mo.runaway && !S5.raf.runaway, '200 次普通 DOM 变更后依然没有自激')
  ok(hook5.panel.scanCount() - scansBefore < 60,
    '扫描次数被变更过滤 + rAF 合并压住(而不是每次变更都全量扫一遍)',
    'scans=' + (hook5.panel.scanCount() - scansBefore))

  // 反向验证:守卫只能拦"没变"的写入,不能把该更新的也拦掉
  const entry5 = hook5.panel.entry()
  hook5.setConfig({ enabled: false, minAmount: 0.02, maxAmount: 0.2, minProbability: 0.5 })
  await flush()
  eq(entry5.__summary.textContent, '已关闭', '配置真的变了 → 入口行摘要照常更新(守卫没拦错东西)')
  hook5.setConfig({ enabled: true })
  await flush()
  eq(entry5.__summary.textContent, '2 分–20 分 · 50%→100%', '再次变化也照常更新')
  ok(!S5.mo.runaway, '这些更新全程没有引发风暴')

  section('15. 卡片不会自己关掉自己')
  const S6 = makeSandbox()
  loadAssets(S6)                      // 这里**不建**鲸鱼面板
  await flush()
  const hook6 = S6.win.__dshDmgNumber
  hook6.panel.open()
  ok(hook6.panel.isOpen(), '没有鲸鱼面板时也能打开卡片')
  const junk = S6.document.createElement('div')
  junk.textContent = 'later mutation'
  S6.body.appendChild(junk)
  ok(hook6.panel.isOpen(), '随后的普通 DOM 变更不该把卡片自动关掉(判据是"面板曾经出现过")')
  S6.panel = hook6.panel

  // ==========================================================================
  // 关键回归:等不到 overlay 时**绝不放弃**。
  // 旧实现是 `if (tries > 200) return` —— 10 秒后永久放弃,而且一声不吭。
  // 后果正是用户遇到的那两个症状同时出现:①「找不到入口行」进不去设置;
  // ② overlay 没跑起来 ⇒ 持续模式当然也不会跳。这类"静默死掉"必须被测试钉住。
  // ==========================================================================
  section('16. 关键回归:overlay 迟到时 panel 绝不永久放弃')
  const S7 = makeSandbox()
  // 只加载 panel.js —— 模拟 overlay.js 慢一步(或压根没加载成功)
  vm.runInContext(fs.readFileSync(path.join(ASSETS, 'panel.js'), 'utf8'), S7.ctx, { filename: 'panel.js' })
  S7.advance(60000)   // 把时间推过旧的 10 秒放弃点
  eq(S7.win.__dshDmgNumber, undefined, '此时确实还没有 overlay 的钩子')
  eq(S7.win.__dshDmgPanelLoaded, true, 'panel.js 自己已经加载了')

  // overlay 迟到了 60 秒才出现
  vm.runInContext(fs.readFileSync(path.join(ASSETS, 'overlay.js'), 'utf8'), S7.ctx, { filename: 'overlay.js' })
  await flush()
  S7.advance(4000)    // 让 panel.js 的下一次重试跑到(此时重试间隔已放慢到 2 秒)
  await flush()
  const whale7 = makeWhalePanel(S7.body)
  S7.advance(4000)
  await flush()
  ok(!!whale7.card.querySelector('#dsh-dmg-entry'),
    '迟到的 overlay 依然让入口行挂上了(旧实现在这里会永久失效)')

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
  console.error('面板测试台自身异常:', err)
  process.exit(2)
})
