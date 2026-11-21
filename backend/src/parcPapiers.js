const { sql } = require('./db');
const { iso } = require('./lib');

// Engine paperwork status, same rules as the desktop (page_loginn.cs): every paper has its own
// "notify N days before expiry" (not_avant). Latest paper per engine and kind; the technical
// inspection is kept per type_visite so an expired type cannot hide behind a valid one.
const KINDS = ['Assurance', 'Vignette', 'Visite technique'];

async function loadPapiers(pool, defaultDays = 30) {
  const r = await pool.request().input('d', sql.Int, 0).query(`
    select e.id, e.designation, e.matricule, x.kind, x.sous_type, x.date_exp, x.not_avant from engins e inner join (
      select id_engin, 'Assurance' as kind, cast('' as varchar(60)) as sous_type, date_exp, not_avant,
             row_number() over (partition by id_engin order by date_exp desc, id desc) as rn from engins_assurance where deleted = @d
      union all select id_engin, 'Vignette', cast('' as varchar(60)), date_exp, not_avant,
             row_number() over (partition by id_engin order by date_exp desc, id desc) from engins_vignette where deleted = @d
      union all select id_engin, 'Visite technique', isnull(cast(type_visite as varchar(60)), ''), date_exp, not_avant,
             row_number() over (partition by id_engin, type_visite order by date_exp desc, id desc) from engins_visite_technique where deleted = @d
    ) x on x.id_engin = e.id
    where e.deleted = @d and x.rn = 1 order by x.date_exp, e.designation`);
  const today = iso(new Date());
  const rows = r.recordset.map((x) => {
    const d = x.date_exp ? iso(new Date(x.date_exp)) : null;
    const win = x.not_avant != null && Number(x.not_avant) >= 0 ? Number(x.not_avant) : defaultDays;
    const jours = d == null ? null : Math.round((new Date(d) - new Date(today)) / 86400000);
    return { id_engin: x.id, engin: (x.designation || '').trim(), matricule: (x.matricule || '').trim(), kind: x.kind,
      type: x.sous_type ? `${x.kind} (${String(x.sous_type).trim()})` : x.kind, date_exp: d, preavis: win, jours,
      etat: d == null ? 'inconnu' : jours < 0 ? 'expire' : jours <= win ? 'bientot' : 'ok' };
  });
  return rows;
}

// Engines with no paper of a kind at all (never entered in the desktop).
async function loadManquants(pool) {
  const r = await pool.request().input('d', sql.Int, 0).query(`
    select e.id, e.designation, e.matricule,
      case when exists (select 1 from engins_assurance x where x.id_engin = e.id and x.deleted = @d) then 0 else 1 end as no_ass,
      case when exists (select 1 from engins_vignette x where x.id_engin = e.id and x.deleted = @d) then 0 else 1 end as no_vig,
      case when exists (select 1 from engins_visite_technique x where x.id_engin = e.id and x.deleted = @d) then 0 else 1 end as no_vt
    from engins e where e.deleted = @d order by e.designation`);
  return r.recordset.map((x) => ({ id_engin: x.id, engin: (x.designation || '').trim(), matricule: (x.matricule || '').trim(),
    manquants: [x.no_ass ? 'Assurance' : null, x.no_vig ? 'Vignette' : null, x.no_vt ? 'Visite technique' : null].filter(Boolean) }))
    .filter((x) => x.manquants.length);
}

module.exports = { loadPapiers, loadManquants, KINDS };
