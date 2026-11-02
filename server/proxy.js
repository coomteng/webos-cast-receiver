// URL proxy: turns whatever the phone pushed (https, redirects, CDN links
// that want a browser UA / Referer) into a plain LAN http URL the TV's
// <video> can play. Streams bytes through; passes Range both ways so the
// TV can seek. HLS playlists get their segment URLs rewritten to go through
// the proxy too.
//
// register(url) -> '/proxy/<id>' ; handle(req, res, id) serves it.
'use strict'

const http = require('node:http')
const https = require('node:https')
const { URL } = require('node:url')

const MAX_REDIRECTS = 5
const MAX_ENTRIES = 2000
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'host', 'content-security-policy', 'set-cookie', 'strict-transport-security'])

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 16 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 16 }),
}

function isPlaylist(url, contentType) {
  const ct = String(contentType || '').toLowerCase()
  if (/mpegurl/.test(ct)) return true
  try { return /\.m3u8?(\?|$)/i.test(new URL(url).pathname) } catch (e) { return false }
}

function createProxy({ userAgent, mode = 'always', log } = {}) {
  const logf = log || (() => {})
  // id -> { url, referer }
  const entries = new Map()
  let counter = 0

  function register(url, opts = {}) {
    if (!url) return url
    if (mode === 'off') return url
    if (mode === 'https-only' && /^http:\/\//i.test(url)) return url
    if (!/^https?:\/\//i.test(url)) return url
    counter += 1
    const id = counter.toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    entries.set(id, { url, referer: opts.referer || null })
    if (entries.size > MAX_ENTRIES) {
      const oldest = entries.keys().next().value
      entries.delete(oldest)
    }
    return `/proxy/${id}`
  }

  function lookup(id) { return entries.get(id) || null }

  // Resolve redirects manually so we can keep headers and see the final URL.
  function fetchUpstream(url, method, headers, referer, hops, cb) {
    let u
    try { u = new URL(url) } catch (e) { return cb(new Error('bad url')) }
    const mod = u.protocol === 'https:' ? https : http
    const h = Object.assign({}, headers, {
      'user-agent': userAgent,
      accept: '*/*',
      'accept-encoding': 'identity',
      host: u.host,
    })
    if (referer) h.referer = referer
    delete h['accept-language']
    const req = mod.request({
      method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, headers: h, agent: agents[u.protocol], timeout: 20000,
      rejectUnauthorized: false,
    }, res => {
      const st = res.statusCode
      if ([301, 302, 303, 307, 308].includes(st) && res.headers.location && hops < MAX_REDIRECTS) {
        res.resume()
        let next
        try { next = new URL(res.headers.location, url).toString() } catch (e) { return once(new Error('bad redirect')) }
        logf('redirect', st, '->', next.slice(0, 120))
        return fetchUpstream(next, method, headers, referer, hops + 1, once)
      }
      once(null, res, url)
    })
    // cb must fire at most once: after the response has been handed over, a
    // late socket error (client went away, CDN reset) must not reach the
    // caller again — it already wrote its headers.
    let done = false
    const once = (...a) => { if (done) return; done = true; cb(...a) }
    req.on('timeout', () => req.destroy(new Error('upstream timeout')))
    req.on('error', once)
    req.end()
    return req
  }

  function rewritePlaylist(text, baseUrl, referer) {
    return text.split('\n').map(line => {
      const t = line.trim()
      if (!t) return line
      if (t.startsWith('#')) {
        // #EXT-X-KEY / #EXT-X-MAP carry URI="..."
        return line.replace(/URI="([^"]+)"/g, (m, uri) => {
          try { return `URI="${register(new URL(uri, baseUrl).toString(), { referer })}"` } catch (e) { return m }
        })
      }
      try { return register(new URL(t, baseUrl).toString(), { referer }) } catch (e) { return line }
    }).join('\n')
  }

  function handle(req, res, id) {
    const entry = lookup(id)
    if (!entry) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('unknown proxy id') }
    const method = req.method === 'HEAD' ? 'HEAD' : 'GET'
    const fwd = {}
    if (req.headers.range) fwd.range = req.headers.range
    if (req.headers['if-range']) fwd['if-range'] = req.headers['if-range']
    let upstreamReq = null
    let closed = false
    req.on('close', () => { closed = true; if (upstreamReq) upstreamReq.destroy() })

    upstreamReq = fetchUpstream(entry.url, method, fwd, entry.referer, 0, (err, up, finalUrl) => {
      if (closed || res.destroyed) { if (up) up.resume(); return }
      if (err) {
        logf('upstream error', entry.url.slice(0, 100), err.message)
        if (res.headersSent) return res.destroy()
        res.writeHead(502, { 'content-type': 'text/plain' })
        return res.end('upstream: ' + err.message)
      }
      const out = {}
      for (const k of Object.keys(up.headers)) {
        if (HOP_HEADERS.has(k)) continue
        out[k] = up.headers[k]
      }
      out['access-control-allow-origin'] = '*'
      out['cache-control'] = 'no-store'
      // LG/webOS players seek by Range; advertise it when upstream didn't.
      if (!out['accept-ranges'] && up.statusCode === 200) out['accept-ranges'] = 'bytes'
      if (up.statusCode < 400 && method === 'GET' && isPlaylist(finalUrl, up.headers['content-type'])) {
        const chunks = []
        up.on('data', c => chunks.push(c))
        up.on('end', () => {
          const body = rewritePlaylist(Buffer.concat(chunks).toString('utf8'), finalUrl, entry.referer)
          delete out['content-length']
          out['content-type'] = 'application/vnd.apple.mpegurl'
          out['content-length'] = Buffer.byteLength(body)
          res.writeHead(200, out)
          res.end(body)
        })
        up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
        return
      }
      if (!out['content-type']) out['content-type'] = 'video/mp4'
      if (res.headersSent) return up.resume()
      res.writeHead(up.statusCode, out)
      if (method === 'HEAD') { up.resume(); return res.end() }
      up.pipe(res)
      up.on('error', e => { logf('upstream stream error', e.message); res.destroy() })
      res.on('error', () => up.destroy())
    })
  }

  return { register, lookup, handle, _rewritePlaylist: rewritePlaylist, _entries: entries }
}

module.exports = { createProxy, isPlaylist }
