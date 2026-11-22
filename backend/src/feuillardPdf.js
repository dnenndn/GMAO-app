// Minimal PDF writer (no dependency): A4 pages, Helvetica text, lines, filled rectangles and JPEG photos.
// Used for the incoming-quality report of the strapping module.
const W = 595.28, H = 841.89, M = 40;

// WinAnsi (cp1252) bytes for a JS string; characters outside it become '?'
const CP1252 = { 'œ': 0x9c, 'Œ': 0x8c, '€': 0x80, '’': 0x92, '‘': 0x91, '“': 0x93, '”': 0x94, '–': 0x96, '—': 0x97, '…': 0x85, '•': 0x95 };
function pdfString(s) {
  const bytes = [];
  for (const ch of String(s == null ? '' : s)) {
    const c = ch.codePointAt(0);
    let b = c < 256 ? c : CP1252[ch];
    if (b == null) b = 0x3f;
    if (b === 0x28 || b === 0x29 || b === 0x5c) bytes.push(0x5c);
    if (b < 32) b = 32;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}
const num = (n) => (Math.round(n * 100) / 100).toString();

// width / height / components of a JPEG, or null when it is not a usable JPEG
function jpegInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (m !== 0xc0 && m !== 0xc1) return null;   // progressive JPEG: not supported by this tiny writer
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), n: buf[i + 9] };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

class Doc {
  constructor() { this.pages = []; this.images = []; this.addPage(); }
  addPage() { this.cur = { ops: [], imgs: [] }; this.pages.push(this.cur); this.y = H - M; }
  need(h) { if (this.y - h < M) this.addPage(); }
  text(x, y, s, size = 10, bold = false, gray = 0) {
    this.cur.ops.push(Buffer.concat([Buffer.from(`BT ${num(gray)} g /${bold ? 'F2' : 'F1'} ${size} Tf ${num(x)} ${num(y)} Td (`), pdfString(s), Buffer.from(') Tj ET\n')]));
  }
  rect(x, y, w, h, rgb) { this.cur.ops.push(Buffer.from(`${rgb.join(' ')} rg ${num(x)} ${num(y)} ${num(w)} ${num(h)} re f 0 g\n`)); }
  line(x1, y1, x2, y2, gray = 0.7) { this.cur.ops.push(Buffer.from(`${gray} G 0.5 w ${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S 0 G\n`)); }
  image(buf, x, y, w, h) {
    const info = jpegInfo(buf); if (!info) return false;
    this.images.push({ buf, info }); const idx = this.images.length;
    this.cur.imgs.push(idx);
    this.cur.ops.push(Buffer.from(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm /Im${idx} Do Q\n`));
    return true;
  }
  // text that wraps on a width (approximate Helvetica metrics); returns the number of lines
  wrap(s, size, width) {
    const max = Math.max(4, Math.floor(width / (size * 0.5)));
    const lines = []; let cur = '';
    for (const word of String(s == null ? '' : s).split(/\s+/)) {
      if (!word) continue;
      if ((cur + ' ' + word).trim().length > max) { if (cur) lines.push(cur); cur = word.length > max ? word.slice(0, max) : word; } else cur = (cur + ' ' + word).trim();
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }
  paragraph(s, x, size, width, bold = false) {
    for (const l of this.wrap(s, size, width)) { this.need(size + 3); this.text(x, this.y - size, l, size, bold); this.y -= size + 3; }
  }
  toBuffer() {
    const objs = [];                                            // Buffer per object (1-based ids)
    const add = (b) => { objs.push(Buffer.isBuffer(b) ? b : Buffer.from(b)); return objs.length; };
    const catalog = add(''); const pagesId = add(''); const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const imgIds = this.images.map(({ buf, info }) => add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${info.w} /Height ${info.h} /ColorSpace /${info.n === 1 ? 'DeviceGray' : info.n === 4 ? 'DeviceCMYK' : 'DeviceRGB'} /BitsPerComponent 8 ${info.n === 4 ? '/Decode [1 0 1 0 1 0 1 0] ' : ''}/Filter /DCTDecode /Length ${buf.length} >>\nstream\n`), buf, Buffer.from('\nendstream')])));
    const pageIds = this.pages.map((p) => {
      const content = Buffer.concat(p.ops);
      const cId = add(Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]));
      const xo = p.imgs.map((i) => `/Im${i} ${imgIds[i - 1]} 0 R`).join(' ');
      return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> /XObject << ${xo} >> >> /Contents ${cId} 0 R >>`);
    });
    objs[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    objs[pagesId - 1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
    const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]; const offs = []; let pos = parts[0].length;
    objs.forEach((o, i) => { offs.push(pos); const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]); parts.push(b); pos += b.length; });
    const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`), `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${pos}\n%%EOF\n`].join('');
    parts.push(Buffer.from(xref));
    return Buffer.concat(parts);
  }
}

const frDate = (d) => { const s = String(d || '').slice(0, 10).split('-'); return s.length === 3 ? `${s[2]}/${s[1]}/${s[0]}` : String(d || ''); };
const f = (n) => (n == null ? '' : String(Math.round(Number(n) * 100) / 100).replace('.', ','));

// data = { entree: {id,date,article,fournisseur,qt}, tol: {min_poids,...}, rows: [{date,controleur,epaisseur,largeur,poids,fissure,couleur,observation,ok,flags}], decision, photos: [Buffer], now }
function qualityReport(data) {
  const d = new Doc();
  const { entree, tol, rows } = data;
  d.text(M, d.y - 18, 'Rapport de contrôle qualité feuillard', 18, true); d.y -= 30;
  d.line(M, d.y, W - M, d.y, 0.3); d.y -= 14;
  const info = [['Entrée n°', entree.id], ['Date de l\'entrée', frDate(entree.date)], ['Article', entree.article], ['Fournisseur', entree.fournisseur || ''], ['Quantité reçue', f(entree.qt) + ' bobine(s)']];
  for (const [k, v] of info) { d.text(M, d.y - 10, k + ' :', 10, true); d.text(M + 110, d.y - 10, String(v), 10); d.y -= 15; }
  d.y -= 4;
  const T = (lo, hi, unit) => (lo == null && hi == null ? '–' : `${f(lo)} à ${f(hi)} ${unit}`);
  d.text(M, d.y - 10, 'Tolérances :', 10, true); d.text(M + 110, d.y - 10, `poids ${T(tol.min_poids, tol.max_poids, 'kg')} · épaisseur ${T(tol.min_epaisseur, tol.max_epaisseur, 'mm')} · largeur ${T(tol.min_largeur, tol.max_largeur, 'mm')}`, 9); d.y -= 22;

  const cols = [['N°', 24], ['Date', 56], ['Contrôleur', 62], ['Poids', 44], ['Épaisseur', 50], ['Largeur', 46], ['Fissure', 38], ['Couleur', 44], ['Observation', 151]];
  const head = () => {
    d.need(24); let x = M; d.rect(M, d.y - 16, W - 2 * M, 16, [0.9, 0.9, 0.93]);
    for (const [t, w] of cols) { d.text(x + 3, d.y - 12, t, 8.5, true); x += w; }
    d.y -= 16;
  };
  head();
  const nonOk = rows.filter((r) => !r.ok).length;
  rows.forEach((r, i) => {
    const obs = d.wrap(r.observation || '', 8, cols[8][1] - 6);
    const hgt = Math.max(15, obs.length * 10 + 5);
    if (d.y - hgt < M) { d.addPage(); head(); }
    let x = M;
    const bad = (k) => r.flags && r.flags[k] && r.flags[k] !== 'ok';
    const cells = [[String(i + 1), false], [frDate(r.date), false], [r.controleur || '', false], [f(r.poids), bad('poids')], [f(r.epaisseur), bad('epaisseur')], [f(r.largeur), bad('largeur')], [r.fissure || '', bad('fissure')], [r.couleur || '', bad('couleur')]];
    cells.forEach(([t, isBad], k) => {
      if (isBad) d.rect(x, d.y - hgt + 1, cols[k][1] - 1, hgt - 1, [1, 0.85, 0.85]);
      d.text(x + 3, d.y - 11, t, 8.5, isBad); x += cols[k][1];
    });
    obs.forEach((l, k) => d.text(x + 3, d.y - 11 - k * 10, l, 8));
    d.line(M, d.y - hgt, W - M, d.y - hgt, 0.85); d.y -= hgt;
  });
  if (!rows.length) { d.text(M + 3, d.y - 12, 'Aucune bobine mesurée.', 9); d.y -= 18; }
  d.y -= 8; d.need(30);
  d.text(M, d.y - 10, `${rows.length} bobine(s) mesurée(s) · ${nonOk} hors tolérance (cases rouges)`, 10, true); d.y -= 24;
  d.need(40); d.text(M, d.y - 11, 'Décision finale', 11, true); d.y -= 18;
  d.paragraph(data.decision || 'Aucune décision enregistrée.', M, 10, W - 2 * M);
  d.y -= 10;
  const photos = (data.photos || []).filter((b) => jpegInfo(b));
  if (photos.length) {
    d.need(30); d.text(M, d.y - 11, 'Photos', 11, true); d.y -= 20;
    const bw = (W - 2 * M - 12) / 2, bh = 190; let col = 0;
    for (const b of photos) {
      if (col === 0) d.need(bh + 10);
      const inf = jpegInfo(b); const sc = Math.min(bw / inf.w, bh / inf.h); const w = inf.w * sc, h = inf.h * sc;
      d.image(b, M + col * (bw + 12), d.y - h, w, h);
      if (col === 1) { d.y -= bh + 10; col = 0; } else col = 1;
    }
    if (col === 1) d.y -= bh + 10;
  }
  if (data.skipped > 0) { d.need(20); d.paragraph(`${data.skipped} photo(s) enregistrée(s) au bureau dans un format non repris dans ce rapport (JPEG de l'application uniquement).`, M, 8.5, W - 2 * M); }
  const pages = d.pages.length;
  d.pages.forEach((p, i) => { d.cur = p; d.text(M, 22, `Édité le ${frDate(data.now || new Date().toISOString())} · page ${i + 1}/${pages}`, 8, false, 0.4); });
  return d.toBuffer();
}

module.exports = { qualityReport, jpegInfo, pdfString };
