const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { iso, period, intParam } = require('../lib');
const { can, requireFeature } = require('../features');
const { loadPapiers, loadManquants } = require('../parcPapiers');

// Engine paperwork (assurance, vignette, visite technique) - READ ONLY.
// For each engine and each kind, the latest expiry date (desktop tables
// engins_assurance / engins_vignette / engins_visite_technique).
const router = express.Router();
router.use(requireAuth);

router.get('/papiers', async (req, res) => {
  const jours = Math.min(365, Math.max(1, Number.parseInt(req.query.jours, 10) || 30));
  try {
    const pool = await getPool();
    const rows = await loadPapiers(pool, jours);
    const manquants = req.query.manquants === '0' ? [] : await loadManquants(pool);
    res.json({ jours, papiers: rows.filter((x) => x.etat === 'expire' || x.etat === 'bientot'), manquants });
  } catch (err) {
    console.error('parc papiers error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// One engine at a glance: identity, papers, open DI / OT, preventive counters, parts issued (BSM).
// The desktop links an engine to its equipment through engins.liaison. Amounts only for money roles.
router.get('/engins/:id/fiche', requireFeature('parc.view'), async (req, res) => {
  const id = intParam(req.params.id);
  if (id == null) return res.status(400).json({ error: 'Engin invalide.' });
  const p = period(req, 30);
  if (p.error) return res.status(400).json({ error: p.error });
  try {
    const pool = await getPool();
    const e = await pool.request().input('i', sql.Int, id).input('d', sql.Int, 0).query(`
      select e.id, e.matricule, e.num_carte, e.designation, e.marque, e.liaison, v.designation as vehicule, c.nom as chauffeur, k.designation as categorie
      from engins e left join type_de_vehicule v on e.id_vehicule = v.id left join chauffeur c on e.id_chauffeur = c.id
      left join categorie_de_charge k on e.id_categorie = k.id where e.id = @i and e.deleted = @d`);
    if (e.recordset.length === 0) return res.status(404).json({ error: 'Engin introuvable.' });
    const g = e.recordset[0]; const lien = g.liaison == null ? null : Number(g.liaison);
    const q = (sqlText, bind = (r) => r) => bind(pool.request().input('l', sql.Int, lien).input('d', sql.Int, 0).input('d1', sql.Date, p.from).input('d2', sql.Date, p.to).input('i', sql.Int, id)).query(sqlText);
    const money_ok = can(req, 'money.view');
    const [paperAll, di, ot, cpt, pieces] = await Promise.all([
      loadPapiers(pool, 30),
      lien == null ? { recordset: [] } : q(`select statut, count(*) as nb from demande_intervention where equipement = @l and deleted = @d group by statut`),
      lien == null ? { recordset: [] } : q(`select statut, count(*) as nb from ordre_travail where equipement = @l and deleted = @d group by statut`),
      lien == null ? { recordset: [] } : q(`select ec.designation, ec.valeur, pc.valeur_lancement from prev_compteur pc inner join equipement_compteur ec on pc.id_compteur = ec.id
        where pc.equipement = @l and ec.deleted = @d order by ec.designation`),
      lien == null ? { recordset: [] } : q(`select count(*) as nb, sum(ba.quantite * ba.prix_ht) as montant from bsm_equipement be
        inner join bsm b on b.id = be.id_bsm inner join bsm_article ba on ba.id_bsm = b.id
        where be.id_equipement = @l and b.date_bsm between @d1 and @d2 and ba.quantite <> 0`)
    ]);
    const nb = (rs, f) => rs.filter(f).reduce((s, x) => s + x.nb, 0);
    const diOpen = nb(di.recordset, (x) => x.statut === 0 || x.statut === 1);
    const otOpen = nb(ot.recordset, (x) => (String(x.statut || '').trim() !== 'Clôturé'));
    const pr = pieces.recordset[0] || {};
    res.json({
      id_engin: id, matricule: (g.matricule || '').trim(), num_carte: (g.num_carte || '').toString().trim(), engin: (g.designation || '').trim(),
      marque: (g.marque || '').toString().trim(), vehicule: (g.vehicule || '').trim(), chauffeur: (g.chauffeur || '').trim(), categorie: (g.categorie || '').trim(),
      lie_equipement: lien != null, from: iso(p.from), to: iso(p.to),
      papiers: paperAll.filter((x) => x.id_engin === id).map((x) => ({ type: x.type, date_exp: x.date_exp, jours: x.jours, etat: x.etat, preavis: x.preavis })),
      di: { ouvertes: diOpen, total: nb(di.recordset, () => true) },
      ot: { ouverts: otOpen, total: nb(ot.recordset, () => true) },
      compteurs: cpt.recordset.map((c) => ({ nom: (c.designation || '').trim(), valeur: Number(c.valeur || 0), lancement: Number(c.valeur_lancement || 0),
        restant: Math.max(0, Number(c.valeur_lancement || 0) - Number(c.valeur || 0)) })),
      pieces: { lignes: Number(pr.nb || 0), ...(money_ok ? { montant: Math.round(Number(pr.montant || 0) * 1000) / 1000 } : {}) }
    });
  } catch (err) {
    console.error('parc fiche error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
