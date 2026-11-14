// Small helpers shared by the read-only / maintenance routes.
function parseDate(v) {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 ? d : null;
}
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const todayUtc = () => parseDate(iso(new Date()));

// ?from=&to= (YYYY-MM-DD). Defaults to the last `days` days. Max 400 days.
function period(req, days = 30) {
  const today = todayUtc();
  const to = req.query.to ? parseDate(req.query.to) : today;
  const from = req.query.from ? parseDate(req.query.from) : addDays(to || today, -days);
  if (!from || !to) return { error: 'Dates invalides (format AAAA-MM-JJ).' };
  if (from > to) return { error: 'La date de début est après la date de fin.' };
  if ((to - from) / 86400000 > 400) return { error: 'Période trop longue (400 jours maximum).' };
  return { from, to };
}

// Escapes % _ [ in user text used inside a LIKE.
const likeEscape = (s) => String(s).replace(/[\\%_\[]/g, (c) => '\\' + c);

function intParam(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

module.exports = { parseDate, iso, addDays, todayUtc, period, likeEscape, intParam };
