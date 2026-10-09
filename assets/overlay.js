// ============================================================================
// dsh-damage-number —— 浏览器半区
// ============================================================================
// 每轮对话结束后,按「区间 + 随机」规则在小鲸鱼头顶弹出一个红色伤害数字。
//
// 数据源:小鲸鱼挂件的 /dsh-whale/last-turn.json → { ok, seq, turn, amount, tokens, ts }
//   seq 每完成一轮递增,所以"seq 变大"就是"又花了一轮钱"的触发信号。
//   挂件没装 / 路由 404 时,这里只是安静地什么都不做(不报错、不刷屏)。
//
// 触发规则(与本插件宿主半区的 DEFAULT_CONFIG 必须一致):
//   amount <  minAmount            → 不跳
//   minAmount <= amount < maxAmount → 概率 = minProbability + (1-minProbability) * 区间内进度
//   amount >= maxAmount            → 必定跳
// 这正是"伤害有上下限、多数时候随机、暴击必定触发"的手感。
// ============================================================================

(function () {
  'use strict'
  if (typeof window === 'undefined') return
  if (window.__dshDmgNumberLoaded) return
  window.__dshDmgNumberLoaded = true

  var ENDPOINT_TURN = '/dsh-whale/last-turn.json'
  var ENDPOINT_CFG = '/dsh-dmg/config.json'
  var POLL_MS = 1000
  var CFG_REFRESH_MS = 30000
  var LAYER_ID = 'dsh-dmg-layer'

  var DEFAULT_CFG = {
    enabled: true,
    minAmount: 0.01,
    maxAmount: 0.1,
    minProbability: 0.25,
    prefix: '-¥',
    decimals: 2,
    color: '#ff3b30',
    strokeColor: '#ffffff',
    strokeWidth: 3,
    fontSizePx: 30,
    risePx: 96,
    riseMs: 1200,
    headOffsetX: 0.5,
    headOffsetY: 0.12,
    jitterX: 0.18,
    maxStack: 6,
  }

  var cfg = Object.assign({}, DEFAULT_CFG)
  // baseline = "已经结算到哪一个 seq"。
  // 持久化在 localStorage 里(键名与小鲸鱼自己的 dshw-last-seq 区分开):这样**刷新页面/重开客户端
  // 不会漏掉**在页面不在时结束的那一轮 —— 挂件自己也是这个策略(它读 dshw-last-seq)。
  var baseline = null
  var SEQ_KEY = 'dshw-dmg-last-seq'
  var stack = []       // 正在飘的节点,满了就丢掉最旧的
  var timers = []

  function readStoredSeq() {
    try {
      var v = window.localStorage.getItem(SEQ_KEY)
      if (v === null || v === undefined || v === '') return null
      var n = Number(v)
      return isFinite(n) ? n : null
    } catch (err) { return null }   // 隐私模式/存储被禁 → 退化成本次会话内对齐
  }
  function storeSeq(v) {
    try { window.localStorage.setItem(SEQ_KEY, String(v)) } catch (err) {}
  }

  function num(v, fallback) {
    var n = Number(v)
    return isFinite(n) ? n : fallback
  }
  function clamp01(v) {
    if (!isFinite(v)) return 0
    return v < 0 ? 0 : (v > 1 ? 1 : v)
  }

  // ---- 落点:鲸鱼精灵图(.dshwv-img)的头顶 ----
  // 挂件是"根节点方块 + 内部 59.45% 的精灵图",所以必须量图片本身的矩形,
  // 不能量根节点 —— 否则数字会飘在鲸鱼左上方的空气里。
  function headPoint() {
    var el = null
    try {
      el = document.querySelector('.dshwv-root .dshwv-img') || document.querySelector('.dshwv-root')
    } catch (err) { el = null }
    if (!el || typeof el.getBoundingClientRect !== 'function') return null
    var r = null
    try { r = el.getBoundingClientRect() } catch (err) { return null }
    if (!r || !(r.width > 0) || !(r.height > 0)) return null
    return {
      x: r.left + r.width * num(cfg.headOffsetX, 0.5),
      y: r.top + r.height * num(cfg.headOffsetY, 0.12),
      w: r.width,
      h: r.height,
    }
  }

  function ensureLayer() {
    var el = null
    try { el = document.getElementById(LAYER_ID) } catch (err) { el = null }
    if (el) return el
    try {
      el = document.createElement('div')
      el.id = LAYER_ID
      el.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;'
        + 'z-index:9998;pointer-events:none;'
      var host = document.body || document.documentElement
      if (!host || typeof host.appendChild !== 'function') return null
      host.appendChild(el)
    } catch (err) { return null }
    return el
  }

  function fmtAmount(n) {
    var a = num(n, 0)
    var d = num(cfg.decimals, 2)
    d = Math.max(0, Math.min(6, Math.round(d)))
    var s = a.toFixed(d)
    // 2 位小数会把"小于半分钱"显示成 0.00 —— 那看着像故障,补一位
    if (d === 2 && s === '0.00' && a > 0) s = a.toFixed(3)
    return s
  }

  // ---- 核心:区间 + 概率判定(纯函数,便于测试)----
  function rollDamage(amount, c) {
    c = c || cfg
    var a = num(amount, NaN)
    if (!isFinite(a) || a <= 0) return { hit: false, p: 0, reason: 'no-cost' }
    var lo = num(c.minAmount, 0)
    var hi = num(c.maxAmount, lo)
    if (a < lo) return { hit: false, p: 0, reason: 'below-min' }
    var base = clamp01(num(c.minProbability, 0))
    var p
    if (hi <= lo || a >= hi) {
      p = 1 // 区间退化(上下限相等)= 纯阈值;达到/超过上限 = 必定触发
    } else {
      p = base + (1 - base) * clamp01((a - lo) / (hi - lo))
    }
    p = clamp01(p)
    var r = Math.random()
    return { hit: r < p, p: p, roll: r, reason: r < p ? 'hit' : 'miss' }
  }

  function dropOldest() {
    var max = Math.max(1, Math.round(num(cfg.maxStack, 6)))
    while (stack.length >= max) {
      var old = stack.shift()
      try { if (old && old.parentNode) old.parentNode.removeChild(old) } catch (err) {}
    }
  }

  function spawn(amount, opts) {
    opts = opts || {}
    var layerEl = ensureLayer()
    if (!layerEl) return null
    var pt = opts.point || headPoint()

    var fs = Math.max(8, num(cfg.fontSizePx, 30))
    var sw = Math.max(0, num(cfg.strokeWidth, 0))
    var color = String(cfg.color || '#ff3b30')
    var strokeColor = String(cfg.strokeColor || '#ffffff')

    var outer = document.createElement('div')
    outer.className = 'dsh-dmg-num'
    // 外层只负责"钉在头顶这个点上",不参与动画 —— 这样内层动画可以全部用 px,
    // 避免百分比与 calc() 混插带来的插值不可靠。
    outer.style.cssText = 'position:absolute;left:0;top:0;white-space:nowrap;'
      + 'pointer-events:none;transform:translate(-50%,-50%);'
      + 'font-weight:900;line-height:1;font-family:inherit;'

    var inner = document.createElement('span')
    inner.style.cssText = 'display:inline-block;transform-origin:50% 100%;will-change:transform,opacity;'
      + 'font-size:' + fs + 'px;color:' + color + ';'
    if (sw > 0) {
      inner.style.webkitTextStroke = sw + 'px ' + strokeColor
      inner.style.paintOrder = 'stroke fill'
      inner.style.textShadow = '0 ' + Math.max(1, Math.round(sw * 0.6)) + 'px '
        + Math.max(2, Math.round(sw * 1.6)) + 'px rgba(0,0,0,.30)'
    }
    inner.textContent = String(cfg.prefix == null ? '-¥' : cfg.prefix) + fmtAmount(amount)
    outer.appendChild(inner)

    var jitter = Math.max(0, num(cfg.jitterX, 0)) * (pt ? pt.w : 60)
    var dx = jitter > 0 ? (Math.random() * 2 - 1) * jitter : 0
    var rot = (Math.random() * 2 - 1) * 6
    var baseX = pt ? pt.x : (num(window.innerWidth, 800) - 80)
    var baseY = pt ? pt.y : (num(window.innerHeight, 600) - 140)
    outer.style.left = Math.round(baseX + dx) + 'px'
    outer.style.top = Math.round(baseY) + 'px'
    outer.style.transform = 'translate(-50%,-50%) rotate(' + rot.toFixed(2) + 'deg)'

    dropOldest()
    layerEl.appendChild(outer)
    stack.push(outer)

    var dist = Math.max(0, num(cfg.risePx, 96))
    var dur = Math.max(120, num(cfg.riseMs, 1200))

    function cleanup() {
      var i = stack.indexOf(outer)
      if (i >= 0) stack.splice(i, 1)
      try { if (outer.parentNode) outer.parentNode.removeChild(outer) } catch (err) {}
    }

    var frames = [
      { transform: 'translateY(0px) scale(.55)', opacity: 0 },
      { transform: 'translateY(' + (-dist * 0.16).toFixed(1) + 'px) scale(1.28)', opacity: 1, offset: 0.16 },
      { transform: 'translateY(' + (-dist * 0.34).toFixed(1) + 'px) scale(1)', opacity: 1, offset: 0.32 },
      { transform: 'translateY(' + (-dist).toFixed(1) + 'px) scale(1.04)', opacity: 0 },
    ]
    var timing = { duration: dur, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'forwards' }

    try {
      if (typeof inner.animate === 'function') {
        var anim = inner.animate(frames, timing)
        if (anim && typeof anim.addEventListener === 'function') anim.addEventListener('finish', cleanup)
        else setTimeout(cleanup, dur + 40)
      } else {
        // 没有 Web Animations API:退化成"出现 → 定时移除",至少不残留
        inner.style.opacity = '1'
        setTimeout(cleanup, dur)
      }
    } catch (err) {
      setTimeout(cleanup, dur)
    }
    return outer
  }

  function fetchJson(url) {
    return fetch(url, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        if (!r || !r.ok) throw new Error('http ' + (r && r.status))
        return r.json()
      })
  }

  function loadConfig() {
    return fetchJson(ENDPOINT_CFG)
      .then(function (d) {
        // 只在拿到**对象**时才应用:404 / 断连 / 畸形载荷一律保留上一次有效配置。
        // 绝不因为一次读失败就把用户调好的区间静默冲回默认值 —— 宿主那边读不到配置时
        // 返回的本来就是"默认值 + 磁盘覆盖"的完整对象,客户端不需要自己兜底重置。
        if (d && typeof d === 'object') {
          cfg = Object.assign({}, DEFAULT_CFG, d)
          hook.cfg = cfg
        }
      })
      .catch(function () {})
  }

  // 跑一次轮询。返回:null = 无事发生;{...} = 本次判定结果(便于测试与调试)
  function tick() {
    return fetchJson(ENDPOINT_TURN)
      .then(function (d) {
        if (!d || !d.ok || typeof d.seq !== 'number') return null
        var seq = num(d.seq, 0)

        if (baseline === null) {
          var stored = readStoredSeq()
          if (stored === null) {
            // 本机第一次运行:只立基准。绝不把历史账本里的旧轮次当成"刚刚花的钱"补弹一遍。
            baseline = seq
            storeSeq(seq)
            return null
          }
          baseline = stored
        }

        if (seq === baseline) return null
        if (seq < baseline) {
          // 挂件重启 / seq 文件丢失 → 拉齐,不弹(否则会拿一个陈旧的比较基准乱跳)
          baseline = seq
          storeSeq(seq)
          return null
        }

        baseline = seq
        storeSeq(seq)
        if (cfg.enabled === false) return null
        var amount = num(d.amount, 0)
        var res = rollDamage(amount)
        if (!res.hit) return res
        spawn(amount)
        return res
      })
      .catch(function () { return null })
  }

  var hook = {
    version: '0.1.0',
    getConfig: function () { return Object.assign({}, cfg) },
    setConfig: function (patch) { cfg = Object.assign({}, cfg, patch || {}); hook.cfg = cfg; return hook.getConfig() },
    roll: rollDamage,
    spawn: spawn,
    tick: tick,
    loadConfig: loadConfig,
    headPoint: headPoint,
    reset: function () { baseline = null; return true },
    clearStoredSeq: function () { try { window.localStorage.removeItem(SEQ_KEY) } catch (err) {} baseline = null; return true },
    getBaseline: function () { return baseline },
    cfg: cfg,
  }
  window.__dshDmgNumber = hook

  function start() {
    ensureLayer()
    loadConfig().then(function () {
      tick()
      timers.push(setInterval(tick, POLL_MS))
      timers.push(setInterval(loadConfig, CFG_REFRESH_MS))
    })
  }

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start)
    } else {
      start()
    }
  } catch (err) {
    // 页面结构异常时绝不让脚本把宿主页面搞挂
    try { start() } catch (err2) {}
  }
})()
