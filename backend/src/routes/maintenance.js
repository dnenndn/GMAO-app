const express = require('express');
const { sql, getPool } = require('../db');
const { getAppPool } = require('../appDb');
const { requireAuth } = require('../middleware/auth');
const { MAINTENANCE_ROLES } = require('../roles');
const { loadCompteurs } = require('../preventifCompteur');
const { loginsByIds } = require('../userLookup');
const { can, requireFeature } = require('../features');
const { notifyRoles } = require('../push');
const { parseDate, iso, period, likeEscape, intParam, todayUtc } = require('../lib');

// Maintenance: breakdown requests (DI), work orders (OT), agenda.
//
// DI mirrors the desktop (Demande_Intervention.cs): same table, same columns,
// same status codes 0 En attente / 1 Validée / 5 Annulée / 10 Clôturée, same
// numbering "AAAA-M-n". Improvements over the desktop: the number is taken
// inside a transaction (two people cannot get the same one), the equipment path
// is checked (each level must be a child of the previous one), and an urgent DI
// notifies the maintenance managers. OT are READ ONLY here (starting, planning
// and closing an OT stay on the desktop: they move stock, costs and counters).
// Nothing is added to GMAO_NGES; photos live in GMAO_APP (sql/05_di_photos.sql).
const router = express.Router();
router.use(requireAuth);

const URGENCES = ['Elevée', 'Moyenne', 'Faible'];
const DI_STATUS = { 0: 'En attente', 1: 'Validée', 5: 'Annulée', 10: 'Clôturée' };
const DI_FILTER = { attente: 0, validee: 1, annulee: 5, cloturee: 10 };
const OT_TYPES = ['Corrective Curative', 'Corrective Palliative', 'Travaux Neufs',
  'Préventive Systématique', 'Préventive Syst Compteur', 'Préventive Conditionnelle'];
const MAX_PHOTOS = 5;
const MAX_PHOTO_BYTES = 1500000;

class MaintError extends Error {}

function requireWrite(req, res, next) {
  return requireFeature('di.create')(req, res, next);
}

const deletedInt = (rq) => rq.input('del', sql.Int, 0);

// "Atelier > Équipement > Sous-équipement > Organe" names for a set of rows.
async function pathNames(pool, rows) {
  const ids = [...new Set(rows.flatMap((r) => [r.atelier, r.equipement, r.sous_equipement, r.organe]).filter((x) => x))];
  if (ids.length === 0) return () => '';
  const rq = pool.request();
  ids.forEach((id, i) => rq.input(`e${i}`, sql.Int, id));
  const r = await rq.query(`select id, designation from equipement where id in (${ids.map((_, i) => `@e${i}`).join(',')})`);
  const names = new Map(r.recordset.map((x) => [x.id, (x.designation || '').trim()]));
  return (row) => [row.atelier, row.equipement, row.sous_equipement, row.organe]
    .filter((x) => x).map((x) => names.get(x) || '?').join(' › ');
}

const timeText = (v) => (v == null ? null : String(v).slice(0, 5));
const dateText = (v) => (v instanceof Date ? iso(v) : v ? String(v).slice(0, 10) : null);

function diRow(r, path) {
  return {
    id: r.id, n_di: (r.n_di || '').trim(), statut: r.statut, statut_label: DI_STATUS[r.statut] || String(r.statut),
    urgence: (r.urgence || '').trim(), date: dateText(r.date_emission), heure: timeText(r.heure_emission),
    demandeur: (r.demandeur || '').trim(), createur: (r.createur_login || '').trim(), id_createur: r.createur,
    anomalie: (r.anomalie || '').trim(), description: (r.description_defaillance || '').trim(),
    equipement: (r.eq_name || '').trim(), chemin: path(r),
    arret_machine: (r.arret_machine || '').trim() === 'Oui',
    date_arret: dateText(r.date_arret), heure_arret: timeText(r.heure_arret)
  };
}

const DI_SELECT = `
  select di.id, di.n_di, di.statut, di.urgence, di.date_emission, di.heure_emission, di.description_defaillance,
         di.arret_machine, di.date_arret, di.heure_arret, di.atelier, di.equipement, di.sous_equipement, di.organe,
         di.createur, i.nom as demandeur, u.login as createur_login, pa.anomalie, eq.designation as eq_name
  from demande_intervention di
  inner join intervenant i on di.id_demandeur = i.id
  left join utilisateur u on di.createur = u.id
  inner join parametre_anomalie pa on di.id_defaillance = pa.id
  inner join equipement eq on di.equipement = eq.id`;

// ---- reference data ---------------------------------------------------
router.get('/options', async (_req, res) => {
  try {
    const pool = await getPool();
    const [dem, ano] = await Promise.all([
      deletedInt(pool.request()).query('select id, nom from intervenant where deleted = @del order by nom'),
      deletedInt(pool.request()).query('select id, code, anomalie from parametre_anomalie where deleted = @del order by code')
    ]);
    res.json({
      urgences: URGENCES, ot_types: OT_TYPES,
      demandeurs: dem.recordset.map((x) => ({ id: x.id, nom: (x.nom || '').trim() })),
      anomalies: ano.recordset.map((x) => ({ id: x.id, code: (x.code || '').trim(), anomalie: (x.anomalie || '').trim() }))
    });
  } catch (err) {
    console.error('maintenance options error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// Children of one node of the equipment tree (parent 0 = the ateliers).
router.get('/equipements', async (req, res) => {
  const parent = intParam(req.query.parent ?? 0);
  if (parent == null) return res.status(400).json({ error: 'Parent invalide.' });
  try {
    const pool = await getPool();
    const r = await deletedInt(pool.request()).input('p', sql.Int, parent)
      .query('select id, code, designation from equipement where id_parent = @p and deleted = @del order by ordre, designation');
    res.json(r.recordset.map((x) => ({ id: x.id, code: (x.code || '').trim(), designation: (x.designation || '').trim() })));
  } catch (err) {
    console.error('maintenance equipements error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ---- DI -------------------------------------------------------------------
router.get('/di', async (req, res) => {
  const p = period(req, 60);
  if (p.error) return res.status(400).json({ error: p.error });
  const statut = req.query.statut && req.query.statut !== 'all' ? DI_FILTER[req.query.statut] : null;
  if (req.query.statut && req.query.statut !== 'all' && statut == null) return res.status(400).json({ error: 'Statut invalide.' });
  try {
    const pool = await getPool();
    const rq = deletedInt(pool.request()).input('d1', sql.Date, p.from).input('d2', sql.Date, p.to);
    let where = 'where di.deleted = @del and di.date_emission between @d1 and @d2';
    if (statut != null) { rq.input('s', sql.Int, statut); where += ' and di.statut = @s'; }
    if (req.query.mine === '1') { rq.input('me', sql.Int, req.user.id); where += ' and di.createur = @me'; }
    const q = String(req.query.search || '').trim().slice(0, 60);
    if (q) {
      rq.input('q', sql.NVarChar, `%${likeEscape(q)}%`);
      where += " and (di.n_di like @q escape '\\' or eq.designation like @q escape '\\' or di.description_defaillance like @q escape '\\')";
    }
    const r = await rq.query(`select top 200 * from (${DI_SELECT} ${where}) t order by date_emission desc, id desc`);
    const path = await pathNames(pool, r.recordset);
    res.json({ from: iso(p.from), to: iso(p.to), di: r.recordset.map((x) => diRow(x, path)) });
  } catch (err) {
    console.error('maintenance di list error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.get('/di/:id', async (req, res) => {
  const id = intParam(req.params.id);
  if (id == null) return res.status(400).json({ error: 'DI invalide.' });
  try {
    const pool = await getPool();
    const r = await deletedInt(pool.request()).input('id', sql.Int, id)
      .query(`${DI_SELECT} where di.id = @id and di.deleted = @del`);
    if (r.recordset.length === 0) return res.status(404).json({ error: 'Demande introuvable.' });
    const path = await pathNames(pool, r.recordset);
    const row = r.recordset[0];
    const ot = await deletedInt(pool.request()).input('id', sql.Int, id)
      .query('select id, n_ot, statut, type from ordre_travail where id_di = @id and deleted = @del');
    let photos = [];
    try {
      const app = await getAppPool();
      const ph = await app.request().input('id', sql.Int, id).query('select id from app_di_photo where id_di = @id order by id');
      photos = ph.recordset.map((x) => x.id);
    } catch (e) { /* photo table not created yet */ }
    const mine = row.createur === req.user.id;
    res.json({
      ...diRow(row, path),
      ot: ot.recordset.map((o) => ({ id: o.id, n_ot: (o.n_ot || '').trim(), statut: (o.statut || '').trim(), type: (o.type || '').trim() })),
      photos,
      can_cancel: row.statut === 0 && (mine || can(req, 'di.manage')),
      can_reopen: row.statut === 5 && (mine || can(req, 'di.manage'))
    });
  } catch (err) {
    console.error('maintenance di get error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// Checks that atelier > equipement > sous > organe really is one branch of the tree.
async function checkChain(tx, ids) {
  const chain = [ids.atelier, ids.equipement, ids.sous_equipement, ids.organe];
  if (!chain[0] || !chain[1]) throw new MaintError("Choisissez l'atelier et l'équipement.");
  if (chain[3] && !chain[2]) throw new MaintError("Choisissez le sous-équipement avant l'organe.");
  let parent = 0;
  for (const id of chain) {
    if (!id) break;
    const r = await tx.request().input('i', sql.Int, id).input('del', sql.Int, 0)
      .query('select id_parent from equipement where id = @i and deleted = @del');
    if (r.recordset.length === 0) throw new MaintError('Équipement introuvable.');
    if (parent !== 0 && Number(r.recordset[0].id_parent) !== parent) throw new MaintError("Chemin d'équipement incohérent.");
    parent = id;
  }
}

router.post('/di', requireWrite, async (req, res) => {
  const b = req.body || {};
  const idDemandeur = intParam(b.id_demandeur), idDef = intParam(b.id_defaillance);
  const urgence = String(b.urgence || '');
  const description = String(b.description || '').trim();
  if (!idDemandeur) return res.status(400).json({ error: 'Choisissez le demandeur.' });
  if (!URGENCES.includes(urgence)) return res.status(400).json({ error: "Choisissez l'urgence." });
  if (!idDef) return res.status(400).json({ error: "Choisissez l'anomalie." });
  if (description.length > 500) return res.status(400).json({ error: 'Description trop longue (500 caractères maximum).' });
  const ids = { atelier: intParam(b.atelier), equipement: intParam(b.equipement), sous_equipement: intParam(b.sous_equipement), organe: intParam(b.organe) };
  const now = new Date();
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const arret = b.arret_machine === true || b.arret_machine === 'Oui';
  let dArret = today, hArret = hhmm(now);
  if (arret && (b.date_arret || b.heure_arret)) {
    dArret = parseDate(b.date_arret);
    if (!dArret || dArret > today) return res.status(400).json({ error: "Date d'arrêt invalide." });
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.heure_arret || ''))) return res.status(400).json({ error: "Heure d'arrêt invalide." });
    hArret = b.heure_arret;
  }

  try {
    const pool = await getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    let out;
    try {
      const dem = await tx.request().input('i', sql.Int, idDemandeur).input('del', sql.Int, 0)
        .query('select 1 as x from intervenant where id = @i and deleted = @del');
      if (dem.recordset.length === 0) throw new MaintError('Demandeur introuvable.');
      const ano = await tx.request().input('i', sql.Int, idDef).input('del', sql.Int, 0)
        .query('select 1 as x from parametre_anomalie where id = @i and deleted = @del');
      if (ano.recordset.length === 0) throw new MaintError('Anomalie introuvable.');
      await checkChain(tx, ids);

      const y = today.getUTCFullYear(), m = today.getUTCMonth() + 1;
      const cnt = await tx.request().input('y', sql.Int, y).input('m', sql.Int, m)
        .query('select count(*) as n from demande_intervention with (updlock, holdlock) where year(date_emission) = @y and month(date_emission) = @m');
      const nDi = `${y}-${m}-${cnt.recordset[0].n + 1}`;
      const ins = await tx.request()
        .input('i1', sql.Int, idDemandeur).input('i2', sql.Date, today).input('i3', sql.VarChar, hhmm(now))
        .input('i4', sql.VarChar, urgence).input('i5', sql.Int, idDef).input('i6', sql.VarChar, description)
        .input('i7', sql.Int, req.user.id).input('i8', sql.Int, ids.atelier).input('i9', sql.Int, ids.equipement)
        .input('i10', sql.Int, ids.sous_equipement || 0).input('i11', sql.Int, ids.organe || 0)
        .input('i12', sql.VarChar, arret ? 'Oui' : 'Non').input('i13', sql.Date, dArret).input('i14', sql.VarChar, hArret)
        .input('i15', sql.Int, 0).input('i16', sql.VarChar, nDi).input('i17', sql.Int, 0)
        .query(`insert into demande_intervention (id_demandeur, date_emission, heure_emission, urgence, id_defaillance, description_defaillance, createur, atelier, equipement, sous_equipement, organe, arret_machine, date_arret, heure_arret, statut, n_di, deleted)
                values (@i1, @i2, @i3, @i4, @i5, @i6, @i7, @i8, @i9, @i10, @i11, @i12, @i13, @i14, @i15, @i16, @i17)
                select cast(scope_identity() as int) as id`);
      out = { id: ins.recordset[0].id, n_di: nDi };
      await tx.commit();
    } catch (err) {
      try { await tx.rollback(); } catch (e) { console.error('maintenance rollback failed:', e); }
      throw err;
    }
    res.json({ ok: true, ...out });
    if (urgence === 'Elevée' || arret) {
      notifyRoles(MAINTENANCE_ROLES, {
        type: 'di_urgent', idRef: out.id, title: arret ? 'Machine à l\'arrêt' : 'DI urgente',
        body: `DI ${out.n_di} (${urgence}${arret ? ', machine arrêtée' : ''}) créée par ${req.user.login || 'un utilisateur'}`
      }).catch((e) => console.error('notify DI failed:', e));
    }
  } catch (err) {
    if (err instanceof MaintError) return res.status(400).json({ error: err.message });
    console.error('maintenance di create error:', err);
    res.status(500).json({ error: 'Erreur serveur lors de la création.' });
  }
});

// Cancel (0 -> 5) / put back on hold (5 -> 0): same two moves the desktop allows.
async function setStatus(req, res, from, to) {
  const id = intParam(req.params.id);
  if (id == null) return res.status(400).json({ error: 'DI invalide.' });
  try {
    const pool = await getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const r = await tx.request().input('id', sql.Int, id).input('del', sql.Int, 0)
        .query('select statut, createur from demande_intervention with (updlock, rowlock) where id = @id and deleted = @del');
      if (r.recordset.length === 0) throw new MaintError('Demande introuvable.');
      const row = r.recordset[0];
      const allowed = row.createur === req.user.id || can(req, 'di.manage');
      if (!allowed) throw new MaintError("Vous n'avez pas les droits pour cette action.");
      if (row.statut !== from) throw new MaintError(`Impossible : la demande est « ${DI_STATUS[row.statut] || row.statut} ».`);
      await tx.request().input('s', sql.Int, to).input('id', sql.Int, id).query('update demande_intervention set statut = @s where id = @id');
      await tx.commit();
    } catch (err) {
      try { await tx.rollback(); } catch (e) { console.error('maintenance rollback failed:', e); }
      throw err;
    }
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof MaintError) return res.status(400).json({ error: err.message });
    console.error('maintenance di status error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
}
router.put('/di/:id/annuler', requireWrite, (req, res) => setStatus(req, res, 0, 5));
router.put('/di/:id/reactiver', requireWrite, (req, res) => setStatus(req, res, 5, 0));

// ---- DI photos (raw JPEG body, kept in GMAO_APP) -----------------------------
router.post('/di/:id/photos', requireWrite, express.raw({ type: 'image/jpeg', limit: '2mb' }), async (req, res) => {
  const id = intParam(req.params.id);
  const buf = req.body;
  if (id == null) return res.status(400).json({ error: 'DI invalide.' });
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return res.status(400).json({ error: 'Photo invalide (JPEG attendu).' });
  if (buf.length > MAX_PHOTO_BYTES) return res.status(400).json({ error: 'Photo trop lourde.' });
  try {
    const pool = await getPool();
    const di = await deletedInt(pool.request()).input('id', sql.Int, id)
      .query('select createur from demande_intervention where id = @id and deleted = @del');
    if (di.recordset.length === 0) return res.status(404).json({ error: 'Demande introuvable.' });
    const allowed = di.recordset[0].createur === req.user.id || can(req, 'di.manage');
    if (!allowed) return res.status(403).json({ error: "Vous n'avez pas les droits pour cette action." });
    const app = await getAppPool();
    const n = await app.request().input('id', sql.Int, id).query('select count(*) as n from app_di_photo where id_di = @id');
    if (n.recordset[0].n >= MAX_PHOTOS) return res.status(400).json({ error: `${MAX_PHOTOS} photos maximum par demande.` });
    const ins = await app.request().input('id', sql.Int, id).input('u', sql.Int, req.user.id).input('d', sql.VarBinary(sql.MAX), buf)
      .query('insert into app_di_photo (id_di, id_user, data) values (@id, @u, @d) select cast(scope_identity() as int) as id');
    res.json({ ok: true, id: ins.recordset[0].id });
  } catch (err) {
    console.error('maintenance photo upload error:', err);
    res.status(500).json({ error: 'Erreur serveur (la table des photos est-elle créée ? voir sql/05_di_photos.sql).' });
  }
});

router.get('/di-photo/:pid', async (req, res) => {
  const pid = intParam(req.params.pid);
  if (pid == null) return res.status(400).json({ error: 'Photo invalide.' });
  try {
    const app = await getAppPool();
    const r = await app.request().input('p', sql.Int, pid).query('select data from app_di_photo where id = @p');
    if (r.recordset.length === 0) return res.status(404).json({ error: 'Photo introuvable.' });
    res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'private, max-age=86400').send(r.recordset[0].data);
  } catch (err) {
    console.error('maintenance photo get error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ---- OT (read only) -----------------------------------------------------------
const otRow = (o, path) => ({
  id: o.id, n_ot: (o.n_ot || '').trim(), statut: (o.statut || '').trim(), type: (o.type || '').trim(),
  urgence: (o.urgence || '').trim(), date_debut: dateText(o.date_debut), heure_debut: timeText(o.heure_debut),
  date_fin: dateText(o.date_fin), heure_fin: timeText(o.heure_fin),
  debut_prevu: dateText(o.debut_prevu), fin_prevu: dateText(o.fin_prevu),
  commentaire: (o.commentaire || '').trim(), id_di: o.id_di || null,
  equipement: (o.eq_name || '').trim(), chemin: path(o)
});

router.get('/ot', async (req, res) => {
  const p = period(req, 30);
  if (p.error) return res.status(400).json({ error: p.error });
  try {
    const pool = await getPool();
    const rq = deletedInt(pool.request()).input('d1', sql.Date, p.from).input('d2', sql.Date, p.to);
    let where = 'where o.deleted = @del and o.date_debut between @d1 and @d2';
    const st = String(req.query.statut || '');
    if (st === 'ouverts') where += " and o.statut <> N'Clôturé'";
    else if (st === 'clotures') where += " and o.statut = N'Clôturé'";
    else if (st && st !== 'all') { rq.input('st', sql.NVarChar, st.slice(0, 40)); where += ' and o.statut = @st'; }
    if (req.query.type && OT_TYPES.includes(req.query.type)) { rq.input('ty', sql.NVarChar, req.query.type); where += ' and o.type = @ty'; }
    if (req.query.urgence && URGENCES.includes(req.query.urgence)) { rq.input('ur', sql.NVarChar, req.query.urgence); where += ' and o.urgence = @ur'; }
    const q = String(req.query.search || '').trim().slice(0, 60);
    if (q) {
      rq.input('q', sql.NVarChar, `%${likeEscape(q)}%`);
      where += " and (o.n_ot like @q escape '\\' or eq.designation like @q escape '\\' or o.commentaire like @q escape '\\')";
    }
    const r = await rq.query(`
      select top 200 o.id, o.n_ot, o.statut, o.type, o.urgence, o.date_debut, o.heure_debut, o.date_fin, o.heure_fin,
             o.debut_prevu, o.fin_prevu, o.commentaire, o.id_di, o.atelier, o.equipement, o.sous_equipement, o.organe,
             eq.designation as eq_name
      from ordre_travail o left join equipement eq on o.equipement = eq.id
      ${where} order by o.date_debut desc, o.id desc`);
    const path = await pathNames(pool, r.recordset);
    res.json({ from: iso(p.from), to: iso(p.to), ot: r.recordset.map((o) => otRow(o, path)) });
  } catch (err) {
    console.error('maintenance ot list error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.get('/ot/:id', async (req, res) => {
  const id = intParam(req.params.id);
  if (id == null) return res.status(400).json({ error: 'OT invalide.' });
  try {
    const pool = await getPool();
    const r = await deletedInt(pool.request()).input('id', sql.Int, id).query(`
      select o.id, o.n_ot, o.statut, o.type, o.urgence, o.date_debut, o.heure_debut, o.date_fin, o.heure_fin,
             o.debut_prevu, o.fin_prevu, o.commentaire, o.id_di, o.atelier, o.equipement, o.sous_equipement, o.organe,
             eq.designation as eq_name, di.n_di
      from ordre_travail o left join equipement eq on o.equipement = eq.id
      left join demande_intervention di on o.id_di = di.id
      where o.id = @id and o.deleted = @del`);
    if (r.recordset.length === 0) return res.status(404).json({ error: 'OT introuvable.' });
    const path = await pathNames(pool, r.recordset);
    const o = r.recordset[0];
    const [staff, parts] = await Promise.all([
      pool.request().input('id', sql.Int, id).query(`
        select i.nom, oi.debut, oi.fin, oi.cout_horaire
        from ot_ordo_intervenant oi
        inner join ot_ressources_fonction rf on oi.id_ressource_fonction = rf.id
        left join intervenant i on oi.id_intervenant = i.id
        where rf.id_ot = @id order by oi.debut`),
      pool.request().input('id', sql.Int, id).query(`
        select b.date_bsm, a.code_article, a.designation, ba.quantite, ba.prix_ht
        from bsm b inner join bsm_article ba on ba.id_bsm = b.id inner join article a on ba.id_article = a.id
        where b.li_ot = @id order by b.date_bsm, a.designation`)
    ]);
    let notes = [];
    try {
      const app = await getAppPool();
      const nr = await app.request().input('id', sql.Int, id).query('select top 50 n.id, n.id_user, n.kind, n.texte, n.created_at from app_ot_note n where n.id_ot = @id order by n.id desc');
      const lg = await loginsByIds(nr.recordset.map((x) => x.id_user));
      notes = nr.recordset.map((x) => ({ id: x.id, kind: x.kind, texte: x.texte, auteur: lg[x.id_user] || '', date: new Date(x.created_at).toISOString() }));
    } catch (e) { /* notes table not created yet */ }
    const showMoney = can(req, 'money.view');
    const hours = (a, b) => (a && b ? Math.max(0, (new Date(b) - new Date(a)) / 3600000) : 0);
    const intervenants = staff.recordset.map((s) => {
      const h = hours(s.debut, s.fin);
      return { nom: (s.nom || '').trim(), debut: s.debut ? new Date(s.debut).toISOString() : null, fin: s.fin ? new Date(s.fin).toISOString() : null,
        heures: Math.round(h * 100) / 100, ...(showMoney ? { cout: Math.round(h * Number(s.cout_horaire || 0) * 1000) / 1000 } : {}) };
    });
    const pieces = parts.recordset.map((x) => ({
      date: dateText(x.date_bsm), code: (x.code_article || '').trim(), designation: (x.designation || '').trim(), quantite: Number(x.quantite),
      ...(showMoney ? { cout: Math.round(Number(x.quantite) * Number(x.prix_ht || 0) * 1000) / 1000 } : {})
    }));
    res.json({
      ...otRow(o, path), n_di: (o.n_di || '').trim(), intervenants, pieces, notes, can_update: can(req, 'ot.update') && (o.statut || '').trim() !== 'Clôturé',
      ...(showMoney ? {
        cout_main_oeuvre: Math.round(intervenants.reduce((s, x) => s + x.cout, 0) * 1000) / 1000,
        cout_pieces: Math.round(pieces.reduce((s, x) => s + x.cout, 0) * 1000) / 1000
      } : {})
    });
  } catch (err) {
    console.error('maintenance ot get error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// A note on a work order, or a request to close it. The desktop closes an OT
// itself (it also resets the equipment counters), so the phone only records the
// note in GMAO_APP and tells the maintenance managers.
router.post('/ot/:id/note', requireFeature('ot.update'), async (req, res) => {
  const id = intParam(req.params.id);
  if (id == null) return res.status(400).json({ error: 'OT invalide.' });
  const kind = req.body && req.body.cloture === true ? 'cloture' : 'note';
  const texte = String((req.body && req.body.texte) || '').trim();
  if (!texte) return res.status(400).json({ error: kind === 'cloture' ? 'Expliquez brièvement ce qui a été fait.' : 'Écrivez une note.' });
  if (texte.length > 500) return res.status(400).json({ error: 'Note trop longue (500 caractères maximum).' });
  try {
    const pool = await getPool();
    const o = await deletedInt(pool.request()).input('id', sql.Int, id).query('select n_ot, statut from ordre_travail where id = @id and deleted = @del');
    if (o.recordset.length === 0) return res.status(404).json({ error: 'OT introuvable.' });
    if ((o.recordset[0].statut || '').trim() === 'Clôturé') return res.status(409).json({ error: 'Cet OT est déjà clôturé.' });
    const app = await getAppPool();
    await app.request().input('id', sql.Int, id).input('u', sql.Int, req.user.id).input('k', sql.VarChar, kind).input('t', sql.NVarChar, texte)
      .query('insert into app_ot_note (id_ot, id_user, kind, texte) values (@id, @u, @k, @t)');
    res.json({ ok: true });
    if (kind === 'cloture') {
      notifyRoles(MAINTENANCE_ROLES, { type: 'ot_close_request', idRef: id, title: 'Clôture d\'OT demandée',
        body: `${req.user.login || 'Un technicien'} demande la clôture de l'OT ${(o.recordset[0].n_ot || '').trim()} : ${texte.slice(0, 120)}` })
        .catch((e) => console.error('notify OT close request failed:', e));
    }
  } catch (err) {
    console.error('maintenance ot note error:', err);
    res.status(500).json({ error: 'Erreur serveur (la table des notes est-elle créée ? voir sql/08_ot_notes.sql).' });
  }
});

// Preventive plans driven by counters (hours / km), closest to their threshold first.
// ?scope=engins -> only equipment that is a vehicle of the Parc (engins.liaison); ?scope=autres -> all the other equipment.
router.get('/compteurs', async (req, res) => {
  try {
    const pool = await getPool();
    const scope = req.query.scope;
    const rows = (await loadCompteurs(pool)).filter((x) => scope === 'engins' ? x.id_engin != null : scope === 'autres' ? x.id_engin == null : true).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || a.restant - b.restant);
    res.json({ compteurs: rows.slice(0, 300), depasses: rows.filter((x) => x.etat === 'depasse').length, proches: rows.filter((x) => x.etat === 'proche').length });
  } catch (err) {
    console.error('maintenance compteurs error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ---- Agenda: planned OT + preventive schedule ------------------------------------
router.get('/agenda', async (req, res) => {
  const from = req.query.from ? parseDate(req.query.from) : todayUtc();
  const to = req.query.to ? parseDate(req.query.to) : from && new Date(from.getTime() + 14 * 86400000);
  if (!from || !to) return res.status(400).json({ error: 'Dates invalides (format AAAA-MM-JJ).' });
  if (from > to || (to - from) / 86400000 > 120) return res.status(400).json({ error: 'Période invalide (120 jours maximum).' });
  const p = { from };
  try {
    const pool = await getPool();
    const base = () => deletedInt(pool.request()).input('d1', sql.Date, p.from).input('d2', sql.Date, to);
    const [ot, prev] = await Promise.all([
      base().query(`
        select top 200 o.id, o.n_ot, o.statut, o.type, o.urgence, o.debut_prevu, o.fin_prevu, o.commentaire, eq.designation as eq_name
        from ordre_travail o left join equipement eq on o.equipement = eq.id
        where o.deleted = @del and o.statut <> N'Clôturé' and o.debut_prevu between @d1 and @d2
        order by o.debut_prevu, o.id`),
      base().query(`
        select top 300 pe.date_ech, g.designation as gamme, e.designation as equipement
        from prev_syst_ech pe
        inner join prev_systematique ps on pe.id_rep = ps.id
        inner join equipement e on ps.equipement = e.id
        inner join gamme_operatoire g on ps.id_gamme = g.id
        where e.deleted = @del and pe.deleted = @del and pe.date_ech between @d1 and @d2
        order by pe.date_ech, e.designation`)
    ]);
    res.json({
      from: iso(from), to: iso(to),
      ot_planifies: ot.recordset.map((o) => ({ id: o.id, n_ot: (o.n_ot || '').trim(), statut: (o.statut || '').trim(), type: (o.type || '').trim(),
        urgence: (o.urgence || '').trim(), debut_prevu: dateText(o.debut_prevu), fin_prevu: dateText(o.fin_prevu), equipement: (o.eq_name || '').trim() })),
      preventif: prev.recordset.map((x) => ({ date: dateText(x.date_ech), gamme: (x.gamme || '').trim(), equipement: (x.equipement || '').trim() }))
    });
  } catch (err) {
    console.error('maintenance agenda error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
