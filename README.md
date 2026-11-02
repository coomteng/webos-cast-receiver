# webos-cast-receiver

A zero-dependency DLNA **MediaRenderer** that lives on a LAN server and relays
casts to a tiny web app on an LG webOS TV. Built so the 抖音 (Douyin) "投屏 TV"
button — and anything else that speaks DLNA/UPnP AVTransport — lands reliably on
an old webOS 4.x TV whose built-in renderer chokes on short-lived CDN URLs.

```
phone ──SSDP / SOAP AVTransport / GENA──▶ cast-receiver (Node, host network, :8790)
                                            ├─ /proxy/<id>   follows redirects, sets UA/Referer,
                                            │                passes Range through, rewrites HLS
                                            ├─ /tv/poll      TV long-polls for load/play/pause/seek/stop/volume
                                            ├─ /tv/state     TV reports state/position/duration (→ GetPositionInfo, LastChange)
                                            └─ /tv/ /sim     the TV app itself + a browser simulator
LG TV app (com.ting.cast, ES5 for Chrome 53) ──XHR──▶ /tv/*;  <video src=http://server:8790/proxy/…>
```

Why not run the renderer on the TV? webOS web apps have no sockets; SSDP needs
UDP multicast. A JS service inside the ipk might work on newer firmware but is
unproven on webOS 4.4, so the socket-side lives on the server and the TV only
plays.

## Screens: the TV, or any browser

Opening `http://<server>:8790/` in a browser turns that tab into a screen. A
live TV app always wins; when no TV is connected, the most recent browser tab
plays instead (muted autoplay fallback until you click the page once). When
the TV comes back it takes over mid-clip (`load` with `startAt`) and the
browser drops to standby. `/status` lists the connected screens.

## Server

```sh
node server/server.js          # http://<lan-ip>:8790, advertises on SSDP
node --test test/*.test.js     # 39 tests, no deps
```

Environment: `FRIENDLY_NAME` (default `客厅电视`), `PORT` (8790), `BIND_ADDR`
(pin the LAN interface on multi-NIC hosts; also the advertised IP),
`ADVERTISE_HOST`, `PROXY_MODE` = `always` | `https-only` | `off`, `DATA_DIR`
(persists the device UUID), `TV_TIMEOUT_MS` (12000), `VERBOSE=1`.

Docker: `compose.portainer.yml` — **must** use `network_mode: host` (multicast).

Implemented UPnP surface: device description with `DMR-1.50`; AVTransport
(SetAVTransportURI, SetNextAVTransportURI, Play, Pause, Stop, Seek, Next,
Previous, Get{Media,Transport,Position}Info, GetDeviceCapabilities,
GetTransportSettings, GetCurrentTransportActions, SetPlayMode);
RenderingControl (Get/SetVolume, Get/SetMute, presets); ConnectionManager
(GetProtocolInfo, connection IDs); GENA SUBSCRIBE/renew/UNSUBSCRIBE with
moderated `LastChange` NOTIFY. If the TV app is not connected, transport
actions fail with UPnP 701 instead of pretending.

## TV app

A prebuilt ipk for the author's LAN (server at 192.168.0.9:8790) is attached to
each [GitHub release](https://github.com/coomteng/webos-cast-receiver/releases);
for any other network build your own as below.

`app/` is plain ES5 + flexbox (webOS 4.4 = Chrome 53; one ES2015 token kills the
script). `tools/es5check.sh` gates it with acorn. Keys: OK/Play/Pause toggle,
←/→ ±10 s, ⏪/⏩ ±30 s, Stop/Back stop, Back again exits. Magic Remote: click
toggles, moving shows the OSD, clicking the bar seeks.

```sh
echo SERVER_BASE=http://192.168.0.9:8790 > local.env
tools/build_ipk.sh                         # substitutes the server address, packages dist/*.ipk
ares-install --device <tv> dist/com.ting.cast_*.ipk
ares-launch  --device <tv> com.ting.cast
```

Developer Mode setup for old LG TVs: see the notes in
[coomteng/moontv-webos](https://github.com/coomteng/moontv-webos).

## Testing without a TV or phone

- `http://<server>:8790/sim/` — scaled TV + remote + a "fake phone" that pushes a URL via SOAP.
- `node tools/cast.js` lists MediaRenderers on the LAN; `node tools/cast.js <url> [name]`
  casts to one, subscribes to events and prints position every second.

## License

MIT
