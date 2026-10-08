/**
 * Shared UI helpers: HTML escaping, formatters, toasts, modals, empty states.
 */

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Tagged template that escapes interpolations unless they are already trusted
 * markup (the result of another html`` call, or wrapped in raw()).
 * Returns a Raw object that stringifies to markup, so it can be nested or
 * assigned straight to innerHTML.
 */
class Raw {
  constructor(v) { this.value = String(v); }
  toString() { return this.value; }
}
const render = (v) => {
  if (v instanceof Raw) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  if (v === undefined || v === null || v === false) return '';
  return esc(v);
};
export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += render(vals[i]) + strings[i + 1];
  return new Raw(out);
}
export const raw = (v) => (v instanceof Raw ? v : new Raw(v ?? ''));

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));

export function parseDate(str) {
  if (!str) return null;
  const [y, m, d] = str.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function toISODate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function fmtDate(str, opts = {}) {
  const d = parseDate(str);
  if (!d) return '—';
  const { weekday = false, short = false } = opts;
  const month = short ? MONTHS_SHORT[d.getMonth()] : MONTHS[d.getMonth()];
  const base = `${month} ${d.getDate()}, ${d.getFullYear()}`;
  if (!weekday) return base;
  return `${d.toLocaleDateString('en-US', { weekday: 'long' })}, ${base}`;
}
export function fmtMonth(ym) {
  if (!ym) return '—';
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}
export function fmtMonthShort(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS_SHORT[m - 1]} ’${String(y).slice(2)}`;
}
export function fmtDateTime(sqlStr) {
  if (!sqlStr) return '—';
  // SQLite datetime('now') is UTC: "YYYY-MM-DD HH:MM:SS"
  const iso = sqlStr.includes('T') ? sqlStr : sqlStr.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return sqlStr;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function fmtTime(sqlStr) {
  if (!sqlStr) return '';
  const iso = sqlStr.includes('T') ? sqlStr : sqlStr.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
export const fmtNum = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));
export const fmtPct = (n) => (n === null || n === undefined ? '—' : `${Number(n).toFixed(1)}%`);
export function age(birthdate) {
  const d = parseDate(birthdate);
  if (!d) return null;
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) a--;
  return a;
}

/** Most recent Sunday on or before today. */
export function lastSunday(from = new Date()) {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}
export const isSundayStr = (str) => { const d = parseDate(str); return d && d.getDay() === 0; };
export function addDays(str, n) { const d = parseDate(str); d.setDate(d.getDate() + n); return toISODate(d); }

export const STATUS_LABELS = {
  first_timer: 'First Timer', new_believer: 'New Believer', regular: 'Regular Attendee',
  member: 'Member', leader: 'Leader', volunteer: 'Volunteer', inactive: 'Inactive',
};
export const DAY_LABELS = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
export const DAY_SHORT = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
export const TIME_LABELS = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening' };
export function fmtClock(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM'; const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
}
/** "Saturday 5:00 PM" or "Schedule not set". */
export const fmtSchedule = (g) => (g.schedule_day || g.schedule_time ? `${DAY_LABELS[g.schedule_day] || ''} ${fmtClock(g.schedule_time)}`.trim() : '');
export const ROLE_LABELS = { admin: 'Admin', staff: 'Attendance Staff', viewer: 'Viewer / Leader' };

export const fullName = (p) => `${p.first_name} ${p.last_name}`;
export const initials = (p) => `${(p.first_name || '?')[0]}${(p.last_name || '')[0] || ''}`.toUpperCase();

export function avatar(p, size = '') {
  const cls = `avatar ${size ? 'avatar--' + size : ''}`;
  if (p.photo) return html`<span class="${cls}"><img src="${p.photo}" alt="" loading="lazy" /></span>`;
  return html`<span class="${cls}" aria-hidden="true">${initials(p)}</span>`;
}
export const statusBadge = (s) => html`<span class="badge badge--${s}">${STATUS_LABELS[s] || s}</span>`;
export const classBadge = (c) => (c ? html`<span class="badge badge--${c}">${c === 'first_timer' ? 'First Timer' : 'Returning'}</span>` : '');
export const attBadge = (s) => (s ? html`<span class="badge badge--${s}">${s === 'present' ? 'Present' : 'Absent'}</span>` : html`<span class="badge">Not recorded</span>`);

export function personCell(p, { link = true } = {}) {
  const inner = html`${raw(avatar(p))}<span><span class="name">${fullName(p)}</span><br><span class="code">${p.person_code || ''}</span></span>`;
  return link
    ? html`<a class="person-cell" href="#/people/${p.id}" style="color:inherit;text-decoration:none">${raw(inner)}</a>`
    : html`<span class="person-cell">${raw(inner)}</span>`;
}

// ---------------------------------------------------------------------------
// Icons (inline SVG paths)
// ---------------------------------------------------------------------------
const ICONS = {
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.5A5 5 0 0 1 21.5 20"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  warn: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  upload: '<path d="M12 15V3M7 8l5-5 5 5M4 21h16"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  print: '<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v12H4z"/><circle cx="12" cy="13" r="3.5"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  chevL: '<path d="m15 18-6-6 6-6"/>',
  chevR: '<path d="m9 18 6-6-6-6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  group: '<circle cx="12" cy="7" r="3"/><circle cx="5" cy="10" r="2.5"/><circle cx="19" cy="10" r="2.5"/><path d="M7 20a5 5 0 0 1 10 0M1.5 18a3.5 3.5 0 0 1 5-3M22.5 18a3.5 3.5 0 0 0-5-3"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14h1M14 20h1M18 18h3v3h-3z"/>',
  inbox: '<path d="M3 13h5l2 3h4l2-3h5"/><path d="M5 5h14l2 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  pin: '<path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10z"/><circle cx="12" cy="11" r="2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
};
export const icon = (name, size = 16) =>
  raw(`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`);

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------
export function emptyState({ icon: ic = 'people', title, text, action }) {
  return html`<div class="empty">
    <div class="empty__icon">${icon(ic, 26)}</div>
    <h3>${title}</h3>
    ${text ? html`<p>${text}</p>` : ''}
    ${action ? raw(action) : ''}
  </div>`;
}
export const loadingState = (text = 'Loading…') => html`<div class="loading">${text}</div>`;
export function errorState(err, retryHash) {
  return html`<div class="card"><div class="empty">
    <div class="empty__icon" style="background:var(--red-100);color:var(--red-600)">${icon('warn', 26)}</div>
    <h3>Something went wrong</h3>
    <p>${err?.message || 'Unexpected error.'}</p>
    <button class="btn mt-2" data-action="reload">Try again</button>
  </div></div>`;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
export function toast(message, type = 'success', ms = 3200) {
  const root = document.getElementById('toastRoot');
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.setAttribute('role', 'status');
  el.innerHTML = `<span>${esc(message)}</span><button aria-label="Dismiss">×</button>`;
  el.querySelector('button').onclick = () => el.remove();
  root.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, ms);
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------
let activeModal = null;
export function openModal({ title, subtitle, body, footer, wide = false, onClose }) {
  closeModal();
  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="modal-backdrop" data-close>
      <div class="modal ${wide ? 'modal--wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <div class="modal__header">
          <div><h2 id="modalTitle">${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>
          <button class="icon-btn" data-close aria-label="Close">${icon('close', 20).value}</button>
        </div>
        <div class="modal__body">${body}</div>
        ${footer ? `<div class="modal__footer">${footer}</div>` : ''}
      </div>
    </div>`;
  const backdrop = root.firstElementChild;
  backdrop.addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-close') || e.target.closest('[data-close]')?.classList.contains('icon-btn')) {
      if (e.target === backdrop || e.target.closest('.icon-btn')) closeModal();
    }
  });
  const onKey = (e) => { if (e.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', onKey);
  activeModal = { onClose, onKey };
  document.body.style.overflow = 'hidden';
  setTimeout(() => backdrop.querySelector('input,select,textarea,button:not([data-close])')?.focus(), 30);
  return backdrop.querySelector('.modal');
}
export function closeModal() {
  const root = document.getElementById('modalRoot');
  if (activeModal) {
    document.removeEventListener('keydown', activeModal.onKey);
    activeModal.onClose?.();
  }
  activeModal = null;
  root.innerHTML = '';
  document.body.style.overflow = '';
}

/** Confirmation dialog. Resolves true/false. */
export function confirmDialog({ title, message, confirmText = 'Confirm', danger = false, confirmWord }) {
  return new Promise((resolve) => {
    const modal = openModal({
      title,
      body: `
        <div class="row" style="align-items:flex-start;flex-wrap:nowrap;gap:14px">
          ${danger ? `<div class="danger-icon">${icon('warn', 22).value}</div>` : ''}
          <div style="flex:1">
            <p style="font-size:.93rem">${message}</p>
            ${confirmWord ? `<div class="field mt-2"><label>Type <b>${esc(confirmWord)}</b> to confirm</label><input id="confirmWord" autocomplete="off" /></div>` : ''}
          </div>
        </div>`,
      footer: `<button class="btn" data-cancel>Cancel</button>
               <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-ok ${confirmWord ? 'disabled' : ''}>${esc(confirmText)}</button>`,
      onClose: () => resolve(false),
    });
    const ok = modal.querySelector('[data-ok]');
    modal.querySelector('[data-cancel]').onclick = () => closeModal();
    ok.onclick = () => { activeModal.onClose = null; closeModal(); resolve(true); };
    if (confirmWord) {
      modal.querySelector('#confirmWord').oninput = (e) => { ok.disabled = e.target.value.trim() !== confirmWord; };
    }
  });
}

/** Read a <form> into a plain object (trimmed strings). */
export function formData(form) {
  const out = {};
  for (const [k, v] of new FormData(form).entries()) out[k] = typeof v === 'string' ? v.trim() : v;
  return out;
}

/** Run an async action while showing a loading state on a button. */
export async function withLoading(btn, fn) {
  if (!btn) return fn();
  btn.classList.add('is-loading');
  btn.disabled = true;
  try { return await fn(); } finally { btn.classList.remove('is-loading'); btn.disabled = false; }
}

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function downloadUrl(url) {
  if (typeof window.__lgDownload === 'function') return window.__lgDownload(url);
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Delegated handlers for the few generic buttons (CSP forbids inline onclick=).
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'reload') location.reload();
  if (el.dataset.action === 'print') window.print();
});
