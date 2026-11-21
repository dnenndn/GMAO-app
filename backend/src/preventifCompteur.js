const { sql } = require('./db');

// Preventive maintenance driven by counters (hours / km), same rule as the desktop
// (lancement_ot_preventive.creation_ot_compteur): an active plan (prev_compteur.arr = 0) fires when
//   type_valeur "Sup": counter value >= valeur_lancement     type_valeur "Inf": counter value <= valeur_lancement
// remaining = how much is left before it fires (negative = already past, the desktop should have
// created the OT). pct = progress towards the threshold for "Sup" plans.
async function loadCompteurs(pool, { liaison = null } = {}) {
  const rq = pool.request().input('d', sql.Int, 0).input('a', sql.Int, 0);
  let where = 'pc.arr = @a and ec.deleted = @d and eq.deleted = @d';
  if (liaison != null) { rq.input('l', sql.Int, liaison); where += ' and pc.equipement = @l'; }
  const r = await rq.query(`
    select pc.id, pc.valeur_lancement, pc.type_valeur, ec.designation as compteur, ec.valeur,
           eq.id as id_equipement, eq.designation as equipement, g.designation as gamme, en.id as id_engin, en.matricule
    from prev_compteur pc
    inner join equipement_compteur ec on pc.id_compteur = ec.id
    inner join equipement eq on pc.equipement = eq.id
    left join gamme_operatoire g on pc.id_gamme = g.id
    left join engins en on en.liaison = pc.equipement and en.deleted = @d
    where ${where}`);
  return r.recordset.map((x) => {
    const valeur = Number(x.valeur || 0), seuil = Number(x.valeur_lancement || 0);
    const inf = String(x.type_valeur || '').trim() === 'Inf';
    const restant = inf ? valeur - seuil : seuil - valeur;
    const pct = !inf && seuil > 0 ? Math.round(valeur / seuil * 100) : null;
    const etat = restant <= 0 ? 'depasse' : (!inf && pct >= 90) || (inf && seuil > 0 && restant / Math.max(valeur, 1) <= 0.1) ? 'proche' : 'ok';
    return { id: x.id, compteur: (x.compteur || '').trim(), valeur, seuil, sens: inf ? 'Inf' : 'Sup', restant: Math.round(restant * 100) / 100, pct, etat,
      gamme: (x.gamme || '').trim(), equipement: (x.equipement || '').trim(), id_engin: x.id_engin || null, matricule: (x.matricule || '').toString().trim() };
  });
}

module.exports = { loadCompteurs };
