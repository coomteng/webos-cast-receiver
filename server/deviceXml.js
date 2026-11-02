// UPnP MediaRenderer device description + the three SCPDs. Static templates;
// the only dynamic parts are uuid / friendlyName / manufacturer / model.
// Every action listed in an SCPD is implemented in avtransport.js /
// renderingcontrol.js / connectionmanager.js — control points read these to
// decide what they may call.
'use strict'

const { xmlEscape } = require('./xml.js')

const AVT = 'urn:schemas-upnp-org:service:AVTransport:1'
const RCS = 'urn:schemas-upnp-org:service:RenderingControl:1'
const CMS = 'urn:schemas-upnp-org:service:ConnectionManager:1'

function deviceDescription({ uuid, friendlyName, manufacturer, modelName }) {
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:dlna="urn:schemas-dlna-org:device-1-0">' +
    '<specVersion><major>1</major><minor>0</minor></specVersion>' +
    '<device>' +
    '<deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>' +
    `<friendlyName>${xmlEscape(friendlyName)}</friendlyName>` +
    `<manufacturer>${xmlEscape(manufacturer)}</manufacturer>` +
    '<manufacturerURL>https://github.com/coomteng/webos-cast-receiver</manufacturerURL>' +
    `<modelName>${xmlEscape(modelName)}</modelName>` +
    '<modelDescription>DLNA renderer relaying to an LG webOS TV</modelDescription>' +
    '<modelNumber>1.0</modelNumber>' +
    `<UDN>uuid:${uuid}</UDN>` +
    '<dlna:X_DLNADOC>DMR-1.50</dlna:X_DLNADOC>' +
    '<serviceList>' +
    service(AVT, 'AVTransport', '/dlna/avt') +
    service(RCS, 'RenderingControl', '/dlna/rcs') +
    service(CMS, 'ConnectionManager', '/dlna/cms') +
    '</serviceList>' +
    '</device></root>'
}

function service(type, id, prefix) {
  return '<service>' +
    `<serviceType>${type}</serviceType>` +
    `<serviceId>urn:upnp-org:serviceId:${id}</serviceId>` +
    `<SCPDURL>${prefix}.xml</SCPDURL>` +
    `<controlURL>${prefix}/control</controlURL>` +
    `<eventSubURL>${prefix}/event</eventSubURL>` +
    '</service>'
}

function arg(name, dir, variable) {
  return `<argument><name>${name}</name><direction>${dir}</direction><relatedStateVariable>${variable}</relatedStateVariable></argument>`
}
function action(name, args) {
  return `<action><name>${name}</name><argumentList>${args.join('')}</argumentList></action>`
}
function sv(name, type, { events = false, allowed = null, def = null } = {}) {
  let s = `<stateVariable sendEvents="${events ? 'yes' : 'no'}"><name>${name}</name><dataType>${type}</dataType>`
  if (def !== null) s += `<defaultValue>${def}</defaultValue>`
  if (allowed) s += '<allowedValueList>' + allowed.map(v => `<allowedValue>${v}</allowedValue>`).join('') + '</allowedValueList>'
  return s + '</stateVariable>'
}
function scpd(actions, vars) {
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<scpd xmlns="urn:schemas-upnp-org:service-1-0">' +
    '<specVersion><major>1</major><minor>0</minor></specVersion>' +
    `<actionList>${actions.join('')}</actionList>` +
    `<serviceStateTable>${vars.join('')}</serviceStateTable></scpd>`
}

const ID = arg('InstanceID', 'in', 'A_ARG_TYPE_InstanceID')

function avtScpd() {
  return scpd([
    action('SetAVTransportURI', [ID, arg('CurrentURI', 'in', 'AVTransportURI'), arg('CurrentURIMetaData', 'in', 'AVTransportURIMetaData')]),
    action('SetNextAVTransportURI', [ID, arg('NextURI', 'in', 'NextAVTransportURI'), arg('NextURIMetaData', 'in', 'NextAVTransportURIMetaData')]),
    action('GetMediaInfo', [ID,
      arg('NrTracks', 'out', 'NumberOfTracks'), arg('MediaDuration', 'out', 'CurrentMediaDuration'),
      arg('CurrentURI', 'out', 'AVTransportURI'), arg('CurrentURIMetaData', 'out', 'AVTransportURIMetaData'),
      arg('NextURI', 'out', 'NextAVTransportURI'), arg('NextURIMetaData', 'out', 'NextAVTransportURIMetaData'),
      arg('PlayMedium', 'out', 'PlaybackStorageMedium'), arg('RecordMedium', 'out', 'RecordStorageMedium'),
      arg('WriteStatus', 'out', 'RecordMediumWriteStatus')]),
    action('GetTransportInfo', [ID,
      arg('CurrentTransportState', 'out', 'TransportState'), arg('CurrentTransportStatus', 'out', 'TransportStatus'),
      arg('CurrentSpeed', 'out', 'TransportPlaySpeed')]),
    action('GetPositionInfo', [ID,
      arg('Track', 'out', 'CurrentTrack'), arg('TrackDuration', 'out', 'CurrentTrackDuration'),
      arg('TrackMetaData', 'out', 'CurrentTrackMetaData'), arg('TrackURI', 'out', 'CurrentTrackURI'),
      arg('RelTime', 'out', 'RelativeTimePosition'), arg('AbsTime', 'out', 'AbsoluteTimePosition'),
      arg('RelCount', 'out', 'RelativeCounterPosition'), arg('AbsCount', 'out', 'AbsoluteCounterPosition')]),
    action('GetDeviceCapabilities', [ID,
      arg('PlayMedia', 'out', 'PossiblePlaybackStorageMedia'), arg('RecMedia', 'out', 'PossibleRecordStorageMedia'),
      arg('RecQualityModes', 'out', 'PossibleRecordQualityModes')]),
    action('GetTransportSettings', [ID, arg('PlayMode', 'out', 'CurrentPlayMode'), arg('RecQualityMode', 'out', 'CurrentRecordQualityMode')]),
    action('Stop', [ID]),
    action('Play', [ID, arg('Speed', 'in', 'TransportPlaySpeed')]),
    action('Pause', [ID]),
    action('Seek', [ID, arg('Unit', 'in', 'A_ARG_TYPE_SeekMode'), arg('Target', 'in', 'A_ARG_TYPE_SeekTarget')]),
    action('Next', [ID]),
    action('Previous', [ID]),
    action('SetPlayMode', [ID, arg('NewPlayMode', 'in', 'CurrentPlayMode')]),
    action('GetCurrentTransportActions', [ID, arg('Actions', 'out', 'CurrentTransportActions')]),
  ], [
    sv('TransportState', 'string', { allowed: ['STOPPED', 'PLAYING', 'TRANSITIONING', 'PAUSED_PLAYBACK', 'NO_MEDIA_PRESENT'] }),
    sv('TransportStatus', 'string', { allowed: ['OK', 'ERROR_OCCURRED'] }),
    sv('PlaybackStorageMedium', 'string', { allowed: ['NETWORK', 'NONE'] }),
    sv('RecordStorageMedium', 'string', { allowed: ['NOT_IMPLEMENTED'] }),
    sv('PossiblePlaybackStorageMedia', 'string'),
    sv('PossibleRecordStorageMedia', 'string'),
    sv('CurrentPlayMode', 'string', { allowed: ['NORMAL'], def: 'NORMAL' }),
    sv('TransportPlaySpeed', 'string', { allowed: ['1'] }),
    sv('RecordMediumWriteStatus', 'string', { allowed: ['NOT_IMPLEMENTED'] }),
    sv('CurrentRecordQualityMode', 'string', { allowed: ['NOT_IMPLEMENTED'] }),
    sv('PossibleRecordQualityModes', 'string'),
    sv('NumberOfTracks', 'ui4'),
    sv('CurrentTrack', 'ui4'),
    sv('CurrentTrackDuration', 'string'),
    sv('CurrentMediaDuration', 'string'),
    sv('CurrentTrackMetaData', 'string'),
    sv('CurrentTrackURI', 'string'),
    sv('AVTransportURI', 'string'),
    sv('AVTransportURIMetaData', 'string'),
    sv('NextAVTransportURI', 'string'),
    sv('NextAVTransportURIMetaData', 'string'),
    sv('RelativeTimePosition', 'string'),
    sv('AbsoluteTimePosition', 'string'),
    sv('RelativeCounterPosition', 'i4'),
    sv('AbsoluteCounterPosition', 'i4'),
    sv('CurrentTransportActions', 'string'),
    sv('LastChange', 'string', { events: true }),
    sv('A_ARG_TYPE_SeekMode', 'string', { allowed: ['REL_TIME', 'ABS_TIME', 'TRACK_NR'] }),
    sv('A_ARG_TYPE_SeekTarget', 'string'),
    sv('A_ARG_TYPE_InstanceID', 'ui4'),
  ])
}

const CH = arg('Channel', 'in', 'A_ARG_TYPE_Channel')

function rcsScpd() {
  return scpd([
    action('ListPresets', [ID, arg('CurrentPresetNameList', 'out', 'PresetNameList')]),
    action('SelectPreset', [ID, arg('PresetName', 'in', 'A_ARG_TYPE_PresetName')]),
    action('GetMute', [ID, CH, arg('CurrentMute', 'out', 'Mute')]),
    action('SetMute', [ID, CH, arg('DesiredMute', 'in', 'Mute')]),
    action('GetVolume', [ID, CH, arg('CurrentVolume', 'out', 'Volume')]),
    action('SetVolume', [ID, CH, arg('DesiredVolume', 'in', 'Volume')]),
  ], [
    sv('PresetNameList', 'string'),
    sv('LastChange', 'string', { events: true }),
    sv('Mute', 'boolean'),
    '<stateVariable sendEvents="no"><name>Volume</name><dataType>ui2</dataType>' +
      '<allowedValueRange><minimum>0</minimum><maximum>100</maximum><step>1</step></allowedValueRange></stateVariable>',
    sv('A_ARG_TYPE_Channel', 'string', { allowed: ['Master'] }),
    sv('A_ARG_TYPE_InstanceID', 'ui4'),
    sv('A_ARG_TYPE_PresetName', 'string', { allowed: ['FactoryDefaults'] }),
  ])
}

function cmsScpd() {
  return scpd([
    action('GetProtocolInfo', [arg('Source', 'out', 'SourceProtocolInfo'), arg('Sink', 'out', 'SinkProtocolInfo')]),
    action('GetCurrentConnectionIDs', [arg('ConnectionIDs', 'out', 'CurrentConnectionIDs')]),
    action('GetCurrentConnectionInfo', [arg('ConnectionID', 'in', 'A_ARG_TYPE_ConnectionID'),
      arg('RcsID', 'out', 'A_ARG_TYPE_RcsID'), arg('AVTransportID', 'out', 'A_ARG_TYPE_AVTransportID'),
      arg('ProtocolInfo', 'out', 'A_ARG_TYPE_ProtocolInfo'), arg('PeerConnectionManager', 'out', 'A_ARG_TYPE_ConnectionManager'),
      arg('PeerConnectionID', 'out', 'A_ARG_TYPE_ConnectionID'), arg('Direction', 'out', 'A_ARG_TYPE_Direction'),
      arg('Status', 'out', 'A_ARG_TYPE_ConnectionStatus')]),
  ], [
    sv('SourceProtocolInfo', 'string', { events: true }),
    sv('SinkProtocolInfo', 'string', { events: true }),
    sv('CurrentConnectionIDs', 'string', { events: true }),
    sv('A_ARG_TYPE_ConnectionStatus', 'string', { allowed: ['OK', 'ContentFormatMismatch', 'InsufficientBandwidth', 'UnreliableChannel', 'Unknown'] }),
    sv('A_ARG_TYPE_ConnectionManager', 'string'),
    sv('A_ARG_TYPE_Direction', 'string', { allowed: ['Input', 'Output'] }),
    sv('A_ARG_TYPE_ProtocolInfo', 'string'),
    sv('A_ARG_TYPE_ConnectionID', 'i4'),
    sv('A_ARG_TYPE_AVTransportID', 'i4'),
    sv('A_ARG_TYPE_RcsID', 'i4'),
  ])
}

// What we claim to be able to play. Broad on purpose: the TV's <video>
// decides in the end, and a narrow list makes phones hide the device.
const SINK_PROTOCOL_INFO = [
  'http-get:*:video/mp4:*', 'http-get:*:video/x-m4v:*', 'http-get:*:video/3gpp:*',
  'http-get:*:video/quicktime:*', 'http-get:*:video/x-matroska:*', 'http-get:*:video/webm:*',
  'http-get:*:video/mpeg:*', 'http-get:*:video/mp2t:*', 'http-get:*:video/x-flv:*',
  'http-get:*:application/vnd.apple.mpegurl:*', 'http-get:*:application/x-mpegurl:*',
  'http-get:*:audio/mpeg:*', 'http-get:*:audio/mp4:*', 'http-get:*:audio/x-m4a:*',
  'http-get:*:audio/aac:*', 'http-get:*:audio/wav:*', 'http-get:*:audio/flac:*',
  'http-get:*:image/jpeg:*', 'http-get:*:image/png:*',
  'http-get:*:*:*',
].join(',')

module.exports = { deviceDescription, avtScpd, rcsScpd, cmsScpd, SINK_PROTOCOL_INFO, AVT, RCS, CMS }
