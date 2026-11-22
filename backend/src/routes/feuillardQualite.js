const express = require('express');
const { sql, getFeuillardPool } = require('../feuillardDb');
const { getAppPool } = require('../appDb');
const { requireAuth } = require('../middleware/auth');
const { requireFeature } = require('../features');
const { idempotent } = require('../idempotency');
const V = require('../feuillardInput');
const S = require('../feuillardStats');
const { qualityReport } = require('../feuillardPdf');

// Incoming quality control of the strapping coils (tables entre_magasin / qualite / qual_general / photo_qualite).
// Unlike the desktop (which deletes and re-inserts the whole sheet on each save) every coil, the final decision and
// every photo are added / edited / removed on their own, so a phone never wipes what somebody else entered.
//   GET  /entrees?from&to&article           receipts with their quality status
//   GET  /:id                               one receipt: tolerances, measured coils, decision, photo ids
//   POST /:id/ligne     PUT /ligne/:rid     DELETE /ligne/:rid
//   PUT  /:id/decision
//   POST /:id/photos (raw JPEG)   GET /photo/:pid   DELETE /photo/:pid
//   GET  /:id/pdf
const router = express.Router();
router.use(requireAuth, requireFeature('feuillard.qualite'));

const trim = (v) => (v == null ? v : String(v).trim());
const fail = (res, err, what) => {
  if (err && err.status) return res.status(err.status).json({ error: err.message });
  console.error(`feuillard qualite ${what} error:`, err);
  res.status(500).json({ error: 'Erreur serveur (base feuillard inaccessible ?).' });
};
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PHOTOS = 10;
const notFound = () => Object.assign(new Error('Entrée introuvable.'), { status: 404 });

// who measures: same rule as the movements (explicit link, else same name in the strapping application)
async function strappingUserId(user) {
  try {
    const app = await getAppPool();
    const l = await app.request().input('u', sql.Int, user.id).query('select id_feuillard_user from app_feuillard_user where desktop_id = @u');
    if (l.recordset[0]) return l.recordset[0].id_feuillard_user;
  } catch (e) { /* table missing: by name */ }
  const pool = await getFeuillardPool();
  const r = await pool.request().input('n', sql.VarChar, String(user.login || '')).query('select id from utilisateur where nom = @n');
  if (r.recordset.length === 1) return r.recordset[0].id;
  throw Object.assign(new Error("Votre compte n'est pas relié à un utilisateur du logiciel feuillard. Demandez à l'administrateur de le relier (Utilisateurs)."), { status: 409 });
}
async function log(req, kind, refId, summary) {
  try {
    const app = await getAppPool();
    await app.request().input('k', sql.VarChar, kind).input('r', sql.Int, refId).input('u', sql.Int, req.user.id).input('l', sql.NVarChar, req.user.login).input('s', sql.NVarChar, summary.slice(0, 300))
      .query('insert into app_feuillard_log (kind, ref_id, id_user, login, summary) values (@k, @r, @u, @l, @s)');
  } catch (e) { console.error('feuillard log skipped:', e.message); }
}
const pid = (v) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error('Identifiant invalide.'), { status: 400 }); return n; };

async function loadEntree(pool, id) {
  const r = await pool.request().input('i', sql.Int, id).query(
    `select e.id, e.date_entre as date, e.qt, e.id_article, a.designation as article, f.nom as fournisseur,
            a.min_poids, a.max_poids, a.min_epaisseur, a.max_epaisseur, a.min_largeur, a.max_largeur
     from entre_magasin e inner join article_feuillard a on e.id_article = a.id left join fournisseur f on e.id_fournisseur = f.id where e.id = @i`);
  if (!r.recordset[0]) throw notFound();
  return r.recordset[0];
}
const tolOf = (e) => ({ min_poids: e.min_poids, max_poids: e.max_poids, min_epaisseur: e.min_epaisseur, max_epaisseur: e.max_epaisseur, min_largeur: e.min_largeur, max_largeur: e.max_largeur });
async function loadRows(pool, id, tol) {
  const r = await pool.request().input('i', sql.Int, id).query(
    `select q.id, q.date_q as date, u.nom as controleur, q.epaisseur, q.largeur, q.poids, q.fissure, q.couleur, q.observation
     from qualite q left join utilisateur u on q.id_magasinier = u.id where q.id_entre = @i order by q.id`);
  return r.recordset.map((x) => Object.assign({ id: x.id, date: x.date, controleur: trim(x.controleur) || '', epaisseur: x.epaisseur, largeur: x.largeur, poids: x.poids, fissure: trim(x.fissure), couleur: trim(x.couleur), observation: trim(x.observation) || '' }, S.judgeCoil(x, tol)));
}

router.get('/entrees', async (req, res) => {
  try {
    const to = ISO.test(req.query.to || '') ? req.query.to : new Date().toISOString().slice(0, 10);
    const from = ISO.test(req.query.from || '') ? req.query.from : new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
    const art = typeof req.query.article === 'string' ? req.query.article.trim().slice(0, 100) : '';
    const pool = await getFeuillardPool();
    const r = await pool.request().input('d1', sql.Date, from).input('d2', sql.Date, to).input('a', sql.VarChar, art).query(
      `select e.id, e.date_entre as date, a.designation as article, f.nom as fournisseur, e.qt,
              (select count(*) from qualite q where q.id_entre = e.id) as nb,
              (select count(*) from qualite q where q.id_entre = e.id and (q.poids < a.min_poids or q.poids > a.max_poids or q.epaisseur < a.min_epaisseur or q.epaisseur > a.max_epaisseur
                    or q.largeur < a.min_largeur or q.largeur > a.max_largeur or q.fissure = 'Oui' or q.couleur = 'Mauvais')) as nb_nc,
              (select count(*) from qual_general g where g.id_entre = e.id) as decision
       from entre_magasin e inner join article_feuillard a on e.id_article = a.id left join fournisseur f on e.id_fournisseur = f.id
       where e.date_entre between @d1 and @d2 and (a.designation = @a or @a = '')
       order by e.date_entre desc, e.id desc`);
    res.json({ from, to, rows: r.recordset.map((x) => ({ id: x.id, date: x.date, article: trim(x.article), fournisseur: trim(x.fournisseur) || '', qt: x.qt, nb: x.nb, nb_nc: x.nb_nc, decision: x.decision > 0 })) });
  } catch (err) { fail(res, err, 'entrees'); }
});

router.get('/photo/:pid', async (req, res) => {
  try {
    const pool = await getFeuillardPool();
    const r = await pool.request().input('p', sql.Int, pid(req.params.pid)).query('select taswira from photo_qualite where id = @p');
    if (!r.recordset[0] || !r.recordset[0].taswira) return res.status(404).json({ error: 'Photo introuvable.' });
    const b = r.recordset[0].taswira;
    res.set('Content-Type', b[0] === 0x89 ? 'image/png' : 'image/jpeg').set('Cache-Control', 'private, max-age=3600').send(b);
  } catch (err) { fail(res, err, 'photo'); }
});

router.delete('/photo/:pid', async (req, res) => {
  try {
    const pool = await getFeuillardPool();
    const r = await pool.request().input('p', sql.Int, pid(req.params.pid)).query('delete from photo_qualite where id = @p');
    if (!r.rowsAffected[0]) return res.status(404).json({ error: 'Photo introuvable.' });
    await log(req, 'qualite_photo_del', Number(req.params.pid), 'Photo qualité supprimée');
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'photo delete'); }
});

router.put('/ligne/:rid', async (req, res) => {
  try {
    const rid = pid(req.params.rid); const d = V.coil(req.body || {});
    const pool = await getFeuillardPool();
    const r = await pool.request().input('r', sql.Int, rid).input('d', sql.Date, d.date).input('e', sql.Real, d.epaisseur).input('l', sql.Real, d.largeur).input('f', sql.VarChar, d.fissure).input('c', sql.VarChar, d.couleur).input('o', sql.VarChar, d.observation).input('p', sql.Real, d.poids)
      .query('update qualite set date_q = @d, epaisseur = @e, largeur = @l, fissure = @f, couleur = @c, observation = @o, poids = @p where id = @r');
    if (!r.rowsAffected[0]) return res.status(404).json({ error: 'Mesure introuvable.' });
    await log(req, 'qualite_ligne_edit', rid, 'Mesure de bobine modifiée');
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'ligne edit'); }
});

router.delete('/ligne/:rid', async (req, res) => {
  try {
    const rid = pid(req.params.rid);
    const pool = await getFeuillardPool();
    const r = await pool.request().input('r', sql.Int, rid).query('delete from qualite where id = @r');
    if (!r.rowsAffected[0]) return res.status(404).json({ error: 'Mesure introuvable.' });
    await log(req, 'qualite_ligne_del', rid, 'Mesure de bobine supprimée');
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'ligne delete'); }
});

router.get('/:id', async (req, res) => {
  try {
    const id = pid(req.params.id);
    const pool = await getFeuillardPool();
    const e = await loadEntree(pool, id); const tol = tolOf(e);
    const rows = await loadRows(pool, id, tol);
    const g = (await pool.request().input('i', sql.Int, id).query('select observation from qual_general where id_entre = @i')).recordset[0];
    const ph = (await pool.request().input('i', sql.Int, id).query('select id from photo_qualite where id_entre = @i order by id')).recordset;
    res.json({ entree: { id: e.id, date: e.date, qt: e.qt, id_article: e.id_article, article: trim(e.article), fournisseur: trim(e.fournisseur) || '' }, tol, rows, decision: g ? trim(g.observation) || '' : null, photos: ph.map((x) => x.id) });
  } catch (err) { fail(res, err, 'detail'); }
});

router.post('/:id/ligne', idempotent, async (req, res) => {
  try {
    const id = pid(req.params.id); const d = V.coil(req.body || {});
    const uid = await strappingUserId(req.user);
    const pool = await getFeuillardPool();
    await loadEntree(pool, id);
    const r = await pool.request().input('e', sql.Int, id).input('d', sql.Date, d.date).input('u', sql.Int, uid).input('ep', sql.Real, d.epaisseur).input('l', sql.Real, d.largeur).input('f', sql.VarChar, d.fissure).input('c', sql.VarChar, d.couleur).input('o', sql.VarChar, d.observation).input('p', sql.Real, d.poids)
      .query('insert into qualite (id_entre, date_q, id_magasinier, epaisseur, largeur, fissure, couleur, observation, poids) values (@e, @d, @u, @ep, @l, @f, @c, @o, @p) select cast(scope_identity() as int) as id');
    await log(req, 'qualite_ligne', r.recordset[0].id, `Mesure de bobine (entrée ${id})`);
    res.status(201).json({ ok: true, id: r.recordset[0].id });
  } catch (err) { fail(res, err, 'ligne'); }
});

router.put('/:id/decision', idempotent, async (req, res) => {
  try {
    const id = pid(req.params.id); const t = V.decision(req.body || {});
    const pool = await getFeuillardPool();
    await loadEntree(pool, id);
    const ex = await pool.request().input('i', sql.Int, id).query('select id from qual_general where id_entre = @i');
    if (ex.recordset.length) await pool.request().input('i', sql.Int, id).input('o', sql.VarChar, t).query('update qual_general set observation = @o where id_entre = @i');
    else await pool.request().input('i', sql.Int, id).input('o', sql.VarChar, t).query('insert into qual_general (id_entre, observation) values (@i, @o)');
    await log(req, 'qualite_decision', id, 'Décision de contrôle qualité');
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'decision'); }
});

router.post('/:id/photos', express.raw({ type: 'image/jpeg', limit: '2mb' }), async (req, res) => {
  try {
    const id = pid(req.params.id);
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) return res.status(400).json({ error: 'Photo JPEG requise (2 Mo maximum).' });
    const pool = await getFeuillardPool();
    await loadEntree(pool, id);
    const n = (await pool.request().input('i', sql.Int, id).query('select count(*) as n from photo_qualite where id_entre = @i')).recordset[0].n;
    if (n >= MAX_PHOTOS) return res.status(400).json({ error: `${MAX_PHOTOS} photos maximum par entrée.` });
    const r = await pool.request().input('i', sql.Int, id).input('d', sql.VarBinary(sql.MAX), buf).query('insert into photo_qualite (id_entre, taswira) values (@i, @d) select cast(scope_identity() as int) as id');
    await log(req, 'qualite_photo', r.recordset[0].id, `Photo qualité (entrée ${id})`);
    res.status(201).json({ ok: true, id: r.recordset[0].id });
  } catch (err) { fail(res, err, 'photo upload'); }
});

router.get('/:id/pdf', async (req, res) => {
  try {
    const id = pid(req.params.id);
    const pool = await getFeuillardPool();
    const e = await loadEntree(pool, id); const tol = tolOf(e);
    const rows = await loadRows(pool, id, tol);
    const g = (await pool.request().input('i', sql.Int, id).query('select observation from qual_general where id_entre = @i')).recordset[0];
    const ph = (await pool.request().input('i', sql.Int, id).query('select taswira from photo_qualite where id_entre = @i order by id')).recordset;
    const photos = ph.map((x) => x.taswira).filter(Buffer.isBuffer);
    const pdf = qualityReport({ entree: { id: e.id, date: e.date, article: trim(e.article), fournisseur: trim(e.fournisseur) || '', qt: e.qt }, tol, rows, decision: g ? trim(g.observation) : '', photos: photos.slice(0, 10), skipped: 0, now: new Date().toISOString() });
    res.set('Content-Type', 'application/pdf').set('Content-Disposition', `inline; filename="controle-qualite-${id}.pdf"`).send(pdf);
  } catch (err) { fail(res, err, 'pdf'); }
});

module.exports = router;
