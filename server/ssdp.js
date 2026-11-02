// SSDP advertiser for a MediaRenderer. Joins 239.255.255.250:1900, answers
// M-SEARCH for our targets, sends NOTIFY ssdp:alive periodically and a byebye
// burst on shutdown. dgram is injectable so tests use a fake socket.
// Adapted from lx-dlna-server/src/ssdp.js (MediaServer -> MediaRenderer).
'use strict'

const dgram = require('node:dgram')

const SSDP_ADDR = '239.255.255.250'
const SSDP_PORT = 1900
const MAX_AGE = 1800
const SERVER_HDR = 'Linux/4.4 UPnP/1.0 webos-cast-receiver/1'

function targetsOf(uuid) {
  return [
    'upnp:rootdevice',
    `uuid:${uuid}`,
    'urn:schemas-upnp-org:device:MediaRenderer:1',
    'urn:schemas-upnp-org:service:AVTransport:1',
    'urn:schemas-upnp-org:service:RenderingControl:1',
    'urn:schemas-upnp-org:service:ConnectionManager:1',
  ]
}

function usnFor(uuid, st) {
  return st === `uuid:${uuid}` ? st : `uuid:${uuid}::${st}`
}

function createSsdp({ uuid, location, bindAddr, createSocket, setIntervalFn, clearIntervalFn, setTimeoutFn, log } = {}) {
  const mkSocket = createSocket || (opts => dgram.createSocket(opts))
  const setI = setIntervalFn || setInterval
  const clearI = clearIntervalFn || clearInterval
  const setT = setTimeoutFn || setTimeout
  const logf = log || ((...a) => console.log('[ssdp]', ...a))
  let socket = null
  let timer = null

  function mSearchResponse(st) {
    return 'HTTP/1.1 200 OK\r\n' +
      `CACHE-CONTROL: max-age=${MAX_AGE}\r\n` +
      'DATE: ' + new Date().toUTCString() + '\r\n' +
      'EXT:\r\n' +
      `LOCATION: ${location}\r\n` +
      `SERVER: ${SERVER_HDR}\r\n` +
      `ST: ${st}\r\n` +
      `USN: ${usnFor(uuid, st)}\r\n` +
      '\r\n'
  }

  function notifyPacket(nt, nts) {
    return 'NOTIFY * HTTP/1.1\r\n' +
      `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
      `CACHE-CONTROL: max-age=${MAX_AGE}\r\n` +
      `LOCATION: ${location}\r\n` +
      `NT: ${nt}\r\n` +
      `NTS: ${nts}\r\n` +
      `SERVER: ${SERVER_HDR}\r\n` +
      `USN: ${usnFor(uuid, nt)}\r\n` +
      '\r\n'
  }

  function matchTargets(st) {
    if (st === 'ssdp:all') return targetsOf(uuid)
    return targetsOf(uuid).filter(t => t === st)
  }

  function onMessage(msg, rinfo) {
    const text = msg.toString('utf8')
    if (!/^M-SEARCH \* HTTP\/1\.1/i.test(text)) return
    if (!/MAN:\s*"ssdp:discover"/i.test(text)) return
    const stMatch = text.match(/^ST:\s*(.+?)\s*$/im)
    if (!stMatch) return
    const answers = matchTargets(stMatch[1])
    if (answers.length === 0) return
    const mxMatch = text.match(/^MX:\s*(\d+)/im)
    const mx = Math.min(mxMatch ? parseInt(mxMatch[1], 10) : 1, 3)
    for (const st of answers) {
      // Spread over [0, min(MX,3)) s but keep the first answer fast: phone
      // UIs often list devices as soon as one response lands.
      const delay = Math.floor(Math.random() * Math.max(mx * 300, 100))
      setT(() => {
        if (!socket) return
        try { socket.send(mSearchResponse(st), rinfo.port, rinfo.address) } catch (e) { /* socket gone */ }
      }, delay)
    }
  }

  function notifyAll(nts) {
    for (const nt of targetsOf(uuid)) {
      try { socket.send(notifyPacket(nt, nts), SSDP_PORT, SSDP_ADDR) } catch (e) { /* best effort */ }
    }
  }

  function start() {
    socket = mkSocket({ type: 'udp4', reuseAddr: true })
    socket.on('message', onMessage)
    socket.on('error', e => logf('socket error:', e.message))
    socket.bind(SSDP_PORT, () => {
      try {
        socket.addMembership(SSDP_ADDR, bindAddr || undefined)
        if (bindAddr) socket.setMulticastInterface(bindAddr)
        if (socket.setMulticastTTL) socket.setMulticastTTL(4)
      } catch (e) {
        logf('membership failed:', e.message)
      }
      // Spec: send alive twice at start (UDP may lose the first).
      notifyAll('ssdp:alive')
      setT(() => { if (socket) notifyAll('ssdp:alive') }, 600)
      logf(`advertising ${location} (uuid:${uuid})`)
    })
    timer = setI(() => { if (socket) notifyAll('ssdp:alive') }, (MAX_AGE / 2) * 1000)
    if (timer && timer.unref) timer.unref()
  }

  function stop() {
    if (timer) { clearI(timer); timer = null }
    if (socket) {
      try { notifyAll('ssdp:byebye') } catch (e) { /* best effort */ }
      const s = socket
      socket = null
      setT(() => { try { s.close() } catch (e) { /* already closed */ } }, 100)
    }
  }

  return { start, stop, _onMessage: onMessage, _mSearchResponse: mSearchResponse, _notifyPacket: notifyPacket }
}

module.exports = { createSsdp, targetsOf, SSDP_ADDR, SSDP_PORT }
