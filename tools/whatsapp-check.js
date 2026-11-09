#!/usr/bin/env node
// Checks your WhatsApp Business Cloud API setup without touching the restaurant app.
//   node tools/whatsapp-check.js                 -> verifies the token, the sending number and (if WHATSAPP_WABA_ID is set) the template
//   node tools/whatsapp-check.js --send 98765xxxxx   -> ALSO sends one real test message from your restaurant number to that phone
// Reads WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_TEMPLATE, WHATSAPP_LANG, WHATSAPP_WABA_ID, WHATSAPP_EXPECTED_NUMBER from the
// environment or from the .env file in the app folder.
const fs = require('fs');
const path = require('path');

try {
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* optional */ }

const E = process.env;
const API = (E.WHATSAPP_API_BASE || 'https://graph.facebook.com/v20.0').replace(/\/$/, '');
const TOKEN = E.WHATSAPP_TOKEN || '', PHONE_ID = E.WHATSAPP_PHONE_ID || '', WABA = E.WHATSAPP_WABA_ID || '';
const TEMPLATE = E.WHATSAPP_TEMPLATE || 'visit_thanks', LANG = E.WHATSAPP_LANG || 'en', EXPECTED = String(E.WHATSAPP_EXPECTED_NUMBER || '').replace(/\D/g, '');
const ATTACH = /^(1|true|yes|on)$/i.test(E.WHATSAPP_ATTACH_PDF || '');
const sendIdx = process.argv.indexOf('--send');
const sendTo = sendIdx > -1 ? String(process.argv[sendIdx + 1] || '').replace(/\D/g, '') : '';

let problems = 0;
const ok = m => console.log('  ✔ ' + m);
const bad = (m, hint) => { problems++; console.log('  ✘ ' + m); if (hint) console.log('    → ' + hint); };
const warn = m => console.log('  ! ' + m);

async function graph(method, p, body) {
  const r = await fetch(API + p, { method, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, j, err: j.error ? `${j.error.message || 'error'}${j.error.code ? ' (code ' + j.error.code + ')' : ''}` : '' };
}

(async () => {
  console.log('WhatsApp setup check\n');
  if (!TOKEN) bad('WHATSAPP_TOKEN is not set', 'put it in the .env file (see .env.example) or set it in the terminal');
  if (!PHONE_ID) bad('WHATSAPP_PHONE_ID is not set', 'in Meta: WhatsApp → API Setup → "Phone number ID" (a long number; NOT your phone number)');
  if (!TOKEN || !PHONE_ID) return finish();

  // 1) token + sending number
  const info = await graph('GET', `/${encodeURIComponent(PHONE_ID)}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,name_status,status`);
  if (!info.ok) {
    if (info.status === 401 || /token|OAuth/i.test(info.err)) bad('Meta rejected the token: ' + info.err, 'the token is wrong or has expired. Create a system-user token in Business Settings (Users → System users) with whatsapp_business_messaging permission.');
    else if (info.status === 400 || info.status === 404) bad('Meta could not find that Phone number ID: ' + info.err, 'copy the "Phone number ID" from WhatsApp → API Setup. People often paste the phone number or the WhatsApp Business Account ID by mistake.');
    else bad('Could not reach the sending number: ' + info.err);
  } else {
    const d = info.j, shown = String(d.display_phone_number || '');
    ok(`Token works. Sending number: ${shown}   (verified name: ${d.verified_name || 'n/a'}, quality: ${d.quality_rating || 'n/a'})`);
    if (EXPECTED) {
      const digits = shown.replace(/\D/g, '');
      if (digits.endsWith(EXPECTED.slice(-10))) ok(`That is your restaurant number (${EXPECTED}).`);
      else bad(`The Phone number ID belongs to ${shown}, not ${EXPECTED}.`, 'you probably used the Meta test number. In API Setup, add your own number, then copy the Phone number ID shown for it.');
    }
    if (d.name_status && !/APPROVED|AVAILABLE_WITHOUT_REVIEW/i.test(d.name_status)) warn(`Display name status: ${d.name_status} (Meta must approve the business name before sending at volume)`);
    if (d.status && !/CONNECTED/i.test(d.status)) bad(`Number status is ${d.status}`, 'finish the number verification / registration in Meta, then run this again');
  }

  // 2) template
  if (!WABA) warn('WHATSAPP_WABA_ID is not set, so I cannot check the template status (optional: WhatsApp Business Account ID from Meta).');
  else {
    const t = await graph('GET', `/${encodeURIComponent(WABA)}/message_templates?name=${encodeURIComponent(TEMPLATE)}&fields=name,status,language,category,components`);
    if (!t.ok) bad('Could not read templates: ' + t.err, 'check WHATSAPP_WABA_ID (the WhatsApp Business Account ID)');
    else {
      const list = t.j.data || [], mine = list.find(x => x.language === LANG) || list[0];
      if (!mine) bad(`No template named "${TEMPLATE}" found`, 'create it in WhatsApp Manager → Message templates; the exact text is in the README');
      else if (mine.status !== 'APPROVED') bad(`Template "${TEMPLATE}" (${mine.language}) is ${mine.status}`, mine.status === 'PENDING' ? 'wait for Meta to approve it (usually minutes to a day)' : 'edit and resubmit it');
      else {
        ok(`Template "${TEMPLATE}" (${mine.language}) is APPROVED, category ${mine.category}.`);
        const body = ((mine.components || []).find(c => c.type === 'BODY') || {}).text || '';
        const vars = new Set((body.match(/\{\{\d+\}\}/g) || [])).size;
        const header = (mine.components || []).find(c => c.type === 'HEADER');
        const docHeader = !!(header && header.format === 'DOCUMENT');
        if (ATTACH && !docHeader) bad('WHATSAPP_ATTACH_PDF is on, but the template has no Document header', 'edit the template: add a header of type Document (sample: a PDF), or set WHATSAPP_ATTACH_PDF=0');
        else if (!ATTACH && docHeader) bad('The template has a Document header, but WHATSAPP_ATTACH_PDF is off', 'set WHATSAPP_ATTACH_PDF=1 so the app sends the PDF, otherwise WhatsApp rejects every message');
        else if (ATTACH) ok('The template has a Document header for the PDF receipt.');
        if (vars !== 4) bad(`The template body has ${vars} variables, the app sends 4`, 'it must contain {{1}} to {{4}} (name, restaurant, receipt, location) in this order');
        else ok('The template has the 4 variables the app sends.');
      }
    }
  }

  // 3) optional real test message
  if (sendIdx > -1) {
    if (!sendTo || sendTo.length < 10) bad('--send needs a phone number, for example: --send 9876543210');
    else if (problems) warn('Fix the problems above first; not sending.');
    else {
      const cc = String(E.PHONE_COUNTRY_CODE || '91'), to = sendTo.length <= 11 ? cc + sendTo.replace(/^0+/, '') : sendTo;
      const vars = ['there', 'Spice & Co.', 'Table 1: 1 x Masala Dosa. Paid 149.00 by card.', 'https://www.google.com/maps/search/?api=1&query=MG+Road%2C+Bengaluru'];
      const components = [{ type: 'body', parameters: vars.map(text => ({ type: 'text', text })) }];
      if (ATTACH) { // upload a sample PDF receipt and attach it, exactly like the app does
        const { buildReceiptPdf } = require('../lib/receipt-pdf');
        const pdf = buildReceiptPdf({ restaurant: 'Spice & Co.', address: 'Sample', currency: '₹', taxName: 'GST', taxRate: 0.05, table: 1, id: 'TEST01', date: new Date(), method: 'card', lines: [{ qty: 1, name: 'Masala Dosa', total: 149 }], subtotal: 149, tax: 7.45, total: 156.45, showShare: false, tip: 0, paid: 156.45 });
        const form = new FormData(); form.append('messaging_product', 'whatsapp'); form.append('type', 'application/pdf'); form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'Receipt-TEST01.pdf');
        const up = await fetch(API + '/' + encodeURIComponent(PHONE_ID) + '/media', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: form });
        const uj = await up.json().catch(() => ({}));
        if (!up.ok || !uj.id) { bad('Could not upload the sample PDF: ' + (uj.error ? uj.error.message : up.status)); return finish(); }
        components.unshift({ type: 'header', parameters: [{ type: 'document', document: { id: uj.id, filename: 'Receipt-TEST01.pdf' } }] });
      }
      const r = await graph('POST', `/${encodeURIComponent(PHONE_ID)}/messages`, { messaging_product: 'whatsapp', to, type: 'template', template: { name: TEMPLATE, language: { code: LANG }, components } });
      if (r.ok) ok(`Test message accepted by WhatsApp for +${to}. Check that phone.`);
      else bad('WhatsApp refused the test message: ' + r.err, /recipient|allowed|list/i.test(r.err) ? 'while your number is in test mode you can only message phone numbers added in API Setup → "To"' : '');
    }
  }
  finish();
})().catch(e => { console.log('  ✘ ' + e.message); process.exitCode = 1; });

function finish() {
  console.log(problems ? `\n${problems} problem${problems > 1 ? 's' : ''} to fix.` : '\nAll good. Start the restaurant app: guests can now get receipts on WhatsApp.');
  process.exitCode = problems ? 1 : 0;
}
