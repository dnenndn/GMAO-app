const { getAppPool } = require('./appDb');

// Per-engine fuel alert settings (table app_engin_seuil in GMAO_APP).
// If the table does not exist yet (SQL file not run) everything keeps the
// global defaults - nothing breaks.
async function loadFuelSettings() {
  try {
    const pool = await getAppPool();
    const r = await pool.request().query('select id_engin, ratio, actif from app_engin_seuil');
    return new Map(r.recordset.map((x) => [x.id_engin, { ratio: x.ratio == null ? null : Number(x.ratio), actif: x.actif !== false && x.actif !== 0 }]));
  } catch (e) {
    return new Map();
  }
}

module.exports = { loadFuelSettings };
