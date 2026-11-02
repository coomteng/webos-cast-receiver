// End-to-end over real HTTP: a fake phone (SOAP) and a fake TV (poll/state)
// against createApp(), no SSDP.
'use strict'
const { test, after } = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { createApp } = require('../server/server.js')
const { loadConfig } = require('../server/config.js')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castrx-'))
const cfg = loadConfig({ DATA_DIR: tmp, PORT: '0', ADVERTISE_HOST: '127.0.0.1', PROXY_MODE: 'off', TV_TIMEOUT_MS: '2000' })
const app = createApp({ config: cfg })
const srv = http.createServer(app.handler)
srv.keepAliveTimeout = 100
let base

test('listen', async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${srv.address().port}`
  cfg.base = base
})
after(() => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

function req(method, p, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + p, { method, headers }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }))
    })
    r.on('error', reject)
    r.end(body)
  })
}

function soap(svc, action, args = '') {
  const type = { avt: 'AVTransport', rcs: 'RenderingControl', cms: 'ConnectionManager' }[svc]
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:${type}:1"><InstanceID>0</InstanceID>${args}</u:${action}></s:Body></s:Envelope>`
  return req('POST', `/dlna/${svc}/control`, { headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"urn:schemas-upnp-org:service:${type}:1#${action}"` }, body })
}

const tvPost = (obj) => req('POST', '/tv/state', { headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })

test('descriptions served with text/xml', async () => {
  const d = await req('GET', '/dlna/device.xml')
  assert.equal(d.status, 200)
  assert.match(d.headers['content-type'], /text\/xml/)
  assert.match(d.text, /MediaRenderer:1/)
  for (const s of ['avt', 'rcs', 'cms']) assert.equal((await req('GET', `/dlna/${s}.xml`)).status, 200)
})

test('ConnectionManager / RenderingControl basics', async () => {
  const pi = await soap('cms', 'GetProtocolInfo')
  assert.equal(pi.status, 200)
  assert.match(pi.text, /video\/mp4/)
  const v = await soap('rcs', 'GetVolume', '<Channel>Master</Channel>')
  assert.match(v.text, /<CurrentVolume>50<\/CurrentVolume>/)
  await soap('rcs', 'SetVolume', '<Channel>Master</Channel><DesiredVolume>20</DesiredVolume>')
  assert.match((await soap('rcs', 'GetVolume', '<Channel>Master</Channel>')).text, /<CurrentVolume>20<\/CurrentVolume>/)
})

test('unknown action -> 500 + UPnP 401; Play with no TV -> 701', async () => {
  const r = await soap('avt', 'Bogus')
  assert.equal(r.status, 500)
  assert.match(r.text, /<errorCode>401<\/errorCode>/)
  await soap('avt', 'SetAVTransportURI', '<CurrentURI>http://cdn/a.mp4</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>')
  const p = await soap('avt', 'Play', '<Speed>1</Speed>')
  assert.equal(p.status, 500)
  assert.match(p.text, /<errorCode>701<\/errorCode>/)
})

test('full cast flow: TV polls, phone sets URI, TV gets load, reports, phone sees position; GENA NOTIFY delivered', async () => {
  // GENA subscriber (fake phone callback server)
  const notifies = []
  const cb = http.createServer((rq, rs) => { let b = ''; rq.on('data', c => b += c); rq.on('end', () => { notifies.push({ seq: rq.headers.seq, body: b }); rs.writeHead(200); rs.end() }) })
  await new Promise(r => cb.listen(0, '127.0.0.1', r))
  const sub = await req('SUBSCRIBE', '/dlna/avt/event', { headers: { NT: 'upnp:event', CALLBACK: `<http://127.0.0.1:${cb.address().port}/cb>`, TIMEOUT: 'Second-300' } })
  assert.equal(sub.status, 200)
  assert.match(sub.headers.sid, /^uuid:/)

  // TV comes online: a poll parks
  const pollP = req('GET', '/tv/poll?after=0')
  await tvPost({ name: 'LG', state: 'idle' })
  const st = JSON.parse((await req('GET', '/status')).text)
  assert.equal(st.tv.online, true)

  // Phone pushes a URI -> TV's parked poll returns the load command
  const set = await soap('avt', 'SetAVTransportURI', '<CurrentURI>http://cdn/a.mp4</CurrentURI><CurrentURIMetaData>&lt;DIDL-Lite&gt;&lt;item&gt;&lt;dc:title&gt;hi&lt;/dc:title&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;</CurrentURIMetaData>')
  assert.equal(set.status, 200)
  const poll = JSON.parse((await pollP).text)
  assert.equal(poll.commands.length, 1)
  assert.equal(poll.commands[0].cmd, 'load')
  assert.equal(poll.commands[0].url, 'http://cdn/a.mp4', 'proxy off -> raw url')
  assert.equal(poll.commands[0].title, 'hi')
  const ti = await soap('avt', 'GetTransportInfo')
  assert.match(ti.text, /TRANSITIONING/)

  // Play while TRANSITIONING is a no-op success (Douyin sends Play right after SetURI)
  assert.equal((await soap('avt', 'Play', '<Speed>1</Speed>')).status, 200)

  // TV reports playing
  await tvPost({ loadId: poll.commands[0].loadId, state: 'playing', position: 2, duration: 15 })
  const pi = await soap('avt', 'GetPositionInfo')
  assert.match(pi.text, /<TrackDuration>0:00:15<\/TrackDuration>/)
  assert.match(pi.text, /<RelTime>0:00:0[23]<\/RelTime>/)

  // Phone pauses -> TV's next poll gets it (acknowledging seq 1)
  const poll2P = req('GET', `/tv/poll?after=${poll.commands[0].seq}`)
  assert.equal((await soap('avt', 'Pause')).status, 200)
  const poll2 = JSON.parse((await poll2P).text)
  assert.deepEqual(poll2.commands.map(c => c.cmd), ['pause'])

  // Seek
  const poll3P = req('GET', `/tv/poll?after=${poll2.commands[0].seq}`)
  await soap('avt', 'Seek', '<Unit>REL_TIME</Unit><Target>0:00:10</Target>')
  const poll3 = JSON.parse((await poll3P).text)
  assert.equal(poll3.commands[0].cmd, 'seek')
  assert.equal(poll3.commands[0].position, 10)

  // Ended -> STOPPED and a NOTIFY carrying it
  await tvPost({ loadId: poll.commands[0].loadId, state: 'ended', position: 15, duration: 15 })
  await new Promise(r => setTimeout(r, 400))
  assert.match((await soap('avt', 'GetTransportInfo')).text, /<CurrentTransportState>STOPPED<\/CurrentTransportState>/)
  assert.ok(notifies.length >= 2, 'initial + change notifies')
  const last = notifies[notifies.length - 1].body
  assert.match(last, /TransportState val=&quot;STOPPED&quot;/)
  cb.closeAllConnections && cb.closeAllConnections(); cb.close()
})

test('TV offline after timeout -> 701 again and STOPPED', async () => {
  await new Promise(r => setTimeout(r, 2300))
  const st = JSON.parse((await req('GET', '/status')).text)
  assert.equal(st.tv.online, false)
  const p = await soap('avt', 'Play', '<Speed>1</Speed>')
  assert.match(p.text, /<errorCode>701<\/errorCode>/)
})

test('static + ops routes', async () => {
  assert.equal((await req('GET', '/healthz')).status, 200)
  assert.equal((await req('GET', '/tv/info')).status, 200)
  const r = await req('GET', '/')
  assert.equal(r.status, 302)
  assert.equal((await req('GET', '/tv/../package.json')).status, 404)
})
