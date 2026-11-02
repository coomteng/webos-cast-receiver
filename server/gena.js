// GENA eventing: SUBSCRIBE / renew / UNSUBSCRIBE per service, and NOTIFY
// delivery of LastChange (AVTransport / RenderingControl) and plain
// variables (ConnectionManager). This is how the phone learns about
// TransportState changes — in particular STOPPED after a clip ends.
//
// LastChange format (AVT): <Event xmlns="urn:schemas-upnp-org:metadata-1-0/AVT/">
//   <InstanceID val="0"><TransportState val="STOPPED"/>...</InstanceID></Event>
// embedded XML-escaped inside <e:property><LastChange>..</LastChange></e:property>.
'use strict'

const http = require('node:http')
const crypto = require('node:crypto')
const { xmlEscape } = require('./xml.js')
const { formatTime } = require('./soap.js')

const DEFAULT_TIMEOUT = 300 // s
const MAX_TIMEOUT = 1800
const MODERATION_MS = 200   // coalesce bursts of LastChange

const LASTCHANGE_NS = {
  avt: 'urn:schemas-upnp-org:metadata-1-0/AVT/',
  rcs: 'urn:schemas-upnp-org:metadata-1-0/RCS/',
}

function parseCallback(header) {
  if (!header) return []
  return [...String(header).matchAll(/<([^>]+)>/g)].map(m => m[1]).filter(u => /^http:\/\//i.test(u))
}

function parseTimeout(header) {
  if (!header) return DEFAULT_TIMEOUT
  const m = String(header).match(/Second-(\d+|infinite)/i)
  if (!m) return DEFAULT_TIMEOUT
  if (m[1] === 'infinite') return MAX_TIMEOUT
  return Math.max(30, Math.min(MAX_TIMEOUT, parseInt(m[1], 10)))
}

// Value formatting inside LastChange: times are "H:MM:SS", others as-is.
function formatVar(name, value) {
  if (/Duration|TimePosition/.test(name) && typeof value === 'number') return formatTime(value)
  return value
}

function lastChangeXml(service, vars) {
  let inner = ''
  for (const k of Object.keys(vars)) {
    const v = formatVar(k, vars[k])
    if (service === 'rcs' && (k === 'Volume' || k === 'Mute')) {
      inner += `<${k} channel="Master" val="${xmlEscape(v)}"/>`
    } else {
      inner += `<${k} val="${xmlEscape(v)}"/>`
    }
  }
  return `<Event xmlns="${LASTCHANGE_NS[service]}"><InstanceID val="0">${inner}</InstanceID></Event>`
}

function propertySet(props) {
  let body = '<?xml version="1.0" encoding="utf-8"?><e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">'
  for (const k of Object.keys(props)) body += `<e:property><${k}>${xmlEscape(props[k])}</${k}></e:property>`
  return body + '</e:propertyset>'
}

function createGena({ renderer, request, now, setTimeoutFn, clearTimeoutFn, log } = {}) {
  const doRequest = request || http.request
  const clock = now || Date.now
  const setT = setTimeoutFn || setTimeout
  const clearT = clearTimeoutFn || clearTimeout
  const logf = log || (() => {})
  // sid -> { service, callbacks, expires, seq }
  const subs = new Map()
  // Pending (moderated) LastChange per service
  const pending = { avt: {}, rcs: {} }
  const timers = { avt: null, rcs: null }

  function initialState(service) {
    if (service === 'avt') {
      const r = renderer
      return {
        TransportState: r.state, TransportStatus: r.status, CurrentTransportActions: r.currentActions(),
        AVTransportURI: r.uri, AVTransportURIMetaData: r.metadata,
        CurrentTrackURI: r.uri, CurrentTrackMetaData: r.metadata,
        CurrentTrackDuration: r.duration, CurrentMediaDuration: r.duration,
        NumberOfTracks: r.uri ? 1 : 0, CurrentTrack: r.uri ? 1 : 0,
        NextAVTransportURI: r.nextUri, NextAVTransportURIMetaData: r.nextMetadata,
        PlaybackStorageMedium: r.uri ? 'NETWORK' : 'NONE', CurrentPlayMode: 'NORMAL', TransportPlaySpeed: '1',
      }
    }
    if (service === 'rcs') return { Volume: renderer.volume, Mute: renderer.mute ? 1 : 0 }
    return null
  }

  function initialProps(service) {
    if (service === 'cms') {
      const { SINK_PROTOCOL_INFO } = require('./deviceXml.js')
      return { SourceProtocolInfo: '', SinkProtocolInfo: SINK_PROTOCOL_INFO, CurrentConnectionIDs: '0' }
    }
    return { LastChange: lastChangeXml(service, initialState(service)) }
  }

  function send(sub, sid, props) {
    const body = propertySet(props)
    for (const cb of sub.callbacks) {
      let u
      try { u = new URL(cb) } catch (e) { continue }
      const req = doRequest({
        method: 'NOTIFY', hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search,
        headers: {
          'content-type': 'text/xml; charset="utf-8"',
          'content-length': Buffer.byteLength(body),
          NT: 'upnp:event', NTS: 'upnp:propchange', SID: sid, SEQ: String(sub.seq),
          connection: 'close',
        },
        timeout: 5000,
      }, res => { res.resume() })
      req.on('timeout', () => req.destroy())
      req.on('error', e => logf('notify failed', sid, cb, e.message))
      req.end(body)
      break // spec: deliver to the first reachable callback; keep it simple
    }
    sub.seq = (sub.seq + 1) % 4294967296
  }

  function flush(service) {
    timers[service] = null
    const vars = pending[service]
    pending[service] = {}
    if (Object.keys(vars).length === 0) return
    const props = { LastChange: lastChangeXml(service, vars) }
    for (const [sid, sub] of subs) {
      if (sub.service === service) send(sub, sid, props)
    }
  }

  function queue(service, vars) {
    Object.assign(pending[service], vars)
    if (!timers[service]) timers[service] = setT(() => flush(service), MODERATION_MS)
  }

  if (renderer) {
    renderer.on('change', vars => queue('avt', vars))
    renderer.on('rcs', vars => queue('rcs', vars))
  }

  function purge() {
    const t = clock()
    for (const [sid, sub] of subs) if (sub.expires <= t) subs.delete(sid)
  }

  // Returns { status, headers } for the HTTP layer. service: 'avt'|'rcs'|'cms'
  function subscribe(service, headers) {
    purge()
    const sidHdr = headers.sid
    const timeout = parseTimeout(headers.timeout)
    if (sidHdr) {
      const sub = subs.get(sidHdr)
      if (!sub || sub.service !== service) return { status: 412 }
      if (headers.callback || headers.nt) return { status: 400 }
      sub.expires = clock() + timeout * 1000
      return { status: 200, headers: { SID: sidHdr, TIMEOUT: `Second-${timeout}` } }
    }
    if (String(headers.nt || '').trim() !== 'upnp:event') return { status: 412 }
    const callbacks = parseCallback(headers.callback)
    if (callbacks.length === 0) return { status: 412 }
    if (subs.size > 64) purge()
    const sid = 'uuid:' + crypto.randomUUID()
    const sub = { service, callbacks, expires: clock() + timeout * 1000, seq: 0 }
    subs.set(sid, sub)
    logf('subscribe', service, sid, callbacks[0])
    // Initial event must go after the SUBSCRIBE response; next tick is enough.
    setT(() => { if (subs.has(sid)) send(sub, sid, initialProps(service)) }, 50)
    return { status: 200, headers: { SID: sid, TIMEOUT: `Second-${timeout}` } }
  }

  function unsubscribe(service, headers) {
    const sid = headers.sid
    if (!sid) return { status: 412 }
    const sub = subs.get(sid)
    if (!sub || sub.service !== service) return { status: 412 }
    subs.delete(sid)
    return { status: 200 }
  }

  return { subscribe, unsubscribe, flush, _subs: subs, _lastChangeXml: lastChangeXml, _propertySet: propertySet }
}

module.exports = { createGena, lastChangeXml, propertySet, parseCallback, parseTimeout }
