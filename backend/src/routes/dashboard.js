const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { can } = require('../features');

// One-call mobile dashboard: counters only (each one wrapped so a single
// failing query does not blank the whole screen).
const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const one = async (q) => { try { const r = await pool.request().input('d', sql.Int, 0).input('b', sql.Bit, false).query(q); return Number(Object.values(r.recordset[0])[0] || 0); } catch (e) { console.error('dashboard:', e.message); return null; } };
    const [di_attente, ot_ouverts, ot_retard, sous_min, da_attente, bsm_jour] = await Promise.all([
      one('select count(*) from demande_intervention where deleted = @d and statut = 0'),
      one("select count(*) from ordre_travail where deleted = @d and statut <> N'Clôturé'"),
      one("select count(*) from ordre_travail where deleted = @d and statut <> N'Clôturé' and fin_prevu < cast(getdate() as date)"),
      one('select count(*) from article where deleted = @b and stock_mini > 0 and stock_neuf <= stock_mini'),
      one('select count(*) from demande_achat where statut = 0'),
      one('select count(*) from bsm where cast(date_bsm as date) = cast(getdate() as date)')
    ]);
    const out = { di_attente, ot_ouverts, ot_retard, sous_minimum: sous_min, da_attente, bsm_jour };
    if (can(req, 'money.view')) {
      out.valeur_stock = await one('select sum(stock_neuf * isnull(prix_ht, 0)) from article where deleted = @b and stock_neuf > 0');
    }
    res.json(out);
  } catch (err) {
    console.error('dashboard error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
