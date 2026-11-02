// Command channel to the screens. A screen is any client running the player
// page: the LG TV app (role 'tv') or a browser that opened
// http://<server>:8790/ (role 'web'). Several screens may be connected, but
// exactly one is ACTIVE and actually plays: a live TV always wins; otherwise
// the most recently seen web screen. The others idle in standby and are told
// so in their poll responses. When the active screen changes, the old one
// gets a 'standby' command (stops playback) and the new one gets 'active'.
//
// Each screen long-polls /tv/poll?client=<id>&role=tv|web and POSTs
// /tv/state (which doubles as its heartbeat). Only the active screen's
// transport reports are trusted by the renderer.
'use strict'

function createTvChannel({ timeoutMs = 12000, pollMs = 25000, now, setTimeoutFn, clearTimeoutFn, onOffline, onActiveChange, log } = {}) {
  const clock = now || Date.now
  const setT = setTimeoutFn || setTimeout
  const clearT = clearTimeoutFn || clearTimeout
  const logf = log || (() => {})
  let seq = 0
  // id -> { id, role, lastSeen, queue: [], waiter: {respond,timer}|null, info }
  const clients = new Map()
  let activeId = null
  let sweepTimer = null

  function alive(c) { return c && clock() - c.lastSeen < timeoutMs }

  function pickActive() {
    // TV beats web; within a role, keep the current active one if still
    // alive (no flapping), else the most recently seen.
    const rank = c => (c.role === 'tv' ? 2 : 1) * 1e15 + (c.id === activeId ? 1e14 : 0) + c.lastSeen
    let best = null
    for (const c of clients.values()) {
      if (!alive(c)) continue
      if (!best || rank(c) > rank(best)) best = c
    }
    return best ? best.id : null
  }

  function enqueue(c, cmd) {
    seq += 1
    const msg = Object.assign({ seq }, cmd)
    if (cmd.cmd === 'load') c.queue = c.queue.filter(x => x.cmd === 'volume' || x.cmd === 'mute' || x.cmd === 'active' || x.cmd === 'standby')
    c.queue.push(msg)
    if (c.queue.length > 50) c.queue = c.queue.slice(-50)
    flush(c)
    return msg
  }

  function reconcile() {
    const prev = activeId
    const next = pickActive()
    if (prev === next) return
    const wasOnline = !!prev
    activeId = next
    if (prev && clients.has(prev)) enqueue(clients.get(prev), { cmd: 'standby' })
    if (next) enqueue(clients.get(next), { cmd: 'active' })
    logf('active screen:', prev, '->', next, next ? clients.get(next).role : '')
    if (onActiveChange) onActiveChange(next ? clients.get(next) : null, prev ? (clients.get(prev) || { id: prev }) : null)
    if (wasOnline && !next && onOffline) onOffline()
  }

  function sweep() {
    sweepTimer = null
    for (const [id, c] of clients) {
      if (!alive(c) && !c.waiter && clock() - c.lastSeen > timeoutMs * 10) clients.delete(id)
    }
    reconcile()
    scheduleSweep()
  }
  function scheduleSweep() {
    if (sweepTimer) return
    sweepTimer = setT(sweep, timeoutMs + 100)
    if (sweepTimer && sweepTimer.unref) sweepTimer.unref()
  }

  function touch(id, role, info) {
    let c = clients.get(id)
    if (c && !alive(c)) { clients.delete(id); c = null } // a returning id starts clean (no stale standby/active in its queue)
    if (!c) {
      c = { id, role: role === 'tv' ? 'tv' : 'web', lastSeen: 0, queue: [], waiter: null, info: {} }
      clients.set(id, c)
      logf('screen joined', id, c.role, info && info.ip)
    }
    if (role === 'tv' || role === 'web') c.role = role
    c.lastSeen = clock()
    if (info) Object.assign(c.info, info)
    scheduleSweep()
    reconcile()
    return c
  }

  // ---- renderer-facing ---------------------------------------------------
  function isOnline() { return activeId !== null && alive(clients.get(activeId)) }
  function activeClient() { return activeId ? clients.get(activeId) : null }
  function isActive(id) { return id === activeId }

  function send(cmd) {
    const c = activeClient()
    if (!c) return null
    const msg = enqueue(c, cmd)
    logf('screen', c.id, '<-', msg.cmd, msg.seq)
    return msg
  }

  // ---- HTTP-facing -------------------------------------------------------
  function flush(c) {
    if (!c.waiter || c.queue.length === 0) return
    const w = c.waiter
    c.waiter = null
    clearT(w.timer)
    const batch = c.queue
    c.queue = []
    w.respond({ commands: batch, active: isActive(c.id) })
  }

  function poll({ client, role, after, respond, info }) {
    const id = client || (info && info.ip) || 'anon'
    const c = touch(id, role, info)
    const n = parseInt(after, 10)
    if (isFinite(n)) c.queue = c.queue.filter(x => x.seq > n)
    if (c.waiter) {
      const old = c.waiter
      c.waiter = null
      clearT(old.timer)
      old.respond({ commands: [], active: isActive(id), replaced: true })
    }
    if (c.queue.length > 0) {
      const batch = c.queue
      c.queue = []
      return respond({ commands: batch, active: isActive(id) })
    }
    const timer = setT(() => {
      if (c.waiter && c.waiter.respond === respond) {
        c.waiter = null
        respond({ commands: [], active: isActive(id) })
      }
    }, pollMs)
    if (timer && timer.unref) timer.unref()
    c.waiter = { respond, timer }
  }

  function onDisconnect(respond) {
    for (const c of clients.values()) {
      if (c.waiter && c.waiter.respond === respond) { clearT(c.waiter.timer); c.waiter = null }
    }
  }

  // Returns true when the report comes from the active screen.
  function report({ client, role, info }) {
    const id = client || (info && info.ip) || 'anon'
    touch(id, role, info)
    return isActive(id)
  }

  function status() {
    const a = activeClient()
    return {
      online: isOnline(),
      active: a ? { id: a.id, role: a.role, ip: a.info.ip, name: a.info.name, ua: a.info.ua } : null,
      screens: [...clients.values()].filter(alive).map(c => ({ id: c.id, role: c.role, ip: c.info.ip, active: c.id === activeId })),
      seq,
    }
  }

  return { isOnline, isActive, activeClient, send, poll, report, status, onDisconnect, reconcile, _clients: clients }
}

module.exports = { createTvChannel }
