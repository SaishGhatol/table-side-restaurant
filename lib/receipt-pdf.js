// One-page PDF receipt, written by hand so the app needs no packages.
// It uses PDF's built-in Courier fonts (always available, fixed character width so columns line up exactly).
// Those fonts only cover Latin-1, so the rupee sign is printed as "Rs." and other unsupported characters become "?".
'use strict';

const MAP = { '₹': 'Rs.', '·': '-', '—': '-', '–': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '•': '*', '×': 'x', '…': '...', '↳': '>' };
function latin1(s) {
  let out = '';
  for (const ch of String(s == null ? '' : s)) {
    if (MAP[ch] !== undefined) { out += MAP[ch]; continue; }
    const c = ch.codePointAt(0);
    out += c === 0x20ac ? '\x80' : c >= 32 && c < 256 ? ch : '?';
  }
  return out;
}
const esc = s => latin1(s).replace(/[\\()]/g, m => '\\' + m);
const money = (cur, n) => `${latin1(cur)}${/^[A-Za-z]+\.?$/.test(latin1(cur)) ? ' ' : ''}${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Break text into lines of at most `width` characters, splitting on spaces and chopping words that are too long.
function wrap(text, width) {
  const out = []; let line = '';
  for (let word of String(text).split(/\s+/).filter(Boolean)) {
    while (word.length > width) { if (line) { out.push(line); line = ''; } out.push(word.slice(0, width)); word = word.slice(width); }
    if (!line) line = word;
    else if ((line + ' ' + word).length <= width) line += ' ' + word;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/**
 * d = { restaurant, tagline, address, mapsUrl, currency, taxName, taxRate, table, id, date (Date), method,
 *       lines: [{ qty, name, size, total }], subtotal, tax, total, showShare, share, tip, paid, shareOnly }
 */
function buildReceiptPdf(d) {
  const W = 226, M = 14, SIZE = 8.5, LH = 11.5;      // an 80 mm "till roll" page; height grows with the content
  const cw = size => size * 0.6;                     // Courier advance width
  const cols = Math.floor((W - 2 * M) / cw(SIZE));
  const rows = [];                                   // { kind: 'text'|'rule'|'gap', ... }
  const text = (t, o = {}) => { const size = o.size || SIZE; rows.push({ kind: 'text', t: latin1(t), size, bold: !!o.bold, align: o.align || 'left', h: o.h || size + 3 }); };
  const center = (t, o = {}) => { const size = o.size || SIZE, c = Math.floor((W - 2 * M) / cw(size)); for (const l of wrap(t, c)) text(l, { ...o, align: 'center' }); };
  const gap = h => rows.push({ kind: 'gap', h });
  const rule = () => rows.push({ kind: 'rule', h: 8 });
  // left text and right-aligned amount on one line; bigger type fits fewer characters per line
  const pair = (l, r, o = {}) => {
    l = latin1(l); r = latin1(r);
    const c = Math.floor((W - 2 * M) / cw(o.size || SIZE)), room = c - r.length - 1;
    text((l.length > room ? l.slice(0, Math.max(0, room)) : l).padEnd(c - r.length) + r, o);
  };

  center(d.restaurant, { size: 13, bold: true, h: 17 });
  if (d.tagline) center(d.tagline, { size: 7.5 });
  if (d.address) center(d.address, { size: 7.5 });
  gap(6);
  pair('Receipt', '#' + d.id);
  pair('Table ' + d.table, new Date(d.date).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).replace(',', ''));
  rule();

  if (d.lines && d.lines.length) {
    for (const l of d.lines) {
      const amount = money(d.currency, l.total), room = cols - amount.length - 1;
      const label = `${l.qty} x ${String(l.name).replace(/^↳\s*/, '')}${l.size ? ' (' + l.size + ')' : ''}`;
      const parts = wrap(latin1(label), room);
      parts.forEach((p, i) => (i === 0 ? pair(p, amount) : text('  ' + p)));
    }
    rule();
  }
  if (d.subtotal != null) {
    pair('Subtotal', money(d.currency, d.subtotal));
    if (d.tax != null) pair(`${d.taxName || 'Tax'} (${Math.round((d.taxRate || 0) * 100)}%)`, money(d.currency, d.tax));
  }
  pair(d.shareOnly ? 'Your share of the bill' : 'Total', money(d.currency, d.total), { bold: true });
  if (d.showShare) pair('Your share', money(d.currency, d.share), { bold: true });
  if (d.tip) pair('Tip', money(d.currency, d.tip));
  rule();
  pair('PAID', money(d.currency, d.paid), { bold: true, size: 10.5 });
  text('Method: ' + d.method);
  gap(8);
  center('Thank you for dining with us!', { bold: true });
  center('We hope to see you again soon.', { size: 7.5 });
  if (d.address || d.mapsUrl) { gap(4); center('Find us: ' + (d.address || d.restaurant), { size: 7.5 }); }
  if (d.mapsUrl) center(d.mapsUrl, { size: 6.5 });

  // ----- lay the rows out on the page -----
  const H = Math.max(260, Math.ceil(rows.reduce((s, r) => s + r.h, 0) + 2 * M));
  let y = H - M, ops = '';
  for (const r of rows) {
    y -= r.h;
    if (r.kind === 'rule') ops += `0.5 w [2 2] 0 d ${M} ${(y + r.h / 2).toFixed(2)} m ${W - M} ${(y + r.h / 2).toFixed(2)} l S\n`;
    else if (r.kind === 'text') {
      const x = r.align === 'center' ? Math.max(M, (W - r.t.length * cw(r.size)) / 2) : M;
      ops += `BT /${r.bold ? 'F2' : 'F1'} ${r.size} Tf ${x.toFixed(2)} ${(y + 2).toFixed(2)} Td (${esc(r.t)}) Tj ET\n`;
    }
  }

  // ----- assemble the file: catalog, pages, page, content, two fonts, info -----
  const chunks = []; const offsets = []; let pos = 0;
  const put = s => { const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1'); chunks.push(b); pos += b.length; };
  const obj = (n, body) => { offsets[n] = pos; put(`${n} 0 obj\n`); put(body); put('\nendobj\n'); };
  put('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`);
  const stream = Buffer.from(ops, 'latin1');
  offsets[4] = pos; put('4 0 obj\n'); put(`<< /Length ${stream.length} >>\nstream\n`); put(stream); put('\nendstream\nendobj\n');
  obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
  obj(6, '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>');
  obj(7, `<< /Title (${esc('Receipt ' + d.id + ' - ' + d.restaurant)}) /Producer (Table-side restaurant app) >>`);
  const xref = pos;
  put(`xref\n0 8\n0000000000 65535 f \n`);
  for (let n = 1; n <= 7; n++) put(String(offsets[n]).padStart(10, '0') + ' 00000 n \n');
  put(`trailer\n<< /Size 8 /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

module.exports = { buildReceiptPdf };
