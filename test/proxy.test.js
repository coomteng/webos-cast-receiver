'use strict'
const { test, after } = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const { createProxy } = require('../server/proxy.js')

// Fake CDN: /redir -> 302 -> /video ; /video serves 1000 bytes with Range;
// /ua echoes the UA; /pl.m3u8 is an HLS playlist with relative segments.
const DATA = Buffer.alloc(1000, 7)
const seen = []
const cdn = http.createServer((req, res) => {
  seen.push({ url: req.url, headers: req.headers })
  if (req.url === '/redir') { res.writeHead(302, { location: '/video' }); return res.end() }
  if (req.url === '/video') {
    const r = req.headers.range && req.headers.range.match(/bytes=(\d+)-(\d*)/)
    if (r) {
      const s = +r[1]; const e = r[2] ? +r[2] : DATA.length - 1
      res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': `bytes ${s}-${e}/${DATA.length}`, 'content-length': e - s + 1, 'accept-ranges': 'bytes' })
      return res.end(DATA.subarray(s, e + 1))
    }
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': DATA.length })
    return res.end(DATA)
  }
  if (req.url === '/pl.m3u8') {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
    return res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4,\nseg0.ts\n#EXTINF:4,\nhttp://other/seg1.ts\n#EXT-X-ENDLIST\n')
  }
  if (req.url === '/fail') { res.writeHead(403); return res.end('nope') }
  res.writeHead(404); res.end()
})

let cdnBase, front, frontBase
const proxy = createProxy({ userAgent: 'TestUA/1', mode: 'always' })

test('setup', async () => {
  await new Promise(r => cdn.listen(0, '127.0.0.1', r))
  cdnBase = `http://127.0.0.1:${cdn.address().port}`
  front = http.createServer((req, res) => {
    const m = req.url.match(/^\/proxy\/([A-Za-z0-9_-]+)$/)
    if (m) return proxy.handle(req, res, m[1])
    res.writeHead(404); res.end()
  })
  await new Promise(r => front.listen(0, '127.0.0.1', r))
  frontBase = `http://127.0.0.1:${front.address().port}`
})

after(() => { for (const s of [cdn, front]) { s.closeAllConnections && s.closeAllConnections(); s.close() } })

function get(url, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    http.request(url, { method, headers }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    }).on('error', reject).end()
  })
}

test('register respects mode', () => {
  assert.match(proxy.register('https://a/b.mp4'), /^\/proxy\//)
  assert.equal(createProxy({ mode: 'off' }).register('https://a/b'), 'https://a/b')
  const ho = createProxy({ mode: 'https-only' })
  assert.equal(ho.register('http://a/b'), 'http://a/b')
  assert.match(ho.register('https://a/b'), /^\/proxy\//)
  assert.equal(proxy.register('rtsp://x'), 'rtsp://x')
})

test('follows redirect, sets UA, streams full body', async () => {
  seen.length = 0
  const id = proxy.register(cdnBase + '/redir')
  const r = await get(frontBase + id)
  assert.equal(r.status, 200)
  assert.equal(r.body.length, 1000)
  assert.equal(r.headers['content-type'], 'video/mp4')
  assert.equal(r.headers['accept-ranges'], 'bytes')
  assert.equal(seen[0].headers['user-agent'], 'TestUA/1')
  assert.equal(seen.length, 2)
})

test('Range passes through both ways (206 + Content-Range)', async () => {
  const id = proxy.register(cdnBase + '/video')
  const r = await get(frontBase + id, { range: 'bytes=100-199' })
  assert.equal(r.status, 206)
  assert.equal(r.headers['content-range'], 'bytes 100-199/1000')
  assert.equal(r.body.length, 100)
})

test('HEAD works', async () => {
  const id = proxy.register(cdnBase + '/video')
  const r = await get(frontBase + id, {}, 'HEAD')
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-length'], '1000')
  assert.equal(r.body.length, 0)
})

test('upstream 403 is passed through; unknown id 404; dead upstream 502', async () => {
  const r = await get(frontBase + proxy.register(cdnBase + '/fail'))
  assert.equal(r.status, 403)
  assert.equal((await get(frontBase + '/proxy/nope')).status, 404)
  const dead = await get(frontBase + proxy.register('http://127.0.0.1:9/x'))
  assert.equal(dead.status, 502)
})

test('HLS playlist segments and key URI are rewritten through the proxy', async () => {
  const r = await get(frontBase + proxy.register(cdnBase + '/pl.m3u8'))
  assert.equal(r.status, 200)
  const text = r.body.toString()
  const lines = text.split('\n')
  assert.match(lines[1], /URI="\/proxy\/[A-Za-z0-9_-]+"/)
  assert.match(lines[3], /^\/proxy\//)
  assert.match(lines[5], /^\/proxy\//)
  const seg0 = proxy.lookup(lines[3].slice('/proxy/'.length))
  assert.equal(seg0.url, cdnBase + '/seg0.ts')
  const seg1 = proxy.lookup(lines[5].slice('/proxy/'.length))
  assert.equal(seg1.url, 'http://other/seg1.ts')
})

test('upstream RST mid-body after headers were sent does not crash the process (ERR_HTTP_HEADERS_SENT regression)', async () => {
  const rst = http.createServer((req, res) => {
    res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': 'bytes 0-9999999/10000000', 'content-length': 10000000 })
    res.write(Buffer.alloc(65536))
    setTimeout(() => (req.socket.resetAndDestroy ? req.socket.resetAndDestroy() : req.socket.destroy()), 150)
  })
  await new Promise(r => rst.listen(0, '127.0.0.1', r))
  let crashed = null
  const onErr = e => { crashed = e }
  process.on('uncaughtException', onErr)
  const id = proxy.register(`http://127.0.0.1:${rst.address().port}/v`)
  await new Promise(resolve => {
    const r = http.get(frontBase + id, { headers: { range: 'bytes=0-' } }, res => { res.on('data', () => {}); res.on('error', () => {}); res.on('close', () => setTimeout(resolve, 200)) })
    r.on('error', () => {})
  })
  process.removeListener('uncaughtException', onErr)
  assert.equal(crashed, null, 'uncaught: ' + (crashed && crashed.code))
  const ok = await get(frontBase + proxy.register(cdnBase + '/video'), { range: 'bytes=0-9' })
  assert.equal(ok.status, 206, 'proxy still alive')
  rst.closeAllConnections && rst.closeAllConnections(); rst.close()
})
