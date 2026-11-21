const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { can } = require('../features');
const { iso, period, likeEscape, intParam } = require('../lib');

// Purchasing follow-up - READ ONLY (orders, delivery notes, invoices).
// Same tables and status codes as the desktop:
//   commande.statut        0 En attente, 1 En cours, 5 Annulée, 10 Clôturée
//   bon_livraison.statut   0 Non facturé, 1 Facturé
// Amounts are HT, remise applied: qt * prix_ht * (1 - remise / 100).
// Only the roles that may see money get these screens.
const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => {
  if (!can(req, 'achats.view')) return res.status(403).json({ error: "Vous n'avez pas les droits pour cette action." });
  next();
});

const CMD_STATUS = { 0: 'En attente', 1: 'En cours', 5: 'Annulée', 10: 'Clôturée' };
const CMD_FILTER = { attente: 0, encours: 1, annulee: 5, cloturee: 10 };
const dateText = (v) => (v instanceof Date ? iso(v) : v ? String(v).slice(0, 10) : null);
const str = (v) => (v == null ? '' : String(v)).trim();   // some desktop columns are numeric
const money = (x) => Math.round(Number(x || 0) * 1000) / 1000;

router.get('/commandes', async (req, res) => {
  const p = period(req, 90);
  if (p.error) return res.status(400).json({ error: p.error });
  const st = req.query.statut && req.query.statut !== 'all' ? CMD_FILTER[req.query.statut] : null;
  if (req.query.statut && req.query.statut !== 'all' && st == null) return res.status(400).json({ error: 'Statut invalide.' });
  try {
    const pool = await getPool();
    const rq = pool.request().input('d1', sql.Date, p.from).input('d2', sql.Date, p.to);
    let where = 'where c.date_commande between @d1 and @d2';
    if (st != null) { rq.input('s', sql.Int, st); where += ' and c.statut = @s'; }
    const q = String(req.query.search || '').trim().slice(0, 60);
    if (q) { rq.input('q', sql.NVarChar, `%${likeEscape(q)}%`); where += " and (f.nom like @q escape '\\' or c.n_commande like @q escape '\\')"; }
    const r = await rq.query(`
      select top 200 c.id, c.n_commande, c.date_commande, c.statut, c.urgence, f.nom as fournisseur,
             sum(ca.qt_commande * ca.prix_ht * (1 - isnull(ca.remise, 0) / 100.0)) as montant
      from commande c
      inner join fournisseur f on c.id_fournisseur = f.id
      left join commande_article ca on ca.id_commande = c.id
      ${where}
      group by c.id, c.n_commande, c.date_commande, c.statut, c.urgence, f.nom
      order by c.date_commande desc, c.id desc`);
    res.json({
      from: iso(p.from), to: iso(p.to),
      commandes: r.recordset.map((c) => ({ id: c.id, numero: str(c.n_commande), date: dateText(c.date_commande), statut: c.statut,
        statut_label: CMD_STATUS[c.statut] || String(c.statut), urgence: str(c.urgence), fournisseur: str(c.fournisseur), montant: money(c.montant) }))
    });
  } catch (err) {
    console.error('achats commandes error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.get('/commandes/:id', async (req, res) => {
  const id = intParam(req.params.id);
  if (id == null) return res.status(400).json({ error: 'Commande invalide.' });
  try {
    const pool = await getPool();
    const r = await pool.request().input('id', sql.Int, id).query(`
      select a.code_article, a.designation, ca.qt_commande, ca.prix_ht, ca.remise
      from commande_article ca
      inner join da_article da on ca.id_da_article = da.id
      inner join article a on da.id_article = a.id
      where ca.id_commande = @id order by a.designation`);
    res.json({ lignes: r.recordset.map((l) => ({ code: str(l.code_article), designation: str(l.designation),
      quantite: Number(l.qt_commande), prix_ht: money(l.prix_ht), remise: Number(l.remise || 0),
      total: money(l.qt_commande * l.prix_ht * (1 - Number(l.remise || 0) / 100)) })) });
  } catch (err) {
    console.error('achats commande lines error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.get('/bl', async (req, res) => {
  const p = period(req, 90);
  if (p.error) return res.status(400).json({ error: p.error });
  const f = req.query.facture === '0' ? 0 : req.query.facture === '1' ? 1 : null;
  try {
    const pool = await getPool();
    const rq = pool.request().input('d1', sql.Date, p.from).input('d2', sql.Date, p.to);
    let where = 'where bl.date_reel between @d1 and @d2';
    if (f != null) { rq.input('f', sql.Int, f); where += ' and bl.statut = @f'; }
    const r = await rq.query(`
      select top 200 bl.id, bl.date_reel, bl.bl_fournisseur, bl.statut, fo.nom as fournisseur,
             sum(la.qt * la.prix_ht * (1 - isnull(la.remise, 0) / 100.0)) as montant
      from bon_livraison bl
      outer apply (select top 1 c.id_fournisseur from reception_commande rc inner join commande c on rc.id_commande = c.id
                   where rc.id_reception = bl.id_reception) rcf
      inner join fournisseur fo on rcf.id_fournisseur = fo.id
      left join livraison_article la on la.id_livraison = bl.id
      ${where}
      group by bl.id, bl.date_reel, bl.bl_fournisseur, bl.statut, fo.nom
      order by bl.date_reel desc, bl.id desc`);
    res.json({
      from: iso(p.from), to: iso(p.to),
      bl: r.recordset.map((b) => ({ id: b.id, date: dateText(b.date_reel), numero: str(b.bl_fournisseur), facture: b.statut === 1,
        fournisseur: str(b.fournisseur), montant: money(b.montant) }))
    });
  } catch (err) {
    console.error('achats bl error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.get('/factures', async (req, res) => {
  const p = period(req, 90);
  if (p.error) return res.status(400).json({ error: p.error });
  try {
    const pool = await getPool();
    const r = await pool.request().input('d1', sql.Date, p.from).input('d2', sql.Date, p.to).query(`
      select top 200 fa.id, fa.n_facture, fa.date_reel, fo.nom as fournisseur,
             sum(la.qt * la.prix_ht * (1 - isnull(la.remise, 0) / 100.0)) as montant
      from facture fa
      inner join fournisseur fo on fa.id_fournisseur = fo.id
      inner join facture_livraison fl on fl.id_facture = fa.id
      inner join livraison_article la on la.id_livraison = fl.id_livraison
      where fa.date_reel between @d1 and @d2
      group by fa.id, fa.n_facture, fa.date_reel, fo.nom
      order by fa.date_reel desc, fa.id desc`);
    res.json({
      from: iso(p.from), to: iso(p.to),
      factures: r.recordset.map((x) => ({ id: x.id, numero: str(x.n_facture), date: dateText(x.date_reel),
        fournisseur: str(x.fournisseur), montant_ht: money(x.montant) })),
      total_ht: money(r.recordset.reduce((s, x) => s + Number(x.montant || 0), 0))
    });
  } catch (err) {
    console.error('achats factures error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ---- Synthèse des achats (état par famille / achats vs consommation) -------------
// Same tables and amounts as the desktop purchasing reports (backend_achat.cs):
//   commandes : commande.date_signature, commande_article via da_article -> article
//   livraisons: bon_livraison.date_reel, livraison_article
//   factures  : facture.date_reel, livraison_article of the invoiced BL, TVA of the invoice
// HT = qt x prix_ht x (1 - remise/100); TTC = HT x (1 + tva/100), tva = article.tva
// (facture.tva for invoices). Each article is counted once (first sous-famille),
// unlike the desktop joins which repeat an article with several units/sous-familles.
// Consommation = BSM lines (qt x prix_ht); gasoil consumption = engin_sortie_carburant.
const SOURCES = ['commandes', 'livraisons', 'factures'];
const FAMILLE_LUBRIFIANT = (process.env.ACHAT_FAMILLES_LUBRIFIANT || 'LUBRIFIANT').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
const FAMILLES_HORS_PR = (process.env.ACHAT_FAMILLES_HORS_PR || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
const FUEL_JOIN = 'left join (select distinct id_carburant from engin_parc_liaison_carburant where id_carburant is not null) fu on fu.id_carburant = a.id';
const FUEL_FLAG = 'case when fu.id_carburant is null then 0 else 1 end';
const FAM_OF = `outer apply (select top 1 sf.id_famille from tableau_article_sous_famille t
                 inner join sous_famille sf on sf.id = t.id_sous_famille where t.id_article = a.id order by sf.id) fx
                 left join famille f on f.id = fx.id_famille ${FUEL_JOIN}`;
const r3 = (x) => Math.round(Number(x || 0) * 1000) / 1000;

function monthRange(m) {
  const k = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(m || ''));
  if (!k) return null;
  const y = +k[1], mo = +k[2];
  return { from: new Date(Date.UTC(y, mo - 1, 1)), to: new Date(Date.UTC(y, mo, 0)), label: `${k[2]}/${k[1]}` };
}

// One row per (famille, fuel?) for the chosen purchasing stage.
function achatSql(source) {
  const net = '(x.qt * x.prix_ht * (1 - isnull(x.remise, 0) / 100.0))';
  if (source === 'commandes') return `
    select f.id as id_famille, f.designation as famille, ${FUEL_FLAG} as fuel,
           sum(x.qt) as qte, sum(${net}) as ht, sum(${net} * (1 + isnull(a.tva, 0) / 100.0)) as ttc
    from (select c.id as id_cmd, ca.qt_commande as qt, ca.prix_ht, ca.remise, da.id_article
          from commande c inner join commande_article ca on ca.id_commande = c.id inner join da_article da on ca.id_da_article = da.id
          where c.statut <> 5 and c.date_signature between @d1 and @d2) x
    inner join article a on a.id = x.id_article ${FAM_OF}
    group by f.id, f.designation, ${FUEL_FLAG}`;
  if (source === 'livraisons') return `
    select f.id as id_famille, f.designation as famille, ${FUEL_FLAG} as fuel,
           sum(x.qt) as qte, sum(${net}) as ht, sum(${net} * (1 + isnull(a.tva, 0) / 100.0)) as ttc
    from (select la.qt, la.prix_ht, la.remise, la.id_article
          from bon_livraison bl inner join livraison_article la on la.id_livraison = bl.id
          where bl.date_reel between @d1 and @d2) x
    inner join article a on a.id = x.id_article ${FAM_OF}
    group by f.id, f.designation, ${FUEL_FLAG}`;
  return `
    select f.id as id_famille, f.designation as famille, ${FUEL_FLAG} as fuel,
           sum(x.qt) as qte, sum(${net}) as ht, sum(${net} * (1 + isnull(x.tva, 0) / 100.0)) as ttc
    from (select la.qt, la.prix_ht, la.remise, la.id_article, fa.tva
          from facture fa inner join facture_livraison fl on fl.id_facture = fa.id inner join livraison_article la on la.id_livraison = fl.id_livraison
          where fa.date_reel between @d1 and @d2) x
    inner join article a on a.id = x.id_article ${FAM_OF}
    group by f.id, f.designation, ${FUEL_FLAG}`;
}

const consoSql = `
  select f.id as id_famille, f.designation as famille, sum(ba.quantite * ba.prix_ht) as montant
  from bsm b inner join bsm_article ba on ba.id_bsm = b.id
  inner join article a on a.id = ba.id_article ${FAM_OF}
  where b.date_bsm between @d1 and @d2 and ba.quantite <> 0 and fu.id_carburant is null
  group by f.id, f.designation`;

const rq2 = (pool, r) => pool.request().input('d1', sql.Date, r.from).input('d2', sql.Date, r.to);
const famName = (x) => (x.famille || '(Sans famille)').trim();
const upper = (x) => famName(x).toUpperCase();
function categoryOf(x) {
  if (x.fuel) return 'gasoil';
  if (FAMILLE_LUBRIFIANT.includes(upper(x))) return 'lubrifiant';
  if (FAMILLES_HORS_PR.includes(upper(x))) return null;
  return 'pieces';
}
const CATS = [['gasoil', 'GASOIL'], ['lubrifiant', 'LUBRIFIANT'], ['pieces', 'PIÈCES DE RECHANGE']];

function parseSynth(req, res) {
  const r = monthRange(req.query.month);
  const source = req.query.source || 'livraisons';
  if (!r) { res.status(400).json({ error: 'Mois invalide (format AAAA-MM).' }); return null; }
  if (!SOURCES.includes(source)) { res.status(400).json({ error: 'Source invalide.' }); return null; }
  return { r, source };
}

// Picture 1: purchases per famille (TTC) + general status of the month.
router.get('/synthese/general', async (req, res) => {
  const q = parseSynth(req, res); if (!q) return;
  try {
    const pool = await getPool();
    const [ach, cmd, bl, da] = await Promise.all([
      rq2(pool, q.r).query(achatSql(q.source)),
      rq2(pool, q.r).query(`
        select x.statut, count(distinct x.id) as nb, sum(x.ht * (1 + isnull(x.tva, 0) / 100.0)) as ttc from (
          select c.id, c.statut, a.tva, ca.qt_commande * ca.prix_ht * (1 - isnull(ca.remise, 0) / 100.0) as ht
          from commande c inner join commande_article ca on ca.id_commande = c.id inner join da_article da on ca.id_da_article = da.id
          inner join article a on a.id = da.id_article where c.date_signature between @d1 and @d2) x group by x.statut`),
      rq2(pool, q.r).query(`
        select count(distinct x.id) as nb, sum(x.ht * (1 + isnull(x.tva, 0) / 100.0)) as ttc from (
          select bl.id, a.tva, la.qt * la.prix_ht * (1 - isnull(la.remise, 0) / 100.0) as ht
          from bon_livraison bl inner join livraison_article la on la.id_livraison = bl.id inner join article a on a.id = la.id_article
          where bl.statut = 0 and bl.date_reel between @d1 and @d2) x`),
      rq2(pool, q.r).query('select statut, count(*) as nb from demande_achat where date_da between @d1 and @d2 group by statut')
    ]);
    // one line per famille; fuel articles get their own GASOIL line so Général matches Par famille
    const byFam = new Map();
    for (const x of ach.recordset) {
      const k = x.fuel ? 'GASOIL' : famName(x); const cur = byFam.get(k) || { famille: k, total_ttc: 0, total_ht: 0 };
      cur.total_ttc += Number(x.ttc || 0); cur.total_ht += Number(x.ht || 0); byFam.set(k, cur);
    }
    const familles = [...byFam.values()].map((f) => ({ ...f, total_ttc: r3(f.total_ttc), total_ht: r3(f.total_ht) })).sort((a, b) => b.total_ttc - a.total_ttc);
    const CMD = { 0: 'En attente', 1: 'En cours', 5: 'Annulée', 10: 'Clôturée' };
    const DA = { 0: 'En cours', 1: 'Confirmées', 2: 'Refusées', 3: 'Chez l\'administrateur', 4: 'Reportées', 10: 'Clôturées' };
    res.json({
      month: req.query.month, label: q.r.label, source: q.source, familles,
      total_ttc: r3(familles.reduce((s, f) => s + f.total_ttc, 0)), total_ht: r3(familles.reduce((s, f) => s + f.total_ht, 0)),
      statuts: {
        commandes: cmd.recordset.map((x) => ({ statut: x.statut, label: CMD[x.statut] || String(x.statut), nb: x.nb, ttc: r3(x.ttc) })),
        bl_non_factures: { nb: (bl.recordset[0] || {}).nb || 0, ttc: r3((bl.recordset[0] || {}).ttc) },
        da: da.recordset.map((x) => ({ statut: x.statut, label: DA[x.statut] || String(x.statut), nb: x.nb }))
      }
    });
  } catch (err) {
    console.error('achats synthese general error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// Picture 2: purchases vs consumption per category.
async function loadCategories(pool, q) {
  const [ach, conso, fuel] = await Promise.all([
    rq2(pool, q.r).query(achatSql(q.source)),
    rq2(pool, q.r).query(consoSql),
    rq2(pool, q.r).query('select sum(quantite) as qte, sum(prix_ttc) as ttc from engin_sortie_carburant where date between @d1 and @d2 and deleted = 0')
  ]);
  const cats = new Map(CATS.map(([k, l]) => [k, { code: k, label: l, achat: { qte: 0, montant: 0 }, consommation: { qte: 0, montant: 0 } }]));
  for (const x of ach.recordset) {
    const c = cats.get(categoryOf(x)); if (!c) continue;
    c.achat.montant += Number(x.ttc || 0);
    if (c.code === 'gasoil') c.achat.qte += Number(x.qte || 0);
  }
  for (const x of conso.recordset) {
    const k = categoryOf({ ...x, fuel: 0 }); const c = cats.get(k); if (!c) continue;
    c.consommation.montant += Number(x.montant || 0);
  }
  const f = fuel.recordset[0] || {};
  cats.get('gasoil').consommation.qte = Number(f.qte || 0);
  cats.get('gasoil').consommation.montant = Number(f.ttc || 0);
  return { cats, ach: ach.recordset, conso: conso.recordset };
}

router.get('/synthese/categories', async (req, res) => {
  const q = parseSynth(req, res); if (!q) return;
  try {
    const pool = await getPool();
    const { cats } = await loadCategories(pool, q);
    const categories = [...cats.values()].map((c) => ({ code: c.code, label: c.label,
      achat: { qte: r3(c.achat.qte), montant: r3(c.achat.montant) }, consommation: { qte: r3(c.consommation.qte), montant: r3(c.consommation.montant) } }));
    res.json({ month: req.query.month, label: q.r.label, source: q.source, categories,
      total_achats: r3(categories.reduce((s, c) => s + c.achat.montant, 0)), total_consommation: r3(categories.reduce((s, c) => s + c.consommation.montant, 0)) });
  } catch (err) {
    console.error('achats synthese categories error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// Detail of one category: per famille (gasoil: per engine).
router.get('/synthese/categories/:code', async (req, res) => {
  const q = parseSynth(req, res); if (!q) return;
  const code = req.params.code;
  if (!CATS.some(([k]) => k === code)) return res.status(400).json({ error: 'Catégorie invalide.' });
  try {
    const pool = await getPool();
    if (code === 'gasoil') {
      const r = await rq2(pool, q.r).query(`
        select e.designation as engin, e.matricule, sum(s.quantite) as qte, sum(s.prix_ttc) as ttc
        from engin_sortie_carburant s inner join engins e on e.id = s.id_engin
        where s.date between @d1 and @d2 and s.deleted = 0 group by e.id, e.designation, e.matricule order by sum(s.quantite) desc`);
      return res.json({ code, label: 'GASOIL', lignes: r.recordset.map((x) => ({ nom: `${(x.engin || '').trim()} ${(x.matricule || '').trim()}`.trim(), qte: r3(x.qte), consommation: r3(x.ttc) })) });
    }
    const { ach, conso } = await loadCategories(pool, q);
    const rows = new Map();
    const row = (k) => { if (!rows.has(k)) rows.set(k, { nom: k, achat: 0, consommation: 0 }); return rows.get(k); };
    ach.filter((x) => categoryOf(x) === code).forEach((x) => { row(famName(x)).achat += Number(x.ttc || 0); });
    conso.filter((x) => categoryOf({ ...x, fuel: 0 }) === code).forEach((x) => { row(famName(x)).consommation += Number(x.montant || 0); });
    res.json({ code, label: CATS.find(([k]) => k === code)[1],
      lignes: [...rows.values()].map((x) => ({ nom: x.nom, achat: r3(x.achat), consommation: r3(x.consommation) })).sort((a, b) => b.achat - a.achat) });
  } catch (err) {
    console.error('achats synthese detail error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
