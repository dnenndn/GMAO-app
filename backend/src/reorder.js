const { sql } = require('./db');

// Quantity suggested to bring an article back up: to its maximum when one is
// set, otherwise to twice its minimum. Never less than 1.
function suggestQty(stock, mini, maxi) {
  const s = Number(stock) || 0, mn = Number(mini) || 0, mx = Number(maxi) || 0;
  const target = mx > s ? mx : mn * 2;
  return Math.max(1, Math.ceil(target - s));
}

// Articles (among `ids`) that already sit on a DA still being processed
// (en attente, confirmée, envoyée à l'administrateur, reportée) with something left to order.
async function openDaArticles(pool, ids) {
  if (!ids.length) return new Set();
  const rq = pool.request();
  ids.forEach((v, i) => rq.input(`o${i}`, sql.Int, v));
  const r = await rq.query(`
    select distinct da.id_article
    from da_article da inner join demande_achat d on da.id_da = d.id
    where d.statut in (0, 1, 3, 4) and da.qt_restant > 0 and da.id_article in (${ids.map((_, i) => `@o${i}`).join(',')})`);
  return new Set(r.recordset.map((x) => x.id_article));
}

module.exports = { suggestQty, openDaArticles };
