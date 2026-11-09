// Shared helpers for staff screens (kitchen display, floor map).
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let PIN = '';
try { PIN = localStorage.getItem('staffPin') || ''; } catch {}

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'x-pin': PIN }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { PIN = ''; try { localStorage.removeItem('staffPin'); } catch {} askPin(); throw new Error(j.error); }
  if (!r.ok) { const e = new Error(j.error || 'Error'); e.reason = j.reason; throw e; }
  return j;
}

function askPin(msg) {
  if (document.getElementById('pinov')) return;
  document.body.insertAdjacentHTML('beforeend', `<div class="overlay" id="pinov" style="align-items:center"><form class="sheet" style="max-width:340px;border-radius:12px" id="pinform"><h2>Staff PIN</h2><p class="mute small">${esc(msg || 'Enter the PIN to open this screen.')}</p><input id="pin" type="password" inputmode="numeric" autocomplete="off" autofocus><button class="btn block" style="margin-top:12px">Open</button></form></div>`);
  $('#pinform').onsubmit = e => {
    e.preventDefault(); PIN = $('#pin').value;
    try { localStorage.setItem('staffPin', PIN); } catch {}
    $('#pinov').remove(); start();
  };
}

let audioCtx;
function beep(freq = 880, ms = 160, times = 1) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < times; i++) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = freq; o.connect(g); g.connect(audioCtx.destination);
      const t0 = audioCtx.currentTime + i * (ms + 90) / 1000;
      g.gain.setValueAtTime(0.15, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + ms / 1000);
      o.start(t0); o.stop(t0 + ms / 1000);
    }
  } catch {}
}

function toast(msg) { const t = $('#toast'); if (!t) return; t.innerHTML = `<div class="toast" style="bottom:30px">${esc(msg)}</div>`; clearTimeout(toast.t); toast.t = setTimeout(() => t.innerHTML = '', 2500); }

function connectLive(onEvent) {
  const es = new EventSource('/api/events');
  es.onmessage = e => { try { onEvent(JSON.parse(e.data)); } catch {} };
}
const mins = ms => Math.floor(ms / 60000);
const fmtTimer = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
