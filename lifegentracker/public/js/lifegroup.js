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
const HINT = { solid: 'matagal na · committed · consistent', new: 'mga bago · hindi pa consistent' };

let d = null;
let view = null; // network leaders: 'leaders' | 'report'; regular leaders: always 'report' (one page)
let draft = { date: null, held: true, present: new Set(), devotion: new Set(), newbies: [] };

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
function cellLeadersView() {
  const net = d.network;
  const byLeader = new Map(net.groups.map((g) => [g.leader_person_id, g]));
  const rows = d.members.map((m) => ({ id: m.id, name: m.name, last4: m.last4, group: byLeader.get(m.id) || null }));
  for (const g of net.groups) if (!rows.some((r) => r.id === g.leader_person_id)) rows.push({ id: g.leader_person_id || `g${g.id}`, name: g.leader_name || g.name, last4: null, group: g });
  const cell = (g, tier, list) => `<section class="cell cell--${tier === 'solid' ? 'closed' : 'open'}">
      <header class="cell__head"><b>${TIER[tier]}</b> <span class="muted">· ${list.length}</span></header>
      <div style="padding:2px 10px 6px">${memberRows(list, { tapTier: true, groupId: g.id })}</div>
    </section>`;
  const heldBadge = (g) => !g ? '' : g.this_week === 'held' ? '<span class="badge badge--present badge--nodot cl__held">Held LG</span>' : g.this_week === 'skip' ? '<span class="badge badge--absent badge--nodot cl__held">No LG</span>' : '<span class="badge badge--nodot cl__held">No report</span>';
  const strip = (g) => `<div class="wk wk--sm" aria-label="Their Lifegroup, last ${g.calendar.length} weeks">${g.calendar.map((w) => { const m = w.meeting; return `<span class="wk__c ${!m ? 'wk__c--none' : m.held ? 'wk__c--held' : 'wk__c--skip'}" title="Week of ${weekLabel(w.week_start)}: ${!m ? 'no report' : m.held ? m.present + ' present' : 'no Lifegroup'}">${m && m.held ? m.present : m ? '×' : ''}</span>`; }).join('')}</div>`;
  const recent = (g) => g.recent && g.recent.length ? `<ul class="cl__recent">${g.recent.map((m) => `<li><b>${fmtDate(m.meeting_date)}</b> — ${m.held ? `${m.present_count} present${m.present.length ? `: ${esc(m.present.join(', '))}` : ''}` : `no Lifegroup${m.no_meeting_reason ? ` (${esc(m.no_meeting_reason)})` : ''}`}</li>`).join('')}</ul>` : '<div class="small muted">No report yet from this leader.</div>';
  const item = (r) => `<details class="cl">
      <summary class="cl__sum"><span class="cl__name">${esc(r.name)}</span>${heldBadge(r.group)}${r.last4 ? dots(r.last4) : '<span class="small muted">—</span>'}</summary>
      ${r.group ? `<div style="padding:6px 12px 0">
          <div class="small muted">${esc(r.group.name)} · ${r.group.total} member${r.group.total === 1 ? '' : 's'} · ${r.group.solid}/${r.group.target} closed cell</div>
          <div class="row row--between mt-1" style="gap:8px;align-items:center"><span class="small"><b>Their Lifegroup</b> · ${r.group.held_last_4}/4 held</span>${strip(r.group)}</div>
          <div class="small mt-1"><b>Who was present</b></div>${recent(r.group)}
        </div>
        <div class="cells" style="margin-top:8px;border-top:1px solid var(--border)">${cell(r.group, 'new', r.group.other_members)}${cell(r.group, 'solid', r.group.solid_members)}</div>`
      : '<div class="small muted" style="padding:8px 12px 10px">No Lifegroup of their own yet.</div>'}
    </details>`;
  return `
    <section class="card reg-card" style="padding:0;overflow:hidden">
      <div class="row row--between" style="padding:14px 16px 10px"><b>My cell leaders</b><span class="small muted">${rows.length}${d.max_members ? ` / ${d.max_members}` : ''} · ${net.summary.met_this_week}/${net.summary.groups} met this week</span></div>
      <p class="small muted" style="margin:0 16px 10px">Dots = present in <b>your</b> Lifegroup, last 4 weeks. Badge = did they hold <b>their</b> Lifegroup this week. Tap a name for who was present and their Open / Closed cell.</p>
      ${rows.length ? rows.map(item).join('') : '<p class="small muted" style="padding:0 16px 14px">No cell leaders yet — add them with “New person this week” in your Weekly report.</p>'}
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
        <p class="small muted" style="margin:-6px 0 8px">Tap a name = present. Tap <b>Devo</b> if they had their devotion this week.</p>
        ${others.length ? `<div class="chip-group"><div class="chip-group__title">${TIER.new} <span class="muted">${others.length}</span></div><div class="chips">${others.map(chip).join('')}</div></div>` : ''}
        ${solid.length ? `<div class="chip-group"><div class="chip-group__title">${TIER.solid} <span class="muted">${solid.length}</span></div><div class="chips">${solid.map(chip).join('')}</div></div>` : ''}
        ${!d.members.length ? '<p class="small muted">No members yet — add your first members below.</p>' : ''}
        <div class="newbies mt-1">
          ${draft.newbies.map((n, i) => `<div class="chip chip--on chip--new"><span class="chip__main"><span class="chip__check"></span><span class="chip__name">${esc(n)}</span></span><button type="button" class="chip__devo" data-rm-new="${i}" aria-label="Remove">×</button></div>`).join('')}
          <button type="button" class="btn btn--sm btn--ghost" id="addNew">+ New person this week</button>
        </div>
      </fieldset>
      <div class="reg-actions"><button class="btn btn--primary btn--lg" type="submit" id="repSave" style="width:100%">Send report</button></div>
    </form>

    <section class="card reg-card mt-2">
      <div class="row row--between"><b>${d.is_solid ? 'Solid Lifegroup 🎉' : 'Progress to a solid Lifegroup'}</b><span class="small muted">${d.solid}/${d.target} closed cell</span></div>
      <div class="progress mt-1"><span style="width:${d.percent}%"></span></div>
      <div class="wk wk--md mt-2" aria-label="Last 8 weeks">${d.calendar.map((w) => { const m = w.meeting; return `<span class="wk__c ${!m ? 'wk__c--none' : m.held ? 'wk__c--held' : 'wk__c--skip'}" title="Week of ${weekLabel(w.week_start)}">${m && m.held ? m.present : m ? '×' : ''}</span>`; }).join('')}</div>
      <div class="small muted mt-1">Last 8 weeks · ${d.held_last_4}/4 held recently · streak ${d.streak}</div>
      ${net ? `<p class="small muted mt-2" style="margin-bottom:0">Your members are cell leaders — open their own members in <a href="#" data-view="leaders">My cell leaders</a>.</p>` : `<details class="mt-2"><summary class="small"><b>Members</b> · move between Open cell and Closed cell</summary>
        <p class="small muted" style="margin:8px 0 4px">${TIER.new} = ${HINT.new}. ${TIER.solid} = ${HINT.solid} (max ${d.target} — ${d.target} = solid Lifegroup).</p>
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
  form.querySelector('#addNew').onclick = () => {
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
  try { d = await call('GET', `/api/public/lifegroup/${encodeURIComponent(token)}`); render(); }
  catch (e) { renderError(e); }
}
load();
