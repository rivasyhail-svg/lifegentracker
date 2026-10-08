'use strict';
/**
 * API integration tests. Starts a private server on a temp database with
 * sign-in ON so permissions are exercised for real.
 *   node tests/api.test.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 3456;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-test-'));
const DB = path.join(tmp, 'test.db');
const root = path.join(__dirname, '..');
const H = { 'X-Requested-With': 'LifegenTracker', 'Content-Type': 'application/json' };

let server;
const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); console.log('  ok   ' + name); }
  catch (e) { results.push([false, name, e]); console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').filter((l) => !l.includes('node:internal')).slice(0, 4).join(' | ')); }
}

async function call(method, url, { body, token, headers = {}, raw = false } = {}) {
  const h = { ...H, ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const ct = res.headers.get('content-type') || '';
  const data = raw ? await res.text() : ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch (e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

function sundayOffset(weeks) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay() - weeks * 7);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

(async () => {
  const env = { ...process.env, PORT: String(PORT), LIFEGEN_AUTH: 'on', LIFEGEN_DB_FILE: DB, LIFEGEN_AUTO_BACKUP: 'off', LIFEGEN_RATE_LIMIT_SUBMIT: '100' };
  if (/^postgres/.test(process.env.LIFEGEN_DB_URL || '')) {
    // Postgres mode (LIFEGEN_DB_URL=postgres://...): start from an empty schema every run.
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.LIFEGEN_DB_URL, ssl: /localhost|127\.0\.0\.1|host=\//.test(process.env.LIFEGEN_DB_URL) ? false : { rejectUnauthorized: false } });
    await c.connect(); await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await c.end();
    console.log('Running against Postgres:', process.env.LIFEGEN_DB_URL.replace(/:\/\/[^@]*@/, '://***@'));
  }
  if (!fs.existsSync(path.join(root, 'node_modules')) && fs.existsSync(path.join(root, 'vendor'))) env.NODE_PATH = path.join(root, 'vendor');
  server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await waitUp();

  let admin, staff, viewer;
  let personId, dupId, serviceId;
  const S0 = sundayOffset(0), S1 = sundayOffset(1);

  console.log('\nAuth & security');
  await test('first-run setup creates the admin', async () => {
    const r = await call('POST', '/api/auth/setup', { body: { username: 'admin1', display_name: 'Admin', password: 'Password123' } });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
    admin = r.data.token || (await call('POST', '/api/auth/login', { body: { username: 'admin1', password: 'Password123' } })).data.token;
    assert.ok(admin, 'token');
  });
  await test('rejects state-changing calls without X-Requested-With (CSRF)', async () => {
    const r = await fetch(BASE + '/api/people', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` }, body: '{}' });
    assert.strictEqual(r.status, 403);
  });
  await test('unauthenticated request is 401 with JSON error', async () => {
    const r = await call('GET', '/api/people');
    assert.strictEqual(r.status, 401); assert.ok(r.data.error);
  });
  await test('security headers present (CSP, nosniff, no-store)', async () => {
    const r = await fetch(BASE + '/');
    assert.ok(r.headers.get('content-security-policy').includes("default-src 'self'"));
    assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
  });
  await test('admin can create staff and viewer users', async () => {
    let r = await call('POST', '/api/users', { token: admin, body: { username: 'staff1', display_name: 'Staff', password: 'Password123', role_id: 'staff' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    r = await call('POST', '/api/users', { token: admin, body: { username: 'viewer1', display_name: 'Viewer', password: 'Password123', role_id: 'viewer' } });
    assert.strictEqual(r.status, 201);
    staff = (await call('POST', '/api/auth/login', { body: { username: 'staff1', password: 'Password123' } })).data.token;
    viewer = (await call('POST', '/api/auth/login', { body: { username: 'viewer1', password: 'Password123' } })).data.token;
    assert.ok(staff && viewer);
  });
  await test('login throttle locks after repeated failures', async () => {
    let last;
    for (let i = 0; i < 7; i++) last = await call('POST', '/api/auth/login', { body: { username: 'nobody', password: 'wrong-pass-1' } });
    assert.strictEqual(last.status, 429);
  });

  console.log('\nPeople');
  await test('validation: missing required fields → 400 with details', async () => {
    const r = await call('POST', '/api/people', { token: staff, body: { first_name: 'A' } });
    assert.strictEqual(r.status, 400); assert.ok(Array.isArray(r.data.details));
  });
  await test('staff registers a person; ID is LG-YYYY-NNNN', async () => {
    const r = await call('POST', '/api/people', { token: staff, body: { first_name: 'Juan', last_name: 'Dela Cruz', sex: 'male', contact_number: '0917 123 4567', status: 'first_timer', email: 'juan@example.com' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    assert.match(r.data.person_code, /^LG-\d{4}-\d{4}$/);
    personId = r.data.id;
  });
  await test('duplicate check finds same contact / same name / same email', async () => {
    let r = await call('GET', '/api/people/duplicates?first_name=juan&last_name=dela%20cruz&contact_number=09171234567', { token: staff });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.matches.length, 1);
    assert.ok(r.data.matches[0].reasons.includes('same contact number'));
    assert.ok(r.data.matches[0].reasons.includes('same name'));
    r = await call('GET', '/api/people/duplicates?email=JUAN@example.com', { token: staff });
    assert.strictEqual(r.data.matches.length, 1);
    r = await call('GET', '/api/people/duplicates?first_name=Maria&last_name=Santos&contact_number=09990000000', { token: staff });
    assert.strictEqual(r.data.matches.length, 0);
  });
  await test('duplicate check excludes the record being edited', async () => {
    const r = await call('GET', `/api/people/duplicates?first_name=Juan&last_name=Dela%20Cruz&exclude_id=${personId}`, { token: staff });
    assert.strictEqual(r.data.matches.length, 0);
  });
  await test('saving a possible duplicate is still allowed (authorised override)', async () => {
    const r = await call('POST', '/api/people', { token: staff, body: { first_name: 'Juan', last_name: 'Dela Cruz', sex: 'male', contact_number: '0917 123 4567', status: 'regular' } });
    assert.strictEqual(r.status, 201); dupId = r.data.id;
  });
  await test('invalid ids → 400 (not 500)', async () => {
    for (const u of ['/api/people/abc', '/api/people/-1', '/api/people/1.5', '/api/services/abc']) {
      const r = await call('GET', u, { token: admin });
      assert.strictEqual(r.status, 400, u + ' ' + r.status);
    }
  });
  await test('unknown id → 404', async () => {
    const r = await call('GET', '/api/people/999999', { token: admin });
    assert.strictEqual(r.status, 404);
  });
  await test('viewer cannot see private fields or write', async () => {
    let r = await call('GET', `/api/people/${personId}`, { token: viewer });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.data.contact_number, undefined); assert.ok(r.data.private_hidden);
    r = await call('POST', '/api/people', { token: viewer, body: { first_name: 'X', last_name: 'Y', contact_number: '09171234567', status: 'regular' } });
    assert.strictEqual(r.status, 403);
    r = await call('POST', `/api/people/${personId}/archive`, { token: viewer });
    assert.strictEqual(r.status, 403);
  });
  await test('paged list returns total/has_more; archived excluded by default', async () => {
    const r = await call('GET', '/api/people?paged=1&limit=1', { token: staff });
    assert.strictEqual(r.data.rows.length, 1); assert.strictEqual(r.data.total, 2); assert.strictEqual(r.data.has_more, true);
  });

  console.log('\nAttendance integrity');
  await test('non-Sunday is rejected', async () => {
    const r = await call('POST', '/api/services', { token: staff, body: { service_date: '2026-10-05' } });
    assert.strictEqual(r.status, 400);
  });
  await test('open a Sunday (idempotent) and mark present → first_timer', async () => {
    let r = await call('POST', '/api/services', { token: staff, body: { service_date: S1 } });
    assert.ok([200, 201].includes(r.status)); serviceId = r.data.id;
    r = await call('POST', '/api/services', { token: staff, body: { service_date: S1 } });
    assert.strictEqual(r.data.id, serviceId, 'same service reused');
    r = await call('PUT', `/api/services/${serviceId}/records/${personId}`, { token: staff, body: { status: 'present' } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.data.record.classification, 'first_timer'); assert.strictEqual(r.data.already_marked, false);
    assert.strictEqual(r.data.summary.present_count, 1);
  });
  await test('marking the same person twice does not double count or re-audit', async () => {
    const before = (await call('GET', `/api/services/${serviceId}/audit`, { token: staff })).data.length;
    const r = await call('PUT', `/api/services/${serviceId}/records/${personId}`, { token: staff, body: { status: 'present' } });
    assert.strictEqual(r.data.already_marked, true);
    assert.strictEqual(r.data.summary.present_count, 1);
    const after = (await call('GET', `/api/services/${serviceId}/audit`, { token: staff })).data.length;
    assert.strictEqual(after, before);
  });
  await test('parallel double-tap (10 concurrent marks) still yields one record', async () => {
    const r2 = await call('POST', '/api/services', { token: staff, body: { service_date: S0 } });
    const sid = r2.data.id;
    const all = await Promise.all(Array.from({ length: 10 }, () => call('PUT', `/api/services/${sid}/records/${dupId}`, { token: staff, body: { status: 'present' } })));
    assert.ok(all.every((x) => x.status === 200));
    const svc = (await call('GET', `/api/services/${sid}`, { token: staff })).data;
    assert.strictEqual(svc.present_count, 1);
    assert.strictEqual(svc.roster.filter((p) => p.id === dupId && p.att_status === 'present').length, 1);
  });
  await test('second Sunday auto-classifies as returning; undo is audited and reversible', async () => {
    const sid = (await call('GET', `/api/services/by-date/${S0}`, { token: staff })).data.service.id;
    let r = await call('PUT', `/api/services/${sid}/records/${personId}`, { token: staff, body: { status: 'present' } });
    assert.strictEqual(r.data.record.classification, 'returning');
    r = await call('DELETE', `/api/services/${sid}/records/${personId}`, { token: staff });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.data.summary.present_count, 1);
    const audit = (await call('GET', `/api/services/${sid}/audit`, { token: staff })).data;
    assert.ok(audit.some((a) => a.action === 'undo' && a.person_id === personId));
  });
  await test('viewer cannot mark attendance', async () => {
    const r = await call('PUT', `/api/services/${serviceId}/records/${personId}`, { token: viewer, body: { status: 'present' } });
    assert.strictEqual(r.status, 403);
  });
  await test('a Sunday with records cannot be deleted', async () => {
    const r = await call('DELETE', `/api/services/${serviceId}`, { token: admin });
    assert.strictEqual(r.status, 409);
  });

  console.log('\nArchive & activity');
  await test('archive hides from list/roster/search but keeps history and totals', async () => {
    let r = await call('POST', `/api/people/${personId}/archive`, { token: staff });
    assert.strictEqual(r.status, 200); assert.ok(r.data.archived_at);
    const list = (await call('GET', '/api/people?status=all', { token: staff })).data;
    assert.ok(!list.some((p) => p.id === personId));
    const arch = (await call('GET', '/api/people?status=archived', { token: staff })).data;
    assert.ok(arch.some((p) => p.id === personId));
    const search = (await call('GET', '/api/search?q=Juan', { token: staff })).data.people;
    assert.ok(!search.some((p) => p.id === personId));
    const svc = (await call('GET', `/api/services/${serviceId}`, { token: staff })).data;
    assert.strictEqual(svc.present_count, 1, 'past total unchanged');
    assert.ok(svc.roster.some((p) => p.id === personId && p.att_status === 'present'), 'still visible on the Sunday they attended');
    const s0 = (await call('GET', `/api/services/by-date/${S0}`, { token: staff })).data.service;
    const roster0 = (await call('GET', `/api/services/${s0.id}`, { token: staff })).data.roster;
    assert.ok(!roster0.some((p) => p.id === personId), 'not on a roster where they have no record');
  });
  await test('restore brings the person back', async () => {
    const r = await call('POST', `/api/people/${personId}/restore`, { token: staff });
    assert.strictEqual(r.data.archived_at, null);
    const list = (await call('GET', '/api/people', { token: staff })).data;
    assert.ok(list.some((p) => p.id === personId));
  });
  await test('activity log records person + attendance actions; admin only', async () => {
    const r = await call('GET', '/api/activity', { token: admin });
    assert.strictEqual(r.status, 200);
    const actions = r.data.map((a) => a.action);
    for (const a of ['person.create', 'person.archive', 'person.restore', 'user.create', 'attendance.mark', 'attendance.undo']) assert.ok(actions.includes(a), a);
    assert.strictEqual((await call('GET', '/api/activity', { token: staff })).status, 403);
  });

  console.log('\nLifegroups');
  let groupA, groupB;
  await test('staff creates groups (leader = registered person); viewer cannot', async () => {
    let r = await call('POST', '/api/lifegroups', { token: staff, body: { name: 'Joshua Group', gender: 'boys', leader_person_id: dupId, area: 'Kaybanban', schedule_day: 'sat', schedule_time: '17:00', category: 'Students', capacity: 1 } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data)); groupA = r.data.id; assert.strictEqual(r.data.leader_name, 'Juan Dela Cruz'); assert.strictEqual(r.data.slots, 1);
    r = await call('POST', '/api/lifegroups', { token: staff, body: { name: 'David Group', gender: 'boys', leader_name: 'Kuya John', area: 'Muzon', schedule_day: 'sat', schedule_time: '18:00' } });
    assert.strictEqual(r.status, 201); groupB = r.data.id;
    assert.strictEqual((await call('POST', '/api/lifegroups', { token: viewer, body: { name: 'X' } })).status, 403);
    assert.strictEqual((await call('POST', '/api/lifegroups', { token: staff, body: { name: '', schedule_time: '25:99' } })).status, 400);
    assert.strictEqual((await call('POST', '/api/lifegroups', { token: staff, body: { name: 'No gender' } })).status, 400, 'boys/girls is required');
  });
  await test('recommendations rank by area/day/time and hide full groups', async () => {
    const r = await call('GET', '/api/lifegroups/recommend?sex=male&area=kaybanban&day=sat&time=evening', { token: staff });
    assert.strictEqual((await call('GET', '/api/lifegroups/recommend?area=kaybanban', { token: staff })).data.groups.length, 0, 'no sex → no recommendations');
    assert.strictEqual(r.data.groups[0].id, groupA); assert.ok(r.data.groups[0].reasons.includes('same area'));
  });
  await test('assign → current membership; capacity enforced; same-group assign is a no-op', async () => {
    let r = await call('POST', `/api/lifegroups/${groupA}/members`, { token: staff, body: { person_id: personId, joined_at: '2026-01-04' } });
    assert.strictEqual(r.status, 201); assert.strictEqual(r.data.current.lifegroup_id, groupA);
    r = await call('POST', `/api/lifegroups/${groupA}/members`, { token: staff, body: { person_id: personId } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.data.unchanged, true);
    r = await call('POST', `/api/lifegroups/${groupA}/members`, { token: staff, body: { person_id: dupId } });
    assert.strictEqual(r.status, 409, 'group is full');
    const p = (await call('GET', `/api/people/${personId}`, { token: viewer })).data;
    assert.strictEqual(p.lifegroup.name, 'Joshua Group'); assert.strictEqual(p.lifegroup.leader_name, 'Juan Dela Cruz');
    const needs = (await call('GET', '/api/lifegroups/needs', { token: staff })).data;
    assert.ok(!needs.some((x) => x.id === personId) && needs.some((x) => x.id === dupId));
  });
  await test('moving to another group keeps history; leaving closes membership', async () => {
    let r = await call('POST', `/api/lifegroups/${groupB}/members`, { token: staff, body: { person_id: personId, joined_at: '2026-04-05' } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.data.history.length, 2); assert.strictEqual(r.data.history[1].left_at, '2026-04-05'); assert.strictEqual(r.data.current.lifegroup_id, groupB);
    r = await call('DELETE', `/api/lifegroups/${groupB}/members/${personId}`, { token: staff });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.data.current, null); assert.strictEqual(r.data.history.length, 2);
    const g = (await call('GET', `/api/lifegroups/${groupB}`, { token: viewer })).data;
    assert.strictEqual(g.members.length, 0); assert.strictEqual(g.former.length, 1);
  });
  await test('preferences saved via PUT; overview counts; group with history cannot be deleted', async () => {
    let r = await call('PUT', `/api/people/${personId}/preferences`, { token: staff, body: { preferred_area: 'Muzon', preferred_day: 'sat', preferred_time: 'evening' } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.data.preferred_area, 'Muzon');
    assert.strictEqual((await call('PUT', `/api/people/${personId}/preferences`, { token: staff, body: { preferred_day: 'someday' } })).status, 400);
    const rec = (await call('GET', `/api/lifegroups/recommend?person_id=${personId}`, { token: staff })).data;
    assert.strictEqual(rec.prefs.area, 'Muzon');
    const ov = (await call('GET', '/api/lifegroups/overview', { token: viewer })).data;
    assert.strictEqual(ov.total_groups, 2); assert.strictEqual(ov.without_group, 2);
    assert.strictEqual((await call('DELETE', `/api/lifegroups/${groupB}`, { token: admin })).status, 409);
    const acts = (await call('GET', '/api/activity', { token: admin })).data.map((a) => a.action);
    assert.ok(acts.includes('lifegroup.create') && acts.includes('lifegroup.assign') && acts.includes('lifegroup.leave'));
  });

  console.log('\nNetworks');
  let netMain, netA, netG;
  await test('staff creates networks with leaders and a parent; validation + loop check', async () => {
    let r = await call('POST', '/api/networks', { token: staff, body: { name: 'Main Network', gender: 'boys', leader_name: 'Ptr. Sam' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data)); netMain = r.data.id; assert.strictEqual(r.data.leader_name, 'Ptr. Sam'); assert.strictEqual(r.data.gender, 'boys');
    r = await call('POST', '/api/networks', { token: staff, body: { name: 'Network A', gender: 'boys', leader_person_id: dupId, parent_network_id: netMain } });
    assert.strictEqual(r.status, 201); netA = r.data.id; assert.strictEqual(r.data.leader_name, 'Juan Dela Cruz'); assert.strictEqual(r.data.parent_name, 'Main Network');
    r = await call('POST', '/api/networks', { token: staff, body: { name: 'Network G', gender: 'girls', leader_name: 'Ate Grace' } });
    assert.strictEqual(r.status, 201); netG = r.data.id;
    assert.strictEqual((await call('POST', '/api/networks', { token: viewer, body: { name: 'X', gender: 'boys' } })).status, 403);
    assert.strictEqual((await call('POST', '/api/networks', { token: staff, body: { name: '', gender: 'boys' } })).status, 400);
    assert.strictEqual((await call('POST', '/api/networks', { token: staff, body: { name: 'Y', gender: 'boys', leader_person_id: 99999 } })).status, 400);
    r = await call('PUT', `/api/networks/${netMain}`, { token: staff, body: { parent_network_id: netA } });
    assert.strictEqual(r.status, 400, 'loop must be rejected');
  });
  await test('a network is boys or girls — never combined (leader, parent, groups, flipping)', async () => {
    let r = await call('POST', '/api/networks', { token: staff, body: { name: 'No type', leader_name: 'X' } });
    assert.strictEqual(r.status, 400); assert.ok(/boys network or a girls network/.test(r.data.error));
    r = await call('POST', '/api/networks', { token: staff, body: { name: 'Bad lead', gender: 'girls', leader_person_id: dupId } });
    assert.strictEqual(r.status, 400); assert.ok(/cannot lead a girls network/.test(r.data.error), r.data.error);
    r = await call('POST', '/api/networks', { token: staff, body: { name: 'Bad parent', gender: 'girls', parent_network_id: netMain } });
    assert.strictEqual(r.status, 400); assert.ok(/boys network — a girls network cannot be under it/.test(r.data.error), r.data.error);
    r = await call('PUT', `/api/networks/${netMain}`, { token: staff, body: { gender: 'girls' } });
    assert.strictEqual(r.status, 400); assert.ok(/sub-network/.test(r.data.error), r.data.error);
    // a girls group cannot be placed in a boys network
    r = await call('POST', '/api/lifegroups', { token: staff, body: { name: 'Wrong net', gender: 'girls', network_id: netA } });
    assert.strictEqual(r.status, 400); assert.ok(/boys network — a girls group cannot be in it/.test(r.data.error), r.data.error);
    const opts = (await call('GET', '/api/lifegroups/options', { token: viewer })).data;
    assert.strictEqual(opts.networks.find((x) => x.id === netG).gender, 'girls');
  });
  await test('group joins a network; group + person show network leader; leadership chain works', async () => {
    let r = await call('PUT', `/api/lifegroups/${groupA}`, { token: staff, body: { network_id: netA } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.data.network, 'Network A'); assert.strictEqual(r.data.network_leader_name, 'Juan Dela Cruz');
    assert.strictEqual((await call('PUT', `/api/lifegroups/${groupB}`, { token: staff, body: { network_id: 99999 } })).status, 400);
    const n = (await call('GET', `/api/networks/${netA}`, { token: viewer })).data;
    assert.strictEqual(n.groups.length, 1); assert.strictEqual(n.groups[0].id, groupA); assert.strictEqual(n.group_count, 1);
    const main = (await call('GET', `/api/networks/${netMain}`, { token: viewer })).data;
    assert.strictEqual(main.children.length, 1); assert.strictEqual(main.children[0].id, netA);
    // member of group A → reports to group leader Juan (also the network leader, shown once) → Ptr. Sam
    await call('POST', `/api/lifegroups/${groupA}/members`, { token: staff, body: { person_id: personId } });
    const p = (await call('GET', `/api/people/${personId}`, { token: viewer })).data;
    assert.strictEqual(p.lifegroup.network_name, 'Network A'); assert.strictEqual(p.lifegroup.network_leader_name, 'Juan Dela Cruz');
    assert.deepStrictEqual(p.leadership.reports_to.map((x) => x.name), ['Juan Dela Cruz', 'Ptr. Sam']);
    assert.deepStrictEqual(p.leadership.reports_to.map((x) => x.level), ['Lifegroup leader', 'Network leader']);
    const leader = (await call('GET', `/api/people/${dupId}`, { token: viewer })).data;
    assert.strictEqual(leader.leadership.leads_groups.length, 1); assert.strictEqual(leader.leadership.leads_networks.length, 1);
    assert.deepStrictEqual(leader.leadership.reports_to.map((x) => x.name), ['Ptr. Sam']);
    const opts = (await call('GET', '/api/lifegroups/options', { token: viewer })).data;
    assert.ok(opts.networks.some((x) => x.id === netA && x.name === 'Network A'));
    const list = (await call('GET', `/api/lifegroups?network_id=${netA}`, { token: viewer })).data;
    assert.strictEqual(list.length, 1);
    await call('DELETE', `/api/lifegroups/${groupA}/members/${personId}`, { token: staff });
  });
  await test('network in use cannot be deleted; empty one can (admin only)', async () => {
    assert.strictEqual((await call('DELETE', `/api/networks/${netA}`, { token: admin })).status, 409);
    assert.strictEqual((await call('DELETE', `/api/networks/${netMain}`, { token: admin })).status, 409, 'has a child network');
    const r = await call('POST', '/api/networks', { token: staff, body: { name: 'Temp', gender: 'boys' } });
    assert.strictEqual((await call('DELETE', `/api/networks/${r.data.id}`, { token: staff })).status, 403);
    assert.strictEqual((await call('DELETE', `/api/networks/${r.data.id}`, { token: admin })).status, 204);
    const ov = (await call('GET', '/api/lifegroups/overview', { token: viewer })).data;
    assert.strictEqual(ov.networks, 3);
    const acts = (await call('GET', '/api/activity', { token: admin })).data.map((a) => a.action);
    assert.ok(acts.includes('network.create') && acts.includes('network.delete'));
  });

  let mariaId, groupC;
  await test('groups are never mixed: boys/girls rules on create, assign, recommend and edit', async () => {
    let r = await call('POST', '/api/people', { token: staff, body: { first_name: 'Maria', last_name: 'Santos', sex: 'female', contact_number: '0918 000 1111', status: 'regular' } });
    mariaId = r.data.id;
    r = await call('POST', '/api/people', { token: staff, body: { first_name: 'Nosex', last_name: 'Person', contact_number: '0918 000 2222', status: 'regular' } });
    const noSexId = r.data.id;
    // a girl cannot join a boys group; a person without Boy/Girl cannot join at all
    r = await call('POST', `/api/lifegroups/${groupB}/members`, { token: staff, body: { person_id: mariaId } });
    assert.strictEqual(r.status, 409, JSON.stringify(r.data)); assert.ok(/never mixed/.test(r.data.error));
    r = await call('POST', `/api/lifegroups/${groupB}/members`, { token: staff, body: { person_id: noSexId } });
    assert.strictEqual(r.status, 400);
    // a girl cannot lead a boys group
    r = await call('POST', '/api/lifegroups', { token: staff, body: { name: 'Bad', gender: 'boys', leader_person_id: mariaId } });
    assert.strictEqual(r.status, 400);
    // girls group under Network A
    r = await call('POST', '/api/lifegroups', { token: staff, body: { name: 'Ruth Group', gender: 'girls', leader_person_id: mariaId, network_id: netG, area: 'Kaybanban' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data)); groupC = r.data.id; assert.strictEqual(r.data.gender, 'girls');
    // recommendations follow the person's sex
    const recF = (await call('GET', `/api/lifegroups/recommend?person_id=${mariaId}`, { token: staff })).data.groups;
    assert.ok(recF.length && recF.every((g) => g.gender === 'girls'));
    const recM = (await call('GET', `/api/lifegroups/recommend?person_id=${personId}`, { token: staff })).data.groups;
    assert.ok(recM.length && recM.every((g) => g.gender === 'boys'));
    // Boy/Girl can be completed from the Find dialog (preferences endpoint)
    r = await call('PUT', `/api/people/${noSexId}/preferences`, { token: staff, body: { sex: 'female', preferred_area: 'Kaybanban' } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.data.sex, 'female');
    r = await call('POST', `/api/lifegroups/${groupC}/members`, { token: staff, body: { person_id: noSexId } });
    assert.strictEqual(r.status, 201);
    // cannot flip a group with members to the other gender
    r = await call('PUT', `/api/lifegroups/${groupC}`, { token: staff, body: { gender: 'boys' } });
    assert.strictEqual(r.status, 400); assert.ok(/never mixed|Move them first|girls network/.test(r.data.error), r.data.error);
    assert.strictEqual((await call('GET', '/api/lifegroups?gender=girls', { token: viewer })).data.length, 1);
    await call('DELETE', `/api/lifegroups/${groupC}/members/${noSexId}`, { token: staff });
  });

  await test('boys/girls counts on networks, network detail members, and the Lifegroup report + CSV', async () => {
    await call('POST', `/api/lifegroups/${groupA}/members`, { token: staff, body: { person_id: personId } });
    await call('POST', `/api/lifegroups/${groupC}/members`, { token: staff, body: { person_id: mariaId } });
    const nets = (await call('GET', '/api/networks', { token: viewer })).data;
    const a = nets.find((n) => n.id === netA), m = nets.find((n) => n.id === netMain), gnet = nets.find((n) => n.id === netG);
    assert.strictEqual(a.people_count, 1); assert.strictEqual(a.girls, 0); assert.strictEqual(a.boys, 1); assert.strictEqual(a.leader_count, 1);
    assert.strictEqual(a.boys_groups, 1); assert.strictEqual(a.girls_groups, 0); assert.strictEqual(a.gender, 'boys');
    assert.strictEqual(gnet.people_count, 1); assert.strictEqual(gnet.girls, 1); assert.strictEqual(gnet.girls_groups, 1); assert.strictEqual(gnet.boys_groups, 0);
    assert.strictEqual(m.people_count, 0); assert.strictEqual(m.total_people, 1, 'main network totals include sub-network'); assert.strictEqual(m.total_girls, 0);
    const det = (await call('GET', `/api/networks/${netA}`, { token: viewer })).data;
    const ja = det.groups.find((g) => g.id === groupA);
    assert.strictEqual(ja.members.length, 1); assert.strictEqual(ja.members[0].sex, 'male'); assert.strictEqual(ja.boys, 1); assert.strictEqual(ja.gender, 'boys');
    const ru = (await call('GET', `/api/networks/${netG}`, { token: viewer })).data.groups.find((g) => g.id === groupC);
    assert.strictEqual(ru.girls, 1); assert.strictEqual(ru.gender, 'girls');
    const rep = (await call('GET', '/api/reports/lifegroups', { token: viewer })).data;
    assert.strictEqual(rep.totals.members, 2); assert.strictEqual(rep.totals.girls, 1); assert.strictEqual(rep.totals.girls_pct, 50);
    assert.strictEqual(rep.totals.boys_groups, 2); assert.strictEqual(rep.totals.girls_groups, 1);
    assert.ok(rep.networks.some((n) => n.network_name === 'Network A' && n.boys === 1 && n.girls === 0 && n.boys_groups === 1 && n.girls_groups === 0 && n.network_gender === 'boys'));
    assert.ok(rep.networks.some((n) => n.network_name === 'Network G' && n.girls === 1 && n.girls_groups === 1 && n.network_gender === 'girls'));
    assert.ok(rep.groups.some((g) => g.group_id === groupA && g.leader_name === 'Juan Dela Cruz' && g.gender === 'boys'));
    assert.strictEqual(rep.not_connected.total, 2, 'Juan #2 (leader, no membership) and Nosex are not connected');
    const csv = await call('GET', '/api/reports/export/lifegroups.csv', { token: viewer, raw: true });
    assert.strictEqual(csv.status, 200); assert.ok(csv.data.includes('Network G') && csv.data.includes('Girls group') && csv.data.includes('TOTAL'));
    await call('DELETE', `/api/lifegroups/${groupA}/members/${personId}`, { token: staff });
  });

  await test('search can be limited to boys or girls (pickers never offer the other sex)', async () => {
    const all = (await call('GET', '/api/search?q=an', { token: staff })).data.people;
    const boys = (await call('GET', '/api/search?q=an&sex=male', { token: staff })).data.people;
    const girls = (await call('GET', '/api/search?q=an&sex=female', { token: staff })).data.people;
    assert.ok(all.length >= 2 && boys.length >= 1 && girls.length >= 1, JSON.stringify(all.map((p) => [p.first_name, p.sex])));
    assert.ok(boys.every((p) => p.sex === 'male') && girls.every((p) => p.sex === 'female'));
    assert.ok(all.length > boys.length && all.length > girls.length);
    assert.strictEqual((await call('GET', '/api/search?q=an&sex=robot', { token: staff })).data.people.length, all.length, 'unknown sex value is ignored');
  });

  await test('lifegroup report has monthly growth for boys groups vs girls groups', async () => {
    const rep = (await call('GET', '/api/reports/lifegroups', { token: viewer })).data;
    const g = rep.growth; assert.ok(g && Array.isArray(g.months) && g.months.length >= 1);
    const last = g.months[g.months.length - 1];
    assert.strictEqual(last.month, new Date().toISOString().slice(0, 7));
    assert.strictEqual(last.girls_end, 1, 'Maria is in Ruth group (girls)'); assert.strictEqual(last.boys_end, 0, 'Juan was removed from Joshua group');
    assert.ok(last.boys_joined >= 1 && last.boys_left >= last.boys_joined, 'boys joined then left this month'); assert.ok(last.girls_joined >= 1);
    assert.strictEqual(g.summary.girls.now, 1); assert.strictEqual(g.summary.boys.now, 0);
    assert.ok(['boys', 'girls'].every((k) => ['now', 'days30_ago', 'days90_ago', 'change_30d', 'change_90d'].every((f) => Number.isInteger(g.summary[k][f]))));
    const ruth = rep.groups.find((x) => x.group_id === groupC);
    assert.ok(ruth.joined_30d >= 1); assert.strictEqual(ruth.net_30d, ruth.joined_30d - ruth.left_30d); assert.strictEqual(ruth.net_30d, 1); assert.strictEqual(ruth.growth_30d_pct, null, '0 → 1 member: new, no % yet');
    const csv = await call('GET', '/api/reports/export/lifegroup-growth.csv', { token: viewer, raw: true });
    assert.strictEqual(csv.status, 200); assert.ok(csv.data.startsWith('month,boys_members') && csv.data.includes(last.month));
    const csv2 = await call('GET', '/api/reports/export/lifegroups.csv', { token: viewer, raw: true });
    assert.ok(csv2.data.split('\n')[0].includes('growth_30d_pct'));
  });

  await test('privacy consent is stored with a date; business details are optional settings', async () => {
    let r = await call('POST', '/api/people', { token: staff, body: { first_name: 'Consent', last_name: 'Test', contact_number: '0917 555 0000', status: 'regular', privacy_consent: true } });
    assert.strictEqual(r.status, 201); assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.data.privacy_consent_at));
    const cid = r.data.id; const first = r.data.privacy_consent_at;
    r = await call('PUT', `/api/people/${cid}`, { token: staff, body: { school: 'X' } });
    assert.strictEqual(r.data.privacy_consent_at, first, 'untouched when the box is not sent');
    r = await call('PUT', `/api/people/${cid}`, { token: staff, body: { privacy_consent: false } });
    assert.strictEqual(r.data.privacy_consent_at, null);
    await call('DELETE', `/api/people/${cid}`, { token: admin, body: { confirm: 'DELETE' } });
    r = await call('PUT', '/api/settings', { token: admin, body: { church_address: '123 Sample St, SJDM', privacy_contact: 'Ptr. Sam · 0917 000 0000', church_contact: '' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data)); assert.strictEqual(r.data.church_address, '123 Sample St, SJDM'); assert.strictEqual(r.data.church_contact, '');
    assert.strictEqual((await call('PUT', '/api/settings', { token: admin, body: { church_name: '' } })).status, 400, 'church name stays required');
    const st = (await call('GET', '/api/auth/status')).data;
    assert.strictEqual(st.settings.privacy_contact, 'Ptr. Sam · 0917 000 0000', 'shown on the public Privacy page');
  });

  console.log('\nBackup & restore');
  let backupData;
  await test('admin can download a backup; staff cannot', async () => {
    const r = await call('GET', '/api/backup', { token: admin });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.data.format, 'lifegentracker-backup');
    assert.strictEqual(r.data.counts.people, 4); assert.strictEqual(r.data.counts.lifegroups, 3); assert.strictEqual(r.data.counts.networks, 3); backupData = r.data;
    assert.strictEqual((await call('GET', '/api/backup', { token: staff })).status, 403);
  });
  await test('restore rejects garbage and requires confirmation word', async () => {
    let r = await call('POST', '/api/restore', { token: admin, body: { confirm: 'RESTORE', backup: { hello: 1 } } });
    assert.strictEqual(r.status, 400);
    r = await call('POST', '/api/restore', { token: admin, body: { backup: backupData } });
    assert.strictEqual(r.status, 400);
    const broken = JSON.parse(JSON.stringify(backupData));
    broken.tables.attendance_records.push({ ...broken.tables.attendance_records[0], id: 999, person_id: 9999 });
    r = await call('POST', '/api/restore', { token: admin, body: { confirm: 'RESTORE', backup: broken } });
    assert.strictEqual(r.status, 400);
    // nothing changed
    assert.strictEqual((await call('GET', '/api/people?paged=1', { token: admin })).data.total, 4);
  });
  await test('restore round-trip: delete a person, restore backup, person is back', async () => {
    let r = await call('DELETE', `/api/people/${dupId}`, { token: admin });
    assert.strictEqual(r.status, 204);
    assert.strictEqual((await call('GET', '/api/people?paged=1', { token: admin })).data.total, 3);
    r = await call('POST', '/api/restore', { token: admin, body: { confirm: 'RESTORE', backup: backupData } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    // sessions are cleared by restore → sign in again
    admin = (await call('POST', '/api/auth/login', { body: { username: 'admin1', password: 'Password123' } })).data.token;
    staff = (await call('POST', '/api/auth/login', { body: { username: 'staff1', password: 'Password123' } })).data.token;
    viewer = (await call('POST', '/api/auth/login', { body: { username: 'viewer1', password: 'Password123' } })).data.token;
    assert.strictEqual((await call('GET', '/api/people?paged=1', { token: admin })).data.total, 4);
    const svc = (await call('GET', `/api/services/${serviceId}`, { token: admin })).data;
    assert.strictEqual(svc.present_count, 1);
    assert.strictEqual((await call('GET', '/api/lifegroups?status=all', { token: admin })).data.length, 3, 'lifegroups restored');
  });
  await test('manual snapshot writes a .db file', async () => {
    const r = await call('POST', '/api/backup/snapshot', { token: admin });
    if (process.env.LIFEGEN_DB_DRIVER === 'libsql' || /^postgres/.test(process.env.LIFEGEN_DB_URL || '')) { assert.strictEqual(r.status, 400); assert.ok(r.data.error.includes('not available')); return; } // hosted-DB mode: friendly message, JSON backup still works
    assert.strictEqual(r.status, 200);
    assert.ok(fs.existsSync(path.join(tmp, 'backups', r.data.file)));
  });

  console.log('\nReports & dashboard');
  await test('dashboard and weekly report agree on totals', async () => {
    const d = (await call('GET', '/api/dashboard', { token: viewer })).data;
    const rep = (await call('GET', `/api/reports/summary?from=${S1}&to=${S0}`, { token: viewer })).data;
    assert.ok(d && rep.totals && Array.isArray(rep.weekly));
    const sum = rep.weekly.reduce((a, w) => a + w.present_count, 0);
    assert.strictEqual(sum, 2, 'two Sundays × 1 present');
    const latest = rep.weekly[rep.weekly.length - 1];
    assert.strictEqual(d.latest ? d.latest.present_count : latest.present_count, latest.present_count);
  });
  await test('CSV export works and respects viewer privacy', async () => {
    const r = await call('GET', '/api/reports/export/people.csv', { token: viewer, raw: true });
    assert.strictEqual(r.status, 200); assert.ok(!r.data.includes('contact_number'));
    const r2 = await call('GET', '/api/reports/export/people.csv', { token: admin, raw: true });
    assert.ok(r2.data.includes('contact_number') && r2.data.includes('archived'));
  });
  await test('malformed JSON body → 400 JSON error', async () => {
    const res = await fetch(BASE + '/api/people', { method: 'POST', headers: { ...H, Authorization: `Bearer ${admin}` }, body: '{bad' });
    assert.strictEqual(res.status, 400); assert.ok((await res.json()).error);
  });

  console.log('\nAdmin password');
  await test('admin changes password: old password stops working, new one works, wrong current password refused', async () => {
    assert.strictEqual((await call('POST', '/api/auth/change-password', { token: admin, body: { current_password: 'WrongOne123', new_password: 'NewPassword456' } })).status, 400);
    const r = await call('POST', '/api/auth/change-password', { token: admin, body: { current_password: 'Password123', new_password: 'NewPassword456' } });
    assert.ok([200, 204].includes(r.status), JSON.stringify(r.data));
    assert.strictEqual((await call('POST', '/api/auth/login', { body: { username: 'admin1', password: 'Password123' } })).status, 401, 'old password refused');
    const ok = await call('POST', '/api/auth/login', { body: { username: 'admin1', password: 'NewPassword456' } });
    assert.strictEqual(ok.status, 200); admin = ok.data.token;
    const html = await (await fetch(BASE + '/')).text();
    assert.ok(!html.includes('NewPassword456') && !html.includes('Password123'), 'no password in HTML');
  });

  console.log('\nQR self-registration (public form → inbox → people)');
  const PUB = '/api/public/register';
  const good = { full_name: 'Juan Dela Cruz', email: 'Juan.DelaCruz@gmail.com', age: 19, school: 'BulSU', leader_name: 'Mark Reyes', network_leader_name: 'Paul Santos', ministry: 'Ushering' };
  let regId, regRef;
  await test('1. options endpoint is public, exposes pick-lists but no personal data', async () => {
    const r = await call('GET', PUB + '/options');
    assert.strictEqual(r.status, 200); assert.strictEqual(r.data.enabled, true);
    assert.ok(Array.isArray(r.data.ministries) && r.data.ministries.length > 0);
    assert.ok(!JSON.stringify(r.data).includes('contact_number'));
  });
  await test('2. valid submission → pending registration with reference number, source qr', async () => {
    const r = await call('POST', PUB, { body: good });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    assert.match(r.data.ref_code, /^LG-\d{4}-\d{6}$/); assert.strictEqual(r.data.status, 'pending');
    regRef = r.data.ref_code;
    const list = (await call('GET', '/api/registrations?status=pending', { token: admin })).data;
    const row = list.items.find((x) => x.ref_code === regRef);
    assert.ok(row); regId = row.id;
    assert.strictEqual(row.source, 'qr'); assert.strictEqual(row.email_normalized, 'juan.delacruz@gmail.com'); assert.ok(row.submitted_at);
    assert.strictEqual(list.counts.pending >= 1, true);
  });
  await test('3. same email again (even UPPERCASE / spaces) is rejected with the friendly message', async () => {
    const r = await call('POST', PUB, { body: { ...good, full_name: 'Juan D. Cruz', email: '  JUAN.DELACRUZ@GMAIL.COM ' } });
    assert.strictEqual(r.status, 409); assert.ok(r.data.error.includes('already registered'), r.data.error);
    const n = (await call('GET', '/api/registrations?status=all', { token: admin })).data.items.filter((x) => x.email_normalized === 'juan.delacruz@gmail.com').length;
    assert.strictEqual(n, 1, 'still exactly one row');
  });
  await test('4. concurrent identical submissions → exactly one succeeds', async () => {
    const body = { ...good, full_name: 'Race Condition', email: 'race@gmail.com' };
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => call('POST', PUB, { body })));
    const ok = rs.filter((r) => r.status === 201).length, dup = rs.filter((r) => r.status === 409).length;
    assert.strictEqual(ok, 1, JSON.stringify(rs.map((r) => r.status))); assert.strictEqual(dup, 4);
  });
  await test('5. same name + different email is accepted but flagged as a possible duplicate', async () => {
    const r = await call('POST', PUB, { body: { ...good, full_name: '  juan   dela cruz ', email: 'juan.other@gmail.com' } });
    assert.strictEqual(r.status, 201); assert.strictEqual(r.data.possible_duplicate, true);
    const chk = await call('POST', PUB + '/check', { body: { full_name: 'JUAN DELA CRUZ', email: 'new@gmail.com' } });
    assert.deepStrictEqual(chk.data, { email_taken: false, name_match: true });
    const chk2 = await call('POST', PUB + '/check', { body: { full_name: 'Nobody Here', email: 'juan.delacruz@gmail.com' } });
    assert.strictEqual(chk2.data.email_taken, true);
  });
  await test('6. validation: bad email, age out of range / decimal, one-word name, missing fields, unknown ministry', async () => {
    const bad = [
      [{ ...good, email: 'not-an-email' }, 'email'], [{ ...good, email: 'x@gmail.com', age: 4 }, 'age'], [{ ...good, email: 'x@gmail.com', age: 101 }, 'age'],
      [{ ...good, email: 'x@gmail.com', age: '18.5' }, 'age'], [{ ...good, email: 'x@gmail.com', full_name: 'Juan' }, 'full_name'],
      [{ ...good, email: 'x@gmail.com', school: '' }, 'school'], [{ ...good, email: 'x@gmail.com', leader_name: '' }, 'leader_name'],
      [{ ...good, email: 'x@gmail.com', network_leader_name: '' }, 'network_leader_name'], [{ ...good, email: 'x@gmail.com', ministry: 'Nope' }, 'ministry'], [{}, 'full_name'],
    ];
    for (const [b, field] of bad) {
      const r = await call('POST', PUB, { body: b });
      assert.strictEqual(r.status, 400, field + ' ' + JSON.stringify(r.data));
      assert.ok(r.data.details && r.data.details[field], `expected field error for ${field}: ${JSON.stringify(r.data)}`);
    }
    assert.strictEqual((await call('GET', '/api/registrations?status=all', { token: admin })).data.items.some((x) => x.email === 'x@gmail.com'), false);
  });
  await test('7. honeypot + no admin/status/role fields accepted from the public form', async () => {
    const r = await call('POST', PUB, { body: { ...good, email: 'bot@gmail.com', website: 'http://spam' } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual((await call('GET', '/api/registrations?status=all', { token: admin })).data.items.some((x) => x.email === 'bot@gmail.com'), false, 'bot not stored');
    const r2 = await call('POST', PUB, { body: { ...good, email: 'sneaky@gmail.com', status: 'approved', role: 'admin', person_id: 1 } });
    assert.strictEqual(r2.status, 201); assert.strictEqual(r2.data.status, 'pending');
  });
  await test('8. admin routes are protected: anonymous 401, staff/viewer 403, admin 200', async () => {
    assert.strictEqual((await call('GET', '/api/registrations')).status, 401);
    assert.strictEqual((await call('GET', '/api/registrations', { token: staff })).status, 403);
    assert.strictEqual((await call('GET', '/api/registrations', { token: viewer })).status, 403);
    assert.strictEqual((await call('GET', '/api/qr/registration', { token: staff })).status, 403);
    assert.strictEqual((await call('POST', `/api/registrations/${regId}/approve`, { token: staff, body: {} })).status, 403);
    assert.strictEqual((await call('GET', '/api/registrations', { token: admin })).status, 200);
  });
  await test('9. QR contains only the registration URL (SVG + PNG, admin only)', async () => {
    const r = await call('GET', '/api/qr/registration', { token: admin });
    assert.strictEqual(r.status, 200); assert.ok(r.data.svg.startsWith('<svg')); assert.strictEqual(r.data.url, `${BASE}/register`);
    await call('PUT', '/api/settings', { token: admin, body: { qr_public_url: 'https://lifegen.example.org/' } });
    assert.strictEqual((await call('GET', '/api/qr/registration', { token: admin })).data.url, 'https://lifegen.example.org/register');
    await call('PUT', '/api/settings', { token: admin, body: { qr_public_url: '' } });
    const png = await fetch(BASE + '/api/qr/registration.png?size=300', { headers: { Authorization: `Bearer ${admin}` } });
    assert.strictEqual(png.status, 200); assert.strictEqual(png.headers.get('content-type'), 'image/png');
    const page = await fetch(BASE + '/register'); assert.strictEqual(page.status, 200); assert.ok((await page.text()).includes('Lifegen Registration'));
  });
  await test('10. search + filters in the inbox (name/email/school/leader/ministry)', async () => {
    for (const q of ['juan', 'delacruz@gmail', 'BulSU', 'Mark Reyes', 'Paul Santos', 'Ushering', regRef]) {
      const r = (await call('GET', `/api/registrations?status=all&q=${encodeURIComponent(q)}`, { token: admin })).data;
      assert.ok(r.items.some((x) => x.id === regId), 'search ' + q);
    }
    assert.strictEqual((await call('GET', '/api/registrations?status=approved', { token: admin })).data.items.length, 0);
  });
  await test('11. admin edit of a pending registration shares the same validation + uniqueness', async () => {
    assert.strictEqual((await call('PUT', `/api/registrations/${regId}`, { token: admin, body: { age: 200 } })).status, 400);
    assert.strictEqual((await call('PUT', `/api/registrations/${regId}`, { token: admin, body: { email: 'RACE@gmail.com' } })).status, 409);
    const r = await call('PUT', `/api/registrations/${regId}`, { token: admin, body: { school: 'Bulacan State University' } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.data.school, 'Bulacan State University');
  });
  let qrPersonId;
  await test('12. approve creates the person in the SAME people table (status first_timer, source qr, LG code)', async () => {
    const before = (await call('GET', '/api/people?status=all', { token: admin })).data;
    const r = await call('POST', `/api/registrations/${regId}/approve`, { token: admin, body: {} });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data)); assert.strictEqual(r.data.status, 'approved'); qrPersonId = r.data.person_id;
    const p = (await call('GET', `/api/people/${qrPersonId}`, { token: admin })).data;
    assert.strictEqual(p.first_name, 'Juan'); assert.strictEqual(p.last_name, 'Dela Cruz'); assert.strictEqual(p.email, 'Juan.DelaCruz@gmail.com');
    assert.strictEqual(p.status, 'first_timer'); assert.strictEqual(p.registration_source, 'qr'); assert.strictEqual(p.age, 19); assert.strictEqual(p.ministry, 'Ushering');
    assert.match(p.person_code, /^LG-\d{4}-\d{4}$/); assert.ok(p.notes.includes('Mark Reyes'));
    const after = (await call('GET', '/api/people?status=all', { token: admin })).data;
    const count = (x) => (Array.isArray(x) ? x.length : (x.items || x.people || []).length);
    assert.strictEqual(count(after), count(before) + 1);
    assert.strictEqual((await call('POST', `/api/registrations/${regId}/approve`, { token: admin, body: {} })).status, 409, 'cannot approve twice');
  });
  await test('13. manual registration still works and shares the one-email rule (409, not a crash)', async () => {
    const r = await call('POST', '/api/people', { token: staff, body: { first_name: 'Manual', last_name: 'Person', contact_number: '09171234567', status: 'first_timer', email: 'JUAN.delacruz@gmail.com' } });
    assert.strictEqual(r.status, 409); assert.ok(r.data.error.includes('already used'), r.data.error);
    const ok = await call('POST', '/api/people', { token: staff, body: { first_name: 'Manual', last_name: 'Person', contact_number: '09171234567', status: 'first_timer', email: 'manual.person@gmail.com' } });
    assert.strictEqual(ok.status, 201); assert.strictEqual(ok.data.registration_source, 'manual');
    const qr = await call('POST', PUB, { body: { ...good, full_name: 'Someone Else', email: 'Manual.Person@gmail.com' } });
    assert.strictEqual(qr.status, 409, 'QR form cannot reuse an email that a manually registered person has');
    // staff can edit the QR-registered person without a contact number, and add one later
    const upd = await call('PUT', `/api/people/${qrPersonId}`, { token: staff, body: { first_name: 'Juan', last_name: 'Dela Cruz', status: 'first_timer', email: 'Juan.DelaCruz@gmail.com', school: 'BulSU' } });
    assert.strictEqual(upd.status, 200, JSON.stringify(upd.data));
  });
  await test('14. reject keeps the row out of people; link-approve fills an existing person instead of duplicating', async () => {
    const items = (await call('GET', '/api/registrations?status=pending', { token: admin })).data.items;
    const flagged = items.find((x) => x.email === 'juan.other@gmail.com');
    assert.ok(flagged && flagged.possible_duplicate === 1);
    const detail = (await call('GET', `/api/registrations/${flagged.id}`, { token: admin })).data;
    assert.ok(detail.review.same_name.some((p) => p.id === qrPersonId), 'review shows the same-name person');
    const rj = await call('POST', `/api/registrations/${flagged.id}/reject`, { token: admin, body: { note: 'Duplicate of LG person' } });
    assert.strictEqual(rj.status, 200); assert.strictEqual(rj.data.status, 'rejected');
    const sneaky = items.find((x) => x.email === 'sneaky@gmail.com');
    const manual = (await call('GET', '/api/search?q=Manual%20Person', { token: admin })).data.people.find((p) => p.email === 'manual.person@gmail.com' || /Manual/.test(p.first_name || p.name || ''));
    assert.ok(manual, 'manual person found');
    const link = await call('POST', `/api/registrations/${sneaky.id}/approve`, { token: admin, body: { mode: 'link', person_id: manual.id } });
    assert.strictEqual(link.status, 409, 'cannot link to a person who already has a different email');
    const target = (await call('POST', '/api/people', { token: staff, body: { first_name: 'Link', last_name: 'Target', contact_number: '09170000001', status: 'regular' } })).data;
    const link2 = await call('POST', `/api/registrations/${sneaky.id}/approve`, { token: admin, body: { mode: 'link', person_id: target.id } });
    assert.strictEqual(link2.status, 200, JSON.stringify(link2.data)); assert.strictEqual(link2.data.person_id, target.id);
    const tp = (await call('GET', `/api/people/${target.id}`, { token: admin })).data;
    assert.strictEqual(tp.email, 'sneaky@gmail.com'); assert.strictEqual(tp.status, 'regular', 'existing status untouched'); assert.strictEqual(tp.contact_number, '09170000001');
    const people = (await call('GET', '/api/people?status=all', { token: admin })).data;
    const arr = Array.isArray(people) ? people : (people.items || people.people);
    assert.ok(!arr.some((p) => (p.email || '').includes('juan.other')), 'rejected never reaches people');
    const del = await call('DELETE', `/api/registrations/${flagged.id}`, { token: admin });
    assert.strictEqual(del.status, 200);
    assert.strictEqual((await call('DELETE', `/api/registrations/${regId}`, { token: admin })).status, 409, 'approved rows are kept as audit trail');
  });
  await test('15. disabling registration blocks the public form; rate limit kicks in; backup includes registrations', async () => {
    await call('PUT', '/api/settings', { token: admin, body: { qr_registration_enabled: '0' } });
    assert.strictEqual((await call('GET', PUB + '/options')).data.enabled, false);
    const r = await call('POST', PUB, { body: { ...good, email: 'closed@gmail.com' } });
    assert.strictEqual(r.status, 403); assert.ok(r.data.error.includes('currently unavailable'));
    await call('PUT', '/api/settings', { token: admin, body: { qr_registration_enabled: '1' } });
    let limited = false;
    for (let i = 0; i < 110; i++) { const x = await call('POST', PUB, { body: { full_name: 'A' } }); if (x.status === 429) { limited = true; break; } }
    assert.ok(limited, 'rate limited after repeated submits');
    const bk = (await call('GET', '/api/backup', { token: admin })).data;
    assert.ok(Array.isArray(bk.tables.registrations) && bk.tables.registrations.length >= 1);
    const act = (await call('GET', '/api/activity', { token: admin })).data;
    const acts = Array.isArray(act) ? act : act.items;
    assert.ok(acts.some((a) => a.action === 'registration.approve'));
  });

  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter((r) => !r[0]).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); if (server) server.kill(); process.exit(1); });
