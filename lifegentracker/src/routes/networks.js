'use strict';

/**
 * Networks: the layer above Lifegroups. Each Network has a leader; each Lifegroup
 * belongs to a Network, so a Lifegroup leader "reports to" the Network leader.
 *
 * NON-NEGOTIABLE: every Network is an independent root. A Network leader is never under
 * another Network leader and there are no sub-networks — enforced here (requests carrying a
 * parent are rejected), in the database (trigger / CHECK: parent_network_id must be NULL) and
 * in the UI (no parent picker, separate cards per Network).
 */
const express = require('express');
const { getDb } = require('../db');
const { clean, HttpError, wrap, intId } = require('../lib/util');
const { requirePermission, can } = require('../middleware/auth');
const activity = require('../services/activity');
const prog = require('../services/lifegroup-progress');
const { syncNetworks } = require('../services/networks-auto');

const router = express.Router();
const SEX_OF = { boys: 'male', girls: 'female' };
const WORD = { boys: 'boys', girls: 'girls' };

// "not the network leader's own Lifegroup" (that group holds the cell leaders, so it is counted separately)
const NOT_OWN = '(n.leader_person_id IS NULL OR g.leader_person_id IS NULL OR g.leader_person_id <> n.leader_person_id)';
const NET_SELECT = `
  SELECT n.*, lp.first_name AS lf, lp.last_name AS ll, lp.person_code AS leader_code, lp.contact_number AS leader_contact,
         (SELECT COUNT(*) FROM lifegroups g WHERE g.network_id = n.id AND g.is_active = 1 AND ${NOT_OWN}) AS group_count,
         (SELECT COUNT(*) FROM lifegroup_memberships m JOIN lifegroups g ON g.id = m.lifegroup_id JOIN people p ON p.id = m.person_id
           WHERE g.network_id = n.id AND m.left_at IS NULL AND p.archived_at IS NULL AND ${NOT_OWN}) AS people_count,
         (SELECT COUNT(*) FROM lifegroup_memberships m JOIN lifegroups g ON g.id = m.lifegroup_id JOIN people p ON p.id = m.person_id
           WHERE g.network_id = n.id AND m.left_at IS NULL AND p.archived_at IS NULL AND p.sex = 'male' AND ${NOT_OWN}) AS boys,
         (SELECT COUNT(*) FROM lifegroup_memberships m JOIN lifegroups g ON g.id = m.lifegroup_id JOIN people p ON p.id = m.person_id
           WHERE g.network_id = n.id AND m.left_at IS NULL AND p.archived_at IS NULL AND p.sex = 'female' AND ${NOT_OWN}) AS girls,
         (SELECT COUNT(*) FROM lifegroups g WHERE g.network_id = n.id AND g.is_active = 1 AND g.gender = 'boys' AND ${NOT_OWN}) AS boys_groups,
         (SELECT COUNT(*) FROM lifegroups g WHERE g.network_id = n.id AND g.is_active = 1 AND g.gender = 'girls' AND ${NOT_OWN}) AS girls_groups,
         (SELECT COUNT(DISTINCT COALESCE('p' || g.leader_person_id, 'n' || g.leader_name)) FROM lifegroups g
           WHERE g.network_id = n.id AND g.is_active = 1 AND (g.leader_person_id IS NOT NULL OR g.leader_name IS NOT NULL) AND ${NOT_OWN}) AS leader_count,
         (SELECT COUNT(*) FROM lifegroup_memberships m JOIN lifegroups g ON g.id = m.lifegroup_id JOIN people p ON p.id = m.person_id
           WHERE n.leader_person_id IS NOT NULL AND g.leader_person_id = n.leader_person_id AND g.is_active = 1 AND m.left_at IS NULL AND p.archived_at IS NULL) AS cell_leaders,
         (SELECT COUNT(*) FROM lifegroup_memberships m JOIN lifegroups g ON g.id = m.lifegroup_id JOIN people p ON p.id = m.person_id
           WHERE g.network_id = n.id AND g.is_active = 1 AND m.left_at IS NULL AND p.archived_at IS NULL AND m.tier = 'solid' AND ${NOT_OWN}) AS closed_cell,
         (SELECT MAX(mt.meeting_date) FROM lifegroup_meetings mt JOIN lifegroups g ON g.id = mt.lifegroup_id WHERE g.network_id = n.id AND mt.held = 1) AS last_held
    FROM networks n
    LEFT JOIN people lp ON lp.id = n.leader_person_id`;

function shape(n, user) {
  if (!n) return n;
  const out = { ...n, leader_name: n.leader_person_id ? `${n.lf} ${n.ll}` : n.leader_name };
  delete out.parent_network_id; // networks are independent roots — there is no parent
  for (const k of ['group_count', 'people_count', 'boys', 'girls', 'boys_groups', 'girls_groups', 'leader_count', 'cell_leaders', 'closed_cell']) if (out[k] != null) out[k] = Number(out[k]);
  out.open_cell = Math.max(0, (out.people_count || 0) - (out.closed_cell || 0));
  if (!can(user, 'people:view_private')) out.leader_contact = undefined;
  delete out.lf; delete out.ll;
  return out;
}
const getNetwork = (db, id, user) => shape(db.prepare(`${NET_SELECT} WHERE n.id = ?`).get(id), user);

function validate(db, body, existing = null) {
  const src = existing ? { ...existing, ...body } : body;
  const data = {
    name: clean(src.name),
    leader_person_id: src.leader_person_id ? Number(src.leader_person_id) : null,
    leader_name: clean(src.leader_name),
    notes: clean(src.notes),
    gender: clean(src.gender) || null,
    is_active: src.is_active === undefined ? 1 : (src.is_active ? 1 : 0),
  };
  const errors = [];
  // Independent networks: any attempt to nest (parent_network_id / parent_id / parent) is refused outright.
  for (const k of ['parent_network_id', 'parent_id', 'parent']) {
    if (body[k] !== undefined && body[k] !== null && body[k] !== '' && body[k] !== 0 && body[k] !== '0') {
      errors.push('Networks are independent — a Network leader is always the root of their own Network and can never be placed under another Network leader.');
      break;
    }
  }
  if (!data.name) errors.push('Network name is required.');
  // A Network is either a boys network or a girls network — never combined.
  if (!['boys', 'girls'].includes(data.gender)) errors.push('Choose whether this is a boys network or a girls network.');
  const word = WORD[data.gender] || 'this';
  if (data.leader_person_id) {
    const lp = db.prepare('SELECT first_name, last_name, sex FROM people WHERE id = ?').get(data.leader_person_id);
    if (!lp) errors.push('Leader must be a registered person.');
    else if (data.gender && lp.sex && lp.sex !== SEX_OF[data.gender]) errors.push(`${lp.first_name} ${lp.last_name} cannot lead a ${word} network — networks are never mixed.`);
    else if (data.gender && !lp.sex) errors.push(`Set Boy or Girl on ${lp.first_name} ${lp.last_name}'s profile first.`);
    if (lp) {
      // one person = one independent Network
      const other = db.prepare('SELECT id, name FROM networks WHERE leader_person_id = ? AND is_active = 1 AND id <> ?').get(data.leader_person_id, existing ? existing.id : 0);
      if (other) errors.push(`${lp.first_name} ${lp.last_name} already leads ${other.name}. A Network leader has exactly one independent Network — pick another leader or edit that Network instead.`);
      // a Network leader is a root: they cannot sit inside another leader's Lifegroup
      const inGroup = db.prepare(`SELECT g.name, COALESCE(l.first_name || ' ' || l.last_name, g.leader_name) AS leader FROM lifegroup_memberships m JOIN lifegroups g ON g.id = m.lifegroup_id
          LEFT JOIN people l ON l.id = g.leader_person_id WHERE m.person_id = ? AND m.left_at IS NULL AND g.is_active = 1 AND (g.leader_person_id IS NULL OR g.leader_person_id <> ?) LIMIT 1`).get(data.leader_person_id, data.leader_person_id);
      if (inGroup) errors.push(`${lp.first_name} ${lp.last_name} is still a member of ${inGroup.name}${inGroup.leader ? ' (' + inGroup.leader + ')' : ''}. A Network leader is independent and cannot be under another leader — remove them from that Lifegroup first.`);
    }
  }
  if (existing && data.gender && data.gender !== existing.gender) {
    // flipping the type is only allowed when nothing inside would become mixed
    const badGroups = db.prepare("SELECT COUNT(*) AS n FROM lifegroups WHERE network_id = ? AND is_active = 1 AND gender IS NOT NULL AND gender <> ?").get(existing.id, data.gender).n;
    if (badGroups) errors.push(`This network still has ${badGroups} ${data.gender === 'boys' ? 'girls' : 'boys'} group${badGroups === 1 ? '' : 's'} — move them to another network first.`);
  }
  if (errors.length) throw new HttpError(400, errors.join(' '), errors);
  return data;
}

// GET /api/networks?status=active|inactive|all
router.get('/', requirePermission('lifegroups:view'), wrap((req, res) => {
  const db = getDb();
  const status = clean(req.query.status) || 'active';
  const where = status === 'active' ? 'WHERE n.is_active = 1' : status === 'inactive' ? 'WHERE n.is_active = 0' : '';
  const rows = db.prepare(`${NET_SELECT} ${where} ORDER BY n.is_active DESC, n.name COLLATE NOCASE`).all().map((n) => shape(n, req.user));
  res.json(withTotals(rows));
}));

/** total_* fields — kept for API compatibility. Networks are independent, so totals = the network's own counts. */
function withTotals(rows) {
  for (const n of rows) Object.assign(n, { total_groups: n.group_count, total_people: n.people_count, total_boys: n.boys, total_girls: n.girls, total_leaders: n.leader_count, total_boys_groups: n.boys_groups, total_girls_groups: n.girls_groups });
  return rows;
}

// GET /api/networks/:id/calendar — week-by-week: did the leader's own group and each group under it meet?
router.get('/:id/calendar', requirePermission('lifegroups:view'), wrap((req, res) => {
  res.json(prog.networkCalendar(getDb(), intId(req.params.id), { weeks: Math.min(Math.max(Number(req.query.weeks) || 8, 4), 26), withMembers: req.query.members === '1' }));
}));

// GET /api/networks/:id — one independent network: its leader, its Lifegroups (with leaders + members). Never other networks.
router.get('/:id', requirePermission('lifegroups:view'), wrap((req, res) => {
  const db = getDb();
  const n = getNetwork(db, intId(req.params.id), req.user);
  if (!n) throw new HttpError(404, 'Network not found.');
  const groups = db.prepare(`
    SELECT g.id, g.name, g.gender, g.area, g.schedule_day, g.schedule_time, g.capacity, g.is_active, g.leader_person_id,
           COALESCE(lp.first_name || ' ' || lp.last_name, g.leader_name) AS leader_name,
           CASE WHEN g.leader_person_id IS NOT NULL AND g.leader_person_id = ? THEN 1 ELSE 0 END AS is_leader_group,
           (SELECT COUNT(*) FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id WHERE m.lifegroup_id = g.id AND m.left_at IS NULL AND p.archived_at IS NULL) AS member_count
      FROM lifegroups g LEFT JOIN people lp ON lp.id = g.leader_person_id
     WHERE g.network_id = ? ORDER BY g.is_active DESC, g.name COLLATE NOCASE`).all(n.leader_person_id || 0, n.id);
  const memberStmt = db.prepare(`SELECT p.id, p.person_code, p.first_name, p.last_name, p.photo, p.sex, p.status, m.role, m.tier, m.joined_at
      FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id
     WHERE m.lifegroup_id = ? AND m.left_at IS NULL AND p.archived_at IS NULL
     ORDER BY m.role = 'member', p.last_name COLLATE NOCASE, p.first_name COLLATE NOCASE`);
  for (const g of groups) {
    g.is_leader_group = Boolean(Number(g.is_leader_group));
    g.members = memberStmt.all(g.id);
    g.boys = g.members.filter((m) => m.sex === 'male').length;
    g.girls = g.members.filter((m) => m.sex === 'female').length;
  }
  res.json({ ...n, groups });
}));

router.post('/', requirePermission('lifegroups:manage'), wrap((req, res) => {
  const db = getDb();
  const data = validate(db, req.body || {});
  // Always a new independent root: never attached to a selected / current / previously created network.
  const info = db.prepare(`INSERT INTO networks (name, gender, leader_person_id, leader_name, notes, is_active, created_by)
    VALUES (@name, @gender, @leader_person_id, @leader_name, @notes, @is_active, @created_by)`).run({ ...data, created_by: req.user.id });
  syncNetworks(db, req.user); // the leader's own Lifegroup (if any) moves into this network
  const n = getNetwork(db, info.lastInsertRowid, req.user);
  activity.log(db, req.user, 'network.create', 'network', n.id, `Created ${n.gender} Network ${n.name}${n.leader_name ? ' (leader ' + n.leader_name + ')' : ''}`);
  res.status(201).json(n);
}));

router.put('/:id', requirePermission('lifegroups:manage'), wrap((req, res) => {
  const db = getDb();
  const id = intId(req.params.id);
  const existing = db.prepare('SELECT * FROM networks WHERE id = ?').get(id);
  if (!existing) throw new HttpError(404, 'Network not found.');
  const data = validate(db, req.body || {}, existing);
  db.prepare(`UPDATE networks SET name=@name, gender=@gender, leader_person_id=@leader_person_id, leader_name=@leader_name,
      notes=@notes, is_active=@is_active, updated_at=datetime('now') WHERE id=@id`).run({ ...data, id });
  syncNetworks(db, req.user);
  activity.log(db, req.user, 'network.update', 'network', id, `Edited Network ${data.name}`);
  res.json(getNetwork(db, id, req.user));
}));

// DELETE — admin; only when no Lifegroups reference it
router.delete('/:id', requirePermission('people:delete'), wrap((req, res) => {
  const db = getDb();
  const id = intId(req.params.id);
  const n = db.prepare('SELECT name FROM networks WHERE id = ?').get(id);
  if (!n) throw new HttpError(404, 'Network not found.');
  const used = db.prepare('SELECT COUNT(*) AS n FROM lifegroups WHERE network_id = ?').get(id).n;
  if (used) throw new HttpError(409, 'This Network still has Lifegroups. Move them first or mark the Network inactive.');
  db.prepare('DELETE FROM networks WHERE id = ?').run(id);
  activity.log(db, req.user, 'network.delete', 'network', id, `Deleted empty Network ${n.name}`);
  res.status(204).end();
}));

/** Leadership summary for a person: what they lead and who they report to. */
function leadershipFor(db, personId) {
  const leads_groups = db.prepare(`SELECT g.id, g.name, g.area, g.network_id, n.name AS network_name FROM lifegroups g LEFT JOIN networks n ON n.id = g.network_id
    WHERE g.leader_person_id = ? AND g.is_active = 1 ORDER BY g.name`).all(personId);
  const leads_networks = db.prepare(`SELECT id, name FROM networks WHERE leader_person_id = ? AND is_active = 1 ORDER BY name`).all(personId);
  // Who they report to: Lifegroup leader of their current group → that group's Network leader. A Network leader is a root (reports to no one).
  const chain = [];
  if (leads_networks.length) return { leads_groups, leads_networks, reports_to: chain };
  const cur = db.prepare(`SELECT g.id AS group_id, g.name AS group_name, g.leader_person_id, COALESCE(lp.first_name || ' ' || lp.last_name, g.leader_name) AS leader_name, g.network_id
    FROM lifegroup_memberships m JOIN lifegroups g ON g.id = m.lifegroup_id LEFT JOIN people lp ON lp.id = g.leader_person_id
    WHERE m.person_id = ? AND m.left_at IS NULL`).get(personId);
  let networkId = null;
  if (cur) {
    if (cur.leader_person_id !== personId && cur.leader_name) chain.push({ level: 'Lifegroup leader', name: cur.leader_name, person_id: cur.leader_person_id, via: cur.group_name, group_id: cur.group_id });
    networkId = cur.network_id;
  } else if (leads_groups.length) networkId = leads_groups[0].network_id;
  if (networkId) {
    const n = db.prepare(`SELECT n.id, n.name, n.leader_person_id, COALESCE(lp.first_name || ' ' || lp.last_name, n.leader_name) AS leader_name
      FROM networks n LEFT JOIN people lp ON lp.id = n.leader_person_id WHERE n.id = ?`).get(networkId);
    const last = chain[chain.length - 1];
    if (n && n.leader_person_id !== personId && n.leader_name && !(last && last.person_id && last.person_id === n.leader_person_id)) chain.push({ level: 'Network leader', name: n.leader_name, person_id: n.leader_person_id, via: n.name, network_id: n.id });
  }
  return { leads_groups, leads_networks, reports_to: chain };
}

module.exports = router;
module.exports.leadershipFor = leadershipFor;
