// ============================================================================
// dsh-damage-number —— 宿主半区
// ============================================================================
// 职责(刻意做小):
//   ① 把浏览器半区 assets/overlay.js 注册成一条只读路由;
//   ② 通过 webserver/index-inject 的结构化行 + tapIndex 两条通道把脚本注入页面
//      (桌面端 Electron 只认前者,普通 dsh web 两者皆可);
//   ③ 读写配置 $DSH_HOME/.dshdmg.json(GET 只读、PUT 仅限本机回环)。
//
// 数值来源完全不在本插件里:前端直接轮询小鲸鱼挂件的 /dsh-whale/last-turn.json,
// 所以本插件与挂件的版本互不绑定 —— 挂件没装也只是安静地什么都不做。
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')
const OVERLAY_FILE = path.join(PACKAGE_ROOT, 'assets', 'overlay.js')
const PACKAGE_FILE = path.join(PACKAGE_ROOT, 'package.json')

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = path.join(DSH_HOME, '.dshdmg.json')

const ROUTE_PREFIX = '/dsh-dmg'
const OVERLAY_SRC = ROUTE_PREFIX + '/overlay.js'
const CONFIG_ROUTE = ROUTE_PREFIX + '/config.json'
const STATUS_ROUTE = ROUTE_PREFIX + '/status.json'

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

// 与前端 assets/overlay.js 的 DEFAULT_CFG **必须逐字段一致**:
// 宿主是"全新安装的默认值",前端是"取不到 config.json 时的兜底"。
const DEFAULT_CONFIG = {
  enabled: true,
  // —— 伤害区间(人民币元)——
  // 低于 minAmount:不跳;区间内:概率从 minProbability 线性升到 1;达到 maxAmount:必定跳。
  minAmount: 0.01,
  maxAmount: 0.1,
  minProbability: 0.25,
  // —— 外观 ——
  prefix: '-¥',
  decimals: 2,
  color: '#ff3b30',
  strokeColor: '#ffffff',
  strokeWidth: 3,
  fontSizePx: 30,
  // —— 动效 ——
  risePx: 96,
  riseMs: 1200,
  // —— 落点(相对鲸鱼精灵图宽/高的比例,0.5/0.12 ≈ 头顶)——
  headOffsetX: 0.5,
  headOffsetY: 0.12,
  jitterX: 0.18,
  maxStack: 6,
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

// 前端脚本按 mtime 热读取:改 assets/overlay.js 后硬刷新页面即生效,不用重启宿主
let overlayCache = { mtimeMs: -1, text: '' }
function loadOverlayJs() {
  const st = fs.statSync(OVERLAY_FILE)
  if (st.mtimeMs !== overlayCache.mtimeMs) {
    overlayCache = { mtimeMs: st.mtimeMs, text: fs.readFileSync(OVERLAY_FILE, 'utf8') }
  }
  return overlayCache.text
}

// 桌面端(Electron)唯一能生效的注入通道:结构化 script 行的 **内联** 形式。
// 为什么不直接推 script-src 行:页面侧解释器对 script-src 是"加载失败即 reject 整个 boot",
// 而我们自己的 <script src> 带 onerror 兜底,路由不在时也不会拖垮页面启动。
const INLINE_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'if(window.__dshDmgNumberLoaded)return;' +
  'var s=document.createElement("script");s.src="' + OVERLAY_SRC + '";' +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

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

    // —— 通道 ①:结构化注入行(桌面端唯一通道)——
    rowDisposers.push(root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        for (const row of table) {
          if (!row) continue
          if (row.kind === 'script-src' && row.src === OVERLAY_SRC) return
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

      // ---- 路由 ----

      // 浏览器半区本体
      disposers.push(registerRoute({
        kind: 'exact',
        path: OVERLAY_SRC,
        handler: (req, res) => {
          try {
            const text = loadOverlayJs()
            res.writeHead(200, {
              'Content-Type': 'application/javascript; charset=utf-8',
              'Cache-Control': 'no-store',
            })
            res.end(text)
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('overlay unavailable: ' + String((err && err.message) || err))
          }
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

      // 自查路由:一眼看清插件版本、配置落点、数据源是否可达
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
            configFile: CONFIG_FILE,
            configExists: fs.existsSync(CONFIG_FILE),
            config: readConfig(),
            dataSource: '/dsh-whale/last-turn.json',
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
          const tag = '<script defer src="' + OVERLAY_SRC + '"></script>'
          if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
          return html + tag
        }))
      } catch (err) {}
    })
  },
}
