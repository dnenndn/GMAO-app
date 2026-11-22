const mssql = require('mssql');
const { getAppPool } = require('./appDb');
const R = require('./roles');

// Catalog of everything a user can be allowed to do in the app.
// `roles` = who has it BY DEFAULT (the rules the app already followed, copied
// from the desktop). An administrator can then grant or remove any feature for
// any single user: those exceptions live in GMAO_APP.app_user_permission.
// Effective right = exception if one exists, otherwise the role default.
const ALL = '*';
const not = (...excluded) => ({ not: excluded });

const FEATURES = [
  // group, key, label, default roles
  ['Stock', 'stock.view', 'Consulter le stock (recherche articles)', ALL],
  ['Stock', 'stock.insight', 'Analyse stock (sous minimum, dormant)', ALL],
  ['Stock', 'stock.valuation', 'Valeur du stock par famille', R.MONEY_ROLES],
  ['Stock', 'nfc.manage', 'Gérer les tags NFC des articles', R.MANAGER_ROLES],
  ['Magasin', 'bsm.create', 'Créer un bon de sortie (BSM)', ALL],
  ['Magasin', 'bsm.validate', 'Valider les BSM / historique (sans validation pour soi)', R.MANAGER_ROLES],
  ['Magasin', 'brm.create', 'Créer un bon de retour (BRM)', ALL],
  ['Magasin', 'brm.validate', 'Valider les BRM / historique (sans validation pour soi)', R.MANAGER_ROLES],
  ['Magasin', 'reception.use', 'Réceptions (bons de commande)', R.MANAGER_ROLES],
  ['Achats', 'da.create', "Créer une demande d'achat", not('Administrateur')],
  ['Achats', 'da.on_behalf', "Créer une DA pour un autre demandeur", R.DA_ON_BEHALF_ROLES],
  ['Achats', 'da.review', "Voir les demandes d'achat à traiter (de tous)", R.DA_REVIEW_ROLES],
  ['Achats', 'da.approve', "Traiter les DA en cours : confirmer, refuser, envoyer à l'admin, reporter", ['Responsable Achat']],
  ['Achats', 'da.approve_admin', "Confirmer les DA envoyées à l'administrateur", ['Administrateur']],
  ['Achats', 'achats.view', 'Achats: commandes, BL, factures, synthèse', R.MONEY_ROLES],
  ['Atelier', 'atelier.view', 'Voir les ordres de fabrication (OF)', ALL],
  ['Atelier', 'atelier.write', 'Réceptionner / modifier les OF', not('DGA')],
  ['Production', 'production.view', 'Voir les rapports de production', ALL],
  ['Production', 'production.write', 'Saisir les rapports de production', not('DGA')],
  ['Production', 'production.anomalie_create', 'Créer une nouvelle anomalie de production', R.MANAGER_ROLES],
  ['Maintenance', 'maintenance.view', 'Voir les demandes et ordres de travail', ALL],
  ['Maintenance', 'di.create', "Créer / annuler une demande d'intervention", not('DGA')],
  ['Maintenance', 'di.manage', "Annuler ou réactiver les DI des autres", [...new Set([...R.MANAGER_ROLES, ...R.MAINTENANCE_ROLES])]],
  ['Maintenance', 'ot.update', "Commenter un OT et demander sa clôture", not('DGA')],
  ['Parc', 'parc.view', 'Parc: gasoil, bons, alertes, papiers', ALL],
  ['Parc', 'parc.cuve', 'Contrôle de cuve carburant (litres mesurés)', ['Administrateur', 'Responsable Méthode', 'Responsable Magasin']],
  ['Parc', 'parc.seuils', "Régler le seuil d'alerte gasoil des engins", ['Administrateur', 'Responsable Méthode', 'Responsable Magasin']],
  ['Feuillard', 'feuillard.stats', 'Feuillard: statistiques de production (rendement, déchet, arrêts, causes)', ['Administrateur', 'Responsable Méthode', 'DGA']],
  ['Feuillard', 'feuillard.write', 'Feuillard: saisir entrées, sorties, retours et retours fournisseur', ['Administrateur', 'Responsable Magasin', 'Magasinier']],
  ['Feuillard', 'feuillard.production', 'Feuillard: saisir la production (causes de déchet, arrêts machine)', ['Administrateur', 'Responsable Méthode', "Chef d'équipe"]],
  ['Général', 'money.view', 'Voir les montants (coûts OT, tableau de bord, valeurs)', R.MONEY_ROLES],
  ['Administration', 'users.admin', 'Gérer les utilisateurs', R.ADMIN_ROLES]
].map(([group, key, label, roles]) => ({ group, key, label, roles }));

const KEYS = new Set(FEATURES.map((f) => f.key));

function defaultAllowed(feature, fonction) {
  const f = (fonction || '').trim();
  const r = feature.roles;
  if (r === ALL) return true;
  if (Array.isArray(r)) return r.includes(f);
  return !r.not.includes(f);
}

function defaultPerms(fonction) {
  const out = {};
  for (const f of FEATURES) out[f.key] = defaultAllowed(f, fonction);
  return out;
}

// ---- overrides (cached a few seconds so a change is effective almost at once) ----
const TTL = 10000;
const cache = new Map();   // userId -> { at, map }

async function loadOverrides(userId) {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL) return hit.map;
  let map = new Map();
  try {
    const pool = await getAppPool();
    const r = await pool.request().input('u', mssql.Int, userId)
      .query('select feature, allowed from app_user_permission where id_user = @u');
    map = new Map(r.recordset.map((x) => [x.feature, x.allowed === true || x.allowed === 1]));
  } catch (e) {
    // table not created yet / app database down: role defaults apply
  }
  cache.set(userId, { at: Date.now(), map });
  return map;
}
function invalidate(userId) { if (userId == null) cache.clear(); else cache.delete(userId); }

// The owner(s) of the app (OWNER_LOGINS in .env, default "marwen") have every right, always, and are the only
// people who manage users and rights. Everybody else, whatever his role, gets his role's rights
// plus the exceptions the owner set, and never "users.admin".
function isOwner(user) {
  const owners = (process.env.OWNER_LOGINS || 'marwen').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return !!user && owners.includes(String(user.login || '').trim().toLowerCase());
}

async function effectivePerms(user) {
  if (isOwner(user)) { const all = {}; for (const f of FEATURES) all[f.key] = true; return all; }
  const base = defaultPerms(user.fonction);
  const over = await loadOverrides(user.id);
  for (const [k, v] of over) if (KEYS.has(k)) base[k] = v;
  base['users.admin'] = false;
  return base;
}

// Sync access from a route (requireAuth fills req.perms; tests may skip it).
const permsOf = (req) => req.perms || defaultPerms(req.user && req.user.fonction);
const can = (req, key) => !!permsOf(req)[key];
function requireFeature(key) {
  if (!KEYS.has(key)) throw new Error(`Unknown feature ${key}`);
  return (req, res, next) => {
    if (!can(req, key)) return res.status(403).json({ error: "Vous n'avez pas les droits pour cette action." });
    next();
  };
}

function requireAny(keys) {
  keys.forEach((k) => { if (!KEYS.has(k)) throw new Error(`Unknown feature ${k}`); });
  return (req, res, next) => {
    if (!keys.some((k) => can(req, k))) return res.status(403).json({ error: "Vous n'avez pas les droits pour cette action." });
    next();
  };
}

module.exports = { isOwner, requireAny, FEATURES, KEYS, defaultAllowed, defaultPerms, effectivePerms, loadOverrides, invalidate, can, permsOf, requireFeature };
