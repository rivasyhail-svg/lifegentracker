import { api } from '../api.js';
import { can, state } from '../app.js';
import { html, raw, icon, avatar, fullName, statusBadge, classBadge, fmtDate, fmtTime, toISODate, lastSunday, isSundayStr, addDays, toast, openModal, closeModal, confirmDialog, promptDialog, withLoading, emptyState, debounce } from '../ui.js';
import { personFormHtml, bindPhotoPicker, collectPerson, duplicateGuard } from './personForm.js';

/**
 * Sunday attendance — built to be the fastest screen in the system.
 *   search → tap PRESENT. That's it.
 * The Sunday record is created automatically on the first mark; tapping a
 * green PRESENT again removes the mark (after confirmation) so staff can fix
 * mistakes without touching history elsewhere.
 */
export async function renderAttendance({ main, query }) {
  const canWrite = can('attendance:write');
  let writable = canWrite;          // false when the Sunday lock closes this date for this user
  let lock = { live: true, can_correct: false, message: '' };
  const correction = () => canWrite && !lock.live && lock.can_correct;
  const today = toISODate(new Date());
  let date = query.date && isSundayStr(query.date) ? query.date : toISODate(lastSunday());
  let service = null;   // { id, present_count, ..., roster } — id is null until the first mark
  let filter = 'all';
  let search = '';

  main.innerHTML = html`
    <div class="page-header">
      <div><h1>Lifegen Attendance</h1><p class="sub" id="dateLabel"></p></div>
      <div class="page-actions date-nav">
        <button class="icon-btn" id="prevSunday" title="Previous Sunday" aria-label="Previous Sunday">${icon('chevL', 20)}</button>
        <input type="date" id="dateInput" value="${date}" max="${today}" aria-label="Sunday date" />
        <button class="icon-btn" id="nextSunday" title="Next Sunday" aria-label="Next Sunday">${icon('chevR', 20)}</button>
        <a class="btn" href="#/attendance/history">History</a>
      </div>
    </div>
    <div id="content"><div class="loading">Loading…</div></div>`;

  const content = main.querySelector('#content');
  const dateInput = main.querySelector('#dateInput');
  const dateLabel = main.querySelector('#dateLabel');

  const setDate = (d) => {
    if (d > today) { toast('Future Sundays cannot be recorded yet.', 'info'); return; }
    date = d; dateInput.value = d;
    history.replaceState(null, '', `#/attendance?date=${d}`);
    load();
  };
  main.querySelector('#prevSunday').onclick = () => setDate(addDays(date, -7));
  main.querySelector('#nextSunday').onclick = () => setDate(addDays(date, 7));
  dateInput.onchange = () => {
    const v = dateInput.value;
    if (!v) return;
    if (!isSundayStr(v)) {
      const snapped = toISODate(lastSunday(new Date(v + 'T12:00:00')));
      toast(`${fmtDate(v, { weekday: true })} is not a Sunday — showing ${fmtDate(snapped, { short: true })}.`, 'info', 4000);
      setDate(snapped);
    } else setDate(v);
  };

  async function load() {
    content.innerHTML = '<div class="loading">Loading…</div>';
    dateLabel.textContent = fmtDate(date, { weekday: true });
    try {
      const r = await api.serviceByDate(date);
      lock = r.lock || { live: true, can_correct: false, message: '' };
      writable = canWrite && (lock.live || lock.can_correct);
      if (r.exists) {
        service = await api.service(r.service.id);
      } else {
        // Nothing recorded yet: show the active roster so the first tap works immediately.
        const people = await api.people({ status: 'active', limit: 2000 });
        service = {
          id: null, service_date: date, present_count: 0, first_timer_count: 0, returning_count: 0,
          roster: people.map((p) => ({ ...p, att_status: null, classification: null, recorded_at: null, recorded_by: null,
            expected_classification: p.sundays_attended > 0 || (p.date_first_attended && p.date_first_attended < date) ? 'returning' : 'first_timer' })),
        };
      }
      renderRoster();
    } catch (err) {
      content.innerHTML = html`<div class="card"><div class="alert alert--error" style="margin:16px">${err.message}</div></div>`;
    }
  }

  const ROSTER_CAP = 150;

  /** Create the Sunday record on demand (first mark). */
  async function ensureService() {
    if (service.id) return;
    const created = await api.openService(date);
    service.id = created.id;
  }

  const counts = () => ({
    all: service.roster.length,
    present: service.roster.filter((p) => p.att_status === 'present').length,
    unmarked: service.roster.filter((p) => p.att_status !== 'present').length,
  });

  function renderRoster() {
    const c = counts();
    content.innerHTML = html`
      ${canWrite && lock.message ? html`<div class="alert ${correction() ? 'alert--warn' : 'alert--info'} mb-2">${icon(correction() ? 'warn' : 'lock', 18)}<span>${lock.message}</span></div>` : ''}
      <div class="card mb-2">
        <div class="card__body" style="padding:14px 20px">
          <div class="row row--between">
            <div class="kpi-row kpi-row--3" style="flex:1 1 240px">
              <div class="kpi"><b id="kPresent">${service.present_count}</b><span>Present</span></div>
              <div class="kpi"><b id="kFirst">${service.first_timer_count}</b><span>First timers</span></div>
              <div class="kpi"><b id="kReturn">${service.returning_count}</b><span>Returning</span></div>
            </div>
            <div class="row">
              ${writable && can('people:write') ? html`<button class="btn" id="quickAdd">${icon('plus')} New first timer</button>` : ''}
              ${service.id ? html`<a class="btn btn--ghost" href="#/attendance/history/${service.id}">Details</a>` : ''}
            </div>
          </div>
        </div>
      </div>

      <div class="toolbar">
        <div class="gsearch grow" style="max-width:none">${icon('search', 17)}<input type="search" id="rosterSearch" placeholder="Search name or Person ID" autocomplete="off" value="${search}" autofocus /></div>
        <div class="filter-tabs" id="filterTabs">
          <button data-f="all" class="${filter === 'all' ? 'active' : ''}">All <span class="count">${c.all}</span></button>
          <button data-f="unmarked" class="${filter === 'unmarked' ? 'active' : ''}">Not yet <span class="count">${c.unmarked}</span></button>
          <button data-f="present" class="${filter === 'present' ? 'active' : ''}">Present <span class="count">${c.present}</span></button>
        </div>
      </div>
      <div class="card"><div class="roster" id="roster"></div></div>
      ${service.is_demo ? html`<p class="small muted mt-1">Demo data Sunday.</p>` : ''}`;

    content.querySelector('#rosterSearch').addEventListener('input', debounce((e) => { search = e.target.value.trim().toLowerCase(); drawList(); }, 120));
    content.querySelector('#filterTabs').onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      filter = b.dataset.f;
      content.querySelectorAll('#filterTabs button').forEach((x) => x.classList.toggle('active', x === b));
      drawList();
    };
    content.querySelector('#quickAdd')?.addEventListener('click', () => quickRegister());
    drawList();
  }

  function refreshCounts() {
    const c = counts();
    const set = (id, v) => { const el = content.querySelector('#' + id); if (el) el.textContent = v; };
    set('kPresent', service.present_count); set('kFirst', service.first_timer_count); set('kReturn', service.returning_count);
    const tabs = content.querySelectorAll('#filterTabs button .count');
    if (tabs.length === 3) [c.all, c.unmarked, c.present].forEach((v, i) => (tabs[i].textContent = v));
  }

  function visibleRoster() {
    return service.roster.filter((p) => {
      if (filter === 'present' && p.att_status !== 'present') return false;
      if (filter === 'unmarked' && p.att_status === 'present') return false;
      if (search) {
        const hay = `${p.first_name} ${p.last_name} ${p.last_name} ${p.first_name} ${p.person_code}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
  }

  function itemHtml(p) {
    const present = p.att_status === 'present';
    return html`<div class="roster__item ${present ? 'is-present' : ''}" data-id="${p.id}">
      ${raw(avatar(p))}
      <div class="roster__info">
        <div class="roster__name">${fullName(p)}</div>
        <div class="roster__meta">
          <span class="mono">${p.person_code}</span>
          ${present ? raw(classBadge(p.classification)) : raw(statusBadge(p.status))}
          ${present && p.recorded_at ? html`<span>· ${fmtTime(p.recorded_at)}</span>` : ''}
        </div>
      </div>
      <div class="roster__actions">
        ${writable
          ? html`<button class="btn btn--present ${present ? 'is-on' : ''}" data-act="toggle" aria-pressed="${present}" title="${present ? 'Tap to remove this mark' : 'Mark present'}">${icon('check', 15)} Present</button>
                 ${present ? html`<button class="icon-btn" data-act="toggleClass" title="${p.classification === 'first_timer' ? 'Change to Returning' : 'Change to First Timer'}" aria-label="Change type">${icon('edit', 16)}</button>` : ''}`
          : raw(present ? '<span class="badge badge--present">Present</span>' : '<span class="badge">—</span>')}
      </div>
    </div>`;
  }

  function drawList() {
    const list = content.querySelector('#roster');
    const rows = visibleRoster();
    if (!service.roster.length) {
      list.innerHTML = emptyState({ icon: 'people', title: 'No one to mark yet', text: 'Register people first — they will appear here.', action: can('people:write') ? `<button class="btn btn--primary" id="quickAdd2">New first timer</button>` : '' });
      list.querySelector('#quickAdd2')?.addEventListener('click', () => quickRegister());
      return;
    }
    if (!rows.length) {
      list.innerHTML = emptyState({
        icon: 'search',
        title: search ? `No one named “${search}”` : filter === 'unmarked' ? 'Everyone is marked' : 'No one marked present yet',
        text: search ? 'Check the spelling, or register them as a first timer.' : '',
        action: search && writable && can('people:write') ? `<button class="btn btn--primary" id="quickAdd3">${icon('plus').value} Register “${search}” as first timer</button>` : '',
      });
      list.querySelector('#quickAdd3')?.addEventListener('click', () => quickRegister(search));
      return;
    }
    // Large rosters: render the first ROSTER_CAP rows and ask the user to narrow the search.
    const shown = rows.length > ROSTER_CAP && !search ? rows.slice(0, ROSTER_CAP) : rows;
    list.innerHTML = shown.map(itemHtml).join('') + (shown.length < rows.length
      ? `<div class="roster__more small muted">Showing ${shown.length} of ${rows.length}. Type a name or Person ID above to find anyone else.</div>` : '');
  }

  // One handler for every row (event delegation).
  const pending = new Set();
  content.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || !writable) return;
    const item = btn.closest('.roster__item');
    const pid = Number(item.dataset.id);
    const person = service.roster.find((p) => p.id === pid);
    const act = btn.dataset.act;

    if (act === 'toggle' && person.att_status === 'present' && !correction()) {
      const ok = await confirmDialog({ title: `Remove ${fullName(person)}'s attendance?`, message: `They will no longer be counted as present on ${fmtDate(service.service_date, { short: true })}. The change is kept in the Sunday's log.`, confirmText: 'Remove mark', danger: true });
      if (!ok) return;
    }
    let reason = null;
    if (correction()) {
      const what = act === 'toggle' ? (person.att_status === 'present' ? `remove ${fullName(person)}'s mark` : `mark ${fullName(person)} present`) : `change ${fullName(person)}'s type`;
      reason = await promptDialog({ title: 'Correction reason', message: `${fmtDate(service.service_date, { short: true })} is not today's Sunday. Why ${what}? This is saved in the audit log.`, placeholder: 'e.g. forgot to tap on Sunday / marked the wrong person', confirmText: 'Save correction' });
      if (!reason) return;
    }

    if (pending.has(pid)) return; // a tap for this person is already in flight
    pending.add(pid);
    btn.disabled = true;
    try {
      await ensureService();
      let res;
      if (act === 'toggle') res = person.att_status === 'present' ? await api.undoMark(service.id, pid, reason) : await api.mark(service.id, pid, 'present', undefined, reason);
      else if (act === 'toggleClass') res = await api.mark(service.id, pid, 'present', person.classification === 'first_timer' ? 'returning' : 'first_timer', reason);
      if (res.already_marked) toast(`${fullName(person)} is already marked present.`, 'info');
      Object.assign(service, res.summary);
      if (res.record) {
        person.att_status = res.record.status; person.classification = res.record.classification;
        person.recorded_at = res.record.recorded_at; person.recorded_by = res.record.recorded_by_name;
        if (!person.date_first_attended) person.date_first_attended = service.service_date;
      } else { person.att_status = null; person.classification = null; person.recorded_at = null; person.recorded_by = null; }

      const stillVisible = visibleRoster().some((p) => p.id === pid);
      if (stillVisible) item.outerHTML = itemHtml(person);
      else { item.remove(); if (!content.querySelector('.roster__item')) drawList(); }
      refreshCounts();
      if (!content.querySelector('#filterTabs + .card a[href*="history"]') && service.id) {
        // First mark of the day created the Sunday: show the Details link.
        const row = content.querySelector('#quickAdd')?.parentElement;
        if (row && !row.querySelector('a[href*="history"]')) row.insertAdjacentHTML('beforeend', `<a class="btn btn--ghost" href="#/attendance/history/${service.id}">Details</a>`);
      }
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    } finally {
      pending.delete(pid);
    }
  });

  /** Walk-in: register + mark present as first timer in one step. */
  function quickRegister(prefill = '') {
    const parts = String(prefill || '').trim().split(/\s+/).filter(Boolean);
    const defaults = { date_registered: date, status: 'first_timer' };
    if (parts.length) { defaults.first_name = parts.slice(0, -1).join(' ') || parts[0]; defaults.last_name = parts.length > 1 ? parts.at(-1) : ''; }
    const modal = openModal({
      title: 'New first timer',
      subtitle: `Registered and marked present for ${fmtDate(date, { short: true })}.`,
      wide: true,
      body: `<form id="quickForm" novalidate><div id="quickErr" class="alert alert--error mb-2" hidden></div><div id="quickDup" class="alert alert--warn mb-2" hidden></div>${personFormHtml(null, { compact: true, defaults })}</form>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn btn--primary" id="quickSave">${icon('check').value} Register &amp; mark present</button>`,
    });
    bindPhotoPicker(modal);
    modal.querySelector('[data-close]').onclick = closeModal;
    const form = modal.querySelector('#quickForm');
    const err = modal.querySelector('#quickErr');
    const save = async (e) => {
      e.preventDefault();
      const data = collectPerson(form);
      data.date_registered = date;
      if (!data.first_name || !data.last_name || !data.contact_number) { err.textContent = 'First name, last name and contact number are required.'; err.hidden = false; return; }
      await withLoading(modal.querySelector('#quickSave'), async () => {
        try {
          err.hidden = true;
          if (!(await duplicateGuard(data, modal.querySelector('#quickDup')))) return;
          const person = await api.createPerson(data);
          await ensureService();
          const res = await api.mark(service.id, person.id, 'present', 'first_timer', correction() ? 'New first timer registered after Sunday' : undefined);
          closeModal();
          toast(`${fullName(person)} registered (${person.person_code}) and marked present.`);
          service.roster.push({ ...person, att_status: 'present', classification: 'first_timer', recorded_at: res.record.recorded_at, recorded_by: res.record.recorded_by_name, expected_classification: 'first_timer' });
          service.roster.sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name));
          Object.assign(service, res.summary);
          search = ''; filter = 'all';
          renderRoster();
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      });
    };
    form.onsubmit = save;
    modal.querySelector('#quickSave').onclick = save;
  }

  // "/" focuses the search box
  const keyHandler = (e) => {
    if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
      const si = content.querySelector('#rosterSearch');
      if (si) { e.preventDefault(); e.stopImmediatePropagation(); si.focus(); }
    }
  };
  document.addEventListener('keydown', keyHandler, true);

  await load();
  return () => document.removeEventListener('keydown', keyHandler, true);
}
