// Small, dependency-free hardening helpers.

// ---- client address ----------------------------------------------------------
// The backend sits behind a Cloudflare tunnel (cloudflared connects from this
// same PC), so every request looks local. The real client is in
// CF-Connecting-IP - trusted ONLY when the TCP peer is loopback, so nobody
// can forge it by talking to the LAN port directly.
function clientIp(req) {
  const peer = (req.socket && req.socket.remoteAddress) || '';
  const local = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const cf = req.headers['cf-connecting-ip'];
  return local && cf ? String(cf).split(',')[0].trim() : peer;
}

// ---- rate limiting -------------------------------------------------------------
// Fixed window counters in memory (one backend process, so this is enough).
function makeLimiter({ windowMs, max }) {
  const hits = new Map();
  const timer = setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); }, 60000);
  timer.unref();
  return {
    // returns seconds to wait when blocked, else 0
    hit(key) {
      const now = Date.now();
      let v = hits.get(key);
      if (!v || v.reset <= now) { v = { n: 0, reset: now + windowMs }; hits.set(key, v); }
      v.n++;
      return v.n > max ? Math.ceil((v.reset - now) / 1000) : 0;
    },
    reset(key) { hits.delete(key); },
    peek(key) { const v = hits.get(key); return v && v.reset > Date.now() && v.n >= max ? Math.ceil((v.reset - Date.now()) / 1000) : 0; }
  };
}

// General protection: many requests per minute per client.
function apiLimiter({ max = Number(process.env.RATE_LIMIT_PER_MIN || 600) } = {}) {
  const lim = makeLimiter({ windowMs: 60000, max });
  return (req, res, next) => {
    const wait = lim.hit(clientIp(req));
    if (wait) { res.set('Retry-After', String(wait)); return res.status(429).json({ error: 'Trop de requêtes. Réessayez dans un instant.' }); }
    next();
  };
}

// Login: failed attempts only. Counted per client+login AND per client, so a
// wrong password cannot be guessed and one address cannot try many logins.
const failsByLogin = makeLimiter({ windowMs: 15 * 60000, max: Number(process.env.LOGIN_MAX_FAILS || 5) });
const failsByIp = makeLimiter({ windowMs: 15 * 60000, max: Number(process.env.LOGIN_MAX_FAILS_PER_IP || 30) });
const loginKey = (req, login) => `${clientIp(req)}|${String(login || '').toLowerCase().slice(0, 64)}`;

function loginBlocked(req, login) {
  return Math.max(failsByLogin.peek(loginKey(req, login)), failsByIp.peek(clientIp(req)));
}
function loginFailed(req, login) { failsByLogin.hit(loginKey(req, login)); failsByIp.hit(clientIp(req)); }
function loginOk(req, login) { failsByLogin.reset(loginKey(req, login)); }

// ---- headers ---------------------------------------------------------------------
function securityHeaders(_req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cache-Control', 'no-store');
  next();
}

// ---- CORS -----------------------------------------------------------------------------
// The Android app runs from http://localhost (Capacitor androidScheme http).
// CORS_ORIGIN can hold a comma separated list, or * to allow everything.
const DEFAULT_ORIGINS = ['http://localhost', 'https://localhost', 'capacitor://localhost', 'ionic://localhost'];
function corsOptions() {
  const raw = (process.env.CORS_ORIGIN || '').trim();
  if (raw === '*') return { origin: '*' };
  const allowed = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_ORIGINS;
  return {
    // No Origin header = not a browser (curl, health checks): allowed, JWT still required.
    origin: (origin, cb) => cb(null, !origin || allowed.includes(origin))
  };
}

function checkSecrets() {
  const s = process.env.JWT_SECRET || '';
  if (s.length < 24) console.warn('[security] JWT_SECRET is missing or short (< 24 characters): set a long random value in .env.');
}

module.exports = { clientIp, makeLimiter, apiLimiter, loginBlocked, loginFailed, loginOk, securityHeaders, corsOptions, checkSecrets };
