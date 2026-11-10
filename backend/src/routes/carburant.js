const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { analyseAll } = require('../fuelAnalysis');

// Diesel per engine - READ ONLY. Everything is read from the desktop tables
// (engins, engin_sortie_carburant, bon_de_carburant ...); nothing is written
// to GMAO_NGES.
//   GET /engins?from&to        consumption per engine over a period
//   GET /engins/:id?from&to    the fuel issues of one engine (with alerts)
//   GET /bons?from&to          fuel vouchers
//   GET /alertes               issues flagged "consomme plus que d'habitude"
const router = express.Router();
router.use(requireAuth);

const HISTORY_DAYS = 180;   // history used to judge "usual" consumption

function parseDate(v) {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 ? d : null;
}
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

function period(req) {
  const today = parseDate(iso(new Date()));
  const to = req.query.to ? parseDate(req.query.to) : today;
  const from = req.query.from ? parseDate(req.query.from) : addDays(to || today, -30);
  if (!from || !to) return { error: 'Dates invalides (format AAAA-MM-JJ).' };
  if (from > to) return { error: 'La date de début est après la date de fin.' };
  if ((to - from) / 86400000 > 400) return { error: 'Période trop longue (400 jours maximum).' };
  return { from, to };
}

// Issues from `since` to `to`, with the engine/fuel names. Used both for the
// lists and as the history for the alert analysis.
async function loadSorties(pool, since, to, idEngin) {
  const rq = pool.request()
    .input('d1', sql.Date, since)
    .input('d2', sql.Date, to)
    .input('del', sql.Bit, false);
  if (idEngin != null) rq.input('e', sql.Int, idEngin);
  const r = await rq.query(`
    select s.id, s.id_engin, e.matricule, e.designation as engin, v.designation as vehicule,
           s.date, left(cast(s.heure as varchar(20)), 5) as heure,
           s.quantite, s.prix_u, s.prix_ttc, s.compteur, a.designation as carburant
    from engin_sortie_carburant s
    inner join engins e on s.id_engin = e.id
    left join type_de_vehicule v on e.id_vehicule = v.id
    left join engin_parc_liaison_carburant l on s.id_carbu = l.id
    left join article a on l.id_carburant = a.id
    where s.date between @d1 and @d2 and s.deleted = @del
      ${idEngin != null ? 'and s.id_engin = @e' : ''}`);
  return r.recordset;
}

router.get('/engins', async (req, res) => {
  const p = period(req);
  if (p.error) return res.status(400).json({ error: p.error });
  try {
    const pool = await getPool();
    const rows = await loadSorties(pool, addDays(p.to, -HISTORY_DAYS), p.to);
    const analysed = analyseAll(rows);
    const fromS = iso(p.from);
    const engins = [];
    for (const [id, list] of analysed) {
      const inPeriod = list.filter((x) => iso(new Date(x.date)) >= fromS);
      if (inPeriod.length === 0) continue;
      const litres = inPeriod.reduce((s, x) => s + Number(x.quantite || 0), 0);
      const cout = inPeriod.reduce((s, x) => s + Number(x.prix_ttc || 0), 0);
      const withCounter = inPeriod.filter((x) => Number(x.compteur) > 0);
      const last = inPeriod[inPeriod.length - 1];
      const rates = inPeriod.map((x) => x.taux).filter((x) => x != null);
      engins.push({
        id_engin: id,
        matricule: (last.matricule || '').trim(),
        engin: (last.engin || '').trim(),
        vehicule: (last.vehicule || '').trim(),
        nb_sorties: inPeriod.length,
        litres: Math.round(litres * 100) / 100,
        cout: Math.round(cout * 1000) / 1000,
        taux_moyen: rates.length ? Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 10000) / 10000 : null,
        dernier_compteur: withCounter.length ? Number(withCounter[withCounter.length - 1].compteur) : null,
        derniere_date: iso(new Date(last.date)),
        nb_alertes: inPeriod.filter((x) => x.alertes.length).length
      });
    }
    engins.sort((a, b) => b.litres - a.litres);
    res.json({
      from: fromS, to: iso(p.to), engins,
      total_litres: Math.round(engins.reduce((s, x) => s + x.litres, 0) * 100) / 100,
      total_cout: Math.round(engins.reduce((s, x) => s + x.cout, 0) * 1000) / 1000
    });
  } catch (err) {
    console.error('carburant engins error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.get('/engins/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Engin invalide.' });
  const p = period(req);
  if (p.error) return res.status(400).json({ error: p.error });
  try {
    const pool = await getPool();
    const rows = await loadSorties(pool, addDays(p.to, -HISTORY_DAYS), p.to, id);
    const list = (analyseAll(rows).get(id) || []);
    const fromS = iso(p.from);
    const sorties = list.filter((x) => iso(new Date(x.date)) >= fromS).reverse().map((x) => ({
      id: x.id, date: iso(new Date(x.date)), heure: x.heure, carburant: (x.carburant || '').trim(),
      quantite: Number(x.quantite), prix_ttc: Number(x.prix_ttc), compteur: x.compteur == null ? null : Number(x.compteur),
      taux: x.taux, alertes: x.alertes, ecart_qte: x.ecart_qte, ecart_taux: x.ecart_taux
    }));
    const head = list[0] || {};
    res.json({
      id_engin: id, matricule: (head.matricule || '').trim(), engin: (head.engin || '').trim(),
      vehicule: (head.vehicule || '').trim(), from: fromS, to: iso(p.to), sorties
    });
  } catch (err) {
    console.error('carburant engin error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.get('/bons', async (req, res) => {
  const p = period(req);
  if (p.error) return res.status(400).json({ error: p.error });
  try {
    const pool = await getPool();
    const r = await pool.request()
      .input('d1', sql.Date, p.from).input('d2', sql.Date, p.to).input('del', sql.Bit, false)
      .query(`
        select b.id, b.nom, b.date, b.quantite, b.prix_u, b.prix_ttc,
               e.matricule, e.designation as engin, c.nom as chauffeur, t.designation as carburant
        from bon_de_carburant b
        left join engins e on b.id_engin = e.id
        left join chauffeur c on b.id_chauffeur = c.id
        left join type_de_carburant t on b.id_type_carburant = t.id
        where b.date between @d1 and @d2 and b.deleted = @del
        order by b.date desc, b.id desc`);
    const bons = r.recordset.map((b) => ({
      id: b.id, nom: (b.nom || '').trim(), date: iso(new Date(b.date)),
      quantite: Number(b.quantite), prix_ttc: Number(b.prix_ttc),
      matricule: (b.matricule || '').trim(), engin: (b.engin || '').trim(),
      chauffeur: (b.chauffeur || '').trim(), carburant: (b.carburant || '').trim()
    }));
    res.json({
      from: iso(p.from), to: iso(p.to), bons,
      total_litres: Math.round(bons.reduce((s, x) => s + x.quantite, 0) * 100) / 100,
      total_cout: Math.round(bons.reduce((s, x) => s + x.prix_ttc, 0) * 1000) / 1000
    });
  } catch (err) {
    console.error('carburant bons error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.get('/alertes', async (req, res) => {
  try {
    const pool = await getPool();
    const today = parseDate(iso(new Date()));
    const rows = await loadSorties(pool, addDays(today, -HISTORY_DAYS), today);
    const since = iso(addDays(today, -30));
    const alertes = [];
    for (const list of analyseAll(rows).values()) {
      for (const x of list) {
        if (x.alertes.length && iso(new Date(x.date)) >= since) {
          alertes.push({
            id: x.id, id_engin: x.id_engin, matricule: (x.matricule || '').trim(), engin: (x.engin || '').trim(),
            date: iso(new Date(x.date)), quantite: Number(x.quantite), taux: x.taux,
            alertes: x.alertes, ecart_qte: x.ecart_qte, ecart_taux: x.ecart_taux
          });
        }
      }
    }
    alertes.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
    res.json({ alertes });
  } catch (err) {
    console.error('carburant alertes error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
module.exports.loadSorties = loadSorties;
