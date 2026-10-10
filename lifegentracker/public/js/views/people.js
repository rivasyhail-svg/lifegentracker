import { api } from '../api.js';
import { can } from '../app.js';
import { html, raw, icon, avatar, fullName, statusBadge, fmtDate, emptyState, debounce, downloadUrl, withLoading } from '../ui.js';

/**
 * People list: a searchable table with only the essentials.
 * Click a row to open the full profile.
 */
export async function renderPeople({ main, query }) {
  const filters = { q: query.q || '', status: query.status || 'active' };

  main.innerHTML = html`
    <div class="page-header">
      <div><h1>People</h1></div>
      <div class="page-actions">
        ${can('reports:view') ? html`<button class="btn" id="exportPeople" title="Download as CSV">${icon('download')} Export</button>` : ''}
        ${can('people:write') ? html`<a class="btn btn--primary" href="#/people/new">${icon('plus')} Add person</a>` : ''}
      </div>
    </div>
    <div class="toolbar">
      <div class="gsearch grow" style="max-width:none">
        ${icon('search', 17)}
        <input type="search" id="q" placeholder="Search by name, Person ID or contact number" value="${filters.q}" autocomplete="off" />
      </div>
      <select id="status" style="width:auto;min-width:150px" aria-label="Show">
        <option value="active">Active</option>
        <option value="first_timer">First timers</option>
        <option value="inactive">Inactive</option>
        <option value="all">Everyone</option>
        <option value="archived">Archived</option>
      </select>
    </div>
    <div class="card"><div id="list" class="card__body--flush"><div class="loading">Loading…</div></div></div>`;

  main.querySelector('#status').value = filters.status;
  main.querySelector('#exportPeople')?.addEventListener('click', () => downloadUrl('/api/reports/export/people.csv'));

  const list = main.querySelector('#list');
  let reqId = 0;
  const PAGE = 100; // rows per page — keeps the first paint fast on large lists

  async function load(offset = 0, previous = []) {
    const id = ++reqId;
    history.replaceState(null, '', '#/people' + api.qs({ q: filters.q, status: filters.status === 'active' ? '' : filters.status }));
    if (!offset) list.innerHTML = '<div class="loading">Loading…</div>';
    let page;
    try { page = await api.people({ ...filters, paged: 1, limit: PAGE, offset }); }
    catch (err) { list.innerHTML = html`<div class="alert alert--error" style="margin:16px">${err.message}</div>`; return; }
    if (id !== reqId) return;
    const people = previous.concat(page.rows);

    if (!people.length) {
      const filtered = filters.q || filters.status !== 'active';
      list.innerHTML = emptyState({
        icon: 'people',
        title: filtered ? 'No one matches' : 'No one is registered yet',
        text: filtered ? 'Try a different name or clear the search.' : 'Add the first person to start tracking Lifegen attendance.',
        action: filtered ? '<button class="btn" id="clearFilters">Clear search</button>' : (can('people:write') ? '<a class="btn btn--primary" href="#/people/new">Add person</a>' : ''),
      });
      list.querySelector('#clearFilters')?.addEventListener('click', () => { location.hash = '#/people'; renderPeople({ main, query: {} }); });
      return;
    }

    list.innerHTML = html`
      <div class="table-wrap"><table class="table table--stack table--people">
        <thead><tr><th>Name</th><th>Status</th><th>Last attendance</th></tr></thead>
        <tbody>
          ${people.map((p) => html`<tr class="clickable" data-id="${p.id}">
            <td data-label=""><div class="person-cell">${raw(avatar(p, 'sm'))}<div class="person-cell__text"><div class="name">${fullName(p)}</div><div class="code">${p.person_code}</div></div></div></td>
            <td data-label="Status">${p.archived_at ? raw('<span class="badge badge--nodot">Archived</span> ') : ''}${raw(statusBadge(p.status))}${p.is_demo ? raw(' <span class="badge badge--demo badge--nodot">Demo</span>') : ''}</td>
            <td data-label="Last attendance">${p.last_attended ? fmtDate(p.last_attended, { short: true }) : raw('<span class="muted">—</span>')}</td>
          </tr>`)}
        </tbody>
      </table></div>
      <div class="card__footer small muted row row--between">
        <span>Showing ${people.length} of ${page.total} ${page.total === 1 ? 'person' : 'people'}</span>
        ${page.has_more ? html`<button class="btn btn--sm" id="loadMore">Load more</button>` : ''}
      </div>`;
    list.querySelectorAll('tr.clickable').forEach((tr) => { tr.onclick = () => { location.hash = `#/people/${tr.dataset.id}`; }; });
    list.querySelector('#loadMore')?.addEventListener('click', (e) => withLoading(e.currentTarget, () => load(people.length, people)));
  }

  main.querySelector('#q').addEventListener('input', debounce((e) => { filters.q = e.target.value.trim(); load(); }, 250));
  main.querySelector('#status').onchange = (e) => { filters.status = e.target.value; load(); };
  load();
}
