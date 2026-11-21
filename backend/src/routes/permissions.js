const express = require('express');
const { sql, getPool } = require('../db');
const { getAppPool } = require('../appDb');
const { requireAuth } = require('../middleware/auth');
const { FEATURES, KEYS, defaultAllowed, loadOverrides, invalidate, permsOf } = require('../features');

// Per-user feature permissions.
//   GET /me            the effective permissions of the logged in user (any user)
//   GET /users         users with their role (editors only)
//   GET /users/:id     every feature: role default, exception, effective right
//   PUT /users/:id     { overrides: { "<feature>": true | false | null } }  (null = back to the role default)
// Who may edit: Administrateur accounts, or only the logins listed in PERMISSION_ADMINS
// (comma separated, e.g. PERMISSION_ADMINS=marwen) when that variable is set.
const router = express.Router();
router.use(requireAuth);

function canEdit(user) {
  if ((user.fonction || '').trim() !== 'Administrateur') return false;
  const only = (process.env.PERMISSION_ADMINS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return only.length === 0 || only.includes(String(user.login || '').toLowerCase());
}
function requireEditor(req, res, next) {
  if (!canEdit(req.user)) return res.status(403).json({ error: "Vous n'avez pas les droits pour cette action." });
  next();
}

router.get('/me', (req, res) => {
  res.json({ permissions: permsOf(req), can_edit: canEdit(req.user) });
});

router.get('/users', requireEditor, async (_req, res) => {
  try {
    const app0 = await getAppPool();
    const r = await app0.request().query('select desktop_id as id, login, fonction from app_user where actif = 1 order by login');
    res.json(r.recordset.map((u) => ({ id: u.id, login: (u.login || '').trim(), fonction: (u.fonction || '').trim() })));
  } catch (err) {
    console.error('permissions users error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

async function loadUser(id) {
  const app0 = await getAppPool();
  const r = await app0.request().input('i', sql.Int, id).query('select desktop_id as id, login, fonction from app_user where desktop_id = @i and actif = 1');
  return r.recordset[0] ? { id: r.recordset[0].id, login: (r.recordset[0].login || '').trim(), fonction: (r.recordset[0].fonction || '').trim() } : null;
}

router.get('/users/:id', requireEditor, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Utilisateur invalide.' });
  try {
    const u = await loadUser(id);
    if (!u) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    invalidate(id);
    const over = await loadOverrides(id);
    res.json({
      user: u,
      features: FEATURES.map((f) => {
        const def = defaultAllowed(f, u.fonction);
        const ov = over.has(f.key) ? over.get(f.key) : null;
        return { key: f.key, group: f.group, label: f.label, default: def, override: ov, effective: ov == null ? def : ov };
      })
    });
  } catch (err) {
    console.error('permissions user error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.put('/users/:id', requireEditor, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Utilisateur invalide.' });
  const ov = (req.body || {}).overrides;
  if (!ov || typeof ov !== 'object' || Array.isArray(ov)) return res.status(400).json({ error: 'Modifications invalides.' });
  const entries = Object.entries(ov);
  if (entries.length === 0 || entries.length > 100) return res.status(400).json({ error: 'Modifications invalides.' });
  for (const [k, v] of entries) {
    if (!KEYS.has(k)) return res.status(400).json({ error: `Droit inconnu : ${k}` });
    if (v !== true && v !== false && v !== null) return res.status(400).json({ error: `Valeur invalide pour ${k}` });
  }
  // nobody can cut off their own access to user management (would lock the screen)
  if (id === req.user.id && ov['users.admin'] === false) return res.status(400).json({ error: 'Vous ne pouvez pas retirer votre propre accès à la gestion des utilisateurs.' });
  try {
    const u = await loadUser(id);
    if (!u) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    const app = await getAppPool();
    const tx = new sql.Transaction(app);
    await tx.begin();
    try {
      for (const [k, v] of entries) {
        const same = v === null || v === defaultAllowed(FEATURES.find((f) => f.key === k), u.fonction);
        const rq = () => new sql.Request(tx).input('u', sql.Int, id).input('k', sql.VarChar, k);
        // an exception equal to the role default is pointless: drop the row instead
        if (v === null || same) await rq().query('delete from app_user_permission where id_user = @u and feature = @k');
        else await rq().input('a', sql.Bit, v).input('by', sql.Int, req.user.id).query(`
          merge app_user_permission as t using (select @u as id_user, @k as feature) as s on t.id_user = s.id_user and t.feature = s.feature
          when matched then update set allowed = @a, updated_by = @by, updated_at = getdate()
          when not matched then insert (id_user, feature, allowed, updated_by) values (@u, @k, @a, @by);`);
      }
      await tx.commit();
    } catch (e) {
      try { await tx.rollback(); } catch (e2) { console.error('permissions rollback failed:', e2); }
      throw e;
    }
    invalidate(id);
    console.log(`[permissions] ${req.user.login} changed ${entries.length} right(s) of ${u.login}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('permissions save error:', err);
    res.status(500).json({ error: 'Erreur serveur (la table des droits est-elle créée ? voir sql/07_user_permissions.sql).' });
  }
});

module.exports = router;
