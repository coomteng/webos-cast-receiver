'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { Renderer } = require('../server/renderer.js')
const { avtActions } = require('../server/actions.js')
const { UpnpError } = require('../server/soap.js')

function fakeTv(online = true) {
  const sent = []
  return { sent, online, isOnline() { return this.online }, send(c) { sent.push(c) } }
}

function make(online = true) {
  let t = 1000
  const tv = fakeTv(online)
  const changes = []
  const r = new Renderer({ tv, now: () => t, toPlayable: u => 'http://proxy/' + encodeURIComponent(u) })
  r.on('change', c => changes.push(c))
  return { r, tv, changes, tick: ms => { t += ms } }
}

const DIDL = '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/"><item id="1"><dc:title>猫猫视频</dc:title></item></DIDL-Lite>'

test('initial state NO_MEDIA_PRESENT', () => {
  const { r } = make()
  assert.equal(r.state, 'NO_MEDIA_PRESENT')
  assert.equal(r.currentActions(), '')
})

test('SetAVTransportURI with TV online loads immediately and goes TRANSITIONING', () => {
  const { r, tv, changes } = make()
  r.setUri('https://cdn/a.mp4', DIDL)
  assert.equal(r.state, 'TRANSITIONING')
  assert.equal(r.title, '猫猫视频')
  assert.equal(tv.sent.length, 1)
  assert.equal(tv.sent[0].cmd, 'load')
  assert.equal(tv.sent[0].url, 'http://proxy/' + encodeURIComponent('https://cdn/a.mp4'))
  assert.equal(tv.sent[0].loadId, 1)
  assert.ok(changes.some(c => c.AVTransportURI === 'https://cdn/a.mp4'))
})

test('SetAVTransportURI with TV offline arms STOPPED; Play then throws 701', () => {
  const { r, tv } = make(false)
  r.setUri('http://x/a.mp4', '')
  assert.equal(r.state, 'STOPPED')
  assert.equal(tv.sent.length, 0)
  assert.throws(() => r.play(), e => e instanceof UpnpError && e.upnpCode === 701)
})

test('TV reports drive PLAYING/PAUSED/ended; stale loadId ignored; position extrapolates', () => {
  const { r, tv, tick, changes } = make()
  r.setUri('http://x/a.mp4', '')
  r.onTvReport({ loadId: 1, state: 'playing', position: 0, duration: 30 })
  assert.equal(r.state, 'PLAYING')
  assert.equal(r.duration, 30)
  tick(5000)
  assert.ok(Math.abs(r.position() - 5) < 0.01)
  r.onTvReport({ loadId: 1, state: 'paused', position: 5.2 })
  assert.equal(r.state, 'PAUSED_PLAYBACK')
  tick(5000)
  assert.ok(Math.abs(r.position() - 5.2) < 0.01, 'paused does not advance')
  r.onTvReport({ loadId: 0, state: 'playing', position: 20 })
  assert.equal(r.state, 'PAUSED_PLAYBACK', 'stale report ignored')
  changes.length = 0
  r.onTvReport({ loadId: 1, state: 'ended', position: 30 })
  assert.equal(r.state, 'STOPPED')
  assert.equal(r.position(), 30)
  assert.ok(changes.some(c => c.TransportState === 'STOPPED'))
  assert.equal(tv.sent.length, 1, 'ended does not send anything to TV')
})

test('play from STOPPED re-loads; pause/play round trip; stop; seek', () => {
  const { r, tv } = make()
  r.setUri('http://x/a.mp4', '')
  r.onTvReport({ loadId: 1, state: 'ended', position: 10, duration: 10 })
  r.play()
  assert.equal(tv.sent.at(-1).cmd, 'load')
  assert.equal(r.state, 'TRANSITIONING')
  r.onTvReport({ loadId: 1, state: 'playing', position: 0, duration: 10 })
  r.pause()
  assert.equal(tv.sent.at(-1).cmd, 'pause')
  assert.equal(r.state, 'PAUSED_PLAYBACK')
  r.play()
  assert.equal(tv.sent.at(-1).cmd, 'play')
  assert.equal(r.state, 'PLAYING')
  r.seek(7)
  assert.equal(tv.sent.at(-1).cmd, 'seek')
  assert.equal(tv.sent.at(-1).position, 7)
  assert.ok(Math.abs(r.position() - 7) < 0.01)
  r.stop()
  assert.equal(tv.sent.at(-1).cmd, 'stop')
  assert.equal(r.state, 'STOPPED')
  assert.equal(r.position(), 0)
})

test('second SetAVTransportURI while playing bumps loadId and supersedes', () => {
  const { r, tv } = make()
  r.setUri('http://x/a.mp4', '')
  r.onTvReport({ loadId: 1, state: 'playing', position: 3, duration: 10 })
  r.setUri('http://x/b.mp4', '')
  assert.equal(r.loadId, 2)
  assert.equal(r.state, 'TRANSITIONING')
  assert.equal(r.position(), 0)
  assert.equal(tv.sent.at(-1).loadId, 2)
})

test('volume/mute from phone and from TV', () => {
  const { r, tv } = make()
  const rcs = []
  r.on('rcs', v => rcs.push(v))
  r.setVolume('30')
  assert.equal(r.volume, 30)
  assert.equal(tv.sent.at(-1).cmd, 'volume')
  r.setMute(true)
  assert.equal(tv.sent.at(-1).cmd, 'mute')
  r.onTvReport({ volume: 55, mute: false })
  assert.equal(r.volume, 55)
  assert.equal(r.mute, false)
  assert.ok(rcs.some(v => v.Volume === 55))
})

test('TV going offline while playing drops to STOPPED', () => {
  const { r } = make()
  r.setUri('http://x/a.mp4', '')
  r.onTvReport({ loadId: 1, state: 'playing', position: 0, duration: 30 })
  r.onTvOffline()
  assert.equal(r.state, 'STOPPED')
})

test('AVT action dispatcher: GetPositionInfo / GetTransportInfo / Seek parsing', () => {
  const { r, tick } = make()
  const acts = avtActions(r)
  acts.SetAVTransportURI('<CurrentURI>http://x/a.mp4</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>')
  r.onTvReport({ loadId: 1, state: 'playing', position: 0, duration: 83 })
  tick(5000)
  const pi = acts.GetPositionInfo()
  assert.equal(pi.TrackDuration, '0:01:23')
  assert.equal(pi.RelTime, '0:00:05')
  assert.equal(pi.TrackURI, 'http://x/a.mp4')
  const ti = acts.GetTransportInfo()
  assert.equal(ti.CurrentTransportState, 'PLAYING')
  acts.Seek('<Unit>REL_TIME</Unit><Target>0:00:40</Target>')
  assert.ok(Math.abs(r.position() - 40) < 0.01)
  assert.throws(() => acts.Seek('<Unit>REL_TIME</Unit><Target>zz</Target>'), e => e.upnpCode === 711)
  assert.throws(() => acts.Seek('<Unit>X</Unit><Target>1</Target>'), e => e.upnpCode === 710)
  assert.equal(acts.GetMediaInfo().NrTracks, 1)
  assert.equal(acts.GetCurrentTransportActions().Actions, 'Pause,Stop,Seek,Next')
})
