const express = require('express');
const { sql, getFeuillardPool } = require('../feuillardDb');
const { getAppPool } = require('../appDb');
const { requireAuth } = require('../middleware/auth');
const { requireFeature, requireAny, can } = require('../features');
const { idempotent } = require('../idempotency');
const V = require('../feuillardInput');

// Strapping module: entering movements and production from the phone. Every movement and its stock update are saved
// in ONE transaction (the desktop application does them separately and can leave the stock wrong).
// The structure of the "feuillard" database is not touched: only rows are added, exactly as the desktop does.
//   GET  /refs                         lists for the forms (articles with stock, suppliers, team leaders, units, machines, causes)
//   GET  /mouvements?kind=             last movements of a kind
//   POST /entree | /sortie | /retour | /retour-fournisseur | /production
const router = express.Router();
const write = [requireAuth, requireFeature('feuillard.write')];
const prodRight = [requireAuth, requireFeature('feuillard.production')];
const anyRight = [requireAuth, requireAny(['feuillard.write', 'feuillard.production', 'feuillard.stats'])];

const trim = (v) => (v == null ? v : String(v).trim());
const fail = (res, err, what) => {
  if (err && err.status) return res.status(err.status).json({ error: err.message });
  console.error(`feuillard ${what} error:`, err);
  res.status(500).json({ error: 'Erreur serveur (base feuillard inaccessible ?).' });
};
class Refused extends Error { constructor(msg, status = 409) { super(msg); this.status = status; } }

async function inTx(fn) {
  const pool = await getFeuillardPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try { const out = await fn((q) => new sql.Request(tx)); await tx.commit(); return out; }
  catch (e) { try { await tx.rollback(); } catch (e2) { console.error('feuillard rollback failed:', e2.message); } throw e; }
}
const num = (v) => Number(v) || 0;

// The id the strapping desktop application records on movements (id_magasinier): explicit link, else same name.
async function strappingUserId(user) {
  try {
    const app = await getAppPool();
    const l = await app.request().input('u', sql.Int, user.id).query('select id_feuillard_user from app_feuillard_user where desktop_id = @u');
    if (l.recordset[0]) return l.recordset[0].id_feuillard_user;
  } catch (e) { /* table not created yet: try by name */ }
  const pool = await getFeuillardPool();
  const r = await pool.request().input('n', sql.VarChar, String(user.login || '')).query('select id from utilisateur where nom = @n');
  if (r.recordset.length === 1) return r.recordset[0].id;
  throw new Refused("Votre compte n'est pas relié à un utilisateur du logiciel feuillard. Demandez à l'administrateur de le relier (Utilisateurs).", 409);
}

async function must(rq, query, params, msg) {
  const r = rq();
  for (const [k, t, v] of params) r.input(k, t, v);
  const out = await r.query(query);
  if (!out.recordset.length) throw new Refused(msg, 400);
  return out.recordset[0];
}
const stockOf = async (rq, idArticle, lock) => {
  const r = await rq().input('a', sql.Int, idArticle).query(`select id, qt from stock_feuillard ${lock ? 'with (updlock, holdlock)' : ''} where id_article = @a`);
  if (!r.recordset[0]) throw new Refused("Cet article n'a pas de ligne de stock dans le logiciel feuillard.", 409);
  return r.recordset[0];
};
const moveStock = async (rq, idArticle, delta) => {
  await rq().input('a', sql.Int, idArticle).input('d', sql.Real, delta).query('update stock_feuillard set qt = qt + @d where id_article = @a');
};
async function log(req, kind, refId, summary) {
  try {
    const app = await getAppPool();
    await app.request().input('k', sql.VarChar, kind).input('r', sql.Int, refId).input('u', sql.Int, req.user.id).input('l', sql.NVarChar, req.user.login).input('s', sql.NVarChar, summary.slice(0, 300))
      .query('insert into app_feuillard_log (kind, ref_id, id_user, login, summary) values (@k, @r, @u, @l, @s)');
  } catch (e) { console.error('feuillard log skipped (is sql/12_feuillard_app.sql applied?):', e.message); }
}
const article = (rq, id) => must(rq, 'select id, designation from article_feuillard where id = @i', [['i', sql.Int, id]], 'Article introuvable.');

router.get('/refs', anyRight, async (req, res) => {
  try {
    const pool = await getFeuillardPool();
    const q = async (t) => (await pool.request().query(t)).recordset;
    const articles = await q('select a.id, a.designation, a.qt_meter, isnull(s.qt, 0) as stock from article_feuillard a left join stock_feuillard s on s.id_article = a.id order by a.designation');
    res.json({
      articles: articles.map((a) => ({ id: a.id, designation: trim(a.designation), qt_meter: a.qt_meter, stock: num(a.stock) })),
      fournisseurs: (await q('select id, nom from fournisseur order by nom')).map((x) => ({ id: x.id, nom: trim(x.nom) })),
      chefs: (await q('select id, nom from receptionniste order by nom')).map((x) => ({ id: x.id, nom: trim(x.nom) })),
      unites: (await q('select id, nom from destination order by nom')).map((x) => ({ id: x.id, nom: trim(x.nom) })),
      machines: (await q('select id, designation, id_unite, ligne from encercleuse order by designation')).map((x) => ({ id: x.id, nom: trim(x.designation), id_unite: x.id_unite, ligne: trim(x.ligne) })),
      causes: (await q('select designation, type from cause order by designation')).map((x) => ({ nom: trim(x.designation), type: trim(x.type) })),
      postes: V.POSTES, briques: V.BRIQUES, retour_types: V.RETOUR_TYPES, can: { write: can(req, 'feuillard.write'), production: can(req, 'feuillard.production') }
    });
  } catch (err) { fail(res, err, 'refs'); }
});

router.post('/entree', write, idempotent, async (req, res) => {
  try {
    const d = V.entree(req.body || {});
    const uid = await strappingUserId(req.user);
    const out = await inTx(async (rq) => {
      const art = await article(rq, d.id_article);
      await must(rq, 'select id from fournisseur where id = @i', [['i', sql.Int, d.id_fournisseur]], 'Fournisseur introuvable.');
      await stockOf(rq, d.id_article, true);
      const r = await rq().input('d', sql.Date, d.date).input('m', sql.Int, uid).input('a', sql.Int, d.id_article).input('q', sql.Real, d.qt).input('f', sql.Int, d.id_fournisseur)
        .query('insert into entre_magasin (date_entre, id_magasinier, id_article, qt, id_fournisseur) values (@d, @m, @a, @q, @f) select cast(scope_identity() as int) as id');
      await moveStock(rq, d.id_article, d.qt);
      return { id: r.recordset[0].id, art, stock: num((await stockOf(rq, d.id_article)).qt) };
    });
    await log(req, 'entree', out.id, `Entrée ${d.qt} × ${trim(out.art.designation)}`);
    res.status(201).json({ ok: true, id: out.id, stock: out.stock });
  } catch (err) { fail(res, err, 'entree'); }
});

async function issueLike(req, res, kind) {
  try {
    const isReturn = kind === 'retour';
    const d = isReturn ? V.retour(req.body || {}) : V.sortie(req.body || {});
    const uid = await strappingUserId(req.user);
    const out = await inTx(async (rq) => {
      const art = await article(rq, d.id_article);
      await must(rq, 'select id from receptionniste where id = @i', [['i', sql.Int, d.id_chef]], "Chef d'équipe introuvable.");
      await must(rq, 'select id from destination where id = @i', [['i', sql.Int, d.id_unite]], 'Unité introuvable.');
      const st = await stockOf(rq, d.id_article, true);
      let id;
      if (isReturn) {
        const r = await rq().input('d', sql.Date, d.date).input('c', sql.Int, d.id_chef).input('u', sql.Int, d.id_unite).input('m', sql.Int, uid).input('a', sql.Int, d.id_article).input('p', sql.VarChar, d.poste).input('q', sql.Real, d.qt).input('t', sql.VarChar, d.type)
          .query('insert into retour_feuillard (date_retour, id_receptionniste, id_destination, id_magasinier, id_article, poste, qt, type) values (@d, @c, @u, @m, @a, @p, @q, @t) select cast(scope_identity() as int) as id');
        id = r.recordset[0].id;
        if (d.type === 'Bon état') await moveStock(rq, d.id_article, d.qt);   // only good coils go back to stock
      } else {
        if (num(st.qt) < d.qt) throw new Refused(`Quantité en stock insuffisante (stock : ${num(st.qt)}).`, 409);
        const r = await rq().input('d', sql.Date, d.date).input('c', sql.Int, d.id_chef).input('u', sql.Int, d.id_unite).input('m', sql.Int, uid).input('a', sql.Int, d.id_article).input('p', sql.VarChar, d.poste).input('q', sql.Real, d.qt)
          .query('insert into sortie_feuillard (date_sortie, id_receptionniste, id_destination, id_magasinier, id_article, poste, qt) values (@d, @c, @u, @m, @a, @p, @q) select cast(scope_identity() as int) as id');
        id = r.recordset[0].id;
        await moveStock(rq, d.id_article, -d.qt);
      }
      return { id, art, stock: num((await stockOf(rq, d.id_article)).qt) };
    });
    await log(req, kind, out.id, `${isReturn ? 'Retour' : 'Sortie'} ${d.qt} × ${trim(out.art.designation)}${isReturn ? ' (' + d.type + ')' : ''}`);
    res.status(201).json({ ok: true, id: out.id, stock: out.stock });
  } catch (err) { fail(res, err, kind); }
}
router.post('/sortie', write, idempotent, (req, res) => issueLike(req, res, 'sortie'));
router.post('/retour', write, idempotent, (req, res) => issueLike(req, res, 'retour'));

router.post('/retour-fournisseur', write, idempotent, async (req, res) => {
  try {
    const d = V.retourFournisseur(req.body || {});
    const uid = await strappingUserId(req.user);
    const out = await inTx(async (rq) => {
      const art = await article(rq, d.id_article);
      await must(rq, 'select id from fournisseur where id = @i', [['i', sql.Int, d.id_fournisseur]], 'Fournisseur introuvable.');
      const st = await stockOf(rq, d.id_article, true);
      if (num(st.qt) < d.qt) throw new Refused(`Quantité en stock insuffisante (stock : ${num(st.qt)}).`, 409);
      const r = await rq().input('d', sql.Date, d.date).input('a', sql.Int, d.id_article).input('f', sql.Int, d.id_fournisseur).input('m', sql.Int, uid).input('q', sql.Real, d.qt)
        .query('insert into sortie_fournisseur (date_sortie, id_article, id_fournisseur, id_magasinier, qt) values (@d, @a, @f, @m, @q) select cast(scope_identity() as int) as id');
      await moveStock(rq, d.id_article, -d.qt);
      return { id: r.recordset[0].id, art, stock: num((await stockOf(rq, d.id_article)).qt) };
    });
    await log(req, 'retour_fournisseur', out.id, `Retour fournisseur ${d.qt} × ${trim(out.art.designation)}`);
    res.status(201).json({ ok: true, id: out.id, stock: out.stock });
  } catch (err) { fail(res, err, 'retour-fournisseur'); }
});

router.post('/production', prodRight, idempotent, async (req, res) => {
  try {
    const d = V.production(req.body || {});
    const out = await inTx(async (rq) => {
      const a1 = await article(rq, d.id_article);
      if (d.id2_article) await article(rq, d.id2_article);
      await must(rq, 'select id from receptionniste where id = @i', [['i', sql.Int, d.id_chef]], "Chef d'équipe introuvable.");
      await must(rq, 'select id from destination where id = @i', [['i', sql.Int, d.id_unite]], 'Unité introuvable.');
      // columns exactly as the desktop writes them (second brick / second article only when used)
      const cols = ['date_production', 'id_receptionniste', 'id_destination', 'id_article', 'poste', 'nbre_wagon', 'nbre_palette', 'brique', 'nbre_bobine'];
      const vals = ['@d', '@c', '@u', '@a', '@p', '@w', '@pl', '@b', '@bo'];
      const r = rq().input('d', sql.Date, d.date).input('c', sql.Int, d.id_chef).input('u', sql.Int, d.id_unite).input('a', sql.Int, d.id_article).input('p', sql.VarChar, d.poste)
        .input('w', sql.Real, d.nbre_wagon).input('pl', sql.Real, d.nbre_palette).input('b', sql.VarChar, d.brique).input('bo', sql.Real, d.nbre_bobine);
      if (d.wagon_h != null) { cols.push('wagon_h', 'palette_h'); vals.push('@wh', '@ph'); r.input('wh', sql.Real, d.wagon_h).input('ph', sql.Real, d.palette_h); }
      if (d.id2_article) { cols.push('id2_article', 'nbre_bobine_2'); vals.push('@a2', '@bo2'); r.input('a2', sql.Int, d.id2_article).input('bo2', sql.Real, d.nbre_bobine_2); }
      const ins = await r.query(`insert into production (${cols.join(', ')}) values (${vals.join(', ')}) select cast(scope_identity() as int) as id`);
      const idProd = ins.recordset[0].id;
      for (const [k, names] of Object.entries(d.causes)) {
        for (const nom of names) {
          await must(rq, 'select id from cause where designation = @n and type = @t', [['n', sql.VarChar, nom], ['t', sql.VarChar, V.CAUSE_TYPES[k]]], `Cause inconnue : ${nom}`);
          await rq().input('p', sql.Int, idProd).input('n', sql.VarChar, nom).input('t', sql.VarChar, k).query('insert into ishikawa (id_production, designation, type) values (@p, @n, @t)');
        }
      }
      for (const a of d.arrets) {
        await must(rq, 'select id from encercleuse where id = @m and id_unite = @u', [['m', sql.Int, a.id_encercleuse], ['u', sql.Int, d.id_unite]], "Cette machine n'appartient pas à l'unité choisie.");
        await rq().input('p', sql.Int, idProd).input('m', sql.Int, a.id_encercleuse).input('c', sql.VarChar, a.cause).input('f', sql.Real, a.frequence).input('d', sql.VarChar, a.duree)
          .query('insert into cause_encercleuse (id_production, id_encercleuse, cause_machine, frequence, duree) values (@p, @m, @c, @f, @d)');
      }
      return { id: idProd, art: a1 };
    });
    await log(req, 'production', out.id, `Production ${d.brique} ${d.nbre_wagon} wagons / ${d.nbre_palette} palettes (${d.poste}, ${d.date})`);
    res.status(201).json({ ok: true, id: out.id });
  } catch (err) { fail(res, err, 'production'); }
});

const LISTS = {
  entree: `select top 20 m.id, m.date_entre as date, a.designation as article, m.qt, f.nom as detail from entre_magasin m inner join article_feuillard a on m.id_article = a.id left join fournisseur f on m.id_fournisseur = f.id order by m.date_entre desc, m.id desc`,
  sortie: `select top 20 m.id, m.date_sortie as date, a.designation as article, m.qt, r.nom + ' · ' + d.nom + ' · ' + m.poste as detail from sortie_feuillard m inner join article_feuillard a on m.id_article = a.id left join receptionniste r on m.id_receptionniste = r.id left join destination d on m.id_destination = d.id order by m.date_sortie desc, m.id desc`,
  retour: `select top 20 m.id, m.date_retour as date, a.designation as article, m.qt, r.nom + ' · ' + d.nom + ' · ' + m.poste + ' · ' + m.type as detail from retour_feuillard m inner join article_feuillard a on m.id_article = a.id left join receptionniste r on m.id_receptionniste = r.id left join destination d on m.id_destination = d.id order by m.date_retour desc, m.id desc`,
  'retour-fournisseur': `select top 20 m.id, m.date_sortie as date, a.designation as article, m.qt, f.nom as detail from sortie_fournisseur m inner join article_feuillard a on m.id_article = a.id left join fournisseur f on m.id_fournisseur = f.id order by m.date_sortie desc, m.id desc`
};
router.get('/mouvements', write, async (req, res) => {
  const q = LISTS[req.query.kind];
  if (!q) return res.status(400).json({ error: 'Type inconnu.' });
  try {
    const pool = await getFeuillardPool();
    const r = await pool.request().query(q);
    res.json({ rows: r.recordset.map((x) => ({ id: x.id, date: x.date, article: trim(x.article), qt: num(x.qt), detail: trim(x.detail) || '' })) });
  } catch (err) { fail(res, err, 'mouvements'); }
});

module.exports = router;
