const { sql, getPool } = require('./db');
const { getAppPool } = require('./appDb');
const { notifyRoles } = require('./push');
const { analyseAll, describe } = require('./fuelAnalysis');
const { loadSorties } = require('./routes/carburant');

// Polls the desktop table for new fuel issues (the desktop app writes them, so
// there is nothing to hook into) and sends a push when an engine consumed more
// than its usual. Already-notified issues are remembered in the app database
// (app_notification_log, type 'fuel_alert', id_ref = issue id): no new table,
// nothing written to GMAO_NGES.
const ROLES = (process.env.FUEL_ALERT_ROLES || 'Administrateur,Responsable Méthode,Responsable Magasin')
  .split(',').map((s) => s.trim()).filter(Boolean);
const LOOKBACK_DAYS = Number(process.env.FUEL_ALERT_LOOKBACK_DAYS || 3);
const MAX_PER_RUN = 10;

const iso = (d) => d.toISOString().slice(0, 10);

async function checkFuelAlerts(now = new Date()) {
  const pool = await getPool();
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const rows = await loadSorties(pool, new Date(today.getTime() - 180 * 86400000), today);
  const recent = iso(new Date(today.getTime() - LOOKBACK_DAYS * 86400000));

  const flagged = [];
  for (const list of analyseAll(rows).values()) {
    for (const x of list) if (x.alertes.length && iso(new Date(x.date)) >= recent) flagged.push(x);
  }
  if (flagged.length === 0) return 0;

  const appPool = await getAppPool();
  const rq = appPool.request();
  flagged.forEach((x, i) => rq.input(`i${i}`, sql.Int, x.id));
  const seen = await rq.query(
    `select distinct id_ref from app_notification_log
     where type = 'fuel_alert' and id_ref in (${flagged.map((_, i) => `@i${i}`).join(',')})`);
  const done = new Set(seen.recordset.map((r) => r.id_ref));
  const fresh = flagged.filter((x) => !done.has(x.id)).sort((a, b) => a.id - b.id);

  let sent = 0;
  for (const x of fresh.slice(0, MAX_PER_RUN)) {
    const nom = `${(x.engin || '').trim()} ${(x.matricule || '').trim()}`.trim();
    await notifyRoles(ROLES, {
      type: 'fuel_alert', idRef: x.id,
      title: 'Consommation gasoil anormale',
      body: `${nom} : ${describe(x)} le ${iso(new Date(x.date)).split('-').reverse().join('/')}`
    });
    sent++;
  }
  if (fresh.length > MAX_PER_RUN) console.log(`[fuel] ${fresh.length - MAX_PER_RUN} more alert(s) will be sent on the next run.`);
  return sent;
}

function startFuelAlerts() {
  if (process.env.FUEL_ALERT_ENABLED === 'false') return;
  const every = Math.max(1, Number(process.env.FUEL_ALERT_INTERVAL_MIN || 10)) * 60000;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { const n = await checkFuelAlerts(); if (n) console.log(`[fuel] ${n} alert(s) sent.`); }
    catch (err) { console.error('[fuel] alert check failed:', err.message); }
    finally { running = false; }
  };
  setTimeout(run, 30000).unref();
  setInterval(run, every).unref();
}

module.exports = { checkFuelAlerts, startFuelAlerts };
