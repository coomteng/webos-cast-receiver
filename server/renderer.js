// Renderer state machine: the single source of truth that SOAP reads and
// writes, the TV feeds back into, and GENA observes. No I/O here.
//
// Transport states follow AVTransport:1: NO_MEDIA_PRESENT, STOPPED,
// TRANSITIONING, PLAYING, PAUSED_PLAYBACK. The TV reports its real player
// state; between reports the position is extrapolated while PLAYING so
// GetPositionInfo stays smooth for phone progress bars.
'use strict'

const { EventEmitter } = require('node:events')
const { UpnpError } = require('./soap.js')
const { tagValue, xmlUnescape } = require('./xml.js')

// Pull a human title out of DIDL-Lite metadata (best effort).
function titleFromMetadata(meta) {
  if (!meta) return ''
  const t = tagValue(meta, 'title')
  return t ? xmlUnescape(t).trim() : ''
}

class Renderer extends EventEmitter {
  // tv: { isOnline(): boolean, send(cmd): void }  (tvchannel)
  // toPlayable: (uri) => string  (proxy registration; identity if proxy off)
  // now: () => ms (injectable clock)
  constructor({ tv, toPlayable, now, log } = {}) {
    super()
    this.tv = tv
    this.toPlayable = toPlayable || (u => u)
    this.now = now || Date.now
    this.log = log || (() => {})
    this.loadId = 0 // increments per SetAVTransportURI; TV echoes it back
    this.reset()
    this.volume = 50
    this.mute = false
  }

  reset() {
    this.state = 'NO_MEDIA_PRESENT'
    this.status = 'OK'
    this.uri = ''
    this.metadata = ''
    this.title = ''
    this.playableUri = ''
    this.nextUri = ''
    this.nextMetadata = ''
    this.duration = 0
    this._pos = 0
    this._posAt = this.now()
  }

  // ---- derived -----------------------------------------------------------
  position() {
    if (this.state === 'PLAYING') {
      const p = this._pos + (this.now() - this._posAt) / 1000
      return this.duration > 0 ? Math.min(p, this.duration) : p
    }
    return this._pos
  }

  currentActions() {
    switch (this.state) {
      case 'PLAYING': return 'Pause,Stop,Seek,Next'
      case 'PAUSED_PLAYBACK': return 'Play,Stop,Seek,Next'
      case 'STOPPED': return this.uri ? 'Play,Seek,Next' : ''
      case 'TRANSITIONING': return 'Stop'
      default: return ''
    }
  }

  snapshot() {
    return {
      state: this.state, status: this.status, uri: this.uri, title: this.title,
      position: this.position(), duration: this.duration, volume: this.volume, mute: this.mute,
      loadId: this.loadId, nextUri: this.nextUri,
    }
  }

  _setState(state) {
    if (this.state === state) return
    // Freeze the extrapolated position when leaving PLAYING.
    if (this.state === 'PLAYING') { this._pos = this.position(); this._posAt = this.now() }
    this.state = state
    this.log('state ->', state)
    this.emit('change', { TransportState: state, CurrentTransportActions: this.currentActions() })
  }

  _requireTv() {
    if (!this.tv || !this.tv.isOnline()) {
      throw new UpnpError(701, 'TV app is not connected')
    }
  }

  // ---- control point side (SOAP) ----------------------------------------
  setUri(uri, metadata) {
    if (!uri) throw new UpnpError(402, 'CurrentURI missing')
    this.loadId += 1
    this.uri = uri
    this.metadata = metadata || ''
    this.title = titleFromMetadata(metadata)
    this.playableUri = this.toPlayable(uri, this.loadId)
    this.duration = 0
    this._pos = 0
    this._posAt = this.now()
    this.status = 'OK'
    const wasPlaying = this.state === 'PLAYING' || this.state === 'TRANSITIONING'
    this.emit('change', {
      AVTransportURI: uri, AVTransportURIMetaData: this.metadata,
      CurrentTrackURI: uri, CurrentTrackMetaData: this.metadata,
      CurrentTrackDuration: '0:00:00', CurrentMediaDuration: '0:00:00', CurrentTrack: this.uri ? 1 : 0,
      NumberOfTracks: this.uri ? 1 : 0,
    })
    // Many control points (Douyin included) call SetAVTransportURI while a
    // previous item is still playing and expect the new one to start
    // immediately, before/without an explicit Play. Load now if the TV is
    // there; otherwise just arm STOPPED and let Play do it.
    if (this.tv && this.tv.isOnline()) {
      this._setState('TRANSITIONING')
      this.tv.send({ cmd: 'load', loadId: this.loadId, url: this.playableUri, title: this.title, autoplay: wasPlaying || true })
    } else {
      this._setState('STOPPED')
    }
  }

  setNextUri(uri, metadata) {
    this.nextUri = uri || ''
    this.nextMetadata = metadata || ''
    this.emit('change', { NextAVTransportURI: this.nextUri, NextAVTransportURIMetaData: this.nextMetadata })
  }

  play() {
    if (!this.uri) throw new UpnpError(701, 'no media')
    this._requireTv()
    if (this.state === 'PLAYING') return
    // A load with autoplay is already in flight; Play right after SetURI
    // (Douyin does this) must not queue a second command.
    if (this.state === 'TRANSITIONING') return
    if (this.state === 'STOPPED' || this.state === 'NO_MEDIA_PRESENT') {
      this._setState('TRANSITIONING')
      this.tv.send({ cmd: 'load', loadId: this.loadId, url: this.playableUri, title: this.title, autoplay: true })
      return
    }
    this.tv.send({ cmd: 'play', loadId: this.loadId })
    // Optimistic: report PLAYING right away so the phone's UI flips; the TV
    // report will correct it if the element could not start.
    this._posAt = this.now()
    this._setState('PLAYING')
  }

  pause() {
    if (this.state !== 'PLAYING' && this.state !== 'TRANSITIONING') {
      if (this.state === 'PAUSED_PLAYBACK') return
      throw new UpnpError(701, 'not playing')
    }
    this._requireTv()
    this.tv.send({ cmd: 'pause', loadId: this.loadId })
    this._setState('PAUSED_PLAYBACK')
  }

  stop() {
    if (this.state === 'NO_MEDIA_PRESENT') return
    if (this.tv && this.tv.isOnline()) this.tv.send({ cmd: 'stop', loadId: this.loadId })
    this._pos = 0
    this._posAt = this.now()
    this._setState('STOPPED')
  }

  seek(seconds) {
    if (!isFinite(seconds) || seconds < 0) throw new UpnpError(711, 'illegal seek target')
    if (this.state === 'NO_MEDIA_PRESENT') throw new UpnpError(701, 'no media')
    this._requireTv()
    if (this.duration > 0) seconds = Math.min(seconds, this.duration)
    this._pos = seconds
    this._posAt = this.now()
    this.tv.send({ cmd: 'seek', loadId: this.loadId, position: seconds })
    this.emit('change', { RelativeTimePosition: seconds })
  }

  setVolume(v) {
    v = Math.max(0, Math.min(100, Math.round(Number(v))))
    if (!isFinite(v)) throw new UpnpError(402, 'bad volume')
    this.volume = v
    if (this.tv && this.tv.isOnline()) this.tv.send({ cmd: 'volume', volume: v })
    this.emit('rcs', { Volume: v })
  }

  setMute(m) {
    this.mute = !!m
    if (this.tv && this.tv.isOnline()) this.tv.send({ cmd: 'mute', mute: this.mute })
    this.emit('rcs', { Mute: this.mute ? 1 : 0 })
  }

  // ---- TV side -----------------------------------------------------------
  // report: { loadId, state: 'loading'|'playing'|'paused'|'stopped'|'ended'|'error',
  //           position, duration, volume, mute, error }
  onTvReport(r) {
    if (!r) return
    if (typeof r.volume === 'number' && r.volume !== this.volume) {
      this.volume = Math.max(0, Math.min(100, Math.round(r.volume)))
      this.emit('rcs', { Volume: this.volume })
    }
    if (typeof r.mute === 'boolean' && r.mute !== this.mute) {
      this.mute = r.mute
      this.emit('rcs', { Mute: this.mute ? 1 : 0 })
    }
    // Reports about an older load are stale: ignore their transport info.
    if (r.loadId !== undefined && r.loadId !== this.loadId) return
    if (typeof r.duration === 'number' && isFinite(r.duration) && r.duration > 0 && Math.abs(r.duration - this.duration) > 0.5) {
      this.duration = r.duration
      this.emit('change', { CurrentTrackDuration: r.duration, CurrentMediaDuration: r.duration })
    }
    if (typeof r.position === 'number' && isFinite(r.position)) {
      this._pos = r.position
      this._posAt = this.now()
    }
    switch (r.state) {
      case 'loading': if (this.uri) this._setState('TRANSITIONING'); break
      case 'playing': this.status = 'OK'; this._setState('PLAYING'); break
      case 'paused':
        // A pause arriving in STOPPED/NO_MEDIA (e.g. the element's trailing
        // pause after error/ended) is not a user pause.
        if (this.state === 'PLAYING' || this.state === 'TRANSITIONING') this._setState('PAUSED_PLAYBACK')
        break
      case 'ended':
        // Natural end: position = duration, STOPPED. This LastChange is what
        // tells the phone the clip is over.
        if (this.duration > 0) this._pos = this.duration
        this._posAt = this.now()
        this._setState('STOPPED')
        this.emit('ended')
        break
      case 'stopped': this._setState('STOPPED'); break
      case 'error':
        this.status = 'ERROR_OCCURRED'
        this.log('tv error:', r.error)
        this.emit('change', { TransportStatus: 'ERROR_OCCURRED' })
        this._setState('STOPPED')
        break
      default: break
    }
  }

  // TV went away (poll timeout) — whatever it was doing is no longer true.
  onTvOffline() {
    if (this.state === 'PLAYING' || this.state === 'TRANSITIONING' || this.state === 'PAUSED_PLAYBACK') {
      this._setState('STOPPED')
    }
  }
}

module.exports = { Renderer, titleFromMetadata }
