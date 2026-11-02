// SOAP action dispatch for the three services. Each handler takes the
// parsed body and returns the out-arguments object (or throws UpnpError).
'use strict'

const { soapArg, UpnpError, parseTime, formatTime } = require('./soap.js')
const { SINK_PROTOCOL_INFO } = require('./deviceXml.js')

function avtActions(renderer) {
  return {
    SetAVTransportURI(body) {
      renderer.setUri(soapArg(body, 'CurrentURI'), soapArg(body, 'CurrentURIMetaData'))
      return {}
    },
    SetNextAVTransportURI(body) {
      renderer.setNextUri(soapArg(body, 'NextURI'), soapArg(body, 'NextURIMetaData'))
      return {}
    },
    GetMediaInfo() {
      return {
        NrTracks: renderer.uri ? 1 : 0,
        MediaDuration: formatTime(renderer.duration),
        CurrentURI: renderer.uri,
        CurrentURIMetaData: renderer.metadata,
        NextURI: renderer.nextUri,
        NextURIMetaData: renderer.nextMetadata,
        PlayMedium: renderer.uri ? 'NETWORK' : 'NONE',
        RecordMedium: 'NOT_IMPLEMENTED',
        WriteStatus: 'NOT_IMPLEMENTED',
      }
    },
    GetTransportInfo() {
      return { CurrentTransportState: renderer.state, CurrentTransportStatus: renderer.status, CurrentSpeed: '1' }
    },
    GetPositionInfo() {
      const pos = formatTime(renderer.position())
      return {
        Track: renderer.uri ? 1 : 0,
        TrackDuration: formatTime(renderer.duration),
        TrackMetaData: renderer.metadata,
        TrackURI: renderer.uri,
        RelTime: pos,
        AbsTime: pos,
        RelCount: 2147483647,
        AbsCount: 2147483647,
      }
    },
    GetDeviceCapabilities() {
      return { PlayMedia: 'NETWORK', RecMedia: 'NOT_IMPLEMENTED', RecQualityModes: 'NOT_IMPLEMENTED' }
    },
    GetTransportSettings() {
      return { PlayMode: 'NORMAL', RecQualityMode: 'NOT_IMPLEMENTED' }
    },
    GetCurrentTransportActions() {
      return { Actions: renderer.currentActions() }
    },
    Stop() { renderer.stop(); return {} },
    Play() { renderer.play(); return {} },
    Pause() { renderer.pause(); return {} },
    Seek(body) {
      const unit = soapArg(body, 'Unit') || 'REL_TIME'
      const target = soapArg(body, 'Target')
      if (unit === 'TRACK_NR') return {} // single track: nothing to do
      if (unit !== 'REL_TIME' && unit !== 'ABS_TIME') throw new UpnpError(710, 'seek mode not supported')
      const sec = parseTime(target)
      if (!isFinite(sec)) throw new UpnpError(711, 'illegal seek target')
      renderer.seek(sec)
      return {}
    },
    Next() {
      // No playlist: Next means "finish this clip". Phones that queued a
      // NextURI get the ended signal and push the next one themselves.
      renderer.stop()
      return {}
    },
    Previous() { renderer.seek(0); return {} },
    SetPlayMode(body) {
      const mode = soapArg(body, 'NewPlayMode')
      if (mode && mode !== 'NORMAL') throw new UpnpError(712, 'play mode not supported')
      return {}
    },
  }
}

function rcsActions(renderer) {
  return {
    ListPresets() { return { CurrentPresetNameList: 'FactoryDefaults' } },
    SelectPreset() { return {} },
    GetMute() { return { CurrentMute: renderer.mute ? 1 : 0 } },
    SetMute(body) {
      const v = soapArg(body, 'DesiredMute')
      renderer.setMute(v === '1' || v === 'true' || v === 'True')
      return {}
    },
    GetVolume() { return { CurrentVolume: renderer.volume } },
    SetVolume(body) {
      renderer.setVolume(soapArg(body, 'DesiredVolume'))
      return {}
    },
  }
}

function cmsActions() {
  return {
    GetProtocolInfo() { return { Source: '', Sink: SINK_PROTOCOL_INFO } },
    GetCurrentConnectionIDs() { return { ConnectionIDs: '0' } },
    GetCurrentConnectionInfo() {
      return {
        RcsID: 0, AVTransportID: 0, ProtocolInfo: '', PeerConnectionManager: '',
        PeerConnectionID: -1, Direction: 'Input', Status: 'OK',
      }
    },
  }
}

module.exports = { avtActions, rcsActions, cmsActions }
