const jwt = require('jsonwebtoken');
const { effectivePerms, defaultPerms } = require('../features');
const { isActive } = require('../appUsers');

// Sliding session: once a token is past half of its life it is replaced by a fresh one (sent in the
// X-New-Token header, the app stores it), so somebody who uses the app regularly is never logged out.
// "Remember me" tokens live JWT_REMEMBER_EXPIRES_IN (default 90 days), others JWT_EXPIRES_IN (12 h).
// A person deactivated by the administrator loses access within a few minutes (checked below).
const ACTIVE_TTL = 5 * 60000;
const activeCache = new Map();   // user id -> { ok, at }
async function userStillActive(id) {
  const hit = activeCache.get(id);
  if (hit && Date.now() - hit.at < ACTIVE_TTL) return hit.ok;
  try {
    const ok = await isActive(id);
    activeCache.set(id, { ok, at: Date.now() });
    return ok;
  } catch (e) { return true; }     // database hiccup: do not lock everybody out
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing token. Log in again.' });
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Session expired or invalid. Log in again.' });
  }
  if (!(await userStillActive(req.user.id))) {
    return res.status(401).json({ error: 'Session expired or invalid. Log in again.' });
  }
  const now = Math.floor(Date.now() / 1000);
  if (req.user.exp && req.user.iat && req.user.exp - now < (req.user.exp - req.user.iat) / 2) {
    const { id, login, fonction, rem } = req.user;
    const life = rem ? (process.env.JWT_REMEMBER_EXPIRES_IN || '90d') : (process.env.JWT_EXPIRES_IN || '12h');
    try { res.set('X-New-Token', jwt.sign({ id, login, fonction, rem }, process.env.JWT_SECRET, { expiresIn: life })); } catch (e) { /* keep the current token */ }
  }
  // Effective feature rights (role default + per-user exceptions set by an administrator).
  try { req.perms = await effectivePerms(req.user); } catch (e) { req.perms = defaultPerms(req.user.fonction); }
  next();
}

function forgetActive(id) { activeCache.delete(id); }

module.exports = { requireAuth, forgetActive };
