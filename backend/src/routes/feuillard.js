const express = require('express');
const { sql, getFeuillardPool } = require('../feuillardDb');
const { requireAuth } = require('../middleware/auth');
const { requireFeature } = require('../features');
const S = require('../feuillardStats');

// Strapping module (database "feuillard", read only for now).
//   GET /stats/options                          lists for the filters
//   GET /stats/production?from&to&poste&unite   dashboard: wagons / pallets per brick, coils issued / returned / used
//   GET /stats/dechet?from&to&unite&chef        waste in metres per shift record, per team leader, per unit
//   GET /stats/arrets?from&to&unite&ligne       machine stoppages
//   GET /stats/causes?from&to&unite&type        waste causes (Ishikawa) ranked by frequency
const router = express.Router();
const stats = [requireAuth, requireFeature('feuillard.stats')];

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const fail = (res, err, what) => { console.error(`feuillard ${what} error:`, err); res.status(500).json({ error: 'Erreur serveur (base feuillard inaccessible ?).' }); };
const txt = (v) => (typeof v === 'string' ? v.trim().slice(0, 60) : '');
function period(req, res) {
  const today = new Date().toISOString().slice(0, 10);
  const to = ISO.test(req.query.to || '') ? req.query.to : today;
  const from = ISO.test(req.query.from || '') ? req.query.from : new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  if (from > to) { res.status(400).json({ error: 'Période invalide.' }); return null; }
  if ((new Date(to) - new Date(from)) / 864e5 > 800) { res.status(400).json({ error: 'Période trop longue (800 jours maximum).' }); return null; }
  return { from, to };
}
const rq = async (P) => { const pool = await getFeuillardPool(); return pool.request().input('d1', sql.Date, P.from).input('d2', sql.Date, P.to); };

router.get('/stats/options', stats, async (_req, res) => {
  try {
    const pool = await getFeuillardPool();
    const q = async (t) => (await pool.request().query(`select nom from ${t} order by nom`)).recordset.map((x) => String(x.nom).trim());
    const lignes = (await pool.request().query('select distinct ligne from encercleuse order by ligne')).recordset.map((x) => String(x.ligne).trim());
    res.json({ unites: await q('destination'), chefs: await q('receptionniste'), postes: ['Jour', 'Soir', 'Nuit'], lignes, types: ['Main_ouevre', 'Methode', 'Matiere', 'Milieu', 'Machine'] });
  } catch (err) { fail(res, err, 'options'); }
});

router.get('/stats/production', stats, async (req, res) => {
  const P = period(req, res); if (!P) return;
  const poste = txt(req.query.poste), unite = txt(req.query.unite);
  try {
    const mk = async () => (await rq(P)).input('p', sql.VarChar, poste).input('u', sql.VarChar, unite);
    const prod = (await (await mk()).query(
      `select r.nom as chef, d.nom as unite, a.designation as article, a.id as art_id, p.id_article, p.id2_article, p.brique,
              p.nbre_wagon, p.wagon_h, p.nbre_palette, p.palette_h, p.nbre_bobine, p.nbre_bobine_2
       from production p
       inner join receptionniste r on p.id_receptionniste = r.id
       inner join destination d on p.id_destination = d.id
       inner join article_feuillard a on (p.id_article = a.id or p.id2_article = a.id)
       where p.date_production between @d1 and @d2 and (p.poste = @p or @p = '') and (d.nom = @u or @u = '')`)).recordset;
    const mv = (table, dateCol, withPoste) =>
      `select r.nom as chef, d.nom as unite, a.designation as article, sum(m.qt) as qt
       from ${table} m
       inner join receptionniste r on m.id_receptionniste = r.id
       inner join destination d on m.id_destination = d.id
       inner join article_feuillard a on m.id_article = a.id
       where m.${dateCol} between @d1 and @d2 ${withPoste ? "and (m.poste = @p or @p = '')" : ''} and (d.nom = @u or @u = '')
       group by r.nom, d.nom, a.designation`;
    const issues = (await (await mk()).query(mv('sortie_feuillard', 'date_sortie', true))).recordset;
    const returns = (await (await mk()).query(mv('retour_feuillard', 'date_retour', false))).recordset;
    const trim = (rows) => rows.map((x) => Object.assign({}, x, { chef: String(x.chef).trim(), unite: String(x.unite).trim(), article: String(x.article).trim() }));
    const d = S.productionDashboard(trim(prod), trim(issues), trim(returns));
    res.json(Object.assign({ from: P.from, to: P.to }, d));
  } catch (err) { fail(res, err, 'production'); }
});

router.get('/stats/dechet', stats, async (req, res) => {
  const P = period(req, res); if (!P) return;
  const unite = txt(req.query.unite), chef = txt(req.query.chef);
  try {
    const r = (await (await rq(P)).input('u', sql.VarChar, unite).input('c', sql.VarChar, chef).query(
      `select p.id, p.date_production as date, p.poste, p.brique, p.nbre_palette, p.palette_h, p.nbre_bobine, p.nbre_bobine_2,
              a1.qt_meter as qm1, a2.qt_meter as qm2, r.nom as chef, d.nom as unite
       from production p
       inner join receptionniste r on p.id_receptionniste = r.id
       inner join destination d on p.id_destination = d.id
       inner join article_feuillard a1 on p.id_article = a1.id
       left join article_feuillard a2 on p.id2_article = a2.id
       where p.date_production between @d1 and @d2 and (d.nom = @u or @u = '') and (r.nom = @c or @c = '')
       order by p.date_production desc, p.id desc`)).recordset;
    const rows = r.map((x) => Object.assign({}, x, { chef: String(x.chef).trim(), unite: String(x.unite).trim() }));
    res.json(Object.assign({ from: P.from, to: P.to }, S.wasteReport(rows)));
  } catch (err) { fail(res, err, 'dechet'); }
});

router.get('/stats/arrets', stats, async (req, res) => {
  const P = period(req, res); if (!P) return;
  try {
    const r = (await (await rq(P)).input('u', sql.VarChar, txt(req.query.unite)).input('l', sql.VarChar, txt(req.query.ligne)).query(
      `select d.nom as unite, e.ligne, e.designation as machine, c.cause_machine as cause, c.frequence, c.duree
       from cause_encercleuse c
       inner join encercleuse e on c.id_encercleuse = e.id
       inner join destination d on e.id_unite = d.id
       inner join production p on c.id_production = p.id
       where p.date_production between @d1 and @d2 and (d.nom = @u or @u = '') and (e.ligne = @l or @l = '')`)).recordset;
    res.json(Object.assign({ from: P.from, to: P.to }, S.stoppages(r.map((x) => ({ unite: String(x.unite).trim(), ligne: String(x.ligne).trim(), machine: String(x.machine).trim(), cause: String(x.cause).trim(), frequence: x.frequence, duree: x.duree })))));
  } catch (err) { fail(res, err, 'arrets'); }
});

router.get('/stats/causes', stats, async (req, res) => {
  const P = period(req, res); if (!P) return;
  try {
    const r = (await (await rq(P)).input('u', sql.VarChar, txt(req.query.unite)).input('t', sql.VarChar, txt(req.query.type)).query(
      `select d.nom as unite, i.type, i.designation, count(i.id) as n
       from production p
       inner join destination d on p.id_destination = d.id
       inner join ishikawa i on p.id = i.id_production
       where p.date_production between @d1 and @d2 and (d.nom = @u or @u = '') and (i.type = @t or @t = '')
       group by i.designation, d.nom, i.type
       order by count(i.id) desc`)).recordset;
    res.json({ from: P.from, to: P.to, rows: r.map((x) => ({ unite: String(x.unite).trim(), type: String(x.type).trim(), designation: String(x.designation).trim(), n: x.n })) });
  } catch (err) { fail(res, err, 'causes'); }
});

module.exports = router;
