/**
 * LifegenTracker front-end bootstrap: auth gate, layout, router, global search.
 */
import { api } from './api.js';
import { esc, html, raw, icon, toast, avatar, fullName, statusBadge, debounce, errorState, ROLE_LABELS, closeModal } from './ui.js';
import { renderLogin, renderSetup } from './views/auth.js';
import { renderPrivacy, renderPublicPrivacy } from './views/privacy.js';
import { renderDashboard } from './views/dashboard.js';
import { renderPeople } from './views/people.js';
import { renderPersonForm } from './views/personForm.js';
import { renderPerson } from './views/person.js';
import { renderAttendance } from './views/attendance.js';
import { renderHistory, renderServiceDetail } from './views/history.js';
import { renderReports } from './views/reports.js';
import { renderSettings } from './views/settings.js';
import { renderLifegroups, renderLifegroup, renderNetwork } from './views/lifegroups.js';
import { renderRegistrations, renderQrPoster, refreshPendingBadge } from './views/registrations.js';

/** Shown in the sidebar so everyone can tell which build is running. Bump on every release. */
export const APP_VERSION = '2026.10.10-3s';

export const state = {
  user: null,
  settings: { church_name: 'Lifegiver Church of Faith', service_name: 'Lifegen / 3rd Service' },
  demoLoaded: false,
  authDisabled: false,
  standalone: false,
};
export const can = (perm) => Boolean(state.user?.permissions?.includes(perm));
// Feature sections switched on/off by the admin (Settings → Customize). Missing setting = on.
export const moduleOn = (name) => { const v = state.settings?.[`module_${name}`]; return v === undefined || (v !== '0' && v !== 'false' && v !== ''); };
const MODULE_OF_NAV = { lifegroups: 'lifegroups', reports: 'reports', registrations: 'registrations' };

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const routes = [
  { path: /^\/dashboard$/, view: renderDashboard, nav: 'dashboard', perm: 'dashboard:view' },
  { path: /^\/people$/, view: renderPeople, nav: 'people', perm: 'people:view' },
  { path: /^\/people\/new$/, view: (c) => renderPersonForm(c, null), nav: 'people', perm: 'people:write' },
  { path: /^\/people\/(\d+)$/, view: (c, m) => renderPerson(c, m[1]), nav: 'people', perm: 'people:view' },
  { path: /^\/people\/(\d+)\/edit$/, view: (c, m) => renderPersonForm(c, m[1]), nav: 'people', perm: 'people:write' },
  { path: /^\/attendance$/, view: renderAttendance, nav: 'attendance', perm: 'attendance:view' },
  { path: /^\/attendance\/history$/, view: renderHistory, nav: 'attendance', perm: 'attendance:view' },
  { path: /^\/attendance\/history\/(\d+)$/, view: (c, m) => renderServiceDetail(c, m[1]), nav: 'attendance', perm: 'attendance:view' },
  { path: /^\/lifegroups$/, view: renderLifegroups, nav: 'lifegroups', perm: 'lifegroups:view' },
  { path: /^\/lifegroups\/(\d+)$/, view: (c, m) => renderLifegroup(c, m[1]), nav: 'lifegroups', perm: 'lifegroups:view' },
  { path: /^\/networks\/(\d+)$/, view: (c, m) => renderNetwork(c, m[1]), nav: 'lifegroups', perm: 'lifegroups:view' },
  { path: /^\/reports$/, view: renderReports, nav: 'reports', perm: 'reports:view' },
  { path: /^\/registrations$/, view: renderRegistrations, nav: 'registrations', perm: 'registrations:manage' },
  { path: /^\/qr-poster$/, view: renderQrPoster, nav: 'settings', perm: 'registrations:manage' },
  { path: /^\/settings$/, view: renderSettings, nav: 'settings' },
  { path: /^\/privacy$/, view: renderPrivacy, nav: 'settings' },
];

let currentCleanup = null;

async function route() {
  const hashPath = (location.hash.replace(/^#/, '') || '/dashboard').split('?')[0];
  const query = Object.fromEntries(new URLSearchParams((location.hash.split('?')[1] || '')));
  const main = document.getElementById('main');

  if (!state.user) { // auth screens handle themselves — except the public Privacy & Terms page
    const app = document.getElementById('app');
    if (hashPath === '/privacy') { app.className = ''; renderPublicPrivacy(app); }
    else if (app.querySelector('.privacy')) boot();
    return;
  }

  if (typeof currentCleanup === 'function') { try { currentCleanup(); } catch {} }
  currentCleanup = null;
  closeModal();

  const match = routes.map((r) => ({ r, m: hashPath.match(r.path) })).find((x) => x.m);
  if (!match) { location.hash = '#/dashboard'; return; }
  const { r, m } = match;
  if (MODULE_OF_NAV[r.nav] && !moduleOn(MODULE_OF_NAV[r.nav])) { location.hash = '#/dashboard'; return; }
  if (r.perm && !can(r.perm)) {
    main.innerHTML = html`<div class="card"><div class="empty"><div class="empty__icon">${icon('lock', 26)}</div><h3>Restricted</h3><p>Your role (${ROLE_LABELS[state.user.role_id]}) does not have access to this page.</p><a class="btn mt-2" href="#/dashboard">Back to dashboard</a></div></div>`;
    return;
  }
  setActiveNav(r.nav);
  closeSidebar();
  main.innerHTML = '<div class="loading">Loading…</div>';
  window.scrollTo({ top: 0 });
  try {
    const cleanup = await r.view({ main, query, params: m }, m);
    if (typeof cleanup === 'function') currentCleanup = cleanup;
  } catch (err) {
    console.error(err);
    main.innerHTML = errorState(err);
  }
}

function setActiveNav(key) {
  document.querySelectorAll('#nav a[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === key));
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
function navLink(href, key, label, ic, sub = false) {
  const badge = key === 'registrations' ? '<span class="nav__badge" id="navPendingBadge" hidden aria-label="pending registrations"></span>' : '';
  return `<a href="${href}" data-nav="${key}" class="${sub ? 'sub' : ''}">${ic ? icon(ic, 19).value : ''}${esc(label)}${badge}</a>`;
}

function renderShell() {
  const u = state.user;
  const app = document.getElementById('app');
  app.className = 'app';
  app.innerHTML = `
    <header class="topbar">
      <button class="icon-btn" id="menuToggle" aria-label="Open menu">${icon('menu', 22).value}</button>
      <a class="brand brand--compact" href="#/dashboard"><span class="brand__mark">LG</span><span class="brand__text"><strong>LifegenTracker</strong></span></a>
      <span class="topbar__spacer"></span>
      ${can('attendance:write') ? `<a class="btn btn--primary btn--sm" href="#/attendance">${icon('check', 15).value} Attendance</a>` : ''}
    </header>

    <aside class="sidebar" id="sidebar" aria-label="Main navigation">
      <a class="brand" href="#/dashboard">
        <span class="brand__mark">LG</span>
        <span class="brand__text"><strong>LifegenTracker</strong><small>${esc(state.settings.church_name)}</small><small class="brand__ver" title="App version">v${APP_VERSION}</small></span>
      </a>
      <nav class="nav" id="nav">
        <div style="padding:4px 12px 10px">
          <div class="gsearch" id="gsearch">
            ${icon('search', 17).value}
            <input type="search" id="gsearchInput" placeholder="Find a person…" autocomplete="off" aria-label="Search people" />
            <div class="gsearch__results" id="gsearchResults" hidden></div>
          </div>
        </div>
        ${navLink('#/dashboard', 'dashboard', 'Dashboard', 'chart')}
        ${navLink('#/people', 'people', 'People', 'people')}
        ${navLink('#/attendance', 'attendance', 'Attendance', 'check')}
        ${moduleOn('lifegroups') ? navLink('#/lifegroups', 'lifegroups', 'Lifegroups', 'group') : ''}
        ${moduleOn('reports') ? navLink('#/reports', 'reports', 'Reports', 'calendar') : ''}
        ${can('registrations:manage') && moduleOn('registrations') && !state.standalone ? navLink('#/registrations', 'registrations', 'Registrations', 'qr') + '' : ''}
        ${navLink('#/settings', 'settings', 'Settings', 'settings')}
        <a class="nav__foot" href="#/privacy">Privacy &amp; Terms</a>
      </nav>
      <div class="sidebar__user">
        <span class="avatar avatar--sm">${esc(u.display_name.split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase())}</span>
        <div style="min-width:0"><strong class="truncate">${esc(u.display_name)}</strong><small>${state.standalone ? 'Standalone · this device' : state.authDisabled ? 'Open access · sign-in off' : esc(ROLE_LABELS[u.role_id] || u.role_id)}</small></div>
        ${state.authDisabled ? '' : `<button class="icon-btn" id="logoutBtn" title="Sign out" aria-label="Sign out">${icon('logout', 19).value}</button>`}
      </div>
    </aside>
    <div class="backdrop" id="backdrop"></div>
    <main class="main" id="main" tabindex="-1"><div class="loading">Loading…</div></main>`;

  document.getElementById('menuToggle').onclick = () => {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('backdrop').classList.toggle('show');
  };
  document.getElementById('backdrop').onclick = closeSidebar;
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.onclick = async () => {
    await api.logout().catch(() => {});
    state.user = null;
    location.hash = '#/dashboard';
    boot();
  };
  setupGlobalSearch();
  refreshPendingBadge();
}

function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('backdrop')?.classList.remove('show');
}

// ---------------------------------------------------------------------------
// Global search (sidebar)
// ---------------------------------------------------------------------------
function setupGlobalSearch() {
  const input = document.getElementById('gsearchInput');
  const results = document.getElementById('gsearchResults');
  if (!input || !can('people:view')) return;
  let focusIdx = -1;

  const hide = () => { results.hidden = true; focusIdx = -1; };
  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) return hide();
    try {
      const { people } = await api.search(q);
      results.hidden = false;
      if (!people.length) {
        results.innerHTML = `<div class="gsearch__empty">No one found for “${esc(q)}”.${can('people:write') ? ` <a href="#/people/new?name=${encodeURIComponent(q)}">Register new person</a>` : ''}</div>`;
        return;
      }
      results.innerHTML = people.map((p) => html`
        <a class="gsearch__item" href="#/people/${p.id}">
          ${raw(avatar(p, 'sm'))}
          <span style="min-width:0;flex:1"><span class="name truncate" style="display:block">${fullName(p)}</span>
          <span class="small muted">${p.person_code}${p.contact_number ? ' · ' + p.contact_number : ''}</span></span>
          ${raw(statusBadge(p.status))}
        </a>`).join('');
    } catch { hide(); }
  }, 220);

  input.addEventListener('input', run);
  input.addEventListener('focus', () => { if (input.value.trim().length >= 2) run(); });
  input.addEventListener('keydown', (e) => {
    const items = [...results.querySelectorAll('.gsearch__item')];
    if (e.key === 'ArrowDown') { focusIdx = Math.min(items.length - 1, focusIdx + 1); }
    else if (e.key === 'ArrowUp') { focusIdx = Math.max(0, focusIdx - 1); }
    else if (e.key === 'Enter') { if (items[focusIdx]) { items[focusIdx].click(); input.value = ''; hide(); } return; }
    else if (e.key === 'Escape') { hide(); input.blur(); return; }
    else return;
    e.preventDefault();
    items.forEach((el, i) => el.classList.toggle('focus', i === focusIdx));
  });
  results.addEventListener('click', () => { input.value = ''; hide(); });
  document.addEventListener('click', (e) => { if (!e.target.closest('#gsearch')) hide(); });
  // Keyboard shortcut "/" focuses search
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
      e.preventDefault();
      document.getElementById('sidebar').classList.add('open');
      document.getElementById('backdrop').classList.add('show');
      input.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
window.addEventListener('lifegen:settings-changed', async () => {
  try { const st = await api.status(); if (st.user) state.user = st.user; state.settings = st.settings || state.settings; } catch { /* keep current */ }
  renderShell();
  route();
});

export async function boot() {
  const app = document.getElementById('app');
  let status;
  try {
    status = await api.status();
  } catch (err) {
    app.innerHTML = errorState(err);
    return;
  }
  state.settings = status.settings || state.settings;
  state.demoLoaded = status.demo_loaded;
  state.authDisabled = Boolean(status.auth_disabled);
  state.standalone = Boolean(status.standalone);
  document.title = `LifegenTracker · ${state.settings.church_name}`;

  if (status.needs_setup) {
    app.className = '';
    renderSetup(app, (user) => { state.user = user; renderShell(); route(); });
    return;
  }
  if (!status.user) {
    app.className = '';
    if ((location.hash.replace(/^#/, '') || '').split('?')[0] === '/privacy') { renderPublicPrivacy(app); return; }
    renderLogin(app, (user) => { state.user = user; renderShell(); route(); });
    return;
  }
  state.user = status.user;
  renderShell();
  route();
}
// Pending-registration badge: refreshed on every route change (cheap count query, admin only).
window.addEventListener('hashchange', () => refreshPendingBadge());

window.addEventListener('hashchange', route);
// "Skip to content" must not touch the hash router — just move focus into the page
document.getElementById('skipLink')?.addEventListener('click', (e) => { e.preventDefault(); const m = document.getElementById('main'); if (m) { m.setAttribute('tabindex', '-1'); m.focus({ preventScroll: false }); } });
window.addEventListener('auth:expired', () => {
  if (state.user) {
    state.user = null;
    toast('Your session has expired. Please sign in again.', 'info');
    boot();
  }
});
boot();
