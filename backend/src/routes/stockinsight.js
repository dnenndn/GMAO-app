const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { can } = require('../features');
const { likeEscape } = require('../lib');
const { suggestQty, openDaArticles } = require('../reorder');

// Stock insight - READ ONLY. Quantities for everyone, values (prix_ht) only
// for the roles that may see money.
const router = express.Router();
router.use(requireAuth);
const money = (x) => Math.round(Number(x || 0) * 1000) / 1000;

// Articles at or under their minimum (only where a minimum is defined).
router.get('/sous-minimum', async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request().input('d', sql.Bit, false).query(`
      select top 300 a.id, a.code_article, a.designation, a.stock_neuf, a.stock_mini, a.stock_maxi
      from article a
      where a.deleted = @d and a.stock_mini > 0 and a.stock_neuf <= a.stock_mini
      order by (a.stock_neuf - a.stock_mini), a.designation`);
    const open = await openDaArticles(pool, r.recordset.map((a) => a.id));
    res.json({ articles: r.recordset.map((a) => ({ id: a.id, code: (a.code_article || '').trim(), designation: (a.designation || '').trim(),
      stock: Number(a.stock_neuf), mini: Number(a.stock_mini), maxi: Number(a.stock_maxi || 0), rupture: Number(a.stock_neuf) <= 0,
      suggere: suggestQty(a.stock_neuf, a.stock_mini, a.stock_maxi), da_en_cours: open.has(a.id) })) });
  } catch (err) {
    console.error('stock sous-minimum error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// Stock with no issue (BSM) for N days.
router.get('/dormant', async (req, res) => {
  const days = Math.min(730, Math.max(30, Number.parseInt(req.query.jours, 10) || 180));
  try {
    const pool = await getPool();
    const r = await pool.request().input('d', sql.Bit, false).input('days', sql.Int, days).query(`
      select top 300 a.id, a.code_article, a.designation, a.stock_neuf, a.prix_ht,
             (select max(b.date_bsm) from bsm_article ba inner join bsm b on ba.id_bsm = b.id where ba.id_article = a.id) as derniere_sortie
      from article a
      where a.deleted = @d and a.stock_neuf > 0
        and not exists (select 1 from bsm_article ba inner join bsm b on ba.id_bsm = b.id
                        where ba.id_article = a.id and b.date_bsm >= dateadd(day, -@days, getdate()))
      order by a.stock_neuf * isnull(a.prix_ht, 0) desc`);
    const money_ok = can(req, 'money.view');
    const articles = r.recordset.map((a) => ({ id: a.id, code: (a.code_article || '').trim(), designation: (a.designation || '').trim(),
      stock: Number(a.stock_neuf), derniere_sortie: a.derniere_sortie ? new Date(a.derniere_sortie).toISOString().slice(0, 10) : null,
      ...(money_ok ? { valeur: money(a.stock_neuf * (a.prix_ht || 0)) } : {}) }));
    res.json({ jours: days, articles, ...(money_ok ? { total: money(articles.reduce((s, a) => s + a.valeur, 0)) } : {}) });
  } catch (err) {
    console.error('stock dormant error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// Stock value by family (money roles only).
router.get('/valorisation', async (req, res) => {
  if (!can(req, 'stock.valuation')) return res.status(403).json({ error: "Vous n'avez pas les droits pour cette action." });
  try {
    const pool = await getPool();
    const r = await pool.request().input('d', sql.Bit, false).query(`
      select f.designation as famille, count(*) as nb, sum(a.stock_neuf * isnull(a.prix_ht, 0)) as valeur
      from article a
      inner join tableau_article_sous_famille t on t.id_article = a.id
      inner join sous_famille sf on sf.id = t.id_sous_famille
      inner join famille f on f.id = sf.id_famille
      where a.deleted = @d and a.stock_neuf > 0
      group by f.designation order by valeur desc`);
    const familles = r.recordset.map((x) => ({ famille: (x.famille || '').trim(), articles: x.nb, valeur: money(x.valeur) }));
    res.json({ familles, total: money(familles.reduce((s, x) => s + x.valeur, 0)) });
  } catch (err) {
    console.error('stock valorisation error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// Movement history of one article (entries RCP/BRM, issues BSM) - last 100.
router.get('/mouvements/:id', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Article invalide.' });
  try {
    const pool = await getPool();
    const r = await pool.request().input('i', sql.Int, id).query(`
      select top 100 * from (
        select b.date_bsm as date, 'Sortie' as type, ba.quantite as qt from bsm_article ba inner join bsm b on ba.id_bsm = b.id where ba.id_article = @i and ba.quantite <> 0
        union all
        select bl.date_reel, 'Entrée', la.qt from livraison_article la inner join bon_livraison bl on la.id_livraison = bl.id where la.id_article = @i and la.qt <> 0
      ) m order by date desc`);
    res.json({ mouvements: r.recordset.map((m) => ({ date: m.date ? new Date(m.date).toISOString().slice(0, 10) : null, type: m.type, quantite: Number(m.qt) })) });
  } catch (err) {
    console.error('stock mouvements error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
