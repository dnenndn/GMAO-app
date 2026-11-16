const { sql, getAppPool } = require('./appDb');

// Replay protection for requests queued by the phone while it was offline.
// The phone sends body.client_ref (random id). The first request with a given
// ref goes through; a second one with the same ref is answered "duplicate"
// without running again. If the first one failed (status >= 400) the ref is
// released so the person can try again. Fails open: if the table does not
// exist yet, requests behave exactly as before.
const REF = /^[A-Za-z0-9-]{8,64}$/;
let lastPurge = 0;

async function idempotent(req, res, next) {
  const ref = req.body && req.body.client_ref;
  if (ref == null) return next();
  if (typeof ref !== 'string' || !REF.test(ref)) return res.status(400).json({ error: 'Référence invalide.' });
  let pool;
  try {
    pool = await getAppPool();
    await pool.request().input('r', sql.VarChar, ref).input('u', sql.Int, req.user ? req.user.id : null)
      .query('insert into app_client_ref (ref, id_user) values (@r, @u)');
  } catch (err) {
    if (err && (err.number === 2627 || err.number === 2601)) return res.json({ ok: true, duplicate: true });
    console.error('idempotency check skipped (is sql/09_client_ref.sql applied?):', err.message);
    return next();
  }
  res.on('finish', () => {
    if (res.statusCode >= 400) pool.request().input('r', sql.VarChar, ref).query('delete from app_client_ref where ref = @r').catch(() => {});
  });
  if (Date.now() - lastPurge > 3600000) {
    lastPurge = Date.now();
    pool.request().query('delete from app_client_ref where created_at < dateadd(day, -30, getdate())').catch(() => {});
  }
  next();
}

module.exports = { idempotent };
