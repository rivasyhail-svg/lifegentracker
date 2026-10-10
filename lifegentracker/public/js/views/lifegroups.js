import { api } from '../api.js';
import { renderProgressCard, renderNetworkCalendar, drawProgressTab, solidBadge, weekStrip, memberSections, memberDots, dotsKey, TIER_LABEL, linkDialog, meetingForm } from './progress.js';
import { can } from '../app.js';
import {
  html, raw, icon, avatar, fullName, statusBadge, fmtDate, emptyState, debounce, toast, confirmDialog,
  openModal, closeModal, withLoading, formData, DAY_LABELS, DAY_SHORT, TIME_LABELS, fmtClock, fmtSchedule, toISODate,
} from '../ui.js';

/**
 * Lifegroups: the connection tool after attendance.
 *   #/lifegroups        list of groups (+ "Needs Lifegroup" follow-up list)
 *   #/lifegroups/:id    one group: leader, schedule, members, former members
 * Person ↔ group is a real relationship with history (see findLifegroup()).
 */

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const slotsText = (g) => (g.max_members == null ? 'Open' : g.slots > 0 ? `${g.slots} slot${g.slots === 1 ? '' : 's'}` : 'Full');
const closedCount = (g) => g.members.filter((m) => m.tier === 'solid').length;
/** Boys / girls ratio bar — exported so Reports can reuse it. */
export function ratioBar(boys, girls, total, { compact = false } = {}) {
  total = total ?? boys + girls;
  const unknown = Math.max(total - boys - girls, 0);
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  if (!total) return html`<div class="ratio ${compact ? 'ratio--compact' : ''}"><div class="ratio__bar"><span class="ratio__none"></span></div>${compact ? '' : raw('<div class="ratio__legend muted">No members yet</div>')}</div>`;
  return html`<div class="ratio ${compact ? 'ratio--compact' : ''}" title="${boys} boys · ${girls} girls${unknown ? ' · ' + unknown + ' not set' : ''}">
    <div class="ratio__bar"><span class="ratio__boys" style="width:${pct(boys)}%"></span><span class="ratio__girls" style="width:${pct(girls)}%"></span>${unknown ? html`<span class="ratio__unknown" style="width:${pct(unknown)}%"></span>` : ''}</div>
    <div class="ratio__legend"><span><i class="dot dot--boys"></i>${boys} boys <span class="muted">${pct(boys)}%</span></span><span><i class="dot dot--girls"></i>${girls} girls <span class="muted">${pct(girls)}%</span></span>${unknown ? html`<span class="muted">${unknown} not set</span>` : ''}</div>
  </div>`;
}
export const genderBadge = (g, { long = false, noun = 'group' } = {}) => (g === 'boys' ? raw(`<span class="gbadge gbadge--boys">${long ? 'Boys ' + noun : 'Boys'}</span>`) : g === 'girls' ? raw(`<span class="gbadge gbadge--girls">${long ? 'Girls ' + noun : 'Girls'}</span>`) : raw('<span class="gbadge gbadge--na" title="Boys or girls not set yet">Not set</span>'));
const sexBadge = (sex) => (sex === 'male' ? raw('<span class="sex sex--boy">Boy</span>') : sex === 'female' ? raw('<span class="sex sex--girl">Girl</span>') : raw('<span class="sex sex--na">—</span>'));

// ---------------------------------------------------------------------------
// Person picker (search registered people) — used for leader + add member
// ---------------------------------------------------------------------------
// `sex` may be 'male' | 'female' | null or a function returning one — when set, only boys (or only girls)
// are ever listed, so a girl can't even be picked for a boys group (and vice versa).
const SEX_WORD = { male: 'boys', female: 'girls' };
const SEX_OF = { boys: 'male', girls: 'female' };
function personPicker(root, { inputId, hiddenId, labelId, initial, sex = null }) {
  const input = root.querySelector('#' + inputId);
  const hidden = root.querySelector('#' + hiddenId);
  const results = root.querySelector('#' + inputId + 'Results');
  const sexNow = () => (typeof sex === 'function' ? sex() : sex);
  if (initial) { input.value = initial.name; hidden.value = initial.id; }
  const hide = () => { results.hidden = true; results.innerHTML = ''; };
  input.addEventListener('input', debounce(async () => {
    const q = input.value.trim();
    hidden.value = '';
    if (q.length < 2) return hide();
    try {
      const sx = sexNow();
      if (sex && !sx) { results.innerHTML = '<div class="gsearch__empty">Choose Boys group or Girls group first.</div>'; results.hidden = false; return; }
      const { people } = await api.search(q, sx ? { sex: sx } : {});
      if (!people.length) { results.innerHTML = `<div class="gsearch__empty">${sx ? `No ${SEX_WORD[sx]} found — only ${SEX_WORD[sx]} can be in this group.` : 'No one found'}</div>`; results.hidden = false; return; }
      results.innerHTML = people.map((p) => `<button type="button" class="gsearch__item" data-id="${p.id}" data-name="${esc(fullName(p))}">${avatar(p, 'sm')}<span><b>${esc(fullName(p))}</b><small>${esc(p.person_code)}</small></span></button>`).join('');
      results.hidden = false;
      results.querySelectorAll('[data-id]').forEach((b) => { b.onclick = () => { hidden.value = b.dataset.id; input.value = b.dataset.name; hide(); }; });
    } catch (e) { hide(); }
  }, 200));
  input.addEventListener('blur', () => setTimeout(hide, 150));
}

// ---------------------------------------------------------------------------
// Group form (create / edit)
// ---------------------------------------------------------------------------
async function groupForm(g, onSaved) {
  let opts = { areas: [], categories: [], networks: [] };
  try { opts = await api.lifegroupOptions(); } catch (e) { /* optional */ }
  const dl = (id, items) => `<datalist id="${id}">${items.map((v) => `<option value="${esc(v)}">`).join('')}</datalist>`;
  const v = (k) => esc(g?.[k] ?? '');
  const modal = openModal({
    title: g ? `Edit ${g.name}` : 'New Lifegroup',
    subtitle: g ? '' : 'A cell group people can be connected to after Sunday.',
    wide: true,
    body: `<form id="groupForm" class="form-grid" novalidate>
      <div id="groupErr" class="alert alert--error span-2" hidden></div>
      <div class="field"><label>Group name <span class="req">*</span></label><input name="name" value="${v('name')}" required autocomplete="off" placeholder="e.g. Joshua Group" /></div>
      <div class="field"><label>Boys or girls <span class="req">*</span></label>
        <div class="choice">
          <label class="choice__opt"><input type="radio" name="gender" value="boys" ${g?.gender === 'boys' ? 'checked' : ''} /><span>Boys group</span></label>
          <label class="choice__opt"><input type="radio" name="gender" value="girls" ${g?.gender === 'girls' ? 'checked' : ''} /><span>Girls group</span></label>
        </div></div>
      <div class="field"><label>Network</label><select name="network_id"><option value="" ${!g || !g.network_manual ? 'selected' : ''}>Auto — from the leader's own Lifegroup${g && !g.network_manual && g.network ? ' (now: ' + esc(g.network) + ')' : ''}</option>${(opts.networks || []).map((n) => `<option value="${n.id}" data-gender="${n.gender || ''}" ${g?.network_manual && Number(g?.network_id) === n.id ? 'selected' : ''}>${esc(n.name)}${n.gender ? ' (' + n.gender + ')' : ''}${n.leader_name ? ' · ' + esc(n.leader_name) : ''}</option>`).join('')}</select></div>
      <div class="field span-2 gsearch-field"><label>Leader <span class="opt">registered person</span></label>
        <div class="gsearch" style="max-width:none">${icon('search', 16).value}<input id="leaderPick" aria-label="Search a registered person to be leader" placeholder="Search a registered person…" autocomplete="off" /><div class="gsearch__results" id="leaderPickResults" hidden></div></div>
        <input type="hidden" id="leaderId" name="leader_person_id" />
        <span class="help" id="leaderHint"></span>
        <input name="leader_name" value="${v('leader_name')}" placeholder="Leader name (if not registered)" autocomplete="off" style="margin-top:6px" /></div>
      <div class="field"><label>Category <span class="opt">optional</span></label><input name="category" value="${v('category')}" list="dlCat" autocomplete="off" placeholder="e.g. Students, Young Pro, Mixed" />${dl('dlCat', opts.categories)}</div>
      <div class="field"><label>Day <span class="opt">optional</span></label><select name="schedule_day"><option value="">—</option>${Object.entries(DAY_LABELS).map(([k, l]) => `<option value="${k}" ${g?.schedule_day === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label>Time <span class="opt">optional</span></label><input name="schedule_time" type="time" value="${v('schedule_time')}" /></div>
      <div class="field"><label>Venue <span class="opt">optional</span></label><input name="venue" value="${v('venue')}" autocomplete="off" /></div>
      <div class="field span-2"><label>Notes <span class="opt">optional</span></label><textarea name="notes">${v('notes')}</textarea></div>
      ${g ? `<div class="field span-2"><label class="toggle"><input type="checkbox" name="is_active" ${g.is_active ? 'checked' : ''}/> Group is active</label></div>` : ''}
    </form>`,
    footer: `<button class="btn" data-close>Cancel</button><button class="btn btn--primary" id="saveGroup">${g ? 'Save' : 'Create Lifegroup'}</button>`,
  });
  modal.querySelector('[data-close]').onclick = closeModal;
  const genderNow = () => modal.querySelector('[name=gender]:checked')?.value || null;
  const leaderHint = modal.querySelector('#leaderHint');
  const netSel = modal.querySelector('[name=network_id]');
  const refreshLeaderHint = () => {
    const gg = genderNow(); leaderHint.textContent = gg ? '' : 'Choose Boys group or Girls group first.';
    // only networks of the same type can hold this group
    netSel.querySelectorAll('option[data-gender]').forEach((o) => { const mismatch = gg && o.dataset.gender && o.dataset.gender !== gg; o.hidden = mismatch; o.disabled = mismatch; if (mismatch && o.selected) netSel.value = ''; });
  };
  // picking a network first sets the group type to match it
  netSel.addEventListener('change', () => { const og = netSel.selectedOptions[0]?.dataset.gender; if (og && genderNow() !== og) { modal.querySelector(`[name=gender][value=${og}]`).checked = true; modal.querySelector(`[name=gender][value=${og}]`).dispatchEvent(new Event('change')); } });
  refreshLeaderHint();
  personPicker(modal, { inputId: 'leaderPick', hiddenId: 'leaderId', sex: () => SEX_OF[genderNow()] || null, initial: g?.leader_person_id ? { id: g.leader_person_id, name: g.leader_name } : null });
  modal.querySelectorAll('[name=gender]').forEach((r) => r.addEventListener('change', () => {
    refreshLeaderHint();
    // the picked leader may be the wrong sex for the new choice — clear and let the user pick again
    if (modal.querySelector('#leaderId').value) { modal.querySelector('#leaderId').value = ''; modal.querySelector('#leaderPick').value = ''; }
  }));
  const save = (e) => withLoading(modal.querySelector('#saveGroup'), async () => {
    e.preventDefault();
    const form = modal.querySelector('#groupForm');
    const d = formData(form);
    d.gender = form.querySelector('[name=gender]:checked')?.value || null;
    d.leader_person_id = form.querySelector('#leaderId').value || null;
    d.network_manual = Boolean(d.network_id);
    if (g) d.is_active = form.querySelector('[name=is_active]').checked;
    for (const k of Object.keys(d)) if (d[k] === '') d[k] = null;
    const err = modal.querySelector('#groupErr');
    try {
      const saved = g ? await api.updateLifegroup(g.id, d) : await api.createLifegroup(d);
      closeModal(); toast(g ? 'Lifegroup updated.' : `${saved.name} created.`); onSaved(saved);
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
  modal.querySelector('#saveGroup').onclick = save;
  modal.querySelector('#groupForm').onsubmit = save;
}

// ---------------------------------------------------------------------------
// "Find a Lifegroup" — preferences → recommended groups → Assign
// Exported so the person profile and the Needs list can share it.
// ---------------------------------------------------------------------------
export async function findLifegroup(person, onAssigned) {
  let sex = person.sex || '';
  const modal = openModal({
    title: 'Find a Lifegroup',
    subtitle: `${fullName(person)} · ${person.person_code}${person.lifegroup ? ' · currently in ' + person.lifegroup.name : ' · no Lifegroup yet'}`,
    wide: true,
    body: `
      <div class="row mb-2" style="gap:10px;flex-wrap:wrap;align-items:center">
        <span class="small muted">Boy or girl</span>
        <div class="choice choice--sm" id="sexChoice">
          <label class="choice__opt"><input type="radio" name="sex" value="male" ${sex === 'male' ? 'checked' : ''} ${person.sex ? 'disabled' : ''} /><span>Boy</span></label>
          <label class="choice__opt"><input type="radio" name="sex" value="female" ${sex === 'female' ? 'checked' : ''} ${person.sex ? 'disabled' : ''} /><span>Girl</span></label>
        </div>
        ${person.sex ? '' : '<span class="small muted">Not set yet — choose one to see matching groups.</span>'}
      </div>
      <div class="gsearch mb-2" style="max-width:none">${icon('search', 16).value}<input id="findQ" placeholder="Filter by group, leader or network…" autocomplete="off" aria-label="Filter Lifegroups" /></div>
      <div id="recList"><div class="loading">Loading…</div></div>`,
    footer: `<button class="btn" data-close>Close</button>`,
  });
  modal.querySelector('[data-close]').onclick = closeModal;
  const list = modal.querySelector('#recList');
  const q = modal.querySelector('#findQ');
  let all = null;

  async function load() {
    all = null;
    if (!sex) { list.innerHTML = emptyState({ icon: 'group', title: 'Choose Boy or Girl first', text: 'Lifegroups are either boys groups or girls groups, so we need this to recommend one.' }).value; return; }
    list.innerHTML = '<div class="loading">Loading…</div>';
    try { all = (await api.lifegroupRecommend({ sex })).groups.filter((g) => !person.lifegroup || g.id !== person.lifegroup.lifegroup_id); } catch (e) { list.innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; return; }
    draw();
  }
  function draw() {
    if (!all) return;
    const needle = q.value.trim().toLowerCase();
    const groups = needle ? all.filter((g) => [g.name, g.leader_name, g.network, g.network_name].some((v) => v && String(v).toLowerCase().includes(needle))) : all;
    if (!groups.length) { list.innerHTML = emptyState({ icon: 'group', title: needle ? 'No match' : `No ${sex === 'male' ? 'boys' : 'girls'} Lifegroup available`, text: needle ? 'Try another group or leader name.' : `No active ${sex === 'male' ? 'boys' : 'girls'} group with open slots. Create one under Lifegroups.` }).value; return; }
    list.innerHTML = `<div class="table-wrap"><table class="table table--stack">
      <thead><tr><th>Group</th><th>Leader</th><th>Network</th><th>Schedule</th><th>Slots</th><th></th></tr></thead>
      <tbody>${groups.map((g) => `<tr>
        <td data-label=""><b>${esc(g.name)}</b> ${genderBadge(g.gender).value}</td>
        <td data-label="Leader">${esc(g.leader_name || '—')}</td>
        <td data-label="Network">${esc(g.network || g.network_name || '—')}</td>
        <td data-label="Schedule">${esc(fmtSchedule(g) || '—')}</td>
        <td data-label="Slots">${slotsText(g)}</td>
        <td data-label="" class="actions">${can('lifegroups:manage') ? `<button class="btn btn--sm btn--primary" data-assign="${g.id}" data-name="${esc(g.name)}">Assign</button>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>`;
    list.querySelectorAll('[data-assign]').forEach((b) => {
      b.onclick = () => withLoading(b, async () => {
        const gid = Number(b.dataset.assign);
        if (person.lifegroup) {
          const ok = await confirmDialog({ title: `Move ${person.first_name} to ${b.dataset.name}?`, message: `They will leave <b>${esc(person.lifegroup.name)}</b> today. The previous membership stays in their history.`, confirmText: 'Move' });
          if (!ok) return;
        }
        try {
          if (!person.sex && sex) await api.updatePreferences(person.id, { sex });
          const r = await api.assignLifegroup(gid, person.id, { joined_at: toISODate(new Date()) });
          closeModal();
          toast(`${fullName(person)} assigned to ${b.dataset.name}. Leader and network are saved automatically.`);
          onAssigned?.(r);
        } catch (e) { toast(e.message, 'error'); }
      });
    });
  }
  q.addEventListener('input', debounce(draw, 150));
  modal.querySelector('#sexChoice').addEventListener('change', (e) => { sex = e.target.value; load(); });
  load();
}

// ---------------------------------------------------------------------------
// List page
// ---------------------------------------------------------------------------
export async function renderLifegroups({ main, query }) {
  const tab = ['needs', 'progress'].includes(query.tab) ? query.tab : 'groups'; // 'groups' = the Network tab (old ?tab=networks lands here too)
  const filters = { q: query.q || '', status: query.status || 'active', gender: query.gender || '' };
  let overview = null;
  try { overview = await api.get('/api/lifegroups/overview'); } catch (e) { /* non-fatal */ }

  main.innerHTML = html`
    <div class="page-header">
      <div><h1>Lifegroups</h1></div>
      <div class="page-actions">${can('lifegroups:manage') ? html`<button class="btn btn--primary" id="newGroup">${icon('plus')} New Lifegroup</button>` : ''}</div>
    </div>
    ${overview ? (() => { const st = overview.structure || { networks: overview.networks, cell_leaders: 0, lifegroups: overview.active_groups, closed_cell: overview.closed_cell, open_cell: overview.open_cell, boys: {}, girls: {} }; const sub = (k) => html`<div class="small muted" style="text-transform:none;letter-spacing:0;font-weight:500">${st.boys[k] || 0} boys · ${st.girls[k] || 0} girls</div>`; return html`<div class="kpi-row mb-2" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">
      <a class="kpi kpi--link" href="#/lifegroups"><b>${st.networks}</b><span>Networks</span>${sub('networks')}</a>
      <a class="kpi kpi--link" href="#/lifegroups"><b>${st.cell_leaders}</b><span>Cell leaders</span>${sub('cell_leaders')}</a>
      <a class="kpi kpi--link" href="#/lifegroups"><b>${st.lifegroups}</b><span>Lifegroups</span>${sub('lifegroups')}</a>
      <a class="kpi kpi--link kpi--teal" href="#/reports?view=lifegroups"><b>${st.closed_cell}</b><span>Closed cell</span>${sub('closed_cell')}</a>
      <a class="kpi kpi--link" href="#/lifegroups?tab=progress"><b>${st.open_cell}</b><span>Open cell</span>${sub('open_cell')}</a>
      <a class="kpi kpi--link ${overview.without_group ? 'kpi--amber' : ''}" href="#/lifegroups?tab=needs"><b>${overview.without_group}</b><span>Without Lifegroup</span><div class="small muted" style="text-transform:none;letter-spacing:0;font-weight:500">${overview.with_group} with Lifegroup</div></a>
    </div>`; })() : ''}
    <div class="filter-tabs mb-2" id="tabs">
      <button data-t="groups" class="${tab === 'groups' ? 'active' : ''}">Network</button>
      <button data-t="needs" class="${tab === 'needs' ? 'active' : ''}">Needs Lifegroup ${overview ? html`<span class="count">${overview.without_group}</span>` : ''}</button>
      <button data-t="progress" class="${tab === 'progress' ? 'active' : ''}">Progress</button>
    </div>
    <div id="tabBody"></div>`;

  main.querySelector('#newGroup')?.addEventListener('click', () => groupForm(null, (g) => { location.hash = `#/lifegroups/${g.id}`; }));
  main.querySelector('#tabs').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    location.hash = '#/lifegroups' + api.qs({ tab: b.dataset.t === 'groups' ? '' : b.dataset.t });
  };
  const body = main.querySelector('#tabBody');
  if (tab === 'needs') return drawNeeds(body);
  if (tab === 'progress') return drawProgressTab(body);
  return drawGroups(body, filters);
}

async function drawGroups(body, filters) {
  body.innerHTML = html`
    <div class="toolbar">
      <div class="gsearch grow" style="max-width:none">${icon('search', 17)}<input type="search" id="gq" placeholder="Search network, group or leader" value="${filters.q}" autocomplete="off" /></div>
      <div class="filter-tabs" id="ggender" style="margin:0"><button data-g="" class="${!filters.gender ? 'active' : ''}">Boys &amp; girls</button><button data-g="boys" class="${filters.gender === 'boys' ? 'active' : ''}">Boys</button><button data-g="girls" class="${filters.gender === 'girls' ? 'active' : ''}">Girls</button></div>
      <select id="gstatus" style="width:auto;min-width:120px" aria-label="Status"><option value="active">Active</option><option value="inactive" ${filters.status === 'inactive' ? 'selected' : ''}>Inactive</option><option value="all" ${filters.status === 'all' ? 'selected' : ''}>All</option></select>
    </div>
    <div id="glist"><div class="card"><div class="loading">Loading…</div></div></div>`;
  const list = body.querySelector('#glist');
  let reqId = 0;
  async function load() {
    const id = ++reqId;
    history.replaceState(null, '', '#/lifegroups' + api.qs({ q: filters.q, gender: filters.gender, status: filters.status === 'active' ? '' : filters.status }));
    let groups, nets;
    try { [groups, nets] = await Promise.all([api.lifegroups(filters), api.networks({ status: filters.status === 'active' ? 'active' : 'all' })]); }
    catch (e) { list.innerHTML = html`<div class="alert alert--error" style="margin:16px">${e.message}</div>`; return; }
    if (id !== reqId) return;
    const q = filters.q.toLowerCase();
    if (filters.gender) nets = nets.filter((n) => n.gender === filters.gender);
    if (!groups.length && !nets.length) {
      list.innerHTML = html`<div class="card">${emptyState({ icon: 'group', title: filters.q ? 'No network or group matches' : 'No Lifegroups yet', text: filters.q ? 'Try a different search.' : 'Create the first Lifegroup so people can be connected after Sunday.', action: can('lifegroups:manage') && !filters.q ? '<button class="btn btn--primary" id="newGroup2">New Lifegroup</button>' : '' })}</div>`;
      list.querySelector('#newGroup2')?.addEventListener('click', () => groupForm(null, (g) => { location.hash = `#/lifegroups/${g.id}`; }));
      return;
    }
    const row = (g, isLeaderGroup) => { const closed = g.solid_count || 0, open = g.member_count - closed, t = g.solid_target || 6; return html`<tr class="clickable ${isLeaderGroup ? 'row--lead' : ''}" data-id="${g.id}">
        <td data-label="" class="nowrap"><b>${g.name}</b>${isLeaderGroup ? raw(' <span class="badge badge--leader badge--nodot">Network leader’s Lifegroup</span>') : ''}${g.is_active ? '' : raw(' <span class="badge badge--nodot">Inactive</span>')}${g.is_demo ? raw(' <span class="badge badge--demo badge--nodot">Demo</span>') : ''}</td>
        <td data-label="${isLeaderGroup ? 'Network leader' : 'Cell leader'}" class="nowrap">${g.leader_name || raw('<span class="muted">—</span>')}</td>
        <td data-label="Schedule" class="nowrap">${fmtSchedule(g) || raw('<span class="muted">—</span>')}</td>
        <td data-label="${isLeaderGroup ? 'Cell leaders' : 'Members'}" class="num nowrap">${g.member_count}${g.max_members != null ? html`<span class="muted small"> / ${g.max_members}</span>` : ''}</td>
        <td data-label="Closed cell" class="num nowrap">${isLeaderGroup ? raw('<span class="muted">—</span>') : closed >= t ? raw(`<span class="badge badge--present badge--nodot" title="Solid Lifegroup">${closed}</span>`) : html`<span class="nowrap">${closed}<span class="muted small">/${t}</span></span>`}</td>
        <td data-label="Open cell" class="num">${isLeaderGroup ? raw('<span class="muted">—</span>') : open}</td>
        <td data-label="Last held" class="nowrap small">${g.last_held ? fmtDate(g.last_held, { short: true }) : raw('<span class="muted">—</span>')}</td>
      </tr>`; };
    const table = (rows, leaderGroup) => html`<div class="table-wrap"><table class="table table--stack">
      <thead><tr><th>Lifegroup</th><th>Leader</th><th>Schedule</th><th class="num">Members</th><th class="num">Closed cell</th><th class="num">Open cell</th><th>Last held</th></tr></thead>
      <tbody>${leaderGroup ? row(leaderGroup, true) : ''}${rows.map((g) => row(g, false))}</tbody></table></div>`;
    const used = new Set();
    const netBlock = (n) => {
      // each Network is an independent root: the network leader's own Lifegroup first, then the cell leaders' Lifegroups
      const leaderGroup = n.leader_person_id ? groups.find((g) => g.leader_person_id === n.leader_person_id) || null : null;
      const rows = groups.filter((g) => g.network_id === n.id && (!leaderGroup || g.id !== leaderGroup.id));
      if (leaderGroup) used.add(leaderGroup.id);
      rows.forEach((g) => used.add(g.id));
      const matches = !q || n.name.toLowerCase().includes(q) || (n.leader_name || '').toLowerCase().includes(q) || rows.length || leaderGroup;
      if (!matches) return '';
      return html`<div class="card mb-2 netblock netblock--${n.gender || 'na'}">
        <div class="card__header netblock__head">
          <div class="min-w-0">
            <h2><a href="#/networks/${n.id}">${n.name}</a>${n.is_demo ? raw(' <span class="badge badge--demo badge--nodot">Demo</span>') : ''}${n.is_active ? '' : raw(' <span class="badge badge--nodot">Inactive</span>')}</h2>
            <div class="small muted">Network leader: <b>${n.leader_name || 'not set'}</b> · Cell leaders <b>${n.cell_leaders || 0}</b> / 6 · ${rows.length} Lifegroup${rows.length === 1 ? '' : 's'} · ${n.people_count || 0} members · Closed cell ${n.closed_cell || 0} · Open cell ${n.open_cell || 0}</div>
          </div>
          <a class="btn btn--sm" href="#/networks/${n.id}">${icon('link', 14)} Network page &amp; QR</a>
        </div>
        <div class="card__body card__body--flush">${rows.length || leaderGroup ? table(rows, leaderGroup) : raw('<div class="small muted" style="padding:14px 16px">No Lifegroups under this Network yet.</div>')}</div>
      </div>`;
    };
    const section = (key, label) => {
      const ns = nets.filter((n) => (key === 'na' ? !n.gender : n.gender === key)).sort((a, b) => a.name.localeCompare(b.name));
      const blocks = ns.map(netBlock);
      const loose = groups.filter((g) => (key === 'na' ? !g.gender : g.gender === key) && !used.has(g.id));
      if (!blocks.some(Boolean) && !loose.length) return '';
      return html`<section class="net-section net-section--${key}">
        <div class="net-section__head"><h2>${label} ${genderBadge(key)} <span class="net-section__count">${ns.length}</span></h2><span class="small muted">${ns.length} network${ns.length === 1 ? '' : 's'}</span></div>
        ${blocks}
        ${loose.length ? html`<div class="card mb-2 netblock netblock--loose">
          <div class="card__header netblock__head"><div><h2>No Network yet</h2></div></div>
          <div class="card__body card__body--flush">${table(loose, null)}</div>
        </div>` : ''}
      </section>`;
    };
    list.innerHTML = html`${section('boys', 'Boys')}${section('girls', 'Girls')}${section('na', 'Boys or girls not set')}`;
    list.querySelectorAll('tr.clickable').forEach((tr) => { tr.onclick = (e) => { if (e.target.closest('a')) return; location.hash = `#/lifegroups/${tr.dataset.id}`; }; });
  }
  body.querySelector('#gq').addEventListener('input', debounce((e) => { filters.q = e.target.value.trim(); load(); }, 250));
  body.querySelector('#ggender').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; filters.gender = b.dataset.g; body.querySelectorAll('#ggender button').forEach((x) => x.classList.toggle('active', x === b)); load(); };
  body.querySelector('#gstatus').onchange = (e) => { filters.status = e.target.value; load(); };
  load();
}

async function drawNeeds(body) {
  body.innerHTML = html`
    <div class="toolbar"><div class="gsearch grow" style="max-width:none">${icon('search', 17)}<input type="search" id="nq" placeholder="Search name or Person ID" autocomplete="off" /></div></div>
    <div class="card"><div id="nlist" class="card__body--flush"><div class="loading">Loading…</div></div></div>`;
  const list = body.querySelector('#nlist');
  let q = '';
  async function load() {
    let rows;
    try { rows = await api.lifegroupNeeds({ q }); } catch (e) { list.innerHTML = html`<div class="alert alert--error" style="margin:16px">${e.message}</div>`; return; }
    if (!rows.length) { list.innerHTML = emptyState({ icon: 'check', title: q ? 'No one matches' : 'Everyone is connected', text: q ? '' : 'Every active person already has a Lifegroup.' }); return; }
    list.innerHTML = html`<div class="table-wrap"><table class="table table--stack">
      <thead><tr><th>Name</th><th>Boy / Girl</th><th>Status</th><th>Last attendance</th><th></th></tr></thead>
      <tbody>${rows.map((p) => html`<tr data-id="${p.id}">
        <td data-label=""><div class="person-cell">${raw(avatar(p, 'sm'))}<div class="person-cell__text"><a class="name" href="#/people/${p.id}">${fullName(p)}</a><div class="code">${p.person_code}</div></div></div></td>
        <td data-label="Boy / Girl">${sexBadge(p.sex)}</td>
        <td data-label="Status">${raw(statusBadge(p.status))}</td>
        <td data-label="Last attendance" class="nowrap">${p.last_attended ? fmtDate(p.last_attended, { short: true }) : raw('<span class="muted">—</span>')}</td>
        <td data-label="" class="actions">${can('lifegroups:manage') ? html`<button class="btn btn--sm" data-find="${p.id}">${icon('group', 14)} Find a Lifegroup</button>` : ''}</td>
      </tr>`)}</tbody></table></div>
      <div class="card__footer small muted">${rows.length} ${rows.length === 1 ? 'person' : 'people'} without a Lifegroup</div>`;
    list.querySelectorAll('[data-find]').forEach((b) => {
      const p = rows.find((x) => x.id === Number(b.dataset.find));
      b.onclick = () => findLifegroup(p, () => load());
    });
  }
  body.querySelector('#nq').addEventListener('input', debounce((e) => { q = e.target.value.trim(); load(); }, 250));
  load();
}

// ---------------------------------------------------------------------------
// Group detail
// ---------------------------------------------------------------------------
export async function renderLifegroup({ main }, id) {
  const g = await api.lifegroup(id);
  const manage = can('lifegroups:manage');
  const info = (label, value, ic) => html`<div><dt>${label}</dt>${value ? html`<dd>${ic ? icon(ic, 13) : ''} ${value}</dd>` : raw('<dd class="none">—</dd>')}</div>`;

  main.innerHTML = html`
    <div class="page-header">
      <div>
        <a class="small" href="#/lifegroups">${icon('back', 14)} Lifegroups</a>
        <h1 class="mt-1">${g.name}</h1>
        <div class="row mt-1">${genderBadge(g.gender, { long: true })}${g.network ? html`<span class="small muted">${g.network}${g.network_leader_name ? html` · Network leader: ${g.network_leader_name}` : ''}</span>` : ''}${g.is_active ? '' : raw('<span class="badge badge--nodot">Inactive</span>')}${g.is_demo ? raw('<span class="badge badge--demo badge--nodot">Demo data</span>') : ''}</div>
      </div>
      ${manage ? html`<div class="page-actions"><button class="btn" id="addMember">${icon('plus')} Add member</button><button class="btn btn--primary" id="editGroup">${icon('edit')} Edit</button></div>` : ''}
    </div>

    <div class="grid grid--stats mb-2" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
      ${g.leads_network ? html`
      <div class="card stat"><span class="stat__label">Cell leaders</span><span class="stat__value">${g.member_count}<small> / ${g.max_members}</small></span><span class="small muted">Network leader — max ${g.max_members}</span></div>
      <div class="card stat"><span class="stat__label">Their Lifegroups</span><span class="stat__value">${g.led_groups.length}</span><span class="small muted">${g.led_groups.filter((x) => x.solid_count >= g.solid_target).length} solid</span></div>` : html`
      <div class="card stat"><span class="stat__label">Members</span><span class="stat__value">${g.member_count}</span></div>
      <div class="card stat ${closedCount(g) >= g.solid_target ? 'stat--ok' : ''}"><span class="stat__label">Closed cell</span><span class="stat__value">${closedCount(g)}<small> / ${g.solid_target}</small></span><span class="small muted">${closedCount(g) >= g.solid_target ? 'Solid Lifegroup' : 'max ' + g.solid_target + ' · ' + g.solid_target + ' = solid'}</span></div>
      <div class="card stat"><span class="stat__label">Open cell</span><span class="stat__value">${g.member_count - closedCount(g)}</span><span class="small muted">no limit</span></div>`}
      <div class="card stat"><span class="stat__label">Schedule</span><span class="stat__value" style="font-size:1.15rem">${fmtSchedule(g) || '—'}</span></div>
    </div>

    <div class="stack">
      <div class="card">
        <div class="card__header"><h2>Details</h2></div>
        <div class="card__body"><dl class="dl">
          <div><dt>Leader</dt>${g.leader_person_id ? html`<dd><a href="#/people/${g.leader_person_id}">${g.leader_name}</a>${g.leader_contact ? html` <span class="small muted">· ${g.leader_contact}</span>` : ''}</dd>` : g.leader_name ? html`<dd>${g.leader_name} <span class="small muted">(not registered)</span></dd>` : raw('<dd class="none">—</dd>')}</div>
          <div><dt>Network</dt>${g.network_id ? html`<dd><a href="#/networks/${g.network_id}">${g.network}</a> <span class="small muted">${g.network_manual ? '· set by hand' : '· automatic'}</span></dd>` : g.network ? html`<dd>${g.network}</dd>` : html`<dd class="none">—</dd>`}</div>
          <div><dt>Network leader</dt>${g.network_leader_name ? html`<dd>${g.network_leader_person_id ? html`<a href="#/people/${g.network_leader_person_id}">${g.network_leader_name}</a>` : g.network_leader_name}<span class="small muted"> · leader reports here</span></dd>` : raw('<dd class="none">—</dd>')}</div>
          ${info('Category', g.category)}
          ${info('Day', DAY_LABELS[g.schedule_day])}
          ${info('Time', fmtClock(g.schedule_time))}
          ${info('Venue', g.venue, 'pin')}
          ${g.notes ? html`<div style="grid-column:1/-1"><dt>Notes</dt><dd>${g.notes}</dd></div>` : ''}
        </dl></div>
      </div>
      ${g.leads_network ? html`<div class="card">
        <div class="card__header"><h2>Cell leaders</h2><span class="hint">${g.member_count} / ${g.max_members}</span></div>
        <div class="card__body card__body--flush" id="membersCard">
          ${g.members.length ? html`<div class="table-wrap"><table class="table table--stack">
            <thead><tr><th>Cell leader</th><th>Present (last 4 wks)</th><th>Their Lifegroup</th><th class="num">Members</th><th class="num">Closed cell</th><th class="num">Open cell</th><th>Last held</th>${manage ? raw('<th></th>') : ''}</tr></thead>
            <tbody>${g.members.map((m) => { const lg = g.led_groups.find((x) => x.leader_person_id === m.id); return html`<tr data-pid="${m.id}" class="cl-row" data-lg="${lg ? lg.id : ''}" title="${lg ? 'Show their Open / Closed cell' : ''}">
              <td data-label="" class="nowrap"><span class="cl-caret" aria-hidden="true"></span><a href="#/people/${m.id}"><b>${fullName(m)}</b></a><div class="code">${m.person_code}</div>${lg ? raw('<div class="small cl-tap">Tap to see their Open / Closed cell</div>') : ''}</td>
              <td data-label="Present" class="nowrap"><span class="l4slot muted small">…</span></td>
              <td data-label="Their Lifegroup" class="nowrap">${lg ? html`<a href="#/lifegroups/${lg.id}">${lg.name}</a>` : raw('<span class="muted">No Lifegroup yet</span>')}</td>
              <td data-label="Members" class="num">${lg ? lg.member_count : '—'}</td>
              <td data-label="Closed cell" class="num nowrap">${lg ? (lg.solid_count >= g.solid_target ? raw(`<span class="badge badge--present badge--nodot" title="Solid Lifegroup">${lg.solid_count}</span>`) : html`<span class="nowrap">${lg.solid_count}<span class="muted small">/${g.solid_target}</span></span>`) : '—'}</td>
              <td data-label="Open cell" class="num">${lg ? lg.member_count - lg.solid_count : '—'}</td>
              <td data-label="Last held" class="small nowrap">${lg && lg.last_held ? fmtDate(lg.last_held, { short: true }) : raw('<span class="muted">—</span>')}</td>
              ${manage ? html`<td data-label="" class="actions nowrap"><button class="btn btn--ghost btn--sm" data-leave="${m.id}" data-name="${fullName(m)}">Remove</button></td>` : ''}
            </tr>`; })}</tbody></table></div>
            <div class="card__footer small muted">${dotsKey()}</div>` : html`<div class="empty" style="padding:28px"><p>No cell leaders yet.${manage ? raw(' Use <b>Add member</b> to add up to 6 cell leaders.') : ''}</p></div>`}
        </div>
      </div>` : html`<div class="card">
        <div class="card__header"><h2>Members</h2><span class="hint">${g.members.filter((m) => m.tier !== 'solid').length} open cell · ${closedCount(g)} / ${g.solid_target} closed cell</span></div>
        <div class="card__body card__body--flush" id="membersCard">
          ${g.members.length ? html`${memberSections(g.members.map((m) => ({ ...m, name: fullName(m), sub: html`${raw(statusBadge(m.status))} <span class="muted">since ${fmtDate(m.joined_at, { short: true })}</span>` })), { manage,
              actions: (m) => html`<button class="btn btn--ghost btn--sm" data-leave="${m.id}" data-name="${fullName(m)}" title="Remove from this Lifegroup">Remove</button> ` })}
            <div class="card__footer small muted">${dotsKey()}</div>` : html`<div class="empty" style="padding:28px"><p>No members yet.${manage ? raw(' Use <b>Add member</b> or assign from a person’s profile.') : ''}</p></div>`}
        </div>
      </div>`}
    </div>
    <div class="card mt-2" id="progressCard"></div>
    ${g.former.length ? html`<div class="card mt-2"><div class="card__header"><h2>Former members</h2></div>
      <div class="card__body"><ul class="small" style="margin:0 0 0 18px;columns:2;column-gap:24px">${g.former.map((f) => html`<li><a href="#/people/${f.id}">${fullName(f)}</a> <span class="muted">· ${fmtDate(f.joined_at, { short: true })} → ${fmtDate(f.left_at, { short: true })}</span></li>`)}</ul></div></div>` : ''}
    ${can('people:delete') && !g.members.length && !g.former.length ? html`<div class="row mt-3" style="padding:0 4px"><button class="btn btn--ghost small" id="delGroup" style="color:var(--muted)">Delete this empty group</button></div>` : ''}`;

  renderProgressCard(main.querySelector('#progressCard'), g.id, { onChange: () => {}, onLoaded: (p) => {
    // fill in the last-4-weeks cells now that progress data is here
    const by = new Map(p.members.map((m) => [m.id, m.last4]));
    main.querySelectorAll('#membersCard tr[data-pid] .l4slot').forEach((el) => { const l4 = by.get(Number(el.closest('tr').dataset.pid)); if (l4) el.outerHTML = memberDots(l4).value + (l4.consistency_pct != null ? ` <span class="small muted">${l4.consistency_pct}%</span>` : ''); else el.textContent = '—'; });
    main.querySelectorAll('#membersCard [data-tier]').forEach((b) => {
      const row = b.closest('tr'); const cell = row && row.querySelector('[data-label="Last 4 weeks"]'); const l4 = by.get(Number(b.dataset.tier));
      if (cell && l4) cell.innerHTML = memberDots(l4).value + (l4.consistency_pct != null ? ` <span class="small muted">${l4.consistency_pct}%</span>` : '');
    });
  } });
  main.querySelectorAll('#membersCard [data-tier]').forEach((b) => {
    b.onclick = () => withLoading(b, async () => {
      try { await api.setTier(g.id, Number(b.dataset.tier), b.dataset.to); toast(b.dataset.to === 'solid' ? 'Moved to the closed cell.' : 'Moved to the open cell.'); renderLifegroup({ main }, id); }
      catch (e) { toast(e.message, 'error'); }
    });
  });
  // Network leader view: click a cell leader row to expand their own Lifegroup's Open / Closed cell
  main.querySelectorAll('#membersCard tr.cl-row').forEach((row) => {
    row.onclick = (ev) => {
      if (ev.target.closest('a, button')) return;
      const lgId = Number(row.dataset.lg);
      if (!lgId) { toast('This cell leader has no Lifegroup yet.', 'info'); return; }
      const next = row.nextElementSibling;
      if (next && next.classList.contains('cl-detail')) { next.remove(); row.classList.remove('is-open'); return; }
      const tr = document.createElement('tr'); tr.className = 'cl-detail';
      const td = document.createElement('td'); td.colSpan = row.children.length; td.dataset.label = '';
      td.innerHTML = '<div class="loading small" style="padding:12px 16px">Loading…</div>';
      tr.appendChild(td); row.after(tr); row.classList.add('is-open');
      const draw = async () => {
        let p;
        try { p = await api.lifegroupProgress(lgId, 4); } catch (e) { td.innerHTML = html`<div class="alert alert--error" style="margin:10px 16px">${e.message}</div>`; return; }
        const solid = p.members.filter((m) => m.tier === 'solid').length;
        td.innerHTML = html`<div class="cl-detail__head small"><a href="#/lifegroups/${lgId}"><b>${p.group.name}</b></a><span class="muted"> · ${p.members.length} members · Closed cell ${solid} / ${p.target}${solid >= p.target ? ' · Solid Lifegroup' : ''} · Open cell ${p.members.length - solid}</span></div>
          ${p.members.length ? memberSections(p.members.map((m) => ({ ...m, name: `${m.first_name} ${m.last_name}` })), { manage }) : raw('<div class="small muted" style="padding:10px 16px">No members yet.</div>')}`;
        // keep the summary row in sync after a move
        const cellOf = (label) => row.querySelector(`td[data-label="${label}"]`);
        if (cellOf('Members')) cellOf('Members').textContent = p.members.length;
        if (cellOf('Open cell')) cellOf('Open cell').textContent = p.members.length - solid;
        if (cellOf('Closed cell')) cellOf('Closed cell').innerHTML = solid >= p.target ? `<span class="badge badge--present badge--nodot" title="Solid Lifegroup">${solid}</span>` : `<span class="nowrap">${solid}<span class="muted small">/${p.target}</span></span>`;
        td.querySelectorAll('[data-tier]').forEach((b) => {
          b.onclick = () => withLoading(b, async () => {
            try { await api.setTier(lgId, Number(b.dataset.tier), b.dataset.to); toast(b.dataset.to === 'solid' ? 'Moved to the closed cell.' : 'Moved to the open cell.'); await draw(); }
            catch (e) { toast(e.message, 'error'); }
          });
        });
      };
      draw();
    };
  });
  main.querySelector('#editGroup')?.addEventListener('click', () => groupForm(g, () => renderLifegroup({ main }, id)));
  main.querySelector('#delGroup')?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: `Delete ${g.name}?`, message: 'This group has no membership history, so it can be removed.', confirmText: 'Delete', danger: true });
    if (!ok) return;
    try { await api.deleteLifegroup(g.id); toast('Lifegroup deleted.', 'info'); location.hash = '#/lifegroups'; } catch (e) { toast(e.message, 'error'); }
  });
  main.querySelectorAll('[data-leave]').forEach((b) => {
    b.onclick = async () => {
      const ok = await confirmDialog({ title: `Remove ${b.dataset.name} from ${g.name}?`, message: 'They will be marked as left today. The membership stays in their history.', confirmText: 'Remove', danger: true });
      if (!ok) return;
      try { await api.leaveLifegroup(g.id, Number(b.dataset.leave)); toast('Member removed.', 'info'); renderLifegroup({ main }, id); } catch (e) { toast(e.message, 'error'); }
    };
  });
  main.querySelector('#addMember')?.addEventListener('click', () => {
    const modal = openModal({
      title: `Add member to ${g.name}`,
      body: `<div class="field gsearch-field"><label>Person</label><div class="gsearch" style="max-width:none">${icon('search', 16).value}<input id="memberPick" aria-label="Search a person to add" placeholder="${g.gender ? `Search a ${g.gender === 'boys' ? 'boy' : 'girl'}…` : 'Search a registered person…'}" autocomplete="off" /><div class="gsearch__results" id="memberPickResults" hidden></div></div><input type="hidden" id="memberId" />
        </div>
        <div class="form-grid mt-1"><div class="field"><label>Joined on</label><input type="date" id="joinedAt" value="${toISODate(new Date())}" /></div>
        <div class="field"><label>Role</label><select id="memberRole"><option value="member">Member</option><option value="assistant">Assistant</option><option value="leader">Leader</option></select></div></div>
        `,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn btn--primary" id="saveMember">Add to group</button>`,
    });
    modal.querySelector('[data-close]').onclick = closeModal;
    personPicker(modal, { inputId: 'memberPick', hiddenId: 'memberId', sex: SEX_OF[g.gender] || null });
    modal.querySelector('#saveMember').onclick = (e) => withLoading(e.currentTarget, async () => {
      const pid = Number(modal.querySelector('#memberId').value);
      if (!pid) return toast('Choose a registered person first.', 'error');
      try {
        const r = await api.assignLifegroup(g.id, pid, { joined_at: modal.querySelector('#joinedAt').value, role: modal.querySelector('#memberRole').value });
        closeModal(); toast(r.unchanged ? 'Already a member of this group.' : 'Member added.'); renderLifegroup({ main }, id);
      } catch (ex) { toast(ex.message, 'error'); }
    });
  });
}

// ---------------------------------------------------------------------------
// Networks: the layer above Lifegroups. Each Network has a leader; group leaders
// report to their Network leader. Networks are flat — every Network has the same shape.
// ---------------------------------------------------------------------------
async function networkForm(n, onSaved) {
  const v = (k) => esc(n?.[k] ?? '');
  const modal = openModal({
    title: n ? `Edit ${n.name}` : 'New Network',
    subtitle: n ? 'An independent network — its leader is the root. Networks are never placed under another Network.' : 'A new independent Network. Its leader is the root — it is never under another Network leader.',
    body: `<form id="netForm" class="form-grid" novalidate>
      <div id="netErr" class="alert alert--error span-2" hidden></div>
      <div class="field span-2"><label>Network name <span class="req">*</span></label><input name="name" value="${v('name')}" required autocomplete="off" placeholder="e.g. Network A" /></div>
      <div class="field span-2"><label>Boys or girls <span class="req">*</span></label>
        <div class="choice">
          <label class="choice__opt"><input type="radio" name="gender" value="boys" ${n?.gender === 'boys' ? 'checked' : ''} /><span>Boys network</span></label>
          <label class="choice__opt"><input type="radio" name="gender" value="girls" ${n?.gender === 'girls' ? 'checked' : ''} /><span>Girls network</span></label>
        </div></div>
      <div class="field span-2 gsearch-field"><label>Network leader <span class="opt">registered person</span></label>
        <div class="gsearch" style="max-width:none">${icon('search', 16).value}<input id="netLeaderPick" aria-label="Search a registered person to be Network leader" placeholder="Search a registered person…" autocomplete="off" /><div class="gsearch__results" id="netLeaderPickResults" hidden></div></div>
        <input type="hidden" id="netLeaderId" name="leader_person_id" />
        <span class="help" id="netLeaderHint"></span>
        <input name="leader_name" value="${v('leader_name')}" placeholder="Leader name (if not registered)" autocomplete="off" style="margin-top:6px" /></div>
      <div class="field span-2"><label>Notes <span class="opt">optional</span></label><textarea name="notes">${v('notes')}</textarea></div>
      ${n ? `<div class="field span-2"><label class="toggle"><input type="checkbox" name="is_active" ${n.is_active ? 'checked' : ''}/> Network is active</label></div>` : ''}
    </form>`,
    footer: `<button class="btn" data-close>Cancel</button><button class="btn btn--primary" id="saveNet">${n ? 'Save' : 'Create Network'}</button>`,
  });
  modal.querySelector('[data-close]').onclick = closeModal;
  const netGenderNow = () => modal.querySelector('[name=gender]:checked')?.value || null;
  const netHint = modal.querySelector('#netLeaderHint');
  const syncNetGender = (clearLeader) => {
    const gg = netGenderNow();
    netHint.textContent = gg ? '' : 'Choose Boys network or Girls network first.';
    if (clearLeader && modal.querySelector('#netLeaderId').value) { modal.querySelector('#netLeaderId').value = ''; modal.querySelector('#netLeaderPick').value = ''; }
  };
  syncNetGender(false);
  modal.querySelectorAll('[name=gender]').forEach((r) => r.addEventListener('change', () => syncNetGender(true)));
  personPicker(modal, { inputId: 'netLeaderPick', hiddenId: 'netLeaderId', sex: () => SEX_OF[netGenderNow()] || null, initial: n?.leader_person_id ? { id: n.leader_person_id, name: n.leader_name } : null });
  const save = (e) => withLoading(modal.querySelector('#saveNet'), async () => {
    e.preventDefault();
    const form = modal.querySelector('#netForm');
    const d = formData(form);
    d.gender = form.querySelector('[name=gender]:checked')?.value || null;
    d.leader_person_id = form.querySelector('#netLeaderId').value || null;
    if (n) d.is_active = form.querySelector('[name=is_active]').checked;
    for (const k of Object.keys(d)) if (d[k] === '') d[k] = null;
    const err = modal.querySelector('#netErr');
    try {
      const saved = n ? await api.updateNetwork(n.id, d) : await api.createNetwork(d);
      closeModal(); toast(n ? 'Network updated.' : `${saved.name} created.`); onSaved(saved);
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
  modal.querySelector('#saveNet').onclick = save;
  modal.querySelector('#netForm').onsubmit = save;
}

export async function renderNetwork({ main }, id, openGroups = new Set(), { autoTried = false } = {}) {
  const [n, cal] = await Promise.all([api.network(id), api.networkCalendar(id, 8, { members: true }).catch(() => null)]);
  const manage = can('lifegroups:manage');
  // The Network QR is the network leader's own Lifegroup link. If the leader has no Lifegroup yet, create it once
  // ("<Network> Leaders" — it holds the cell leaders) so the QR always loads.
  let autoErr = '';
  if (manage && n.leader_person_id && !(cal && cal.groups && cal.groups.some((g) => g.is_leader_group)) && !autoTried) {
    try { await api.ensureNetworkLeaderGroup(id); return renderNetwork({ main }, id, openGroups, { autoTried: true }); } catch (e) { autoErr = e.message; }
  }
  const netTarget = cal ? cal.target : 6;
  const last4Of = (gid, pid) => (cal && cal.members_last4 && cal.members_last4[gid] ? cal.members_last4[gid][pid] || null : null);
  // independent network: root = the network leader (their own Lifegroup = the cell leaders); children = the cell leaders' Lifegroups
  const own = n.groups.find((g) => g.is_leader_group) || null;
  const cells = n.groups.filter((g) => !g.is_leader_group);
  const members = cells.reduce((t, g) => t + g.member_count, 0);
  const boys = cells.reduce((t, g) => t + g.boys, 0), girls = cells.reduce((t, g) => t + g.girls, 0);
  const personLink = (p) => html`<a href="#/people/${p.id}">${fullName(p)}</a>`;
  const leaderGroup = cal && cal.groups ? cal.groups.find((g) => g.is_leader_group) || null : null;

  main.innerHTML = html`
    <div class="page-header">
      <div>
        <a class="small" href="#/lifegroups">${icon('back', 14)} Network</a>
        <h1 class="mt-1">${n.name}</h1>
        <div class="row mt-1">${genderBadge(n.gender, { long: true, noun: 'network' })}<span class="small muted">${n.is_auto ? 'Formed automatically' : 'Set by hand'}</span>${n.is_active ? '' : raw('<span class="badge badge--nodot">Inactive</span>')}${n.is_demo ? raw('<span class="badge badge--demo badge--nodot">Demo data</span>') : ''}</div>
      </div>
      ${manage ? html`<div class="page-actions">${leaderGroup ? html`<button class="btn btn--primary" id="netReport">${icon('plus')} Report a meeting</button><button class="btn" id="netQr">${icon('link')} Network QR</button>` : ''}<button class="btn" id="editNet">${icon('edit')} Edit</button></div>` : ''}
    </div>
    ${manage ? html`<div class="card mb-2 netqr" id="netQrCard">
      <div class="netqr__img" id="netQrImg">${leaderGroup ? raw('<div class="loading small">…</div>') : ''}</div>
      <div class="netqr__text">
        <b>Network QR · ${n.name}</b>
        ${leaderGroup ? html`<div class="small muted">Weekly report of <a href="#/lifegroups/${leaderGroup.id}">${leaderGroup.name}</a> · no login needed.</div>
          <div class="row mt-1" style="gap:8px;flex-wrap:wrap"><button class="btn btn--sm" id="netQrOpen">${icon('link', 14)} Link, print &amp; New QR</button><button class="btn btn--sm" id="netQrCopy">${icon('copy', 14)} Copy link</button></div>`
        : html`<div class="small muted">${autoErr ? html`<span class="alert alert--error" style="display:inline-block;padding:6px 10px">${autoErr}</span>` : n.leader_person_id ? `Could not prepare ${n.leader_name}’s Lifegroup for the QR. Reload the page or create their Lifegroup (leader = ${n.leader_name}).` : 'Set the network leader first (Edit) — the Network QR is created automatically after that.'}</div>`}
      </div>
    </div>` : ''}

    ${!n.gender ? html`<div class="alert alert--warn mb-2">${icon('warn', 16)} This Network is not yet marked as boys or girls. ${manage ? 'Press Edit and choose one — networks are never combined.' : 'Ask an Admin to set it.'}${boys && girls ? html` It currently holds ${boys} boys and ${girls} girls; move one side to another Network first.` : ''}</div>` : ''}
    <div class="grid grid--stats mb-2" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
      <div class="card stat"><span class="stat__label">Cell leaders</span><span class="stat__value">${n.cell_leaders || 0}<small> / 6</small></span><span class="small muted">${leaderGroup ? 'in ' + leaderGroup.name : 'network leader has no Lifegroup yet'}</span></div>
      <div class="card stat"><span class="stat__label">Lifegroups</span><span class="stat__value">${n.group_count}</span><span class="small muted">led by the cell leaders</span></div>
      <div class="card stat"><span class="stat__label">${n.gender === 'boys' ? 'Boys' : n.gender === 'girls' ? 'Girls' : 'Members'}</span><span class="stat__value">${members}</span>${n.gender ? '' : html`<span class="small muted">${boys} boys · ${girls} girls</span>`}</div>
      <div class="card stat ${n.group_count && cells.filter((g) => g.is_active).every((g) => g.members.filter((m) => m.tier === 'solid').length >= netTarget) ? 'stat--ok' : ''}"><span class="stat__label">Closed cell</span><span class="stat__value">${n.closed_cell || 0}</span><span class="small muted">${netTarget} per Lifegroup = solid</span></div>
      <div class="card stat"><span class="stat__label">Open cell</span><span class="stat__value">${n.open_cell || 0}</span><span class="small muted">no limit</span></div>
    </div>

    <div class="card mb-2">
      <div class="card__header"><h2>Structure</h2></div>
      <div class="card__body">
        <div class="tree">
          <div class="tree__root">
            <div class="tree__node tree__node--root">
              <span class="tree__tag">Network leader</span>
              <div class="tree__who">${n.leader_person_id ? html`<a href="#/people/${n.leader_person_id}"><b>${n.leader_name}</b></a>` : n.leader_name ? html`<b>${n.leader_name}</b> <span class="small muted">(not registered)</span>` : raw('<span class="muted">No leader set yet</span>')}${n.leader_contact ? html`<span class="small muted"> · ${n.leader_contact}</span>` : ''}</div>
              <div class="small muted">Independent network · ${n.cell_leaders || 0} cell leader${n.cell_leaders === 1 ? '' : 's'} report here${leaderGroup ? html` · <a href="#/lifegroups/${leaderGroup.id}" style="color:inherit;text-decoration:underline">${leaderGroup.name}</a>` : ''}</div>
              ${own && own.members.length ? html`<div class="small mt-1">Cell leaders: ${own.members.map((m, i) => html`${i ? ', ' : ''}<a href="#/people/${m.id}">${fullName(m)}</a>`)}</div>` : ''}
            </div>
            ${n.notes ? html`<div class="small muted mt-1">${n.notes}</div>` : ''}
          </div>

          ${cells.length ? html`<div class="tree__children">${cells.map((g) => html`<details class="tree__node tree__node--group ${g.is_active ? '' : 'is-inactive'}" data-gid="${g.id}" ${openGroups.has(g.id) ? 'open' : ''}>
            <summary>
              <div class="row row--between" style="gap:10px;flex-wrap:wrap">
                <div class="min-w-0">
                  <span class="tree__tag">Lifegroup leader · ${g.gender === 'boys' ? 'boys group' : g.gender === 'girls' ? 'girls group' : 'boys/girls not set'}</span>
                  <div class="tree__who"><b>${g.leader_name || raw('<span class="muted">No leader</span>')}</b> <span class="muted">· ${g.name}</span> ${genderBadge(g.gender)}${g.is_active ? '' : raw(' <span class="badge badge--nodot">Inactive</span>')}</div>
                  <div class="small muted">${g.member_count} member${g.member_count === 1 ? '' : 's'}${fmtSchedule(g) ? html` · ${fmtSchedule(g)}` : ''}</div>
                </div>
                <div class="small muted nowrap">${solidBadge(g.members.filter((m) => m.tier === 'solid').length, netTarget, g.members.filter((m) => m.tier === 'solid').length >= netTarget)}</div>
              </div>
              <span class="tree__toggle small">${icon('chevR', 14)} <span class="t-open">Show members</span><span class="t-close">Hide members</span></span>
            </summary>
            <div class="tree__members">
              <div class="row small mb-1" style="gap:10px"><a href="#/lifegroups/${g.id}">Open ${g.name} ${icon('chevR', 12)}</a>${g.leader_person_id ? html`<a href="#/people/${g.leader_person_id}">Leader profile</a>` : ''}</div>
              ${g.members.length ? memberSections(g.members.map((m) => ({ ...m, name: fullName(m), last4: last4Of(g.id, m.id), sub: html`${raw(statusBadge(m.status))} <span class="muted">since ${fmtDate(m.joined_at, { short: true })}</span>` })), { manage }) : raw('<div class="small muted" style="padding:6px 0">No members yet.</div>')}
            </div>
          </details>`)}</div>` : html`<div class="tree__children"><div class="tree__node small muted">No Lifegroups in this Network yet.${manage ? ' Edit a Lifegroup and choose this Network.' : ''}</div></div>`}
        </div>
      </div>
      <div class="card__footer small muted">${dotsKey()} · Closed cell = matagal na, consistent · Open cell = mga bago · Statistics and CSV: <a href="#/reports?view=lifegroups">Reports → Lifegroups</a></div>
    </div>

    <div class="card mb-2" id="netCalendar"></div>
    ${can('people:delete') && !n.groups.length ? html`<div class="row mt-3" style="padding:0 4px"><button class="btn btn--ghost small" id="delNet" style="color:var(--muted)">Delete this empty network</button></div>` : ''}`;
  renderNetworkCalendar(main.querySelector('#netCalendar'), n.id, cal);
  // move a member between Open / Closed cell straight from the Structure tree (closed cell cap still applies)
  main.querySelectorAll('.tree [data-tier]').forEach((b) => {
    b.onclick = () => withLoading(b, async () => {
      const gid = Number(b.closest('details[data-gid]').dataset.gid);
      try {
        await api.setTier(gid, Number(b.dataset.tier), b.dataset.to);
        toast(b.dataset.to === 'solid' ? 'Moved to the closed cell.' : 'Moved to the open cell.');
        const keep = new Set([...main.querySelectorAll('details[data-gid][open]')].map((d) => Number(d.dataset.gid)));
        renderNetwork({ main }, id, keep);
      } catch (e) { toast(e.message, 'error'); }
    });
  });
  if (manage && leaderGroup) {
    let prog = null;
    const load = async () => { prog = await api.lifegroupProgress(leaderGroup.id, 4); return prog; };
    load().then((p) => { const img = main.querySelector('#netQrImg'); if (img) img.innerHTML = p.report_qr || ''; }).catch((e) => { const img = main.querySelector('#netQrImg'); if (img) img.innerHTML = html`<span class="small muted">${e.message}</span>`; });
    const openLink = async () => { try { const p = prog || await load(); linkDialog(leaderGroup.id, p, (link, qr) => { p.report_link = link; p.report_qr = qr; const img = main.querySelector('#netQrImg'); if (img) img.innerHTML = qr || ''; }, { network: n.name }); } catch (e) { toast(e.message, 'error'); } };
    main.querySelector('#netQr').onclick = openLink;
    main.querySelector('#netQrOpen').onclick = openLink;
    main.querySelector('#netQrCopy').onclick = async () => {
      try { const p = prog || await load(); await navigator.clipboard.writeText(p.report_link); toast('Network link copied.'); } catch (e) { toast(e.message || 'Could not copy — open the QR dialog and copy from there.', 'error'); }
    };
    main.querySelector('#netReport').onclick = async () => { try { const p = prog || await load(); meetingForm(leaderGroup.id, p, null, () => renderNetwork({ main }, id)); } catch (e) { toast(e.message, 'error'); } };
  }
  main.querySelector('#editNet')?.addEventListener('click', () => networkForm(n, () => renderNetwork({ main }, id)));
  main.querySelector('#delNet')?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: `Delete ${n.name}?`, message: 'This Network has no Lifegroups, so it can be removed.', confirmText: 'Delete', danger: true });
    if (!ok) return;
    try { await api.deleteNetwork(n.id); toast('Network deleted.', 'info'); location.hash = '#/lifegroups?tab=networks'; } catch (e) { toast(e.message, 'error'); }
  });
}
