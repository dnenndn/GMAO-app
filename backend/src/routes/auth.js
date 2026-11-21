const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { sql } = require('../db');
const { effectivePerms } = require('../features');
const { loginBlocked, loginFailed, loginOk } = require('../security');

const router = express.Router();

const { getAppPool } = require('../appDb');
const { findByLogin, checkPassword, hash } = require('../appUsers');

// Login against the app's own users (GMAO_APP.app_user). A user created by the administrator has no
// password yet: the first time he connects (login typed, password left empty) the app asks him to
// choose one (POST /set-password), then he keeps using it.
function issue(res, user, remember, req, login) {
  const fonction = (user.fonction || '').trim();
  const login2 = (user.login || '').trim();
  const token = jwt.sign(
    { id: user.desktop_id, login: login2, fonction, rem: remember ? 1 : 0 },
    process.env.JWT_SECRET,
    { expiresIn: remember ? (process.env.JWT_REMEMBER_EXPIRES_IN || '90d') : (process.env.JWT_EXPIRES_IN || '12h') }
  );
  return { token, fonction, login2 };
}

async function finish(req, res, user, remember) {
  const { token, fonction, login2 } = issue(res, user, remember);
  getAppPool().then((app) => app.request().input('i', sql.Int, user.desktop_id).query('update app_user set last_login = getdate() where desktop_id = @i')).catch(() => {});
  let permissions = null;
  try { permissions = await effectivePerms({ id: user.desktop_id, login: login2, fonction }); } catch (e) { /* the app asks /permissions/me */ }
  res.json({ token, user: { id: user.desktop_id, login: login2, fonction }, permissions });
}

router.post('/login', async (req, res) => {
  const { login, password } = req.body || {};
  const remember = !!(req.body && req.body.remember);
  if (typeof login !== 'string' || !login.trim() || (password != null && typeof password !== 'string')) {
    return res.status(400).json({ error: 'Identifiant requis.' });
  }
  const wait = loginBlocked(req, login);
  if (wait) {
    res.set('Retry-After', String(wait));
    return res.status(429).json({ error: `Trop de tentatives. Réessayez dans ${Math.ceil(wait / 60)} min.` });
  }
  try {
    const user = await findByLogin(login);
    if (!user || !user.actif) {
      loginFailed(req, login);
      return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
    }
    if (!user.pwd_hash) {
      // first connection: no password defined yet
      if (!password) return res.json({ first_login: true, login: user.login.trim() });
      loginFailed(req, login);
      return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
    }
    if (!password || !(await bcrypt.compare(password, user.pwd_hash))) {
      loginFailed(req, login);
      return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
    }
    loginOk(req, login);
    await finish(req, res, user, remember);
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// First connection: the person chooses his password. Only works while no password is set (atomic
// update), so it can never be used to take over an account that already has one.
router.post('/set-password', async (req, res) => {
  const { login, password } = req.body || {};
  const remember = !!(req.body && req.body.remember);
  if (typeof login !== 'string' || !login.trim()) return res.status(400).json({ error: 'Identifiant requis.' });
  const bad = checkPassword(password);
  if (bad) return res.status(400).json({ error: bad });
  const wait = loginBlocked(req, login);
  if (wait) {
    res.set('Retry-After', String(wait));
    return res.status(429).json({ error: `Trop de tentatives. Réessayez dans ${Math.ceil(wait / 60)} min.` });
  }
  try {
    const user = await findByLogin(login);
    if (!user || !user.actif || user.pwd_hash) {
      loginFailed(req, login);
      return res.status(409).json({ error: 'Ce compte a déjà un mot de passe. Connectez-vous normalement, ou demandez à l\'administrateur de le réinitialiser.' });
    }
    const app = await getAppPool();
    const upd = await app.request().input('i', sql.Int, user.desktop_id).input('h', sql.NVarChar, await hash(password))
      .query('update app_user set pwd_hash = @h, pwd_set_at = getdate() where desktop_id = @i and pwd_hash is null');
    if (!upd.rowsAffected[0]) return res.status(409).json({ error: 'Ce compte a déjà un mot de passe.' });
    loginOk(req, login);
    await finish(req, res, user, remember);
  } catch (err) {
    console.error('set-password error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
