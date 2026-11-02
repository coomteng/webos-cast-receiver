'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { createGena, lastChangeXml, parseCallback, parseTimeout } = require('../server/gena.js')
const { Renderer } = require('../server/renderer.js')
const { xmlUnescape } = require('../server/xml.js')

function harness() {
  const sent = []
  const timers = []
  const tv = { isOnline: () => true, send() {} }
  const renderer = new Renderer({ tv, now: () => 0 })
  const gena = createGena({
    renderer,
    now: () => 0,
    setTimeoutFn: (fn) => { timers.push(fn); return timers.length },
    clearTimeoutFn: () => {},
    request: (opts, cb) => {
      const chunks = []
      const req = { on() { return req }, end(body) { sent.push({ opts, body: String(body) }) }, destroy() {} }
      return req
    },
  })
  const runTimers = () => { const t = timers.splice(0); t.forEach(fn => fn()) }
  return { gena, renderer, sent, runTimers }
}

test('parse helpers', () => {
  assert.deepEqual(parseCallback('<http://192.168.0.5:49152/cb><http://x/y>'), ['http://192.168.0.5:49152/cb', 'http://x/y'])
  assert.equal(parseTimeout('Second-1800'), 1800)
  assert.equal(parseTimeout('Second-5'), 30)
  assert.equal(parseTimeout(undefined), 300)
  assert.equal(parseTimeout('Second-infinite'), 1800)
})

test('lastChangeXml AVT and RCS shapes', () => {
  const a = lastChangeXml('avt', { TransportState: 'PLAYING', CurrentTrackDuration: 83 })
  assert.match(a, /<Event xmlns="urn:schemas-upnp-org:metadata-1-0\/AVT\/"><InstanceID val="0"><TransportState val="PLAYING"\/><CurrentTrackDuration val="0:01:23"\/><\/InstanceID><\/Event>/)
  const r = lastChangeXml('rcs', { Volume: 10, Mute: 0 })
  assert.match(r, /<Volume channel="Master" val="10"\/><Mute channel="Master" val="0"\/>/)
})

test('SUBSCRIBE issues SID, sends initial event, renew works, bad renew 412', () => {
  const { gena, sent, runTimers } = harness()
  const r = gena.subscribe('avt', { nt: 'upnp:event', callback: '<http://192.168.0.5:4000/cb>', timeout: 'Second-600' })
  assert.equal(r.status, 200)
  assert.match(r.headers.SID, /^uuid:/)
  assert.equal(r.headers.TIMEOUT, 'Second-600')
  runTimers()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].opts.method, 'NOTIFY')
  assert.equal(sent[0].opts.hostname, '192.168.0.5')
  assert.equal(sent[0].opts.port, '4000')
  assert.equal(sent[0].opts.headers.SEQ, '0')
  assert.match(sent[0].body, /<e:propertyset/)
  const inner = xmlUnescape(sent[0].body.match(/<LastChange>([\s\S]*?)<\/LastChange>/)[1])
  assert.match(inner, /<TransportState val="NO_MEDIA_PRESENT"\/>/)
  const renew = gena.subscribe('avt', { sid: r.headers.SID, timeout: 'Second-300' })
  assert.equal(renew.status, 200)
  assert.equal(gena.subscribe('avt', { sid: 'uuid:nope' }).status, 412)
  assert.equal(gena.subscribe('avt', { nt: 'wrong', callback: '<http://a/b>' }).status, 412)
  assert.equal(gena.unsubscribe('avt', { sid: r.headers.SID }).status, 200)
  assert.equal(gena.unsubscribe('avt', { sid: r.headers.SID }).status, 412)
})

test('renderer state change produces moderated NOTIFY with SEQ increment; ended -> STOPPED', () => {
  const { gena, renderer, sent, runTimers } = harness()
  const r = gena.subscribe('avt', { nt: 'upnp:event', callback: '<http://h:1/cb>' })
  runTimers(); sent.length = 0
  renderer.setUri('http://x/a.mp4', '')
  renderer.onTvReport({ loadId: 1, state: 'playing', position: 0, duration: 12 })
  runTimers() // flush moderation
  assert.equal(sent.length, 1, 'burst coalesced into one NOTIFY')
  assert.equal(sent[0].opts.headers.SEQ, '1')
  let inner = xmlUnescape(sent[0].body.match(/<LastChange>([\s\S]*?)<\/LastChange>/)[1])
  assert.match(inner, /<TransportState val="PLAYING"\/>/)
  assert.match(inner, /<AVTransportURI val="http:\/\/x\/a.mp4"\/>/)
  assert.match(inner, /<CurrentTrackDuration val="0:00:12"\/>/)
  sent.length = 0
  renderer.onTvReport({ loadId: 1, state: 'ended', position: 12 })
  runTimers()
  inner = xmlUnescape(sent[0].body.match(/<LastChange>([\s\S]*?)<\/LastChange>/)[1])
  assert.match(inner, /<TransportState val="STOPPED"\/>/)
  assert.equal(sent[0].opts.headers.SEQ, '2')
  assert.equal(sent[0].opts.headers.SID, r.headers.SID)
})

test('rcs subscribers get Volume events, not avt ones', () => {
  const { gena, renderer, sent, runTimers } = harness()
  gena.subscribe('rcs', { nt: 'upnp:event', callback: '<http://h:1/cb>' })
  runTimers(); sent.length = 0
  renderer.setUri('http://x/a.mp4', '')
  renderer.setVolume(70)
  runTimers()
  assert.equal(sent.length, 1)
  const inner = xmlUnescape(sent[0].body.match(/<LastChange>([\s\S]*?)<\/LastChange>/)[1])
  assert.match(inner, /RCS\//)
  assert.match(inner, /<Volume channel="Master" val="70"\/>/)
  assert.doesNotMatch(inner, /TransportState/)
})
