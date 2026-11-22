// Validation of what the phone sends for the strapping module (pure functions, no database).
const POSTES = ['Jour', 'Soir', 'Nuit'];
const BRIQUES = ['B12', 'Hourdi', 'Platrière', 'B8', 'B12 & Hourdi', 'B12 & Platrière', 'B12 & B8', 'Hourdi & Platrière', 'Hourdi & B8', 'B8 & Platrière'];
const RETOUR_TYPES = ['Bon état', 'Mauvais état'];
// ishikawa.type as the desktop application writes it
const CAUSE_TYPES = { main_ouevre: 'Main_Ouevre', machine: 'Machine', matiere: 'Matiere', methode: 'Methode', milieu: 'Milieu' };

class Bad extends Error { constructor(msg) { super(msg); this.status = 400; } }
const fail = (m) => { throw new Bad(m); };

function id(v, label) { const n = Number(v); if (!Number.isInteger(n) || n <= 0) fail(`${label} : choix invalide.`); return n; }
function qty(v, label = 'Quantité') {
  const n = Number(v);
  if (v === '' || v == null || !Number.isFinite(n) || n <= 0) fail(`${label} : nombre strictement positif requis.`);
  if (n > 1000000) fail(`${label} : valeur trop grande.`);
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) fail(`${label} : 2 décimales au maximum.`);
  return Math.round(n * 100) / 100;
}
function amount(v, label) {   // wagons, pallets, coils: 0 allowed
  const n = Number(v);
  if (v === '' || v == null || !Number.isFinite(n) || n < 0) fail(`${label} : nombre requis (0 ou plus).`);
  if (n > 1000000) fail(`${label} : valeur trop grande.`);
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) fail(`${label} : 2 décimales au maximum.`);
  return Math.round(n * 100) / 100;
}
function date(v, now = new Date()) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) fail('Date invalide.');
  const today = new Date(now.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);   // one day of tolerance for time zones
  if (v > today) fail('La date ne peut pas être dans le futur.');
  const oldest = new Date(now.getTime() - 90 * 864e5).toISOString().slice(0, 10);
  if (v < oldest) fail('Date trop ancienne (90 jours maximum) : saisissez-la au bureau.');
  return v;
}
function oneOf(v, list, label) { if (typeof v !== 'string' || !list.includes(v)) fail(`${label} : choix invalide.`); return v; }

const entree = (b, now) => ({ date: date(b.date, now), id_article: id(b.id_article, 'Article'), id_fournisseur: id(b.id_fournisseur, 'Fournisseur'), qt: qty(b.qt) });
const sortie = (b, now) => ({ date: date(b.date, now), poste: oneOf(b.poste, POSTES, 'Poste'), id_chef: id(b.id_chef, "Chef d'équipe"), id_unite: id(b.id_unite, 'Unité'), id_article: id(b.id_article, 'Article'), qt: qty(b.qt) });
const retour = (b, now) => Object.assign(sortie(b, now), { type: oneOf(b.type, RETOUR_TYPES, "Type de retour") });
const retourFournisseur = (b, now) => ({ date: date(b.date, now), id_article: id(b.id_article, 'Article'), id_fournisseur: id(b.id_fournisseur, 'Fournisseur'), qt: qty(b.qt) });

function production(b, now) {
  const out = {
    date: date(b.date, now), poste: oneOf(b.poste, POSTES, 'Poste'), id_chef: id(b.id_chef, "Chef d'équipe"), id_unite: id(b.id_unite, 'Unité'),
    brique: oneOf(b.brique, BRIQUES, 'Brique'), id_article: id(b.id_article, 'Article'),
    nbre_wagon: amount(b.nbre_wagon, 'Nombre de wagons'), nbre_palette: amount(b.nbre_palette, 'Nombre de palettes'), nbre_bobine: amount(b.nbre_bobine, 'Nombre de bobines'),
    id2_article: null, nbre_bobine_2: null, wagon_h: null, palette_h: null, causes: {}, arrets: []
  };
  if (out.brique.includes('&')) { out.wagon_h = amount(b.wagon_h, 'Wagons (2e brique)'); out.palette_h = amount(b.palette_h, 'Palettes (2e brique)'); }
  const has2 = b.id2_article != null && b.id2_article !== '';
  if (has2) {
    out.id2_article = id(b.id2_article, '2e article'); out.nbre_bobine_2 = amount(b.nbre_bobine_2, 'Bobines (2e article)');
    if (out.id2_article === out.id_article) fail('Les deux articles doivent être différents.');
  } else if (b.nbre_bobine_2 != null && b.nbre_bobine_2 !== '' && Number(b.nbre_bobine_2) !== 0) fail('Choisissez le 2e article.');
  const c = b.causes || {};
  if (typeof c !== 'object' || Array.isArray(c)) fail('Causes invalides.');
  for (const k of Object.keys(c)) {
    if (!CAUSE_TYPES[k]) fail(`Type de cause inconnu : ${k}`);
    if (!Array.isArray(c[k]) || c[k].length > 50) fail('Causes invalides.');
    const names = [...new Set(c[k].map((x) => String(x).trim()).filter(Boolean))];
    if (names.some((x) => x.length > 200)) fail('Cause trop longue.');
    if (names.length) out.causes[k] = names;
  }
  const a = b.arrets == null ? [] : b.arrets;
  if (!Array.isArray(a) || a.length > 50) fail('Arrêts invalides.');
  out.arrets = a.map((x) => {
    const duree = String(x.duree || '');
    if (!/^\d{1,2}:[0-5]\d:[0-5]\d$/.test(duree)) fail('Durée d\'arrêt : format hh:mm:ss.');
    const cause = String(x.cause || '').trim(); if (!cause || cause.length > 200) fail("Cause d'arrêt requise.");
    return { id_encercleuse: id(x.id_encercleuse, 'Machine'), cause, frequence: qty(x.frequence, 'Fréquence'), duree: duree.length === 7 ? '0' + duree : duree };
  });
  return out;
}

module.exports = { id, POSTES, BRIQUES, RETOUR_TYPES, CAUSE_TYPES, Bad, entree, sortie, retour, retourFournisseur, production };
