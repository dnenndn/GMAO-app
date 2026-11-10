// "Consomme plus que d'habitude" detection for diesel issues (engin_sortie_carburant).
// Pure functions, no database access, so the rules are easy to test and tune.
//
// For every engine the issues are read in chronological order. An issue is
// compared with the engine's OWN recent history (never with other engines):
//   - quantite : litres issued vs the median of the previous issues
//   - rythme   : litres per counter unit (km or hours) vs the median of the
//                previous rates. Full-tank method: the litres issued at a fill
//                cover the counter distance since the previous fill.
// An issue is flagged when it exceeds RATIO x the median. Not enough history
// = never flagged (a new engine does not raise false alarms).

const RATIO = Number(process.env.FUEL_ALERT_RATIO || 1.5);          // 1.5 = +50 %
const MIN_HISTORY = Number(process.env.FUEL_ALERT_MIN_HISTORY || 4); // previous issues needed
const WINDOW = 10;                                                   // previous issues used as baseline

function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const num = (x) => (x == null || x === '' ? NaN : Number(x));
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

// rows: issues of ONE engine sorted oldest -> newest. Returns the same rows
// with { taux, ecart_qte, ecart_taux, alertes[] } added.
function analyseEngine(rows, opts = {}) {
  const ratio = opts.ratio ?? RATIO;
  const minHistory = opts.minHistory ?? MIN_HISTORY;
  const out = [];
  const qtys = [];
  const rates = [];
  let prevCounter = null;

  for (const r of rows) {
    const q = num(r.quantite);
    const c = num(r.compteur);
    const item = { ...r, taux: null, ecart_qte: null, ecart_taux: null, alertes: [] };

    // litres per counter unit since the previous issue (needs a sane counter)
    if (Number.isFinite(q) && q > 0 && Number.isFinite(c) && c > 0 && prevCounter != null && c > prevCounter) {
      item.taux = round(q / (c - prevCounter), 4);
    }

    if (qtys.length >= minHistory) {
      const base = median(qtys.slice(-WINDOW));
      if (base > 0 && q > ratio * base) {
        item.alertes.push('quantite');
        item.ecart_qte = round((q / base - 1) * 100, 0);
      }
    }
    if (item.taux != null && rates.length >= 3) {
      const base = median(rates.slice(-WINDOW));
      if (base > 0 && item.taux > ratio * base) {
        item.alertes.push('rythme');
        item.ecart_taux = round((item.taux / base - 1) * 100, 0);
      }
    }

    if (Number.isFinite(q) && q > 0) qtys.push(q);
    if (item.taux != null) rates.push(item.taux);
    if (Number.isFinite(c) && c > 0) prevCounter = c;
    out.push(item);
  }
  return out;
}

// rows: issues of all engines (any order). Returns Map(id_engin -> analysed rows, oldest first).
function analyseAll(rows, opts) {
  const byEngin = new Map();
  for (const r of rows) {
    if (!byEngin.has(r.id_engin)) byEngin.set(r.id_engin, []);
    byEngin.get(r.id_engin).push(r);
  }
  const day = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
  const key = (r) => `${day(r.date)} ${String(r.heure || '').slice(0, 8)} ${String(r.id).padStart(12, '0')}`;
  const result = new Map();
  for (const [id, list] of byEngin) {
    list.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    result.set(id, analyseEngine(list, opts));
  }
  return result;
}

function describe(item) {
  const parts = [];
  if (item.alertes.includes('quantite')) parts.push(`${item.quantite} L (+${item.ecart_qte} % vs habituel)`);
  if (item.alertes.includes('rythme')) parts.push(`${item.taux} L/unité compteur (+${item.ecart_taux} %)`);
  return parts.join(' · ');
}

module.exports = { analyseEngine, analyseAll, describe, median, RATIO, MIN_HISTORY };
