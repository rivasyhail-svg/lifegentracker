import { api } from '../api.js';
import { state, can } from '../app.js';
import { html, raw, icon, toast, confirmDialog, openModal, closeModal, withLoading, formData, fmtDateTime, ROLE_LABELS } from '../ui.js';
import { renderQrCard } from './registrations.js';

export async function renderSettings({ main }) {
  const admin = can('users:manage');
  main.innerHTML = html`
    <div class="page-header"><div><h1>Settings</h1><p class="sub">Your account${admin ? ', users, church details and data' : ''}.</p></div></div>
    ${state.authDisabled ? html`<div class="alert alert--warn mb-2">${icon('warn', 18)}<span><b>Sign-in is currently turned off</b> (open access mode). Everyone who opens this site is treated as Admin. Before using LifegenTracker with real church records, start the server with <code>LIFEGEN_AUTH=on</code> to require sign-in.</span></div>` : ''}
    <div class="grid grid--2" style="align-items:start">
      <div class="stack">
        <div class="card" id="accountCard"></div>
        ${admin ? raw('<div class="card" id="churchCard"></div>') : ''}
        ${admin ? raw('<div class="card" id="rulesCard"></div>') : ''}
        ${admin ? raw('<div class="card" id="qrCard"></div>') : ''}
        ${admin ? raw('<div class="card" id="backupCard"></div>') : ''}
        ${admin ? raw('<div class="card" id="demoCard"></div>') : ''}
      </div>
      <div class="stack">
        ${admin ? raw('<div class="card" id="usersCard"></div>') : ''}
        <div class="card" id="rolesCard"></div>
        ${admin ? raw('<div class="card" id="systemCard"></div>') : ''}
        ${admin ? raw('<div class="card" id="activityCard"></div>') : ''}
      </div>
    </div>`;

  // ----- Account -------------------------------------------------------------
  const acc = main.querySelector('#accountCard');
  acc.innerHTML = html`
    <div class="card__header"><h2>Security · my account</h2><span class="badge badge--${state.user.role_id}">${ROLE_LABELS[state.user.role_id]}</span></div>
    <div class="card__body">
      <p class="mb-2">Signed in as <b>${state.user.display_name}</b> (<span class="mono">${state.user.username}</span>).</p>
      ${state.standalone ? '' : html`<div class="row row--between mb-2" style="gap:10px;flex-wrap:wrap"><span class="small muted">Sessions expire after 30 days of inactivity and are stored only as hashed tokens on the server. Passwords are stored hashed (scrypt) — never in the page, the QR or the URL.</span><button class="btn btn--sm" id="signOutBtn">${icon('logout', 14)} Sign out</button></div>`}
      <form id="pwForm" class="form-grid" novalidate>
        <div class="field span-2"><label>Current password</label><input name="current_password" type="password" autocomplete="current-password" required /></div>
        <div class="field"><label>New password</label><input name="new_password" type="password" autocomplete="new-password" required /><span class="help">At least 8 characters.</span></div>
        <div class="field"><label>Confirm new password</label><input name="confirm" type="password" autocomplete="new-password" required /></div>
        <div class="span-2 form-actions"><button class="btn btn--primary" type="submit">Change password</button></div>
      </form>
    </div>`;
  acc.querySelector('#signOutBtn')?.addEventListener('click', () => document.getElementById('logoutBtn')?.click());
  acc.querySelector('#pwForm').onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    if (d.new_password !== d.confirm) return toast('New passwords do not match.', 'error');
    await withLoading(e.target.querySelector('button'), async () => {
      try { await api.changePassword(d.current_password, d.new_password); toast('Password changed.'); e.target.reset(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };

  // ----- Roles reference -----------------------------------------------------
  main.querySelector('#rolesCard').innerHTML = html`
    <div class="card__header"><h2>Roles &amp; access</h2></div>
    <div class="card__body card__body--flush"><table class="table">
      <thead><tr><th>Role</th><th>Can do</th></tr></thead>
      <tbody>
        <tr><td><span class="badge badge--admin">Admin</span></td><td class="small">Everything: people, attendance, reports, users, settings, demo data, permanent deletion.</td></tr>
        <tr><td><span class="badge badge--staff">Attendance Staff</span></td><td class="small">Register and edit people, record Lifegen attendance, view dashboards and reports.</td></tr>
        <tr><td><span class="badge badge--viewer">Viewer / Leader</span></td><td class="small">View dashboards, reports, people and attendance history. Contact details, birthdays and notes are hidden. No edits.</td></tr>
      </tbody></table></div>`;

  if (!admin) return;

  // ----- Church details ------------------------------------------------------
  const church = main.querySelector('#churchCard');
  church.innerHTML = html`
    <div class="card__header"><h2>Church details</h2></div>
    <div class="card__body"><form id="churchForm" class="form-grid" novalidate>
      <div class="field span-2"><label>Church name</label><input name="church_name" value="${state.settings.church_name}" required /></div>
      <div class="field span-2"><label>Service name</label><input name="service_name" value="${state.settings.service_name}" required /><span class="help">Shown on the dashboard, attendance page and exports.</span></div>
      <div class="field span-2"><label>Church address <span class="opt">optional</span></label><input name="church_address" value="${state.settings.church_address || ''}" autocomplete="off" placeholder="Street, barangay, city" /></div>
      <div class="field"><label>Church contact <span class="opt">optional</span></label><input name="church_contact" value="${state.settings.church_contact || ''}" autocomplete="off" placeholder="Phone or email" /></div>
      <div class="field"><label>Data privacy contact <span class="opt">optional</span></label><input name="privacy_contact" value="${state.settings.privacy_contact || ''}" autocomplete="off" placeholder="Name · email / phone" /><span class="help">Who members can ask about their data. Shown on the <a href="#/privacy">Privacy &amp; Terms</a> page.</span></div>
      <div class="span-2 form-actions"><button class="btn btn--primary" type="submit">Save</button></div>
    </form></div>`;
  church.querySelector('#churchForm').onsubmit = async (e) => {
    e.preventDefault();
    await withLoading(e.target.querySelector('button'), async () => {
      try {
        const s = await api.saveSettings(formData(e.target));
        Object.assign(state.settings, s);
        document.querySelector('.sidebar .brand__text small').textContent = s.church_name;
        toast('Church details saved.');
      } catch (err) { toast(err.message, 'error'); }
    });
  };

  // ----- Attendance & Lifegroup rules ---------------------------------------
  const rules = main.querySelector('#rulesCard');
  const lockOn = state.settings.attendance_sunday_lock !== '0';
  rules.innerHTML = html`
    <div class="card__header"><h2>Attendance &amp; Lifegroup rules</h2></div>
    <div class="card__body"><form id="rulesForm" class="form-grid" novalidate>
      <div class="field span-2"><label class="toggle"><input type="checkbox" name="attendance_sunday_lock" ${lockOn ? 'checked' : ''} ${state.standalone ? 'disabled' : ''} /> Sunday-only attendance marking${state.standalone ? ' <span class="badge badge--nodot">Server only</span>' : ''}</label>
        <span class="help">On: PRESENT can be tapped only on the actual Sunday (Philippine time). Past Sundays can be corrected by <b>Admins only</b>, and every correction asks for a reason that is kept in the audit log. Off: staff may mark any Sunday.</span></div>
      <div class="field"><label>Solid Lifegroup target</label><input name="lifegroup_solid_target" type="number" min="1" max="50" value="${state.settings.lifegroup_solid_target || '6'}" required /><span class="help">A Lifegroup counts as <b>solid</b> once it has this many members tagged Solid.</span></div>
      <div class="span-2 form-actions"><button class="btn btn--primary" type="submit">Save</button></div>
    </form></div>`;
  rules.querySelector('#rulesForm').onsubmit = async (e) => {
    e.preventDefault();
    await withLoading(e.target.querySelector('button[type=submit]'), async () => {
      try {
        const s = await api.saveSettings({ attendance_sunday_lock: e.target.attendance_sunday_lock.checked ? '1' : '0', lifegroup_solid_target: e.target.lifegroup_solid_target.value.trim() });
        Object.assign(state.settings, s);
        toast('Rules saved.');
      } catch (err) { toast(err.message, 'error'); }
    });
  };

  // ----- QR self-registration ------------------------------------------------
  const qrCard = main.querySelector('#qrCard');
  if (state.standalone) {
    qrCard.innerHTML = html`
      <div class="card__header"><h2>QR registration</h2><span class="badge badge--nodot">Server only</span></div>
      <div class="card__body stack">
        <p class="small">QR self-registration lets visitors register from their own phones. That needs the <b>server deployment</b> (Node.js + SQLite) so every phone writes to one shared database.</p>
        <p class="small muted">This standalone build stores data only in this browser, so it cannot receive registrations from other devices — the feature is not offered here to avoid pretending otherwise. Run <code>node server.js</code> (see README) to use it.</p>
      </div>`;
  } else {
    renderQrCard(qrCard);
    if (location.hash.includes('section=qr')) setTimeout(() => qrCard.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }

  // ----- Users ---------------------------------------------------------------
  const usersCard = main.querySelector('#usersCard');
  async function drawUsers() {
    const users = await api.users();
    usersCard.innerHTML = html`
      <div class="card__header"><h2>Users</h2><button class="btn btn--sm btn--primary" id="addUser">${icon('plus')} Add user</button></div>
      <div class="card__body card__body--flush"><div class="table-wrap"><table class="table table--stack">
        <thead><tr><th>User</th><th>Role</th><th>Last sign-in</th><th></th></tr></thead>
        <tbody>${users.map((u) => html`<tr>
          <td data-label="User"><b>${u.display_name}</b>${u.is_active ? '' : raw(' <span class="badge badge--inactive">Deactivated</span>')}<br><span class="small muted"><span class="mono">${u.username}</span>${u.email ? ` · ${u.email}` : ''}</span></td>
          <td data-label="Role"><span class="badge badge--${u.role_id}">${u.role_name}</span></td>
          <td data-label="Last sign-in" class="small muted">${u.last_login_at ? fmtDateTime(u.last_login_at) : 'Never'}</td>
          <td class="actions"><button class="btn btn--sm btn--ghost" data-edit="${u.id}">Edit</button></td>
        </tr>`)}</tbody></table></div></div>`;
    usersCard.querySelector('#addUser').onclick = () => userModal(null);
    usersCard.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => userModal(users.find((u) => u.id === Number(b.dataset.edit)))));
  }

  function userModal(u) {
    const isSelf = u && u.id === state.user.id;
    const modal = openModal({
      title: u ? `Edit ${u.display_name}` : 'Add user',
      subtitle: u ? `@${u.username}` : 'Create an account for a staff member or leader.',
      body: `<form id="userForm" class="form-grid" novalidate>
        ${u ? '' : '<div class="field"><label>Username <span class="req">*</span></label><input name="username" autocomplete="off" required /></div>'}
        <div class="field"><label>Display name <span class="req">*</span></label><input name="display_name" value="${u ? u.display_name.replace(/"/g, '&quot;') : ''}" required /></div>
        <div class="field"><label>Email <span class="opt">optional</span></label><input name="email" type="email" value="${u && u.email ? u.email.replace(/"/g, '&quot;') : ''}" autocomplete="off" /></div>
        <div class="field"><label>Role <span class="req">*</span></label><select name="role_id" ${isSelf ? 'disabled' : ''}>${Object.entries(ROLE_LABELS).map(([k, l]) => `<option value="${k}" ${(u ? u.role_id : 'staff') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label>${u ? 'New password' : 'Password'} ${u ? '<span class="opt">leave blank to keep</span>' : '<span class="req">*</span>'}</label><input name="password" type="password" autocomplete="new-password" /><span class="help">At least 8 characters.</span></div>
        ${u && !isSelf ? `<div class="field span-2"><label class="toggle"><input type="checkbox" name="is_active" ${u.is_active ? 'checked' : ''}/> Account is active</label><span class="help">Deactivated users are signed out immediately and cannot sign in.</span></div>` : ''}
      </form>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn btn--primary" id="saveUser">${u ? 'Save' : 'Create user'}</button>`,
    });
    modal.querySelector('[data-close]').onclick = closeModal;
    const save = (e) => withLoading(modal.querySelector('#saveUser'), async () => {
      e.preventDefault();
      const form = modal.querySelector('#userForm');
      const d = formData(form);
      if (u && !isSelf) d.is_active = form.querySelector('[name=is_active]').checked;
      if (!d.password) delete d.password;
      try {
        if (u) await api.updateUser(u.id, d); else await api.createUser(d);
        closeModal(); toast(u ? 'User updated.' : 'User created.'); drawUsers();
      } catch (err) { toast(err.message, 'error'); }
    });
    modal.querySelector('#saveUser').onclick = save;
    modal.querySelector('#userForm').onsubmit = save;
  }
  drawUsers();

  // ----- Demo data -----------------------------------------------------------
  const demoCard = main.querySelector('#demoCard');
  async function drawDemo() {
    const d = await api.demoStatus();
    state.demoLoaded = d.loaded;
    demoCard.innerHTML = html`
      <div class="card__header"><h2>Sample / demo data</h2>${d.loaded ? raw('<span class="badge badge--demo">Loaded</span>') : ''}</div>
      <div class="card__body">
        <p class="small muted mb-2">Load clearly-labelled sample records (“Demo Person 01…24” across the last 10 Sundays) to explore the dashboard and reports before real registrations begin. Demo records are tagged and can be removed completely at any time. Do not mix demo data with live church records.</p>
        ${d.loaded
          ? html`<div class="row"><span class="small">${d.people} demo people · ${d.services} demo Sundays</span><button class="btn btn--danger-ghost" id="demoRemove" style="margin-left:auto">${icon('trash')} Remove demo data</button></div>`
          : html`<button class="btn" id="demoLoad">Load demo data</button>`}
      </div>`;
    demoCard.querySelector('#demoLoad')?.addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
      try { await api.demoLoad(); toast('Demo data loaded. A banner will show on the dashboard while it is present.'); drawDemo(); } catch (err) { toast(err.message, 'error'); }
    }));
    demoCard.querySelector('#demoRemove')?.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Remove all demo data?', message: 'All “Demo Person” records, their attendance and demo-only Sundays will be deleted. Real records are not affected.', confirmText: 'Remove demo data', danger: true });
      if (!ok) return;
      try { await api.demoRemove(); toast('Demo data removed.', 'info'); drawDemo(); } catch (err) { toast(err.message, 'error'); }
    });
  }
  drawDemo();

  // ----- Backup & restore ----------------------------------------------------
  const backupCard = main.querySelector('#backupCard');
  async function drawBackup() {
    let snaps = { snapshots: [] };
    try { snaps = await api.backupSnapshots(); } catch (e) { /* shown below */ }
    const last = snaps.snapshots[0];
    backupCard.innerHTML = html`
      <div class="card__header"><h2>Backup &amp; restore</h2>${last ? html`<span class="hint">Last snapshot ${fmtDateTime(last.created_at)}</span>` : ''}</div>
      <div class="card__body">
        <p class="small muted mb-2">The server keeps an automatic daily copy of the database (last 14 kept in <span class="mono">data/backups/</span>). Download a backup file before major changes and keep it somewhere safe (e.g. Google Drive).</p>
        <div class="row" style="flex-wrap:wrap;gap:8px">
          <button class="btn btn--primary" id="backupDownload">${icon('download')} Download backup</button>
          ${snaps.supported === false ? html`<span class="small muted">Hosted database — file snapshots are kept by the database provider; download the JSON backup regularly.</span>` : html`<button class="btn" id="backupSnapshot">Snapshot now</button>`}
          <button class="btn btn--danger-ghost" id="backupRestore" style="margin-left:auto">${icon('upload')} Restore from file…</button>
          <input type="file" id="restoreInput" accept="application/json,.json" hidden />
        </div>
        ${snaps.snapshots.length ? html`<details class="mt-2 small"><summary class="muted">${snaps.snapshots.length} snapshot file${snaps.snapshots.length === 1 ? '' : 's'} on the server</summary>
          <ul class="mt-1" style="margin-left:18px">${snaps.snapshots.slice(0, 14).map((f) => html`<li><span class="mono">${f.file}</span> · ${Math.round(f.size / 1024)} KB</li>`)}</ul></details>` : ''}
      </div>`;
    backupCard.querySelector('#backupDownload').onclick = (e) => withLoading(e.currentTarget, async () => {
      try {
        const data = await api.backup();
        const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `lifegentracker-backup-${data.exported_at.slice(0, 10)}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        toast(`Backup downloaded (${data.counts.people} people, ${data.counts.attendance_records} attendance records).`);
      } catch (err) { toast(err.message, 'error'); }
    });
    if (backupCard.querySelector("#backupSnapshot")) backupCard.querySelector("#backupSnapshot").onclick = (e) => withLoading(e.currentTarget, async () => {
      try { const r = await api.backupSnapshot(); toast(`Snapshot saved: ${r.file}`); drawBackup(); } catch (err) { toast(err.message, 'error'); }
    });
    const input = backupCard.querySelector('#restoreInput');
    backupCard.querySelector('#backupRestore').onclick = () => { input.value = ''; input.click(); };
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      let data;
      try { data = JSON.parse((await file.text()).replace(/^\uFEFF/, '')); }
      catch (e) { return toast('That file is not a valid backup (not JSON).', 'error'); }
      if (!data || data.format !== 'lifegentracker-backup' || !data.tables) return toast('That file is not a LifegenTracker backup.', 'error');
      const c = data.counts || {};
      const ok = await confirmDialog({
        title: 'Replace ALL data with this backup?',
        message: `Backup from <b>${fmtDateTime(data.exported_at)}</b>: ${c.people ?? '?'} people, ${c.services ?? '?'} Sundays, ${c.attendance_records ?? '?'} attendance records.<br><br>Everything currently in the database will be replaced. A snapshot of the current database is saved first, and the restore is all-or-nothing.`,
        confirmText: 'Restore backup', danger: true, confirmWord: 'RESTORE',
      });
      if (!ok) return;
      await withLoading(backupCard.querySelector('#backupRestore'), async () => {
        try {
          const r = await api.restoreBackup(data);
          toast(`Restored: ${r.counts.people} people, ${r.counts.attendance_records} attendance records.`, 'success', 6000);
          setTimeout(() => location.reload(), 800);
        } catch (err) { toast(err.message, 'error', 7000); }
      });
    };
  }
  drawBackup();

  // ----- Activity log --------------------------------------------------------
  const actCard = main.querySelector('#activityCard');
  async function drawActivity() {
    let rows = [];
    try { rows = await api.activity({ limit: 60 }); } catch (e) { actCard.innerHTML = html`<div class="card__body alert alert--error">${e.message}</div>`; return; }
    actCard.innerHTML = html`
      <div class="card__header"><h2>Activity log</h2><span class="hint">Latest ${rows.length}</span></div>
      <div class="card__body card__body--flush">
        ${rows.length ? html`<ul class="activity">${rows.map((r) => html`<li>
            <span class="activity__when small muted">${fmtDateTime(r.created_at)}</span>
            <span class="activity__text">${r.summary || r.action}</span>
            <span class="activity__who small muted">${r.user_name || 'system'} · <span class="mono">${r.action}</span></span>
          </li>`)}</ul>` : html`<div class="empty" style="padding:28px"><p>No activity recorded yet.</p></div>`}
      </div>`;
  }
  drawActivity();

  // ----- System --------------------------------------------------------------
  const sys = await api.system();
  main.querySelector('#systemCard').innerHTML = html`
    <div class="card__header"><h2>System</h2><span class="hint">LifegenTracker v1 · Phase 1</span></div>
    <div class="card__body">
      <dl class="dl">
        <div><dt>People</dt><dd>${sys.counts.people}</dd></div>
        <div><dt>Sundays</dt><dd>${sys.counts.services}</dd></div>
        <div><dt>Attendance records</dt><dd>${sys.counts.attendance_records}</dd></div>
        <div><dt>Users</dt><dd>${sys.counts.users}</dd></div>
        <div><dt>Archived people</dt><dd>${sys.counts.archived ?? 0}</dd></div>
        <div><dt>Sign-in</dt><dd>${sys.auth_disabled ? raw('<span style="color:#b45309">Off (open access)</span>') : 'On'}</dd></div>
        <div style="grid-column:1/-1"><dt>Database file</dt><dd class="small mono" style="word-break:break-all">${sys.db_file}</dd></div>
        <div style="grid-column:1/-1"><dt>Schema migrations</dt><dd class="small">${sys.migrations.map((m) => m.version).join(', ')}</dd></div>
      </dl>
      <p class="small muted mt-2">Future phases (Cell Groups, LifeClass, Discipleship, Ministries) will be added as new migrations without rebuilding existing data.</p>
    </div>`;
}
