'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { createTvChannel } = require('../server/tvchannel.js')

function harness() {
  let t = 0
  const timers = []
  const changes = []
  let offline = 0
  const ch = createTvChannel({
    timeoutMs: 1000, pollMs: 5000, now: () => t,
    setTimeoutFn: (fn, ms) => { const h = { fn, at: t + ms, unref() {} }; timers.push(h); return h },
    clearTimeoutFn: h => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1) },
    onOffline: () => { offline += 1 },
    onActiveChange: (n, p) => changes.push([p && p.id, n && n.id]),
  })
  const tick = ms => { t += ms; for (const h of timers.splice(0).filter(h => h.at <= t)) h.fn(); }
  const poll = (client, role) => { const out = {}; ch.poll({ client, role, after: 0, respond: o => Object.assign(out, o), info: { ip: client } }); return out }
  return { ch, tick, poll, changes, offline: () => offline }
}

test('web screen alone becomes active and receives commands', () => {
  const { ch, poll } = harness()
  const r = poll('web1', 'web')
  assert.equal(r.active, true)
  assert.deepEqual(r.commands.map(c => c.cmd), ['active'])
  assert.equal(ch.isOnline(), true)
  const r2 = poll('web1', 'web')
  ch.send({ cmd: 'play' })
  assert.deepEqual(r2.commands.map(c => c.cmd), ['play'])
})

test('TV joining takes over from web; web gets standby; TV leaving hands back', () => {
  const { ch, poll, tick, changes } = harness()
  const w = poll('web1', 'web')          // active
  const w2 = poll('web1', 'web')         // parked
  const tv = poll('tv1', 'tv')
  assert.equal(tv.active, true)
  assert.deepEqual(tv.commands.map(c => c.cmd), ['active'])
  assert.deepEqual(w2.commands.map(c => c.cmd), ['standby'])
  assert.equal(w2.active, false)
  assert.deepEqual(changes, [[null, 'web1'], ['web1', 'tv1']])
  // web keeps polling, TV stops -> after timeout web is active again
  tick(600); poll('web1', 'web')
  tick(600) // tv lastSeen now 1200 ago -> dead
  ch.reconcile()
  assert.equal(ch.activeClient().id, 'web1')
  assert.equal(changes.at(-1)[1], 'web1')
})

test('reports from non-active screens are flagged false', () => {
  const { ch, poll } = harness()
  poll('tv1', 'tv'); poll('web1', 'web')
  assert.equal(ch.report({ client: 'web1', role: 'web', info: {} }), false)
  assert.equal(ch.report({ client: 'tv1', role: 'tv', info: {} }), true)
})

test('everyone gone -> offline callback once', () => {
  const { ch, poll, tick, offline } = harness()
  poll('web1', 'web')
  tick(1200)
  assert.equal(ch.isOnline(), false)
  assert.equal(offline(), 1)
})
