// webos-cast-receiver — HTTP face. Routes:
//   /dlna/device.xml, /dlna/{avt,rcs,cms}.xml        descriptions
//   POST /dlna/{avt,rcs,cms}/control                 SOAP
//   SUBSCRIBE|UNSUBSCRIBE /dlna/{avt,rcs,cms}/event  GENA
//   /proxy/<id>                                      media relay
//   /tv/poll /tv/state /tv/info                      TV app channel
//   /tv/ /sim /                                      static (TV app, simulator)
//   /status /healthz                                 ops
// Start: node server/server.js   (env: see config.js)
'use strict'

const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')

const { loadConfig } = require('./config.js')
const { createSsdp } = require('./ssdp.js')
const { deviceDescription, avtScpd, rcsScpd, cmsScpd, AVT, RCS, CMS } = require('./deviceXml.js')
const { actionFromSoapAction, soapResponse, soapFault, UpnpError } = require('./soap.js')
const { Renderer } = require('./renderer.js')
const { avtActions, rcsActions, cmsActions } = require('./actions.js')
const { createGena } = require('./gena.js')
const { createProxy } = require('./proxy.js')
const { createTvChannel } = require('./tvchannel.js')

const SERVER_HDR = 'Linux/4.4 UPnP/1.0 webos-cast-receiver/1'
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > limit) { req.destroy(); return reject(new Error('body too large')) }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendXml(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/xml; charset="utf-8"', 'content-length': Buffer.byteLength(body), server: SERVER_HDR, ext: '' })
  res.end(body)
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'access-control-allow-origin': '*', 'cache-control': 'no-store' })
  res.end(body)
}

function sendFile(res, root, rel) {
  const file = path.normalize(path.join(root, rel))
  if (!file.startsWith(path.normalize(root + path.sep)) && file !== path.normalize(root)) { res.writeHead(403); return res.end() }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found') }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-cache', 'access-control-allow-origin': '*' })
    fs.createReadStream(file).pipe(res)
  })
}

function createApp({ config } = {}) {
  const cfg = config || loadConfig()
  const log = (...a) => console.log(new Date().toISOString(), ...a)
  const vlog = cfg.verbose ? log : () => {}

  const proxy = createProxy({ userAgent: cfg.proxyUserAgent, mode: cfg.proxyMode, log: vlog })
  let renderer = null
  const tv = createTvChannel({
    timeoutMs: cfg.tvTimeoutMs, log: vlog,
    onOffline: () => renderer && renderer.onTvOffline(),
    // Screen handover (TV came online while a browser was playing, or the
    // active screen vanished): carry the current item over, resuming near
    // where the previous screen was.
    onActiveChange: (next) => { if (next && renderer) renderer.onScreenChanged() },
  })
  renderer = new Renderer({
    tv,
    log: vlog,
    toPlayable: (uri) => {
      const p = proxy.register(uri)
      return p.startsWith('/') ? cfg.base + p : p
    },
  })
  const gena = createGena({ renderer, log: vlog })

  const services = {
    avt: { type: AVT, actions: avtActions(renderer), scpd: avtScpd },
    rcs: { type: RCS, actions: rcsActions(renderer), scpd: rcsScpd },
    cms: { type: CMS, actions: cmsActions(), scpd: cmsScpd },
  }

  renderer.on('change', v => { if (v.TransportState) log('[avt]', v.TransportState, renderer.uri ? renderer.uri.slice(0, 80) : '') })

  async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const p = url.pathname
    const m = req.method

    try {
      // --- descriptions ---------------------------------------------------
      if (p === '/dlna/device.xml') return sendXml(res, 200, deviceDescription(cfg))
      let mm = p.match(/^\/dlna\/(avt|rcs|cms)\.xml$/)
      if (mm) return sendXml(res, 200, services[mm[1]].scpd())

      // --- SOAP control ---------------------------------------------------
      mm = p.match(/^\/dlna\/(avt|rcs|cms)\/control$/)
      if (mm) {
        if (m !== 'POST') { res.writeHead(405); return res.end() }
        const svc = services[mm[1]]
        const action = actionFromSoapAction(req.headers.soapaction)
        const body = await readBody(req)
        const fn = action && svc.actions[action]
        if (!fn) {
          log('[soap]', mm[1], action || '(none)', '-> 401 invalid action')
          return sendXml(res, 500, soapFault(401, 'Invalid Action'))
        }
        try {
          const out = fn(body) || {}
          if (!/^Get/.test(action)) log('[soap]', action, action === 'SetAVTransportURI' ? renderer.uri.slice(0, 100) : '')
          return sendXml(res, 200, soapResponse(svc.type, action, out))
        } catch (e) {
          if (e instanceof UpnpError) {
            log('[soap]', action, '->', e.upnpCode, e.message)
            return sendXml(res, 500, soapFault(e.upnpCode, e.message))
          }
          throw e
        }
      }

      // --- GENA -----------------------------------------------------------
      mm = p.match(/^\/dlna\/(avt|rcs|cms)\/event$/)
      if (mm) {
        let r
        if (m === 'SUBSCRIBE') r = gena.subscribe(mm[1], req.headers)
        else if (m === 'UNSUBSCRIBE') r = gena.unsubscribe(mm[1], req.headers)
        else { res.writeHead(405); return res.end() }
        res.writeHead(r.status, Object.assign({ server: SERVER_HDR, 'content-length': 0 }, r.headers || {}))
        return res.end()
      }

      // --- media proxy ----------------------------------------------------
      mm = p.match(/^\/proxy\/([A-Za-z0-9_-]+)$/)
      if (mm) return proxy.handle(req, res, mm[1])

      // --- TV channel -----------------------------------------------------
      if (m === 'OPTIONS' && p.startsWith('/tv/')) {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' })
        return res.end()
      }
      if (p === '/tv/poll') {
        const info = { ip: req.socket.remoteAddress, ua: req.headers['user-agent'] || '' }
        const respond = obj => sendJson(res, 200, obj)
        req.on('close', () => tv.onDisconnect(respond))
        return tv.poll({ client: url.searchParams.get('client'), role: url.searchParams.get('role'), after: url.searchParams.get('after'), respond, info })
      }
      if (p === '/tv/state' && m === 'POST') {
        const body = await readBody(req)
        let r = null
        try { r = JSON.parse(body || '{}') } catch (e) { return sendJson(res, 400, { error: 'bad json' }) }
        const active = tv.report({ client: r.client, role: r.role, info: { ip: req.socket.remoteAddress, name: r.name } })
        if (active) renderer.onTvReport(r)
        return sendJson(res, 200, { ok: true, active, seq: tv.status().seq })
      }
      if (p === '/tv/info') {
        return sendJson(res, 200, { name: cfg.friendlyName, host: cfg.advertiseHost, port: cfg.port, uuid: cfg.uuid, version: require('../package.json').version })
      }

      // --- ops --------------------------------------------------------------
      if (p === '/healthz') return sendJson(res, 200, { ok: true })
      if (p === '/status') return sendJson(res, 200, { renderer: renderer.snapshot(), tv: tv.status(), name: cfg.friendlyName, base: cfg.base })

      // --- static -----------------------------------------------------------
      // Root = the player page: any browser can act as the screen when the TV is off.
      if (p === '/' ) return sendFile(res, cfg.appDir, 'index.html')
      if (p === '/sim' || p === '/sim/') return sendFile(res, cfg.simDir, 'index.html')
      if (p.startsWith('/sim/')) return sendFile(res, cfg.simDir, p.slice(5))
      if (p === '/tv' || p === '/tv/') return sendFile(res, cfg.appDir, 'index.html')
      if (p.startsWith('/tv/')) return sendFile(res, cfg.appDir, p.slice(4))
      if (/^\/(css|js)\//.test(p) || p === '/icon.png' || p === '/largeIcon.png') return sendFile(res, cfg.appDir, p.slice(1))

      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    } catch (e) {
      log('[http] error', p, e.message)
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('error') }
      else res.end()
    }
  }

  return { cfg, handler, renderer, tv, gena, proxy }
}

function main() {
  // A stray socket error must not take the renderer down (SSDP presence,
  // GENA subscriptions and the TV channel would all vanish with it).
  process.on('uncaughtException', e => console.error(new Date().toISOString(), '[fatal-ish] uncaught:', e && e.stack || e))
  process.on('unhandledRejection', e => console.error(new Date().toISOString(), '[fatal-ish] unhandled rejection:', e && e.stack || e))
  const app = createApp()
  const { cfg } = app
  const server = http.createServer(app.handler)
  server.keepAliveTimeout = 65000
  server.listen(cfg.port, cfg.bindAddr || '0.0.0.0', () => {
    console.log(`[http] ${cfg.base}  friendlyName="${cfg.friendlyName}" uuid=${cfg.uuid} proxy=${cfg.proxyMode}`)
  })
  const ssdp = createSsdp({ uuid: cfg.uuid, location: `${cfg.base}/dlna/device.xml`, bindAddr: cfg.bindAddr })
  ssdp.start()
  const shutdown = () => { ssdp.stop(); server.close(); setTimeout(() => process.exit(0), 300) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

if (require.main === module) main()

module.exports = { createApp, readBody }
