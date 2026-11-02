// Command channel to the TV app. The TV long-polls /tv/poll; commands are
// queued with a sequence number and delivered in order. The TV POSTs
// /tv/state about once a second (and on every player event), which also
// serves as the liveness heartbeat. Only one TV is supported: the newest
// poller wins, the old one's poll is answered with {replaced:true}.
'use strict'

function createTvChannel({ timeoutMs = 12000, pollMs = 25000, now, setTimeoutFn, clearTimeoutFn, onOffline, log } = {}) {
  const clock = now || Date.now
  const setT = setTimeoutFn || setTimeout
  const clearT = clearTimeoutFn || clearTimeout
  const logf = log || (() => {})
  let seq = 0
  let queue = []          // [{seq, ...cmd}]
  let waiter = null       // { res, timer, client }
  let lastSeen = 0
  let client = null       // { ip, ua, name }
  let offlineTimer = null

  function isOnline() { return lastSeen > 0 && clock() - lastSeen < timeoutMs }

  function touch(info) {
    const wasOnline = isOnline()
    lastSeen = clock()
    if (info) client = Object.assign(client || {}, info)
    if (!wasOnline) logf('tv online', client && client.ip)
    if (offlineTimer) clearT(offlineTimer)
    offlineTimer = setT(() => {
      if (!isOnline()) { logf('tv offline'); if (onOffline) onOffline() }
    }, timeoutMs + 100)
    if (offlineTimer && offlineTimer.unref) offlineTimer.unref()
  }

  function send(cmd) {
    seq += 1
    const msg = Object.assign({ seq }, cmd)
    // A new load supersedes every queued transport command for the old one.
    if (cmd.cmd === 'load') queue = queue.filter(c => c.cmd === 'volume' || c.cmd === 'mute')
    queue.push(msg)
    if (queue.length > 50) queue = queue.slice(-50)
    logf('tv <-', msg.cmd, msg.seq)
    flush()
  }

  function flush() {
    if (!waiter || queue.length === 0) return
    const w = waiter
    waiter = null
    clearT(w.timer)
    const batch = queue
    queue = []
    w.respond({ commands: batch })
  }

  // HTTP side ------------------------------------------------------------
  // respond(obj) writes the JSON; after is the last seq the TV has processed.
  function poll({ after, respond, info }) {
    touch(info)
    const n = parseInt(after, 10)
    if (isFinite(n)) queue = queue.filter(c => c.seq > n)
    if (waiter) {
      const old = waiter
      waiter = null
      clearT(old.timer)
      old.respond({ commands: [], replaced: true })
    }
    if (queue.length > 0) {
      const batch = queue
      queue = []
      return respond({ commands: batch })
    }
    const timer = setT(() => {
      if (waiter && waiter.respond === respond) {
        waiter = null
        respond({ commands: [] })
      }
    }, pollMs)
    if (timer && timer.unref) timer.unref()
    waiter = { respond, timer }
  }

  function onDisconnect(respond) {
    if (waiter && waiter.respond === respond) { clearT(waiter.timer); waiter = null }
  }

  function report(info) { touch(info) }

  function status() {
    return { online: isOnline(), lastSeen, client, queued: queue.length, seq }
  }

  return { isOnline, send, poll, report, status, onDisconnect, _queue: () => queue }
}

module.exports = { createTvChannel }
