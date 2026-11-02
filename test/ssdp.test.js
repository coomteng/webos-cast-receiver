'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { createSsdp, targetsOf } = require('../server/ssdp.js')

function fakeSocket() {
  const sent = []
  return {
    sent, handlers: {},
    on(ev, fn) { this.handlers[ev] = fn },
    bind(port, cb) { this.bound = port; cb && cb() },
    addMembership(addr, iface) { this.membership = { addr, iface } },
    setMulticastInterface(iface) { this.mcastIface = iface },
    setMulticastTTL() {},
    send(msg, port, addr) { sent.push({ msg: String(msg), port, addr }) },
    close() { this.closed = true },
  }
}

function makeSsdp(sock, extra = {}) {
  return createSsdp({
    uuid: 'abc-123', location: 'http://192.168.0.9:8790/dlna/device.xml',
    createSocket: () => sock, setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {},
    setTimeoutFn: fn => fn(), log: () => {}, ...extra,
  })
}

test('targets cover renderer + 3 services', () => {
  const t = targetsOf('x')
  assert.ok(t.includes('urn:schemas-upnp-org:device:MediaRenderer:1'))
  assert.ok(t.includes('urn:schemas-upnp-org:service:AVTransport:1'))
  assert.equal(t.length, 6)
})

test('start binds 1900, joins group, sends alive twice for all targets', () => {
  const sock = fakeSocket()
  makeSsdp(sock).start()
  assert.equal(sock.bound, 1900)
  assert.equal(sock.membership.addr, '239.255.255.250')
  const alive = sock.sent.filter(s => s.msg.includes('ssdp:alive'))
  assert.equal(alive.length, 12)
  assert.ok(alive[0].msg.includes('LOCATION: http://192.168.0.9:8790/dlna/device.xml'))
})

test('M-SEARCH for MediaRenderer answers once, unicast to sender', () => {
  const sock = fakeSocket()
  const s = makeSsdp(sock)
  s.start()
  sock.sent.length = 0
  const msg = 'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n'
  s._onMessage(Buffer.from(msg), { address: '192.168.0.50', port: 41000 })
  assert.equal(sock.sent.length, 1)
  assert.equal(sock.sent[0].addr, '192.168.0.50')
  assert.equal(sock.sent[0].port, 41000)
  assert.match(sock.sent[0].msg, /^HTTP\/1\.1 200 OK/)
  assert.match(sock.sent[0].msg, /USN: uuid:abc-123::urn:schemas-upnp-org:device:MediaRenderer:1/)
})

test('M-SEARCH ssdp:all answers for every target; MediaServer ST ignored', () => {
  const sock = fakeSocket()
  const s = makeSsdp(sock)
  s.start(); sock.sent.length = 0
  s._onMessage(Buffer.from('M-SEARCH * HTTP/1.1\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n'), { address: 'a', port: 1 })
  assert.equal(sock.sent.length, 6)
  sock.sent.length = 0
  s._onMessage(Buffer.from('M-SEARCH * HTTP/1.1\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:MediaServer:1\r\n\r\n'), { address: 'a', port: 1 })
  assert.equal(sock.sent.length, 0)
})

test('stop sends byebye', () => {
  const sock = fakeSocket()
  const s = makeSsdp(sock)
  s.start(); sock.sent.length = 0
  s.stop()
  assert.equal(sock.sent.filter(x => x.msg.includes('ssdp:byebye')).length, 6)
  assert.ok(sock.closed)
})
