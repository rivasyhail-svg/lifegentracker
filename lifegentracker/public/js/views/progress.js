// Lifegroup progress: solid/new members, weekly meeting calendar, leader report link,
// per-network grid and the overall Progress tab. Shared by lifegroups.js.
import { api } from '../api.js';
import { can } from '../app.js';
import { html, raw, esc, icon, fmtDate, toISODate, toast, openModal, closeModal, confirmDialog, withLoading, emptyState, debounce } from '../ui.js';

const DAY_SHORT = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
export const weekLabel = (monday) => { const d = new Date(`${monday}T00:00:00`); return `${d.toLocaleDateString('en-US', { month: 'short' })} ${d.getDate()}`; };

/** Compact week strip: one cell per week — held / no meeting / nothing reported. */
export function weekStrip(calendar, { size = 'sm' } = {}) {
  return html`<div class="wk wk--${size}" role="img" aria-label="Weekly Lifegroup meetings">${calendar.map((w) => {
    const m = w.meeting;
    const cls = !m ? 'wk__c--none' : m.held ? 'wk__c--held' : 'wk__c--skip';
    const tip = `Week of ${weekLabel(w.week_start)}: ${!m ? 'no report' : m.held ? `held on ${fmtDate(m.date, { short: true })} · ${m.present} present` : 'no Lifegroup'}`;
    return html`<span class="wk__c ${cls}" title="${tip}">${m && m.held ? m.present : ''}</span>`;
  })}</div>`;
}

export function solidBadge(solid, target, is_solid) {
  return is_solid
    ? raw(`<span class="badge badge--present badge--nodot" title="${solid} solid members (target ${target})">Solid · ${solid}/${target}</span>`)
    : raw(`<span class="badge badge--nodot" title="${solid} solid members (target ${target})">${solid}/${target} solid</span>`);
}
export const tierBadge = (t) => raw(t === 'solid' ? '<span class="badge badge--present badge--nodot">Solid</span>' : '<span class="badge badge--nodot">New / other</span>');

// ---------------------------------------------------------------------------
// Group detail: Progress card
// ---------------------------------------------------------------------------
export async function renderProgressCard(card, groupId, { onChange } = {}) {
  const manage = can('lifegroups:manage');
  card.innerHTML = '<div class="card__header"><h2>Progress</h2></div><div class="card__body"><div class="loading">Loading…</div></div>';
  let p;
  try { p = await api.lifegroupProgress(groupId, 12); } catch (e) { card.querySelector('.card__body').innerHTML = html`<div class="alert alert--error">${e.message}</div>`; return; }
  const draw = () => {
    const last = p.calendar[p.calendar.length - 1];
    card.innerHTML = html`
      <div class="card__header"><h2>Progress</h2>${solidBadge(p.solid, p.target, p.is_solid)}</div>
      <div class="card__body stack">
        <div>
          <div class="row row--between small"><span><b>${p.solid}</b> solid of ${p.target} needed · <b>${p.new_members}</b> new / other</span><span class="muted">${p.percent}%</span></div>
          <div class="progress mt-1"><span style="width:${p.percent}%"></span></div>
          <p class="small muted mt-1">${p.is_solid ? 'This is a solid Lifegroup. Keep the weekly meetings going.' : `${p.target - p.solid} more solid member${p.target - p.solid === 1 ? '' : 's'} to become a solid Lifegroup. Mark a member Solid once they are committed and consistent — it is the leader's / admin's call, not automatic.`}</p>
        </div>
        <div class="kpi-row" style="grid-template-columns:repeat(auto-fit,minmax(110px,1fr))">
          <div class="kpi ${p.met_this_week ? '' : 'kpi--amber'}"><b>${p.met_this_week ? 'Yes' : last && last.meeting ? 'No' : '—'}</b><span>Met this week</span></div>
          <div class="kpi"><b>${p.held_last_4}<small>/4</small></b><span>Last 4 weeks</span></div>
          <div class="kpi"><b>${p.streak}</b><span>Week streak</span></div>
          <div class="kpi"><b>${p.last_meeting ? fmtDate(p.last_meeting.meeting_date, { short: true }) : '—'}</b><span>Last report</span></div>
        </div>
        <div><div class="row row--between small mb-1"><span class="muted">Last 12 weeks</span><span class="muted">${weekLabel(p.calendar[0].week_start)} → ${weekLabel(last.week_start)}</span></div>${weekStrip(p.calendar, { size: 'md' })}
          <div class="small muted mt-1"><span class="wk__c wk__c--held wk__c--key"></span> held (number = present) <span class="wk__c wk__c--skip wk__c--key"></span> no Lifegroup <span class="wk__c wk__c--none wk__c--key"></span> not reported</div></div>
        ${manage ? html`<div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn btn--primary" id="pgReport">${icon('plus')} Report a meeting</button><button class="btn" id="pgLink">${icon('link')} Leader link &amp; QR</button></div>` : ''}
        <div>
          <h3 class="section-title">Members <span class="muted small" style="font-weight:400">${p.total}</span></h3>
          ${p.members.length ? html`<div class="table-wrap"><table class="table table--stack">
            <thead><tr><th>Name</th><th>Tier</th><th class="num">Meetings</th><th>Last attended</th>${manage ? raw('<th></th>') : ''}</tr></thead>
            <tbody>${p.members.map((m) => html`<tr>
              <td data-label=""><a href="#/people/${m.id}">${m.first_name} ${m.last_name}</a>${m.role !== 'member' ? html` <span class="badge badge--leader">${m.role === 'leader' ? 'Leader' : 'Assistant'}</span>` : ''}</td>
              <td data-label="Tier">${tierBadge(m.tier)}</td>
              <td data-label="Meetings" class="num">${m.meetings_attended}</td>
              <td data-label="Last attended" class="nowrap">${m.last_meeting_attended ? fmtDate(m.last_meeting_attended, { short: true }) : raw('<span class="muted">—</span>')}</td>
              ${manage ? html`<td data-label="" class="actions"><button class="btn btn--sm ${m.tier === 'solid' ? 'btn--ghost' : ''}" data-tier="${m.id}" data-to="${m.tier === 'solid' ? 'new' : 'solid'}">${m.tier === 'solid' ? 'Set as New' : 'Mark Solid'}</button></td>` : ''}
            </tr>`)}</tbody></table></div>` : html`<p class="small muted">No members yet.</p>`}
        </div>
        <div>
          <h3 class="section-title">Meeting reports</h3>
          ${p.meetings.length ? html`<div class="table-wrap"><table class="table table--stack">
            <thead><tr><th>Date</th><th>Held</th><th class="num">Present</th><th>Topic / reason</th><th>Reported by</th>${manage ? raw('<th></th>') : ''}</tr></thead>
            <tbody>${p.meetings.map((m) => html`<tr>
              <td data-label="Date" class="nowrap">${fmtDate(m.meeting_date, { short: true })}</td>
              <td data-label="Held">${m.held ? raw('<span class="badge badge--present">Held</span>') : raw('<span class="badge badge--absent">No Lifegroup</span>')}</td>
              <td data-label="Present" class="num">${m.held ? html`<span title="${m.present.map((x) => x.name).join(', ')}">${m.present_count}</span>` : '—'}</td>
              <td data-label="Topic / reason" class="small">${m.held ? m.topic || raw('<span class="muted">—</span>') : m.no_meeting_reason}${m.notes ? html`<div class="muted">${m.notes}</div>` : ''}</td>
              <td data-label="Reported by" class="small muted">${m.submitted_via === 'leader_link' ? `${m.submitted_by_name || 'Leader'} · via link` : m.submitted_by_user_name || 'Staff'}</td>
              ${manage ? html`<td data-label="" class="actions"><button class="icon-btn" data-edit-meeting="${m.id}" title="Edit report" aria-label="Edit report">${icon('edit', 15)}</button><button class="icon-btn" data-del-meeting="${m.id}" title="Delete report" aria-label="Delete report">${icon('trash', 15)}</button></td>` : ''}
            </tr>`)}</tbody></table></div>` : html`<p class="small muted">No meeting reported yet.${manage ? ' Share the leader link so the leader can report every week, or use Report a meeting.' : ''}</p>`}
        </div>
      </div>`;
    card.querySelectorAll('[data-tier]').forEach((b) => {
      b.onclick = () => withLoading(b, async () => {
        try { p = { ...p, ...(await api.setTier(groupId, Number(b.dataset.tier), b.dataset.to)) }; p.meetings = (await api.lifegroupProgress(groupId, 12)).meetings; draw(); onChange?.(); }
        catch (e) { toast(e.message, 'error'); }
      });
    });
    card.querySelector('#pgReport')?.addEventListener('click', () => meetingForm(groupId, p, null, async () => { p = await api.lifegroupProgress(groupId, 12); draw(); onChange?.(); }));
    card.querySelectorAll('[data-edit-meeting]').forEach((b) => { b.onclick = () => meetingForm(groupId, p, p.meetings.find((m) => m.id === Number(b.dataset.editMeeting)), async () => { p = await api.lifegroupProgress(groupId, 12); draw(); onChange?.(); }); });
    card.querySelectorAll('[data-del-meeting]').forEach((b) => {
      b.onclick = async () => {
        const m = p.meetings.find((x) => x.id === Number(b.dataset.delMeeting));
        const ok = await confirmDialog({ title: `Delete the report for ${fmtDate(m.meeting_date, { short: true })}?`, message: 'The meeting and who was present will be removed from this group’s history.', confirmText: 'Delete', danger: true });
        if (!ok) return;
        try { const r = await api.deleteMeeting(groupId, m.id); p = { ...p, ...r.progress, meetings: r.meetings }; draw(); toast('Report deleted.', 'info'); onChange?.(); } catch (e) { toast(e.message, 'error'); }
      };
    });
    card.querySelector('#pgLink')?.addEventListener('click', () => linkDialog(groupId, p, (link, qr) => { p.report_link = link; p.report_qr = qr; }));
  };
  draw();
}

function linkDialog(groupId, p, onReset) {
  const modal = openModal({
    title: 'Leader report link',
    subtitle: `${p.group.name} · give this only to ${p.group.leader_name || 'the leader'}`,
    body: `<div class="stack">
      <p class="small">The leader opens this link (or scans the QR) on their phone — no login — and reports each week: Lifegroup held or not, who was present, newcomers, and who is already Solid. Anyone with the link can report for this group, so keep it private.</p>
      <div class="qr-preview" id="lgQr" style="max-width:220px;margin:0 auto">${p.report_qr || ''}</div>
      <div class="field"><label>Link</label><input id="lgLinkUrl" readonly value="${esc(p.report_link || '')}" /></div>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button class="btn btn--sm" id="lgCopy">${icon('copy', 14).value} Copy link</button>
        <a class="btn btn--sm" id="lgOpen" href="${esc(p.report_link || '#')}" target="_blank" rel="noopener">${icon('link', 14).value} Open</a>
        <button class="btn btn--sm" id="lgPrint">${icon('print', 14).value} Print QR</button>
        <button class="btn btn--sm btn--ghost" id="lgReset" style="margin-left:auto;color:var(--red-600)">${icon('undo', 14).value} New link</button>
      </div>
      <p class="small muted">“New link” stops the old link from working — use it if the link was shared with the wrong person or the leader changed.</p>
    </div>`,
    footer: `<button class="btn" data-close>Close</button>`,
  });
  modal.querySelector('[data-close]').onclick = closeModal;
  modal.querySelector('#lgCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(modal.querySelector('#lgLinkUrl').value); toast('Link copied.'); }
    catch { modal.querySelector('#lgLinkUrl').select(); toast('Press Ctrl/Cmd+C to copy the selected link.', 'info'); }
  };
  modal.querySelector('#lgPrint').onclick = () => {
    const w = window.open('', '_blank');
    if (!w) return toast('Allow pop-ups to print.', 'error');
    w.document.write(`<!doctype html><title>${esc(p.group.name)} — leader link</title><body style="font-family:system-ui;text-align:center;padding:40px"><h2 style="margin:0 0 4px">${esc(p.group.name)}</h2><p style="margin:0 0 20px;color:#555">Lifegroup weekly report · ${esc(p.group.leader_name || '')}</p><div style="max-width:320px;margin:0 auto">${p.report_qr || ''}</div><p style="font-size:12px;word-break:break-all;color:#555">${esc(p.report_link || '')}</p><p style="font-size:12px;color:#999">Private — for the Lifegroup leader only.</p></body>`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
  };
  modal.querySelector('#lgReset').onclick = async (e) => {
    const ok = await confirmDialog({ title: 'Create a new leader link?', message: 'The current link and QR will stop working immediately. You will need to send the new one to the leader.', confirmText: 'New link', danger: true });
    if (!ok) return;
    await withLoading(e.currentTarget, async () => {
      try {
        const r = await api.resetReportLink(groupId);
        const fresh = await api.lifegroupProgress(groupId, 4);
        modal.querySelector('#lgLinkUrl').value = r.report_link; modal.querySelector('#lgOpen').href = r.report_link; modal.querySelector('#lgQr').innerHTML = fresh.report_qr || '';
        onReset?.(r.report_link, fresh.report_qr); toast('New link created. The old one no longer works.');
      } catch (ex) { toast(ex.message, 'error'); }
    });
  };
}

/** Staff-side meeting report (create or edit). */
export function meetingForm(groupId, p, existing, onSaved) {
  const today = toISODate(new Date());
  const presentIds = new Set(existing ? existing.present.map((x) => x.id) : []);
  const modal = openModal({
    title: existing ? `Edit report · ${fmtDate(existing.meeting_date, { short: true })}` : `Report a meeting · ${p.group.name}`,
    body: `<form id="mtForm" class="stack" novalidate>
      <div id="mtErr" class="alert alert--error" hidden></div>
      <div class="form-grid">
        <div class="field"><label>Meeting date <span class="req">*</span></label><input type="date" name="meeting_date" max="${today}" value="${esc(existing ? existing.meeting_date : today)}" ${existing ? 'readonly' : ''} required /></div>
        <div class="field"><label>Did the Lifegroup meet?</label>
          <div class="choice choice--sm"><label class="choice__opt"><input type="radio" name="held" value="1" ${!existing || existing.held ? 'checked' : ''} /><span>Yes, held</span></label><label class="choice__opt"><input type="radio" name="held" value="0" ${existing && !existing.held ? 'checked' : ''} /><span>No Lifegroup</span></label></div></div>
      </div>
      <div class="field" id="mtReasonWrap" ${!existing || existing.held ? 'hidden' : ''}><label>Why no Lifegroup? <span class="req">*</span></label><input name="no_meeting_reason" value="${esc(existing?.no_meeting_reason || '')}" placeholder="e.g. exams week, leader sick, holiday" maxlength="160" /></div>
      <div id="mtHeld" ${existing && !existing.held ? 'hidden' : ''}>
        <div class="field"><label>Topic <span class="opt">optional</span></label><input name="topic" value="${esc(existing?.topic || '')}" maxlength="160" placeholder="e.g. Prayer, Identity in Christ" /></div>
        <div class="field mt-1"><label>Who was present?</label>
          ${p.members.length ? `<div class="checklist">${p.members.map((m) => `<label class="checklist__item"><input type="checkbox" name="present" value="${m.id}" ${presentIds.has(m.id) ? 'checked' : ''} /><span>${esc(m.first_name + ' ' + m.last_name)}</span>${m.tier === 'solid' ? '<span class="badge badge--present badge--nodot">Solid</span>' : ''}</label>`).join('')}</div>` : '<p class="small muted">No members yet.</p>'}
        </div>
        <div class="field mt-1"><label>Newcomers <span class="opt">optional · one full name per line</span></label><textarea name="new_members" rows="2" placeholder="Juan Dela Cruz&#10;Maria Santos"></textarea><span class="help">They are registered as new Lifegroup members (status First Timer) and counted present. Add contact details later from People.</span></div>
      </div>
      <div class="field"><label>Notes <span class="opt">optional</span></label><textarea name="notes" rows="2" maxlength="1000">${esc(existing?.notes || '')}</textarea></div>
    </form>`,
    footer: `<button class="btn" data-close>Cancel</button><button class="btn btn--primary" id="mtSave">${existing ? 'Save changes' : 'Save report'}</button>`,
  });
  modal.querySelector('[data-close]').onclick = closeModal;
  const form = modal.querySelector('#mtForm');
  const sync = () => { const held = form.querySelector('[name=held]:checked').value === '1'; modal.querySelector('#mtReasonWrap').hidden = held; modal.querySelector('#mtHeld').hidden = !held; };
  form.querySelectorAll('[name=held]').forEach((r) => r.addEventListener('change', sync));
  const save = (e) => withLoading(modal.querySelector('#mtSave'), async () => {
    e.preventDefault();
    const err = modal.querySelector('#mtErr');
    const held = form.querySelector('[name=held]:checked').value === '1';
    const body = {
      meeting_date: form.meeting_date.value, held, no_meeting_reason: form.no_meeting_reason.value.trim() || null, topic: form.topic.value.trim() || null, notes: form.notes.value.trim() || null,
      present_ids: held ? [...form.querySelectorAll('[name=present]:checked')].map((c) => Number(c.value)) : [],
      new_members: held ? form.new_members.value.split('\n').map((s) => s.trim()).filter(Boolean).map((full_name) => ({ full_name })) : [],
    };
    try { await api.saveMeeting(groupId, body); closeModal(); toast(existing ? 'Report updated.' : 'Meeting report saved.'); onSaved?.(); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
  modal.querySelector('#mtSave').onclick = save; form.onsubmit = save;
}

// ---------------------------------------------------------------------------
// Network detail: weekly grid (network leader's own group first, then each group)
// ---------------------------------------------------------------------------
export async function renderNetworkCalendar(card, networkId) {
  card.innerHTML = '<div class="card__header"><h2>Weekly Lifegroups</h2></div><div class="card__body"><div class="loading">Loading…</div></div>';
  let d;
  try { d = await api.networkCalendar(networkId, 8); } catch (e) { card.querySelector('.card__body').innerHTML = html`<div class="alert alert--error">${e.message}</div>`; return; }
  const s = d.summary;
  card.innerHTML = html`
    <div class="card__header"><h2>Weekly Lifegroups</h2><span class="hint">Last 8 weeks · ${s.met_this_week}/${s.groups} met this week · ${s.consistency_pct}% of the last 4 weeks</span></div>
    <div class="card__body card__body--flush">
      ${d.groups.length ? html`<div class="table-wrap"><table class="table table--grid">
        <thead><tr><th>Lifegroup</th><th>Solid</th>${d.weeks.map((w) => html`<th class="num small">${weekLabel(w)}</th>`)}</tr></thead>
        <tbody>${d.groups.map((g) => html`<tr>
          <td><a href="#/lifegroups/${g.id}"><b>${g.name}</b></a>${g.is_leader_group ? raw(' <span class="badge badge--leader">Network leader’s group</span>') : ''}<div class="small muted">${g.leader_name || '—'}${g.schedule_day ? ` · ${DAY_SHORT[g.schedule_day]}` : ''}</div></td>
          <td class="nowrap">${solidBadge(g.solid, g.target, g.is_solid)}</td>
          ${g.calendar.map((w) => { const m = w.meeting; return html`<td class="num"><span class="wk__c wk__c--md ${!m ? 'wk__c--none' : m.held ? 'wk__c--held' : 'wk__c--skip'}" title="${!m ? 'Not reported' : m.held ? `Held ${fmtDate(m.date, { short: true })} · ${m.present} present` : 'No Lifegroup'}">${m && m.held ? m.present : m ? '×' : ''}</span></td>`; })}
        </tr>`)}</tbody></table></div>` : html`<div class="empty" style="padding:28px"><p>No active Lifegroups under this network yet.</p></div>`}
      <div class="card__footer small muted"><span class="wk__c wk__c--held wk__c--key"></span> held (number = present) <span class="wk__c wk__c--skip wk__c--key"></span> no Lifegroup <span class="wk__c wk__c--none wk__c--key"></span> not reported</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Lifegroups → Progress tab
// ---------------------------------------------------------------------------
export async function drawProgressTab(body) {
  body.innerHTML = '<div class="loading">Loading…</div>';
  let d;
  try { d = await api.progressOverview(8); } catch (e) { body.innerHTML = html`<div class="alert alert--error">${e.message}</div>`; return; }
  const s = d.summary;
  const sum = (label, x) => html`<tr><td><b>${label}</b></td><td class="num">${x.groups}</td><td class="num">${x.solid_groups}</td><td class="num">${x.solid_members}</td><td class="num">${x.new_members}</td><td class="num">${x.met_this_week}/${x.groups}</td><td class="num">${x.consistency_pct}%</td></tr>`;
  let q = '';
  body.innerHTML = html`
    <div class="kpi-row mb-2" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">
      <div class="kpi"><b>${s.solid_groups}<small>/${s.groups}</small></b><span>Solid Lifegroups</span></div>
      <div class="kpi"><b>${s.solid_members}</b><span>Solid members</span></div>
      <div class="kpi"><b>${s.new_members}</b><span>New / other</span></div>
      <div class="kpi ${s.met_this_week < s.groups ? 'kpi--amber' : ''}"><b>${s.met_this_week}<small>/${s.groups}</small></b><span>Met this week</span></div>
      <div class="kpi"><b>${s.consistency_pct}%</b><span>Held, last 4 weeks</span></div>
      <div class="kpi"><b>${s.networks}</b><span>Networks</span></div>
    </div>
    <p class="small muted mb-2">A Lifegroup is <b>solid</b> once it has ${d.target} solid members. “Solid” is set by hand by the leader (via their report link) or by staff. Newcomers sit under the group as <b>New / other</b> until then.</p>
    <div class="card mb-2"><div class="card__header"><h2>Boys vs girls</h2></div><div class="card__body card__body--flush"><div class="table-wrap"><table class="table">
      <thead><tr><th></th><th class="num">Groups</th><th class="num">Solid groups</th><th class="num">Solid members</th><th class="num">New / other</th><th class="num">Met this week</th><th class="num">Last 4 weeks</th></tr></thead>
      <tbody>${sum('Boys', d.boys)}${sum('Girls', d.girls)}${sum('All', s)}</tbody></table></div></div></div>
    <div class="card mb-2"><div class="card__header"><h2>By network</h2><span class="hint">Click a network for its weekly grid</span></div><div class="card__body card__body--flush">
      ${d.networks.length ? html`<div class="table-wrap"><table class="table table--stack">
        <thead><tr><th>Network</th><th class="num">Groups</th><th class="num">Solid groups</th><th class="num">Solid</th><th class="num">New / other</th><th class="num">Met this week</th><th class="num">Last 4 weeks</th></tr></thead>
        <tbody>${d.networks.map((n) => html`<tr class="${n.id ? 'clickable' : ''}" data-net="${n.id || ''}">
          <td data-label="">${n.id ? html`<a href="#/networks/${n.id}"><b>${n.name}</b></a>` : html`<b class="muted">${n.name}</b>`}</td>
          <td data-label="Groups" class="num">${n.summary.groups}</td><td data-label="Solid groups" class="num">${n.summary.solid_groups}</td><td data-label="Solid" class="num">${n.summary.solid_members}</td><td data-label="New / other" class="num">${n.summary.new_members}</td>
          <td data-label="Met this week" class="num">${n.summary.met_this_week}/${n.summary.groups}</td><td data-label="Last 4 weeks" class="num">${n.summary.consistency_pct}%</td>
        </tr>`)}</tbody></table></div>` : html`<div class="empty" style="padding:28px"><p>No active Lifegroups yet.</p></div>`}
    </div></div>
    <div class="card"><div class="card__header"><h2>Every Lifegroup</h2><div class="gsearch" style="max-width:260px">${icon('search', 15)}<input id="pgq" placeholder="Filter…" autocomplete="off" aria-label="Filter groups" /></div></div><div class="card__body card__body--flush" id="pgAll"></div></div>`;
  const all = body.querySelector('#pgAll');
  const drawAll = () => {
    const needle = q.toLowerCase();
    const rows = needle ? d.groups.filter((g) => [g.name, g.leader_name, g.network_name].some((v) => v && v.toLowerCase().includes(needle))) : d.groups;
    all.innerHTML = rows.length ? html`<div class="table-wrap"><table class="table table--grid">
      <thead><tr><th>Lifegroup</th><th>Network</th><th>Solid</th><th class="num">Members</th>${d.weeks.map((w) => html`<th class="num small">${weekLabel(w)}</th>`)}</tr></thead>
      <tbody>${rows.map((g) => html`<tr>
        <td><a href="#/lifegroups/${g.id}"><b>${g.name}</b></a><div class="small muted">${g.leader_name || '—'}</div></td>
        <td class="small">${g.network_name || raw('<span class="muted">—</span>')}</td>
        <td class="nowrap">${solidBadge(g.solid, g.target, g.is_solid)}</td>
        <td class="num">${g.total}</td>
        ${g.calendar.map((w) => { const m = w.meeting; return html`<td class="num"><span class="wk__c wk__c--md ${!m ? 'wk__c--none' : m.held ? 'wk__c--held' : 'wk__c--skip'}" title="${!m ? 'Not reported' : m.held ? `Held ${fmtDate(m.date, { short: true })} · ${m.present} present` : 'No Lifegroup'}">${m && m.held ? m.present : m ? '×' : ''}</span></td>`; })}
      </tr>`)}</tbody></table></div><div class="card__footer small muted">${rows.length} group${rows.length === 1 ? '' : 's'} · <span class="wk__c wk__c--held wk__c--key"></span> held <span class="wk__c wk__c--skip wk__c--key"></span> no Lifegroup <span class="wk__c wk__c--none wk__c--key"></span> not reported</div>` : emptyState({ icon: 'group', title: 'No group matches', text: '' });
  };
  body.querySelector('#pgq').addEventListener('input', debounce((e) => { q = e.target.value.trim(); drawAll(); }, 150));
  drawAll();
}
