import { api } from '../api.js';
import { renderProgressCard, renderNetworkCalendar, drawProgressTab, solidBadge, weekStrip } from './progress.js';
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
const slotsText = (g) => (g.capacity == null ? 'Open' : g.slots > 0 ? `${g.slots} slot${g.slots === 1 ? '' : 's'}` : 'Full');
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
        </div><span class="help">Groups are never mixed — only boys can join a boys group, only girls a girls group.</span></div>
      <div class="field"><label>Network</label><select name="network_id"><option value="" ${!g || !g.network_manual ? 'selected' : ''}>Auto — from the leader's own Lifegroup${g && !g.network_manual && g.network ? ' (now: ' + esc(g.network) + ')' : ''}</option>${(opts.networks || []).map((n) => `<option value="${n.id}" data-gender="${n.gender || ''}" ${g?.network_manual && Number(g?.network_id) === n.id ? 'selected' : ''}>${esc(n.name)}${n.gender ? ' (' + n.gender + ')' : ''}${n.leader_name ? ' · ' + esc(n.leader_name) : ''}</option>`).join('')}</select><span class="help">Auto: the network is the one led by the leader's own Lifegroup leader, and updates itself. Pick a network only to override by hand.</span></div>
      <div class="field span-2 gsearch-field"><label>Leader <span class="opt">registered person</span></label>
        <div class="gsearch" style="max-width:none">${icon('search', 16).value}<input id="leaderPick" aria-label="Search a registered person to be leader" placeholder="Search a registered person…" autocomplete="off" /><div class="gsearch__results" id="leaderPickResults" hidden></div></div>
        <input type="hidden" id="leaderId" name="leader_person_id" />
        <span class="help" id="leaderHint"></span>
        <span class="help">Or type a name below if the leader is not registered yet.</span>
        <input name="leader_name" value="${v('leader_name')}" placeholder="Leader name (if not registered)" autocomplete="off" style="margin-top:6px" /></div>
      <div class="field"><label>Area <span class="opt">optional</span></label><input name="area" value="${v('area')}" list="dlArea" autocomplete="off" placeholder="e.g. Kaybanban" />${dl('dlArea', opts.areas)}</div>
      <div class="field"><label>Category <span class="opt">optional</span></label><input name="category" value="${v('category')}" list="dlCat" autocomplete="off" placeholder="e.g. Students, Young Pro, Mixed" />${dl('dlCat', opts.categories)}</div>
      <div class="field"><label>Day <span class="opt">optional</span></label><select name="schedule_day"><option value="">—</option>${Object.entries(DAY_LABELS).map(([k, l]) => `<option value="${k}" ${g?.schedule_day === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label>Time <span class="opt">optional</span></label><input name="schedule_time" type="time" value="${v('schedule_time')}" /></div>
      <div class="field"><label>Capacity <span class="opt">blank = no limit</span></label><input name="capacity" type="number" min="1" max="999" value="${v('capacity')}" /></div>
      <div class="field"><label>Venue <span class="opt">optional</span></label><input name="venue" value="${v('venue')}" autocomplete="off" /></div>
      <div class="field span-2"><label>Notes <span class="opt">optional</span></label><textarea name="notes">${v('notes')}</textarea></div>
      ${g ? `<div class="field span-2"><label class="toggle"><input type="checkbox" name="is_active" ${g.is_active ? 'checked' : ''}/> Group is active</label><span class="help">Inactive groups are hidden from recommendations and new assignments; history is kept.</span></div>` : ''}
    </form>`,
    footer: `<button class="btn" data-close>Cancel</button><button class="btn btn--primary" id="saveGroup">${g ? 'Save' : 'Create Lifegroup'}</button>`,
  });
  modal.querySelector('[data-close]').onclick = closeModal;
  const genderNow = () => modal.querySelector('[name=gender]:checked')?.value || null;
  const leaderHint = modal.querySelector('#leaderHint');
  const netSel = modal.querySelector('[name=network_id]');
  const refreshLeaderHint = () => {
    const gg = genderNow(); leaderHint.textContent = gg ? `Only ${gg} are listed — a ${gg} group is led by a ${gg === 'boys' ? 'boy' : 'girl'}.` : 'Choose Boys group or Girls group above first.';
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
        <span class="small muted">${person.sex ? 'Only ' + (person.sex === 'male' ? 'boys' : 'girls') + ' groups are shown — groups are never mixed.' : 'Not set on the profile yet — choose one to see matching groups (it will be saved).'}</span>
      </div>
      <div class="gsearch mb-2" style="max-width:none">${icon('search', 16).value}<input id="findQ" placeholder="Filter by group, leader, network or area…" autocomplete="off" aria-label="Filter Lifegroups" /></div>
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
    const groups = needle ? all.filter((g) => [g.name, g.leader_name, g.network, g.network_name, g.area, g.category].some((v) => v && String(v).toLowerCase().includes(needle))) : all;
    if (!groups.length) { list.innerHTML = emptyState({ icon: 'group', title: needle ? 'No match' : `No ${sex === 'male' ? 'boys' : 'girls'} Lifegroup available`, text: needle ? 'Try another group, leader or area name.' : `No active ${sex === 'male' ? 'boys' : 'girls'} group with open slots. Create one under Lifegroups.` }).value; return; }
    list.innerHTML = `<div class="table-wrap"><table class="table table--stack">
      <thead><tr><th>Group</th><th>Leader</th><th>Network</th><th>Schedule</th><th>Slots</th><th></th></tr></thead>
      <tbody>${groups.map((g) => `<tr>
        <td data-label=""><b>${esc(g.name)}</b> ${genderBadge(g.gender).value}${g.area ? `<div class="small muted">${esc(g.area)}</div>` : ''}</td>
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
  const tab = ['needs', 'networks', 'progress'].includes(query.tab) ? query.tab : 'groups';
  const filters = { q: query.q || '', area: query.area || '', status: query.status || 'active', gender: query.gender || '' };
  let overview = null;
  try { overview = await api.get('/api/lifegroups/overview'); } catch (e) { /* non-fatal */ }

  main.innerHTML = html`
    <div class="page-header">
      <div><h1>Lifegroups</h1><p class="sub">Connect people to a cell group after Sunday</p></div>
      <div class="page-actions">${can('lifegroups:manage') && tab !== 'networks' ? html`<button class="btn btn--primary" id="newGroup">${icon('plus')} New Lifegroup</button>` : ''}</div>
    </div>
    ${overview ? html`<div class="kpi-row mb-2" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">
      <div class="kpi"><b>${overview.active_groups}</b><span>Active groups</span>${overview.boys_groups != null ? html`<div class="small muted" style="text-transform:none;letter-spacing:0;font-weight:500">${overview.boys_groups} boys · ${overview.girls_groups} girls</div>` : ''}</div>
      <div class="kpi"><b>${overview.total_leaders}</b><span>Leaders</span></div>
      <div class="kpi"><b>${overview.with_group}</b><span>With Lifegroup</span></div>
      <div class="kpi ${overview.without_group ? 'kpi--amber' : ''}"><b>${overview.without_group}</b><span>Without Lifegroup</span></div>
      <div class="kpi"><b>${overview.groups_with_slots}</b><span>Groups with slots</span></div>
    </div>` : ''}
    <div class="filter-tabs mb-2" id="tabs">
      <button data-t="groups" class="${tab === 'groups' ? 'active' : ''}">Groups</button>
      <button data-t="needs" class="${tab === 'needs' ? 'active' : ''}">Needs Lifegroup ${overview ? html`<span class="count">${overview.without_group}</span>` : ''}</button>
      <button data-t="networks" class="${tab === 'networks' ? 'active' : ''}">Networks</button>
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
  if (tab === 'networks') return drawNetworks(body);
  if (tab === 'progress') return drawProgressTab(body);
  return drawGroups(body, filters);
}

async function drawGroups(body, filters) {
  let opts = { areas: [] };
  try { opts = await api.lifegroupOptions(); } catch (e) { /* optional */ }
  body.innerHTML = html`
    <div class="toolbar">
      <div class="gsearch grow" style="max-width:none">${icon('search', 17)}<input type="search" id="gq" placeholder="Search group, leader, area or network" value="${filters.q}" autocomplete="off" /></div>
      <select id="ggender" style="width:auto;min-width:120px" aria-label="Boys or girls"><option value="">Boys & girls</option><option value="boys" ${filters.gender === 'boys' ? 'selected' : ''}>Boys groups</option><option value="girls" ${filters.gender === 'girls' ? 'selected' : ''}>Girls groups</option></select>
      <select id="garea" style="width:auto;min-width:140px" aria-label="Area"><option value="">All areas</option>${opts.areas.map((a) => html`<option value="${a}" ${filters.area === a ? 'selected' : ''}>${a}</option>`)}</select>
      <select id="gstatus" style="width:auto;min-width:120px" aria-label="Status"><option value="active">Active</option><option value="inactive" ${filters.status === 'inactive' ? 'selected' : ''}>Inactive</option><option value="all" ${filters.status === 'all' ? 'selected' : ''}>All</option></select>
    </div>
    <div class="card"><div id="glist" class="card__body--flush"><div class="loading">Loading…</div></div></div>`;
  const list = body.querySelector('#glist');
  let reqId = 0;
  async function load() {
    const id = ++reqId;
    history.replaceState(null, '', '#/lifegroups' + api.qs({ q: filters.q, area: filters.area, gender: filters.gender, status: filters.status === 'active' ? '' : filters.status }));
    let groups;
    try { groups = await api.lifegroups(filters); } catch (e) { list.innerHTML = html`<div class="alert alert--error" style="margin:16px">${e.message}</div>`; return; }
    if (id !== reqId) return;
    if (!groups.length) {
      list.innerHTML = emptyState({ icon: 'group', title: filters.q || filters.area ? 'No group matches' : 'No Lifegroups yet', text: filters.q || filters.area ? 'Try a different search.' : 'Create the first Lifegroup so people can be connected after Sunday.', action: can('lifegroups:manage') && !filters.q ? '<button class="btn btn--primary" id="newGroup2">New Lifegroup</button>' : '' });
      list.querySelector('#newGroup2')?.addEventListener('click', () => groupForm(null, (g) => { location.hash = `#/lifegroups/${g.id}`; }));
      return;
    }
    list.innerHTML = html`<div class="table-wrap"><table class="table table--stack">
      <thead><tr><th>Group</th><th>Leader</th><th>Area</th><th>Schedule</th><th class="num">Members</th><th>Solid</th><th>Last held</th></tr></thead>
      <tbody>${groups.map((g) => html`<tr class="clickable" data-id="${g.id}">
        <td data-label=""><b>${g.name}</b> ${genderBadge(g.gender)}${g.network ? html`<div class="small muted">${g.network}${g.network_leader_name ? html` · ${g.network_leader_name}` : ''}</div>` : ''}${g.is_active ? '' : raw(' <span class="badge badge--nodot">Inactive</span>')}${g.is_demo ? raw(' <span class="badge badge--demo badge--nodot">Demo</span>') : ''}</td>
        <td data-label="Leader">${g.leader_name || raw('<span class="muted">—</span>')}</td>
        <td data-label="Area">${g.area || raw('<span class="muted">—</span>')}</td>
        <td data-label="Schedule">${fmtSchedule(g) || raw('<span class="muted">—</span>')}</td>
        <td data-label="Members" class="num">${g.member_count}${g.capacity != null ? html`<span class="muted"> / ${g.capacity}</span>` : ''}</td>
        <td data-label="Solid" class="nowrap">${solidBadge(g.solid_count || 0, g.solid_target || 6, (g.solid_count || 0) >= (g.solid_target || 6))}</td>
        <td data-label="Last held" class="nowrap small">${g.last_held ? fmtDate(g.last_held, { short: true }) : raw('<span class="muted">—</span>')}</td>
      </tr>`)}</tbody></table></div>
      <div class="card__footer small muted">${groups.length} group${groups.length === 1 ? '' : 's'}</div>`;
    list.querySelectorAll('tr.clickable').forEach((tr) => { tr.onclick = () => { location.hash = `#/lifegroups/${tr.dataset.id}`; }; });
  }
  body.querySelector('#gq').addEventListener('input', debounce((e) => { filters.q = e.target.value.trim(); load(); }, 250));
  body.querySelector('#garea').onchange = (e) => { filters.area = e.target.value; load(); };
  body.querySelector('#ggender').onchange = (e) => { filters.gender = e.target.value; load(); };
  body.querySelector('#gstatus').onchange = (e) => { filters.status = e.target.value; load(); };
  load();
}

async function drawNeeds(body) {
  body.innerHTML = html`
    <div class="toolbar"><div class="gsearch grow" style="max-width:none">${icon('search', 17)}<input type="search" id="nq" placeholder="Search name or Person ID" autocomplete="off" /></div></div>
    <p class="small muted mb-1">Active people (first timers, returning, members) who are <b>not in any Lifegroup</b>. Most recent attendees first — these are the ones to follow up.</p>
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
      <div class="card stat"><span class="stat__label">Members</span><span class="stat__value">${g.member_count}${g.capacity != null ? html`<small> / ${g.capacity}</small>` : ''}</span></div>
      <div class="card stat"><span class="stat__label">Slots</span><span class="stat__value" style="font-size:1.15rem">${slotsText(g)}</span></div>
      <div class="card stat"><span class="stat__label">Schedule</span><span class="stat__value" style="font-size:1.15rem">${fmtSchedule(g) || '—'}</span></div>
      <div class="card stat"><span class="stat__label">Area</span><span class="stat__value" style="font-size:1.15rem">${g.area || '—'}</span></div>
      <div class="card stat"><span class="stat__label">Boys · Girls</span><span class="stat__value" style="font-size:1.15rem">${g.members.filter((m) => m.sex === 'male').length} · ${g.members.filter((m) => m.sex === 'female').length}</span></div>
    </div>

    <div class="grid grid--detail">
      <div class="card">
        <div class="card__header"><h2>Details</h2></div>
        <div class="card__body"><dl class="dl">
          <div><dt>Leader</dt>${g.leader_person_id ? html`<dd><a href="#/people/${g.leader_person_id}">${g.leader_name}</a>${g.leader_contact ? html` <span class="small muted">· ${g.leader_contact}</span>` : ''}</dd>` : g.leader_name ? html`<dd>${g.leader_name} <span class="small muted">(not registered)</span></dd>` : raw('<dd class="none">—</dd>')}</div>
          <div><dt>Network</dt>${g.network_id ? html`<dd><a href="#/networks/${g.network_id}">${g.network}</a> <span class="small muted">${g.network_manual ? '· set by hand' : '· automatic'}</span></dd>` : g.network ? html`<dd>${g.network}</dd>` : html`<dd class="none">— <span class="small">forms once the leader joins another leader's Lifegroup</span></dd>`}</div>
          <div><dt>Network leader</dt>${g.network_leader_name ? html`<dd>${g.network_leader_person_id ? html`<a href="#/people/${g.network_leader_person_id}">${g.network_leader_name}</a>` : g.network_leader_name}<span class="small muted"> · leader reports here</span></dd>` : raw('<dd class="none">—</dd>')}</div>
          ${info('Category', g.category)}
          ${info('Day', DAY_LABELS[g.schedule_day])}
          ${info('Time', fmtClock(g.schedule_time))}
          ${info('Venue', g.venue, 'pin')}
          ${g.notes ? html`<div style="grid-column:1/-1"><dt>Notes</dt><dd>${g.notes}</dd></div>` : ''}
        </dl></div>
      </div>
      <div class="card">
        <div class="card__header"><h2>Members</h2><span class="hint">${g.members.length} current</span></div>
        <div class="card__body card__body--flush">
          ${g.members.length ? html`<div class="table-wrap"><table class="table table--stack">
            <thead><tr><th>Name</th><th>Boy / Girl</th><th>Role</th><th>Since</th><th>Last attendance</th>${manage ? raw('<th></th>') : ''}</tr></thead>
            <tbody>${g.members.map((m) => html`<tr>
              <td data-label=""><div class="person-cell">${raw(avatar(m, 'sm'))}<div class="person-cell__text"><a class="name" href="#/people/${m.id}">${fullName(m)}</a><div class="code">${m.person_code}</div></div></div></td>
              <td data-label="Boy / Girl">${sexBadge(m.sex)}</td>
              <td data-label="Role">${m.role === 'member' ? raw(statusBadge(m.status)) : html`<span class="badge badge--leader">${m.role === 'leader' ? 'Leader' : 'Assistant'}</span>`}</td>
              <td data-label="Since" class="nowrap">${fmtDate(m.joined_at, { short: true })}</td>
              <td data-label="Last attendance" class="nowrap">${m.last_attended ? fmtDate(m.last_attended, { short: true }) : raw('<span class="muted">—</span>')}</td>
              ${manage ? html`<td data-label="" class="actions"><button class="btn btn--ghost btn--sm" data-leave="${m.id}" data-name="${fullName(m)}">Remove</button></td>` : ''}
            </tr>`)}</tbody></table></div>` : html`<div class="empty" style="padding:28px"><p>No members yet.${manage ? raw(' Use <b>Add member</b> or assign from a person’s profile.') : ''}</p></div>`}
        </div>
      </div>
    </div>
    <div class="card mt-2" id="progressCard"></div>
    ${g.former.length ? html`<div class="card mt-2"><div class="card__header"><h2>Former members</h2><span class="hint">History is kept</span></div>
      <div class="card__body"><ul class="small" style="margin:0 0 0 18px;columns:2;column-gap:24px">${g.former.map((f) => html`<li><a href="#/people/${f.id}">${fullName(f)}</a> <span class="muted">· ${fmtDate(f.joined_at, { short: true })} → ${fmtDate(f.left_at, { short: true })}</span></li>`)}</ul></div></div>` : ''}
    ${can('people:delete') && !g.members.length && !g.former.length ? html`<div class="row mt-3" style="padding:0 4px"><button class="btn btn--ghost small" id="delGroup" style="color:var(--muted)">Delete this empty group</button></div>` : ''}`;

  renderProgressCard(main.querySelector('#progressCard'), g.id, { onChange: () => {} });
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
        ${g.gender ? `<span class="help">${g.name} is a ${g.gender} group — only ${g.gender} are listed.</span>` : ''}</div>
        <div class="form-grid mt-1"><div class="field"><label>Joined on</label><input type="date" id="joinedAt" value="${toISODate(new Date())}" /></div>
        <div class="field"><label>Role</label><select id="memberRole"><option value="member">Member</option><option value="assistant">Assistant</option><option value="leader">Leader</option></select></div></div>
        <p class="small muted">If the person is already in another group they will be moved; the previous membership is kept in history.</p>`,
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
// report to their Network leader; a Network can sit under a parent Network.
// ---------------------------------------------------------------------------
async function networkForm(n, onSaved) {
  let all = [];
  try { all = await api.networks({ status: 'all' }); } catch (e) { /* optional */ }
  const parents = all.filter((x) => !n || x.id !== n.id);
  const v = (k) => esc(n?.[k] ?? '');
  const modal = openModal({
    title: n ? `Edit ${n.name}` : 'New Network',
    subtitle: n ? '' : 'A Network groups Lifegroups under one Network leader.',
    body: `<form id="netForm" class="form-grid" novalidate>
      <div id="netErr" class="alert alert--error span-2" hidden></div>
      <div class="field span-2"><label>Network name <span class="req">*</span></label><input name="name" value="${v('name')}" required autocomplete="off" placeholder="e.g. Network A" /></div>
      <div class="field span-2"><label>Boys or girls <span class="req">*</span></label>
        <div class="choice">
          <label class="choice__opt"><input type="radio" name="gender" value="boys" ${n?.gender === 'boys' ? 'checked' : ''} /><span>Boys network</span></label>
          <label class="choice__opt"><input type="radio" name="gender" value="girls" ${n?.gender === 'girls' ? 'checked' : ''} /><span>Girls network</span></label>
        </div><span class="help">A Network is never combined — a boys network holds boys groups only, a girls network girls groups only.</span></div>
      <div class="field span-2 gsearch-field"><label>Network leader <span class="opt">registered person</span></label>
        <div class="gsearch" style="max-width:none">${icon('search', 16).value}<input id="netLeaderPick" aria-label="Search a registered person to be Network leader" placeholder="Search a registered person…" autocomplete="off" /><div class="gsearch__results" id="netLeaderPickResults" hidden></div></div>
        <input type="hidden" id="netLeaderId" name="leader_person_id" />
        <span class="help" id="netLeaderHint"></span>
        <span class="help">Lifegroup leaders in this Network report to this person.</span>
        <input name="leader_name" value="${v('leader_name')}" placeholder="Leader name (if not registered)" autocomplete="off" style="margin-top:6px" /></div>
      <div class="field span-2"><label>Reports to <span class="opt">parent network, optional</span></label><select name="parent_network_id"><option value="">— None (top level) —</option>${parents.map((p) => `<option value="${p.id}" data-gender="${p.gender || ''}" ${Number(n?.parent_network_id) === p.id ? 'selected' : ''}>${esc(p.name)}${p.leader_name ? ' · ' + esc(p.leader_name) : ''}</option>`).join('')}</select></div>
      <div class="field span-2"><label>Notes <span class="opt">optional</span></label><textarea name="notes">${v('notes')}</textarea></div>
      ${n ? `<div class="field span-2"><label class="toggle"><input type="checkbox" name="is_active" ${n.is_active ? 'checked' : ''}/> Network is active</label></div>` : ''}
    </form>`,
    footer: `<button class="btn" data-close>Cancel</button><button class="btn btn--primary" id="saveNet">${n ? 'Save' : 'Create Network'}</button>`,
  });
  modal.querySelector('[data-close]').onclick = closeModal;
  const netGenderNow = () => modal.querySelector('[name=gender]:checked')?.value || null;
  const netHint = modal.querySelector('#netLeaderHint');
  const parentSel = modal.querySelector('[name=parent_network_id]');
  const syncNetGender = (clearLeader) => {
    const gg = netGenderNow();
    netHint.textContent = gg ? `Only ${gg} are listed — a ${gg} network is led by a ${gg === 'boys' ? 'boy' : 'girl'}.` : 'Choose Boys network or Girls network above first.';
    // parent must be the same type
    parentSel.querySelectorAll('option[data-gender]').forEach((o) => { const mismatch = gg && o.dataset.gender && o.dataset.gender !== gg; o.hidden = mismatch; o.disabled = mismatch; if (mismatch && o.selected) parentSel.value = ''; });
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

async function drawNetworks(body) {
  body.innerHTML = html`
    <p class="small muted mb-1">Networks form <b>automatically</b>: when a Lifegroup leader is a member of another leader's Lifegroup, their group goes under that leader's network. Boys and girls networks are never combined. Open a card to see leaders → members and the weekly Lifegroup grid.${can('lifegroups:manage') ? ' To override, edit a Lifegroup and pick a network by hand.' : ''}</p>
    <div id="netlist"><div class="loading">Loading…</div></div>`;
  const list = body.querySelector('#netlist');
  let nets;
  try { nets = await api.networks({ status: 'all' }); } catch (e) { list.innerHTML = html`<div class="alert alert--error">${e.message}</div>`; return; }
  if (!nets.length) {
    list.innerHTML = html`<div class="card">${emptyState({ icon: 'group', title: 'No Networks yet', text: 'Networks appear by themselves: add a Lifegroup leader as a member of another leader\'s Lifegroup and a network forms under that leader.' })}</div>`;
    return;
  }
  // order as a tree: top-level first, sub-networks right after their parent
  const byParent = new Map();
  nets.forEach((n) => { const k = n.parent_network_id && nets.some((x) => x.id === n.parent_network_id) ? n.parent_network_id : 0; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(n); });
  const rows = [];
  const walk = (pid, depth) => (byParent.get(pid) || []).forEach((n) => { rows.push({ ...n, depth }); if (depth < 6) walk(n.id, depth + 1); });
  walk(0, 0);
  const manage = can('lifegroups:manage');

  // one card — simple: who leads, how many groups / leaders / members
  const card = (n) => {
    const nested = n.child_count > 0;
    const people = nested ? n.total_people : n.people_count;
    const noun = n.gender === 'boys' ? 'boys' : n.gender === 'girls' ? 'girls' : 'members';
    return html`<a class="card net-card net-card--${n.gender || 'na'} ${n.depth ? 'net-card--sub' : ''} ${n.is_active ? '' : 'net-card--inactive'}" href="#/networks/${n.id}">
      <div class="net-card__head">
        <div class="min-w-0"><div class="net-card__name">${n.name}${n.is_active ? '' : raw(' <span class="badge badge--nodot">Inactive</span>')}${n.is_demo ? raw(' <span class="badge badge--demo badge--nodot">Demo</span>') : ''}</div>
          <div class="small muted">${n.parent_name ? html`under ${n.parent_name}` : 'Top level'}${nested ? html` · ${n.child_count} sub-network${n.child_count === 1 ? '' : 's'}` : ''}</div></div>
        ${icon('chevR', 16)}
      </div>
      <div class="net-card__leader"><span class="muted small">Network leader</span><b>${n.leader_name || raw('<span class="muted">not set</span>')}</b></div>
      <div class="net-card__stats">
        <div><b>${nested ? n.total_groups : n.group_count}</b><span>Groups</span></div>
        <div><b>${nested ? n.total_leaders : n.leader_count}</b><span>Leaders</span></div>
        <div><b>${people}</b><span>${noun}</span></div>
      </div>
      ${!n.gender ? html`<div class="net-card__warn">${icon('warn', 14)} Choose boys or girls for this Network${n.boys && n.girls ? html` — it currently holds <b>${n.boys} boys</b> and <b>${n.girls} girls</b>; move one side out first` : ''}.</div>` : ''}
      ${nested ? raw('<div class="small muted mt-1">Totals include sub-networks</div>') : ''}
    </a>`;
  };
  const section = (key, title, items, blurb) => {
    const sum = items.filter((n) => !n.depth || !items.some((x) => x.id === n.parent_network_id)).reduce((t, n) => ({ g: t.g + (n.child_count ? n.total_groups : n.group_count), p: t.p + (n.child_count ? n.total_people : n.people_count) }), { g: 0, p: 0 });
    const noun = key === 'boys' ? 'boys' : key === 'girls' ? 'girls' : 'members';
    return html`<section class="net-section net-section--${key}">
      <div class="net-section__head">
        <h2>${title} <span class="net-section__count">${items.length}</span></h2>
        <span class="small muted">${items.length ? html`${sum.g} group${sum.g === 1 ? '' : 's'} · ${sum.p} ${noun}` : blurb}</span>
      </div>
      ${items.length ? html`<div class="net-cards">${items.map(card)}</div>` : html`<div class="net-section__empty">${blurb}</div>`}
    </section>`;
  };
  const boys = rows.filter((n) => n.gender === 'boys'), girls = rows.filter((n) => n.gender === 'girls'), unset = rows.filter((n) => !n.gender);
  list.innerHTML = html`
    ${section('boys', 'Boys networks', boys, 'No boys network yet.')}
    <hr class="net-divider" />
    ${section('girls', 'Girls networks', girls, 'No girls network yet.')}
    ${unset.length ? html`<hr class="net-divider" />
      <section class="net-section net-section--na">
        <div class="net-section__head"><h2>Not set yet <span class="net-section__count">${unset.length}</span></h2><span class="small muted">These Networks were made before the boys/girls rule. ${manage ? 'Open each one and press Edit to choose.' : 'Ask an Admin to set them.'}</span></div>
        <div class="net-cards">${unset.map(card)}</div>
      </section>` : ''}`;
}

export async function renderNetwork({ main }, id) {
  const n = await api.network(id);
  const manage = can('lifegroups:manage');
  const members = n.groups.reduce((t, g) => t + g.member_count, 0);
  const boys = n.groups.reduce((t, g) => t + g.boys, 0), girls = n.groups.reduce((t, g) => t + g.girls, 0);
  const leaders = new Set(n.groups.filter((g) => g.is_active && (g.leader_person_id || g.leader_name)).map((g) => g.leader_person_id ? 'p' + g.leader_person_id : 'n' + g.leader_name)).size;
  const personLink = (p) => html`<a href="#/people/${p.id}">${fullName(p)}</a>`;

  main.innerHTML = html`
    <div class="page-header">
      <div>
        <a class="small" href="#/lifegroups?tab=networks">${icon('back', 14)} Networks</a>
        <h1 class="mt-1">${n.name}</h1>
        <div class="row mt-1">${genderBadge(n.gender, { long: true, noun: 'network' })}<span class="small muted">${n.parent_network_id ? html`Network under <a href="#/networks/${n.parent_network_id}">${n.parent_name}</a>` : 'Top-level Network'}${n.is_auto ? ' · formed automatically' : ''}</span>${n.is_active ? '' : raw('<span class="badge badge--nodot">Inactive</span>')}${n.is_demo ? raw('<span class="badge badge--demo badge--nodot">Demo data</span>') : ''}</div>
      </div>
      ${manage ? html`<div class="page-actions"><button class="btn btn--primary" id="editNet">${icon('edit')} Edit</button></div>` : ''}
    </div>

    ${!n.gender ? html`<div class="alert alert--warn mb-2">${icon('warn', 16)} This Network is not yet marked as boys or girls. ${manage ? 'Press Edit and choose one — networks are never combined.' : 'Ask an Admin to set it.'}${boys && girls ? html` It currently holds ${boys} boys and ${girls} girls; move one side to another Network first.` : ''}</div>` : ''}
    <div class="grid grid--stats mb-2" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
      <div class="card stat"><span class="stat__label">${n.gender === 'boys' ? 'Boys groups' : n.gender === 'girls' ? 'Girls groups' : 'Lifegroups'}</span><span class="stat__value">${n.group_count}${n.gender ? '' : html`<small class="muted" style="font-size:.8rem;font-weight:500"> · ${n.boys_groups} boys / ${n.girls_groups} girls</small>`}</span></div>
      <div class="card stat"><span class="stat__label">Leaders</span><span class="stat__value">${leaders}</span></div>
      <div class="card stat"><span class="stat__label">${n.gender === 'boys' ? 'Boys' : n.gender === 'girls' ? 'Girls' : 'Members'}</span><span class="stat__value">${members}</span></div>
      ${n.gender ? '' : html`<div class="card stat"><span class="stat__label">Boys · Girls</span><span class="stat__value" style="font-size:1.15rem">${boys} · ${girls}</span></div>`}
    </div>

    <div class="card mb-2">
      <div class="card__header"><h2>Structure</h2><span class="hint">Network leader → Lifegroup leaders → members</span></div>
      <div class="card__body">
        <div class="tree">
          <div class="tree__root">
            <div class="tree__node tree__node--root">
              <span class="tree__tag">Network leader</span>
              <div class="tree__who">${n.leader_person_id ? html`<a href="#/people/${n.leader_person_id}"><b>${n.leader_name}</b></a>` : n.leader_name ? html`<b>${n.leader_name}</b> <span class="small muted">(not registered)</span>` : raw('<span class="muted">No leader set yet</span>')}${n.leader_contact ? html`<span class="small muted"> · ${n.leader_contact}</span>` : ''}</div>
              <div class="small muted">${n.group_count} Lifegroup leader${n.group_count === 1 ? '' : 's'} report here${n.children.length ? html` · ${n.children.length} sub-network${n.children.length === 1 ? '' : 's'}` : ''}</div>
            </div>
            ${n.notes ? html`<div class="small muted mt-1">${n.notes}</div>` : ''}
          </div>

          ${n.children.length ? html`<div class="tree__children">${n.children.map((c) => html`<a class="tree__node tree__node--net" href="#/networks/${c.id}">
            <span class="tree__tag">Sub-network</span>
            <div class="tree__who"><b>${c.name}</b> <span class="muted">· ${c.leader_name || 'no leader'}</span></div>
            <div class="small muted">${c.total_groups} group${c.total_groups === 1 ? '' : 's'} · ${c.total_people} members · ${c.total_boys} boys / ${c.total_girls} girls</div>
          </a>`)}</div>` : ''}

          ${n.groups.length ? html`<div class="tree__children">${n.groups.map((g) => html`<details class="tree__node tree__node--group ${g.is_active ? '' : 'is-inactive'}">
            <summary>
              <div class="row row--between" style="gap:10px;flex-wrap:wrap">
                <div class="min-w-0">
                  <span class="tree__tag">Lifegroup leader · ${g.gender === 'boys' ? 'boys group' : g.gender === 'girls' ? 'girls group' : 'boys/girls not set'}</span>
                  <div class="tree__who"><b>${g.leader_name || raw('<span class="muted">No leader</span>')}</b> <span class="muted">· ${g.name}</span> ${genderBadge(g.gender)}${g.is_active ? '' : raw(' <span class="badge badge--nodot">Inactive</span>')}</div>
                  <div class="small muted">${g.member_count} member${g.member_count === 1 ? '' : 's'}${g.area ? html` · ${g.area}` : ''}${fmtSchedule(g) ? html` · ${fmtSchedule(g)}` : ''}</div>
                </div>
                <div class="tree__ratio">${ratioBar(g.boys, g.girls, g.member_count, { compact: true })}<span class="small muted">${g.boys} boys · ${g.girls} girls</span></div>
              </div>
              <span class="tree__toggle small">${icon('chevR', 14)} <span class="t-open">Show members</span><span class="t-close">Hide members</span></span>
            </summary>
            <div class="tree__members">
              <div class="row small mb-1" style="gap:10px"><a href="#/lifegroups/${g.id}">Open ${g.name} ${icon('chevR', 12)}</a>${g.leader_person_id ? html`<a href="#/people/${g.leader_person_id}">Leader profile</a>` : ''}</div>
              ${g.members.length ? html`<div class="table-wrap"><table class="table table--stack">
                <thead><tr><th>Member</th><th>Boy / Girl</th><th>Status</th><th>Role</th><th>Since</th></tr></thead>
                <tbody>${g.members.map((m) => html`<tr>
                  <td data-label=""><div class="person-cell">${raw(avatar(m, 'sm'))}<div class="person-cell__text"><a class="name" href="#/people/${m.id}">${fullName(m)}</a><div class="code">${m.person_code}</div></div></div></td>
                  <td data-label="Boy / Girl">${sexBadge(m.sex)}</td>
                  <td data-label="Status">${raw(statusBadge(m.status))}</td>
                  <td data-label="Role">${m.role === 'member' ? raw('<span class="muted">Member</span>') : html`<span class="badge badge--leader">${m.role === 'leader' ? 'Leader' : 'Assistant'}</span>`}</td>
                  <td data-label="Since" class="nowrap">${fmtDate(m.joined_at, { short: true })}</td>
                </tr>`)}</tbody></table></div>` : raw('<div class="small muted" style="padding:6px 0">No members yet.</div>')}
            </div>
          </details>`)}</div>` : html`<div class="tree__children"><div class="tree__node small muted">No Lifegroups in this Network yet.${manage ? ' Edit a Lifegroup and choose this Network.' : ''}</div></div>`}
        </div>
      </div>
    </div>

    <div class="card mb-2" id="netCalendar"></div>
    <div class="card">
      <div class="card__header"><h2>Boys &amp; girls</h2><span class="hint">current members in this Network's groups</span></div>
      <div class="card__body">
        ${ratioBar(boys, girls, members)}
        ${n.groups.length ? html`<div class="table-wrap mt-2"><table class="table table--stack">
          <thead><tr><th>Lifegroup</th><th>Leader</th><th class="num">Members</th><th class="num">Boys</th><th class="num">Girls</th><th>Ratio</th></tr></thead>
          <tbody>${n.groups.map((g) => html`<tr>
            <td data-label=""><a href="#/lifegroups/${g.id}"><b>${g.name}</b></a> ${genderBadge(g.gender)}</td>
            <td data-label="Leader">${g.leader_name || raw('<span class="muted">—</span>')}</td>
            <td data-label="Members" class="num">${g.member_count}</td><td data-label="Boys" class="num">${g.boys}</td><td data-label="Girls" class="num">${g.girls}</td>
            <td data-label="Ratio">${ratioBar(g.boys, g.girls, g.member_count, { compact: true })}</td>
          </tr>`)}</tbody>
          <tfoot><tr><td data-label="">Total</td><td data-label=""></td><td data-label="Members" class="num">${members}</td><td data-label="Boys" class="num">${boys}</td><td data-label="Girls" class="num">${girls}</td><td data-label="Ratio">${members ? html`${Math.round((boys / members) * 100)}% · ${Math.round((girls / members) * 100)}%` : '—'}</td></tr></tfoot>
        </table></div>` : ''}
        <div class="small muted mt-1">Full report with every Network and CSV export: <a href="#/reports?view=lifegroups">Reports → Lifegroups</a>.</div>
      </div>
    </div>
    ${can('people:delete') && !n.groups.length && !n.children.length ? html`<div class="row mt-3" style="padding:0 4px"><button class="btn btn--ghost small" id="delNet" style="color:var(--muted)">Delete this empty network</button></div>` : ''}`;
  renderNetworkCalendar(main.querySelector('#netCalendar'), n.id);
  main.querySelector('#editNet')?.addEventListener('click', () => networkForm(n, () => renderNetwork({ main }, id)));
  main.querySelector('#delNet')?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: `Delete ${n.name}?`, message: 'This Network has no Lifegroups or sub-networks, so it can be removed.', confirmText: 'Delete', danger: true });
    if (!ok) return;
    try { await api.deleteNetwork(n.id); toast('Network deleted.', 'info'); location.hash = '#/lifegroups?tab=networks'; } catch (e) { toast(e.message, 'error'); }
  });
}
