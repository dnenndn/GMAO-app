const express = require('express');
const { sql, getPool } = require('../db');
const { getAppPool } = require('../appDb');
const { requireAuth, forgetActive } = require('../middleware/auth');
const { requireFeature, isOwner } = require('../features');
const { createDesktopShadow, deleteDesktopShadow } = require('../appUsers');

// Administration of the app's own users (GMAO_APP.app_user).
//   GET  /users                 users of the app
//   GET  /desktop-users         people of the desktop database who are not in the app yet
//   POST /users/import          { ids: [utilisateur.id...] }  bring existing people (no password: they choose one)
//   POST /users                 { login, fonction }           create somebody new (no password)
//   PUT  /users/:id             { fonction?, active? }
//   POST /users/:id/reset-password   removes the password: the person chooses a new one at next connection
// Passwords are never readable by anybody (stored hashed).
const router = express.Router();
router.use(requireAuth, requireFeature('users.admin'));

const ROLES = ['Administrateur', 'Responsable Méthode', 'Responsable Magasin', 'Responsable Achat', 'Magasinier', 'Technicien', 'DGA'];
const fail = (res, err, what) => { console.error(`${what} error:`, err); res.status(500).json({ error: 'Erreur serveur.' }); };

router.get('/roles', (_req, res) => res.json(ROLES));

router.get('/users', async (_req, res) => {
  try {
    const app = await getAppPool();
    const r = await app.request().query('select desktop_id as id, login, fonction, actif, shadow, pwd_hash, last_login from app_user order by login');
    res.json(r.recordset.map((u) => ({
      id: u.id, login: (u.login || '').trim(), fonction: (u.fonction || '').trim(),
      deleted: !u.actif, has_password: !!u.pwd_hash, last_login: u.last_login
    })));
  } catch (err) { fail(res, err, 'list users'); }
});

router.get('/desktop-users', async (_req, res) => {
  try {
    const app = await getAppPool();
    const have = new Set((await app.request().query('select desktop_id from app_user')).recordset.map((x) => x.desktop_id));
    const pool = await getPool();
    const r = await pool.request().input('d', sql.Bit, false).query('select id, login, fonction from utilisateur where deleted = @d order by login');
    res.json(r.recordset.filter((u) => !have.has(u.id)).map((u) => ({ id: u.id, login: (u.login || '').trim(), fonction: (u.fonction || '').trim() })));
  } catch (err) { fail(res, err, 'desktop users'); }
});

router.post('/users/import', async (req, res) => {
  const ids = [...new Set(((req.body || {}).ids || []).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length || ids.length > 500) return res.status(400).json({ error: 'Choisissez au moins un utilisateur.' });
  try {
    const pool = await getPool();
    const rq = pool.request().input('d', sql.Bit, false);
    ids.forEach((id, i) => rq.input(`i${i}`, sql.Int, id));
    const found = (await rq.query(`select id, login, fonction from utilisateur where deleted = @d and id in (${ids.map((_, i) => `@i${i}`).join(',')})`)).recordset;
    const app = await getAppPool();
    let added = 0; const skipped = [];
    for (const u of found) {
      const login = (u.login || '').trim(); const fonction = (u.fonction || '').trim();
      if (!login || !fonction) { skipped.push(login || `#${u.id}`); continue; }
      try {
        await app.request().input('i', sql.Int, u.id).input('l', sql.NVarChar, login).input('f', sql.NVarChar, fonction).input('by', sql.Int, req.user.id)
          .query('insert into app_user (desktop_id, login, fonction, created_by) values (@i, @l, @f, @by)');
        added++;
      } catch (e) { skipped.push(login); }   // already there, or the same login exists
    }
    res.status(201).json({ added, skipped });
  } catch (err) { fail(res, err, 'import users'); }
});

router.post('/users', async (req, res) => {
  const login = String((req.body || {}).login || '').trim();
  const fonction = String((req.body || {}).fonction || '').trim();
  if (!login || login.length > 50 || /\s/.test(login)) return res.status(400).json({ error: "Identifiant requis (sans espace, 50 caractères max)." });
  if (!ROLES.includes(fonction)) return res.status(400).json({ error: 'Rôle invalide.' });
  let shadowId = null;
  try {
    const app = await getAppPool();
    const dup = await app.request().input('l', sql.NVarChar, login).query('select 1 as x from app_user where login = @l');
    const pool = await getPool();
    const dup2 = await pool.request().input('l', sql.NVarChar, login).query('select 1 as x from utilisateur where login = @l');
    if (dup.recordset.length || dup2.recordset.length) return res.status(409).json({ error: 'Cet identifiant existe déjà (utilisez « Importer » pour une personne déjà présente dans le logiciel).' });
    shadowId = await createDesktopShadow(login, fonction);
    await app.request().input('i', sql.Int, shadowId).input('l', sql.NVarChar, login).input('f', sql.NVarChar, fonction).input('by', sql.Int, req.user.id)
      .query('insert into app_user (desktop_id, login, fonction, shadow, created_by) values (@i, @l, @f, 1, @by)');
    res.status(201).json({ id: shadowId });
  } catch (err) {
    if (shadowId) await deleteDesktopShadow(shadowId);
    fail(res, err, 'create user');
  }
});

router.put('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { fonction, active } = req.body || {};
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Utilisateur invalide.' });
  if (fonction !== undefined && !ROLES.includes(fonction)) return res.status(400).json({ error: 'Rôle invalide.' });
  if (id === req.user.id && active === false) return res.status(400).json({ error: 'Vous ne pouvez pas désactiver votre propre compte.' });
  if (id === req.user.id && fonction !== undefined && fonction !== req.user.fonction) return res.status(400).json({ error: 'Vous ne pouvez pas changer votre propre rôle.' });
  try {
    const app = await getAppPool();
    const cur = (await app.request().input('i', sql.Int, id).query('select login, fonction, shadow from app_user where desktop_id = @i')).recordset[0];
    if (!cur) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    if (isOwner(cur)) return res.status(400).json({ error: 'Le compte propriétaire ne peut pas être modifié ici.' });
    await app.request().input('i', sql.Int, id).input('f', sql.NVarChar, fonction === undefined ? null : fonction)
      .input('a', sql.Bit, active === undefined ? null : !!active)
      .query('update app_user set fonction = coalesce(@f, fonction), actif = coalesce(@a, actif) where desktop_id = @i');
    if (cur.shadow && fonction !== undefined) {
      const pool = await getPool();
      await pool.request().input('i', sql.Int, id).input('f', sql.NVarChar, fonction).query('update utilisateur set fonction = @f where id = @i');
    }
    forgetActive(id);
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'update user'); }
});

router.post('/users/:id/reset-password', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Utilisateur invalide.' });
  try {
    const app = await getAppPool();
    const t = (await app.request().input('i', sql.Int, id).query('select login, fonction, shadow from app_user where desktop_id = @i')).recordset[0];
    if (t && isOwner(t)) return res.status(400).json({ error: 'Le compte propriétaire ne peut pas être réinitialisé ici.' });
    const r = await app.request().input('i', sql.Int, id).query('update app_user set pwd_hash = null, pwd_set_at = null where desktop_id = @i');
    if (!r.rowsAffected[0]) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'reset password'); }
});

module.exports = router;
