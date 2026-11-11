// Publishes the CURRENT public address of the backend (the Cloudflare quick
// tunnel changes at every restart) to a tiny Firebase Realtime Database node
// the phones read, so the app finds the server again by itself.
//
//   cloudflared (start-tunnel.bat, --metrics 127.0.0.1:20241)
//        -> /quicktunnel  -> {"hostname":"xxxx.trycloudflare.com"}
//   this module polls it and, when the host changes, writes
//        <DISCOVERY_DB_URL>/gmao_server.json  = { api, host, updated }
//   the app reads that node (public read, nobody can write without the key).
//
// Only the address is published - every API call still needs a login token.
// Nothing is written to SQL Server.
const DB_URL = (process.env.DISCOVERY_DB_URL || 'https://gmao-magasin-default-rtdb.firebaseio.com').replace(/\/+$/, '');
const METRICS = process.env.CLOUDFLARED_METRICS || '127.0.0.1:20241';
const EVERY_MS = Math.max(10, Number(process.env.DISCOVERY_INTERVAL_SEC || 30)) * 1000;

let lastPublished = null;
let credential = null;

async function tunnelHost() {
  const res = await fetch(`http://${METRICS}/quicktunnel`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) return null;
  const j = await res.json();
  const host = String(j.hostname || '').trim().toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null;
}

async function accessToken() {
  if (!credential) {
    const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    if (!path) throw new Error('FIREBASE_SERVICE_ACCOUNT_PATH not set');
    const admin = require('firebase-admin');
    credential = admin.credential.cert(require(require('path').resolve(path)));
  }
  return (await credential.getAccessToken()).access_token;
}

async function publish(host) {
  const token = await accessToken();
  const body = { api: `https://${host}/api`, host, updated: new Date().toISOString() };
  const res = await fetch(`${DB_URL}/gmao_server.json?access_token=${encodeURIComponent(token)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`Realtime Database answered ${res.status} (is it enabled? is DISCOVERY_DB_URL right?)`);
  return body;
}

async function tick() {
  let host;
  try { host = await tunnelHost(); } catch (e) { return; }   // tunnel not running (yet): nothing to publish
  if (!host || host === lastPublished) return;
  const b = await publish(host);
  lastPublished = host;
  console.log(`[discovery] published ${b.api}`);
}

function startServerDiscovery() {
  if (process.env.DISCOVERY_ENABLED === 'false') return;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await tick(); } catch (e) { console.error('[discovery] publish failed:', e.message); }
    finally { running = false; }
  };
  setTimeout(run, 5000).unref();
  setInterval(run, EVERY_MS).unref();
}

module.exports = { startServerDiscovery, tick, _test: { tunnelHost } };
