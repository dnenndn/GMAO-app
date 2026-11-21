const { sql, getPool } = require('./db');
const { getAppPool } = require('./appDb');
const { notifyRoles } = require('./push');
const { loadPapiers } = require('./parcPapiers');

// Daily digest alerts (one push per kind per day, not one per item):
//  - engine paperwork (assurance / vignette / visite technique) expiring soon
//  - articles under their minimum stock
//  - preventive maintenance due today or overdue
// Dedup in app_notification_log (type + id_ref = YYYYMMDD) - nothing written to GMAO_NGES.
const DAYS = Number(process.env.PAPERWORK_ALERT_DAYS || 15);
const R_PARC = (process.env.PAPERWORK_ALERT_ROLES || 'Administrateur,Responsable Méthode,Responsable Magasin,Responsable Achat,Employé Parc').split(',').map((s) => s.trim()).filter(Boolean);
const R_STOCK = (process.env.STOCK_ALERT_ROLES || 'Administrateur,Responsable Méthode,Responsable Magasin,Responsable Achat').split(',').map((s) => s.trim()).filter(Boolean);
const R_PREV = (process.env.PREVENTIVE_ALERT_ROLES || 'Administrateur,Responsable Méthode,Responsable Technique,Responsable Maintenance').split(',').map((s) => s.trim()).filter(Boolean);

const dayKey = (d = new Date()) => Number(d.toISOString().slice(0, 10).replace(/-/g, ''));

async function alreadySent(type, key) {
  const p = await getAppPool();
  const r = await p.request().input('t', sql.NVarChar, type).input('k', sql.Int, key)
    .query('select 1 as x from app_notification_log where type = @t and id_ref = @k');
  return r.recordset.length > 0;
}

async function checkDailyAlerts(now = new Date()) {
  const key = dayKey(now);
  const pool = await getPool();
  const run = async (q) => (await pool.request().input('d', sql.Int, 0).input('b', sql.Bit, false).input('n', sql.Int, DAYS).query(q)).recordset;
  let sent = 0;

  if (!(await alreadySent('paperwork_alert', key))) {
    const rows = (await loadPapiers(pool, DAYS)).filter((x) => x.etat === 'expire' || x.etat === 'bientot');
    if (rows.length) {
      const late = rows.filter((r) => r.etat === 'expire').length;
      await notifyRoles(R_PARC, { type: 'paperwork_alert', idRef: key, title: 'Papiers engins à renouveler',
        body: `${rows.length} document(s) arrivent à échéance (préavis de chaque papier)${late ? ` dont ${late} déjà expiré(s)` : ''}.` });
      sent++;
    }
  }
  if (!(await alreadySent('stock_alert', key))) {
    const rows = await run('select count(*) as n, sum(case when stock_neuf <= 0 then 1 else 0 end) as r from article where deleted = @b and stock_mini > 0 and stock_neuf <= stock_mini');
    if (rows[0].n > 0) {
      await notifyRoles(R_STOCK, { type: 'stock_alert', idRef: key, title: 'Stock sous le minimum',
        body: `${rows[0].n} article(s) sous le minimum${rows[0].r ? ` dont ${rows[0].r} en rupture` : ''}.` });
      sent++;
    }
  }
  if (!(await alreadySent('preventive_alert', key))) {
    const rows = await run(`
      select count(*) as n from prev_syst_ech pe inner join prev_systematique ps on pe.id_rep = ps.id
      inner join equipement e on ps.equipement = e.id
      where e.deleted = @d and pe.deleted = @d and pe.date_ech <= cast(getdate() as date)
        and pe.date_ech >= dateadd(day, -30, cast(getdate() as date))`);
    if (rows[0].n > 0) {
      await notifyRoles(R_PREV, { type: 'preventive_alert', idRef: key, title: 'Préventif à réaliser',
        body: `${rows[0].n} opération(s) de maintenance préventive échues ou prévues aujourd'hui.` });
      sent++;
    }
  }
  return sent;
}

function startDailyAlerts() {
  if (process.env.DAILY_ALERTS_ENABLED === 'false') return;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { const n = await checkDailyAlerts(); if (n) console.log(`[alerts] ${n} digest(s) sent.`); }
    catch (err) { console.error('[alerts] check failed:', err.message); }
    finally { running = false; }
  };
  // Only between 07:00 and 18:00 so nobody is woken up; once per day per kind thanks to the log.
  const tick = () => { const h = new Date().getHours(); if (h >= 7 && h < 18) run(); };
  setTimeout(tick, 60000).unref();
  setInterval(tick, 30 * 60000).unref();
}

module.exports = { checkDailyAlerts, startDailyAlerts };
