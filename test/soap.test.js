'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { actionFromSoapAction, soapArg, soapResponse, soapFault, parseTime, formatTime } = require('../server/soap.js')
const { deviceDescription, avtScpd, rcsScpd, cmsScpd } = require('../server/deviceXml.js')

test('actionFromSoapAction handles quoted/unquoted', () => {
  assert.equal(actionFromSoapAction('"urn:schemas-upnp-org:service:AVTransport:1#Play"'), 'Play')
  assert.equal(actionFromSoapAction('urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI'), 'SetAVTransportURI')
  assert.equal(actionFromSoapAction(undefined), null)
})

test('soapArg extracts by local name and unescapes', () => {
  const body = '<s:Envelope><s:Body><u:SetAVTransportURI xmlns:u="x"><InstanceID>0</InstanceID>' +
    '<CurrentURI>http://a/b?x=1&amp;y=2</CurrentURI><CurrentURIMetaData>&lt;DIDL-Lite&gt;&lt;/DIDL-Lite&gt;</CurrentURIMetaData>' +
    '</u:SetAVTransportURI></s:Body></s:Envelope>'
  assert.equal(soapArg(body, 'CurrentURI'), 'http://a/b?x=1&y=2')
  assert.equal(soapArg(body, 'CurrentURIMetaData'), '<DIDL-Lite></DIDL-Lite>')
  assert.equal(soapArg(body, 'Nope'), null)
})

test('soapResponse / soapFault shapes', () => {
  const r = soapResponse('urn:x', 'GetVolume', { CurrentVolume: 42 })
  assert.match(r, /<u:GetVolumeResponse xmlns:u="urn:x"><CurrentVolume>42<\/CurrentVolume><\/u:GetVolumeResponse>/)
  const f = soapFault(701, 'Transition not available')
  assert.match(f, /<errorCode>701<\/errorCode>/)
  assert.match(f, /<faultstring>UPnPError<\/faultstring>/)
})

test('time parse/format', () => {
  assert.equal(parseTime('0:01:23'), 83)
  assert.equal(parseTime('00:00:05.500'), 5.5)
  assert.equal(parseTime('1:02'), 62)
  assert.equal(parseTime('12'), 12)
  assert.ok(Number.isNaN(parseTime('abc')))
  assert.equal(formatTime(83), '0:01:23')
  assert.equal(formatTime(3725.9), '1:02:05')
  assert.equal(formatTime(NaN), '0:00:00')
})

test('device description is a MediaRenderer with 3 services and escaped name', () => {
  const x = deviceDescription({ uuid: 'u1', friendlyName: '客厅 & 电视', manufacturer: 'M', modelName: 'N' })
  assert.match(x, /<deviceType>urn:schemas-upnp-org:device:MediaRenderer:1<\/deviceType>/)
  assert.match(x, /<friendlyName>客厅 &amp; 电视<\/friendlyName>/)
  assert.match(x, /<UDN>uuid:u1<\/UDN>/)
  assert.equal((x.match(/<service>/g) || []).length, 3)
  assert.match(x, /<controlURL>\/dlna\/avt\/control<\/controlURL>/)
  assert.match(x, /<eventSubURL>\/dlna\/avt\/event<\/eventSubURL>/)
})

test('SCPDs list the actions the dispatcher implements', () => {
  const { avtActions, rcsActions, cmsActions } = require('../server/actions.js')
  const stub = { uri: '', state: 'NO_MEDIA_PRESENT', currentActions: () => '' }
  for (const [scpd, acts] of [[avtScpd(), avtActions(stub)], [rcsScpd(), rcsActions(stub)], [cmsScpd(), cmsActions()]]) {
    const listed = [...scpd.matchAll(/<action><name>([A-Za-z]+)<\/name>/g)].map(m => m[1])
    for (const a of listed) assert.ok(typeof acts[a] === 'function', a + ' listed but not implemented')
    for (const a of Object.keys(acts)) assert.ok(listed.includes(a), a + ' implemented but not listed')
  }
})
