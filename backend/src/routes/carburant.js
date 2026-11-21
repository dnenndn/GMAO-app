const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { analyseAll, RATIO } = require('../fuelAnalysis');
const { loadFuelSettings } = require('../fuelSettings');
const { requireFeature } = require('../features');
const { getAppPool } = require('../appDb');

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
const dateIso = (v) => (v instanceof Date ? iso(v) : String(v).slice(0, 10));
const r2 = (x) => Math.round(x * 100) / 100;
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
    const analysed = analyseAll(rows, { perEngine: await loadFuelSettings() });
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
        nb_alertes: inPeriod.filter((x) => x.alertes.length).length,
        nb_sans_compteur: inPeriod.filter((x) => x.sans_compteur).length
      });
    }
    engins.sort((a, b) => b.litres - a.litres);
    engins.forEach((x, i) => { x.rang = i + 1; });
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
    const settings = await loadFuelSettings();
    const list = (analyseAll(rows, { perEngine: settings }).get(id) || []);
    const fromS = iso(p.from);
    const sorties = list.filter((x) => iso(new Date(x.date)) >= fromS).reverse().map((x) => ({
      id: x.id, date: iso(new Date(x.date)), heure: x.heure, carburant: (x.carburant || '').trim(),
      quantite: Number(x.quantite), prix_ttc: Number(x.prix_ttc), compteur: x.compteur == null ? null : Number(x.compteur),
      taux: x.taux, alertes: x.alertes, sans_compteur: x.sans_compteur, ecart_qte: x.ecart_qte, ecart_taux: x.ecart_taux
    }));
    const head = list[0] || {};
    res.json({
      id_engin: id, matricule: (head.matricule || '').trim(), engin: (head.engin || '').trim(),
      vehicule: (head.vehicule || '').trim(), from: fromS, to: iso(p.to), sorties,
      seuil: { ratio: (settings.get(id) || {}).ratio || null, actif: (settings.get(id) || {}).actif !== false, defaut: RATIO }
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
    for (const list of analyseAll(rows, { perEngine: await loadFuelSettings() }).values()) {
      for (const x of list) {
        if ((x.alertes.length || x.sans_compteur) && iso(new Date(x.date)) >= since) {
          alertes.push({
            id: x.id, id_engin: x.id_engin, matricule: (x.matricule || '').trim(), engin: (x.engin || '').trim(),
            date: iso(new Date(x.date)), quantite: Number(x.quantite), taux: x.taux,
            alertes: x.sans_compteur ? [...x.alertes, 'compteur'] : x.alertes, ecart_qte: x.ecart_qte, ecart_taux: x.ecart_taux
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

// ---- Fuel tank checks (GMAO_APP.app_cuve_controle) -------------------------------------------------
// A person measures the litres really in the tank. Between two checks the app compares the measured
// change with what the desktop data explains:
//   expected = previous measure + deliveries (BL) - fuel issued to engines - other BSM issues of that article
//   gap      = measure - expected      (negative = fuel missing / unrecorded issue, positive = unrecorded delivery)
// stock_gap = measure - stock_neuf the desktop believed at the time of the check.
router.get('/cuve', requireFeature('parc.cuve'), async (req, res) => {
  try {
    const pool = await getPool(); const app = await getAppPool();
    const arts = await pool.request().input('d', sql.Bit, false).query(`
      select distinct a.id, a.designation, a.stock_neuf from engin_parc_liaison_carburant l
      inner join article a on l.id_carburant = a.id where l.deleted = @d order by a.designation`);
    const ctl = await app.request().query('select id, id_article, date_controle, litres_mesures, stock_theorique, note, id_user, created_at from app_cuve_controle order by date_controle, id');
    const out = [];
    for (const a of arts.recordset) {
      const list = ctl.recordset.filter((c) => c.id_article === a.id);
      const checks = [];
      for (let i = 0; i < list.length; i++) {
        const c = list[i], prev = list[i - 1];
        const item = { id: c.id, date: dateIso(c.date_controle), litres: Number(c.litres_mesures), stock_theorique: c.stock_theorique == null ? null : Number(c.stock_theorique), note: (c.note || '').trim(),
          ecart_stock: c.stock_theorique == null ? null : r2(Number(c.litres_mesures) - Number(c.stock_theorique)) };
        if (prev) {
          const rq = () => pool.request().input('i', sql.Int, a.id).input('d1', sql.Date, addDays(new Date(prev.date_controle), 1)).input('d2', sql.Date, new Date(c.date_controle));
          const [en, is, bs] = await Promise.all([
            rq().query('select isnull(sum(la.qt), 0) as v from livraison_article la inner join bon_livraison bl on la.id_livraison = bl.id where la.id_article = @i and bl.date_reel between @d1 and @d2'),
            rq().query('select isnull(sum(quantite), 0) as v from engin_sortie_carburant where id_carbu in (select id from engin_parc_liaison_carburant where id_carburant = @i) and date between @d1 and @d2 and deleted = 0'),
            rq().query('select isnull(sum(ba.quantite), 0) as v from bsm_article ba inner join bsm b on ba.id_bsm = b.id where ba.id_article = @i and b.date_bsm between @d1 and @d2')
          ]);
          const entrees = Number(en.recordset[0].v), engins = Number(is.recordset[0].v), bsm = Number(bs.recordset[0].v);
          const attendu = Number(prev.litres_mesures) + entrees - engins - bsm;
          Object.assign(item, { entrees: r2(entrees), sorties_engins: r2(engins), sorties_bsm: r2(bsm), attendu: r2(attendu), ecart: r2(Number(c.litres_mesures) - attendu) });
        }
        checks.push(item);
      }
      out.push({ id_article: a.id, designation: (a.designation || '').trim(), stock_desktop: Number(a.stock_neuf), controles: checks.slice(-12).reverse() });
    }
    res.json({ articles: out });
  } catch (err) {
    console.error('carburant cuve error:', err);
    res.status(500).json({ error: 'Erreur serveur (la table des contrôles est-elle créée ? voir sql/10_cuve_controle.sql).' });
  }
});

router.post('/cuve', requireFeature('parc.cuve'), async (req, res) => {
  const b = req.body || {};
  const id = Number.parseInt(b.id_article, 10);
  const litres = Number(b.litres);
  const note = String(b.note || '').trim().slice(0, 200);
  const date = b.date ? parseDate(b.date) : parseDate(iso(new Date()));
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Carburant invalide.' });
  if (!Number.isFinite(litres) || litres < 0 || litres > 10000000) return res.status(400).json({ error: 'Litres mesurés invalides.' });
  if (!date || date > parseDate(iso(new Date()))) return res.status(400).json({ error: 'Date invalide (pas dans le futur).' });
  try {
    const pool = await getPool();
    const a = await pool.request().input('i', sql.Int, id).input('d', sql.Bit, false).query(`
      select a.stock_neuf from article a inner join engin_parc_liaison_carburant l on l.id_carburant = a.id where a.id = @i and l.deleted = @d`);
    if (a.recordset.length === 0) return res.status(404).json({ error: "Ce n'est pas un carburant du parc." });
    const app = await getAppPool();
    const last = await app.request().input('i', sql.Int, id).query('select max(date_controle) as d from app_cuve_controle where id_article = @i');
    if (last.recordset[0].d && date < new Date(last.recordset[0].d)) return res.status(400).json({ error: 'Il existe déjà un contrôle plus récent pour ce carburant.' });
    await app.request().input('i', sql.Int, id).input('dt', sql.Date, date).input('l', sql.Float, litres).input('s', sql.Float, Number(a.recordset[0].stock_neuf))
      .input('n', sql.NVarChar, note || null).input('u', sql.Int, req.user.id)
      .query('insert into app_cuve_controle (id_article, date_controle, litres_mesures, stock_theorique, note, id_user) values (@i, @dt, @l, @s, @n, @u)');
    res.json({ ok: true });
  } catch (err) {
    console.error('carburant cuve save error:', err);
    res.status(500).json({ error: 'Erreur serveur (la table des contrôles est-elle créée ? voir sql/10_cuve_controle.sql).' });
  }
});

// Per-engine alert threshold (managers). ratio: 1.1 - 5 (1.5 = alert at +50 %), or null for the
// default; actif=false mutes the engine. Stored in GMAO_APP only.
router.put('/seuils/:id', requireFeature('parc.seuils'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Engin invalide.' });
  const b = req.body || {};
  let ratio = null;
  if (b.ratio != null && b.ratio !== '') {
    ratio = Number(b.ratio);
    if (!Number.isFinite(ratio) || ratio < 1.1 || ratio > 5) return res.status(400).json({ error: 'Seuil invalide (entre 1,1 et 5).' });
  }
  const actif = b.actif !== false;
  try {
    const pool = await getPool();
    const e = await pool.request().input('i', sql.Int, id).input('d', sql.Bit, false).query('select 1 as x from engins where id = @i and deleted = @d');
    if (e.recordset.length === 0) return res.status(404).json({ error: 'Engin introuvable.' });
    const app = await getAppPool();
    await app.request().input('i', sql.Int, id).input('r', sql.Float, ratio).input('a', sql.Bit, actif).input('u', sql.Int, req.user.id).query(`
      merge app_engin_seuil as t using (select @i as id_engin) as s on t.id_engin = s.id_engin
      when matched then update set ratio = @r, actif = @a, updated_by = @u, updated_at = getdate()
      when not matched then insert (id_engin, ratio, actif, updated_by) values (@i, @r, @a, @u);`);
    res.json({ ok: true });
  } catch (err) {
    console.error('carburant seuil error:', err);
    res.status(500).json({ error: 'Erreur serveur (la table des seuils est-elle créée ? voir sql/06_engin_seuil.sql).' });
  }
});

module.exports = router;
module.exports.loadSorties = loadSorties;
