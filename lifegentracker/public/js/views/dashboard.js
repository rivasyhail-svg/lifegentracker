import { api } from '../api.js';
import { state, can } from '../app.js';
import { html, raw, icon, fmtDate, fmtNum, emptyState } from '../ui.js';
import { lineChart } from '../charts.js';

const shortSunday = (d) => { const [, m, day] = d.split('-'); return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1]} ${+day}`; };

/**
 * Compact dashboard: four numbers that matter, one trend chart, recent Sundays.
 * Every figure comes from /api/dashboard (computed from attendance records).
 */
export async function renderDashboard({ main }) {
  const d = await api.dashboard();
  state.demoLoaded = d.demo_loaded;
  const latest = d.latest;
  const noData = d.services_recorded === 0;

  main.innerHTML = html`
    <div class="page-header">
      <div>
        <h1>Dashboard</h1>
        <p class="sub">${latest ? html`Latest Sunday · ${fmtDate(latest.service_date, { weekday: true })}` : fmtDate(d.today, { weekday: true })}</p>
      </div>
      <div class="page-actions">
        ${can('attendance:write') ? html`<a class="btn btn--primary" href="#/attendance">${icon('check')} Record attendance</a>` : ''}
      </div>
    </div>

    ${state.authDisabled && !state.standalone ? html`<div class="alert alert--warn mb-2">${icon('lock', 18)}<span><b>Sign-in is off.</b> Anyone who can open this address is treated as Admin. Turn it on before storing real records (<span class="mono">LIFEGEN_AUTH=on</span>).</span><a class="btn btn--sm" href="#/settings">Settings</a></div>` : ''}
    ${d.pending_registrations && !state.standalone ? html`<div class="alert alert--info mb-2">${icon('inbox', 18)}<span><b>${fmtNum(d.pending_registrations)} QR registration${d.pending_registrations === 1 ? '' : 's'}</b> waiting for review.</span><a class="btn btn--sm" href="#/registrations">Review</a></div>` : ''}
    ${d.demo_loaded ? html`<div class="alert alert--warn demo-banner mb-2">${icon('warn', 18)}<span><b>Demo data is loaded.</b> People marked with a <b>Demo</b> badge, their attendance, Lifegroups and registrations are sample records, not real church data.</span>${can('settings:manage') ? html`<a class="btn btn--sm" href="#/settings">Remove in Settings</a>` : ''}</div>` : ''}

    ${noData ? html`<div class="card mb-2">${raw(emptyState({
      icon: 'calendar',
      title: 'No Sunday attendance recorded yet',
      text: can('attendance:write')
        ? 'Register people, then open Attendance on Sunday and mark them present. Numbers appear here automatically.'
        : 'Once attendance staff record the first Lifegen Sunday, numbers will appear here.',
      action: can('people:write') ? '<a class="btn btn--primary" href="#/people/new">Register a person</a>' : '',
    }))}</div>` : html`
    <div class="grid grid--stats mb-2">
      <div class="card stat">
        <span class="stat__label">Lifegen attendance</span>
        <span class="stat__value">${fmtNum(latest.present_count)}</span>
        <span class="stat__meta">${d.change_vs_previous === null ? 'first recorded Sunday' : raw(`<span class="delta ${d.change_vs_previous >= 0 ? 'delta--up' : 'delta--down'}">${d.change_vs_previous >= 0 ? '+' : '−'}${Math.abs(d.change_vs_previous)}</span> vs previous Sunday`)}</span>
      </div>
      <div class="card stat">
        <span class="stat__label">First timers</span>
        <span class="stat__value">${fmtNum(latest.first_timer_count)}</span>
        <span class="stat__meta">${fmtNum(d.quarter.first_timers)} this quarter</span>
      </div>
      <div class="card stat">
        <span class="stat__label">Returning</span>
        <span class="stat__value">${fmtNum(latest.returning_count)}</span>
        <span class="stat__meta">${fmtNum(d.people.active)} registered people</span>
      </div>
      <div class="card stat">
        <span class="stat__label">Average attendance</span>
        <span class="stat__value">${fmtNum(d.average_attendance)}</span>
        <span class="stat__meta">${d.year.services ? `${d.year.services} Sunday${d.year.services === 1 ? '' : 's'} in ${d.year.label}` : 'last 8 Sundays'}</span>
      </div>
    </div>

    <div class="card mb-2">
      <div class="card__header"><h2>Attendance trend</h2><span class="hint">Last ${d.trend.length} Sunday${d.trend.length === 1 ? '' : 's'}</span></div>
      <div class="card__body">${raw(lineChart(d.trend.map((w) => ({ label: shortSunday(w.service_date), value: w.present_count, title: fmtDate(w.service_date) })), { aria: 'Attendance trend', width: 900, height: 230, cls: 'chart--trend' }))}</div>
    </div>

    ${d.lifegroups ? html`<div class="card mb-2">
      <div class="card__header"><h2>Lifegroup overview</h2><a class="small" href="#/lifegroups?tab=needs">Needs Lifegroup ${icon('chevR', 13)}</a></div>
      <div class="card__body">
        <div class="kpi-row" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">
          ${(() => { const st = d.lifegroups.structure || { networks: d.lifegroups.networks || 0, cell_leaders: 0, lifegroups: d.lifegroups.active_groups, closed_cell: d.lifegroups.closed_cell || 0, open_cell: d.lifegroups.open_cell || 0 }; return html`
          <a class="kpi kpi--link" href="#/lifegroups"><b>${fmtNum(st.networks)}</b><span>Networks</span></a>
          <a class="kpi kpi--link" href="#/lifegroups"><b>${fmtNum(st.cell_leaders)}</b><span>Cell leaders</span></a>
          <a class="kpi kpi--link" href="#/lifegroups"><b>${fmtNum(st.lifegroups)}</b><span>Lifegroups</span></a>
          <a class="kpi kpi--link kpi--teal" href="#/reports?view=lifegroups"><b>${fmtNum(st.closed_cell)}</b><span>Closed cell</span></a>
          <a class="kpi kpi--link" href="#/lifegroups?tab=progress"><b>${fmtNum(st.open_cell)}</b><span>Open cell</span></a>`; })()}
          <a class="kpi kpi--link ${d.lifegroups.without_group ? 'kpi--amber' : ''}" href="#/lifegroups?tab=needs"><b>${fmtNum(d.lifegroups.without_group)}</b><span>Without Lifegroup</span></a>
          <a class="kpi kpi--link" href="#/lifegroups?tab=needs"><b>${fmtNum(d.lifegroups.new_needing_connection)}</b><span>New, needs connection</span></a>
        </div>
        ${d.needs_lifegroup && d.needs_lifegroup.length ? html`<div class="mt-2 small muted">Needs Lifegroup — most recent attendees first:</div>
          <div class="row mt-1" style="gap:6px 14px">${d.needs_lifegroup.map((p) => html`<a href="#/people/${p.id}" class="small">${p.first_name} ${p.last_name}</a>`)}${d.lifegroups.without_group > d.needs_lifegroup.length ? html`<a class="small muted" href="#/lifegroups?tab=needs">+${d.lifegroups.without_group - d.needs_lifegroup.length} more</a>` : ''}</div>` : ''}
      </div>
    </div>` : ''}

    <div class="card">
      <div class="card__header"><h2>Recent Sundays</h2><a class="small" href="#/attendance/history">All history ${icon('chevR', 13)}</a></div>
      <div class="table-wrap"><table class="table table--compact">
        <thead><tr><th>Sunday</th><th class="num">Present</th><th class="num">First timers</th><th class="num">Returning</th></tr></thead>
        <tbody>${d.recent.map((s) => html`<tr class="clickable" data-id="${s.id}">
          <td>${fmtDate(s.service_date, { short: true })}</td>
          <td class="num"><b>${fmtNum(s.present_count)}</b></td>
          <td class="num">${fmtNum(s.first_timer_count)}</td>
          <td class="num">${fmtNum(s.returning_count)}</td>
        </tr>`)}</tbody>
      </table></div>
    </div>`}
  `;

  main.querySelectorAll('tr.clickable').forEach((tr) => { tr.onclick = () => { location.hash = `#/attendance/history/${tr.dataset.id}`; }; });
}
