import { api } from '../api.js';
import { can } from '../app.js';
import { html, raw, icon, personCell, statusBadge, classBadge, attBadge, fmtDate, fmtDateTime, fmtNum, fmtPct, emptyState, toast, openModal, closeModal, withLoading, downloadUrl } from '../ui.js';

export async function renderHistory({ main, query }) {
  const year = query.year || '';
  const years = await api.reportYears();
  const services = await api.services(year ? { from: `${year}-01-01`, to: `${year}-12-31` } : {});

  main.innerHTML = html`
    <div class="page-header">
      <div><a class="small" href="#/attendance">${icon('back', 14)} Attendance</a><h1 class="mt-1">Attendance History</h1><p class="sub">Every recorded Lifegen Sunday. Click a date to see who was there.</p></div>
      <div class="page-actions">
        <select id="yearSel" style="width:auto"><option value="">All years</option>${years.map((y) => html`<option value="${y}" ${String(y) === year ? 'selected' : ''}>${y}</option>`)}</select>
        <button class="btn" id="exportBtn">${icon('download')} Export CSV</button>
      </div>
    </div>
    <div class="card">
      ${services.length ? html`<div class="table-wrap"><table class="table table--stack">
        <thead><tr><th>Date</th><th class="num">Present</th><th class="num">First timers</th><th class="num">Returning</th></tr></thead>
        <tbody>${services.map((s) => html`<tr class="clickable" data-id="${s.id}">
          <td data-label="Date"><b>${fmtDate(s.service_date)}</b>${s.is_demo ? raw(' <span class="badge badge--demo badge--nodot">Demo</span>') : ''}${s.notes ? html`<div class="small muted truncate" style="max-width:280px">${s.notes}</div>` : ''}</td>
          <td data-label="Present" class="num"><b>${fmtNum(s.present_count)}</b></td>
          <td data-label="First timers" class="num">${fmtNum(s.first_timer_count)}</td>
          <td data-label="Returning" class="num">${fmtNum(s.returning_count)}</td>
        </tr>`)}</tbody>
      </table></div>
      <div class="card__footer small muted">${services.length} Sunday${services.length === 1 ? '' : 's'}</div>`
      : raw(emptyState({ icon: 'calendar', title: 'No Sundays recorded yet', text: 'Recorded Sundays will be listed here with their totals.', action: can('attendance:write') ? '<a class="btn btn--primary" href="#/attendance">Record attendance</a>' : '' }))}
    </div>`;

  main.querySelector('#yearSel').onchange = (e) => { location.hash = '#/attendance/history' + (e.target.value ? `?year=${e.target.value}` : ''); };
  main.querySelector('#exportBtn').onclick = () => downloadUrl('/api/reports/export/weekly.csv' + (year ? `?year=${year}` : ''));
  main.querySelectorAll('tr.clickable').forEach((tr) => { tr.onclick = (e) => { if (!e.target.closest('a')) location.hash = `#/attendance/history/${tr.dataset.id}`; }; });
}

export async function renderServiceDetail({ main }, id) {
  const [s, audit] = await Promise.all([api.service(id), api.serviceAudit(id)]);
  const present = s.roster.filter((p) => p.att_status === 'present');
  const absent = s.roster.filter((p) => p.att_status === 'absent');
  const unmarked = s.roster.filter((p) => !p.att_status);
  let tab = 'present';

  main.innerHTML = html`
    <div class="page-header">
      <div>
        <a class="small" href="#/attendance/history">${icon('back', 14)} Attendance history</a>
        <h1 class="mt-1">${fmtDate(s.service_date, { weekday: true })}</h1>
        <p class="sub">Lifegen / 3rd Service${s.is_demo ? ' · Demo data' : ''}</p>
      </div>
      <div class="page-actions">
        ${can('attendance:write') ? html`<button class="btn" id="notesBtn">${icon('edit')} Notes</button><a class="btn btn--primary" href="#/attendance?date=${s.service_date}">${icon('check')} Mark attendance</a>` : ''}
        <button class="btn" data-action="print">${icon('print')} Print</button>
      </div>
    </div>

    <div class="card mb-2"><div class="card__body">
      <div class="kpi-row">
        <div class="kpi"><b>${s.present_count}</b><span>Present</span></div>
        <div class="kpi"><b>${s.first_timer_count}</b><span>First timers</span></div>
        <div class="kpi"><b>${s.returning_count}</b><span>Returning</span></div>
        <div class="kpi"><b>${fmtPct(s.attendance_rate)}</b><span>Attendance rate</span></div>
      </div>
      ${s.notes ? html`<div class="alert alert--info mt-2" id="notesBox">${s.notes}</div>` : html`<div id="notesBox"></div>`}
    </div></div>

    <div class="grid grid--2" style="grid-template-columns:minmax(0,3fr) minmax(0,2fr)">
      <div class="card">
        <div class="card__header">
          <div class="filter-tabs" id="tabs">
            <button data-t="present" class="active">Present <span class="count">${present.length}</span></button>
            <button data-t="unmarked">Not present <span class="count">${unmarked.length + absent.length}</span></button>
          </div>
        </div>
        <div class="card__body card__body--flush" id="listBody"></div>
      </div>
      <div class="card">
        <div class="card__header"><h2>Change log</h2><span class="hint">Who recorded what</span></div>
        <div class="card__body card__body--flush" style="max-height:560px;overflow:auto">
          ${audit.length ? html`<ul class="timeline" style="padding:4px 20px">${audit.map((a) => html`<li>
            <span style="flex:1;min-width:0"><b>${a.first_name ? `${a.first_name} ${a.last_name}` : 'Deleted person'}</b> <span class="muted small">${a.person_code || ''}</span><br>
            <span class="small">${a.action === 'undo' ? 'Record cleared' : a.action === 'mark' ? `Marked ${a.new_status}` : `Changed ${a.old_status}${a.old_classification ? ' (' + a.old_classification.replace('_', ' ') + ')' : ''} → ${a.new_status}`}${a.new_classification && a.action !== 'undo' ? ` · ${a.new_classification.replace('_', ' ')}` : ''}</span></span>
            <span class="when">${a.user_name || 'Unknown'}<br>${fmtDateTime(a.created_at)}</span></li>`)}</ul>`
          : raw('<div class="empty" style="padding:28px"><p>No changes recorded yet.</p></div>')}
        </div>
      </div>
    </div>`;

  const listBody = main.querySelector('#listBody');
  const draw = () => {
    const rows = tab === 'present' ? present : [...absent, ...unmarked].sort((a, b) => a.last_name.localeCompare(b.last_name));
    if (!rows.length) { listBody.innerHTML = emptyState({ icon: 'people', title: tab === 'present' ? 'No one marked present' : 'Everyone was present', text: '' }); return; }
    listBody.innerHTML = html`<div class="table-wrap"><table class="table table--stack">
      <thead><tr><th>Person</th><th>Status</th>${tab === 'present' ? raw('<th>Type</th><th>Recorded</th>') : ''}</tr></thead>
      <tbody>${rows.map((p) => html`<tr>
        <td data-label="">${raw(personCell(p))}</td>
        <td data-label="Status">${raw(statusBadge(p.status))}</td>
        ${tab === 'present' ? html`<td data-label="Type">${raw(classBadge(p.classification))}</td>` : ''}
        ${tab === 'present' ? html`<td data-label="Recorded" class="small muted">${fmtDateTime(p.recorded_at)}${p.recorded_by ? html`<br>by ${p.recorded_by}` : ''}</td>` : ''}
      </tr>`)}</tbody></table></div>`;
  };
  main.querySelector('#tabs').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; tab = b.dataset.t; main.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b)); draw(); };
  draw();

  main.querySelector('#notesBtn')?.addEventListener('click', () => {
    const modal = openModal({
      title: 'Sunday notes', subtitle: fmtDate(s.service_date),
      body: `<div class="field"><label>Notes <span class="opt">optional</span></label><textarea id="notesInput" placeholder="e.g. Youth camp weekend, heavy rain, special guest speaker…">${s.notes ? s.notes.replace(/</g, '&lt;') : ''}</textarea></div>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn btn--primary" id="saveNotes">Save</button>`,
    });
    modal.querySelector('[data-close]').onclick = closeModal;
    modal.querySelector('#saveNotes').onclick = (e) => withLoading(e.currentTarget, async () => {
      try {
        const updated = await api.updateService(s.id, { notes: modal.querySelector('#notesInput').value });
        s.notes = updated.notes; closeModal(); toast('Notes saved.');
        main.querySelector('#notesBox').outerHTML = s.notes ? html`<div class="alert alert--info mt-2" id="notesBox">${s.notes}</div>` : '<div id="notesBox"></div>';
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}
