// One small, consistent line-icon set (24px grid, 1.6px stroke, round caps) used by every screen.
// Usage: icon('bell') -> inline <svg>. Size/colour come from CSS (.i { width:1.25em } and currentColor).
(function () {
  const P = {
    menu: '<path d="M5 4.5h10.5A3.5 3.5 0 0 1 19 8v12H8.5A3.5 3.5 0 0 1 5 16.5z"/><path d="M8.5 9h7M8.5 12.5h5"/>',
    order: '<path d="M6 3.5h12v17l-3-1.8-3 1.8-3-1.8-3 1.8z"/><path d="M9.5 8h5M9.5 11.5h5"/>',
    dice: '<rect x="4.5" y="4.5" width="15" height="15" rx="3.5"/><circle cx="9" cy="9" r=".9" fill="currentColor"/><circle cx="15" cy="15" r=".9" fill="currentColor"/><circle cx="12" cy="12" r=".9" fill="currentColor"/>',
    star: '<path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z"/>',
    wallet: '<path d="M4.5 7.5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A2 2 0 0 1 3.5 17.5v-10a2 2 0 0 1 2-2H16"/><path d="M15.5 13.5h2.2"/>',
    bell: '<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M15.5 15.5L20 20"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    plus: '<path d="M12 5.5v13M5.5 12h13"/>',
    minus: '<path d="M5.5 12h13"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    filter: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
    wifi: '<path d="M3.5 9.5a12 12 0 0 1 17 0M6.5 12.8a7.6 7.6 0 0 1 11 0M9.5 16a3.3 3.3 0 0 1 5 0"/><circle cx="12" cy="19" r=".9" fill="currentColor"/>',
    key: '<circle cx="8" cy="14" r="3.5"/><path d="M10.5 11.5L19 3.5M16 6.5l2 2M13.5 9l1.8 1.8"/>',
    lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
    out: '<path d="M10 5.5H6.5A1.5 1.5 0 0 0 5 7v10.5A1.5 1.5 0 0 0 6.5 19H17a1.5 1.5 0 0 0 1.5-1.5V14M13.5 5.5h5v5M18.5 5.5L11 13"/>',
    card: '<rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M3.5 10.5h17M7 15h3"/>',
    phone: '<rect x="7" y="3.5" width="10" height="17" rx="2.2"/><path d="M11 17.5h2"/>',
    bank: '<path d="M4 9.5L12 5l8 4.5M5.5 9.5v7.5M10 9.5v7.5M14 9.5v7.5M18.5 9.5v7.5M4 19h16"/>',
    cash: '<rect x="3.5" y="7" width="17" height="10" rx="1.8"/><circle cx="12" cy="12" r="2.3"/><path d="M6.5 10v4M17.5 10v4"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
    fork: '<path d="M8 3.5v6.5a2 2 0 0 0 2 2M8 3.5v17M5.5 3.5V9a2.5 2.5 0 0 0 2.5 2.5M16.5 20.5v-17c-2 1.5-3 4-3 7h3"/>',
    undo: '<path d="M9 8L5 12l4 4M5 12h9a5 5 0 0 1 0 10"/>',
    map: '<path d="M4 6.5l5-2 6 2 5-2v13l-5 2-6-2-5 2z"/><path d="M9 4.5v13M15 6.5v13"/>',
    grid: '<rect x="4.5" y="4.5" width="6" height="6" rx="1"/><rect x="13.5" y="4.5" width="6" height="6" rx="1"/><rect x="4.5" y="13.5" width="6" height="6" rx="1"/><rect x="13.5" y="13.5" width="6" height="6" rx="1"/>',
    edit: '<path d="M5 19l1-4L16.5 4.5a1.8 1.8 0 0 1 2.5 2.5L8.5 17.5z"/>',
    volume: '<path d="M4.5 10v4h3l4 3.5v-11L7.5 10z"/><path d="M15 9.5a3.5 3.5 0 0 1 0 5M17.5 7a7 7 0 0 1 0 10"/>',
    mute: '<path d="M4.5 10v4h3l4 3.5v-11L7.5 10zM15.5 9.5l4 5M19.5 9.5l-4 5"/>',
    kitchen: '<path d="M6 11.5h12v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4z"/><path d="M6 11.5a3 3 0 0 1 1-5.8 3.5 3.5 0 0 1 10 0 3 3 0 0 1 1 5.8"/>',
    door: '<path d="M6.5 20.5v-16h8v16M4.5 20.5h13"/><circle cx="12" cy="12.5" r=".8" fill="currentColor"/>',
    glass: '<path d="M6 4.5h12L12 12.5zM12 12.5v7M8.5 19.5h7"/>',
    toilet: '<circle cx="8" cy="5.5" r="1.3"/><circle cx="16" cy="5.5" r="1.3"/><path d="M8 9v7M6 9.5h4l-1 4M16 9v7M14 9.5h4l-1.5 4.5M12 4.5v15"/>',
    connect: '<rect x="4.5" y="4.5" width="15" height="15" rx="2.5"/><circle cx="9" cy="9" r="1.7"/><circle cx="15" cy="9" r="1.7"/><circle cx="9" cy="15" r="1.7"/><circle cx="15" cy="15" r="1.7"/>',
    hand: '<path d="M7.5 12.5V7a1.5 1.5 0 0 1 3 0v4M10.5 11V5.5a1.5 1.5 0 0 1 3 0V11M13.5 11V6.5a1.5 1.5 0 0 1 3 0V14M16.5 12.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.2a6 6 0 0 1-4.8-2.4L4.8 14.6a1.5 1.5 0 0 1 2.4-1.8l.3.4"/>',
    cards: '<rect x="4.5" y="8" width="10.5" height="12" rx="1.8"/><path d="M8.5 5.2A1.8 1.8 0 0 1 10.3 4H18a1.8 1.8 0 0 1 1.8 1.8V15a1.8 1.8 0 0 1-1.2 1.7"/>',
    question: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.6a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1.1 1-1.1 1.7M12 16.8v.1"/>',
    rock: '<path d="M6.5 14.5l1.5-5.5 4-2.5 4.5 2 1.5 5-2.5 3.5h-6.5z"/>',
    paper: '<path d="M7 4.5h7l3.5 3.5v11.5H7z"/><path d="M14 4.5V8h3.5M9.5 12h5M9.5 15h5"/>',
    scissors: '<circle cx="7" cy="17.5" r="2.5"/><circle cx="17" cy="17.5" r="2.5"/><path d="M8.7 15.6L16.5 4.5M15.3 15.6L7.5 4.5"/>',
    download: '<path d="M12 4.5v10M8 11l4 4 4-4M5 19.5h14"/>',
    back:'<path d="M15 6l-6 6 6 6"/>',
    alert:'<path d="M12 4.5l8.5 15h-17z"/><path d="M12 10v4M12 16.8v.1"/>',
  };
  const sprite = '<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true">' +
    Object.entries(P).map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${v}</symbol>`).join('') + '</svg>';
  const mount = () => document.body.insertAdjacentHTML('afterbegin', sprite);
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  window.icon = (name, cls) => `<svg class="i${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
})();
