const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireFeature, can } = require('../features');
const { notifyUsers, notifyRoles } = require('../push');
const { loginsByIds } = require('../userLookup');
const { intParam, parseDate, iso, todayUtc } = require('../lib');

// Demande d'achat review - the desktop workflow (liste_da.cs, da_admin.cs, da_reporter.cs):
//   statut 0 En cours      -> confirmer (1), refuser + cause (2), envoyer à l'administrateur (3), reporter + nouvelle date (4)
//   statut 3 Administrateur-> confirmer (1)
//   statut 4 Reportée      -> remettre en cours (0)
// Every step also writes the same history row as the desktop
// (da_confirmer / da_refuser / da_administrateur / da_reporter / da_retourner).
const router = express.Router();
router.use(requireAuth);

const LABEL = { 0: 'En cours', 1: 'Confirmée', 2: 'Refusée', 3: "Chez l'administrateur", 4: 'Reportée', 10: 'Clôturée' };
const LISTABLE = [0, 3, 4, 2, 1];

class ReviewError extends Error { constructor(m, status = 400) { super(m); this.status = status; } }

const hhmm = (d = new Date()) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

router.get('/', requireFeature('da.review'), async (req, res) => {
  const st = req.query.statut == null ? 0 : Number.parseInt(req.query.statut, 10);
  if (!LISTABLE.includes(st)) return res.status(400).json({ error: 'Statut invalide.' });
  try {
    const pool = await getPool();
    const r = await pool.request().input('s', sql.Int, st).query(`
      select top 100 d.id, d.date_da, d.heure_da, d.createur, d.demandeur, d.delai, d.periode, d.statut,
             (select count(*) from da_article x where x.id_da = d.id) as nb_lignes
      from demande_achat d where d.statut = @s order by d.id desc`);
    const logins = await loginsByIds(r.recordset.flatMap((x) => [x.createur, x.demandeur]));
    const counts = await pool.request().query('select statut, count(*) as nb from demande_achat where statut in (0, 3, 4) group by statut');
    res.json({
      statut: st, counts: Object.fromEntries(counts.recordset.map((c) => [c.statut, c.nb])),
      da: r.recordset.map((x) => ({ id: x.id, date: x.date_da instanceof Date ? iso(x.date_da) : String(x.date_da).slice(0, 10), heure: x.heure_da,
        delai: x.delai, periode: x.periode, statut: x.statut, statut_label: LABEL[x.statut] || String(x.statut), nb_lignes: x.nb_lignes,
        createur: logins[x.createur] || null, demandeur: logins[x.demandeur] || null }))
    });
  } catch (err) {
    console.error('da review list error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.get('/:id', requireFeature('da.review'), async (req, res) => {
  const id = intParam(req.params.id);
  if (id == null) return res.status(400).json({ error: 'DA invalide.' });
  try {
    const pool = await getPool();
    const h = await pool.request().input('i', sql.Int, id).query('select id, date_da, heure_da, createur, demandeur, delai, periode, statut from demande_achat where id = @i');
    if (h.recordset.length === 0) return res.status(404).json({ error: 'Demande introuvable.' });
    const d = h.recordset[0];
    const lines = await pool.request().input('i', sql.Int, id).query(`
      select da.id, a.code_article, a.designation, da.qt, da.motif, a.stock_neuf
      from da_article da inner join article a on a.id = da.id_article where da.id_da = @i order by da.id`);
    const eq = await pool.request().input('i', sql.Int, id).query(`
      select x.id_lis, e.designation from da_article_equipement x inner join equipement e on e.id = x.id_equipement where x.id_da = @i order by e.designation`);
    const byLine = {};
    eq.recordset.forEach((x) => { (byLine[x.id_lis] = byLine[x.id_lis] || []).push((x.designation || '').trim()); });
    const cause = await pool.request().input('i', sql.Int, id).query('select top 1 cause from da_refuser where id_da = @i order by id desc');
    const logins = await loginsByIds([d.createur, d.demandeur]);
    res.json({
      id: d.id, date: d.date_da instanceof Date ? iso(d.date_da) : String(d.date_da).slice(0, 10), heure: d.heure_da, delai: d.delai, periode: d.periode,
      statut: d.statut, statut_label: LABEL[d.statut] || String(d.statut), createur: logins[d.createur] || null, demandeur: logins[d.demandeur] || null,
      cause: d.statut === 2 && cause.recordset[0] ? cause.recordset[0].cause : null,
      lines: lines.recordset.map((l) => ({ code: (l.code_article || '').trim(), designation: (l.designation || '').trim(), qt: l.qt, motif: (l.motif || '').trim(),
        stock: l.stock_neuf, equipements: byLine[l.id] || [] })),
      actions: allowedActions(req, d.statut)
    });
  } catch (err) {
    console.error('da review get error:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

function allowedActions(req, statut) {
  const a = [];
  if (statut === 0 && can(req, 'da.approve')) a.push('confirmer', 'refuser', 'admin', 'reporter');
  if (statut === 3 && can(req, 'da.approve_admin')) a.push('confirmer');
  if (statut === 4 && can(req, 'da.approve')) a.push('retourner');
  return a;
}

// action -> [from status, to status, history table SQL]
const ACTIONS = {
  confirmer: { to: 1, sql: 'insert into da_confirmer (id_da, confirmer_par, date_confirmer, heure_confirmer) values (@id, @u, @d, @h)' },
  refuser: { to: 2, sql: 'insert into da_refuser (id_da, refuser_par, date_refus, heure_refus, cause) values (@id, @u, @d, @h, @cause)' },
  admin: { to: 3, sql: 'insert into da_administrateur (id_da, envoyer_par, date_envoyer, heure_envoyer) values (@id, @u, @d, @h)' },
  reporter: { to: 4, sql: 'insert into da_reporter (id_da, reporter_par, date_report, heure_report, nouvel_date) values (@id, @u, @d, @h, @nd)' },
  retourner: { to: 0, sql: 'insert into da_retourner (id_da, retourner_par, date_retourner, heure_retourner) values (@id, @u, @d, @h)' }
};

router.post('/:id/:action', async (req, res) => {
  const id = intParam(req.params.id);
  const act = ACTIONS[req.params.action];
  if (id == null || !act) return res.status(400).json({ error: 'Action invalide.' });
  if (!can(req, 'da.approve') && !can(req, 'da.approve_admin')) return res.status(403).json({ error: "Vous n'avez pas les droits pour cette action." });
  const b = req.body || {};
  let cause = null, newDate = null;
  if (req.params.action === 'refuser') {
    cause = String(b.cause || '').trim();
    if (!cause) return res.status(400).json({ error: 'Indiquez la cause du refus.' });
    if (cause.length > 250) return res.status(400).json({ error: 'Cause trop longue (250 caractères maximum).' });
  }
  if (req.params.action === 'reporter') {
    newDate = parseDate(b.date);
    if (!newDate || newDate < todayUtc()) return res.status(400).json({ error: 'Choisissez une nouvelle date (aujourd\'hui ou plus tard).' });
  }
  try {
    const pool = await getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    let d;
    try {
      // lock the row so two approvers cannot act on the same DA at once
      const cur = await new sql.Request(tx).input('i', sql.Int, id).query('select statut, createur, demandeur from demande_achat with (updlock, rowlock) where id = @i');
      if (cur.recordset.length === 0) throw new ReviewError('Demande introuvable.', 404);
      d = cur.recordset[0];
      if (!allowedActions(req, d.statut).includes(req.params.action)) {
        throw new ReviewError(`Cette demande est « ${LABEL[d.statut] || d.statut} » : action impossible.`, 409);
      }
      await new sql.Request(tx).input('s', sql.Int, act.to).input('i', sql.Int, id).query('update demande_achat set statut = @s where id = @i');
      const rq = new sql.Request(tx).input('id', sql.Int, id).input('u', sql.Int, req.user.id).input('d', sql.Date, todayUtc()).input('h', sql.VarChar, hhmm());
      if (cause != null) rq.input('cause', sql.VarChar, cause);
      if (newDate) rq.input('nd', sql.Date, newDate);
      await rq.query(act.sql);
      await tx.commit();
    } catch (e) {
      try { await tx.rollback(); } catch (e2) { console.error('da review rollback failed:', e2); }
      throw e;
    }
    res.json({ ok: true, statut: act.to, statut_label: LABEL[act.to] });
    notifyOutcome(req.params.action, id, req.user, d, { cause, newDate }).catch((e) => console.error('da review notify failed:', e));
  } catch (err) {
    if (err instanceof ReviewError) return res.status(err.status).json({ error: err.message });
    console.error('da review action error:', err);
    res.status(500).json({ error: 'Erreur serveur pendant le traitement de la demande.' });
  }
});

async function notifyOutcome(action, id, user, d, extra) {
  const who = user.login || 'Un responsable';
  if (action === 'admin') {
    return notifyRoles(['Administrateur'], { type: 'da_admin', idRef: id, title: "DA à confirmer", body: `${who} a envoyé la demande d'achat #${id} à l'administrateur.` });
  }
  const text = {
    confirmer: () => `La demande d'achat #${id} a été confirmée par ${who}.`,
    refuser: () => `La demande d'achat #${id} a été refusée par ${who} : ${extra.cause}`,
    reporter: () => `La demande d'achat #${id} a été reportée au ${iso(extra.newDate).split('-').reverse().join('/')} par ${who}.`,
    retourner: () => `La demande d'achat #${id} est de nouveau en cours.`
  }[action]();
  const ids = [...new Set([d.createur, d.demandeur])].filter((x) => x && x !== user.id);
  if (ids.length) await notifyUsers(ids, { type: `da_${action}`, idRef: id, title: "Demande d'achat", body: text });
}

module.exports = router;
