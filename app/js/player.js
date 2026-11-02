/* player.js — <video> wrapper + OSD. ES5 only.
 * Player.load({loadId,url,title,autoplay}) / play / pause / stop / seek / setVolume / setMute
 * Emits reports through Player.onReport(fn): {loadId,state,position,duration,volume,mute,error} */
var Player = (function () {
  'use strict';

  var video = document.getElementById('video');
  var idle = document.getElementById('idle');
  var loading = document.getElementById('loading');
  var loadingTxt = document.getElementById('loading-txt');
  var osd = document.getElementById('osd');
  var osdTitle = document.getElementById('osd-title');
  var osdCur = document.getElementById('osd-cur');
  var osdDur = document.getElementById('osd-dur');
  var osdFill = document.getElementById('osd-fill');
  var osdState = document.getElementById('osd-state');

  var current = null;      // {loadId,url,title}
  var reportFn = null;
  var osdTimer = null;
  var lastState = 'idle';
  var stallTimer = null;
  var retried = false;

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    var m = Math.floor(sec / 60), s = sec % 60;
    var h = Math.floor(m / 60); m = m % 60;
    var ss = (s < 10 ? '0' : '') + s;
    return h ? h + ':' + (m < 10 ? '0' : '') + m + ':' + ss : m + ':' + ss;
  }

  function report(state, extra) {
    if (state) lastState = state;
    var r = {
      loadId: current ? current.loadId : 0,
      state: lastState,
      position: isFinite(video.currentTime) ? video.currentTime : 0,
      duration: isFinite(video.duration) ? video.duration : 0,
      volume: Math.round(video.volume * 100),
      mute: !!video.muted
    };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    if (reportFn) reportFn(r);
  }

  function showIdle(on) {
    if (on) { idle.classList.remove('hidden'); osd.classList.add('hidden'); loading.classList.add('hidden'); }
    else idle.classList.add('hidden');
  }

  function showLoading(on, txt) {
    if (txt) loadingTxt.textContent = txt;
    if (on) loading.classList.remove('hidden'); else loading.classList.add('hidden');
  }

  function updateOsd() {
    var cur = video.currentTime || 0, dur = video.duration;
    osdCur.textContent = fmt(cur);
    osdDur.textContent = isFinite(dur) ? fmt(dur) : '--:--';
    osdFill.style.width = (isFinite(dur) && dur > 0 ? Math.min(100, cur / dur * 100) : 0) + '%';
    osdState.textContent = video.paused ? '已暂停' : '';
  }

  function showOsd(ms) {
    if (!current) return;
    updateOsd();
    osd.classList.remove('hidden');
    if (osdTimer) clearTimeout(osdTimer);
    if (ms !== 0) osdTimer = setTimeout(function () { if (!video.paused) osd.classList.add('hidden'); }, ms || 3000);
  }

  function clearStall() { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } }

  /* ---- video events ---- */
  video.addEventListener('loadstart', function () { report('loading'); });
  video.addEventListener('loadedmetadata', function () { report(null); updateOsd(); });
  video.addEventListener('playing', function () { clearStall(); showLoading(false); showIdle(false); report('playing'); showOsd(3000); });
  video.addEventListener('play', function () { report(video.readyState >= 3 ? 'playing' : 'loading'); });
  video.addEventListener('pause', function () { if (!video.ended && current) { report('paused'); showOsd(0); } });
  video.addEventListener('waiting', function () { if (current) { showLoading(true, '缓冲中…'); report('loading'); } });
  video.addEventListener('canplay', function () { showLoading(false); });
  video.addEventListener('timeupdate', function () { if (!osd.classList.contains('hidden')) updateOsd(); });
  video.addEventListener('ended', function () {
    clearStall();
    report('ended');
    App.toast('播放完毕');
    // Keep the last frame for a moment, then back to idle unless something new arrives.
    var id = current ? current.loadId : 0;
    setTimeout(function () { if (current && current.loadId === id) stop(true); }, 2500);
  });
  video.addEventListener('error', function () {
    clearStall();
    var err = video.error;
    var code = err ? err.code : 0;
    var msg = ({ 1: '已中止', 2: '网络错误', 3: '解码失败', 4: '格式不支持' })[code] || ('错误 ' + code);
    if (!current) return;
    // One retry for transient network errors (CDN hiccup / proxy redirect).
    if (!retried && (code === 2 || code === 4)) {
      retried = true;
      App.log('video error ' + code + ', retrying');
      var c = current;
      setTimeout(function () { if (current === c) { video.src = c.url + (c.url.indexOf('?') < 0 ? '?' : '&') + 'r=1'; video.load(); video.play(); } }, 600);
      return;
    }
    showLoading(false);
    App.toast('无法播放：' + msg, true);
    report('error', { error: msg + ' (' + code + ')' });
    var failed = current;
    setTimeout(function () { if (current === failed) stop(true); }, 2500);
  });
  video.addEventListener('volumechange', function () { report(null); });

  /* ---- commands ---- */
  function load(cmd) {
    current = { loadId: cmd.loadId, url: cmd.url, title: cmd.title || '' };
    retried = false;
    osdTitle.textContent = current.title;
    showIdle(false);
    showLoading(true, '正在加载…');
    osd.classList.add('hidden');
    try { video.pause(); } catch (e) { /* ignore */ }
    video.removeAttribute('src');
    try { video.load(); } catch (e2) { /* ignore */ }
    video.src = cmd.url;
    video.load();
    report('loading');
    if (cmd.autoplay !== false) {
      var p = video.play();
      if (p && p['catch']) p['catch'](function (e) { App.log('play() rejected: ' + e); });
    }
    // Watchdog: if nothing starts within 20 s, report an error so the phone
    // is not stuck in TRANSITIONING.
    clearStall();
    stallTimer = setTimeout(function () {
      if (current && current.loadId === cmd.loadId && video.readyState < 3) {
        App.toast('加载超时', true);
        report('error', { error: 'load timeout' });
        stop(true);
      }
    }, 20000);
  }

  function play() {
    if (!current) return;
    var p = video.play();
    if (p && p['catch']) p['catch'](function () {});
    osd.classList.add('hidden');
  }

  function pause() { if (!current) return; video.pause(); }

  function stop(silent) {
    clearStall();
    var had = !!current;
    current = null;
    try { video.pause(); } catch (e) { /* ignore */ }
    video.removeAttribute('src');
    try { video.load(); } catch (e2) { /* ignore */ }
    showIdle(true);
    if (had && !silent) report('stopped');
  }

  function seek(sec) {
    if (!current) return;
    try { video.currentTime = Math.max(0, sec); } catch (e) { /* not seekable yet */ }
    showOsd(3000);
  }

  function seekBy(delta) { if (current) seek((video.currentTime || 0) + delta); }

  function togglePlay() { if (!current) return; if (video.paused) play(); else pause(); }

  function setVolume(v) { video.volume = Math.max(0, Math.min(1, v / 100)); }
  function setMute(m) { video.muted = !!m; }

  return {
    load: load, play: play, pause: pause, stop: stop, seek: seek, seekBy: seekBy, togglePlay: togglePlay,
    setVolume: setVolume, setMute: setMute, showOsd: showOsd,
    isActive: function () { return !!current; },
    isPaused: function () { return video.paused; },
    report: function () { report(null); },
    onReport: function (fn) { reportFn = fn; }
  };
})();
