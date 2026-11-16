const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { iso } = require('../lib');

// Engine paperwork (assurance, vignette, visite technique) - READ ONLY.
// For each engine and each kind, the latest expiry date (desktop tables
// engins_assurance / engins_vignette / engins_visite_technique).
const router = express.Router();
router.use(requireAuth);

router.get('/papiers', async (req, res) => {
  const jours = Math.min(365, Math.max(1, Number.parseInt(req.query.jours, 10) || 30));
  try {
    const pool = await getPool();
    const r = await pool.request().input('d', sql.Int, 0).query(`
      select e.id, e.designation, e.matricule, x.kind, x.date_exp from engins e inner join (
        select id_engin, 'Assurance' as kind, max(date_exp) as date_exp from engins_assurance where deleted = @d group by id_engin
        union all select id_engin, 'Vignette', max(date_exp) from engins_vignette where deleted = @d group by id_engin
        union all select id_engin, 'Visite technique', max(date_exp) from engins_visite_technique where deleted = @d group by id_engin
      ) x on x.id_engin = e.id
      where e.deleted = @d order by x.date_exp, e.designation`);
    const today = iso(new Date());
    const limit = iso(new Date(Date.now() + jours * 86400000));
    const rows = r.recordset.map((x) => {
      const d = x.date_exp ? iso(new Date(x.date_exp)) : null;
      return { id_engin: x.id, engin: (x.designation || '').trim(), matricule: (x.matricule || '').trim(), type: x.kind, date_exp: d,
        etat: d == null ? 'inconnu' : d < today ? 'expire' : d <= limit ? 'bientot' : 'ok',
        jours: d == null ? null : Math.round((new Date(d) - new Date(today)) / 86400000) };
    });
    res.json({ jours, papiers: rows.filter((x) => x.etat === 'expire' || x.etat === 'bientot') });
  } catch (err) {
    console.error('parc papiers error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
