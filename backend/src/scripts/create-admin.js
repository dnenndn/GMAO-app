// Creates (or resets) an administrator of the app.   Usage, from the backend folder:
//   node src/scripts/create-admin.js <login> <password>
// - if the login exists in the desktop utilisateur table the account is linked to it,
//   otherwise a placeholder row (random password, unusable on the desktop) is created;
// - the app account gets the role Administrateur and the given password (stored hashed).
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { sql, getPool } = require('../db');
const { getAppPool } = require('../appDb');
const { checkPassword, createDesktopShadow, hash } = require('../appUsers');

(async () => {
  const [login, password] = process.argv.slice(2);
  if (!login || !password) { console.error('Usage: node src/scripts/create-admin.js <login> <password>'); process.exit(1); }
  const bad = checkPassword(password);
  if (bad) { console.error(bad); process.exit(1); }
  const pool = await getPool(); const app = await getAppPool();
  const mine = (await app.request().input('l', sql.NVarChar, login).query('select desktop_id from app_user where login = @l')).recordset[0];
  const h = await hash(password);
  if (mine) {
    await app.request().input('i', sql.Int, mine.desktop_id).input('h', sql.NVarChar, h)
      .query("update app_user set pwd_hash = @h, pwd_set_at = getdate(), fonction = 'Administrateur', actif = 1 where desktop_id = @i");
    console.log(`Compte "${login}" mis à jour (Administrateur, nouveau mot de passe).`);
  } else {
    const d = (await pool.request().input('l', sql.NVarChar, login).input('x', sql.Bit, false).query('select id from utilisateur where login = @l and deleted = @x')).recordset[0];
    const id = d ? d.id : await createDesktopShadow(login, 'Administrateur');
    await app.request().input('i', sql.Int, id).input('l', sql.NVarChar, login).input('h', sql.NVarChar, h).input('s', sql.Bit, !d)
      .query("insert into app_user (desktop_id, login, fonction, pwd_hash, shadow, pwd_set_at) values (@i, @l, 'Administrateur', @h, @s, getdate())");
    console.log(`Compte "${login}" créé (Administrateur)${d ? ', lié à l\'utilisateur existant du logiciel' : ''}.`);
  }
  process.exit(0);
})().catch((e) => { console.error('Erreur :', e.message); process.exit(1); });
