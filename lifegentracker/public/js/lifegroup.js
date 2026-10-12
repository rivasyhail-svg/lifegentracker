// Lifegroup leader report page (/lifegroup?t=TOKEN). No login: the token in the link is the key.
// Mobile-first, tap-only: date → who was there (+ devotion) → send. Network leaders also see every
// Lifegroup in their network with each member's last 4 weeks.
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'LifegenTracker' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const token = new URLSearchParams(location.search).get('t') || '';
const body = document.getElementById('lgBody');
const lead = document.getElementById('lgLead');
const title = document.getElementById('lgTitle');

async function call(method, path, data) {
  const res = await fetch(path, { method, headers: H, body: data === undefined ? undefined : JSON.stringify(data), cache: 'no-store' });
  let out = null; try { out = await res.json(); } catch { /* no body */ }
  if (!res.ok) { const e = new Error(out?.error || `Request failed (${res.status})`); e.status = res.status; e.details = out?.details; throw e; }
  return out;
}
function toast(msg, type = 'success') {
  const t = document.createElement('div'); t.className = `toast toast--${type}`; t.textContent = msg;
  document.getElementById('toasts').appendChild(t); setTimeout(() => t.remove(), 3600);
}
const fmtDate = (s) => { const d = new Date(`${s}T00:00:00`); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
const weekLabel = (s) => { const d = new Date(`${s}T00:00:00`); return `${d.toLocaleDateString('en-US', { month: 'short' })} ${d.getDate()}`; };
const DAY = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const TIER = { solid: 'Closed cell', new: 'Open cell' };

let d = null;
let view = null; // network leaders: 'leaders' | 'report'; regular leaders: always 'report' (one page)
let draft = { date: null, held: true, present: new Set(), devotion: new Set(), newbies: [] };
const openLeaders = new Set(); // which cell-leader rows are expanded (kept across re-renders)

/** Four small cells: LG attended / devotion for each of the last 4 weeks. */
function dots(last4) {
  if (!last4) return '';
  return `<span class="m4" aria-label="Last 4 weeks">${last4.weeks.map((w) => `<i class="m4__c ${!w.held ? 'm4__c--none' : w.present ? 'm4__c--on' : 'm4__c--off'} ${w.devotion ? 'm4__c--devo' : ''}" title="Week of ${weekLabel(w.week_start)}: ${!w.held ? 'no Lifegroup' : w.present ? 'attended' : 'absent'}${w.devotion ? ' · devotion' : ''}"></i>`).join('')}</span>`;
}
const pctTxt = (l4) => (l4 && l4.consistency_pct != null ? `${l4.consistency_pct}%` : '—');

function memberRows(list, { tapTier, groupId, inactive = false } = {}) {
  if (!list.length) return '<div class="small muted" style="padding:6px 0">None yet.</div>';
  return `<div class="mlist">${list.map((m) => `<div class="mlist__row">
    <div class="mlist__who"><b>${esc(m.name)}</b>${m.role && m.role !== 'member' ? ` <span class="badge badge--leader">${m.role === 'leader' ? 'Leader' : 'Assistant'}</span>` : ''}
      <div class="small muted">${pctTxt(m.last4)} of Lifegroups · ${m.last4 ? m.last4.devotions : 0} devotion${m.last4 && m.last4.devotions === 1 ? '' : 's'} (4 wks)</div></div>
    ${dots(m.last4)}
    ${tapTier ? `<div class="mlist__act"><button type="button" class="btn btn--sm ${m.tier === 'solid' ? 'btn--ghost' : 'btn--primary'}" data-tier="${m.id}" data-group="${groupId || ''}" data-to="${m.tier === 'solid' ? 'new' : 'solid'}" title="${m.tier === 'solid' ? 'Move to Open cell' : 'Move to Closed cell'}">${m.tier === 'solid' ? '← Open cell' : 'Closed cell →'}</button>${inactive ? `<button type="button" class="btn btn--sm btn--ghost mlist__off" data-inactive="${m.id}" title="Not active anymore — remove from my Lifegroup">Not active</button>` : ''}</div>` : ''}
  </div>`).join('')}</div>`;
}

/** Network leader: "My cell leaders" — just the names and whether they were present (their last 4 weeks in my
 *  Lifegroup). Tap a name → that leader's own members appear in Open cell / Closed cell and can be moved there. */
let mon = null;            // weekly monitoring data for the selected week (network leaders only)
let monBusy = false;       // loading a week
let monErr = '';
let leaderFilter = '';     // '' = all cell leaders
const addDaysISO = (iso, n) => { const t = new Date(`${iso}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

async function loadMonitor(date) {
  monBusy = true; monErr = ''; render();
  try { mon = await call('GET', `/api/public/lifegroup/${encodeURIComponent(token)}/monitor${date ? `?date=${encodeURIComponent(date)}` : ''}`); }
  catch (e) { monErr = e.message; if (e.status === 404) setTimeout(load, 1500); }
  monBusy = false; render();
}

/** Three-state control: Present / Absent / Not yet (or Yes / No / Not yet). */
function tri(kind, value, { labels, person = '', group = '', disabled = false, title = '' }) {
  const opts = [['present', labels[0], 'tri__on-yes'], ['absent', labels[1], 'tri__on-no'], ['clear', labels[2], 'tri__on-none']];
  return `<span class="tri ${disabled ? 'is-disabled' : ''}" role="group" aria-label="${esc(title)}">${opts.map(([v, l, cls]) => {
    const on = v === 'clear' ? !value : value === v;
    return `<button type="button" class="tri__b ${on ? `is-on ${cls}` : ''}" data-tri="${v}" data-kind="${kind}" data-person="${person}" data-group="${group}" aria-pressed="${on}" ${disabled ? 'disabled' : ''}>${l}</button>`;
  }).join('')}</span>`;
}

function cellLeadersView() {
  const net = d.network;
  const byGroupId = new Map(net.groups.map((g) => [g.id, g]));
  const cell = (g, tier, list) => `<section class="cell cell--${tier === 'solid' ? 'closed' : 'open'}">
      <header class="cell__head"><b>${TIER[tier]}</b> <span class="muted">· ${list.length}${tier === 'solid' ? ` / ${g.target}` : ''}</span><span class="small muted cell__hint">${tier === 'solid' ? (list.length >= g.target ? 'solid ✓' : `max ${g.target}`) : ''}</span></header>
      <div style="padding:2px 10px 6px">${memberRows(list, { tapTier: true, groupId: g.id })}</div>
    </section>`;
  const strip = (g) => `<div class="wk wk--sm" aria-label="Their Lifegroup, last ${g.calendar.length} weeks">${g.calendar.map((w) => { const m = w.meeting; return `<span class="wk__c ${!m ? 'wk__c--none' : m.held ? 'wk__c--held' : 'wk__c--skip'}" title="Week of ${weekLabel(w.week_start)}: ${!m ? 'no report' : m.held ? m.present_count + ' present' : 'no Lifegroup'}"></span>`; }).join('')}</div>`;
  const recent = (g) => g.recent && g.recent.length ? `<ul class="cl__recent">${g.recent.map((m) => `<li><b>${fmtDate(m.meeting_date)}</b> — ${m.held ? `${m.present_count} present${m.present.length ? `: ${esc(m.present.join(', '))}` : ''}` : `no Lifegroup${m.no_meeting_reason ? ` (${esc(m.no_meeting_reason)})` : ''}`}</li>`).join('')}</ul>` : '<div class="small muted">No reports yet.</div>';

  // ---- week toolbar + summary ----
  const wk = mon ? `${fmtDate(mon.week_start)} – ${fmtDate(mon.week_end)}` : '';
  const toolbar = `<section class="card reg-card mon-bar">
      <div class="row row--between" style="gap:8px;flex-wrap:wrap;align-items:center">
        <div><b>Week</b> <span class="small muted">${wk}${mon && mon.is_current_week ? ' · this week' : ''}</span></div>
        <div class="mon-ctl">
          <button type="button" class="btn btn--sm" id="monPrev" ${monBusy ? 'disabled' : ''} aria-label="Previous week">‹</button>
          <input type="date" class="input input--sm" id="monDate" value="${mon ? mon.date : d.today}" max="${d.today}" aria-label="Pick any date in the week" ${monBusy ? 'disabled' : ''} />
          <button type="button" class="btn btn--sm" id="monNext" ${monBusy || !mon || mon.is_current_week ? 'disabled' : ''} aria-label="Next week">›</button>
        </div>
      </div>
      ${mon && mon.leaders.length > 1 ? `<div class="row mt-1" style="gap:8px;align-items:center"><label class="small muted" for="monFilter">Show</label><select class="select select--sm" id="monFilter"><option value="">All cell leaders</option>${mon.leaders.map((l) => `<option value="${l.id}" ${String(leaderFilter) === String(l.id) ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>` : ''}
    </section>`;
  const sm = mon && mon.summary;
  const summary = sm ? `<div class="mon-sum" aria-label="Weekly summary">
      <div class="card reg-card mon-sum__c"><span class="mon-sum__t">Cell leaders</span><b class="mon-sum__v">${sm.leaders.present}<small>/${sm.leaders.total} present</small></b><span class="small muted">${sm.leaders.absent} absent · ${sm.leaders.unrecorded} not yet recorded</span></div>
      <div class="card reg-card mon-sum__c"><span class="mon-sum__t">Lifegroups</span><b class="mon-sum__v">${sm.lifegroups.conducted}<small>/${sm.lifegroups.total} conducted</small></b><span class="small muted">${sm.lifegroups.not_conducted} not conducted · ${sm.lifegroups.not_reported} not yet reported</span></div>
      <div class="card reg-card mon-sum__c"><span class="mon-sum__t">Reports</span><b class="mon-sum__v">${sm.reports.submitted}<small>/${sm.lifegroups.total} submitted</small></b><span class="small muted">${sm.reports.pending} pending</span></div>
      <div class="card reg-card mon-sum__c"><span class="mon-sum__t">Members</span><b class="mon-sum__v">${sm.members.present}<small>/${sm.members.registered} present</small></b><span class="small muted">${sm.members.absent} absent · ${sm.members.unrecorded} not yet recorded · ${sm.members.sessions} session${sm.members.sessions === 1 ? '' : 's'}</span></div>
    </div>` : '';

  // ---- one card per cell leader ----
  const item = (r) => {
    const g = r.group ? byGroupId.get(r.group.id) : null; // existing 4-week view (strip, recent, Open/Closed cell)
    const open = openLeaders.has(String(r.id));
    const rep = r.report;
    const repLine = rep.status === 'yes' ? `<span class="badge badge--present badge--nodot">Conducted · ${fmtDate(rep.meeting_date)}</span>`
      : rep.status === 'no' ? `<span class="badge badge--absent badge--nodot">Not conducted</span>${rep.reason ? ` <span class="small muted">· ${esc(rep.reason)}</span>` : ''}`
      : '<span class="badge badge--nodot">Not yet reported</span>';
    const members = rep.status === 'yes' ? `<div class="mon-members">
        <div class="row row--between" style="gap:8px;flex-wrap:wrap;align-items:baseline">
          <div><b>Member attendance</b> <span class="small muted">· ${esc(r.group.name)} · ${fmtDate(rep.meeting_date)}</span></div>
          <div class="small"><b class="ok">${r.totals.present} present</b> · <b class="no">${r.totals.absent} absent</b> · ${r.totals.unrecorded} not yet · ${r.totals.registered} registered</div>
        </div>
        ${r.members.length ? `<div class="mon-mlist">${r.members.map((m) => `<div class="mon-m"><span class="mon-m__name">${esc(m.name)} <span class="small muted">${m.tier === 'solid' ? 'Closed cell' : 'Open cell'}</span></span>${tri('member', m.status, { labels: ['Present', 'Absent', 'Not yet'], person: m.id, group: r.group.id, title: `${m.name} — Lifegroup attendance` })}</div>`).join('')}</div>`
          : '<div class="small muted" style="padding:6px 0">No members assigned to this Lifegroup yet.</div>'}
      </div>` : '';
    return `<div class="cl ${open ? 'is-open' : ''}" data-leader="${r.id}">
      <div class="cl__sum" role="button" tabindex="0" aria-expanded="${open}" data-toggle="${r.id}"><span class="cl__name">${esc(r.name)}${r.in_leader_group ? '' : ' <span class="small muted">(not in your Lifegroup)</span>'}</span>${g && g.last4 ? '' : ''}</div>
      <div class="mon-rows">
        <div class="mon-row"><span class="mon-row__l">Network meeting</span>${r.in_leader_group ? tri('leader', r.attendance, { labels: ['Present', 'Absent', 'Not yet'], person: r.id, title: `${r.name} — network meeting attendance` }) : '<span class="small muted">—</span>'}</div>
        <div class="mon-row"><span class="mon-row__l">Conducted Lifegroup this week?</span>${r.group ? tri('report', rep.status === 'yes' ? 'present' : rep.status === 'no' ? 'absent' : null, { labels: ['Yes', 'No', 'Not yet'], group: r.group.id, title: `${r.name} — did they conduct Lifegroup?` }) : '<span class="small muted">No Lifegroup of their own yet</span>'}</div>
        ${r.group ? `<div class="mon-row mon-row--status"><span class="mon-row__l"></span><span>${repLine}</span></div>` : ''}
        ${members}
      </div>
      <div class="cl__detail" ${open ? '' : 'hidden'}>
        ${g ? `<div style="padding:6px 12px 0">
          <div class="small muted">${esc(g.name)} · ${g.total} member${g.total === 1 ? '' : 's'} · Closed cell ${g.solid} / ${g.target}${g.solid >= g.target ? ' (solid ✓)' : ''} · Open cell ${g.total - g.solid}</div>
          <div class="row row--between mt-1" style="gap:8px;align-items:center"><span class="small"><b>Their Lifegroup</b> · ${g.held_last_4}/4 held</span>${strip(g)}</div>
          <div class="small mt-1"><b>Recent reports</b></div>${recent(g)}
        </div>
        <div class="cells" style="margin-top:8px;border-top:1px solid var(--border)">${cell(g, 'new', g.other_members)}${cell(g, 'solid', g.solid_members)}</div>`
        : '<div class="small muted" style="padding:8px 12px 10px">No Lifegroup of their own yet.</div>'}
      </div>
    </div>`;
  };
  const leaders = mon ? mon.leaders.filter((l) => !leaderFilter || String(l.id) === String(leaderFilter)) : [];
  const list = monErr ? `<div class="alert alert--error" style="margin:12px 16px">${esc(monErr)}</div>`
    : !mon ? '<div class="loading" style="padding:20px 16px">Loading this week…</div>'
    : leaders.length ? leaders.map(item).join('') : '<p class="small muted" style="padding:0 16px 14px">No cell leaders yet.</p>';
  return `${toolbar}${summary}
    <section class="card reg-card ${monBusy ? 'is-busy' : ''}" style="padding:0;overflow:hidden" aria-busy="${monBusy}">
      <div class="row row--between" style="padding:14px 16px 4px"><b>My cell leaders</b><span class="small muted">${d.members.length}${d.max_members ? ` / ${d.max_members}` : ''} · ${net.summary.met_this_week}/${net.summary.groups} met this week</span></div>
      <p class="small muted" style="padding:0 16px 10px;margin:0">Three separate records per leader: <b>Network meeting</b> (were they present?), <b>Conducted Lifegroup?</b> (their own report), and the <b>member attendance</b> of that session. One never fills in another. Open a name for their Open / Closed cell.</p>
      ${list}
    </section>`;
}

function render() {
  const g = d.group;
  const net = d.network;
  if (!view) view = net ? 'leaders' : 'report';
  title.textContent = g.name;
  lead.textContent = `Hi ${g.leader_name || 'Leader'}!${g.schedule_day ? ` Your Lifegroup: ${DAY[g.schedule_day]}${g.schedule_time ? ' ' + g.schedule_time : ''}.` : ''}`;
  document.getElementById('lgChurch').textContent = d.church_name || '';
  if (!draft.date) draft.date = d.today;
  // If a report already exists for the chosen date, pre-tick it (so re-opening edits instead of starting blank).
  const existing = d.recent.find((m) => m.meeting_date === draft.date);
  if (existing && !draft.touched) { draft.held = existing.held; draft.present = new Set(existing.present_ids); draft.devotion = new Set(existing.devotion_ids); }

  const solid = d.members.filter((m) => m.tier === 'solid'), others = d.members.filter((m) => m.tier !== 'solid');
  const chip = (m) => `<div class="chip ${draft.present.has(m.id) ? 'chip--on' : ''}" data-id="${m.id}">
      <button type="button" class="chip__main" data-present="${m.id}" aria-pressed="${draft.present.has(m.id)}"><span class="chip__check" aria-hidden="true"></span><span class="chip__name">${esc(m.name)}</span></button>
      <button type="button" class="chip__devo ${draft.devotion.has(m.id) ? 'chip__devo--on' : ''}" data-devo="${m.id}" aria-pressed="${draft.devotion.has(m.id)}" title="Had devotion this week">Devo</button>
    </div>`;

  if (!net && view !== 'report') view = 'report';
  const tabs = net ? `<div class="filter-tabs" style="margin:0 0 14px"><button type="button" class="${view === 'leaders' ? 'active' : ''}" data-view="leaders">My cell leaders <span class="count">${d.members.length}${d.max_members ? `/${d.max_members}` : ''}</span></button><button type="button" class="${view === 'report' ? 'active' : ''}" data-view="report">Weekly report</button></div>` : '';

  const reportView = `
    <form id="rep" class="card reg-card" novalidate>
      <fieldset class="reg-step">
        <legend class="reg-step-title"><span class="reg-step-no">1</span> When was your Lifegroup?</legend>
        <div id="repErr" class="alert alert--error" hidden role="alert"></div>
        <div class="field"><input class="input" id="mdate" type="date" max="${d.today}" value="${draft.date}" required aria-label="Date of the Lifegroup" />${existing ? `<span class="help">You already sent a report for this date — sending again updates it.</span>` : ''}</div>
        <div class="choice"><label class="choice__opt"><input type="radio" name="held" value="1" ${draft.held ? 'checked' : ''} /><span>We met</span></label><label class="choice__opt"><input type="radio" name="held" value="0" ${!draft.held ? 'checked' : ''} /><span>No Lifegroup</span></label></div>
        <div class="field mt-1" id="reasonWrap" ${draft.held ? 'hidden' : ''}><label for="reason">Why? <span class="req">*</span></label><input class="input" id="reason" maxlength="160" placeholder="e.g. exams week, I was sick, holiday" value="${esc(existing && !existing.held ? existing.no_meeting_reason || '' : '')}" /></div>
      </fieldset>
      <fieldset class="reg-step" id="heldWrap" ${draft.held ? '' : 'hidden'}>
        <legend class="reg-step-title"><span class="reg-step-no">2</span> Who was there? <span class="small muted" id="presentCount" style="font-weight:400"></span></legend>
        ${others.length ? `<div class="chip-group"><div class="chip-group__title">${TIER.new} <span class="muted">${others.length}</span></div><div class="chips">${others.map(chip).join('')}</div></div>` : ''}
        ${solid.length ? `<div class="chip-group"><div class="chip-group__title">${TIER.solid} <span class="muted">${solid.length}</span></div><div class="chips">${solid.map(chip).join('')}</div></div>` : ''}
        ${!d.members.length ? '<p class="small muted">No members yet — add your first members below.</p>' : ''}
        <div class="newbies mt-1">
          ${draft.newbies.map((n, i) => `<div class="chip chip--on chip--new"><span class="chip__main"><span class="chip__check"></span><span class="chip__name">${esc(n)}</span></span><button type="button" class="chip__devo" data-rm-new="${i}" aria-label="Remove">×</button></div>`).join('')}
          ${net && d.max_members && d.members.length + draft.newbies.length >= d.max_members
            ? `<span class="small muted">Full — max ${d.max_members} cell leaders.</span>`
            : `<button type="button" class="btn btn--sm btn--ghost" id="addNew">${net ? '+ New cell leader this week' : '+ New person this week'}</button>`}
        </div>
      </fieldset>
      <div class="reg-actions"><button class="btn btn--primary btn--lg" type="submit" id="repSave" style="width:100%">Send report</button></div>
    </form>

    <section class="card reg-card mt-2">
      ${net ? `<div class="row row--between"><b>My cell leaders</b><span class="small muted">${d.members.length} / ${d.max_members || 6} · max ${d.max_members || 6}</span></div>
      <div class="progress mt-1"><span style="width:${Math.min(100, Math.round((d.members.length / (d.max_members || 6)) * 100))}%"></span></div>`
      : `<div class="row row--between"><b>${d.is_solid ? 'Solid Lifegroup 🎉' : 'Progress to a solid Lifegroup'}</b><span class="small muted">${d.solid}/${d.target} closed cell</span></div>
      <div class="progress mt-1"><span style="width:${d.percent}%"></span></div>`}
      <div class="wk wk--md mt-2" aria-label="Last 8 weeks">${d.calendar.map((w) => { const m = w.meeting; return `<span class="wk__c ${!m ? 'wk__c--none' : m.held ? 'wk__c--held' : 'wk__c--skip'}" title="Week of ${weekLabel(w.week_start)}">${m && m.held ? m.present : m ? '×' : ''}</span>`; }).join('')}</div>
      <div class="small muted mt-1">Last 8 weeks · ${d.held_last_4}/4 held recently · streak ${d.streak}</div>
      ${net ? `<p class="small muted mt-2" style="margin-bottom:0"><a href="#" data-view="leaders">My cell leaders</a></p>` : `<details class="mt-2"><summary class="small"><b>Members</b></summary>
        <div class="chip-group__title mt-1">${TIER.new} <span class="muted">${others.length}</span></div>${memberRows(others, { tapTier: true, inactive: true })}
        <div class="chip-group__title mt-1">${TIER.solid} <span class="muted">${solid.length}</span></div>${memberRows(solid, { tapTier: true, inactive: true })}
        ${d.former && d.former.length ? `<div class="chip-group__title mt-1">Not active anymore <span class="muted">${d.former.length}</span></div><div class="mlist">${d.former.map((m) => `<div class="mlist__row"><div class="mlist__who"><b>${esc(m.name)}</b><div class="small muted">left ${fmtDate(m.left_at)}</div></div><button type="button" class="btn btn--sm btn--ghost" data-restore="${m.id}">Bring back</button></div>`).join('')}</div>` : ''}
      </details>`}
      ${d.recent.length ? `<details class="mt-1"><summary class="small"><b>Recent reports</b></summary><ul class="small" style="margin:6px 0 0;padding-left:18px;line-height:1.7">${d.recent.map((m) => `<li><b>${fmtDate(m.meeting_date)}</b> — ${m.held ? `${m.present_count} present` : `no Lifegroup (${esc(m.no_meeting_reason || '')})`}</li>`).join('')}</ul></details>` : ''}
    </section>`;

  body.innerHTML = tabs + (view === 'leaders' && net ? cellLeadersView() : reportView);
  body.querySelectorAll('[data-view]').forEach((b) => { b.onclick = (e) => { e.preventDefault(); view = b.dataset.view; render(); window.scrollTo(0, 0); }; });
  if (view !== 'report') { bindTier(); return; }

  const form = body.querySelector('#rep');
  const count = () => { const el = form.querySelector('#presentCount'); if (el) { const n = draft.present.size + draft.newbies.length; el.textContent = n ? `· ${n} present` : ''; } };
  count();
  form.querySelector('#mdate').addEventListener('change', (e) => { draft = { date: e.target.value, held: true, present: new Set(), devotion: new Set(), newbies: [], touched: false }; render(); });
  form.querySelectorAll('[name=held]').forEach((r) => r.addEventListener('change', () => { draft.held = form.querySelector('[name=held]:checked').value === '1'; draft.touched = true; form.querySelector('#reasonWrap').hidden = draft.held; form.querySelector('#heldWrap').hidden = !draft.held; }));
  form.querySelectorAll('[data-present]').forEach((b) => {
    b.onclick = () => { const id = Number(b.dataset.present); draft.touched = true; if (draft.present.has(id)) draft.present.delete(id); else draft.present.add(id); const c = b.closest('.chip'); c.classList.toggle('chip--on', draft.present.has(id)); b.setAttribute('aria-pressed', String(draft.present.has(id))); count(); };
  });
  form.querySelectorAll('[data-devo]').forEach((b) => {
    b.onclick = () => { const id = Number(b.dataset.devo); draft.touched = true; if (draft.devotion.has(id)) draft.devotion.delete(id); else draft.devotion.add(id); b.classList.toggle('chip__devo--on', draft.devotion.has(id)); b.setAttribute('aria-pressed', String(draft.devotion.has(id))); };
  });
  if (form.querySelector('#addNew')) form.querySelector('#addNew').onclick = () => {
    const name = window.prompt('Full name of the new person (e.g. Juan Dela Cruz):');
    const v = (name || '').trim().replace(/\s+/g, ' ');
    if (!v) return;
    if (v.length < 3) return toast('Please type the full name.', 'error');
    draft.newbies.push(v); draft.touched = true; render();
  };
  form.querySelectorAll('[data-rm-new]').forEach((b) => { b.onclick = () => { draft.newbies.splice(Number(b.dataset.rmNew), 1); render(); }; });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = form.querySelector('#repErr'); err.hidden = true;
    const held = form.querySelector('[name=held]:checked').value === '1';
    const payload = {
      meeting_date: form.querySelector('#mdate').value, held,
      no_meeting_reason: form.querySelector('#reason').value.trim() || null,
      present_ids: held ? [...draft.present] : [], devotion_ids: [...draft.devotion],
      new_members: held ? draft.newbies.map((full_name) => ({ full_name })) : [],
    };
    if (!payload.meeting_date) { err.textContent = 'Please choose the date.'; err.hidden = false; return; }
    if (!held && !payload.no_meeting_reason) { err.textContent = 'Please tell us why there was no Lifegroup.'; err.hidden = false; form.querySelector('#reason').focus(); return; }
    if (held && !payload.present_ids.length && !payload.new_members.length && !window.confirm('No one is tapped as present. Send anyway?')) return;
    const btn = form.querySelector('#repSave'); btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const r = await call('POST', `/api/public/lifegroup/${encodeURIComponent(token)}/report`, payload);
      toast(r.updated ? 'Report updated. Thank you!' : 'Report sent. Thank you!');
      draft = { date: null, held: true, present: new Set(), devotion: new Set(), newbies: [], touched: false };
      await load(); window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; btn.textContent = 'Send report'; if (ex.status === 404) setTimeout(load, 1500); }
  };
  bindTier();
}

function bindTier() {
  body.querySelectorAll('[data-toggle]').forEach((h) => {
    const go = () => { const id = h.dataset.toggle; const row = h.closest('.cl'); const open = !openLeaders.has(id); if (open) openLeaders.add(id); else openLeaders.delete(id); row.classList.toggle('is-open', open); row.querySelector('.cl__detail').hidden = !open; h.setAttribute('aria-expanded', String(open)); };
    h.onclick = go; h.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
  });
  body.querySelectorAll('[data-tri]').forEach((b) => {
    b.onclick = async (e) => {
      e.preventDefault(); e.stopPropagation();
      const grp = b.closest('.tri'); if (grp.classList.contains('is-busy')) return;
      const status = b.dataset.tri, kind = b.dataset.kind, date = mon ? mon.date : d.today;
      let reason;
      if (kind === 'report' && status === 'absent') { reason = window.prompt('Why was there no Lifegroup this week? (optional)', ''); if (reason === null) return; }
      grp.classList.add('is-busy'); grp.querySelectorAll('button').forEach((x) => { x.disabled = true; });
      const base = `/api/public/lifegroup/${encodeURIComponent(token)}`;
      try {
        let r;
        if (kind === 'leader') r = await call('POST', `${base}/attendance`, { person_id: Number(b.dataset.person), status, date });
        else if (kind === 'report') r = await call('POST', `${base}/groups/${b.dataset.group}/conducted`, { conducted: status === 'present' ? 'yes' : status === 'absent' ? 'no' : 'clear', date, reason: reason || undefined });
        else r = await call('POST', `${base}/groups/${b.dataset.group}/attendance`, { person_id: Number(b.dataset.person), status, date });
        if (r.monitor) mon = r.monitor;
        if (kind === 'leader') { if (r.this_week) d.this_week = r.this_week; if (r.recent) d.recent = r.recent; toast(status === 'present' ? 'Marked present.' : status === 'absent' ? 'Marked absent.' : 'Cleared — not yet recorded.', status === 'absent' ? 'info' : 'success'); }
        else if (kind === 'report') toast(r.conducted === 'yes' ? 'Saved: conducted Lifegroup. You can now record the members.' : r.conducted === 'no' ? 'Saved: no Lifegroup this week.' : 'Report cleared — not yet reported.', r.conducted ? 'success' : 'info');
        else toast(r.status === 'present' ? 'Member marked present.' : r.status === 'absent' ? 'Member marked absent.' : 'Cleared — not yet recorded.', r.status === 'absent' ? 'info' : 'success');
        render();
      } catch (ex) { toast(ex.message, 'error'); grp.classList.remove('is-busy'); grp.querySelectorAll('button').forEach((x) => { x.disabled = false; }); if (ex.status === 404) setTimeout(load, 1500); }
    };
  });
  const dateEl = body.querySelector('#monDate');
  if (dateEl) dateEl.onchange = () => { if (dateEl.value) loadMonitor(dateEl.value); };
  const prev = body.querySelector('#monPrev'); if (prev) prev.onclick = () => loadMonitor(addDaysISO(mon ? mon.date : d.today, -7));
  const next = body.querySelector('#monNext'); if (next) next.onclick = () => loadMonitor(addDaysISO(mon ? mon.date : d.today, 7));
  const flt = body.querySelector('#monFilter'); if (flt) flt.onchange = () => { leaderFilter = flt.value; render(); };
  body.querySelectorAll('[data-tier]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      const gid = b.dataset.group;
      try {
        if (gid) { const r = await call('PUT', `/api/public/lifegroup/${encodeURIComponent(token)}/groups/${gid}/members/${b.dataset.tier}/tier`, { tier: b.dataset.to }); d.network = r.network; }
        else await call('PUT', `/api/public/lifegroup/${encodeURIComponent(token)}/members/${b.dataset.tier}/tier`, { tier: b.dataset.to });
        toast(b.dataset.to === 'solid' ? 'Moved to the closed cell.' : 'Moved to the open cell.');
        if (gid) render(); else await load();
      } catch (ex) { toast(ex.message, 'error'); b.disabled = false; }
    };
  });
  body.querySelectorAll('[data-inactive]').forEach((b) => {
    b.onclick = async () => {
      const m = d.members.find((x) => x.id === Number(b.dataset.inactive));
      if (!window.confirm(`${m ? m.name : 'This member'} is not active anymore? They will be removed from your Lifegroup (history is kept, you can bring them back).`)) return;
      b.disabled = true;
      try { await call('PUT', `/api/public/lifegroup/${encodeURIComponent(token)}/members/${b.dataset.inactive}/inactive`); toast('Marked as not active.', 'info'); await load(); }
      catch (ex) { toast(ex.message, 'error'); b.disabled = false; }
    };
  });
  body.querySelectorAll('[data-restore]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try { await call('PUT', `/api/public/lifegroup/${encodeURIComponent(token)}/members/${b.dataset.restore}/restore`); toast('Welcome back!'); await load(); }
      catch (ex) { toast(ex.message, 'error'); b.disabled = false; }
    };
  });
}

function renderError(e) {
  title.textContent = 'Lifegroup Report';
  lead.textContent = '';
  body.innerHTML = `<section class="card reg-card"><div class="reg-closed">
    <div class="empty__icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
    <h2>${e.status === 404 ? 'This link is not valid' : 'Could not load your Lifegroup'}</h2>
    <p>${esc(e.message)}</p>
    ${e.status === 404 ? '' : '<button class="btn btn--primary" id="retry">Try again</button>'}
  </div></section>`;
  body.querySelector('#retry')?.addEventListener('click', load);
}

async function load() {
  if (!token) { renderError({ status: 404, message: 'Open the link exactly as the Lifegen admin sent it (it ends with ?t=…).' }); return; }
  try { d = await call('GET', `/api/public/lifegroup/${encodeURIComponent(token)}`); render(); if (d.network && !mon && !monBusy) loadMonitor(mon ? mon.date : null); }
  catch (e) { renderError(e); }
}
load();
