'use strict';

/**
 * Networks: the layer above Lifegroups. Each Network has a leader; each Lifegroup
 * belongs to a Network, so a Lifegroup leader "reports to" the Network leader.
 */
const express = require('express');
const { getDb } = require('../db');
const { clean, HttpError, wrap, intId } = require('../lib/util');
const { requirePermission, can } = require('../middleware/auth');
const activity = require('../services/activity');
const prog = require('../services/lifegroup-progress');

const router = express.Router();
const SEX_OF = { boys: 'male', girls: 'female' };
const WORD = { boys: 'boys', girls: 'girls' };

const NET_SELECT = `
  SELECT n.*, lp.first_name AS lf, lp.last_name AS ll, lp.person_code AS leader_code, lp.contact_number AS leader_contact,
         pn.name AS parent_name,
         (SELECT COUNT(*) FROM lifegroups g WHERE g.network_id = n.id AND g.is_active = 1) AS group_count,
         (SELECT COUNT(*) FROM lifegroup_memberships m JOIN lifegroups g ON g.id = m.lifegroup_id JOIN people p ON p.id = m.person_id
           WHERE g.network_id = n.id AND m.left_at IS NULL AND p.archived_at IS NULL) AS people_count,
         (SELECT COUNT(*) FROM networks c WHERE c.parent_network_id = n.id AND c.is_active = 1) AS child_count,
         (SELECT COUNT(*) FROM lifegroup_memberships m JOIN lifegroups g ON g.id = m.lifegroup_id JOIN people p ON p.id = m.person_id
           WHERE g.network_id = n.id AND m.left_at IS NULL AND p.archived_at IS NULL AND p.sex = 'male') AS boys,
         (SELECT COUNT(*) FROM lifegroup_memberships m JOIN lifegroups g ON g.id = m.lifegroup_id JOIN people p ON p.id = m.person_id
           WHERE g.network_id = n.id AND m.left_at IS NULL AND p.archived_at IS NULL AND p.sex = 'female') AS girls,
         (SELECT COUNT(*) FROM lifegroups g WHERE g.network_id = n.id AND g.is_active = 1 AND g.gender = 'boys') AS boys_groups,
         (SELECT COUNT(*) FROM lifegroups g WHERE g.network_id = n.id AND g.is_active = 1 AND g.gender = 'girls') AS girls_groups,
         (SELECT COUNT(DISTINCT COALESCE('p' || g.leader_person_id, 'n' || g.leader_name)) FROM lifegroups g
           WHERE g.network_id = n.id AND g.is_active = 1 AND (g.leader_person_id IS NOT NULL OR g.leader_name IS NOT NULL)) AS leader_count
    FROM networks n
    LEFT JOIN people lp ON lp.id = n.leader_person_id
    LEFT JOIN networks pn ON pn.id = n.parent_network_id`;

function shape(n, user) {
  if (!n) return n;
  const out = { ...n, leader_name: n.leader_person_id ? `${n.lf} ${n.ll}` : n.leader_name };
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
    parent_network_id: src.parent_network_id ? Number(src.parent_network_id) : null,
    notes: clean(src.notes),
    gender: clean(src.gender) || null,
    is_active: src.is_active === undefined ? 1 : (src.is_active ? 1 : 0),
  };
  const errors = [];
  if (!data.name) errors.push('Network name is required.');
  // A Network is either a boys network or a girls network — never combined.
  if (!['boys', 'girls'].includes(data.gender)) errors.push('Choose whether this is a boys network or a girls network.');
  const word = WORD[data.gender] || 'this';
  if (data.leader_person_id) {
    const lp = db.prepare('SELECT first_name, last_name, sex FROM people WHERE id = ?').get(data.leader_person_id);
    if (!lp) errors.push('Leader must be a registered person.');
    else if (data.gender && lp.sex && lp.sex !== SEX_OF[data.gender]) errors.push(`${lp.first_name} ${lp.last_name} cannot lead a ${word} network — networks are never mixed.`);
    else if (data.gender && !lp.sex) errors.push(`Set Boy or Girl on ${lp.first_name} ${lp.last_name}'s profile first.`);
  }
  if (existing && data.gender && data.gender !== existing.gender) {
    // flipping the type is only allowed when nothing inside would become mixed
    const badGroups = db.prepare("SELECT COUNT(*) AS n FROM lifegroups WHERE network_id = ? AND is_active = 1 AND gender IS NOT NULL AND gender <> ?").get(existing.id, data.gender).n;
    const badKids = db.prepare("SELECT COUNT(*) AS n FROM networks WHERE parent_network_id = ? AND is_active = 1 AND gender IS NOT NULL AND gender <> ?").get(existing.id, data.gender).n;
    if (badGroups) errors.push(`This network still has ${badGroups} ${data.gender === 'boys' ? 'girls' : 'boys'} group${badGroups === 1 ? '' : 's'} — move them to another network first.`);
    if (badKids) errors.push(`This network still has ${badKids} ${data.gender === 'boys' ? 'girls' : 'boys'} sub-network${badKids === 1 ? '' : 's'} — move them first.`);
  }
  if (data.parent_network_id) {
    const parent = db.prepare('SELECT id, name, gender FROM networks WHERE id = ?').get(data.parent_network_id);
    if (existing && data.parent_network_id === existing.id) errors.push('A network cannot be its own parent.');
    else if (!parent) errors.push('Parent network not found.');
    else if (data.gender && parent.gender && parent.gender !== data.gender) errors.push(`${parent.name} is a ${WORD[parent.gender]} network — a ${word} network cannot be under it.`);
    else if (existing) {
      // prevent cycles: walk up from the chosen parent
      let cur = data.parent_network_id; let hops = 0;
      while (cur && hops++ < 50) { if (cur === existing.id) { errors.push('That parent would create a loop.'); break; } cur = db.prepare('SELECT parent_network_id AS p FROM networks WHERE id = ?').get(cur)?.p; }
    }
  }
  if (errors.length) throw new HttpError(400, errors.join(' '), errors);
  return data;
}

// GET /api/networks?status=active|inactive|all
router.get('/', requirePermission('lifegroups:view'), wrap((req, res) => {
  const db = getDb();
  const status = clean(req.query.status) || 'active';
  const where = status === 'active' ? 'WHERE n.is_active = 1' : status === 'inactive' ? 'WHERE n.is_active = 0' : '';
  const rows = db.prepare(`${NET_SELECT} ${where} ORDER BY n.is_active DESC, n.parent_network_id IS NOT NULL, n.name COLLATE NOCASE`).all().map((n) => shape(n, req.user));
  res.json(withTotals(rows));
}));

/** Adds total_* fields = own counts + every descendant network's counts (so a main network shows the whole tree). */
function withTotals(rows) {
  const byParent = new Map();
  rows.forEach((n) => { const k = n.parent_network_id || 0; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(n); });
  const sum = (n, depth = 0) => {
    const t = { total_groups: n.group_count, total_people: n.people_count, total_boys: n.boys, total_girls: n.girls, total_leaders: n.leader_count, total_boys_groups: n.boys_groups, total_girls_groups: n.girls_groups };
    if (depth < 20) for (const c of byParent.get(n.id) || []) { const ct = sum(c, depth + 1); for (const k of Object.keys(t)) t[k] += ct[k]; }
    Object.assign(n, t);
    return t;
  };
  rows.filter((n) => !n.parent_network_id || !rows.some((x) => x.id === n.parent_network_id)).forEach((n) => sum(n));
  return rows;
}

// GET /api/networks/:id/calendar — week-by-week: did the leader's own group and each group under it meet?
router.get('/:id/calendar', requirePermission('lifegroups:view'), wrap((req, res) => {
  res.json(prog.networkCalendar(getDb(), intId(req.params.id), { weeks: Math.min(Math.max(Number(req.query.weeks) || 8, 4), 26) }));
}));

// GET /api/networks/:id — network + its groups (with leaders) + child networks
router.get('/:id', requirePermission('lifegroups:view'), wrap((req, res) => {
  const db = getDb();
  const n = getNetwork(db, intId(req.params.id), req.user);
  if (!n) throw new HttpError(404, 'Network not found.');
  const groups = db.prepare(`
    SELECT g.id, g.name, g.gender, g.area, g.schedule_day, g.schedule_time, g.capacity, g.is_active, g.leader_person_id,
           COALESCE(lp.first_name || ' ' || lp.last_name, g.leader_name) AS leader_name,
           (SELECT COUNT(*) FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id WHERE m.lifegroup_id = g.id AND m.left_at IS NULL AND p.archived_at IS NULL) AS member_count
      FROM lifegroups g LEFT JOIN people lp ON lp.id = g.leader_person_id
     WHERE g.network_id = ? ORDER BY g.is_active DESC, g.name COLLATE NOCASE`).all(n.id);
  const memberStmt = db.prepare(`SELECT p.id, p.person_code, p.first_name, p.last_name, p.photo, p.sex, p.status, m.role, m.joined_at
      FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id
     WHERE m.lifegroup_id = ? AND m.left_at IS NULL AND p.archived_at IS NULL
     ORDER BY m.role = 'member', p.last_name COLLATE NOCASE, p.first_name COLLATE NOCASE`);
  for (const g of groups) {
    g.members = memberStmt.all(g.id);
    g.boys = g.members.filter((m) => m.sex === 'male').length;
    g.girls = g.members.filter((m) => m.sex === 'female').length;
  }
  const children = withTotals(db.prepare(`${NET_SELECT} WHERE n.parent_network_id = ? ORDER BY n.name COLLATE NOCASE`).all(n.id).map((c) => shape(c, req.user)));
  res.json({ ...n, groups, children });
}));

router.post('/', requirePermission('lifegroups:manage'), wrap((req, res) => {
  const db = getDb();
  const data = validate(db, req.body || {});
  const info = db.prepare(`INSERT INTO networks (name, gender, leader_person_id, leader_name, parent_network_id, notes, is_active, created_by)
    VALUES (@name, @gender, @leader_person_id, @leader_name, @parent_network_id, @notes, @is_active, @created_by)`).run({ ...data, created_by: req.user.id });
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
  db.prepare(`UPDATE networks SET name=@name, gender=@gender, leader_person_id=@leader_person_id, leader_name=@leader_name, parent_network_id=@parent_network_id,
      notes=@notes, is_active=@is_active, updated_at=datetime('now') WHERE id=@id`).run({ ...data, id });
  activity.log(db, req.user, 'network.update', 'network', id, `Edited Network ${data.name}`);
  res.json(getNetwork(db, id, req.user));
}));

// DELETE — admin; only when no groups/children reference it
router.delete('/:id', requirePermission('people:delete'), wrap((req, res) => {
  const db = getDb();
  const id = intId(req.params.id);
  const n = db.prepare('SELECT name FROM networks WHERE id = ?').get(id);
  if (!n) throw new HttpError(404, 'Network not found.');
  const used = db.prepare('SELECT (SELECT COUNT(*) FROM lifegroups WHERE network_id = ?) + (SELECT COUNT(*) FROM networks WHERE parent_network_id = ?) AS n').get(id, id).n;
  if (used) throw new HttpError(409, 'This Network still has Lifegroups or sub-networks. Move them first or mark the Network inactive.');
  db.prepare('DELETE FROM networks WHERE id = ?').run(id);
  activity.log(db, req.user, 'network.delete', 'network', id, `Deleted empty Network ${n.name}`);
  res.status(204).end();
}));

/** Leadership summary for a person: what they lead and who they report to. */
function leadershipFor(db, personId) {
  const leads_groups = db.prepare(`SELECT g.id, g.name, g.area, g.network_id, n.name AS network_name FROM lifegroups g LEFT JOIN networks n ON n.id = g.network_id
    WHERE g.leader_person_id = ? AND g.is_active = 1 ORDER BY g.name`).all(personId);
  const leads_networks = db.prepare(`SELECT id, name, parent_network_id FROM networks WHERE leader_person_id = ? AND is_active = 1 ORDER BY name`).all(personId);
  // Who they report to: group leader of their current group → network leader of that group's network → parent network leader…
  const chain = [];
  const cur = db.prepare(`SELECT g.id AS group_id, g.name AS group_name, g.leader_person_id, COALESCE(lp.first_name || ' ' || lp.last_name, g.leader_name) AS leader_name, g.network_id
    FROM lifegroup_memberships m JOIN lifegroups g ON g.id = m.lifegroup_id LEFT JOIN people lp ON lp.id = g.leader_person_id
    WHERE m.person_id = ? AND m.left_at IS NULL`).get(personId);
  let networkId = null;
  if (cur) {
    if (cur.leader_person_id !== personId && cur.leader_name) chain.push({ level: 'Lifegroup leader', name: cur.leader_name, person_id: cur.leader_person_id, via: cur.group_name, group_id: cur.group_id });
    networkId = cur.network_id;
  } else if (leads_groups.length) networkId = leads_groups[0].network_id;
  else if (leads_networks.length) networkId = leads_networks[0].parent_network_id;
  let hops = 0;
  while (networkId && hops++ < 20) {
    const n = db.prepare(`SELECT n.id, n.name, n.parent_network_id, n.leader_person_id, COALESCE(lp.first_name || ' ' || lp.last_name, n.leader_name) AS leader_name
      FROM networks n LEFT JOIN people lp ON lp.id = n.leader_person_id WHERE n.id = ?`).get(networkId);
    if (!n) break;
    const last = chain[chain.length - 1];
    if (n.leader_person_id !== personId && n.leader_name && !(last && last.person_id && last.person_id === n.leader_person_id)) chain.push({ level: 'Network leader', name: n.leader_name, person_id: n.leader_person_id, via: n.name, network_id: n.id });
    networkId = n.parent_network_id;
  }
  return { leads_groups, leads_networks, reports_to: chain };
}

module.exports = router;
module.exports.leadershipFor = leadershipFor;
