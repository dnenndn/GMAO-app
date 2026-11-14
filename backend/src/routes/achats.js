const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { canSeeMoney } = require('../roles');
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
  if (!canSeeMoney(req.user?.fonction)) return res.status(403).json({ error: "Vous n'avez pas les droits pour cette action." });
  next();
});

const CMD_STATUS = { 0: 'En attente', 1: 'En cours', 5: 'Annulée', 10: 'Clôturée' };
const CMD_FILTER = { attente: 0, encours: 1, annulee: 5, cloturee: 10 };
const dateText = (v) => (v instanceof Date ? iso(v) : v ? String(v).slice(0, 10) : null);
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
      commandes: r.recordset.map((c) => ({ id: c.id, numero: (c.n_commande || '').trim(), date: dateText(c.date_commande), statut: c.statut,
        statut_label: CMD_STATUS[c.statut] || String(c.statut), urgence: (c.urgence || '').trim(), fournisseur: (c.fournisseur || '').trim(), montant: money(c.montant) }))
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
    res.json({ lignes: r.recordset.map((l) => ({ code: (l.code_article || '').trim(), designation: (l.designation || '').trim(),
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
      inner join reception re on bl.id_reception = re.id
      inner join fournisseur fo on re.id_fournisseur = fo.id
      left join livraison_article la on la.id_livraison = bl.id
      ${where}
      group by bl.id, bl.date_reel, bl.bl_fournisseur, bl.statut, fo.nom
      order by bl.date_reel desc, bl.id desc`);
    res.json({
      from: iso(p.from), to: iso(p.to),
      bl: r.recordset.map((b) => ({ id: b.id, date: dateText(b.date_reel), numero: (b.bl_fournisseur || '').trim(), facture: b.statut === 1,
        fournisseur: (b.fournisseur || '').trim(), montant: money(b.montant) }))
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
      factures: r.recordset.map((x) => ({ id: x.id, numero: (x.n_facture || '').trim(), date: dateText(x.date_reel),
        fournisseur: (x.fournisseur || '').trim(), montant_ht: money(x.montant) })),
      total_ht: money(r.recordset.reduce((s, x) => s + Number(x.montant || 0), 0))
    });
  } catch (err) {
    console.error('achats factures error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
