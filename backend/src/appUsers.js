const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { sql, getPool } = require('./db');
const { getAppPool } = require('./appDb');

// The app's own users (GMAO_APP.app_user). desktop_id = utilisateur.id in the desktop database,
// which is the id every other table already records (BSM, DI, DA...).
const MIN_PASSWORD = 6;

async function findByLogin(login) {
  const app = await getAppPool();
  const r = await app.request().input('l', sql.NVarChar, String(login).trim()).query(
    'select desktop_id, login, fonction, pwd_hash, actif from app_user where login = @l');
  return r.recordset[0] || null;
}

async function isActive(desktopId) {
  const app = await getAppPool();
  const r = await app.request().input('i', sql.Int, desktopId).query('select actif from app_user where desktop_id = @i');
  return !!(r.recordset[0] && r.recordset[0].actif);
}

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return `Le mot de passe doit avoir au moins ${MIN_PASSWORD} caractères.`;
  if (pw.length > 100) return 'Mot de passe trop long.';
  return null;
}

// Placeholder row in the desktop utilisateur table for somebody created in the app only, so that his
// id exists everywhere the desktop records users. Its password is random: nobody can use it to log in
// to the desktop application.
async function createDesktopShadow(login, fonction) {
  const pool = await getPool();
  const r = await pool.request()
    .input('login', sql.NVarChar, login).input('pw', sql.NVarChar, crypto.randomBytes(12).toString('hex'))
    .input('f', sql.NVarChar, fonction).input('d', sql.Bit, false)
    .query('insert into utilisateur (login, mot_passe, fonction, deleted) values (@login, @pw, @f, @d) select cast(scope_identity() as int) as id');
  return r.recordset[0].id;
}
async function deleteDesktopShadow(id) {
  try { const pool = await getPool(); await pool.request().input('i', sql.Int, id).query('delete from utilisateur where id = @i'); }
  catch (e) { console.error('could not remove placeholder utilisateur', id, e.message); }
}

async function hash(pw) { return bcrypt.hash(pw, 10); }

module.exports = { MIN_PASSWORD, findByLogin, isActive, checkPassword, createDesktopShadow, deleteDesktopShadow, hash };
