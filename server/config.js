// Configuration from environment, with the persistent device UUID.
// Everything has a default so `node server/server.js` works on a laptop.
'use strict'

const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

// First non-internal IPv4 address; prefers an interface whose name does not
// look like docker/bridge/virtual. Used for LOCATION and proxy URLs when
// ADVERTISE_HOST is not set.
function detectHost() {
  const ifs = os.networkInterfaces()
  const names = Object.keys(ifs).sort((a, b) => {
    const bad = n => /^(docker|br-|veth|virbr|lo)/.test(n) ? 1 : 0
    return bad(a) - bad(b)
  })
  for (const name of names) {
    for (const i of ifs[name] || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address
    }
  }
  return '127.0.0.1'
}

function loadUuid(dataDir) {
  const file = path.join(dataDir, 'uuid')
  try {
    const v = fs.readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f-]{36}$/i.test(v)) return v
  } catch (e) { /* first run */ }
  const v = crypto.randomUUID()
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(file, v + '\n')
  } catch (e) {
    console.warn('[config] cannot persist uuid in', dataDir, '-', e.message)
  }
  return v
}

function loadConfig(env = process.env) {
  const dataDir = env.DATA_DIR || path.join(__dirname, '..', 'data')
  const port = parseInt(env.PORT || '8790', 10)
  const bindAddr = env.BIND_ADDR || ''
  const advertiseHost = env.ADVERTISE_HOST || bindAddr || detectHost()
  const proxyMode = ['always', 'https-only', 'off'].includes(env.PROXY_MODE) ? env.PROXY_MODE : 'always'
  return {
    port,
    bindAddr,
    advertiseHost,
    base: `http://${advertiseHost}:${port}`,
    friendlyName: env.FRIENDLY_NAME || '客厅电视',
    // Manufacturer/model strings some control points pattern-match on; a
    // plain TV identity is the safest bet.
    manufacturer: env.MANUFACTURER || 'LG Electronics',
    modelName: env.MODEL_NAME || 'LG TV Cast Receiver',
    uuid: env.UUID || loadUuid(dataDir),
    dataDir,
    proxyMode,
    proxyUserAgent: env.PROXY_UA || 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
    tvTimeoutMs: parseInt(env.TV_TIMEOUT_MS || '12000', 10),
    appDir: env.APP_DIR || path.join(__dirname, '..', 'app'),
    simDir: env.SIM_DIR || path.join(__dirname, '..', 'sim'),
    verbose: env.VERBOSE === '1',
  }
}

module.exports = { loadConfig, detectHost }
