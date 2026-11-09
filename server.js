// Table-side restaurant app: customer ordering, kitchen display, floor map.
// Zero dependencies. Run: node server.js   (env: PORT, STAFF_PIN)
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { buildReceiptPdf } = require('./lib/receipt-pdf');

// Optional ".env" file next to server.js (one KEY=value per line, e.g. WHATSAPP_TOKEN=...). Real environment variables win.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no .env file: that's fine */ }

const PORT = Number(process.env.PORT) || 3000;
const PIN = String(process.env.STAFF_PIN || '1234');
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const STATE_FILE = path.join(ROOT, 'data', 'state.json');
const RECEIPT_DIR = path.join(ROOT, 'data', 'receipts');
const MENU = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'menu.json'), 'utf8'));
const ITEMS = Object.fromEntries(MENU.items.map(i => [i.id, i]));
const baseSize = def => def.sizes.find(x => x.add === 0) || def.sizes[0]; // the standard portion is the one with no surcharge
const R = MENU.rewards;
for (const i of MENU.items) { // dish photos (see public/credits.html); ?v= changes when a photo is replaced, so browsers never show a stale one
  try { i.img = `/img/${i.id}.jpg?v=${Math.floor(fs.statSync(path.join(PUBLIC, 'img', i.id + '.jpg')).mtimeMs / 1000)}`; } catch { /* no photo for this item */ }
}
// Guests are sent to the restaurant's own Google review form; the review itself is always written and posted by the guest.
const GOOGLE_REVIEW_URL = MENU.googlePlaceId ? `https://search.google.com/local/writereview?placeid=${encodeURIComponent(MENU.googlePlaceId)}` : '';

const round2 = n => Math.round(n * 100) / 100;
const uid = () => crypto.randomBytes(6).toString('hex');
const now = () => Date.now();

// ---------- integrations (all optional; without keys the app runs in demo mode) ----------
// Payments: Stripe Checkout (cards + Apple Pay + Google Pay on the hosted page).
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, PUBLIC_URL, CURRENCY_CODE (ISO, e.g. "pkr"; or menu.json currencyCode)
// Receipts + thank-you on WhatsApp: WhatsApp Business Cloud API (Meta).
//   WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_TEMPLATE (default "visit_thanks"), WHATSAPP_LANG (default "en")
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_API = process.env.STRIPE_API_BASE || 'https://api.stripe.com/v1';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const CURRENCY_CODE = String(process.env.CURRENCY_CODE || MENU.currencyCode || '').toLowerCase();
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
const WA_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';
const WA_TEMPLATE = process.env.WHATSAPP_TEMPLATE || 'visit_thanks';
const WA_LANG = process.env.WHATSAPP_LANG || 'en';
const WA_API = (process.env.WHATSAPP_API_BASE || 'https://graph.facebook.com/v20.0').replace(/\/$/, '');
const WA_ON = !!(WA_TOKEN && WA_PHONE_ID);
// Attach the PDF receipt to the WhatsApp message. The template then needs a DOCUMENT header (see README).
const WA_PDF = /^(1|true|yes|on)$/i.test(process.env.WHATSAPP_ATTACH_PDF || '');
const PHONE_CC = String(MENU.phoneCountryCode || '91').replace(/\D/g, '');
// Where guests are sent when they share the restaurant with friends and family.
const MAPS_URL = MENU.mapsUrl || ((MENU.address || MENU.googlePlaceId)
  ? 'https://www.google.com/maps/search/?' + new URLSearchParams(Object.assign({ api: '1', query: MENU.address || MENU.restaurant }, MENU.googlePlaceId ? { query_place_id: MENU.googlePlaceId } : {})).toString()
  : '');
const ONLINE = !!(STRIPE_KEY && CURRENCY_CODE);
const AWAITING_MAX_MS = 32 * 60 * 1000; // Stripe Checkout sessions are created with a 31 min expiry

const toMinor = amt => Math.round(amt * (ZERO_DECIMAL.has(CURRENCY_CODE) ? 1 : 100));

async function stripe(method, p, params) {
  const r = await fetch(STRIPE_API + p, { method, headers: { Authorization: 'Bearer ' + STRIPE_KEY, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params ? new URLSearchParams(params) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Payment provider error');
  return j;
}

// Stripe-Signature: "t=<unix>,v1=<hmac>[,v1=<hmac>]"; hmac = HMAC-SHA256(secret, `${t}.${rawBody}`)
function verifyStripeSignature(raw, header) {
  if (!STRIPE_WEBHOOK_SECRET || !header) return false;
  const parts = String(header).split(',').map(s => s.split('='));
  const t = (parts.find(p => p[0] === 't') || [])[1];
  const sigs = parts.filter(p => p[0] === 'v1').map(p => p[1]);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex');
  return sigs.some(s => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

// "98765 43210", "09876543210", "+91 98765 43210" -> "919876543210" (digits only, with country code), or null if it can't be a phone number.
function normalizePhone(raw) {
  const plus = /^\s*(\+|00)/.test(String(raw || ''));
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (plus) d = d.replace(/^00/, '');
  else { d = d.replace(/^0+/, ''); if (d.length <= 11) d = PHONE_CC + d; } // a local number: add the restaurant's country code
  return /^[1-9]\d{9,14}$/.test(d) ? d : null;
}
const maskPhone = d => `+${d.slice(0, 2)} ${'•'.repeat(Math.max(0, d.length - 5))}${d.slice(-3)}`;
// Template variables may not contain new lines, tabs or runs of 4+ spaces.
const waText = x => String(x == null ? '' : x).replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, 900);
const METHOD_NAME = { card: 'card', applepay: 'Apple Pay', googlepay: 'Google Pay', online: 'card or wallet', bank: 'bank transfer', cash: 'cash' };
function receiptOneLine(p) {
  const c = MENU.currency, total = p.amount + p.tip;
  const what = (p.items || []).length ? p.items.map(i => `${i.qty} x ${i.name}${i.size ? ' (' + i.size + ')' : ''}`).join(', ') : `your share of the table bill`;
  return `Table ${p.table}: ${what}. Paid ${c}${total.toFixed(2)} by ${METHOD_NAME[p.method] || p.method}${p.tip ? ` (including ${c}${p.tip.toFixed(2)} tip)` : ''}.`;
}

// Sends the receipt and a thank-you (with the restaurant's location to share) to the number the guest gave, once.
// The template must be approved in WhatsApp Manager; see the README for the exact text. The number is not kept afterwards.
async function sendWhatsApp(p) {
  const phone = p.phone; p.phone = null;
  if (!phone) { p.waStatus = 'none'; return; }
  if (!WA_ON) { p.waStatus = 'not-configured'; return; }
  try {
    const params = [p.waName || 'there', MENU.restaurant, receiptOneLine(p), MAPS_URL || MENU.restaurant].map(t => ({ type: 'text', text: waText(t) || '-' }));
    const components = [{ type: 'body', parameters: params }];
    if (WA_PDF) { // upload the PDF to WhatsApp, then reference it in the template's document header
      const form = new FormData();
      form.append('messaging_product', 'whatsapp'); form.append('type', 'application/pdf');
      form.append('file', new Blob([receiptPdf(p)], { type: 'application/pdf' }), `Receipt-${p.id.slice(0, 6).toUpperCase()}.pdf`);
      const up = await fetch(`${WA_API}/${encodeURIComponent(WA_PHONE_ID)}/media`, { method: 'POST', headers: { Authorization: 'Bearer ' + WA_TOKEN }, body: form });
      const uj = await up.json().catch(() => ({}));
      if (!up.ok || !uj.id) throw new Error('PDF upload failed (' + up.status + ') ' + JSON.stringify(uj).slice(0, 200));
      components.unshift({ type: 'header', parameters: [{ type: 'document', document: { id: uj.id, filename: `Receipt-${p.id.slice(0, 6).toUpperCase()}.pdf` } }] });
    }
    const r = await fetch(`${WA_API}/${encodeURIComponent(WA_PHONE_ID)}/messages`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'template', template: { name: WA_TEMPLATE, language: { code: WA_LANG }, components } }),
    });
    p.waStatus = r.ok ? 'sent' : 'failed';
    if (!r.ok) console.error('WhatsApp error', r.status, (await r.text().catch(() => '')).slice(0, 300));
  } catch (e) { p.waStatus = 'failed'; console.error('WhatsApp error', e.message); }
  save();
}

// What goes on the PDF receipt. A guest who paid for chosen items sees exactly those items; everyone else sees the whole table bill
// (snapshotted when they paid) plus their own share.
function receiptData(p) {
  const base = { restaurant: MENU.restaurant, tagline: MENU.tagline || '', address: MENU.address || '', mapsUrl: MAPS_URL, currency: MENU.currency, taxName: MENU.taxName || 'Tax', taxRate: MENU.taxRate,
    table: p.table, id: p.id.slice(0, 6).toUpperCase(), date: p.confirmedAt || p.createdAt, method: METHOD_NAME[p.method] || p.method, tip: p.tip, paid: round2(p.amount + p.tip), share: p.amount };
  if (p.mode === 'items' && (p.items || []).length) {
    return Object.assign(base, { lines: p.items.map(i => ({ qty: i.qty, name: i.name, size: i.size, total: i.total })), subtotal: round2(p.items.reduce((a, i) => a + i.total, 0)), tax: p.tax, total: p.amount, showShare: false });
  }
  if (p.bill) return Object.assign(base, { lines: p.bill.lines, subtotal: p.bill.subtotal, tax: p.bill.tax, total: p.bill.total, showShare: Math.abs(p.amount - p.bill.total) > 0.004 });
  return Object.assign(base, { lines: [], subtotal: null, tax: null, total: p.amount, showShare: false, shareOnly: true });
}
const receiptPdf = p => buildReceiptPdf(receiptData(p));

// ---------- state ----------
let S = { seq: 1, tables: {}, orders: [], payments: [], reviews: [], customers: {}, games: [] };
try { S = Object.assign(S, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch { /* fresh start */ }
for (let i = 1; i <= MENU.tables; i++) {
  // open = timestamp while guests are seated; members = device ids a waiter approved this sitting;
  // requests = devices waiting for approval; declined = device id -> time, so a declined phone can't spam the waiter
  S.tables[i] = Object.assign({ id: i, help: null, session: 1, open: null, members: [], requests: [], declined: {} }, S.tables[i]);
  delete S.tables[i].code; // older saves used a join code
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFile(STATE_FILE, JSON.stringify(S), () => {});
  }, 300);
}

// ---------- live updates (SSE) ----------
const clients = new Set();
function broadcast(type, extra) {
  const msg = `data: ${JSON.stringify(Object.assign({ t: type }, extra))}\n\n`;
  for (const c of clients) c.write(msg);
  save();
}

// ---------- helpers ----------
class HttpError extends Error { constructor(code, msg, reason) { super(msg); this.code = code; this.reason = reason; } }
const fail = (code, msg, reason) => { throw new HttpError(code, msg, reason); };

const tableOf = n => S.tables[Number(n)] || fail(404, 'Unknown table');
const activeOrders = t => S.orders.filter(o => o.table === t.id && o.session === t.session && o.status !== 'cancelled');
const validCid = cid => typeof cid === 'string' && /^[a-z0-9]{8,40}$/i.test(cid);
const customer = cid => {
  if (!validCid(cid)) return null;
  return (S.customers[cid] = S.customers[cid] || { id: cid, name: '', points: 0 });
};

// ---------- table access: guests scan the table QR, a waiter approves ----------
// Scanning only sends a join request. Ordering, calling for service, games and paying all need the guest's device to have been
// approved for the *current* sitting, so a saved or screenshotted QR can't be used from home: a waiter would simply decline it.
// Paying the bill (or staff closing the table) ends the sitting and revokes every approval.
const DENY_MS = 60 * 1000, REQUEST_TTL_MS = 20 * 60 * 1000;
const isMember = (t, cid) => !!(t.open && validCid(cid) && t.members.includes(cid));
const joinState = (t, cid) => isMember(t, cid) ? 'member'
  : validCid(cid) && t.requests.some(r => r.cid === cid) ? 'pending'
  : validCid(cid) && t.declined[cid] && now() - t.declined[cid] < DENY_MS ? 'denied' : 'none';
function requireMember(t, cid) {
  if (isMember(t, cid)) return;
  const st = joinState(t, cid);
  if (st === 'pending') fail(403, 'Your waiter has not approved your table yet. They have been notified.', 'waiting');
  if (st === 'denied') fail(403, 'Your waiter could not confirm this table. Please ask them in person.', 'denied');
  fail(403, 'Ask your waiter to approve your table first.', 'closed');
}
function approveRequest(t, r) {
  if (!t.members.includes(r.cid) && t.members.length >= 30) fail(409, 'Too many devices at this table.');
  t.open = t.open || now();
  if (!t.members.includes(r.cid)) t.members.push(r.cid);
  t.requests = t.requests.filter(x => x.rid !== r.rid);
}
function declineRequest(t, r) { t.declined[r.cid] = now(); t.requests = t.requests.filter(x => x.rid !== r.rid); }
function endSitting(t) { t.session += 1; t.help = null; t.open = null; t.members = []; t.requests = []; t.declined = {}; }
// Requests nobody answered go away on their own.
setInterval(() => {
  let changed = false;
  for (const t of Object.values(S.tables)) {
    const keep = t.requests.filter(r => now() - r.at < REQUEST_TTL_MS);
    if (keep.length !== t.requests.length) { t.requests = keep; changed = true; }
    for (const [cid, at] of Object.entries(t.declined)) if (now() - at > DENY_MS) delete t.declined[cid];
  }
  if (changed) broadcast('seat');
}, 60000).unref();

// Per-IP rate limits. Behind a reverse proxy set TRUST_PROXY=1 so the real client IP is used.
const ipOf = req => (process.env.TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || '?';
const buckets = new Map();
// Guests on one restaurant Wi-Fi may share a single public IP, so limits that must not punish the whole room are keyed by device/table instead.
function limit(req, name, max, windowMs, msg, who) {
  const key = name + '|' + (who || ipOf(req)), t = now();
  let b = buckets.get(key);
  if (!b || t - b.start > windowMs) { b = { start: t, n: 0 }; buckets.set(key, b); }
  if (++b.n > max) fail(429, msg || 'Too many requests — please slow down.', 'rate');
}
setInterval(() => { const t = now(); for (const [k, b] of buckets) if (t - b.start > 3600e3) buckets.delete(k); }, 600e3).unref();
const addPoints = (cid, n) => { const c = customer(cid); if (c && n > 0) c.points += Math.floor(n); };

function billOf(t) {
  const lines = [];
  for (const o of activeOrders(t)) o.lines.forEach((l, idx) => {
    if (l.price > 0 || l.paid) lines.push({ key: `${o.id}.${idx}`, name: l.name, size: l.size, qty: l.qty, price: l.price, paid: !!l.paid });
  });
  const subtotal = round2(activeOrders(t).reduce((s, o) => s + o.lines.reduce((a, l) => a + l.price * l.qty, 0), 0));
  const tax = round2(subtotal * MENU.taxRate);
  const total = round2(subtotal + tax);
  const pays = S.payments.filter(p => p.table === t.id && p.session === t.session && p.status !== 'rejected');
  const paid = round2(pays.reduce((s, p) => s + p.amount, 0));
  const pendingConfirm = pays.filter(p => p.status === 'pending');
  const awaiting = pays.filter(p => p.status === 'awaiting'); // customer is on the Stripe page
  return { lines, subtotal, tax, total, paid, balance: round2(total - paid), pending: pendingConfirm, awaiting };
}

function tableStatus(t) {
  const os_ = activeOrders(t);
  if (!os_.length) return t.open ? 'seated' : t.requests.length ? 'request' : 'free';
  if (os_.some(o => o.status === 'pending')) return 'new';
  if (os_.some(o => o.status === 'ready')) return 'ready';
  if (os_.some(o => o.status === 'sent')) return 'cooking';
  return 'dining';
}

function orderPublic(o) {
  return { id: o.id, no: o.no, status: o.status, createdAt: o.createdAt, sentAt: o.sentAt, readyAt: o.readyAt, by: o.by, lines: o.lines.map(l => ({ name: l.name, size: l.size, qty: l.qty, price: l.price, notes: l.notes, status: l.status, station: l.station, reward: l.reward })) };
}

function maybeCloseTable(t) {
  const b = billOf(t);
  if (activeOrders(t).length && b.balance <= 0.004 && !b.pending.length && !b.awaiting.length) {
    S.orders.forEach(o => { if (o.table === t.id && o.session === t.session && o.status === 'ready') o.status = 'served'; });
    endSitting(t);
  }
}

function confirmPayment(p) {
  if (p.status === 'confirmed' || p.status === 'rejected') return; // idempotent: webhook + redirect can both arrive
  p.status = 'confirmed'; p.confirmedAt = now();
  addPoints(p.cid, p.amount * R.perCurrencyUnit);
  p.receipt = receiptText(p);
  try { // local copy of every receipt for the restaurant's records
    fs.mkdirSync(RECEIPT_DIR, { recursive: true });
    fs.writeFileSync(path.join(RECEIPT_DIR, `${p.id}.txt`), (p.waMasked ? `WhatsApp: ${p.waMasked}\n` : '') + p.receipt);
    fs.writeFileSync(path.join(RECEIPT_DIR, `${p.id}.pdf`), receiptPdf(p));
  } catch (e) { console.error('Could not save receipt copy:', e.message); }
  sendWhatsApp(p); // async, never blocks the payment
  maybeCloseTable(S.tables[p.table]);
}

// Release a payment that will not complete: un-flag its items so they can be paid again.
function rejectPayment(p) {
  if (p.status === 'confirmed' || p.status === 'rejected') return;
  p.status = 'rejected'; p.phone = null; // no payment, no message: forget the number
  for (const i of p.items || []) {
    const [oid, idx] = i.key.split('.'); const o = S.orders.find(x => x.id === oid);
    if (o && o.lines[Number(idx)]) delete o.lines[Number(idx)].paid;
  }
}

// Ask Stripe directly whether a Checkout Session was paid (never trust the browser's redirect alone).
async function syncStripePayment(p) {
  if (p.status !== 'awaiting' || !p.stripeSession) return;
  const s = await stripe('GET', '/checkout/sessions/' + encodeURIComponent(p.stripeSession));
  const expected = toMinor(p.amount + p.tip);
  if (s.payment_status === 'paid' && s.amount_total === expected && String(s.currency).toLowerCase() === CURRENCY_CODE && (s.metadata || {}).paymentId === p.id) {
    p.status = 'pending'; confirmPayment(p);
  } else if (s.status === 'expired') rejectPayment(p);
}

function receiptText(p) {
  const c = MENU.currency, w = 34, line = '-'.repeat(w);
  const row = (a, b) => a + ' '.repeat(Math.max(1, w - a.length - b.length)) + b;
  const out = [MENU.restaurant, `Table ${p.table}  ·  ${new Date(p.createdAt).toLocaleString()}`, line];
  (p.items || []).forEach(i => out.push(row(`${i.qty}x ${i.name}${i.size ? ' (' + i.size + ')' : ''}`, `${c} ${i.total.toFixed(2)}`)));
  if (p.mode !== 'items') out.push(row(`Share of bill (${p.mode})`, `${c} ${p.amount.toFixed(2)}`));
  else out.push(row('Incl. tax', `${c} ${p.tax.toFixed(2)}`));
  out.push(row('Tip', `${c} ${p.tip.toFixed(2)}`), line, row('PAID', `${c} ${(p.amount + p.tip).toFixed(2)}`), `Method: ${p.method}`, '', 'Thank you for dining with us!');
  return out.join('\n');
}

// ---------- two-player games: noughts & crosses, connect four, rock-paper-scissors ----------
const GAME_TYPES = { ttt: 'Noughts & crosses', c4: 'Connect four', rps: 'Rock, paper, scissors' };
const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
function tttWinner(b) {
  for (const [a, c, d] of LINES) if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a];
  return b.every(Boolean) ? 'draw' : null;
}
// Connect four: 7 columns x 6 rows, index = row * 7 + col, row 0 is the top.
function c4Drop(board, col, side) {
  for (let row = 5; row >= 0; row--) if (!board[row * 7 + col]) { board[row * 7 + col] = side; return row; }
  return -1;
}
function c4Winner(board, row, col) {
  const side = board[row * 7 + col];
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    let n = 1;
    for (const sign of [1, -1]) for (let k = 1; k < 4; k++) {
      const r = row + dr * k * sign, c = col + dc * k * sign;
      if (r < 0 || r > 5 || c < 0 || c > 6 || board[r * 7 + c] !== side) break;
      n++;
    }
    if (n >= 4) return side;
  }
  return board.every(Boolean) ? 'draw' : null;
}
const RPS_BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
const RPS_TARGET = 2; // first to two round wins
const otherSide = side => (side === 'x' ? 'o' : 'x');

function newGameState(type) {
  if (type === 'ttt') return { board: Array(9).fill(''), turn: 'x' };
  if (type === 'c4') return { board: Array(42).fill(''), turn: 'x' };
  return { board: null, turn: null, rps: { choices: {}, rounds: [], score: { x: 0, o: 0 } } };
}
// Never expose device ids (they double as the guest's table credential); tell each viewer which side they are instead.
// A rock-paper-scissors choice stays hidden until both players have chosen.
function gamePublic(g, viewer) {
  const me = viewer && g.x.cid === viewer ? 'x' : viewer && g.o && g.o.cid === viewer ? 'o' : null;
  const out = { id: g.id, type: g.type || 'ttt', label: GAME_TYPES[g.type || 'ttt'], x: { table: g.x.table, name: g.x.name }, o: g.o && { table: g.o.table, name: g.o.name }, board: g.board, turn: g.turn, winner: g.winner, forfeit: !!g.forfeit, updated: g.updated, me };
  if (g.rps) out.rps = { target: RPS_TARGET, score: g.rps.score, rounds: g.rps.rounds, mine: me ? g.rps.choices[me] || null : null, opponentChosen: me ? !!g.rps.choices[otherSide(me)] : false };
  return out;
}
// Rewards for a genuine win; capped so two phones cannot farm free rewards.
function awardWin(g) {
  if (!g.winner || g.winner === 'draw' || g.forfeit) return;
  const wc = customer(g.winner === 'x' ? g.x.cid : g.o.cid), day = new Date().toDateString();
  if (wc) { wc.gw = wc.gw && wc.gw.day === day ? wc.gw : { day, n: 0 }; if (wc.gw.n < 3) { wc.gw.n++; wc.points += R.gameWin; } }
}

// ---------- floor plan layout (data/layout.json, edited from the floor map's "Edit layout") ----------
// Coordinates are in plan units on a W x H stage; each table is positioned by its centre.
const LAYOUT_FILE = path.join(ROOT, 'data', 'layout.json');
const SHAPES = ['round', 'square', 'rect'];
function defaultLayout(n) {
  const W = 1000; let H = 640;
  const slots = [ // [x, y, shape, seats]
    [90, 185, 'square', 2], [90, 335, 'square', 2], [90, 485, 'square', 2],          // window side
    [320, 195, 'round', 4], [490, 195, 'round', 4], [660, 195, 'round', 4],          // main hall
    [320, 345, 'square', 4], [490, 345, 'square', 4], [660, 345, 'square', 4],
    [490, 510, 'rect', 8],
    [880, 195, 'round', 4], [880, 410, 'round', 4],                                  // patio
  ];
  const zones = [
    { name: 'Window side', x: 20, y: 90, w: 190, h: 500 },
    { name: 'Main hall', x: 230, y: 90, w: 520, h: 500 },
    { name: 'Patio', x: 770, y: 90, w: 210, h: 500, kind: 'patio' },
  ];
  const tables = {};
  for (let i = 1; i <= n; i++) {
    if (slots[i - 1]) { const [x, y, shape, seats] = slots[i - 1]; tables[i] = { x, y, shape, seats }; continue; }
    const k = i - 13; // overflow tables go in rows below the main plan
    tables[i] = { x: 150 + (k % 5) * 170, y: 700 + Math.floor(k / 5) * 140, shape: 'round', seats: 4 };
    H = Math.max(H, 700 + Math.floor(k / 5) * 140 + 90);
  }
  if (n > 12) zones.push({ name: 'Extra seating', x: 20, y: 640, w: 960, h: H - 650 });
  return {
    W, H, zones, tables,
    fixtures: [
      { type: 'kitchen', label: 'Kitchen', x: 20, y: 20, w: 300, h: 56 },
      { type: 'bar', label: 'Bar', x: 340, y: 20, w: 360, h: 56 },
      { type: 'wc', label: 'Restrooms', x: 780, y: 20, w: 200, h: 56 },
      { type: 'door', label: 'Entrance', x: 440, y: 606, w: 120, h: 28 },
    ],
  };
}
let LAYOUT;
try { LAYOUT = JSON.parse(fs.readFileSync(LAYOUT_FILE, 'utf8')); } catch { LAYOUT = defaultLayout(MENU.tables); }
(function ensureAllTables() { // tables added to menu.json later get a default spot
  const d = defaultLayout(MENU.tables);
  for (let i = 1; i <= MENU.tables; i++) if (!LAYOUT.tables[i]) LAYOUT.tables[i] = d.tables[i];
  for (const k of Object.keys(LAYOUT.tables)) if (Number(k) > MENU.tables) delete LAYOUT.tables[k];
  LAYOUT.H = Math.max(LAYOUT.H || 640, d.H);
})();
function saveLayout() {
  fs.mkdirSync(path.dirname(LAYOUT_FILE), { recursive: true });
  fs.writeFile(LAYOUT_FILE, JSON.stringify(LAYOUT, null, 1), () => {});
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler, staff = false) => routes.push({ method, re: new RegExp('^' + pattern + '$'), handler, staff });

route('GET', '/api/menu', () => ({ restaurant: MENU.restaurant, tagline: MENU.tagline || '', currency: MENU.currency, locale: MENU.locale || 'en-IN', taxName: MENU.taxName || 'Tax', googleReviewUrl: GOOGLE_REVIEW_URL, taxRate: MENU.taxRate, categories: MENU.categories, items: MENU.items, rewards: R, tables: MENU.tables, onlinePayments: ONLINE, whatsappReceipts: WA_ON, whatsappPdf: WA_ON && WA_PDF, address: MENU.address || '', mapsUrl: MAPS_URL, phoneCountryCode: PHONE_CC }));

route('GET', '/api/layout', () => LAYOUT, true);
route('POST', '/api/layout', (req, m, q, body) => {
  if (body.reset) LAYOUT = defaultLayout(MENU.tables);
  const num = (v, lo, hi) => Math.round(Math.min(hi, Math.max(lo, Number(v))));
  for (const [id, patch] of Object.entries(body.tables || {})) {
    const cur = LAYOUT.tables[id]; if (!cur || typeof patch !== 'object') continue;
    if (patch.x != null && isFinite(patch.x)) cur.x = num(patch.x, 0, LAYOUT.W);
    if (patch.y != null && isFinite(patch.y)) cur.y = num(patch.y, 0, LAYOUT.H);
    if (SHAPES.includes(patch.shape)) cur.shape = patch.shape;
    if (patch.seats != null && isFinite(patch.seats)) cur.seats = num(patch.seats, 1, 12);
  }
  saveLayout(); broadcast('layout');
  return LAYOUT;
}, true);

route('GET', '/api/info', (req) => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => `http://${i.address}:${PORT}`);
  return { lan: ips, tables: MENU.tables };
});

// Guests only see a table's orders and bill once a waiter has approved their device.
route('GET', '/api/table/(\\d+)', (req, m, q) => {
  const t = tableOf(m[1]);
  const cid = q.get('cid');
  const c = validCid(cid) ? S.customers[cid] : null; // read-only: don't create records on GET
  const mine = validCid(cid) ? S.payments.filter(p => p.cid === cid).slice(-10).map(p => ({ id: p.id, status: p.status, amount: p.amount, tip: p.tip, method: p.method, table: p.table, session: p.session })) : [];
  const base = { table: t.id, open: !!t.open, joined: isMember(t, cid), joinState: joinState(t, cid), me: c && { name: c.name, points: c.points }, myPayments: mine };
  if (!base.joined) return Object.assign(base, { requests: [], orders: [], bill: { lines: [], subtotal: 0, tax: 0, total: 0, paid: 0, balance: 0, pending: [], awaiting: [] }, status: t.open ? 'seated' : 'free', help: null });
  // other devices waiting to join this table (so a guest can wave a friend in without calling the waiter)
  const requests = t.requests.map(r => ({ rid: r.rid, name: r.name, at: r.at }));
  return Object.assign(base, { requests, wifi: MENU.wifi, help: t.help, status: tableStatus(t), session: t.session, orders: activeOrders(t).map(orderPublic), bill: billOf(t) });
});

// Guest scanned the table QR: ask the waiter to let this phone in.
route('POST', '/api/table/(\\d+)/request', (req, m, q, body) => {
  const t = tableOf(m[1]);
  if (!validCid(body.cid)) fail(400, 'Bad device id');
  if (isMember(t, body.cid)) return { state: 'member' };
  const name = String(body.name || '').trim().slice(0, 30);
  const mineReq = t.requests.find(x => x.cid === body.cid);
  if (mineReq) { // already waiting: only refresh the name, or ring again if they've waited a while
    if (name) mineReq.name = name;
    if (body.again && now() - mineReq.at > 30000) { mineReq.at = now(); broadcast('join', { table: t.id }); } else broadcast('seat', { table: t.id });
    return { state: 'pending' };
  }
  const d = t.declined[body.cid];
  if (d && now() - d < DENY_MS) fail(429, 'Your waiter could not confirm this table. Try again in a minute, or ask them in person.', 'denied');
  limit(req, 'joinreq', 8, 10 * 60000, 'Too many requests from this network. Please ask your waiter.', `${ipOf(req)}:${t.id}`);
  limit(req, 'joinreq-cid', 5, 10 * 60000, 'Please wait a moment before asking again.', body.cid);
  if (t.requests.length >= 12) t.requests.shift();
  t.requests.push({ rid: uid(), cid: body.cid, name, at: now() });
  delete t.declined[body.cid];
  broadcast('join', { table: t.id });
  return { state: 'pending' };
});

// A guest who is already in can wave their own friends in (or turn them away).
route('POST', '/api/table/(\\d+)/approve-guest', (req, m, q, body) => {
  const t = tableOf(m[1]);
  if (!isMember(t, body.cid)) fail(403, 'Only people already at this table can do that.', 'closed');
  const r = t.requests.find(x => x.rid === body.rid) || fail(404, 'That request is gone.');
  if (body.deny) declineRequest(t, r); else approveRequest(t, r);
  broadcast('seat', { table: t.id });
  return { ok: true };
});

route('POST', '/api/me', (req, m, q, body) => {
  limit(req, 'me', 30, 60000, null, String(body.cid || ''));
  const c = customer(body.cid) || fail(400, 'cid required');
  if (body.name != null) c.name = String(body.name).slice(0, 30);
  return { name: c.name, points: c.points };
});

route('POST', '/api/order', (req, m, q, body) => {
  const t = tableOf(body.table);
  requireMember(t, body.cid);
  limit(req, 'order', 6, 300000, 'You are ordering very fast — please wait a moment.', body.cid); // per device
  limit(req, 'order-ip', 80, 300000, 'Too many orders from this network — please ask your waiter.');
  if (activeOrders(t).filter(o => o.status === 'pending').length >= 8) fail(429, 'Several orders are waiting for your waiter already — please wait for them to be sent.', 'rate');
  const c = customer(body.cid);
  if (!Array.isArray(body.items) || !body.items.length) fail(400, 'Cart is empty');
  const lines = [];
  for (const it of body.items.slice(0, 40)) {
    const def = ITEMS[it.id] || fail(400, 'Unknown item');
    const qty = Math.min(20, Math.max(1, Math.floor(Number(it.qty) || 1)));
    let price = def.price, size = null;
    if (def.sizes) {
      const s = def.sizes.find(x => x.name === it.size) || baseSize(def);
      size = s.name; price += s.add;
    }
    const notes = String(it.notes || '').slice(0, 140);
    if (it.reward) {
      if (!c || c.points < R.redeemAt) fail(400, 'Not enough points');
      if (it.id !== R.redeemItem) fail(400, 'Not a reward item');
      c.points -= R.redeemAt;
      lines.push({ name: def.name + ' (reward)', size, qty: 1, price: 0, notes, station: def.station, status: 'new', reward: true });
      continue;
    }
    if (def.includes) {
      lines.push({ name: def.name, size: null, qty, price, notes, station: null, status: 'ready', deal: true });
      for (const sub of def.includes) {
        const sd = ITEMS[sub];
        lines.push({ name: '↳ ' + sd.name, size: sd.sizes ? baseSize(sd).name : null, qty, price: 0, notes: '', station: sd.station, status: 'new' });
      }
    } else {
      lines.push({ name: def.name, size, qty, price, notes, station: def.station, status: 'new' });
    }
  }
  const o = { id: uid(), no: S.seq++, table: t.id, session: t.session, status: 'pending', createdAt: now(), by: (c && c.name) || '', cid: c && c.id, lines };
  S.orders.push(o);
  if (c) c.points += R.perOrder;
  broadcast('order', { table: t.id, new: true });
  return orderPublic(o);
});

route('POST', '/api/order/([a-f0-9]+)/cancel', (req, m, q, body, isStaff) => {
  const o = S.orders.find(x => x.id === m[1]) || fail(404, 'No such order');
  if (!isStaff && (!validCid(body.cid) || o.cid !== body.cid)) fail(403, 'That is not your order');
  if (!isStaff && o.status !== 'pending') fail(409, 'Order already sent to the kitchen — ask your waiter');
  if (o.status === 'served' || o.status === 'cancelled') fail(409, 'Cannot cancel');
  o.status = 'cancelled';
  broadcast('order', { table: o.table });
  return { ok: true };
});

route('POST', '/api/call', (req, m, q, body) => {
  const t = tableOf(body.table);
  requireMember(t, body.cid);
  const reason = String(body.reason || 'Assistance').slice(0, 40);
  if (!t.help) t.help = { reason, at: now() };
  broadcast('help', { table: t.id, reason });
  return { ok: true, help: t.help };
});

// staff
route('GET', '/api/floor', () => {
  const tables = Object.values(S.tables).map(t => {
    const b = billOf(t);
    return { id: t.id, open: !!t.open, devices: t.members.length, requests: t.requests.map(r => ({ rid: r.rid, name: r.name, at: r.at })), help: t.help, status: tableStatus(t), orders: activeOrders(t).map(orderPublic), bill: { total: b.total, paid: b.paid, balance: b.balance, pending: b.pending.map(p => ({ id: p.id, amount: p.amount, tip: p.tip, method: p.method })) } };
  });
  const rev = S.payments.filter(p => p.status === 'confirmed' && new Date(p.createdAt).toDateString() === new Date().toDateString());
  return { tables, today: { revenue: round2(rev.reduce((s, p) => s + p.amount + p.tip, 0)), tips: round2(rev.reduce((s, p) => s + p.tip, 0)), orders: S.orders.filter(o => new Date(o.createdAt).toDateString() === new Date().toDateString() && o.status !== 'cancelled').length }, reviews: S.reviews.slice(-5).reverse() };
}, true);

// Staff: approve or decline join requests (one tap approves everyone waiting), remove all devices, or close the table.
route('POST', '/api/table/(\\d+)/approve', (req, m, q, body) => {
  const t = tableOf(m[1]);
  const list = body.rid ? t.requests.filter(r => r.rid === body.rid) : [...t.requests];
  if (!list.length) fail(404, 'No request to approve (the guest may have left).');
  for (const r of list) approveRequest(t, r);
  broadcast('seat', { table: t.id });
  return { approved: list.length, devices: t.members.length };
}, true);

route('POST', '/api/table/(\\d+)/decline', (req, m, q, body) => {
  const t = tableOf(m[1]);
  const list = body.rid ? t.requests.filter(r => r.rid === body.rid) : [...t.requests];
  for (const r of list) declineRequest(t, r);
  broadcast('seat', { table: t.id });
  return { declined: list.length };
}, true);

route('POST', '/api/table/(\\d+)/reset-devices', (req, m) => {
  const t = tableOf(m[1]);
  t.members = [];
  broadcast('seat', { table: t.id });
  return { ok: true };
}, true);

route('POST', '/api/table/(\\d+)/close', (req, m, q, body) => {
  const t = tableOf(m[1]);
  const b = billOf(t);
  if (activeOrders(t).length && b.balance > 0.004 && !body.force) fail(409, 'This table still has an unpaid bill. Close anyway?', 'unpaid');
  // Orders that never reached the end of the kitchen flow are cancelled so tickets don't linger.
  for (const o of activeOrders(t)) if (o.status === 'pending' || o.status === 'sent') o.status = 'cancelled';
  for (const p of S.payments) if (p.table === t.id && p.session === t.session && (p.status === 'pending' || p.status === 'awaiting')) rejectPayment(p);
  endSitting(t);
  broadcast('seat', { table: t.id });
  return { ok: true };
}, true);

route('POST', '/api/order/([a-f0-9]+)/send', (req, m) => {
  const o = S.orders.find(x => x.id === m[1]) || fail(404, 'No such order');
  if (o.status !== 'pending') fail(409, 'Already sent');
  o.status = 'sent'; o.sentAt = now();
  if (o.lines.every(l => l.status === 'ready')) { o.status = 'ready'; o.readyAt = now(); }
  broadcast('order', { table: o.table, sent: true });
  return { ok: true };
}, true);

route('POST', '/api/table/(\\d+)/send-all', (req, m) => {
  const t = tableOf(m[1]); let n = 0;
  for (const o of activeOrders(t)) if (o.status === 'pending') { o.status = 'sent'; o.sentAt = now(); n++; }
  broadcast('order', { table: t.id, sent: true });
  return { sent: n };
}, true);

route('POST', '/api/order/([a-f0-9]+)/served', (req, m) => {
  const o = S.orders.find(x => x.id === m[1]) || fail(404, 'No such order');
  o.status = 'served';
  broadcast('order', { table: o.table });
  return { ok: true };
}, true);

route('POST', '/api/table/(\\d+)/help/clear', (req, m) => {
  tableOf(m[1]).help = null;
  broadcast('help', { table: Number(m[1]), cleared: true });
  return { ok: true };
}, true);

route('GET', '/api/kitchen', () => {
  const tickets = S.orders.filter(o => o.status === 'sent').map(o => ({ id: o.id, no: o.no, table: o.table, sentAt: o.sentAt, lines: o.lines.map((l, idx) => ({ idx, name: l.name, size: l.size, qty: l.qty, notes: l.notes, station: l.station, status: l.status })).filter(l => l.station) }));
  return { tickets: tickets.sort((a, b) => a.sentAt - b.sentAt), stations: MENU.stations, serverTime: now() };
}, true);

route('POST', '/api/kitchen/ready', (req, m, q, body) => {
  const o = S.orders.find(x => x.id === body.orderId) || fail(404, 'No such order');
  if (o.status !== 'sent') fail(409, 'Order is not in the kitchen');
  const idxs = Array.isArray(body.idxs) ? body.idxs : [body.idx];
  for (const i of idxs) { const l = o.lines[i]; if (l && l.station) l.status = body.ready === false ? 'new' : 'ready'; }
  if (o.lines.every(l => l.status === 'ready')) { o.status = 'ready'; o.readyAt = now(); }
  broadcast('order', { table: o.table, ready: o.status === 'ready' });
  return { ok: true, status: o.status };
}, true);

route('POST', '/api/payment/([a-f0-9]+)/(confirm|reject)', (req, m) => {
  const p = S.payments.find(x => x.id === m[1]) || fail(404, 'No such payment');
  if (p.status !== 'pending') fail(409, 'Already handled');
  if (m[2] === 'confirm') confirmPayment(p); else rejectPayment(p);
  const t = S.tables[p.table];
  if (t.help && /^(Cash payment|Bank transfer check)$/.test(t.help.reason) && !billOf(t).pending.length) t.help = null;
  broadcast('pay', { table: p.table });
  return { ok: true };
}, true);

// ----- payment -----
// 'online' = Stripe Checkout (card / Apple Pay / Google Pay). Without Stripe keys, online methods are
// marked paid instantly as a DEMO. 'cash' and 'bank' always need a waiter to confirm.
route('POST', '/api/pay', async (req, m, q, body) => {
  const t = tableOf(body.table);
  requireMember(t, body.cid);
  limit(req, 'pay', 20, 300000, null, body.cid);
  const b = billOf(t);
  if (b.balance <= 0.004) fail(409, 'Nothing left to pay');
  const method = body.method;
  if (!['cash', 'bank', 'online', 'card', 'applepay', 'googlepay'].includes(method)) fail(400, 'Choose a payment method');
  if (ONLINE && ['card', 'applepay', 'googlepay'].includes(method)) fail(400, 'Use online payment');

  let amount, items = [], mode = body.mode;
  if (mode === 'items') {
    const keys = Array.isArray(body.keys) ? [...new Set(body.keys)] : [];
    if (!keys.length) fail(400, 'Select at least one item');
    let sub = 0;
    for (const k of keys) {
      const [oid, idx] = String(k).split('.');
      const o = activeOrders(t).find(x => x.id === oid) || fail(400, 'Bad item');
      const l = o.lines[Number(idx)];
      if (!l || l.paid || l.price <= 0) fail(409, 'Item already paid');
      sub += l.price * l.qty;
      items.push({ name: l.name, size: l.size, qty: l.qty, total: round2(l.price * l.qty), key: k });
    }
    amount = round2(sub * (1 + MENU.taxRate));
  } else if (mode === 'equal') {
    const n = Math.max(1, Math.min(20, Math.floor(Number(body.people) || 1)));
    amount = n === 1 ? b.balance : round2(b.balance / n);
  } else if (mode === 'amount') {
    amount = round2(Number(body.amount));
  } else { mode = 'all'; amount = b.balance; }
  if (!(amount > 0)) fail(400, 'Invalid amount');
  if (amount > b.balance + 0.004) amount = b.balance;

  const tip = Math.max(0, Math.min(round2(Number(body.tip) || 0), round2(b.total)));
  // WhatsApp receipt: only with an explicit tick from the guest, and the number is used once (see sendWhatsApp).
  let phone = null;
  if (body.whatsapp === true && String(body.phone || '').trim()) {
    phone = normalizePhone(body.phone);
    if (!phone) fail(400, 'That phone number looks wrong. Please check it, including the country code.');
  }

  const staffMethod = method === 'cash' || method === 'bank';
  const stripeFlow = ONLINE && method === 'online';
  const p = { id: uid(), table: t.id, session: t.session, cid: body.cid || null, mode, amount, tip, method, phone, bill: { lines: b.lines.map(l => ({ qty: l.qty, name: l.name, size: l.size, total: round2(l.price * l.qty) })), subtotal: b.subtotal, tax: b.tax, total: b.total }, waMasked: phone ? maskPhone(phone) : null, waName: (customer(body.cid) || {}).name || '', items, tax: round2(amount - amount / (1 + MENU.taxRate)), status: stripeFlow ? 'awaiting' : 'pending', createdAt: now() };
  items.forEach(i => { const [oid, idx] = i.key.split('.'); S.orders.find(x => x.id === oid).lines[Number(idx)].paid = true; });
  S.payments.push(p);

  if (stripeFlow) {
    const origin = PUBLIC_URL || `http://${req.headers.host}`;
    const params = {
      mode: 'payment', client_reference_id: p.id, 'metadata[paymentId]': p.id, 'metadata[table]': String(t.id),
      'payment_intent_data[metadata][paymentId]': p.id,
      success_url: `${origin}/t/${t.id}?paid=${p.id}`, cancel_url: `${origin}/t/${t.id}?cancel=${p.id}`,
      expires_at: String(Math.floor(Date.now() / 1000) + 31 * 60),
      'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': CURRENCY_CODE,
      'line_items[0][price_data][unit_amount]': String(toMinor(amount)),
      'line_items[0][price_data][product_data][name]': `${MENU.restaurant} — Table ${t.id}`,
    };
    if (tip > 0) Object.assign(params, { 'line_items[1][quantity]': '1', 'line_items[1][price_data][currency]': CURRENCY_CODE, 'line_items[1][price_data][unit_amount]': String(toMinor(tip)), 'line_items[1][price_data][product_data][name]': 'Tip' });
    try {
      const s = await stripe('POST', '/checkout/sessions', params);
      p.stripeSession = s.id;
      broadcast('pay', { table: t.id });
      return { id: p.id, status: p.status, amount, tip, checkoutUrl: s.url };
    } catch (e) {
      rejectPayment(p);
      console.error('Stripe error:', e.message);
      fail(502, 'Online payment is unavailable right now — please pay by cash or ask your waiter.');
    }
  }

  if (staffMethod) {
    if (!t.help) t.help = { reason: method === 'cash' ? 'Cash payment' : 'Bank transfer check', at: now() };
    broadcast('help', { table: t.id, reason: t.help.reason });
  } else confirmPayment(p); // demo mode
  broadcast('pay', { table: t.id });
  return { id: p.id, status: p.status, amount, tip, receipt: p.receipt || null, closed: S.tables[t.id].session !== p.session };
});

// Customer polls this after returning from Stripe; `verify` asks Stripe itself so it works even before the webhook lands.
route('GET', '/api/payment/([a-f0-9]+)', async (req, m, q) => {
  const p = S.payments.find(x => x.id === m[1]) || fail(404, 'No such payment');
  if (q.get('verify') && p.status === 'awaiting') {
    try { await syncStripePayment(p); broadcast('pay', { table: p.table }); } catch (e) { console.error('Stripe verify:', e.message); }
  }
  return { id: p.id, status: p.status, amount: p.amount, tip: p.tip, method: p.method, receipt: p.receipt || null, table: p.table, waMasked: p.waMasked || null, waStatus: p.waStatus || null };
});

// Customer came back from Stripe via "back" without paying.
route('POST', '/api/payment/([a-f0-9]+)/abandon', async (req, m, q, body) => {
  const p = S.payments.find(x => x.id === m[1]) || fail(404, 'No such payment');
  if (p.status !== 'awaiting' || !body.cid || body.cid !== p.cid) return { status: p.status };
  try { await syncStripePayment(p); } catch { /* fall through to expire */ }
  if (p.status === 'awaiting') {
    try { await stripe('POST', `/checkout/sessions/${encodeURIComponent(p.stripeSession)}/expire`); } catch { /* may already be expired */ }
    rejectPayment(p);
  }
  broadcast('pay', { table: p.table });
  return { status: p.status };
});

// Stripe webhook: the reliable path (customer may close the tab before returning).
// Register https://<PUBLIC_URL>/api/stripe/webhook for checkout.session.completed, .async_payment_succeeded and .expired.
async function stripeWebhook(raw, sigHeader) {
  if (!verifyStripeSignature(raw, sigHeader)) return [400, { error: 'Bad signature' }];
  let ev; try { ev = JSON.parse(raw); } catch { return [400, { error: 'Bad payload' }]; }
  const s = ev.data && ev.data.object;
  const p = s && S.payments.find(x => x.id === (s.metadata || {}).paymentId || x.stripeSession === s.id);
  if (p && p.status === 'awaiting') {
    if ((ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') && s.payment_status === 'paid') {
      await syncStripePayment(p).catch(e => console.error('Stripe verify:', e.message)); // re-check amount/currency with Stripe
    } else if (ev.type === 'checkout.session.expired' || ev.type === 'checkout.session.async_payment_failed') rejectPayment(p);
    broadcast('pay', { table: p.table });
  }
  return [200, { received: true }];
}

// Free up payments whose Checkout session timed out without any webhook/return.
setInterval(() => {
  for (const p of S.payments) if (p.status === 'awaiting' && now() - p.createdAt > AWAITING_MAX_MS) {
    // Only release it once Stripe itself says the session is expired/unpaid; if Stripe is unreachable, retry next minute.
    syncStripePayment(p).then(() => broadcast('pay', { table: p.table })).catch(e => console.error('Stripe sweep:', e.message));
  }
}, 60000).unref();

route('POST', '/api/review', (req, m, q, body) => {
  const rating = Math.min(5, Math.max(1, Math.floor(Number(body.rating) || 0)));
  if (!rating) fail(400, 'Rating required');
  // Only someone who actually paid can review, once per payment.
  const paidBy = S.payments.find(p => p.id === body.paymentId && p.status === 'confirmed' && p.cid && p.cid === body.cid) || fail(403, 'Reviews are for guests who have paid.');
  if (paidBy.reviewed) fail(409, 'You already reviewed this visit — thank you!');
  paidBy.reviewed = true;
  S.reviews.push({ id: uid(), table: Number(body.table) || null, rating, comment: String(body.comment || '').slice(0, 500), name: String(body.name || '').slice(0, 30), at: now() });
  addPoints(body.cid, 5);
  broadcast('review');
  return { ok: true };
});

// games
const openGames = () => S.games.filter(g => !g.winner || now() - g.updated < 60000).filter(g => now() - g.updated < 15 * 60000);
const inGame = (g, cid) => g.x.cid === cid || (g.o && g.o.cid === cid);
route('GET', '/api/games', (req, m, q) => ({ games: openGames().map(g => gamePublic(g, q.get('cid'))), types: GAME_TYPES }));
route('POST', '/api/game/new', (req, m, q, body) => {
  requireMember(tableOf(body.table), body.cid);
  const c = customer(body.cid) || fail(400, 'cid required');
  const type = body.type || 'ttt';
  if (!GAME_TYPES[type]) fail(400, 'Unknown game');
  S.games = S.games.filter(g => g.winner ? now() - g.updated < 60000 : now() - g.updated < 15 * 60000);
  const mine = S.games.find(g => !g.winner && inGame(g, c.id));
  if (mine) {
    if (mine.o) fail(409, 'Finish or leave your current game first.');
    if ((mine.type || 'ttt') === type) return gamePublic(mine, c.id);  // already waiting for an opponent in this game
    S.games = S.games.filter(g => g !== mine);                          // switching games while still waiting alone
  }
  const g = Object.assign({ id: uid(), type, x: { cid: c.id, table: Number(body.table), name: c.name || `Table ${body.table}` }, o: null, winner: null, updated: now() }, newGameState(type));
  S.games.push(g);
  broadcast('game');
  return gamePublic(g, c.id);
});
route('POST', '/api/game/([a-f0-9]+)/join', (req, m, q, body) => {
  requireMember(tableOf(body.table), body.cid);
  const c = customer(body.cid) || fail(400, 'cid required');
  const g = S.games.find(x => x.id === m[1]) || fail(404, 'Game gone');
  if (g.o) fail(409, 'Game is full');
  if (g.x.cid === c.id) fail(409, 'You started this game. Wait for an opponent.');
  const busy = S.games.find(x => x !== g && !x.winner && inGame(x, c.id));
  if (busy) fail(409, 'Finish or leave your current game first.');
  g.o = { cid: c.id, table: Number(body.table), name: c.name || `Table ${body.table}` };
  g.updated = now();
  broadcast('game');
  return gamePublic(g, c.id);
});
route('POST', '/api/game/([a-f0-9]+)/move', (req, m, q, body) => {
  const g = S.games.find(x => x.id === m[1]) || fail(404, 'Game gone');
  if (!g.o || g.winner) fail(409, 'Not playable');
  const side = g.x.cid === body.cid ? 'x' : g.o.cid === body.cid ? 'o' : fail(403, 'You are not in this game');
  const type = g.type || 'ttt';
  if (type === 'rps') {
    const choice = String(body.choice);
    if (!RPS_BEATS[choice]) fail(400, 'Choose rock, paper or scissors');
    if (g.rps.choices[side]) fail(409, 'You already chose. Waiting for your opponent.');
    g.rps.choices[side] = choice;
    const { x, o } = g.rps.choices;
    if (x && o) { // both in: reveal the round
      const result = x === o ? 'draw' : RPS_BEATS[x] === o ? 'x' : 'o';
      g.rps.rounds.push({ x, o, result });
      if (result !== 'draw') g.rps.score[result]++;
      g.rps.choices = {};
      if (g.rps.score.x >= RPS_TARGET) g.winner = 'x'; else if (g.rps.score.o >= RPS_TARGET) g.winner = 'o';
    }
  } else {
    if (g.turn !== side) fail(409, 'Not your turn');
    if (type === 'c4') {
      const col = Number(body.col);
      if (!Number.isInteger(col) || col < 0 || col > 6) fail(400, 'Bad move');
      const row = c4Drop(g.board, col, side);
      if (row < 0) fail(400, 'That column is full');
      g.winner = c4Winner(g.board, row, col);
    } else {
      const cell = Number(body.cell);
      if (!(cell >= 0 && cell < 9) || g.board[cell]) fail(400, 'Bad move');
      g.board[cell] = side;
      g.winner = tttWinner(g.board);
    }
    g.turn = otherSide(side);
  }
  g.updated = now();
  awardWin(g);
  broadcast('game');
  return gamePublic(g, body.cid);
});
// Walk away: an unstarted game disappears; a game in progress counts as a win for the other player (no reward).
route('POST', '/api/game/([a-f0-9]+)/leave', (req, m, q, body) => {
  const g = S.games.find(x => x.id === m[1]) || fail(404, 'Game gone');
  if (!validCid(body.cid) || !inGame(g, body.cid)) fail(403, 'You are not in this game');
  if (!g.o) S.games = S.games.filter(x => x !== g);
  else if (!g.winner) { g.winner = g.x.cid === body.cid ? 'o' : 'x'; g.forfeit = true; g.updated = now(); }
  broadcast('game');
  return { ok: true };
});

// ---------- server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

  if (url.pathname === '/api/events') {
    if (clients.size >= 500) { res.writeHead(503); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clients.delete(res); clearInterval(ping); });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    const isStaff = req.headers['x-pin'] === PIN;
    if (req.method === 'POST' && url.pathname === '/api/stripe/webhook') { // needs the raw body for signature checks
      let raw = '';
      req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
      req.on('end', async () => { try { const [code, obj] = await stripeWebhook(raw, req.headers['stripe-signature']); send(code, obj); } catch (e) { console.error(e); send(500, { error: 'Server error' }); } });
      return;
    }
    const pm = url.pathname.match(/^\/api\/payment\/([a-f0-9]+)\/receipt\.pdf$/);
    if (pm && req.method === 'GET') { // the guest's own PDF receipt (device id must match), or staff
      const p = S.payments.find(x => x.id === pm[1]), cid = url.searchParams.get('cid');
      if (!p || p.status !== 'confirmed') return send(404, { error: 'Receipt not available yet' });
      if (!isStaff && !(cid && cid === p.cid)) return send(403, { error: 'This receipt belongs to another guest' });
      let pdf; try { pdf = receiptPdf(p); } catch (e) { console.error(e); return send(500, { error: 'Could not make the PDF' }); }
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="receipt-${p.id.slice(0, 6)}.pdf"`, 'Cache-Control': 'private, no-store', 'Content-Length': pdf.length });
      return res.end(pdf);
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      if (r.staff && !isStaff) return send(401, { error: 'Staff PIN required' });
      try {
        if (!isStaff && req.method === 'POST') limit(req, 'global', 600, 60000); // blanket per-IP cap for guests
        const body = req.method === 'POST' ? await readBody(req) : {};
        return send(200, await r.handler(req, m, url.searchParams, body, isStaff));
      } catch (e) {
        if (e instanceof HttpError) return send(e.code, { error: e.message, reason: e.reason });
        console.error(e);
        return send(500, { error: 'Server error' });
      }
    }
    return send(404, { error: 'Not found' });
  }

  let file = url.pathname;
  if (/^\/t\/\d+\/?$/.test(file)) file = '/customer.html';
  else if (file === '/kitchen') file = '/kitchen.html';
  else if (file === '/floor') file = '/floor.html';
  else if (file === '/qr') file = '/qr.html';
  else if (file === '/') file = '/index.html';
  const full = path.join(PUBLIC, path.normalize(file));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': full.endsWith('.jpg') ? 'public, max-age=86400' : 'no-cache' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n${MENU.restaurant} running on http://localhost:${PORT}`);
  console.log(`  Customer (table 5): http://localhost:${PORT}/t/5`);
  console.log(`  Kitchen display:    http://localhost:${PORT}/kitchen`);
  console.log(`  Floor map:          http://localhost:${PORT}/floor`);
  console.log(`  QR codes to print:  http://localhost:${PORT}/qr`);
  console.log(`  Staff PIN: ${PIN}${process.env.STAFF_PIN ? '' : '  (default — set STAFF_PIN to change)'}`);
  if (STRIPE_KEY && !CURRENCY_CODE) console.log('  ! Stripe key set but no currency: set CURRENCY_CODE (e.g. pkr) or menu.json "currencyCode". Online payments are OFF.');
  console.log(`  Online payments: ${ONLINE ? `Stripe Checkout (${CURRENCY_CODE.toUpperCase()})${STRIPE_WEBHOOK_SECRET ? '' : '  ! no STRIPE_WEBHOOK_SECRET — relying on the return redirect only'}${PUBLIC_URL ? '' : '  ! set PUBLIC_URL'}` : 'DEMO mode (no real charges)'}`);
  console.log(`  WhatsApp receipts: ${WA_ON ? `on (template "${WA_TEMPLATE}")` : 'off (set WHATSAPP_TOKEN and WHATSAPP_PHONE_ID)'}`);
  if (WA_ON) console.log(`  WhatsApp PDF attachment: ${WA_PDF ? 'on (template needs a Document header)' : 'off'}`);
  console.log(`  Location to share: ${MAPS_URL || 'not set (add "address" to data/menu.json)'}`);
  for (const i of Object.values(os.networkInterfaces()).flat()) if (i && i.family === 'IPv4' && !i.internal) console.log(`  On your phone (same WiFi): http://${i.address}:${PORT}/t/5`);
});
