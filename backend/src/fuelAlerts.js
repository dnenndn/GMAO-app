const { sql, getPool } = require('./db');
const { getAppPool } = require('./appDb');
const { notifyRoles } = require('./push');
const { analyseAll, describe } = require('./fuelAnalysis');
const { loadSorties } = require('./routes/carburant');
const { loadFuelSettings } = require('./fuelSettings');

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

  const settings = await loadFuelSettings();
  const analysed = [...analyseAll(rows, { perEngine: settings }).values()];
  const recentRows = (pick) => analysed.flatMap((list) => list.filter((x) => pick(x) && iso(new Date(x.date)) >= recent));
  const kinds = [
    { type: 'fuel_alert', flagged: recentRows((x) => x.alertes.length), title: 'Consommation gasoil anormale',
      body: (x, nom, jour) => `${nom} : ${describe(x)} le ${jour}` },
    { type: 'fuel_no_counter', flagged: recentRows((x) => x.sans_compteur), title: 'Compteur non saisi',
      body: (x, nom, jour) => `${nom} : ${Number(x.quantite)} L servis le ${jour} sans relevé de compteur.` }
  ];
  const appPool = await getAppPool();
  let sent = 0;
  for (const k of kinds) {
    if (k.flagged.length === 0) continue;
    const rq = appPool.request().input('t', sql.VarChar, k.type);
    k.flagged.forEach((x, i) => rq.input(`i${i}`, sql.Int, x.id));
    const seen = await rq.query(
      `select distinct id_ref from app_notification_log
       where type = @t and id_ref in (${k.flagged.map((_, i) => `@i${i}`).join(',')})`);
    const done = new Set(seen.recordset.map((r) => r.id_ref));
    const fresh = k.flagged.filter((x) => !done.has(x.id)).sort((a, b) => a.id - b.id);
    for (const x of fresh.slice(0, MAX_PER_RUN)) {
      const nom = `${(x.engin || '').trim()} ${(x.matricule || '').trim()}`.trim();
      await notifyRoles(ROLES, { type: k.type, idRef: x.id, title: k.title,
        body: k.body(x, nom, iso(new Date(x.date)).split('-').reverse().join('/')) });
      sent++;
    }
    if (fresh.length > MAX_PER_RUN) console.log(`[fuel] ${fresh.length - MAX_PER_RUN} more ${k.type} alert(s) will be sent on the next run.`);
  }
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
