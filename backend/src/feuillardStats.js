// Statistics of the strapping module, ported from the desktop application "Gestion de Feuillard"
// (tableau_bord.cs and Historique_production.cs). Pure functions: no database access here.

const BRICKS = ['B12', 'Hourdi', 'B8', 'Platriere'];
const norm = (b) => String(b || '').trim().replace('Platrière', 'Platriere');
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (x) => Math.round(x * 100) / 100;
const r0 = (x) => Math.round(x);

// A production record names a brick ("B12") or two ("B12 & Hourdi"); wagons / pallets of the first brick are
// nbre_wagon / nbre_palette, those of the second brick are wagon_h / palette_h.
function parseBrique(brique) {
  const parts = String(brique || '').split('&').map(norm).filter(Boolean);
  return parts.filter((p) => BRICKS.includes(p));
}

// When two coil articles were used (id2_article set) the desktop splits the wagons / pallets between them:
// B12 and B8 are shared 57 % / 43 %, Hourdi and Platrière 55 % / 45 % (first article / second article).
const SHARE = { B12: [0.57, 0.43], B8: [0.57, 0.43], Hourdi: [0.55, 0.45], Platriere: [0.55, 0.45] };

// One line of the dashboard: a production record seen from one of its coil articles.
// `isSecond` = this line is about the record's second article (id2_article).
function brickShares(rec, hasSecond, isSecond) {
  const out = {};
  const bricks = parseBrique(rec.brique);
  const add = (b, wag, pal) => {
    if (!b) return;
    const f = hasSecond ? SHARE[b][isSecond ? 1 : 0] : 1;
    const o = out[b] || (out[b] = { wagons: 0, palettes: 0 });
    o.wagons += r2(f * num(wag)); o.palettes += r0(f * num(pal));
  };
  add(bricks[0], rec.nbre_wagon, rec.nbre_palette);
  if (bricks.length > 1) add(bricks[1], rec.wagon_h, rec.palette_h);
  return out;
}

const pct = (a, b) => (b > 0 ? Math.round(a / b * 10000) / 100 : null);
const ratio = (a, b) => (b > 0 ? Math.round(a / b * 100) / 100 : null);

function finishRow(r) {
  r.wagons = r2(BRICKS.reduce((s, b) => s + r.bricks[b].wagons, 0));
  r.palettes = BRICKS.reduce((s, b) => s + r.bricks[b].palettes, 0);
  r.ecart = r2(r.sorties - r.retours - r.consomme);
  r.p_w = ratio(r.palettes, r.wagons);
  r.pct_palette = pct(r.sorties - r.retours, r.palettes);   // coils lost (issued - returned) per 100 pallets
  r.pct_wagon = pct(r.sorties - r.retours, r.wagons);       // ... per 100 wagons
  return r;
}
const emptyRow = (o) => Object.assign({ bricks: Object.fromEntries(BRICKS.map((b) => [b, { wagons: 0, palettes: 0 }])), sorties: 0, retours: 0, consomme: 0 }, o);

// prodRows: one row per (production record x coil article it uses): { chef, unite, article, art_id, id_article, id2_article, brique,
//           nbre_wagon, wagon_h, nbre_palette, palette_h, nbre_bobine, nbre_bobine_2 }
// issues / returns: [{ chef, unite, article, qt }]  (already filtered by period; issues also by shift)
function productionDashboard(prodRows, issues, returns) {
  const rows = new Map();
  const key = (c, u, a) => `${c}\u0001${u}\u0001${a}`;
  for (const p of prodRows) {
    const k = key(p.chef, p.unite, p.article);
    const row = rows.get(k) || rows.set(k, emptyRow({ chef: p.chef, unite: p.unite, article: p.article })).get(k);
    const hasSecond = p.id2_article != null && p.id2_article !== '';
    const isSecond = hasSecond && p.id2_article === p.art_id;
    const sh = brickShares(p, hasSecond, isSecond);
    for (const b of Object.keys(sh)) { row.bricks[b].wagons += sh[b].wagons; row.bricks[b].palettes += sh[b].palettes; }
    row.consomme += isSecond ? num(p.nbre_bobine_2) : num(p.nbre_bobine);
  }
  // only the (team leader, unit, article) combinations that produced something are listed, like the desktop
  for (const i of issues) { const r = rows.get(key(i.chef, i.unite, i.article)); if (r) r.sorties += num(i.qt); }
  for (const i of returns) { const r = rows.get(key(i.chef, i.unite, i.article)); if (r) r.retours += num(i.qt); }
  const list = [...rows.values()].map(finishRow).sort((a, b) => (a.unite + a.chef + a.article).localeCompare(b.unite + b.chef + b.article, 'fr'));
  const sum = (items, o) => {
    const t = emptyRow(o);
    for (const r of items) { t.sorties += r.sorties; t.retours += r.retours; t.consomme += r.consomme; for (const b of BRICKS) { t.bricks[b].wagons += r.bricks[b].wagons; t.bricks[b].palettes += r.bricks[b].palettes; } }
    t.sorties = r2(t.sorties); t.retours = r2(t.retours); t.consomme = r2(t.consomme);
    return finishRow(t);
  };
  const group = (field) => [...new Set(list.map((r) => r[field]))].map((v) => sum(list.filter((r) => r[field] === v), { [field]: v }));
  return { rows: list, par_unite: group('unite'), par_chef: group('chef'), total: sum(list, {}) };
}

// ---- waste in metres (Historique_production): metres of strap really needed for the pallets produced versus the
// metres of the coils consumed. The metres-per-pallet figures are the ones hard-coded in the desktop application.
const M_SINGLE = { B12: 45.84, Hourdi: 45.04, B8: 41.42, Platriere: 45.04 };   // one coil article
const M_FIRST = { B12: 26.4, Hourdi: 27.76, B8: 23.58, Platriere: 27.76 };     // two articles: first article
const M_SECOND = { B12: 19.44, Hourdi: 17.28, B8: 17.84, Platriere: 17.28 };   // two articles: second article
function metresNeeded(table, brique, palette, paletteH) {
  const b = parseBrique(brique);
  if (b.length > 1) return num(palette) * table[b[0]] + num(paletteH) * table[b[1]];
  return num(palette) * (table[b[0]] || table.B12);
}

// rec: { chef, unite, poste, date, brique, nbre_palette, palette_h, nbre_bobine, nbre_bobine_2, qm1, qm2 }
function wasteOfRecord(rec) {
  const two = num(rec.nbre_bobine_2) !== 0;
  const parts = [];
  if (num(rec.qm1) > 0) {
    const total = num(rec.qm1) * num(rec.nbre_bobine);
    parts.push({ total, used: metresNeeded(two ? M_FIRST : M_SINGLE, rec.brique, rec.nbre_palette, rec.palette_h) });
  }
  if (two && num(rec.qm2) > 0) {
    const total = num(rec.qm2) * num(rec.nbre_bobine_2);
    parts.push({ total, used: metresNeeded(M_SECOND, rec.brique, rec.nbre_palette, rec.palette_h) });
  }
  const total = parts.reduce((s, p) => s + p.total, 0), used = parts.reduce((s, p) => s + p.used, 0);
  return { total_m: r2(total), besoin_m: r2(used), dechet_m: r2(total - used), pct: pct(total - used, total) };
}

function wasteReport(records) {
  const items = records.map((r) => Object.assign({ id: r.id, date: r.date, chef: r.chef, unite: r.unite, poste: r.poste, brique: r.brique }, wasteOfRecord(r)));
  const sum = (arr, o) => {
    const total = arr.reduce((s, x) => s + x.total_m, 0), dech = arr.reduce((s, x) => s + x.dechet_m, 0);
    return Object.assign(o, { n: arr.length, total_m: r2(total), dechet_m: r2(dech), pct: pct(dech, total) });
  };
  const group = (f) => [...new Set(items.map((x) => x[f]))].map((v) => sum(items.filter((x) => x[f] === v), { [f]: v })).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
  return { total: sum(items, {}), par_chef: group('chef'), par_unite: group('unite'), recent: items.slice(0, 50) };
}

// ---- machine stoppages: durations are stored as text "hh:mm:ss"
function seconds(txt) {
  const m = /^\s*(\d+):(\d{1,2})(?::(\d{1,2}))?/.exec(String(txt || ''));
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0) : 0;
}
function stoppages(rows) {
  const map = new Map();
  for (const r of rows) {
    const k = [r.unite, r.ligne, r.machine, r.cause].join('\u0001');
    const o = map.get(k) || map.set(k, { unite: r.unite, ligne: r.ligne, machine: r.machine, cause: r.cause, frequence: 0, secondes: 0 }).get(k);
    o.frequence += num(r.frequence); o.secondes += seconds(r.duree);
  }
  const list = [...map.values()].map((o) => Object.assign(o, { minutes: Math.round(o.secondes / 60), duree: `${Math.floor(o.secondes / 3600)} h ${String(Math.floor(o.secondes % 3600 / 60)).padStart(2, '0')} min` }));
  list.sort((a, b) => b.secondes - a.secondes);
  const s = list.reduce((t, o) => t + o.secondes, 0);
  return { rows: list, total: { frequence: list.reduce((t, o) => t + o.frequence, 0), secondes: s, duree: `${Math.floor(s / 3600)} h ${String(Math.floor(s % 3600 / 60)).padStart(2, '0')} min` } };
}

// ---- stock check: the stored stock (what the desktop shows) against the stock recalculated from the movements:
// receipts - issues + returns in good condition - returns to the supplier. `base` = difference accepted by the owner.
function stockCheck(r, base) {
  const n = (v) => Math.round(num(v) * 100) / 100;
  const recalcule = n(num(r.entrees) - num(r.sorties) + num(r.retours_bon) - num(r.retours_four));
  const stock = n(r.stock);
  const ecart = n(stock - recalcule);
  const net = n(ecart - num(base));
  const par_jour = num(r.sorties30) / 30;
  return {
    id: r.id, designation: r.designation, qt_meter: r.qt_meter == null ? null : num(r.qt_meter), stock, recalcule, ecart, base: n(base), ecart_net: net, ok: Math.abs(net) < 0.005,
    metres: r.qt_meter ? Math.round(stock * num(r.qt_meter)) : null,
    jours: par_jour > 0 ? Math.round(stock / par_jour * 10) / 10 : null,
    sorties30: n(r.sorties30), lignes_stock: num(r.lignes_stock),
    detail: { entrees: n(r.entrees), sorties: n(r.sorties), retours_bon: n(r.retours_bon), retours_mauvais: n(r.retours_mauvais), retours_four: n(r.retours_four) }
  };
}

module.exports = { stockCheck, BRICKS, parseBrique, brickShares, productionDashboard, wasteOfRecord, wasteReport, seconds, stoppages, metresNeeded };
