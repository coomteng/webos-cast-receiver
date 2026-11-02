// SOAP request parsing and response envelopes. Tolerant regex over the
// body: control points disagree on prefixes, the tag LOCAL name is the
// contract. (Same stance as lx-dlna-server/src/soap.js.)
'use strict'

const { xmlEscape, xmlUnescape, tagValue } = require('./xml.js')

// 'urn:...:service:AVTransport:1#Play' -> 'Play'. Header may be quoted.
function actionFromSoapAction(header) {
  if (!header) return null
  const m = String(header).match(/#([A-Za-z0-9_]+)"?\s*$/)
  return m ? m[1] : null
}

function soapArg(body, name) {
  const v = tagValue(body, name)
  return v === null ? null : xmlUnescape(v)
}

function soapResponse(service, action, args) {
  let inner = ''
  for (const k of Object.keys(args || {})) inner += `<${k}>${xmlEscape(args[k])}</${k}>`
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"' +
    ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action}Response xmlns:u="${service}">` +
    inner +
    `</u:${action}Response></s:Body></s:Envelope>`
}

// UPnP error codes: 401 invalid action, 402 invalid args, 501 action failed,
// 701 transition not available, 710 seek mode not supported, 711 illegal
// seek target, 714 illegal MIME type, 716 resource not found.
function soapFault(code, description) {
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"' +
    ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body><s:Fault>' +
    '<faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>' +
    '<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">' +
    `<errorCode>${code}</errorCode><errorDescription>${xmlEscape(description)}</errorDescription>` +
    '</UPnPError></detail></s:Fault></s:Body></s:Envelope>'
}

class UpnpError extends Error {
  constructor(code, description) {
    super(description)
    this.upnpCode = code
  }
}

// "0:01:23", "00:01:23.500", "1:23" or plain seconds -> seconds (float).
function parseTime(s) {
  if (s === null || s === undefined) return NaN
  const t = String(s).trim()
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t)
  const m = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/)
  if (!m) return NaN
  const h = parseInt(m[1] || '0', 10)
  const mm = parseInt(m[2], 10)
  const ss = parseInt(m[3], 10)
  const frac = m[4] ? parseFloat('0.' + m[4]) : 0
  return h * 3600 + mm * 60 + ss + frac
}

// seconds -> "H:MM:SS" (UPnP time format; no fraction, most CPs choke on it)
function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0
  const s = Math.floor(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

module.exports = { actionFromSoapAction, soapArg, soapResponse, soapFault, UpnpError, parseTime, formatTime }
