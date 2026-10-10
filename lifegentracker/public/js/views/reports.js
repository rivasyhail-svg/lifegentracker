import { api } from '../api.js';
import { state } from '../app.js';
import { html, raw, icon, fmtDate, fmtNum, fmtPct, fmtMonth, fmtMonthShort, emptyState, downloadUrl, toISODate, lastSunday } from '../ui.js';
import { barChart, lineChart, donutChart, multiLineChart } from '../charts.js';
import { ratioBar, genderBadge } from './lifegroups.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const shortSunday = (d) => { const [, m, day] = d.split('-'); return `${MONTHS[+m - 1].slice(0, 3)} ${+day}`; };

export async function renderReports({ main, query }) {
  if (query.view === 'lifegroups') return renderLifegroupReport({ main });
  const years = await api.reportYears();
  const now = new Date();
  const mode = query.mode || (query.year && !query.quarter && !query.month ? 'year' : query.quarter ? 'quarter' : query.from ? 'range' : 'month');
  const sunday = query.week && query.week.match(/^\d{4}-\d{2}-\d{2}$/) ? query.week : toISODate(lastSunday());
  const sel = {
    mode,
    year: Number(query.year) || now.getFullYear(),
    month: Number(query.month) || now.getMonth() + 1,
    quarter: Number(query.quarter) || Math.floor(now.getMonth() / 3) + 1,
    from: query.from || toISODate(new Date(now.getFullYear(), now.getMonth() - 2, 1)),
    to: query.to || toISODate(lastSunday()),
    week: sunday,
  };

  main.innerHTML = html`
    <div class="page-header">
      <div><h1>Reports</h1><p class="sub">Lifegen attendance for a week, month, quarter or year.</p></div>
      <div class="page-actions">
        <div class="filter-tabs" style="margin:0"><button class="active">Attendance</button><button id="toLgReport">Lifegroups</button></div>
        <button class="btn" id="printBtn">${icon('print')} Print / PDF</button>
        <div class="row" style="position:relative">
          <button class="btn" id="exportBtn">${icon('download')} Export</button>
          <div class="gsearch__results" id="exportMenu" hidden style="left:auto;right:0;min-width:240px;top:calc(100% + 6px)">
            <a class="gsearch__item" href="#" data-x="weekly">Weekly breakdown (CSV)</a>
            <a class="gsearch__item" href="#" data-x="monthly">Monthly breakdown (CSV)</a>
            <a class="gsearch__item" href="#" data-x="detail">Per-person detail (CSV)</a>
          </div>
        </div>
      </div>
    </div>

    <div class="card mb-2"><div class="card__body">
      <div class="row row--between" style="gap:12px">
        <div class="segmented" id="modeSeg">
          ${['week', 'month', 'quarter', 'year', 'range'].map((m) => html`<button data-m="${m}" class="${sel.mode === m ? 'active' : ''}">${m === 'range' ? 'Custom' : m[0].toUpperCase() + m.slice(1)}</button>`)}
        </div>
        <div class="row" id="pickers"></div>
      </div>
    </div></div>

    <div id="report"><div class="loading">Building report…</div></div>`;

  const pickers = main.querySelector('#pickers');
  const yearOpts = (v) => years.map((y) => html`<option value="${y}" ${y === v ? 'selected' : ''}>${y}</option>`);

  function drawPickers() {
    const m = sel.mode;
    pickers.innerHTML = html`
 ${m === 'week' ? html`<input type="date" id="pWeek" value="${sel.week}" style="width:auto" aria-label="Sunday" />` : ''}
      ${m === 'month' ? html`<select id="pMonth" style="width:auto">${MONTHS.map((n, i) => html`<option value="${i + 1}" ${sel.month === i + 1 ? 'selected' : ''}>${n}</option>`)}</select>` : ''}
      ${m === 'quarter' ? html`<select id="pQuarter" style="width:auto">${[1, 2, 3, 4].map((q) => html`<option value="${q}" ${sel.quarter === q ? 'selected' : ''}>Q${q} (${MONTHS[(q - 1) * 3].slice(0, 3)}–${MONTHS[q * 3 - 1].slice(0, 3)})</option>`)}</select>` : ''}
      ${m !== 'range' && m !== 'week' ? html`<select id="pYear" style="width:auto">${yearOpts(sel.year)}</select>` : ''}
      ${m === 'range' ? html`<input type="date" id="pFrom" value="${sel.from}" style="width:auto"/> <span class="muted">to</span> <input type="date" id="pTo" value="${sel.to}" style="width:auto"/>` : ''}`;
    pickers.querySelectorAll('select,input').forEach((el) => (el.onchange = () => {
      if (el.id === 'pWeek') { const v = el.value; sel.week = v && new Date(v + 'T12:00:00').getDay() === 0 ? v : toISODate(lastSunday(new Date(v + 'T12:00:00'))); el.value = sel.week; }
      if (el.id === 'pMonth') sel.month = Number(el.value);
      if (el.id === 'pQuarter') sel.quarter = Number(el.value);
      if (el.id === 'pYear') sel.year = Number(el.value);
      if (el.id === 'pFrom') sel.from = el.value;
      if (el.id === 'pTo') sel.to = el.value;
      load();
    }));
  }

  function params() {
    if (sel.mode === 'week') return { from: sel.week, to: sel.week };
    if (sel.mode === 'month') return { year: sel.year, month: sel.month };
    if (sel.mode === 'quarter') return { year: sel.year, quarter: sel.quarter };
    if (sel.mode === 'year') return { year: sel.year };
    return { from: sel.from, to: sel.to };
  }

  main.querySelector('#modeSeg').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    sel.mode = b.dataset.m;
    main.querySelectorAll('#modeSeg button').forEach((x) => x.classList.toggle('active', x === b));
    drawPickers(); load();
  };
  main.querySelector('#toLgReport').onclick = () => { location.hash = '#/reports?view=lifegroups'; };
  main.querySelector('#printBtn').onclick = () => window.print();
  const exportMenu = main.querySelector('#exportMenu');
  main.querySelector('#exportBtn').onclick = (e) => { e.stopPropagation(); exportMenu.hidden = !exportMenu.hidden; };
  document.addEventListener('click', () => { exportMenu.hidden = true; }, { once: false });
  exportMenu.onclick = (e) => {
    const a = e.target.closest('[data-x]'); if (!a) return;
    e.preventDefault();
    downloadUrl(`/api/reports/export/${a.dataset.x}.csv${api.qs(params())}`);
    exportMenu.hidden = true;
  };

  const report = main.querySelector('#report');

  async function load() {
    history.replaceState(null, '', '#/reports' + api.qs({ mode: sel.mode, ...(sel.mode === 'week' ? { week: sel.week } : params()) }));
    report.innerHTML = '<div class="loading">Building report…</div>';
    let r;
    try { r = await api.reportSummary(params()); } catch (err) { report.innerHTML = html`<div class="alert alert--error">${err.message}</div>`; return; }
    const t = r.totals;

    if (!r.weekly.length) {
      report.innerHTML = html`<div class="card">${raw(emptyState({ icon: 'chart', title: `No attendance recorded for ${r.range.label}`, text: 'Choose a different period, or record Sundays on the Attendance page.' }))}</div>`;
      return;
    }

    report.innerHTML = html`
      <div class="print-header"><h1>${state.settings.church_name} — Lifegen Attendance Report</h1><p>${r.range.label} · generated ${fmtDate(toISODate(new Date()))}</p></div>
      <div class="card mb-2">
        <div class="card__header"><h2>${r.range.label}</h2><span class="hint">${fmtDate(r.range.from || r.weekly[0].service_date, { short: true })} – ${fmtDate(r.range.to || r.weekly.at(-1).service_date, { short: true })} · ${t.services} Sunday${t.services === 1 ? '' : 's'}</span></div>
        <div class="card__body kpi-row">
          <div class="kpi kpi--teal"><b>${fmtNum(t.total_attendance)}</b><span>Total attendance</span></div>
          <div class="kpi"><b>${fmtNum(t.average_attendance)}</b><span>Average / Sunday</span></div>
          <div class="kpi kpi--green"><b>${fmtNum(t.highest?.present_count)}</b><span>Highest · ${t.highest ? fmtDate(t.highest.service_date, { short: true }) : ''}</span></div>
          <div class="kpi kpi--red"><b>${fmtNum(t.lowest?.present_count)}</b><span>Lowest · ${t.lowest ? fmtDate(t.lowest.service_date, { short: true }) : ''}</span></div>
          <div class="kpi kpi--amber"><b>${fmtNum(t.first_timers)}</b><span>First timers</span></div>
          <div class="kpi kpi--blue"><b>${fmtNum(t.returning)}</b><span>Returning</span></div>
          <div class="kpi"><b>${fmtPct(t.average_rate)}</b><span>Avg attendance rate</span></div>
          <div class="kpi"><b>${fmtNum(t.unique_attendees)}</b><span>Unique people</span></div>
          <div class="kpi"><b>${fmtNum(t.new_registrations)}</b><span>New registrations</span></div>
        </div>
      </div>

      <div class="grid grid--2 mb-2">
        <div class="card">
          <div class="card__header"><h2>Weekly attendance</h2><span class="legend-row"><span>Returning</span><span class="alt">First timers</span></span></div>
          <div class="card__body">${raw(barChart(r.weekly.map((w) => ({ label: shortSunday(w.service_date), returning: w.returning_count, first: w.first_timer_count, title: fmtDate(w.service_date) })), { stacked: [{ key: 'returning', label: 'Returning' }, { key: 'first', label: 'First timers', cls: 'bar--alt' }], showValues: true, aria: 'Weekly attendance' }))}</div>
        </div>
        <div class="card">
          <div class="card__header"><h2>Attendance trend</h2><span class="legend-row"><span>Present</span><span class="alt">4-week average</span></span></div>
          <div class="card__body">${raw(lineChart(r.weekly.map((w) => ({ label: shortSunday(w.service_date), value: w.present_count, title: fmtDate(w.service_date) })), { average: true }))}</div>
        </div>
        ${r.monthly.length > 1 ? html`<div class="card">
          <div class="card__header"><h2>Monthly attendance</h2><span class="hint">Total present per month</span></div>
          <div class="card__body">${raw(barChart(r.monthly.map((m) => ({ label: fmtMonthShort(m.month), value: m.present, title: fmtMonth(m.month) })), { aria: 'Monthly attendance' }))}</div>
        </div>` : ''}
        <div class="card">
          <div class="card__header"><h2>First timers vs returning</h2></div>
          <div class="card__body">${raw(donutChart([{ label: 'Returning', value: t.returning, color: '#0f766e' }, { label: 'First timers', value: t.first_timers, color: '#b9ddd8' }], { centerLabel: 'present' }))}</div>
        </div>
      </div>

      <div class="card mb-2">
        <div class="card__header"><h2>Weekly breakdown</h2></div>
        <div class="table-wrap"><table class="table table--stack">
          <thead><tr><th>Sunday</th><th class="num">Present</th><th class="num">First timers</th><th class="num">Returning</th><th class="num">Absent</th><th class="num">Registered</th><th class="num">Rate</th></tr></thead>
          <tbody>${r.weekly.map((w) => html`<tr>
            <td data-label="Sunday"><a href="#/attendance/history/${w.id}">${fmtDate(w.service_date)}</a></td>
            <td data-label="Present" class="num"><b>${w.present_count}</b></td><td data-label="First timers" class="num">${w.first_timer_count}</td>
            <td data-label="Returning" class="num">${w.returning_count}</td><td data-label="Absent" class="num">${w.absent_count}</td>
            <td data-label="Registered" class="num">${w.registered_base}</td><td data-label="Rate" class="num">${fmtPct(w.attendance_rate)}</td></tr>`)}</tbody>
          <tfoot><tr><td data-label="">Total / average</td><td data-label="Present" class="num">${t.total_attendance}</td><td data-label="First timers" class="num">${t.first_timers}</td><td data-label="Returning" class="num">${t.returning}</td><td data-label="Absent" class="num">${t.absent}</td><td data-label="" class="num">—</td><td data-label="Rate" class="num">${fmtPct(t.average_rate)}</td></tr></tfoot>
        </table></div>
      </div>

      <div class="card">
        <div class="card__header"><h2>Monthly breakdown</h2></div>
        <div class="table-wrap"><table class="table table--stack">
          <thead><tr><th>Month</th><th class="num">Sundays</th><th class="num">Total present</th><th class="num">Average</th><th class="num">First timers</th><th class="num">Returning</th><th class="num">Absent</th></tr></thead>
          <tbody>${r.monthly.map((m) => html`<tr>
            <td data-label="Month"><b>${fmtMonth(m.month)}</b></td><td data-label="Sundays" class="num">${m.services}</td><td data-label="Total" class="num"><b>${m.present}</b></td>
            <td data-label="Average" class="num">${m.average}</td><td data-label="First timers" class="num">${m.first_timers}</td><td data-label="Returning" class="num">${m.returning}</td><td data-label="Absent" class="num">${m.absent}</td></tr>`)}</tbody>
        </table></div>
      </div>`;
  }

  drawPickers();
  load();
}


// ---------------------------------------------------------------------------
// Lifegroup report — who is connected, per Network and per group, boys vs girls
// ---------------------------------------------------------------------------
async function renderLifegroupReport({ main }) {
  main.innerHTML = html`
    <div class="page-header">
      <div><h1>Reports</h1><p class="sub">Network status, Lifegroup statistics and growth.</p></div>
      <div class="page-actions">
        <div class="filter-tabs" style="margin:0"><button id="toAtt">Attendance</button><button class="active">Lifegroups</button></div>
        <button class="btn" id="printBtn">${icon('print')} Print / PDF</button>
        <button class="btn" id="csvNet">${icon('download')} Network CSV</button>
        <button class="btn" id="csvBtn">${icon('download')} Lifegroups CSV</button>
      </div>
    </div>
    <div id="report"><div class="loading">Building report…</div></div>`;
  main.querySelector('#toAtt').onclick = () => { location.hash = '#/reports'; };
  main.querySelector('#printBtn').onclick = () => window.print();
  main.querySelector('#csvBtn').onclick = () => downloadUrl('/api/reports/export/lifegroups.csv');
  main.querySelector('#csvNet').onclick = () => downloadUrl('/api/reports/export/network-status.csv');
  const report = main.querySelector('#report');
  let r, ns;
  try { [r, ns] = await Promise.all([api.reportLifegroups(), api.networkStats()]); } catch (e) { report.innerHTML = html`<div class="alert alert--error">${e.message}</div>`; return; }
  const t = r.totals;
  if (!r.groups.length) { report.innerHTML = html`<div class="card">${emptyState({ icon: 'group', title: 'No active Lifegroups yet', text: 'Create Lifegroups and connect people to see this report.' })}</div>`; return; }
  const pctTxt = (v) => (v == null ? '—' : `${v}%`);
  const gr = r.growth || { months: [], summary: { boys: {}, girls: {} } };
  const gs = gr.summary;
  const cls = (n) => (n > 0 ? 'delta--up' : n < 0 ? 'delta--down' : 'delta--flat');
  const sign = (n) => (n > 0 ? '+' : n < 0 ? '−' : '');
  const delta = (change, pct) => raw(`<i class="delta ${cls(change)}">${sign(change)}${Math.abs(change || 0)}${pct == null ? (change > 0 ? ' <small>new</small>' : '') : ` <small>(${sign(pct)}${Math.abs(pct)}%)</small>`}</i>`);
  const pctDelta = (pct) => (pct == null ? raw('<span class="muted">—</span>') : raw(`<i class="delta ${cls(pct)}">${sign(pct)}${Math.abs(pct)}%</i>`));
  const monthLabel = (ym, long = false) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-PH', long ? { month: 'short', year: 'numeric' } : { month: 'short' }); };
  const bar = (pct, color = 'var(--brand-600)') => (pct == null ? raw('<span class="muted">—</span>') : raw(`<span class="pbar" title="${pct}%"><i style="width:${pct}%;background:${color}"></i></span><span class="small">${pct}%</span>`));
  const nt = ns.totals;
  const bySex = (label, x) => html`<tr><td><b>${label}</b></td><td class="num">${x.groups}</td><td class="num">${x.solid_groups}</td><td class="num">${x.total_members}</td><td class="num">${x.solid_members}</td><td class="num">${pctTxt(x.total_members ? Math.round((x.solid_members / x.total_members) * 100) : null)}</td><td class="num">${x.met_this_week}/${x.groups}</td><td class="num">${pctTxt(x.consistency_pct)}</td></tr>`;
  const solidById = new Map(ns.networks.map((n) => [n.id || 0, n]));
  report.innerHTML = html`
    <div class="print-header"><h1>${state.settings.church_name} — Lifegroup Report</h1><p>Network status and Lifegroup statistics · generated ${fmtDate(toISODate(new Date()))}</p></div>
    ${(() => { const st = ns.structure || {}; const sec = (label, x) => html`<div class="card sexsplit__card">
        <div class="card__header"><h2>${label}</h2><span class="hint">${x.lifegroups} Lifegroup${x.lifegroups === 1 ? '' : 's'} · ${x.members} members</span></div>
        <div class="card__body"><div class="kpi-row kpi-row--4">
          <div class="kpi"><b>${fmtNum(x.networks)}</b><span>Networks</span></div>
          <div class="kpi"><b>${fmtNum(x.cell_leaders)}</b><span>Cell leaders</span></div>
          <div class="kpi"><b>${fmtNum(x.open_cell)}</b><span>Open cell</span></div>
          <div class="kpi kpi--teal"><b>${fmtNum(x.closed_cell)}</b><span>Closed cell</span></div>
        </div></div>
      </div>`; return html`<div class="sexsplit mb-2">${sec('Boys', st.boys || { networks: 0, cell_leaders: 0, lifegroups: 0, members: 0, open_cell: 0, closed_cell: 0 })}${sec('Girls', st.girls || { networks: 0, cell_leaders: 0, lifegroups: 0, members: 0, open_cell: 0, closed_cell: 0 })}</div>`; })()}

    <div class="card mb-2">
      <div class="card__header"><h2>Network status</h2><span class="hint">ratios per Network · last 4 weeks</span></div>
      <div class="table-wrap"><table class="table table--stack table--wide">
        <thead><tr><th>Network</th><th class="num">Lifegroups</th><th class="num">Members</th><th class="num">Closed cell</th><th class="num">Open cell</th><th>Closed %</th><th class="num">Solid groups</th><th class="num">Met this week</th><th>Held (4 wks)</th><th>LG attendance</th><th>Devotion</th><th>At Lifegen</th></tr></thead>
        <tbody>${ns.networks.map((n) => html`<tr>
          <td data-label="">${n.id ? html`<a href="#/networks/${n.id}"><b>${n.name}</b></a> ${genderBadge(n.gender)}` : html`<span class="muted">${n.name}</span>`}${n.leader_name ? html`<div class="small muted">${n.leader_name}</div>` : ''}</td>
          <td data-label="Lifegroups" class="num">${n.groups}</td>
          <td data-label="Members" class="num"><b>${n.members}</b></td>
          <td data-label="Closed cell" class="num">${n.solid_members}</td>
          <td data-label="Open cell" class="num">${n.new_members}</td>
          <td data-label="Closed %">${bar(n.solid_pct)}</td>
          <td data-label="Solid groups" class="num">${n.solid_groups}<span class="muted small">/${n.groups}</span></td>
          <td data-label="Met this week" class="num ${n.met_this_week < n.groups ? 'warn-text' : ''}">${n.met_this_week}<span class="muted small">/${n.groups}</span></td>
          <td data-label="Held (4 wks)">${bar(n.consistency_pct, n.consistency_pct >= 75 ? 'var(--green-600)' : n.consistency_pct >= 50 ? 'var(--amber-600)' : 'var(--red-600)')}</td>
          <td data-label="LG attendance">${bar(n.avg_attendance_pct)}${n.avg_present != null ? html`<div class="small muted">avg ${n.avg_present} present</div>` : ''}</td>
          <td data-label="Devotion">${bar(n.devotion_pct)}</td>
          <td data-label="At Lifegen">${n.sunday ? bar(n.sunday.pct) : raw('<span class="muted">—</span>')}</td>
        </tr>`)}</tbody>
        <tfoot><tr><td data-label="">Total</td><td data-label="Lifegroups" class="num">${nt.groups}</td><td data-label="Members" class="num">${nt.members}</td><td data-label="Closed cell" class="num">${nt.solid_members}</td><td data-label="Open cell" class="num">${nt.members - nt.solid_members}</td><td data-label="Closed %">${pctTxt(nt.solid_pct)}</td><td data-label="Solid groups" class="num">${nt.solid_groups}</td><td data-label="Met this week" class="num">${nt.met_this_week}/${nt.groups}</td><td data-label="Held (4 wks)">${pctTxt(nt.consistency_pct)}</td><td data-label="LG attendance"></td><td data-label="Devotion">${pctTxt(nt.devotion_pct)}</td><td data-label="At Lifegen">${pctTxt(nt.sunday_pct)}</td></tr></tfoot>
      </table></div>
      <div class="card__footer small muted">Closed % = closed cell (matagal na, consistent) ÷ all members · Open cell = mga bago · Held = weeks with a Lifegroup ÷ 4 weeks × groups · LG attendance = average present ÷ average group size · Devotion = members with at least one devotion tap in 4 weeks · At Lifegen = members present last Sunday.</div>
    </div>

    <div class="card mb-2"><div class="card__header"><h2>Boys vs girls</h2></div><div class="card__body card__body--flush"><div class="table-wrap"><table class="table">
      <thead><tr><th></th><th class="num">Lifegroups</th><th class="num">Solid groups</th><th class="num">Members</th><th class="num">Closed cell</th><th class="num">Closed %</th><th class="num">Met this week</th><th class="num">Held (4 wks)</th></tr></thead>
      <tbody>${bySex('Boys', ns.by_gender.boys)}${bySex('Girls', ns.by_gender.girls)}</tbody></table></div></div></div>

    <div class="card mb-2" id="growthCard">
      <div class="card__header"><h2>Growth</h2><span class="hint">members at end of each month · last ${gr.months.length} month${gr.months.length === 1 ? '' : 's'}</span></div>
      <div class="card__body">
        <div class="kpi-row mb-2" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
          <div class="kpi kpi--blue"><b>${delta(gs.boys.change_30d, gs.boys.pct_30d)}</b><span>Boys groups · 30 days</span><small class="muted">${gs.boys.days30_ago} → ${gs.boys.now} members</small></div>
          <div class="kpi" style="background:#fdf2f8;border-color:#fbcfe8"><b>${delta(gs.girls.change_30d, gs.girls.pct_30d)}</b><span>Girls groups · 30 days</span><small class="muted">${gs.girls.days30_ago} → ${gs.girls.now} members</small></div>
          <div class="kpi kpi--blue"><b>${delta(gs.boys.change_90d, gs.boys.pct_90d)}</b><span>Boys groups · 90 days</span><small class="muted">${gs.boys.days90_ago} → ${gs.boys.now} members</small></div>
          <div class="kpi" style="background:#fdf2f8;border-color:#fbcfe8"><b>${delta(gs.girls.change_90d, gs.girls.pct_90d)}</b><span>Girls groups · 90 days</span><small class="muted">${gs.girls.days90_ago} → ${gs.girls.now} members</small></div>
        </div>
        ${raw(multiLineChart(gr.months.map((m) => monthLabel(m.month)), [{ name: 'Boys groups', color: '#2563eb', values: gr.months.map((m) => m.boys_end) }, { name: 'Girls groups', color: '#db2777', values: gr.months.map((m) => m.girls_end) }], { aria: 'Members in boys groups and girls groups per month' }))}
        <div class="table-wrap mt-2"><table class="table table--stack table--compact">
          <thead><tr><th>Month</th><th class="num">Boys groups</th><th class="num">Joined</th><th class="num">Left</th><th class="num">Growth</th><th class="num">Girls groups</th><th class="num">Joined</th><th class="num">Left</th><th class="num">Growth</th></tr></thead>
          <tbody>${gr.months.map((m) => html`<tr>
            <td data-label="">${monthLabel(m.month, true)}</td>
            <td data-label="Boys groups" class="num"><b>${m.boys_end}</b></td><td data-label="Joined" class="num">${m.boys_joined ? '+' + m.boys_joined : '0'}</td><td data-label="Left" class="num">${m.boys_left ? '−' + m.boys_left : '0'}</td><td data-label="Growth" class="num">${pctDelta(m.boys_growth_pct)}</td>
            <td data-label="Girls groups" class="num"><b>${m.girls_end}</b></td><td data-label="Joined" class="num">${m.girls_joined ? '+' + m.girls_joined : '0'}</td><td data-label="Left" class="num">${m.girls_left ? '−' + m.girls_left : '0'}</td><td data-label="Growth" class="num">${pctDelta(m.girls_growth_pct)}</td>
          </tr>`)}</tbody>
        </table></div>
        <p class="small muted mt-1">Growth = change in members versus the previous month. <a href="#" id="growthCsv">Download growth CSV</a></p>
      </div>
    </div>

    <div class="card">
      <div class="card__header"><h2>Per Lifegroup</h2><span class="hint">active groups only</span></div>
      <div class="table-wrap"><table class="table table--stack">
        <thead><tr><th>Network</th><th>Lifegroup</th><th>Leader</th><th class="num">Members</th><th class="num">Closed cell</th><th class="num">Open cell</th><th>Closed %</th><th class="num">Last 30 days</th></tr></thead>
        <tbody>${r.groups.map((g) => { const sg = solidOf(g); return html`<tr>
          <td data-label="Network">${g.network_name || raw('<span class="muted">—</span>')}</td>
          <td data-label=""><a href="#/lifegroups/${g.group_id}"><b>${g.group_name}</b></a> ${genderBadge(g.gender)}</td>
          <td data-label="Leader">${g.leader_name || raw('<span class="muted">—</span>')}</td>
          <td data-label="Members" class="num"><b>${g.members}</b></td>
          <td data-label="Closed cell" class="num">${sg ? sg.solid : '—'}</td>
          <td data-label="Open cell" class="num">${sg ? g.members - sg.solid : '—'}</td>
          <td data-label="Closed %">${sg && g.members ? bar(Math.round((sg.solid / g.members) * 100)) : raw('<span class="muted">—</span>')}</td>
          <td data-label="Last 30 days" class="num">${delta(g.net_30d, g.growth_30d_pct)}</td>
        </tr>`; })}</tbody>
      </table></div>
    </div>`;
  function solidOf(g) { return r.group_solid ? r.group_solid[g.group_id] : null; }
  report.querySelector('#growthCsv')?.addEventListener('click', (e) => { e.preventDefault(); downloadUrl('/api/reports/export/lifegroup-growth.csv'); });
}
