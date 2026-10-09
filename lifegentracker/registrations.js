import { api } from '../api.js';
import { state, can } from '../app.js';
import { html, raw, icon, toast, openModal, closeModal, confirmDialog, withLoading, formData, fmtDateTime, emptyState, debounce, downloadUrl } from '../ui.js';

/**
 * QR self-registration — Admin inbox. Pending/rejected rows live only in `registrations`;
 * approving writes the person into the same `people` table the manual form uses.
 */

const STATUS = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected' };
const RISK = {
  fast: ['Filled in under 20 s', 'Very fast — real people usually take longer'],
  same_device: ['Same phone', 'Another registration came from this same phone/browser'],
  ip_burst: ['Burst', '3+ registrations from the same network within 10 minutes'],
  email_numeric: ['Odd email', 'Email has a long run of digits'],
  placeholder_name: ['Placeholder name', 'Looks like a sample name (e.g. Juan Dela Cruz) — verify'],
};
const riskBadges = (r) => raw(String(r.risk_flags || '').split(',').filter(Boolean).map((f) => `<span class="badge badge--nodot reg-flag" title="${RISK[f] ? RISK[f][1] : f}">${RISK[f] ? RISK[f][0] : f}</span>`).join(' '));
const statusBadge = (s) => raw(`<span class="badge badge--nodot ${s === 'pending' ? 'badge--first_timer' : s === 'approved' ? 'badge--regular' : ''}">${STATUS[s] || s}</span>`);

// ---------------------------------------------------------------------------
// Pending badge in the sidebar (admin only; silent on failure)
// ---------------------------------------------------------------------------
let badgeTimer = null;
let lastPending = null; // for the simple in-app "New QR Registration" notice
export async function refreshPendingBadge() {
  const el = document.getElementById('navPendingBadge');
  if (!el || !can('registrations:manage') || state.standalone) return;
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(async () => {
    try {
      const c = await api.registrationCounts();
      el.textContent = c.pending > 99 ? '99+' : String(c.pending);
      el.hidden = !c.pending;
      el.title = `${c.pending} pending registration${c.pending === 1 ? '' : 's'}`;
      if (lastPending !== null && c.pending > lastPending && !location.hash.startsWith('#/registrations')) {
        const n = c.pending - lastPending;
        toast(`New QR Registration — ${n === 1 ? 'someone' : n + ' people'} submitted a new registration.`, 'info', 6000);
      }
      lastPending = c.pending;
    } catch { /* badge is best-effort */ }
  }, 50);
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------
export async function renderRegistrations({ main, query }) {
  const filters = { status: ['pending', 'approved', 'rejected', 'all'].includes(query.status) ? query.status : 'pending', q: query.q || '' };
  main.innerHTML = html`
    <div class="page-header">
      <div><h1>Registrations</h1><p class="sub">People who registered through the QR code. Approve to add them to People.</p></div>
      <div class="page-actions"><a class="btn" href="#/settings?section=qr">${icon('qr')} QR code &amp; rules</a></div>
    </div>
    <div class="toolbar">
      <div class="segmented" id="statusSeg" role="tablist" aria-label="Filter by status">
        ${['pending', 'approved', 'rejected', 'all'].map((s) => html`<button type="button" data-status="${s}" class="${filters.status === s ? 'active' : ''}" role="tab">${s === 'all' ? 'All' : STATUS[s]} <span class="muted" data-count="${s}"></span></button>`)}
      </div>
      <div class="gsearch grow" style="max-width:none">
        ${icon('search', 17)}
        <input type="search" id="q" placeholder="Search name, email, school, leader, ministry or reference" value="${filters.q}" autocomplete="off" aria-label="Search registrations" />
      </div>
    </div>
    <div id="guardBanner"></div>
    <div class="card"><div id="list" class="card__body--flush"><div class="loading">Loading…</div></div></div>`;

  const list = main.querySelector('#list');
  let reqId = 0;
  const selected = new Set();

  async function showGuardBanner() {
    try {
      const g = await api.registrationGuard();
      const el = main.querySelector('#guardBanner');
      if (!el) return;
      if (g.paused_at) {
        el.innerHTML = html`<div class="alert alert--warn" style="margin-bottom:16px;align-items:center">${icon('warn', 18)}<span style="flex:1"><b>QR registration auto-paused</b> — more than ${g.hourly_cap} submissions arrived within an hour (${fmtDateTime(g.paused_at)}). Check the newest rows below; when it looks fine, resume.</span><button class="btn btn--sm btn--primary" id="resumeBtn">Resume registration</button></div>`;
        el.querySelector('#resumeBtn').onclick = (e) => withLoading(e.currentTarget, async () => { try { await api.registrationResume(); toast('Registration resumed.'); showGuardBanner(); } catch (err) { toast(err.message, 'error'); } });
      } else if (!g.open_now) {
        const why = g.closed_reason === 'window' ? `closed until ${g.window_label} (church time now: ${g.church_time})` : g.closed_reason === 'disabled' ? 'switched off in Settings' : g.closed_reason;
        el.innerHTML = html`<p class="small muted" style="margin:-6px 0 14px">The public form is currently <b>${why}</b>. New registrations only come in while it is open.</p>`;
      } else el.innerHTML = '';
    } catch { /* banner is best-effort */ }
  }

  async function load() {
    const id = ++reqId;
    history.replaceState(null, '', '#/registrations' + api.qs({ status: filters.status === 'pending' ? '' : filters.status, q: filters.q }));
    main.querySelectorAll('#statusSeg button').forEach((b) => b.classList.toggle('active', b.dataset.status === filters.status));
    list.innerHTML = '<div class="loading">Loading…</div>';
    let data;
    try { data = await api.registrations({ status: filters.status, q: filters.q }); }
    catch (err) { list.innerHTML = html`<div class="alert alert--error" style="margin:16px">${err.message}</div>`; return; }
    if (id !== reqId) return;
    const c = data.counts;
    for (const [k, v] of Object.entries({ pending: c.pending, approved: c.approved, rejected: c.rejected, all: c.total })) {
      const el = main.querySelector(`[data-count="${k}"]`); if (el) el.textContent = v ? `(${v})` : '';
    }
    refreshPendingBadge();

    if (!data.items.length) {
      list.innerHTML = emptyState({
        icon: 'inbox',
        title: filters.q ? 'No registrations match' : filters.status === 'pending' ? 'No pending registrations' : `No ${filters.status === 'all' ? '' : filters.status + ' '}registrations`,
        text: filters.q ? 'Try a different name, email or school.' : filters.status === 'pending'
          ? 'New registrations from the QR code will appear here for your review.' : 'Nothing here yet.',
        action: filters.status === 'pending' && !filters.q ? '<a class="btn" href="#/settings?section=qr">Show the QR code</a>' : '',
      });
      return;
    }
    list.innerHTML = html`
      <div class="table-wrap"><table class="table table--stack table--wide">
        <thead><tr><th style="width:28px"><input type="checkbox" id="selAll" aria-label="Select all pending on this page" /></th><th>Name</th><th>Email</th><th>Age · School</th><th>Leader</th><th>Ministry</th><th>Submitted</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${data.items.map((r) => html`<tr class="clickable" data-id="${r.id}">
            <td data-label="">${r.status === 'pending' ? html`<input type="checkbox" data-sel="${r.id}" aria-label="Select ${r.full_name}" ${selected.has(r.id) ? 'checked' : ''} />` : ''}</td>
            <td data-label="Name" class="nowrap"><div class="name">${r.full_name}</div><div class="code">${r.ref_code || ''}${r.possible_duplicate ? raw(' <span class="badge badge--nodot reg-flag" title="Same name as someone already registered">Possible duplicate</span>') : ''} ${riskBadges(r)}</div></td>
            <td data-label="Email" class="small nowrap">${r.email}</td>
            <td data-label="Age · School" class="small">${r.age} · ${r.school}</td>
            <td data-label="Leader" class="small nowrap">${r.leader_name}<br><span class="muted">${r.network_leader_name}</span></td>
            <td data-label="Ministry" class="small">${r.ministry}</td>
            <td data-label="Submitted" class="small nowrap">${fmtDateTime(r.submitted_at)}</td>
            <td data-label="Status">${statusBadge(r.status)}${r.status === 'approved' && r.person_code ? html`<div class="code"><a href="#/people/${r.person_id}">${r.person_code}</a></div>` : ''}</td>
            <td data-label="" style="white-space:nowrap;text-align:right">
              <button class="btn btn--sm" data-view="${r.id}">View</button>
              ${r.status === 'pending' ? html` <button class="btn btn--sm btn--primary" data-approve="${r.id}">Approve</button>` : ''}
            </td>
          </tr>`)}
        </tbody>
      </table></div>
      <div class="card__footer row row--between" style="gap:8px;flex-wrap:wrap"><span class="small muted">Showing ${data.items.length} registration${data.items.length === 1 ? '' : 's'}</span>
        <span class="row" style="gap:8px;align-items:center"><span class="small muted" id="selCount" hidden></span><button class="btn btn--sm btn--danger-ghost" id="bulkReject" hidden>Reject selected…</button></span></div>`;
    const syncBulk = () => {
      const n = selected.size; const b = list.querySelector('#bulkReject'); const c = list.querySelector('#selCount');
      if (b) b.hidden = !n; if (c) { c.hidden = !n; c.textContent = `${n} selected`; }
    };
    list.querySelectorAll('[data-sel]').forEach((cb) => { cb.onclick = (e) => e.stopPropagation(); cb.onchange = () => { const id = Number(cb.dataset.sel); if (cb.checked) selected.add(id); else selected.delete(id); syncBulk(); }; });
    const selAll = list.querySelector('#selAll');
    if (selAll) selAll.onchange = () => { list.querySelectorAll('[data-sel]').forEach((cb) => { cb.checked = selAll.checked; const id = Number(cb.dataset.sel); if (selAll.checked) selected.add(id); else selected.delete(id); }); syncBulk(); };
    list.querySelector('#bulkReject').onclick = () => bulkRejectDialog([...selected], () => { selected.clear(); load(); });
    syncBulk();
    list.querySelectorAll('[data-view]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); openRegistration(Number(b.dataset.view), load); }; });
    list.querySelectorAll('[data-approve]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); openRegistration(Number(b.dataset.approve), load, { approve: true }); }; });
    list.querySelectorAll('tr.clickable').forEach((tr) => { tr.onclick = () => openRegistration(Number(tr.dataset.id), load); });
  }

  main.querySelector('#statusSeg').onclick = (e) => { const b = e.target.closest('button[data-status]'); if (b) { filters.status = b.dataset.status; selected.clear(); load(); } };
  main.querySelector('#q').addEventListener('input', debounce((e) => { filters.q = e.target.value.trim(); load(); }, 250));
  showGuardBanner();
  load();
}

const BLOCK_OPTS = (showIp = true) => html`
  <fieldset class="stack" style="border:0;padding:0;margin:0;gap:6px">
    <legend class="small" style="font-weight:600;margin-bottom:4px">Also block (stops them from registering again)</legend>
    <label class="toggle"><input type="checkbox" name="block_email" /><span>This email address</span></label>
    <label class="toggle"><input type="checkbox" name="block_device" /><span>This phone / browser <span class="muted">(same-device lock)</span></span></label>
    ${showIp ? html`<label class="toggle"><input type="checkbox" name="block_ip" /><span>This network / IP <span class="muted">— careful: the church Wi-Fi is shared by everyone</span></span></label>` : ''}
  </fieldset>`;

function bulkRejectDialog(ids, done) {
  const modal = openModal({
    title: `Reject ${ids.length} registration${ids.length === 1 ? '' : 's'}`,
    body: html`<form id="bulkForm" class="stack" novalidate>
      <p class="small">Use this for troll bursts and obvious fakes. The rows move to Rejected (they stay visible for the audit trail) and none of them reach People.</p>
      <div class="field"><label>Reason <span class="opt">optional</span></label><input name="note" maxlength="200" placeholder="e.g. spam burst / fake names" /></div>
      ${BLOCK_OPTS(false)}
    </form>`.toString(),
    footer: `<button class="btn" data-close>Cancel</button><button class="btn btn--danger" form="bulkForm" type="submit">Reject ${ids.length}</button>`,
  });
  modal.querySelector('[data-close]:not(.icon-btn)').onclick = closeModal;
  modal.querySelector('#bulkForm').onsubmit = (e) => { e.preventDefault(); withLoading(modal.querySelector('.btn--danger'), async () => {
    const f = e.target;
    try {
      const out = await api.bulkRejectRegistrations(ids, f.note.value, { block_email: f.block_email.checked, block_device: f.block_device.checked });
      closeModal(); toast(`${out.rejected} rejected${out.skipped ? `, ${out.skipped} skipped (not pending)` : ''}.`, 'info'); await done?.(); refreshPendingBadge();
    } catch (err) { toast(err.message, 'error'); }
  }); };
}

// ---------------------------------------------------------------------------
// Detail modal: view / approve / link / reject / edit / delete
// ---------------------------------------------------------------------------
async function openRegistration(id, reload, opts = {}) {
  let r;
  try { r = await api.registration(id); } catch (err) { toast(err.message, 'error'); return; }
  const rv = r.review || {};
  const pending = r.status === 'pending';
  const row = (k, v) => html`<div><dt>${k}</dt><dd>${v ?? '—'}</dd></div>`;
  const modal = openModal({
    title: r.full_name,
    subtitle: `${r.ref_code || ''} · QR Registration · ${fmtDateTime(r.submitted_at)}`,
    wide: true,
    body: html`
      <div class="stack">
        <div class="row row--between" style="gap:8px;flex-wrap:wrap">${statusBadge(r.status)}${r.possible_duplicate ? raw('<span class="badge badge--nodot reg-flag">Possible duplicate</span>') : ''}${riskBadges(r)}
          ${r.status !== 'pending' && r.reviewed_by_name ? html`<span class="small muted">${r.status === 'approved' ? 'Approved' : 'Rejected'} by ${r.reviewed_by_name} · ${fmtDateTime(r.approved_at || r.rejected_at)}</span>` : ''}</div>
        ${r.review_note ? html`<div class="alert alert--info">${icon('info', 18)}<span>Note: ${r.review_note}</span></div>` : ''}
        <dl class="review-grid">
          ${row('Full name', r.full_name)}${row('Email', r.email)}${row('Age', r.age)}${row('School', r.school)}
          ${row('Ministry', r.ministry)}${row('Leader', r.leader_name)}${row('Network leader', r.network_leader_name)}
          ${r.person_code ? row('Person record', html`<a href="#/people/${r.person_id}">${r.person_code}</a>`) : ''}
          ${row('Form time', r.form_seconds != null ? `${r.form_seconds} s` : '—')}${row('Device', r.device_id ? html`<span class="code" title="Anonymous device id (cookie) — not personal data">${r.device_id.slice(0, 8)}…</span>` : '—')}
        </dl>
        ${rv.same_email ? html`<div class="alert alert--warn">${icon('warn', 18)}<span>This email already belongs to <a href="#/people/${rv.same_email.id}">${rv.same_email.first_name} ${rv.same_email.last_name} (${rv.same_email.person_code})</a>.</span></div>` : ''}
        ${pending && rv.same_name && rv.same_name.length ? html`<div class="alert alert--warn" style="flex-direction:column;gap:6px">
            <div class="row" style="gap:8px">${icon('warn', 18)}<b>Same name already in People — is this the same person?</b></div>
            ${rv.same_name.map((p) => html`<div class="row row--between" style="gap:8px;width:100%"><span><a href="#/people/${p.id}">${p.first_name} ${p.last_name}</a> <span class="code">${p.person_code}</span> · ${p.email || 'no email'} · ${p.school || ''}</span>
              ${!p.email || p.email.toLowerCase() === r.email.toLowerCase() ? html`<button class="btn btn--sm" data-link="${p.id}">${icon('link', 14)} Link to this person</button>` : html`<span class="small muted">different email</span>`}</div>`)}
            <span class="small">“Link” fills the blanks of the existing record (email, school, age, ministry) instead of creating a duplicate. “Approve” creates a new person.</span>
          </div>` : ''}
        ${pending && rv.matching_groups && rv.matching_groups.length ? html`<p class="small muted">Leader “${r.leader_name}” matches Lifegroup ${rv.matching_groups.map((g) => html`<a href="#/lifegroups/${g.id}">${g.name}</a>`)} — you can assign them after approving.</p>` : ''}
        ${pending ? html`<div class="field"><label for="approveStatus">Status after approval</label>
          <select id="approveStatus" style="max-width:260px"><option value="first_timer">First Timer (default)</option><option value="returning">Returning</option><option value="regular">Regular</option></select>
          <span class="help">Contact number is not asked on the QR form — staff can add it on the person's profile later.</span></div>` : ''}
      </div>`,
    footer: html`
      <div class="row" style="gap:8px;flex-wrap:wrap;width:100%">
        ${pending ? html`<button class="btn btn--danger-ghost" data-reject>Reject</button><button class="btn" data-edit>${icon('edit', 14)} Edit</button>` : ''}
        ${r.status !== 'approved' ? html`<button class="btn btn--danger-ghost" data-delete>${icon('trash', 14)} Delete</button>` : ''}
        <span style="flex:1"></span>
        <button class="btn" data-close>Close</button>
        ${pending ? html`<button class="btn btn--primary" data-approve>${icon('check', 14)} Approve &amp; add to People</button>` : ''}
      </div>`.toString(),
  });
  const done = async (msg) => { closeModal(); toast(msg); await reload?.(); refreshPendingBadge(); };
  modal.querySelector('[data-close]:not(.icon-btn)')?.addEventListener('click', closeModal);
  modal.querySelector('[data-approve]')?.addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
    try {
      const out = await api.approveRegistration(id, { mode: 'create', status: modal.querySelector('#approveStatus')?.value });
      await done(`${r.full_name} added to People (${out.person_code || 'new record'}).`);
    } catch (err) { toast(err.message, 'error'); }
  }));
  modal.querySelectorAll('[data-link]').forEach((b) => b.addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
    const ok = await confirmDialog({ title: 'Link to existing person?', message: 'The registration will be marked approved and the existing record keeps its ID, status and attendance. Only empty fields are filled in.', confirmText: 'Link' });
    if (!ok) return;
    try { await api.approveRegistration(id, { mode: 'link', person_id: Number(b.dataset.link) }); await done('Linked to the existing person.'); }
    catch (err) { toast(err.message, 'error'); }
  })));
  modal.querySelector('[data-reject]')?.addEventListener('click', () => rejectDialog(r, reload));
  modal.querySelector('[data-edit]')?.addEventListener('click', () => editDialog(r, reload));
  modal.querySelector('[data-delete]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Delete this registration?', message: `${r.full_name} (${r.ref_code}) will be removed permanently. They can register again with the same email afterwards.`, confirmText: 'Delete', danger: true });
    if (!ok) return;
    try { await api.deleteRegistration(id); await done('Registration deleted.'); } catch (err) { toast(err.message, 'error'); }
  });
  if (opts.approve) modal.querySelector('[data-approve]')?.focus();
}

function rejectDialog(r, reload) {
  const modal = openModal({
    title: 'Reject registration', subtitle: `${r.full_name} · ${r.ref_code}`,
    body: html`<form id="rejectForm" class="stack" novalidate>
      <p class="small">The person will not be added to People. The row stays in the Rejected list so you can see why later.</p>
      <div class="field"><label>Reason <span class="opt">optional</span></label><input name="note" maxlength="200" placeholder="e.g. Duplicate of LG-2026-0012 / test entry" /></div>
      ${BLOCK_OPTS(true)}
    </form>`.toString(),
    footer: '<button class="btn" data-close>Cancel</button><button class="btn btn--danger" form="rejectForm" type="submit">Reject</button>',
  });
  modal.querySelector('[data-close]:not(.icon-btn)').onclick = closeModal;
  modal.querySelector('#rejectForm').onsubmit = (e) => { e.preventDefault(); withLoading(modal.querySelector('.btn--danger'), async () => {
    const f = e.target;
    try { await api.rejectRegistration(r.id, f.note.value, { block_email: f.block_email.checked, block_device: f.block_device.checked, block_ip: f.block_ip.checked }); closeModal(); toast('Registration rejected.', 'info'); await reload?.(); refreshPendingBadge(); }
    catch (err) { toast(err.message, 'error'); }
  }); };
}

function editDialog(r, reload) {
  const ministries = String(state.settings.qr_ministries || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  const modal = openModal({
    title: 'Edit registration', subtitle: `${r.ref_code} · same rules as the public form`,
    body: html`<form id="editReg" class="form-grid" novalidate>
      <div class="field span-2"><label>Full name <span class="req">*</span></label><input name="full_name" value="${r.full_name}" required maxlength="120" /></div>
      <div class="field"><label>Email <span class="req">*</span></label><input name="email" type="email" value="${r.email}" required maxlength="160" /></div>
      <div class="field"><label>Age <span class="req">*</span></label><input name="age" type="number" min="5" max="100" step="1" value="${r.age}" required /></div>
      <div class="field span-2"><label>School <span class="req">*</span></label><input name="school" value="${r.school}" required maxlength="120" /></div>
      <div class="field"><label>Leader <span class="req">*</span></label><input name="leader_name" value="${r.leader_name}" required maxlength="120" /></div>
      <div class="field"><label>Network leader <span class="req">*</span></label><input name="network_leader_name" value="${r.network_leader_name}" required maxlength="120" /></div>
      <div class="field span-2"><label>Ministry <span class="req">*</span></label>
        ${ministries.length ? html`<select name="ministry">${ministries.map((m) => html`<option value="${m}" ${m === r.ministry ? 'selected' : ''}>${m}</option>`)}</select>` : html`<input name="ministry" value="${r.ministry}" required />`}
      </div>
    </form>`.toString(),
    footer: '<button class="btn" data-close>Cancel</button><button class="btn btn--primary" form="editReg" type="submit">Save</button>',
  });
  modal.querySelector('[data-close]:not(.icon-btn)').onclick = closeModal;
  modal.querySelector('#editReg').onsubmit = (e) => { e.preventDefault(); withLoading(modal.querySelector('.btn--primary'), async () => {
    try { await api.updateRegistration(r.id, formData(e.target)); closeModal(); toast('Registration updated.'); await reload?.(); }
    catch (err) { toast(err.details && typeof err.details === 'object' ? Object.values(err.details)[0] : err.message, 'error'); }
  }); };
}

// ---------------------------------------------------------------------------
// QR card (used inside Settings) + printable poster
// ---------------------------------------------------------------------------
export async function renderQrCard(card) {
  card.innerHTML = html`<div class="card__header"><h2>QR registration</h2><a class="btn btn--sm" href="#/registrations">${icon('inbox', 14)} Inbox</a></div><div class="card__body"><div class="loading">Loading…</div></div>`;
  let qr, g;
  try { [qr, g] = await Promise.all([api.qrRegistration(), api.registrationGuard()]); } catch (err) { card.querySelector('.card__body').innerHTML = html`<div class="alert alert--error">${err.message}</div>`; return; }
  const s = state.settings;
  const on = (k) => s[k] !== '0';
  const rotating = g.mode === 'rotating';
  const stateLine = g.paused_at ? ['warn', `Auto-paused since ${fmtDateTime(g.paused_at)} — more than ${g.hourly_cap} submissions in an hour.`]
    : !on('qr_registration_enabled') ? ['info', 'Registration is switched off.']
    : g.open_until ? ['info', `Open now (manual override) until ${fmtDateTime(g.open_until)}.`]
    : g.open_now ? ['info', `Open right now${g.window === 'sunday' ? ` — Sunday window ${g.window_label.replace('Sunday, ', '')}` : ' (always open)'}.`]
    : ['info', `Closed right now. Opens every ${g.window_label}. Church time: ${g.church_time}.`];
  card.querySelector('.card__body').innerHTML = html`
    <div class="alert alert--${stateLine[0]}" style="align-items:center;flex-wrap:wrap;gap:8px">${icon(stateLine[0] === 'warn' ? 'warn' : 'info', 18)}<span style="flex:1">${stateLine[1]}</span>
      ${g.paused_at ? html`<button class="btn btn--sm btn--primary" id="qrResume">Resume</button>` : ''}
      ${!g.paused_at && on('qr_registration_enabled') && g.window === 'sunday' && !g.open_until ? html`<button class="btn btn--sm" id="qrOpenNow" title="Open the form outside the Sunday window, e.g. for a special event">Open now for 3 h</button>` : ''}
      ${g.open_until ? html`<button class="btn btn--sm" id="qrCloseNow">End override</button>` : ''}
    </div>
    <div class="row" style="gap:20px;align-items:flex-start;flex-wrap:wrap">
      <div class="qr-preview" id="qrPreview" aria-label="Registration QR code">${raw(qr.svg)}</div>
      <div class="stack" style="flex:1;min-width:220px">
        ${rotating
          ? html`<p class="small"><b>Rotating QR</b> — this code works only until <b>Sunday ${qr.valid_through}</b>. Print a fresh one every week (or tap “New QR code” to invalidate the current print immediately). The QR still contains only a link — never personal data.</p>`
          : html`<p class="small"><b>Reusable QR</b> — print it once and post it at the venue. The QR contains only this link, never personal data. Changing the rules below does not change the QR, so the same print keeps working.</p>`}
        <div class="qr-url" id="qrUrl">${qr.url}</div>
        ${!qr.custom_url ? html`<span class="small muted">This is the address people are using right now. If the app is reached through a different domain, set the public URL below so the QR points there.</span>` : ''}
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <button class="btn btn--sm" id="qrCopy">${icon('copy', 14)} Copy link</button>
          <button class="btn btn--sm" id="qrPng">${icon('download', 14)} Download PNG</button>
          <a class="btn btn--sm" href="#/qr-poster">${icon('print', 14)} Print poster</a>
          <a class="btn btn--sm" href="${qr.url.replace(/^https?:\/\/[^/]+/, '')}" target="_blank" rel="noopener">Open form</a>
          ${rotating ? html`<button class="btn btn--sm btn--danger-ghost" id="qrRotate">${icon('undo', 14)} New QR code</button>` : ''}
        </div>
      </div>
    </div>
    <hr class="sep" />
    <form id="qrRules" class="stack" novalidate>
      <h3 style="font-size:.95rem">Registration rules</h3>
      <label class="toggle" style="align-items:flex-start"><input type="checkbox" name="qr_registration_enabled" ${on('qr_registration_enabled') ? 'checked' : ''} /><span>Allow new registrations<br><span class="small muted">Off = the form shows “Registration is currently unavailable”.</span></span></label>
      <label class="toggle" style="align-items:flex-start"><input type="checkbox" name="qr_require_approval" ${on('qr_require_approval') ? 'checked' : ''} /><span>Require admin approval before adding to People<br><span class="small muted">Recommended. Off = each registration becomes a person immediately.</span></span></label>
      <label class="toggle" style="align-items:flex-start"><input type="checkbox" name="qr_name_duplicate_check" ${on('qr_name_duplicate_check') ? 'checked' : ''} /><span>Flag same-name registrations for review<br><span class="small muted">Email uniqueness is always enforced regardless (Gmail dots and +tags count as the same inbox).</span></span></label>
      <label class="toggle" style="align-items:flex-start"><input type="checkbox" name="qr_show_leaders" ${on('qr_show_leaders') ? 'checked' : ''} /><span>Suggest active leader names on the form<br><span class="small muted">Names only — no contact details.</span></span></label>

      <h3 style="font-size:.95rem;margin-top:8px">Anti-fake protection</h3>
      <div class="form-grid">
        <div class="field"><label>QR mode</label>
          <select name="qr_mode"><option value="reusable" ${!rotating ? 'selected' : ''}>Reusable — one print, works every week</option><option value="rotating" ${rotating ? 'selected' : ''}>Rotating — new code every week (Mon–Sun)</option></select>
          <span class="help">Rotating stops photos of the poster from being reused later. Use the Print poster button each week.</span></div>
        <div class="field"><label>When the form is open</label>
          <select name="qr_window"><option value="sunday" ${g.window === 'sunday' ? 'selected' : ''}>Sundays only, between the times below</option><option value="always" ${g.window === 'always' ? 'selected' : ''}>Always open</option></select>
          <span class="help">Church time zone: <code>${g.timezone}</code> · now ${g.church_time}</span></div>
        <div class="field"><label>Opens at</label><input name="qr_window_start" type="time" value="${g.window_start}" required /></div>
        <div class="field"><label>Closes at</label><input name="qr_window_end" type="time" value="${g.window_end}" required /></div>
        <div class="field span-2"><label class="toggle" style="align-items:flex-start"><input type="checkbox" name="qr_device_lock" ${g.device_lock ? 'checked' : ''} /><span>One registration per phone / browser<br><span class="small muted">The second attempt from the same phone shows the earlier reference instead of creating another entry. Rejected entries free the phone again.</span></span></label></div>
        <div class="field"><label>Auto-pause after</label><div class="row" style="gap:8px;align-items:center"><input name="qr_hourly_cap" type="number" min="0" max="9999" step="1" value="${g.hourly_cap}" style="max-width:110px" /><span class="small muted">submissions per hour (0 = off). Last hour: <b>${g.last_hour}</b></span></div></div>
        <div class="field"><label>Per-network limit</label><div class="row" style="gap:8px;align-items:center"><input name="qr_ip_daily_cap" type="number" min="0" max="9999" step="1" value="${g.ip_daily_cap}" style="max-width:110px" /><span class="small muted">per IP per day (church Wi-Fi is shared — keep it generous; 0 = off)</span></div></div>
      </div>
      <p class="small muted" style="margin:0">Always on: real-name checks (no “test”, “asdf”, repeated letters, one-word names), temporary-email domains rejected, mistyped domains (gmail.con) caught, a form that was open for less than a few seconds is refused, per-IP rate limit, honeypot field.</p>

      <div class="field"><label>Ministry choices</label><textarea name="qr_ministries" rows="5" placeholder="One per line">${String(s.qr_ministries || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean).join('\n')}</textarea><span class="help">Shown as the Ministry dropdown on the form.</span></div>
      <div class="field"><label>Public URL <span class="opt">optional</span></label><input name="qr_public_url" value="${s.qr_public_url || ''}" placeholder="https://lifegen.yourchurch.org" autocomplete="off" /><span class="help">Only needed when the address above is not the one people will use (e.g. a custom domain). <code>/register</code> is added automatically.</span></div>
      <div class="form-actions"><button class="btn btn--primary" type="submit">Save rules</button></div>
    </form>
    <hr class="sep" />
    <div id="qrBlocks"><div class="loading">Loading blocklist…</div></div>`;
  const rerender = async () => { try { const st = await api.status(); if (st.settings) Object.assign(state.settings, st.settings); } catch { /* ignore */ } renderQrCard(card); };
  card.querySelector('#qrCopy').onclick = async (e) => {
    try { await navigator.clipboard.writeText(qr.url); toast('Link copied.'); }
    catch { const r = document.createRange(); r.selectNodeContents(card.querySelector('#qrUrl')); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast('Press Ctrl/Cmd+C to copy the selected link.', 'info'); }
  };
  card.querySelector('#qrPng').onclick = (e) => withLoading(e.currentTarget, async () => {
    try {
      const blob = await api.blob('/api/qr/registration.png?size=1024');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = rotating ? `lifegen-registration-qr-${qr.valid_through}.png` : 'lifegen-registration-qr.png'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err) { toast(err.message, 'error'); }
  });
  card.querySelector('#qrResume')?.addEventListener('click', (e) => withLoading(e.currentTarget, async () => { try { await api.registrationResume(); toast('Registration resumed.'); rerender(); } catch (err) { toast(err.message, 'error'); } }));
  card.querySelector('#qrOpenNow')?.addEventListener('click', (e) => withLoading(e.currentTarget, async () => { try { await api.registrationOpenNow(3); toast('Form is open for the next 3 hours.'); rerender(); } catch (err) { toast(err.message, 'error'); } }));
  card.querySelector('#qrCloseNow')?.addEventListener('click', (e) => withLoading(e.currentTarget, async () => { try { await api.registrationOpenNow(0); toast('Override ended — back to the Sunday schedule.', 'info'); rerender(); } catch (err) { toast(err.message, 'error'); } }));
  card.querySelector('#qrRotate')?.addEventListener('click', async (e) => {
    const ok = await confirmDialog({ title: 'Generate a new QR code?', message: 'Every printed or shared copy of the current code stops working immediately. Print and post the new poster afterwards.', confirmText: 'New QR code', danger: true });
    if (!ok) return;
    withLoading(e.currentTarget, async () => { try { await api.registrationRotate(); toast('New QR code generated — print the new poster.'); rerender(); } catch (err) { toast(err.message, 'error'); } });
  });
  card.querySelector('#qrRules').onsubmit = (e) => { e.preventDefault(); withLoading(e.target.querySelector('button[type=submit]'), async () => {
    const f = e.target;
    const body = {
      qr_registration_enabled: f.qr_registration_enabled.checked ? '1' : '0',
      qr_require_approval: f.qr_require_approval.checked ? '1' : '0',
      qr_name_duplicate_check: f.qr_name_duplicate_check.checked ? '1' : '0',
      qr_show_leaders: f.qr_show_leaders.checked ? '1' : '0',
      qr_mode: f.qr_mode.value, qr_window: f.qr_window.value,
      qr_window_start: f.qr_window_start.value || '12:00', qr_window_end: f.qr_window_end.value || '17:00',
      qr_device_lock: f.qr_device_lock.checked ? '1' : '0',
      qr_hourly_cap: String(Math.max(0, Number(f.qr_hourly_cap.value) || 0)), qr_ip_daily_cap: String(Math.max(0, Number(f.qr_ip_daily_cap.value) || 0)),
      qr_ministries: f.qr_ministries.value.split(/[,\n]/).map((x) => x.trim()).filter(Boolean).join(', '),
      qr_public_url: f.qr_public_url.value.trim(),
    };
    if (!body.qr_ministries) return toast('Add at least one ministry choice.', 'error');
    if (body.qr_window === 'sunday' && body.qr_window_start >= body.qr_window_end) return toast('“Opens at” must be earlier than “Closes at”.', 'error');
    try { Object.assign(state.settings, await api.saveSettings(body)); toast('Registration rules saved.'); renderQrCard(card); }
    catch (err) { toast(err.message, 'error'); }
  }); };
  renderBlocklist(card.querySelector('#qrBlocks'));
}

const BLOCK_KIND = { email: 'Email', domain: 'Email domain', device: 'Phone / browser', ip: 'Network (IP)' };
async function renderBlocklist(box) {
  let items;
  try { items = (await api.registrationBlocks()).items; } catch (err) { box.innerHTML = html`<div class="alert alert--error">${err.message}</div>`; return; }
  box.innerHTML = html`
    <h3 style="font-size:.95rem">Blocklist <span class="muted" style="font-weight:400">(${items.length})</span></h3>
    <p class="small muted" style="margin-top:0">Blocked emails, domains, phones and networks cannot submit the form — they see a generic “please approach the team” message. Phones and networks are added from a registration’s Reject dialog; emails and domains can also be added here.</p>
    <form id="blockAdd" class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end" novalidate>
      <div class="field" style="margin:0"><label>Type</label><select name="kind"><option value="email">Email</option><option value="domain">Email domain</option></select></div>
      <div class="field grow" style="margin:0;min-width:200px"><label>Value</label><input name="value" placeholder="name@gmail.com or example.com" autocomplete="off" required /></div>
      <div class="field grow" style="margin:0;min-width:160px"><label>Reason <span class="opt">optional</span></label><input name="reason" maxlength="200" /></div>
      <button class="btn" type="submit">Block</button>
    </form>
    ${items.length ? html`<div class="table-wrap" style="margin-top:12px"><table class="table table--stack">
      <thead><tr><th>Type</th><th>Value</th><th>Reason</th><th>Added</th><th></th></tr></thead>
      <tbody>${items.map((b) => html`<tr>
        <td data-label="Type">${BLOCK_KIND[b.kind] || b.kind}</td>
        <td data-label="Value" class="code">${b.kind === 'device' || b.kind === 'ip' ? b.value.slice(0, 10) + '…' : b.value}${b.linked ? html` <span class="small muted">· ${b.linked} registration${b.linked === 1 ? '' : 's'}</span>` : ''}</td>
        <td data-label="Reason" class="small">${b.reason || '—'}</td>
        <td data-label="Added" class="small muted">${fmtDateTime(b.created_at)}${b.created_by_name ? ` · ${b.created_by_name}` : ''}</td>
        <td style="text-align:right"><button class="btn btn--sm" data-unblock="${b.id}">Unblock</button></td></tr>`)}</tbody>
    </table></div>` : html`<p class="small muted" style="margin:10px 0 0">Nothing blocked yet.</p>`}`;
  box.querySelector('#blockAdd').onsubmit = (e) => { e.preventDefault(); withLoading(e.target.querySelector('button'), async () => {
    const f = e.target;
    try { await api.addRegistrationBlock({ kind: f.kind.value, value: f.value.value, reason: f.reason.value }); toast('Blocked.', 'info'); renderBlocklist(box); }
    catch (err) { toast(err.message, 'error'); }
  }); };
  box.querySelectorAll('[data-unblock]').forEach((b) => { b.onclick = (e) => withLoading(e.currentTarget, async () => {
    try { await api.removeRegistrationBlock(Number(b.dataset.unblock)); toast('Unblocked.'); renderBlocklist(box); } catch (err) { toast(err.message, 'error'); }
  }); });
}

export async function renderQrPoster({ main }) {
  main.innerHTML = '<div class="loading">Preparing poster…</div>';
  let qr;
  try { qr = await api.qrRegistration(); } catch (err) { main.innerHTML = html`<div class="alert alert--error">${err.message}</div>`; return; }
  document.body.classList.add('printing-poster');
  main.innerHTML = html`
    <div class="page-header no-print">
      <div><h1>Print QR poster</h1><p class="sub">A4 / Letter. Print or save as PDF from the browser dialog.</p></div>
      <div class="page-actions"><a class="btn" href="#/settings?section=qr">${icon('back')} Back</a><button class="btn btn--primary" data-action="print">${icon('print')} Print</button></div>
    </div>
    <div class="qr-poster">
      <div class="qr-poster__kicker">${state.settings.church_name}</div>
      <div class="small muted" style="margin-top:6px">LifegenTracker · Lifegen Registration</div>
      <h1>LIFEGEN</h1>
      <h2>NEW HERE?</h2>
      <div class="qr-poster__code" aria-label="QR code to the registration form">${raw(qr.svg)}</div>
      <p><b>Scan to Register</b></p>
      <p>Register your basic information with Lifegen.</p>
      <p class="small muted">Please complete the registration form on your phone.</p>
      <p class="qr-poster__url">${qr.url}</p>
      ${qr.valid_through ? html`<p class="small muted">This code is valid until Sunday, ${qr.valid_through}. Registration opens during Lifegen service.</p>` : ''}
      <div class="qr-poster__foot">${state.settings.service_name} · Sundays</div>
    </div>`;
  const cleanup = () => { document.body.classList.remove('printing-poster'); window.removeEventListener('hashchange', cleanup); };
  window.addEventListener('hashchange', cleanup);
}
