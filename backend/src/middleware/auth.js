const jwt = require('jsonwebtoken');
const { effectivePerms, defaultPerms } = require('../features');

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
  // Effective feature rights (role default + per-user exceptions set by an administrator).
  try { req.perms = await effectivePerms(req.user); } catch (e) { req.perms = defaultPerms(req.user.fonction); }
  next();
}

module.exports = { requireAuth };
