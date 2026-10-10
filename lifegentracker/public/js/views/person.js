import { api } from '../api.js';
import { can } from '../app.js';
import { html, raw, icon, avatar, statusBadge, classBadge, fmtDate, fmtDateTime, fmtNum, fmtPct, age, toast, confirmDialog, openModal, closeModal, withLoading, STATUS_LABELS, DAY_LABELS, DAY_SHORT, TIME_LABELS, fmtSchedule } from '../ui.js';
import { findLifegroup, genderBadge } from './lifegroups.js';

/** Person profile: who they are, how often they attend, and their Sunday history. */
export async function renderPerson({ main }, id) {
  const p = await api.person(id);
  const locked = p.private_hidden;
  const inactive = p.status === 'inactive';
  const archived = Boolean(p.archived_at);
  const present = p.history.filter((h) => h.status === 'present');

  const row = (label, value, fmt = (x) => x) => {
    if (locked && value === undefined) return html`<div><dt>${label}</dt><dd class="locked">${icon('lock', 13)} Restricted</dd></div>`;
    return html`<div><dt>${label}</dt>${value ? html`<dd>${fmt(value)}</dd>` : raw('<dd class="none">—</dd>')}</div>`;
  };

  main.innerHTML = html`
    <div class="page-header">
      <div class="profile-head">
        ${raw(avatar(p, 'lg'))}
        <div class="info">
          <a class="small" href="#/people">${icon('back', 14)} People</a>
          <h1 class="mt-1">${p.first_name} ${p.middle_name ? p.middle_name + ' ' : ''}${p.last_name}</h1>
          <div class="row mt-1"><span class="code mono">${p.person_code}</span>${archived ? raw('<span class="badge badge--nodot">Archived</span>') : ''}${raw(statusBadge(p.status))}${p.is_demo ? raw('<span class="badge badge--demo badge--nodot">Demo data</span>') : ''}</div>
        </div>
      </div>
      ${can('people:write') ? html`<div class="page-actions">
        <button class="btn" id="statusBtn">Change status</button>
        <a class="btn btn--primary" href="#/people/${p.id}/edit">${icon('edit')} Edit</a>
      </div>` : ''}
    </div>

    <div class="grid grid--stats mb-2" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
      <div class="card stat"><span class="stat__label">Attendance</span><span class="stat__value">${fmtNum(p.sundays_attended)}<small> / ${p.services_since} Sundays</small></span></div>
      <div class="card stat"><span class="stat__label">Attendance rate</span><span class="stat__value">${fmtPct(p.attendance_rate)}</span></div>
      <div class="card stat"><span class="stat__label">First attended</span><span class="stat__value" style="font-size:1.15rem">${p.date_first_attended ? fmtDate(p.date_first_attended) : '—'}</span></div>
      <div class="card stat"><span class="stat__label">Last attended</span><span class="stat__value" style="font-size:1.15rem">${p.last_attended ? fmtDate(p.last_attended) : '—'}</span></div>
    </div>

    ${lifegroupCard(p)}

    <div class="grid grid--2">
      <div class="card">
        <div class="card__header"><h2>Details</h2>${locked ? raw(`<span class="hint">${icon('lock', 13).value} Contact details hidden for your role</span>`) : ''}</div>
        <div class="card__body"><dl class="dl">
          ${row('Contact number', p.contact_number, (v) => raw(`<a href="tel:${v.replace(/\s/g, '')}">${v}</a>`))}
          ${row('Email', p.email, (v) => raw(`<a href="mailto:${v}">${v}</a>`))}
          ${row('Birthday', p.birthdate, (v) => `${fmtDate(v)} · ${age(v)} yrs`)}
          ${row('Sex', p.sex, (v) => v[0].toUpperCase() + v.slice(1))}
          ${row('School', p.school)}
          ${row('Course / Year', p.course_year)}
          ${row('Occupation', p.occupation)}
          ${!p.birthdate ? row('Age', p.age, (v) => `${v} yrs (self-reported)`) : ''}
          ${row('Ministry', p.ministry)}
          ${row('Registered', p.date_registered, (v) => fmtDate(v) + (p.registration_source === 'qr' ? ' · via QR registration' : ''))}
          <div><dt>Privacy consent</dt><dd>${p.privacy_consent_at ? html`Given · ${fmtDate(p.privacy_consent_at)}` : raw('<span class="muted">Not yet recorded</span>')}</dd></div>
          <div style="grid-column:1/-1">${row('Address', p.address)}</div>
          ${!locked && p.notes ? html`<div style="grid-column:1/-1"><dt>Notes</dt><dd>${p.notes}</dd></div>` : ''}
        </dl></div>
      </div>

      <div class="card">
        <div class="card__header"><h2>Attendance history</h2><span class="hint">${present.length} Sunday${present.length === 1 ? '' : 's'} present</span></div>
        <div class="card__body card__body--flush">
          ${p.history.length ? html`<ul class="timeline" style="padding:4px 20px">
            ${p.history.map((h) => html`<li>
              <a class="date" href="#/attendance/history/${h.service_id}">${fmtDate(h.service_date, { short: true })}</a>
              ${h.status === 'present' ? raw(classBadge(h.classification)) : raw('<span class="badge badge--absent">Absent</span>')}
              <span class="when">${h.recorded_by || ''}<br>${fmtDateTime(h.recorded_at)}</span>
            </li>`)}
          </ul>` : html`<div class="empty" style="padding:32px"><p>No attendance recorded yet.</p></div>`}
        </div>
      </div>
    </div>

    ${archived ? html`<div class="alert alert--info mt-3">This person is archived — hidden from People, search and the Sunday roster. Attendance history is kept.${can('people:write') ? html` <button class="btn btn--sm" id="restoreBtn" style="margin-left:8px">Restore</button>` : ''}</div>` : ''}
    ${can('people:write') && !archived ? html`<div class="row row--between mt-3" style="padding:0 4px">
      <span class="small muted">${inactive ? 'Inactive — not on the Sunday roster.' : ''}</span>
      <span class="row">
        <button class="btn ${inactive ? '' : 'btn--danger-ghost'}" id="toggleActive">${inactive ? 'Reactivate' : 'Deactivate'}</button>
        <button class="btn btn--ghost small" id="archiveBtn" style="color:var(--muted)" title="Hide from lists; keep history">Archive</button>
        ${can('people:delete') ? html`<button class="btn btn--ghost small" id="deleteBtn" style="color:var(--muted)">Delete permanently</button>` : ''}
      </span>
    </div>` : ''}`;

  main.querySelector('#findGroup')?.addEventListener('click', () => findLifegroup(p, () => renderPerson({ main }, id)));
  main.querySelector('#leaveGroup')?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: `Remove ${p.first_name} from ${p.lifegroup.name}?`, message: 'They will be marked as left today. The membership stays in their history.', confirmText: 'Remove', danger: true });
    if (!ok) return;
    try { await api.leaveLifegroup(p.lifegroup.lifegroup_id, p.id); toast('Removed from Lifegroup.', 'info'); renderPerson({ main }, id); } catch (err) { toast(err.message, 'error'); }
  });

  main.querySelector('#archiveBtn')?.addEventListener('click', async (e) => {
    const ok = await confirmDialog({
      title: `Archive ${p.first_name}?`,
      message: 'Archived people disappear from People, search and the Sunday roster but <b>all attendance history is kept</b> and past totals do not change. You can restore them anytime from People → Archived.',
      confirmText: 'Archive',
    });
    if (!ok) return;
    await withLoading(e.currentTarget, async () => {
      try { await api.archivePerson(p.id); toast(`${p.first_name} archived.`, 'info'); renderPerson({ main }, id); }
      catch (err) { toast(err.message, 'error'); }
    });
  });
  main.querySelector('#restoreBtn')?.addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
    try { await api.restorePerson(p.id); toast(`${p.first_name} restored.`); renderPerson({ main }, id); }
    catch (err) { toast(err.message, 'error'); }
  }));

  main.querySelector('#toggleActive')?.addEventListener('click', async (e) => {
    if (!inactive) {
      const ok = await confirmDialog({ title: `Deactivate ${p.first_name}?`, message: 'They will no longer appear on the Sunday attendance list. All past attendance is kept and this can be reversed anytime.', confirmText: 'Deactivate', danger: true });
      if (!ok) return;
      await withLoading(e.currentTarget, async () => {
        try { await api.setPersonStatus(p.id, 'inactive'); toast(`${p.first_name} deactivated.`, 'info'); renderPerson({ main }, id); }
        catch (err) { toast(err.message, 'error'); }
      });
    } else openStatusModal('regular');
  });

  main.querySelector('#statusBtn')?.addEventListener('click', () => openStatusModal(p.status));

  function openStatusModal(selected) {
    const modal = openModal({
      title: 'Change status',
      subtitle: `${p.first_name} ${p.last_name} · currently ${STATUS_LABELS[p.status]}`,
      body: `<div class="field"><label>New status</label><select id="newStatus">${Object.entries(STATUS_LABELS).map(([k, l]) => `<option value="${k}" ${k === selected ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn btn--primary" id="saveStatus">Save</button>`,
    });
    modal.querySelector('[data-close]').onclick = closeModal;
    modal.querySelector('#saveStatus').onclick = (e) => withLoading(e.currentTarget, async () => {
      const s = modal.querySelector('#newStatus').value;
      try { await api.setPersonStatus(p.id, s); closeModal(); toast(`Status updated to ${STATUS_LABELS[s]}.`); renderPerson({ main }, id); }
      catch (err) { toast(err.message, 'error'); }
    });
  }

  main.querySelector('#deleteBtn')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Delete this person permanently?',
      message: `This removes <b>${p.first_name} ${p.last_name}</b> (${p.person_code}) and <b>${p.history.length}</b> attendance record(s). Past Sunday totals will change and this <b>cannot be undone</b>. Prefer <b>Archive</b> unless this record was created by mistake.`,
      confirmText: 'Delete permanently', danger: true, confirmWord: 'DELETE',
    });
    if (!ok) return;
    try { await api.deletePerson(p.id); toast('Person deleted.', 'info'); location.hash = '#/people'; }
    catch (err) { toast(err.message, 'error'); }
  });
}

/** Lifegroup card: current group + leader/area/schedule, or "No Lifegroup yet" + Find a Lifegroup; always shows history. */
function lifegroupCard(p) {
  const g = p.lifegroup;
  const manage = can('lifegroups:manage') && !p.archived_at;
  const hist = p.lifegroup_history || [];
  return html`<div class="card lg-card mb-2">
    <div class="card__header"><h2>Lifegroup</h2>
      <span class="row">
        ${manage && g ? html`<button class="btn btn--ghost btn--sm" id="leaveGroup">Remove</button>` : ''}
        ${manage ? html`<button class="btn btn--sm ${g ? '' : 'btn--primary'}" id="findGroup">${icon('group', 14)} ${g ? 'Change group' : 'Find a Lifegroup'}</button>` : ''}
      </span>
    </div>
    <div class="card__body">
      ${g ? html`<dl class="dl">
          <div><dt>Lifegroup</dt><dd><a href="#/lifegroups/${g.lifegroup_id}">${g.name}</a> ${genderBadge(g.gender)}${g.role !== 'member' ? html` <span class="badge badge--leader">${g.role === 'leader' ? 'Leader' : 'Assistant'}</span>` : ''}${g.is_active ? '' : raw(' <span class="badge badge--nodot">Inactive group</span>')}</dd></div>
          <div><dt>Leader</dt>${g.leader_person_id ? html`<dd><a href="#/people/${g.leader_person_id}">${g.leader_name}</a></dd>` : g.leader_name ? html`<dd>${g.leader_name}</dd>` : raw('<dd class="none">—</dd>')}</div>
          <div><dt>Network</dt>${g.network_id ? html`<dd><a href="#/networks/${g.network_id}">${g.network_name}</a>${g.network_leader_name ? html` <span class="small muted">· led by ${g.network_leader_name}</span>` : ''}</dd>` : raw('<dd class="none">—</dd>')}</div>
          <div><dt>Area</dt>${g.area ? html`<dd>${g.area}</dd>` : raw('<dd class="none">—</dd>')}</div>
          <div><dt>Schedule</dt>${fmtSchedule(g) ? html`<dd>${fmtSchedule(g)}</dd>` : raw('<dd class="none">—</dd>')}</div>
          <div><dt>Member since</dt><dd>${fmtDate(g.joined_at)}</dd></div>
          <div><dt>Status</dt><dd class="current">Active</dd></div>
        </dl>`
      : html`<div class="row row--between" style="flex-wrap:wrap">
          <div><div><b>No Lifegroup yet</b></div>${p.archived_at ? html`<div class="small muted">Archived people cannot be assigned.</div>` : ''}</div>
        </div>`}
      ${leadershipBlock(p)}
      ${hist.length > (g ? 1 : 0) || (hist.length && !g) ? html`<details class="mt-2 small"><summary class="muted">History (${hist.length})</summary>
        <ul class="lg-history mt-1">${hist.map((h) => html`<li><span class="when">${fmtDate(h.joined_at, { short: true })} → ${h.left_at ? fmtDate(h.left_at, { short: true }) : raw('<span class="current">present</span>')}</span><span><a href="#/lifegroups/${h.lifegroup_id}">${h.name}</a>${h.leader_name ? html` <span class="muted">· ${h.leader_name}</span>` : ''}${h.area ? html` <span class="muted">· ${h.area}</span>` : ''}</span></li>`)}</ul></details>` : ''}
    </div>
  </div>`;
}

/** "Leads" / "Reports to" chain: person → Lifegroup leader → Network leader → parent Network leader. */
function leadershipBlock(p) {
  const l = p.leadership;
  if (!l || (!l.leads_groups.length && !l.leads_networks.length && !l.reports_to.length)) return '';
  const leads = [
    ...l.leads_networks.map((n) => html`<a href="#/networks/${n.id}">${n.name}</a> <span class="muted">(Network)</span>`),
    ...l.leads_groups.map((g) => html`<a href="#/lifegroups/${g.id}">${g.name}</a>${g.network_name ? html` <span class="muted">· ${g.network_name}</span>` : ''}`),
  ];
  return html`<div class="leadership mt-2">
    ${leads.length ? html`<div class="row small" style="gap:6px;flex-wrap:wrap"><span class="muted" style="min-width:80px">Leads</span><span>${leads.map((x, i) => html`${i ? raw('<span class="muted"> · </span>') : ''}${x}`)}</span></div>` : ''}
    ${l.reports_to.length ? html`<div class="row small mt-1" style="gap:6px;flex-wrap:wrap;align-items:flex-start"><span class="muted" style="min-width:80px">Reports to</span><span class="chain">${l.reports_to.map((r, i) => html`${i ? raw('<span class="muted"> → </span>') : ''}${r.person_id ? html`<a href="#/people/${r.person_id}">${r.name}</a>` : r.name} <span class="muted">(${r.level} · ${r.via})</span>`)}</span></div>` : ''}
  </div>`;
}
