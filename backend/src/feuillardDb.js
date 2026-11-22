const sql = require('mssql');

// Connection to the strapping ("feuillard") database used by the desktop application "Gestion de Feuillard".
// By default it uses the same SQL Server and the same login as the GMAO connection (the login must have access
// to that database). Set FEUILLARD_DB_* in .env to use another server, database name or login.
// The structure of that database is never changed by the app (no table, no column added).
const config = {
  server: process.env.FEUILLARD_DB_SERVER || process.env.DB_SERVER,
  database: process.env.FEUILLARD_DB_NAME || 'feuillard',
  user: process.env.FEUILLARD_DB_USER || process.env.DB_USER,
  password: process.env.FEUILLARD_DB_PASSWORD || process.env.DB_PASSWORD,
  port: Number(process.env.FEUILLARD_DB_PORT || process.env.DB_PORT || 1433),
  options: {
    encrypt: process.env.DB_ENCRYPT !== 'false',
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERT !== 'false'
  },
  pool: { max: 5, min: 0, idleTimeoutMillis: 30000 }
};

let poolPromise;
function getFeuillardPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(config).connect()
      .then((pool) => { console.log('Connected to strapping database:', config.server, '/', config.database); return pool; })
      .catch((err) => { poolPromise = null; throw err; });
  }
  return poolPromise;
}

module.exports = { sql, getFeuillardPool };
