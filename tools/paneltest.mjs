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
const ASSETS = path.resolve(HERE, '..', 'assets')

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

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: '', className: '', textContent: '', innerHTML: '', title: '',
    type: '', value: '', checked: false, disabled: false,
    min: '', max: '', step: '',
    children: [], parentNode: null, __attrs: {}, __listeners: {},
    style: { cssText: '', zIndex: '', setProperty() {} },
    setAttribute(k, v) { el.__attrs[k] = String(v) },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el.__attrs, k) ? el.__attrs[k] : null },
    appendChild(c) { c.parentNode = el; el.children.push(c); return c },
    insertBefore(c, ref) {
      c.parentNode = el
      const i = el.children.indexOf(ref)
      if (i < 0) el.children.push(c)
      else el.children.splice(i, 0, c)
      return c
    },
    removeChild(c) {
      const i = el.children.indexOf(c)
      if (i >= 0) el.children.splice(i, 1)
      c.parentNode = null
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
  const body = makeEl('body')
  const document = {
    readyState: 'complete',
    body,
    documentElement: body,
    createElement: (t) => makeEl(t),
    createElementNS: (ns, t) => makeEl(t),
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

  const net = { puts: [], cfg: opts.cfg || null, turn: { ok: true, seq: 1, amount: 0.05, tokens: 1, ts: 1 } }
  const registered = []

  const win = {
    innerWidth: 1200, innerHeight: 800,
    localStorage: storage,
    dshwRegisterMask(el) { registered.push(el); return function () {} },
    getComputedStyle(el) { return { zIndex: (el && el.style && el.style.zIndex) || 'auto' } },
  }

  const sandbox = {
    document, window: win, localStorage: storage, console,
    setInterval() { return 1 }, setTimeout() { return 1 }, clearInterval() {},
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
          net.cfg = body
          return { ok: true, status: 200, json: async () => ({ ok: true, config: body, file: 'x' }) }
        }
        return { ok: true, status: 200, json: async () => net.cfg }
      }
      return { ok: false, status: 404, json: async () => null }
    },
  }

  const ctx = vm.createContext(sandbox)
  vm.runInContext('Math.random = function(){ return 0.5 }', ctx)

  return { sandbox, ctx, document, body, win, net, registered, storage }
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

  section('4. 概率公式与曲线')
  eq(P.probAt(0.005, 0.01, 0.1, 0.25), 0, '低于下限 → 0')
  near(P.probAt(0.01, 0.01, 0.1, 0.25), 0.25, 1e-9, '下限处 → minProbability')
  near(P.probAt(0.055, 0.01, 0.1, 0.25), 0.625, 1e-9, '中点 → 0.625')
  eq(P.probAt(0.1, 0.01, 0.1, 0.25), 1, '达到上限 → 1')
  eq(P.probAt(9, 0.01, 0.1, 0.25), 1, '超过上限 → 1')
  eq(P.probAt(0.05, 0.05, 0.05, 0), 1, '上下限相等(纯阈值)→ 达到即 1')
  eq(P.probAt(0.04, 0.05, 0.05, 0), 0, '纯阈值模式下差一点 → 0')
  const pts = P.curvePoints(0.01, 0.1, 0.25, 24)
  eq(pts.length, 25, '曲线采样 25 个点')
  near(pts[0].p, 0.25, 1e-9, '曲线起点 = 下限处概率')
  eq(pts[pts.length - 1].p, 1, '曲线终点 = 100%')
  let mono = true
  for (let i = 1; i < pts.length; i++) if (pts[i].p < pts[i - 1].p - 1e-12) mono = false
  ok(mono, '曲线单调不减')
  eq(P.curvePoints(0.05, 0.05, 0).length, 3, '阈值模式曲线退化为 3 点折线')

  section('5. 摘要文本')
  eq(P.summaryText({ enabled: false }), '已关闭', '关闭时摘要显示「已关闭」')
  eq(P.summaryText({ enabled: true, minAmount: 0.02, maxAmount: 0.2, minProbability: 0.5 }),
    '2 分–20 分 · 50%→100%', '自定义配置的摘要')

  section('6. 保存载荷换算与夹取')
  const patch = P.buildPatch({
    enabled: true, minFen: 2, maxFen: 20, minPct: 50,
    pushEnabled: true, mainSessionOnly: false, pollMs: 10,
    prefix: '-¥', decimals: 2, color: '#ff3b30', strokeColor: '#ffffff', strokeWidth: 3,
    fontSizePx: 30, risePx: 96, riseMs: 1200, jitterX: 0.18, maxStack: 6,
  })
  eq(patch.minAmount, 0.02, '下限 2 分 → minAmount 0.02 元')
  eq(patch.maxAmount, 0.2, '上限 20 分 → maxAmount 0.2 元')
  eq(patch.minProbability, 0.5, '50% → minProbability 0.5')
  eq(patch.pollMs, 250, '轮询间隔低于下限时被夹到 250ms')
  eq(P.buildPatch({ pollMs: 999999 }).pollMs, 60000, '轮询间隔超上限时被夹到 60000ms')
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
  ok(allText(myCard).indexOf('概率曲线') >= 0, '含概率曲线区块')
  ok(allText(myCard).indexOf('预览与试算') >= 0, '含预览与试算区块')

  const numInputs = myCard.querySelectorAll('input').filter((i) => i.type === 'number')
  eq(numInputs[0].value, '1', '下限输入框预填 1 分')
  eq(numInputs[1].value, '10', '上限输入框预填 10 分')
  eq(numInputs[2].value, '25', '概率输入框预填 25%')
  const svg = myCard.querySelectorAll('svg')[0]
  ok(!!svg && String(svg.innerHTML).indexOf('<path') >= 0, '概率曲线已绘制(<path> 存在)')

  section('8. 预览按钮不花钱')
  const before = hook.getRuntime().onScreen
  const previewBtns = myCard.querySelectorAll('button').filter((b) => String(b.textContent).indexOf('预览') === 0)
  eq(previewBtns.length, 3, '有 3 个预览按钮(下限/中点/上限)')
  previewBtns[0].__fire('click')
  eq(hook.getRuntime().onScreen, before + 1, '点「预览下限」后就地飘出一个数字(未发任何请求)')
  eq(S.net.puts.length, 0, '预览不产生任何写请求')

  section('9. 试算按钮验证概率')
  const simInputs = myCard.querySelectorAll('input').filter((i) => i.type === 'number')
  simInputs[3].value = '10'      // 试算金额 = 上限 10 分
  simInputs[4].value = '1000'    // 掷 1000 次
  const runBtn = myCard.querySelectorAll('button').filter((b) => String(b.textContent) === '跑')[0]
  ok(!!runBtn, '找到「跑」按钮')
  runBtn.__fire('click')
  ok(allText(myCard).indexOf('1000/1000') >= 0, '上限金额试算 1000 次全部命中', allText(myCard).slice(-80))

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
  eq(hook.getConfig().minAmount, 0.02, '保存成功后本地配置立即生效')
  eq(hook.getRuntime().pollMs, 2000, '未改动的轮询间隔保持 2000ms')
  eq(entry.__summary.textContent, '2 分–10 分 · 40%→100%', '入口行摘要跟着刷新')
  ok(!hook.panel.isOpen(), '保存成功后卡片自动关闭')

  section('10b. 轮询间隔的夹取是端到端生效的(界面 → 载荷 → 重建定时器)')
  hook.panel.open()
  const card2 = S.body.querySelectorAll('.dshwv-bubmask')
    .filter((m) => m.getAttribute('data-dsh-dmg'))[0].querySelector('.dshwv-bubcard')
  const ni2 = card2.querySelectorAll('input').filter((i) => i.type === 'number')
  // 守卫:曾经真的踩过「控件 new 出来了、却忘了 appendChild 进那一行」——
  // 结果界面上少一个输入框,而 collect() 永远读到默认值,静默失效。
  // 所以这里把"数字控件必须齐"钉死(下限/上限/概率/试算金额/试算次数/轮询/字号/描边宽/小数位/上浮/时长/抖动/同屏)。
  eq(ni2.length, 13, '卡片里的数字输入框数量正确(少一个就说明有控件没挂进 DOM)')
  eq(ni2[5].value, '2000', '轮询间隔输入框真的在 DOM 里(第 6 个数字控件)')
  ni2[5].value = '100'
  card2.querySelectorAll('button').filter((b) => String(b.textContent) === '保存')[0].__fire('click')
  await flush(); await flush()
  eq(S.net.puts.length, 2, '第二次保存发出了 PUT')
  eq(S.net.puts[1].pollMs, 250, '界面填 100ms → 载荷被夹到 250ms')
  eq(hook.getRuntime().pollMs, 250, '夹取结果真的落到了重建后的定时器上')
  ok(!hook.panel.isOpen(), '第二次保存后卡片也关闭了')

  section('11. 入口行勾选框 = 总开关(立即保存)')
  entry.__check.checked = false
  entry.__check.__fire('change')
  await flush(); await flush()
  eq(S.net.puts.length, 3, '勾选框变化触发了 1 个 PUT')
  eq(S.net.puts[2].enabled, false, 'PUT 载荷:enabled = false')
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
