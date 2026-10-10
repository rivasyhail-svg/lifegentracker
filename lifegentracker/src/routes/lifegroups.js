'use strict';

/**
 * Lifegroups (cell groups): groups, leaders, memberships with history, recommendations.
 */
const express = require('express');
const { getDb } = require('../db');
const { clean, isValidDate, today, HttpError, wrap, intId } = require('../lib/util');
const { requirePermission, can } = require('../middleware/auth');
const activity = require('../services/activity');
const { syncNetworks } = require('../services/networks-auto');
const prog = require('../services/lifegroup-progress');
const QRCode = require('qrcode');

const router = express.Router();
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const TIMES = ['morning', 'afternoon', 'evening'];

const GROUP_SELECT = `
  SELECT g.*,
         lp.first_name AS leader_first_name, lp.last_name AS leader_last_name, lp.person_code AS leader_code,
         lp.contact_number AS leader_contact,
         n.name AS network_name, n.leader_person_id AS network_leader_person_id,
         COALESCE(nl.first_name || ' ' || nl.last_name, n.leader_name) AS network_leader_name,
         (SELECT COUNT(*) FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id
           WHERE m.lifegroup_id = g.id AND m.left_at IS NULL AND p.archived_at IS NULL) AS member_count,
         (SELECT COUNT(*) FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id
           WHERE m.lifegroup_id = g.id AND m.left_at IS NULL AND p.archived_at IS NULL AND m.tier = 'solid') AS solid_count,
         (SELECT MAX(mt.meeting_date) FROM lifegroup_meetings mt WHERE mt.lifegroup_id = g.id AND mt.held = 1) AS last_held,
         EXISTS (SELECT 1 FROM networks xn WHERE xn.leader_person_id = g.leader_person_id AND xn.is_active = 1) AS leads_network
    FROM lifegroups g
    LEFT JOIN people lp ON lp.id = g.leader_person_id
    LEFT JOIN networks n ON n.id = g.network_id
    LEFT JOIN people nl ON nl.id = n.leader_person_id`;

function timeBucket(hhmm) {
  if (!hhmm) return null;
  const h = Number(String(hhmm).slice(0, 2));
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

function shape(g, user) {
  if (!g) return g;
  const out = {
    ...g,
    leader_name: g.leader_person_id ? `${g.leader_first_name} ${g.leader_last_name}` : g.leader_name,
    network: g.network_name || g.network, // display name (legacy free-text kept as fallback)
    time_bucket: timeBucket(g.schedule_time),
    leads_network: Boolean(Number(g.leads_network)),
    max_members: Number(g.leads_network) ? prog.NETWORK_LEADER_MAX : null, // open cell has no limit; capacity column is no longer used
  };
  out.slots = out.max_members == null ? null : Math.max(out.max_members - g.member_count, 0);
  if (!can(user, 'people:view_private')) out.leader_contact = undefined;
  delete out.leader_first_name; delete out.leader_last_name;
  delete out.report_token; // private leader link — only via /:id/progress for managers
  return out;
}

function getGroup(db, id, user) {
  return shape(db.prepare(`${GROUP_SELECT} WHERE g.id = ?`).get(id), user);
}

function validateGroup(body, existing = null) {
  const src = existing ? { ...existing, ...body } : body;
  const data = {
    name: clean(src.name),
    gender: clean(src.gender),
    leader_person_id: src.leader_person_id ? Number(src.leader_person_id) : null,
    leader_name: clean(src.leader_name),
    network_id: src.network_id ? Number(src.network_id) : null,
    // a network chosen by hand is pinned; "Auto" (no network_id, or network_manual=false) lets membership decide
    network_manual: src.network_id && (body.network_manual === undefined ? (body.network_id !== undefined ? true : Boolean(src.network_manual)) : Boolean(body.network_manual)) ? 1 : 0,
    network: clean(src.network),
    area: clean(src.area),
    schedule_day: clean(src.schedule_day),
    schedule_time: clean(src.schedule_time),
    category: clean(src.category),
    capacity: src.capacity === '' || src.capacity == null ? null : Number(src.capacity),
    venue: clean(src.venue),
    notes: clean(src.notes),
    is_active: src.is_active === undefined ? 1 : (src.is_active ? 1 : 0),
  };
  const errors = [];
  if (!data.name) errors.push('Group name is required.');
  if (!['boys', 'girls'].includes(data.gender)) errors.push('Choose whether this is a boys group or a girls group.');
  if (data.leader_person_id !== null && (!Number.isInteger(data.leader_person_id) || data.leader_person_id < 1)) errors.push('Invalid leader.');
  if (data.network_id !== null && (!Number.isInteger(data.network_id) || data.network_id < 1)) errors.push('Invalid network.');
  if (data.schedule_day && !DAYS.includes(data.schedule_day)) errors.push('Invalid schedule day.');
  if (data.schedule_time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.schedule_time)) errors.push('Schedule time must be HH:MM.');
  if (data.capacity !== null && (!Number.isInteger(data.capacity) || data.capacity < 1 || data.capacity > 999)) errors.push('Capacity must be a whole number (1–999) or blank.');
  if (errors.length) throw new HttpError(400, errors.join(' '), errors);
  return data;
}

const SEX_OF = { boys: 'male', girls: 'female' };
const GENDER_LABEL = { boys: 'boys group', girls: 'girls group' };
/** Leader must match the group's gender; when changing gender, current members must all match. */
function checkGenderRules(db, data, existingId = null) {
  if (data.leader_person_id && data.network_id) {
    // Independent networks: a Network leader's own Lifegroup can only live in their own Network.
    const own = db.prepare('SELECT id, name FROM networks WHERE leader_person_id = ? AND is_active = 1 LIMIT 1').get(data.leader_person_id);
    if (own && own.id !== data.network_id) {
      const lp = db.prepare('SELECT first_name, last_name FROM people WHERE id = ?').get(data.leader_person_id);
      throw new HttpError(400, `${lp ? lp.first_name + ' ' + lp.last_name : 'This leader'} leads ${own.name}. A Network leader is independent — their Lifegroup stays in their own Network and cannot be placed under another Network leader.`);
    }
  }
  if (data.network_id) {
    // a boys group can only sit in a boys network (and vice versa) — networks are never combined
    const net = db.prepare('SELECT name, gender FROM networks WHERE id = ?').get(data.network_id);
    if (net && net.gender && net.gender !== data.gender) throw new HttpError(400, `${net.name} is a ${net.gender} network — a ${GENDER_LABEL[data.gender]} cannot be in it. Pick a ${data.gender} network.`);
  }
  if (data.leader_person_id) {
    const lp = db.prepare('SELECT first_name, last_name, sex FROM people WHERE id = ?').get(data.leader_person_id);
    if (lp && lp.sex && lp.sex !== SEX_OF[data.gender]) throw new HttpError(400, `${lp.first_name} ${lp.last_name} cannot lead a ${GENDER_LABEL[data.gender]} — groups are never mixed.`);
  }
  if (existingId) {
    const bad = db.prepare(`SELECT COUNT(*) n FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id
      WHERE m.lifegroup_id = ? AND m.left_at IS NULL AND p.archived_at IS NULL AND (p.sex IS NULL OR p.sex <> ?)`).get(existingId, SEX_OF[data.gender]).n;
    if (bad) throw new HttpError(400, `Cannot make this a ${GENDER_LABEL[data.gender]}: ${bad} current member${bad === 1 ? ' is' : 's are'} not ${data.gender}. Move them first.`);
  }
}

/** Current membership + history for a person (used by people route too). */
function membershipFor(db, personId, user) {
  const rows = db
    .prepare(
      `SELECT m.id, m.lifegroup_id, m.role, m.tier, m.joined_at, m.left_at, m.notes, g.name, g.gender, g.schedule_day, g.schedule_time,
              g.is_active, g.leader_person_id, g.leader_name AS leader_fallback, lp.first_name AS lf, lp.last_name AS ll,
              g.network_id, n.name AS network_name, n.leader_person_id AS network_leader_person_id,
              COALESCE(nl.first_name || ' ' || nl.last_name, n.leader_name) AS network_leader_name,
              u.display_name AS assigned_by_name
         FROM lifegroup_memberships m
         JOIN lifegroups g ON g.id = m.lifegroup_id
         LEFT JOIN people lp ON lp.id = g.leader_person_id
         LEFT JOIN networks n ON n.id = g.network_id
         LEFT JOIN people nl ON nl.id = n.leader_person_id
         LEFT JOIN users u ON u.id = m.assigned_by
        WHERE m.person_id = ?
        ORDER BY m.left_at IS NOT NULL, m.joined_at DESC, m.id DESC`
    )
    .all(personId)
    .map((r) => ({ ...r, leader_name: r.leader_person_id ? `${r.lf} ${r.ll}` : r.leader_fallback, lf: undefined, ll: undefined, leader_fallback: undefined }));
  const current = rows.find((r) => !r.left_at) || null;
  return { current, history: rows };
}

/** Score active groups against a person's preferences. */
function recommend(db, prefs, user, limit = 8) {
  // boys only see boys groups, girls only girls groups; unknown sex → nothing (profile must be completed first)
  const wanted = prefs.sex === 'male' ? 'boys' : prefs.sex === 'female' ? 'girls' : null;
  if (!wanted) return [];
  const groups = db.prepare(`${GROUP_SELECT} WHERE g.is_active = 1 AND g.gender = ? ORDER BY g.name COLLATE NOCASE`).all(wanted).map((g) => shape(g, user));
  const area = (prefs.area || '').toLowerCase(), day = prefs.day || '', time = prefs.time || '', cat = (prefs.category || '').toLowerCase();
  return groups
    .map((g) => {
      let score = 0; const why = [];
      if (day && g.schedule_day === day) { score += 2; why.push('preferred day'); }
      if (time && g.time_bucket === time) { score += 1; why.push('preferred time'); }
      if (cat && g.category && g.category.toLowerCase() === cat) { score += 1; why.push('matching category'); }
      if (g.slots === 0) score -= 10;
      return { ...g, score, reasons: why };
    })
    .filter((g) => g.slots !== 0)
    .sort((a, b) => b.score - a.score || (b.slots ?? 999) - (a.slots ?? 999) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// GET /api/lifegroups?q&area&status=active|inactive|all
// ---------------------------------------------------------------------------
router.get('/', requirePermission('lifegroups:view'), wrap((req, res) => {
  const db = getDb();
  const where = []; const params = {};
  const q = clean(req.query.q);
  const gender = clean(req.query.gender);
  if (gender && ['boys', 'girls'].includes(gender)) { where.push('g.gender = @gender'); params.gender = gender; }
  if (q) { where.push('(g.name LIKE @q OR g.area LIKE @q OR g.network LIKE @q OR n.name LIKE @q OR lp.first_name || \' \' || lp.last_name LIKE @q OR g.leader_name LIKE @q)'); params.q = `%${q}%`; }
  if (req.query.network_id) { where.push('g.network_id = @nid'); params.nid = intId(req.query.network_id, 'network id'); }
  const area = clean(req.query.area);
  if (area) { where.push('g.area = @area'); params.area = area; }
  const status = clean(req.query.status) || 'active';
  if (status === 'active') where.push('g.is_active = 1');
  else if (status === 'inactive') where.push('g.is_active = 0');
  const rows = db.prepare(`${GROUP_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY g.is_active DESC, g.gender, g.name COLLATE NOCASE`).all(params);
  const solidTarget = prog.target(prog.settings(db));
  res.json(rows.map((g) => ({ ...shape(g, req.user), solid_target: solidTarget })));
}));

// GET /api/lifegroups/options — areas / categories / networks for dropdowns
router.get('/options', requirePermission('lifegroups:view'), wrap((req, res) => {
  const db = getDb();
  const col = (c) => db.prepare(`SELECT DISTINCT ${c} AS v FROM lifegroups WHERE ${c} IS NOT NULL AND ${c} <> ''`).all().map((r) => r.v).sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }));
  const networks = db.prepare(`SELECT n.id, n.name, n.gender, COALESCE(lp.first_name || ' ' || lp.last_name, n.leader_name) AS leader_name FROM networks n LEFT JOIN people lp ON lp.id = n.leader_person_id WHERE n.is_active = 1 ORDER BY n.name COLLATE NOCASE`).all();
  res.json({ areas: col('area'), categories: col('category'), networks, days: DAYS, times: TIMES });
}));

// GET /api/lifegroups/overview — dashboard numbers
router.get('/overview', requirePermission('dashboard:view'), wrap((req, res) => {
  res.json(overview(getDb()));
}));

function overview(db) {
  const g = db.prepare(`SELECT COUNT(*) AS total, SUM(is_active = 1) AS active, SUM(is_active = 1 AND gender = 'boys') AS boys_groups, SUM(is_active = 1 AND gender = 'girls') AS girls_groups,
                               SUM(is_active = 1) AS with_slots
                          FROM lifegroups`).get();
  const leaders = db.prepare(`SELECT COUNT(DISTINCT leader_person_id) AS n FROM lifegroups WHERE is_active = 1 AND leader_person_id IS NOT NULL`).get().n
    + db.prepare(`SELECT COUNT(DISTINCT leader_name) AS n FROM lifegroups WHERE is_active = 1 AND leader_person_id IS NULL AND leader_name IS NOT NULL`).get().n;
  // "connected" = in a Lifegroup, or the root of their own Network (network leaders are never "without Lifegroup")
  const p = db.prepare(`SELECT
      SUM(EXISTS (SELECT 1 FROM lifegroup_memberships m WHERE m.person_id = p.id AND m.left_at IS NULL)) AS with_group,
      SUM(NOT EXISTS (SELECT 1 FROM lifegroup_memberships m WHERE m.person_id = p.id AND m.left_at IS NULL) AND NOT EXISTS (SELECT 1 FROM networks xn WHERE xn.leader_person_id = p.id AND xn.is_active = 1)) AS without_group,
      SUM(NOT EXISTS (SELECT 1 FROM lifegroup_memberships m WHERE m.person_id = p.id AND m.left_at IS NULL) AND NOT EXISTS (SELECT 1 FROM networks xn WHERE xn.leader_person_id = p.id AND xn.is_active = 1)
          AND p.date_registered >= date('now', '-60 days')) AS new_needing
    FROM people p WHERE p.archived_at IS NULL AND p.status <> 'inactive'`).get();
  const networks = db.prepare('SELECT COUNT(*) n FROM networks WHERE is_active = 1').get().n;
  const cells = db.prepare(`SELECT SUM(m.tier = 'solid') AS closed, SUM(m.tier <> 'solid') AS open FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id JOIN lifegroups g ON g.id = m.lifegroup_id
      WHERE m.left_at IS NULL AND p.archived_at IS NULL AND g.is_active = 1`).get();
  // church-structure numbers (network leaders' own groups hold the cell leaders, so they are not open/closed cell)
  const st = prog.structureTiles(db);
  const structure = { networks: st.boys.networks + st.girls.networks, cell_leaders: st.boys.cell_leaders + st.girls.cell_leaders, lifegroups: st.boys.lifegroups + st.girls.lifegroups,
    closed_cell: st.boys.closed_cell + st.girls.closed_cell, open_cell: st.boys.open_cell + st.girls.open_cell, boys: st.boys, girls: st.girls };
  return {
    structure,
    networks, closed_cell: Number(cells.closed) || 0, open_cell: Number(cells.open) || 0,
    total_groups: g.total || 0, active_groups: g.active || 0, boys_groups: g.boys_groups || 0, girls_groups: g.girls_groups || 0, groups_with_slots: g.with_slots || 0, total_leaders: leaders || 0,
    with_group: p.with_group || 0, without_group: p.without_group || 0, new_needing_connection: p.new_needing || 0,
  };
}

// GET /api/lifegroups/needs — people without a current group (for follow-up)
router.get('/needs', requirePermission('people:view'), wrap((req, res) => {
  const db = getDb();
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
  const q = clean(req.query.q);
  const rows = db.prepare(`
    SELECT p.id, p.person_code, p.first_name, p.last_name, p.photo, p.sex, p.status, p.date_registered, p.date_first_attended,
           p.preferred_area, p.preferred_day, p.preferred_time, p.preferred_category,
           (SELECT COUNT(*) FROM attendance_records r WHERE r.person_id = p.id AND r.status = 'present') AS sundays_attended,
           (SELECT MAX(s.service_date) FROM attendance_records r JOIN services s ON s.id = r.service_id WHERE r.person_id = p.id AND r.status = 'present') AS last_attended
      FROM people p
     WHERE p.archived_at IS NULL AND p.status <> 'inactive'
       AND NOT EXISTS (SELECT 1 FROM lifegroup_memberships m WHERE m.person_id = p.id AND m.left_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM networks xn WHERE xn.leader_person_id = p.id AND xn.is_active = 1)
       ${q ? "AND (p.first_name || ' ' || p.last_name LIKE @q OR p.person_code LIKE @q)" : ''}
     ORDER BY last_attended IS NULL, last_attended DESC, p.date_registered DESC LIMIT ${limit}`).all(q ? { q: `%${q}%` } : {});
  res.json(rows);
}));

// GET /api/lifegroups/recommend?person_id= | ?area&day&time&category
router.get('/recommend', requirePermission('lifegroups:view'), wrap((req, res) => {
  const db = getDb();
  let prefs = { sex: clean(req.query.sex), area: clean(req.query.area), day: clean(req.query.day), time: clean(req.query.time), category: clean(req.query.category) };
  if (req.query.person_id) {
    const p = db.prepare('SELECT sex, preferred_area, preferred_day, preferred_time, preferred_category FROM people WHERE id = ?').get(intId(req.query.person_id, 'person id'));
    if (!p) throw new HttpError(404, 'Person not found.');
    prefs = { sex: prefs.sex || p.sex, area: prefs.area || p.preferred_area, day: prefs.day || p.preferred_day, time: prefs.time || p.preferred_time, category: prefs.category || p.preferred_category };
  }
  if (prefs.sex && !['male', 'female'].includes(prefs.sex)) throw new HttpError(400, 'Invalid sex value.');
  res.json({ prefs, groups: recommend(db, prefs, req.user) });
}));

// ---------------------------------------------------------------------------
// Progress: solid/new members, weekly reports, leader link, statistics
// ---------------------------------------------------------------------------
// GET /api/lifegroups/progress/overview — Progress tab (all groups, per network, overall)
router.get('/progress/overview', requirePermission('lifegroups:view'), wrap((req, res) => {
  res.json(prog.overview(getDb(), { weeks: Math.min(Math.max(Number(req.query.weeks) || 8, 4), 26) }));
}));

// GET /api/lifegroups/:id/progress — one group: members with tiers, calendar, meetings, leader link (managers only)
function linkBase(db, req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const custom = clean(db.prepare("SELECT value FROM settings WHERE key = 'qr_public_url'").get()?.value);
  return custom ? custom.replace(/\/+$/, '').replace(/\/register$/, '') : `${proto}://${req.get('host')}`;
}
router.get('/:id/progress', requirePermission('lifegroups:view'), wrap(async (req, res) => {
  const db = getDb();
  const id = intId(req.params.id);
  const p = prog.progress(db, id, { weeks: Math.min(Math.max(Number(req.query.weeks) || 12, 4), 26) });
  const out = { ...p, meetings: prog.meetingsOf(db, id, 30) };
  if (can(req.user, 'lifegroups:manage')) {
    const token = prog.ensureToken(db, id);
    out.report_link = `${linkBase(db, req)}/lifegroup?t=${token}`;
    out.report_qr = await QRCode.toString(out.report_link, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#111111', light: '#ffffff' } });
  }
  res.json(out);
}));

// PUT /api/lifegroups/:id/members/:personId/tier { tier: 'solid' | 'new' }
router.put('/:id/members/:personId/tier', requirePermission('lifegroups:manage'), wrap((req, res) => {
  const db = getDb();
  const id = intId(req.params.id);
  prog.setTier(db, id, intId(req.params.personId, 'person id'), clean(req.body?.tier), { user: req.user });
  res.json(prog.progress(db, id));
}));

// POST /api/lifegroups/:id/meetings — staff files/overwrites the report for a date
router.post('/:id/meetings', requirePermission('lifegroups:manage'), wrap((req, res) => {
  const db = getDb();
  const id = intId(req.params.id);
  const out = prog.recordMeeting(db, id, req.body || {}, { via: 'admin', user: req.user, byName: req.user.display_name });
  res.status(out.updated ? 200 : 201).json({ ...out, progress: prog.progress(db, id), meetings: prog.meetingsOf(db, id, 30) });
}));
router.delete('/:id/meetings/:mid', requirePermission('lifegroups:manage'), wrap((req, res) => {
  const db = getDb();
  const id = intId(req.params.id);
  prog.deleteMeeting(db, id, intId(req.params.mid, 'meeting id'), req.user);
  res.json({ progress: prog.progress(db, id), meetings: prog.meetingsOf(db, id, 30) });
}));
// POST /api/lifegroups/:id/report-link/reset — invalidate the leader's link
router.post('/:id/report-link/reset', requirePermission('lifegroups:manage'), wrap((req, res) => {
  const db = getDb();
  const id = intId(req.params.id);
  const token = prog.resetToken(db, id, req.user);
  res.json({ report_link: `${linkBase(db, req)}/lifegroup?t=${token}` });
}));

// GET /api/lifegroups/:id — group + current members + leader
router.get('/:id', requirePermission('lifegroups:view'), wrap((req, res) => {
  const db = getDb();
  const g = getGroup(db, intId(req.params.id), req.user);
  if (!g) throw new HttpError(404, 'Lifegroup not found.');
  const members = db.prepare(`
    SELECT p.id, p.person_code, p.first_name, p.last_name, p.photo, p.sex, p.status, p.archived_at, m.role, m.tier, m.joined_at, m.id AS membership_id,
           (SELECT MAX(s.service_date) FROM attendance_records r JOIN services s ON s.id = r.service_id WHERE r.person_id = p.id AND r.status = 'present') AS last_attended
      FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id
     WHERE m.lifegroup_id = ? AND m.left_at IS NULL
     ORDER BY m.role = 'member', p.last_name COLLATE NOCASE, p.first_name COLLATE NOCASE`).all(g.id);
  const former = db.prepare(`
    SELECT p.id, p.person_code, p.first_name, p.last_name, m.joined_at, m.left_at
      FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id
     WHERE m.lifegroup_id = ? AND m.left_at IS NOT NULL ORDER BY m.left_at DESC LIMIT 50`).all(g.id);
  let led_groups = [];
  if (g.leads_network && members.length) {
    const ids = members.map((m) => m.id);
    led_groups = db.prepare(`SELECT x.id, x.name, x.leader_person_id,
          (SELECT COUNT(*) FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id WHERE m.lifegroup_id = x.id AND m.left_at IS NULL AND p.archived_at IS NULL) AS member_count,
          (SELECT COUNT(*) FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id WHERE m.lifegroup_id = x.id AND m.left_at IS NULL AND p.archived_at IS NULL AND m.tier = 'solid') AS solid_count,
          (SELECT MAX(mt.meeting_date) FROM lifegroup_meetings mt WHERE mt.lifegroup_id = x.id AND mt.held = 1) AS last_held
        FROM lifegroups x WHERE x.is_active = 1 AND x.leader_person_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  }
  res.json({ ...g, members, former, led_groups, solid_target: prog.target(prog.settings(db)) });
}));

// POST /api/lifegroups
router.post('/', requirePermission('lifegroups:manage'), wrap((req, res) => {
  const db = getDb();
  const data = validateGroup(req.body || {});
  if (data.leader_person_id && !db.prepare('SELECT 1 FROM people WHERE id = ?').get(data.leader_person_id)) throw new HttpError(400, 'Leader must be a registered person.');
  if (data.network_id && !db.prepare('SELECT 1 FROM networks WHERE id = ?').get(data.network_id)) throw new HttpError(400, 'Network not found.');
  checkGenderRules(db, data);
  const info = db.prepare(`INSERT INTO lifegroups (name, gender, leader_person_id, leader_name, network_id, network_manual, network, area, schedule_day, schedule_time, category, capacity, venue, notes, is_active, created_by)
    VALUES (@name, @gender, @leader_person_id, @leader_name, @network_id, @network_manual, @network, @area, @schedule_day, @schedule_time, @category, @capacity, @venue, @notes, @is_active, @created_by)`).run({ ...data, created_by: req.user.id });
  syncNetworks(db, req.user);
  const g = getGroup(db, info.lastInsertRowid, req.user);
  activity.log(db, req.user, 'lifegroup.create', 'lifegroup', g.id, `Created Lifegroup ${g.name}${g.leader_name ? ' (leader ' + g.leader_name + ')' : ''}`);
  res.status(201).json(g);
}));

// PUT /api/lifegroups/:id
router.put('/:id', requirePermission('lifegroups:manage'), wrap((req, res) => {
  const db = getDb();
  const id = intId(req.params.id);
  const existing = db.prepare('SELECT * FROM lifegroups WHERE id = ?').get(id);
  if (!existing) throw new HttpError(404, 'Lifegroup not found.');
  const data = validateGroup(req.body || {}, existing);
  if (data.leader_person_id && !db.prepare('SELECT 1 FROM people WHERE id = ?').get(data.leader_person_id)) throw new HttpError(400, 'Leader must be a registered person.');
  if (data.network_id && !db.prepare('SELECT 1 FROM networks WHERE id = ?').get(data.network_id)) throw new HttpError(400, 'Network not found.');
  checkGenderRules(db, data, id);
  db.prepare(`UPDATE lifegroups SET name=@name, gender=@gender, leader_person_id=@leader_person_id, leader_name=@leader_name, network_id=@network_id, network_manual=@network_manual, network=@network, area=@area,
      schedule_day=@schedule_day, schedule_time=@schedule_time, category=@category, capacity=@capacity, venue=@venue, notes=@notes,
      is_active=@is_active, updated_at=datetime('now') WHERE id=@id`).run({ ...data, id });
  syncNetworks(db, req.user);
  const changed = Object.keys(data).filter((k) => (existing[k] ?? null) !== (data[k] ?? null));
  activity.log(db, req.user, 'lifegroup.update', 'lifegroup', id, `Edited Lifegroup ${data.name}${changed.length ? ': ' + changed.join(', ') : ''}`);
  res.json(getGroup(db, id, req.user));
}));

// DELETE /api/lifegroups/:id — admin; only when it never had members
router.delete('/:id', requirePermission('people:delete'), wrap((req, res) => {
  const db = getDb();
  const id = intId(req.params.id);
  const g = db.prepare('SELECT name FROM lifegroups WHERE id = ?').get(id);
  if (!g) throw new HttpError(404, 'Lifegroup not found.');
  const n = db.prepare('SELECT COUNT(*) n FROM lifegroup_memberships WHERE lifegroup_id = ?').get(id).n;
  if (n) throw new HttpError(409, 'This Lifegroup has membership history and cannot be deleted. Mark it inactive instead.');
  db.prepare('DELETE FROM lifegroups WHERE id = ?').run(id);
  activity.log(db, req.user, 'lifegroup.delete', 'lifegroup', id, `Deleted empty Lifegroup ${g.name}`);
  res.status(204).end();
}));

// ---------------------------------------------------------------------------
// Membership: POST /api/lifegroups/:id/members { person_id, joined_at?, role?, notes? }
//   Closes any current membership (history is kept) and opens the new one.
// ---------------------------------------------------------------------------
function assign(db, user, { personId, groupId, joinedAt, role, notes }) {
  const g = db.prepare('SELECT * FROM lifegroups WHERE id = ?').get(groupId);
  if (!g) throw new HttpError(404, 'Lifegroup not found.');
  if (!g.is_active) throw new HttpError(400, 'That Lifegroup is inactive.');
  const p = db.prepare('SELECT id, first_name, last_name, person_code, sex FROM people WHERE id = ?').get(personId);
  if (!p) throw new HttpError(404, 'Person not found.');
  if (!p.sex) throw new HttpError(400, `Set Boy or Girl on ${p.first_name}'s profile first — ${g.name} is a ${GENDER_LABEL[g.gender] || 'group'} and groups are never mixed.`);
  if (g.gender && p.sex !== SEX_OF[g.gender]) throw new HttpError(409, `${p.first_name} ${p.last_name} cannot join ${g.name}: it is a ${GENDER_LABEL[g.gender]} and groups are never mixed.`);
  const date = joinedAt || today();
  if (!isValidDate(date)) throw new HttpError(400, 'Joined date must be a valid date.');
  if (role && !['member', 'leader', 'assistant'].includes(role)) throw new HttpError(400, 'Invalid role.');
  const cur = db.prepare('SELECT * FROM lifegroup_memberships WHERE person_id = ? AND left_at IS NULL').get(p.id);
  if (cur && cur.lifegroup_id === g.id) return { person: p, group: g, unchanged: true };
  prog.assertRoom(db, g.id, g.name, p.id); // 6-member rule for a network leader's own group; a Network leader is never a member
  db.transaction(() => {
    if (cur) db.prepare('UPDATE lifegroup_memberships SET left_at = ? WHERE id = ?').run(date, cur.id);
    db.prepare('INSERT INTO lifegroup_memberships (person_id, lifegroup_id, role, joined_at, notes, assigned_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.id, g.id, role || 'member', date, clean(notes), user.id);
  })();
  const prev = cur ? db.prepare('SELECT name FROM lifegroups WHERE id = ?').get(cur.lifegroup_id)?.name : null;
  activity.log(db, user, 'lifegroup.assign', 'person', p.id, `${p.first_name} ${p.last_name} (${p.person_code}) ${prev ? `moved from ${prev} to` : 'joined'} ${g.name}`);
  syncNetworks(db, user);
  return { person: p, group: g, unchanged: false };
}

router.post('/:id/members', requirePermission('lifegroups:manage'), wrap((req, res) => {
  const db = getDb();
  const groupId = intId(req.params.id);
  const personId = intId(req.body?.person_id, 'person id');
  const out = assign(db, req.user, { personId, groupId, joinedAt: clean(req.body?.joined_at), role: clean(req.body?.role), notes: req.body?.notes });
  res.status(out.unchanged ? 200 : 201).json({ ...membershipFor(db, personId, req.user), unchanged: out.unchanged });
}));

// DELETE /api/lifegroups/:id/members/:personId?left_at= — leave the group (history kept)
router.delete('/:id/members/:personId', requirePermission('lifegroups:manage'), wrap((req, res) => {
  const db = getDb();
  const groupId = intId(req.params.id); const personId = intId(req.params.personId, 'person id');
  const cur = db.prepare('SELECT m.*, g.name FROM lifegroup_memberships m JOIN lifegroups g ON g.id = m.lifegroup_id WHERE m.person_id = ? AND m.lifegroup_id = ? AND m.left_at IS NULL').get(personId, groupId);
  if (!cur) throw new HttpError(404, 'No current membership in that group.');
  const date = clean(req.query.left_at) || today();
  if (!isValidDate(date)) throw new HttpError(400, 'Left date must be a valid date.');
  db.prepare('UPDATE lifegroup_memberships SET left_at = ? WHERE id = ?').run(date, cur.id);
  const p = db.prepare('SELECT first_name, last_name, person_code FROM people WHERE id = ?').get(personId);
  activity.log(db, req.user, 'lifegroup.leave', 'person', personId, `${p.first_name} ${p.last_name} (${p.person_code}) left ${cur.name}`);
  syncNetworks(db, req.user);
  res.json(membershipFor(db, personId, req.user));
}));

module.exports = router;
module.exports.membershipFor = membershipFor;
module.exports.overview = overview;
module.exports.DAYS = DAYS;
module.exports.TIMES = TIMES;
