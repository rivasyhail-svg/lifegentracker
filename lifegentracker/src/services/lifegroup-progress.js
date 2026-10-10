'use strict';
/**
 * Lifegroup progress: solid/new members, weekly meeting reports (from the leader's private link
 * or from staff), per-group / per-network calendars and the overall statistics.
 * Weeks run Monday–Sunday in church time, matching the rest of the app.
 */
const crypto = require('crypto');
const { clean, isValidDate, HttpError } = require('../lib/util');
const { splitFullName, normalizeName, tidyName } = require('../lib/normalize');
const guard = require('./qrguard');
const activity = require('./activity');
const { syncNetworks } = require('./networks-auto');

const SEX_OF = { boys: 'male', girls: 'female' };

function settings(db) {
  const out = {};
  for (const r of db.prepare("SELECT key, value FROM settings WHERE key IN ('lifegroup_solid_target', 'qr_timezone', 'church_name')").all()) out[r.key] = r.value;
  return out;
}
const target = (s) => Math.max(1, Number(s.lifegroup_solid_target) || 6);

/**
 * Church rule: a network leader's own Lifegroup holds at most 6 members (they are leaders themselves).
 * Returns the cap for a group (6 when its leader currently leads an active network, else the group's own capacity or null).
 */
const NETWORK_LEADER_MAX = 6;
function maxMembers(db, groupId) {
  // Structure: network leader → max 6 cell leaders; a cell leader's open cell has no limit (closed cell is capped by the target).
  const g = db.prepare('SELECT leader_person_id FROM lifegroups WHERE id = ?').get(groupId);
  if (!g) return null;
  const isNetLeader = g.leader_person_id && db.prepare('SELECT 1 FROM networks WHERE leader_person_id = ? AND is_active = 1 LIMIT 1').get(g.leader_person_id);
  return isNetLeader ? NETWORK_LEADER_MAX : null;
}
function currentCount(db, groupId) {
  return db.prepare('SELECT COUNT(*) n FROM lifegroup_memberships m JOIN people x ON x.id = m.person_id WHERE m.lifegroup_id = ? AND m.left_at IS NULL AND x.archived_at IS NULL').get(groupId).n;
}
/** A Network leader is the root of their own independent Network — they can never be a member of a Lifegroup. */
function assertNotNetworkLeader(db, personId, groupName) {
  if (!personId) return;
  const n = db.prepare(`SELECT n.name, p.first_name, p.last_name FROM networks n JOIN people p ON p.id = n.leader_person_id
      WHERE n.leader_person_id = ? AND n.is_active = 1 LIMIT 1`).get(personId);
  if (n) throw new HttpError(409, `${n.first_name} ${n.last_name} leads ${n.name}. A Network leader is independent and cannot be placed under another leader${groupName ? ` (${groupName})` : ''}.`);
}
/** Throws 409 when one more member would exceed the cap (and, when personId is given, when that person is a Network leader). */
function assertRoom(db, groupId, groupName, personId = null) {
  assertNotNetworkLeader(db, personId, groupName);
  const cap = maxMembers(db, groupId);
  if (cap == null) return;
  const n = currentCount(db, groupId);
  if (n >= cap) throw new HttpError(409, `${groupName || 'This Lifegroup'} already has ${n} cell leaders — a network leader handles at most ${NETWORK_LEADER_MAX}.`);
}
const tz = (s) => s.qr_timezone || 'Asia/Manila';

// ---------------------------------------------------------------------------
// Weeks
// ---------------------------------------------------------------------------
function mondayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function addDays(dateStr, n) { const d = new Date(`${dateStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
/** Last `n` week keys (Mondays), oldest first, ending with the current church week. */
function recentWeeks(db, n, s = settings(db)) {
  const thisMonday = guard.weekKey(tz(s));
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) out.push(addDays(thisMonday, -7 * i));
  return out;
}
const churchToday = (db, s = settings(db)) => guard.churchNow(tz(s)).date;

// ---------------------------------------------------------------------------
// Private leader link
// ---------------------------------------------------------------------------
function ensureToken(db, groupId) {
  const row = db.prepare('SELECT report_token FROM lifegroups WHERE id = ?').get(groupId);
  if (!row) throw new HttpError(404, 'Lifegroup not found.');
  if (row.report_token) return row.report_token;
  const t = crypto.randomBytes(15).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 20) || crypto.randomBytes(10).toString('hex');
  db.prepare("UPDATE lifegroups SET report_token = ?, updated_at = datetime('now') WHERE id = ?").run(t, groupId);
  return t;
}
function resetToken(db, groupId, user) {
  db.prepare("UPDATE lifegroups SET report_token = NULL, updated_at = datetime('now') WHERE id = ?").run(groupId);
  const t = ensureToken(db, groupId);
  activity.log(db, user, 'lifegroup.link_reset', 'lifegroup', groupId, 'Leader report link reset — the old link no longer works');
  return t;
}
function groupByToken(db, token) {
  const t = String(token || '').trim();
  if (!/^[A-Za-z0-9]{10,40}$/.test(t)) return null;
  return db.prepare(`SELECT g.*, COALESCE(lp.first_name || ' ' || lp.last_name, g.leader_name) AS leader_display
      FROM lifegroups g LEFT JOIN people lp ON lp.id = g.leader_person_id WHERE g.report_token = ? AND g.is_active = 1`).get(t) || null;
}

// ---------------------------------------------------------------------------
// Members + progress of one group
// ---------------------------------------------------------------------------
function members(db, groupId) {
  return db.prepare(`
    SELECT p.id, p.person_code, p.first_name, p.last_name, p.sex, p.status, m.id AS membership_id, m.role, m.tier, m.joined_at,
           (SELECT COUNT(*) FROM lifegroup_meeting_attendance a JOIN lifegroup_meetings mt ON mt.id = a.meeting_id
             WHERE a.person_id = p.id AND mt.lifegroup_id = m.lifegroup_id AND a.present = 1) AS meetings_attended,
           (SELECT COUNT(*) FROM lifegroup_meeting_attendance a JOIN lifegroup_meetings mt ON mt.id = a.meeting_id
             WHERE a.person_id = p.id AND mt.lifegroup_id = m.lifegroup_id AND a.devotion = 1) AS devotions,
           (SELECT MAX(mt.meeting_date) FROM lifegroup_meeting_attendance a JOIN lifegroup_meetings mt ON mt.id = a.meeting_id
             WHERE a.person_id = p.id AND mt.lifegroup_id = m.lifegroup_id AND a.present = 1) AS last_meeting_attended
      FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id
     WHERE m.lifegroup_id = ? AND m.left_at IS NULL AND p.archived_at IS NULL
     ORDER BY m.role = 'member', m.tier = 'new', p.last_name COLLATE NOCASE, p.first_name COLLATE NOCASE`).all(groupId);
}

function meetingsOf(db, groupId, limit = 60) {
  const rows = db.prepare(`SELECT mt.*, u.display_name AS submitted_by_user_name FROM lifegroup_meetings mt LEFT JOIN users u ON u.id = mt.submitted_by_user
      WHERE mt.lifegroup_id = ? ORDER BY mt.meeting_date DESC LIMIT ?`).all(groupId, limit);
  const att = db.prepare(`SELECT a.meeting_id, a.present, a.devotion, p.id, p.first_name, p.last_name FROM lifegroup_meeting_attendance a JOIN people p ON p.id = a.person_id
      WHERE a.meeting_id IN (SELECT id FROM lifegroup_meetings WHERE lifegroup_id = ?) ORDER BY p.last_name, p.first_name`).all(groupId);
  const by = new Map(), dev = new Map();
  for (const a of att) {
    const who = { id: a.id, name: `${a.first_name} ${a.last_name}` };
    if (Number(a.present)) { if (!by.has(a.meeting_id)) by.set(a.meeting_id, []); by.get(a.meeting_id).push(who); }
    if (Number(a.devotion)) { if (!dev.has(a.meeting_id)) dev.set(a.meeting_id, []); dev.get(a.meeting_id).push(who); }
  }
  return rows.map((m) => ({ ...m, present: by.get(m.id) || [], devotion: dev.get(m.id) || [] }));
}

/** Week-by-week calendar for one group (oldest → newest). */
function calendar(db, groupId, weeks, s = settings(db)) {
  const keys = recentWeeks(db, weeks, s);
  const first = keys[0];
  const rows = db.prepare('SELECT id, meeting_date, held, present_count FROM lifegroup_meetings WHERE lifegroup_id = ? AND meeting_date >= ? ORDER BY meeting_date').all(groupId, first);
  const byWeek = new Map();
  for (const r of rows) { const k = mondayOf(r.meeting_date); const prev = byWeek.get(k); if (!prev || (r.held && !prev.held)) byWeek.set(k, r); }
  return keys.map((k) => { const m = byWeek.get(k); return { week_start: k, week_end: addDays(k, 6), meeting: m ? { id: m.id, date: m.meeting_date, held: Boolean(m.held), present: m.present_count } : null }; });
}

/**
 * Per-member week-by-week detail for the last `n` weeks: did they attend the Lifegroup, did they have devotion.
 * Returns Map personId → { weeks: [{ week_start, held, present, devotion }], attended, possible, consistency_pct }.
 */
function memberWeeks(db, groupId, n, s = settings(db)) {
  const keys = recentWeeks(db, n, s);
  const first = keys[0];
  const meetings = db.prepare('SELECT id, meeting_date, held FROM lifegroup_meetings WHERE lifegroup_id = ? AND meeting_date >= ? ORDER BY meeting_date').all(groupId, first);
  const weekOf = new Map(); // meeting id → week key
  const weekInfo = new Map(); // week key → { reported, held }
  for (const m of meetings) {
    const k = mondayOf(m.meeting_date); weekOf.set(m.id, k);
    const w = weekInfo.get(k) || { reported: true, held: false }; if (Number(m.held)) w.held = true; weekInfo.set(k, w);
  }
  const ids = meetings.map((m) => m.id);
  const marks = new Map(); // `${week}:${person}` → { present, devotion } (merged over all meetings that week)
  if (ids.length) for (const r of db.prepare(`SELECT meeting_id, person_id, present, devotion FROM lifegroup_meeting_attendance WHERE meeting_id IN (${ids.map(() => '?').join(',')})`).all(...ids)) {
    const key = `${weekOf.get(r.meeting_id)}:${r.person_id}`;
    const cur = marks.get(key) || { present: false, devotion: false };
    if (Number(r.present)) cur.present = true; if (Number(r.devotion)) cur.devotion = true;
    marks.set(key, cur);
  }
  const out = new Map();
  const forPerson = (pid) => {
    if (out.has(pid)) return out.get(pid);
    let attended = 0, possible = 0, devotions = 0;
    const wk = keys.map((k) => {
      const info = weekInfo.get(k);
      const held = Boolean(info && info.held);
      const r = marks.get(`${k}:${pid}`);
      const present = Boolean(held && r && r.present);
      const devotion = Boolean(r && r.devotion);
      if (held) { possible += 1; if (present) attended += 1; }
      if (devotion) devotions += 1;
      return { week_start: k, reported: Boolean(info), held, present, devotion };
    });
    const v = { weeks: wk, attended, possible, devotions, consistency_pct: possible ? Math.round((attended / possible) * 100) : null };
    out.set(pid, v); return v;
  };
  return { forPerson, weeks: keys };
}

function progress(db, groupId, { weeks = 12 } = {}) {
  const s = settings(db);
  const g = db.prepare(`SELECT g.id, g.name, g.gender, g.is_active, g.schedule_day, g.schedule_time, g.leader_person_id, g.network_id,
        COALESCE(lp.first_name || ' ' || lp.last_name, g.leader_name) AS leader_name, n.name AS network_name
      FROM lifegroups g LEFT JOIN people lp ON lp.id = g.leader_person_id LEFT JOIN networks n ON n.id = g.network_id WHERE g.id = ?`).get(groupId);
  if (!g) throw new HttpError(404, 'Lifegroup not found.');
  const mw = memberWeeks(db, groupId, 4, s);
  const mem = members(db, groupId).map((m) => ({ ...m, last4: mw.forPerson(m.id) }));
  const cal = calendar(db, groupId, weeks, s);
  const t = target(s);
  const solid = mem.filter((m) => m.tier === 'solid').length;
  const held4 = cal.slice(-4).filter((w) => w.meeting && w.meeting.held).length;
  const reported4 = cal.slice(-4).filter((w) => w.meeting).length;
  let streak = 0;
  for (let i = cal.length - 1; i >= 0; i -= 1) { const w = cal[i]; if (w.meeting && w.meeting.held) streak += 1; else if (w.meeting || i < cal.length - 1) break; }
  const last = db.prepare('SELECT meeting_date, held, present_count FROM lifegroup_meetings WHERE lifegroup_id = ? ORDER BY meeting_date DESC LIMIT 1').get(groupId) || null;
  return {
    group: g, target: t, solid, new_members: mem.length - solid, total: mem.length, is_solid: solid >= t,
    percent: Math.min(100, Math.round((solid / t) * 100)),
    held_last_4: held4, reported_last_4: reported4, streak, last_meeting: last,
    met_this_week: Boolean(cal[cal.length - 1].meeting && cal[cal.length - 1].meeting.held),
    members: mem, calendar: cal, max_members: maxMembers(db, groupId),
  };
}

// ---------------------------------------------------------------------------
// Tier + meeting reports
// ---------------------------------------------------------------------------
function setTier(db, groupId, personId, tier, { user = null, via = 'admin', byName = null } = {}) {
  if (!['solid', 'new'].includes(tier)) throw new HttpError(400, 'Tier must be solid or new.');
  const m = db.prepare('SELECT m.id, m.tier, p.first_name, p.last_name FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id WHERE m.lifegroup_id = ? AND m.person_id = ? AND m.left_at IS NULL').get(groupId, personId);
  if (!m) throw new HttpError(404, 'That person is not a current member of this Lifegroup.');
  if (m.tier === tier) return false;
  if (tier === 'solid') {
    // Church rule: the closed cell holds at most the target (6). The 7th stays in the open cell.
    const t = target(settings(db));
    const closed = db.prepare("SELECT COUNT(*) n FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id WHERE m.lifegroup_id = ? AND m.left_at IS NULL AND p.archived_at IS NULL AND m.tier = 'solid'").get(groupId).n;
    if (closed >= t) throw new HttpError(409, `The closed cell is full (${t}). ${m.first_name} stays in the open cell — move someone out first.`);
  }
  db.prepare('UPDATE lifegroup_memberships SET tier = ? WHERE id = ?').run(tier, m.id);
  activity.log(db, user, 'lifegroup.tier', 'person', personId, `${m.first_name} ${m.last_name} moved to the ${tier === 'solid' ? 'closed' : 'open'} cell${via === 'leader_link' ? ` by leader ${byName || ''} (report link)` : ''}`.trim());
  return true;
}

/** Leader (or staff) marks a member as no longer active in this group: membership ends today, history is kept. */
function leaveMember(db, groupId, personId, { user = null, via = 'admin', byName = null } = {}) {
  const m = db.prepare('SELECT m.id, g.name, p.first_name, p.last_name FROM lifegroup_memberships m JOIN lifegroups g ON g.id = m.lifegroup_id JOIN people p ON p.id = m.person_id WHERE m.lifegroup_id = ? AND m.person_id = ? AND m.left_at IS NULL').get(groupId, personId);
  if (!m) throw new HttpError(404, 'That person is not a current member of this Lifegroup.');
  const today = churchToday(db);
  db.prepare("UPDATE lifegroup_memberships SET left_at = ?, notes = COALESCE(notes || ' · ', '') || ? WHERE id = ?").run(today, `Marked inactive${via === 'leader_link' ? ` by leader ${byName || ''} (report link)` : ''}`.trim(), m.id);
  activity.log(db, user, 'lifegroup.leave', 'person', personId, `${m.first_name} ${m.last_name} marked inactive in ${m.name}${via === 'leader_link' ? ` by leader ${byName || ''} (report link)` : ''}`.trim());
  syncNetworks(db, user);
  return true;
}
/** Bring a former member back (only when they are not in another Lifegroup now). */
function restoreMember(db, groupId, personId, { user = null, via = 'admin', byName = null } = {}) {
  const prev = db.prepare('SELECT m.id, m.tier, g.name, p.first_name, p.last_name FROM lifegroup_memberships m JOIN lifegroups g ON g.id = m.lifegroup_id JOIN people p ON p.id = m.person_id WHERE m.lifegroup_id = ? AND m.person_id = ? AND m.left_at IS NOT NULL ORDER BY m.left_at DESC LIMIT 1').get(groupId, personId);
  if (!prev) throw new HttpError(404, 'No former membership found.');
  const cur = db.prepare('SELECT g.name FROM lifegroup_memberships m JOIN lifegroups g ON g.id = m.lifegroup_id WHERE m.person_id = ? AND m.left_at IS NULL').get(personId);
  if (cur) throw new HttpError(409, `${prev.first_name} ${prev.last_name} is now in ${cur.name} — ask the admin to move them.`);
  assertRoom(db, groupId, prev.name, personId);
  const today = churchToday(db);
  db.prepare("INSERT INTO lifegroup_memberships (person_id, lifegroup_id, role, tier, joined_at, notes) VALUES (?, ?, 'member', ?, ?, ?)").run(personId, groupId, prev.tier || 'new', today, `Brought back${via === 'leader_link' ? ` by leader ${byName || ''} (report link)` : ''}`.trim());
  activity.log(db, user, 'lifegroup.assign', 'person', personId, `${prev.first_name} ${prev.last_name} brought back to ${prev.name}${via === 'leader_link' ? ` by leader ${byName || ''} (report link)` : ''}`.trim());
  syncNetworks(db, user);
  return true;
}
function formerMembers(db, groupId, limit = 30) {
  return db.prepare(`SELECT p.id, p.first_name, p.last_name, m.tier, m.left_at FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id
     WHERE m.lifegroup_id = ? AND m.left_at IS NOT NULL AND p.archived_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM lifegroup_memberships c WHERE c.person_id = p.id AND c.left_at IS NULL)
     ORDER BY m.left_at DESC LIMIT ?`).all(groupId, limit);
}

/**
 * Upsert the report for one date. body: { meeting_date, held, no_meeting_reason?, topic?, notes?, present_ids: [], devotion_ids: [], new_members: [{ full_name }] }
 * meta: { via: 'admin'|'leader_link', user?, byName? }
 */
function recordMeeting(db, groupId, body, meta = {}) {
  const s = settings(db);
  const g = db.prepare('SELECT id, name, gender, is_active FROM lifegroups WHERE id = ?').get(groupId);
  if (!g) throw new HttpError(404, 'Lifegroup not found.');
  if (!g.is_active) throw new HttpError(400, 'This Lifegroup is inactive.');
  const b = body || {};
  const date = clean(b.meeting_date);
  if (!isValidDate(date)) throw new HttpError(400, 'Please choose the date of the Lifegroup meeting.', { meeting_date: 'Choose a valid date.' });
  const today = churchToday(db, s);
  if (date > today) throw new HttpError(400, 'The meeting date cannot be in the future.', { meeting_date: 'Future date.' });
  if (date < addDays(today, -120)) throw new HttpError(400, 'Reports can only be filed for the last 120 days.', { meeting_date: 'Too far back.' });
  const held = b.held === undefined ? true : Boolean(b.held === true || b.held === 1 || b.held === '1' || b.held === 'true');
  const reason = clean(b.no_meeting_reason);
  if (!held && !reason) throw new HttpError(400, 'Please tell us why there was no Lifegroup this week.', { no_meeting_reason: 'Required when no meeting was held.' });
  const topic = clean(b.topic), notes = clean(b.notes);
  if ((topic || '').length > 160 || (notes || '').length > 1000) throw new HttpError(400, 'Topic or notes are too long.');
  const presentIds = Array.isArray(b.present_ids) ? [...new Set(b.present_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : [];
  const newMembers = Array.isArray(b.new_members) ? b.new_members.slice(0, 20) : [];
  if (newMembers.length > 0 && !held) throw new HttpError(400, 'New people can only be added to a meeting that was held.');

  const current = new Set(members(db, groupId).map((m) => m.id));
  for (const id of presentIds) if (!current.has(id)) throw new HttpError(400, 'One of the people marked present is not a current member of this Lifegroup. Reload and try again.');

  const out = db.transaction(() => {
    const added = [];
    for (const nm of newMembers) {
      const name = tidyName(nm && nm.full_name);
      const prob = name.length < 3 ? 'Please enter the full name.' : guard.nameProblem(normalizeName(name));
      if (prob) throw new HttpError(400, `New member "${name || ''}": ${prob}`, { new_members: prob });
      const { first_name, last_name } = splitFullName(name);
      const dup = db.prepare('SELECT id, first_name, last_name FROM people WHERE full_name_normalized = ? AND archived_at IS NULL LIMIT 1').get(normalizeName(name));
      let pid;
      if (dup) {
        pid = dup.id; // already in People: just place them in this group (one current membership per person)
        const cur = db.prepare('SELECT lifegroup_id FROM lifegroup_memberships WHERE person_id = ? AND left_at IS NULL').get(pid);
        if (cur && cur.lifegroup_id !== groupId) throw new HttpError(409, `${dup.first_name} ${dup.last_name} is already in another Lifegroup — ask the admin to move them.`, { new_members: 'already in another group' });
        if (!cur) { assertRoom(db, groupId, g.name, pid); db.prepare("INSERT INTO lifegroup_memberships (person_id, lifegroup_id, role, tier, joined_at, notes) VALUES (?, ?, 'member', 'new', ?, ?)").run(pid, groupId, date, `Added via Lifegroup report${meta.byName ? ' by ' + meta.byName : ''}`); }
      } else {
        assertRoom(db, groupId, g.name);
        const info = db.prepare(`INSERT INTO people (first_name, last_name, full_name_normalized, sex, status, date_registered, notes, registration_source, added_via, registered_at, created_by)
          VALUES (@first_name, @last_name, @norm, @sex, 'first_timer', @date, @notes, 'manual', 'lifegroup_link', datetime('now'), @uid)`)
          .run({ first_name, last_name: last_name || first_name, norm: normalizeName(name), sex: SEX_OF[g.gender] || null, date, notes: `Added from ${g.name} Lifegroup report${meta.byName ? ' by ' + meta.byName : ''} (${date}). Please complete contact details.`, uid: meta.user ? meta.user.id : null });
        pid = info.lastInsertRowid;
        const year = date.slice(0, 4);
        const row = db.prepare('SELECT MAX(CAST(substr(person_code, 9) AS INTEGER)) AS n FROM people WHERE person_code LIKE ?').get(`LG-${year}-%`);
        db.prepare('UPDATE people SET person_code = ? WHERE id = ?').run(`LG-${year}-${String((row?.n || 0) + 1).padStart(4, '0')}`, pid);
        db.prepare("INSERT INTO lifegroup_memberships (person_id, lifegroup_id, role, tier, joined_at, notes) VALUES (?, ?, 'member', 'new', ?, ?)").run(pid, groupId, date, `Added via Lifegroup report${meta.byName ? ' by ' + meta.byName : ''}`);
        activity.log(db, meta.user || null, 'person.create', 'person', pid, `${first_name} ${last_name || first_name} added as a new Lifegroup member of ${g.name}${meta.via === 'leader_link' ? ' via the leader report link' : ''}`);
      }
      added.push(pid); presentIds.push(pid);
    }
    const uniq = [...new Set(presentIds)];
    const existing = db.prepare('SELECT id FROM lifegroup_meetings WHERE lifegroup_id = ? AND meeting_date = ?').get(groupId, date);
    let meetingId;
    const by = meta.via === 'leader_link' ? 'leader_link' : 'admin';
    if (existing) {
      meetingId = existing.id;
      db.prepare(`UPDATE lifegroup_meetings SET held = ?, no_meeting_reason = ?, topic = ?, notes = ?, present_count = ?, submitted_via = ?, submitted_by_user = ?, submitted_by_name = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(held ? 1 : 0, held ? null : reason, topic, notes, held ? uniq.length : 0, by, meta.user ? meta.user.id : null, meta.byName || null, meetingId);
      db.prepare('DELETE FROM lifegroup_meeting_attendance WHERE meeting_id = ?').run(meetingId);
    } else {
      meetingId = db.prepare(`INSERT INTO lifegroup_meetings (lifegroup_id, meeting_date, held, no_meeting_reason, topic, notes, present_count, submitted_via, submitted_by_user, submitted_by_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(groupId, date, held ? 1 : 0, held ? null : reason, topic, notes, held ? uniq.length : 0, by, meta.user ? meta.user.id : null, meta.byName || null).lastInsertRowid;
    }
    const devo = [...new Set((Array.isArray(b.devotion_ids) ? b.devotion_ids : []).map(Number).filter((x) => Number.isInteger(x) && x > 0 && current.has(x)))];
    const ins = db.prepare('INSERT INTO lifegroup_meeting_attendance (meeting_id, person_id, present, devotion) VALUES (?, ?, ?, ?)');
    const presentSet = new Set(held ? uniq : []);
    for (const pid of new Set([...presentSet, ...devo])) ins.run(meetingId, pid, presentSet.has(pid) ? 1 : 0, devo.includes(pid) ? 1 : 0);
    activity.log(db, meta.user || null, existing ? 'lifegroup.meeting_update' : 'lifegroup.meeting', 'lifegroup', groupId,
      `${g.name}: ${held ? `Lifegroup held on ${date} — ${uniq.length} present${added.length ? `, ${added.length} new` : ''}` : `no Lifegroup on ${date} (${reason})`}${by === 'leader_link' ? ` · reported by ${meta.byName || 'leader'} via link` : ''}`);
    return { meeting_id: meetingId, updated: Boolean(existing), present: uniq.length, added: added.length };
  })();
  if (out.added) syncNetworks(db, meta.user || null);
  return out;
}

function deleteMeeting(db, groupId, meetingId, user) {
  const m = db.prepare('SELECT id, meeting_date FROM lifegroup_meetings WHERE id = ? AND lifegroup_id = ?').get(meetingId, groupId);
  if (!m) throw new HttpError(404, 'Meeting not found.');
  db.prepare('DELETE FROM lifegroup_meetings WHERE id = ?').run(m.id);
  activity.log(db, user, 'lifegroup.meeting_delete', 'lifegroup', groupId, `Removed Lifegroup report for ${m.meeting_date}`);
}

// ---------------------------------------------------------------------------
// Network calendar + overall statistics
// ---------------------------------------------------------------------------
function groupRows(db, where = '', params = []) {
  return db.prepare(`
    SELECT g.id, g.name, g.gender, g.network_id, g.leader_person_id, g.schedule_day, g.schedule_time,
           COALESCE(lp.first_name || ' ' || lp.last_name, g.leader_name) AS leader_name, n.name AS network_name,
           EXISTS (SELECT 1 FROM networks xn WHERE xn.leader_person_id = g.leader_person_id AND xn.is_active = 1) AS is_leader_group,
           (SELECT COUNT(*) FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id WHERE m.lifegroup_id = g.id AND m.left_at IS NULL AND p.archived_at IS NULL) AS total,
           (SELECT COUNT(*) FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id WHERE m.lifegroup_id = g.id AND m.left_at IS NULL AND p.archived_at IS NULL AND m.tier = 'solid') AS solid,
           (SELECT MAX(meeting_date) FROM lifegroup_meetings mt WHERE mt.lifegroup_id = g.id AND mt.held = 1) AS last_held
      FROM lifegroups g LEFT JOIN people lp ON lp.id = g.leader_person_id LEFT JOIN networks n ON n.id = g.network_id
     WHERE g.is_active = 1 ${where} ORDER BY n.name COLLATE NOCASE, g.name COLLATE NOCASE`).all(...params);
}
function attachCalendars(db, rows, weeks, s) {
  const t = target(s);
  return rows.map((g) => {
    const cal = calendar(db, g.id, weeks, s);
    const held4 = cal.slice(-4).filter((w) => w.meeting && w.meeting.held).length;
    return { ...g, is_leader_group: Boolean(Number(g.is_leader_group)), target: t, is_solid: g.solid >= t, new_members: g.total - g.solid, held_last_4: held4, met_this_week: Boolean(cal[cal.length - 1].meeting && cal[cal.length - 1].meeting.held), calendar: cal };
  });
}

/** Rows = the network leader's own group (if any) + every group in the network, each with a weekly calendar. */
function networkCalendar(db, networkId, { weeks = 8, withMembers = false } = {}) {
  const s = settings(db);
  const n = db.prepare(`SELECT n.id, n.name, n.gender, n.leader_person_id, COALESCE(lp.first_name || ' ' || lp.last_name, n.leader_name) AS leader_name
      FROM networks n LEFT JOIN people lp ON lp.id = n.leader_person_id WHERE n.id = ?`).get(networkId);
  if (!n) throw new HttpError(404, 'Network not found.');
  const own = n.leader_person_id ? groupRows(db, 'AND g.leader_person_id = ?', [n.leader_person_id]) : [];
  const inNet = groupRows(db, 'AND g.network_id = ?', [n.id]).filter((g) => !own.some((o) => o.id === g.id));
  const rows = attachCalendars(db, [...own.map((g) => ({ ...g, is_leader_group: true })), ...inNet], weeks, s);
  const out = { network: n, weeks: recentWeeks(db, weeks, s), target: target(s), groups: rows, summary: summarize(rows) };
  if (withMembers) {
    out.members_last4 = {};
    for (const g of rows) { const mw = memberWeeks(db, g.id, 4, s); out.members_last4[g.id] = {}; for (const m of members(db, g.id)) out.members_last4[g.id][m.id] = mw.forPerson(m.id); }
  }
  return out;
}

/**
 * What a network leader sees on their own report link: every Lifegroup in the network(s) they lead,
 * each with this week's status and the members (solid / other) with the last 4 weeks of LG attendance + devotion.
 */
function leaderNetworkView(db, leaderPersonId, { weeks = 4 } = {}) {
  if (!leaderPersonId) return null;
  const s = settings(db);
  const nets = db.prepare('SELECT id, name, gender FROM networks WHERE leader_person_id = ? AND is_active = 1 ORDER BY name').all(leaderPersonId);
  if (!nets.length) return null;
  const ids = nets.map((n) => n.id);
  const rows = attachCalendars(db, groupRows(db, `AND g.network_id IN (${ids.map(() => '?').join(',')}) AND (g.leader_person_id IS NULL OR g.leader_person_id <> ?)`, [...ids, leaderPersonId]), weeks, s);
  const groups = rows.map((g) => {
    const mw = memberWeeks(db, g.id, weeks, s);
    const mem = members(db, g.id).map((m) => ({ id: m.id, name: `${m.first_name} ${m.last_name}`, tier: m.tier, role: m.role, meetings_attended: m.meetings_attended, last4: mw.forPerson(m.id) }));
    const w = g.calendar[g.calendar.length - 1];
    return { id: g.id, name: g.name, leader_name: g.leader_name, leader_person_id: g.leader_person_id, schedule_day: g.schedule_day, schedule_time: g.schedule_time,
      solid: g.solid, total: g.total, target: g.target, is_solid: g.is_solid, held_last_4: g.held_last_4, met_this_week: g.met_this_week,
      this_week: !w || !w.meeting ? 'none' : w.meeting.held ? 'held' : 'skip', last_meeting: w && w.meeting ? w.meeting : null, calendar: g.calendar,
      solid_members: mem.filter((m) => m.tier === 'solid'), other_members: mem.filter((m) => m.tier !== 'solid'),
      // last reports: did they hold the Lifegroup, and who was present (names only — shown to the network leader)
      recent: meetingsOf(db, g.id, 4).map((m) => ({ id: m.id, meeting_date: m.meeting_date, held: Boolean(m.held), no_meeting_reason: m.no_meeting_reason, present_count: m.present_count, present: m.present.map((x) => x.name) })) };
  });
  return { networks: nets, weeks: recentWeeks(db, weeks, s), groups, summary: summarize(rows) };
}

function summarize(allRows) {
  // A network leader's own Lifegroup holds the cell leaders — it is the root of the network, not a cell, so it is left out of cell numbers.
  const rows = allRows.filter((g) => !g.is_leader_group);
  const out = { groups: rows.length, solid_groups: rows.filter((g) => g.is_solid).length, solid_members: 0, new_members: 0, total_members: 0, met_this_week: 0, reported_this_week: 0, held_last_4: 0, possible_last_4: rows.length * 4 };
  for (const g of rows) {
    out.solid_members += g.solid; out.new_members += g.new_members; out.total_members += g.total;
    if (g.met_this_week) out.met_this_week += 1;
    const w = g.calendar[g.calendar.length - 1]; if (w && w.meeting) out.reported_this_week += 1;
    out.held_last_4 += g.held_last_4;
  }
  out.consistency_pct = out.possible_last_4 ? Math.round((out.held_last_4 / out.possible_last_4) * 100) : 0;
  return out;
}

/**
 * Network statistics for Reports: one row per network (+ groups without a network) with ratios:
 * solid %, solid groups, held this week, consistency (4 weeks), average Lifegroup attendance, last-Sunday attendance of members.
 */
function networkStatus(db) {
  const s = settings(db);
  const t = target(s);
  const rows = attachCalendars(db, groupRows(db), 4, s);
  const lastSunday = db.prepare('SELECT id, service_date FROM services ORDER BY service_date DESC LIMIT 1').get() || null;
  const weeks4 = recentWeeks(db, 4, s)[0];
  const netOf = new Map();
  for (const g of rows) {
    const k = g.network_id || 0;
    if (!netOf.has(k)) netOf.set(k, { id: g.network_id, name: g.network_name || 'No network yet', gender: g.gender, groups: [] });
    netOf.get(k).groups.push(g);
  }
  const leaderOf = new Map(db.prepare(`SELECT n.id, COALESCE(lp.first_name || ' ' || lp.last_name, n.leader_name) AS leader_name, n.gender FROM networks n LEFT JOIN people lp ON lp.id = n.leader_person_id`).all().map((r) => [r.id, r]));
  const out = [...netOf.values()].map((n) => {
    n.groups = n.groups.filter((g) => !g.is_leader_group); // the network leader's own group is the root, not a cell
    const ids = n.groups.map((g) => g.id);
    const ph = ids.map(() => '?').join(',');
    const sum = summarize(n.groups);
    // average attendance at Lifegroups held in the last 4 weeks = present ÷ members at that time (approx. current members)
    const att = ids.length ? db.prepare(`SELECT COUNT(*) AS meetings, COALESCE(SUM(present_count), 0) AS present FROM lifegroup_meetings WHERE held = 1 AND meeting_date >= ? AND lifegroup_id IN (${ph})`).get(weeks4, ...ids) : { meetings: 0, present: 0 };
    const avgPresent = Number(att.meetings) ? Number(att.present) / Number(att.meetings) : null;
    const avgGroupSize = n.groups.length ? sum.total_members / n.groups.length : 0;
    const devo = ids.length ? db.prepare(`SELECT COUNT(DISTINCT a.person_id) AS n FROM lifegroup_meeting_attendance a JOIN lifegroup_meetings mt ON mt.id = a.meeting_id WHERE a.devotion = 1 AND mt.meeting_date >= ? AND mt.lifegroup_id IN (${ph})`).get(weeks4, ...ids).n : 0;
    let sunday = null;
    if (lastSunday && ids.length) {
      const r = db.prepare(`SELECT COUNT(DISTINCT m.person_id) AS members,
          COUNT(DISTINCT CASE WHEN ar.status = 'present' THEN m.person_id END) AS present
        FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id
        LEFT JOIN attendance_records ar ON ar.person_id = m.person_id AND ar.service_id = ?
       WHERE m.left_at IS NULL AND p.archived_at IS NULL AND m.lifegroup_id IN (${ph})`).get(lastSunday.id, ...ids);
      sunday = { date: lastSunday.service_date, members: Number(r.members), present: Number(r.present), pct: Number(r.members) ? Math.round((Number(r.present) / Number(r.members)) * 100) : null };
    }
    const info = n.id ? leaderOf.get(n.id) : null;
    const leaders = new Set(n.groups.map((g) => g.leader_person_id || g.leader_name).filter(Boolean)).size;
    return {
      id: n.id, name: n.name, gender: n.gender, leader_name: info ? info.leader_name : null,
      groups: sum.groups, leaders, members: sum.total_members, solid_members: sum.solid_members, new_members: sum.new_members,
      solid_pct: sum.total_members ? Math.round((sum.solid_members / sum.total_members) * 100) : null,
      solid_groups: sum.solid_groups, solid_groups_pct: sum.groups ? Math.round((sum.solid_groups / sum.groups) * 100) : null,
      met_this_week: sum.met_this_week, reported_this_week: sum.reported_this_week, consistency_pct: sum.consistency_pct,
      avg_present: avgPresent == null ? null : Math.round(avgPresent * 10) / 10,
      avg_attendance_pct: avgPresent != null && avgGroupSize ? Math.min(100, Math.round((avgPresent / avgGroupSize) * 100)) : null,
      devotion_members: Number(devo), devotion_pct: sum.total_members ? Math.round((Number(devo) / sum.total_members) * 100) : null,
      sunday,
    };
  }).sort((a, b) => (a.id ? 0 : 1) - (b.id ? 0 : 1) || String(a.gender).localeCompare(String(b.gender)) || a.name.localeCompare(b.name));
  const total = (key) => out.reduce((acc, r) => acc + (r[key] || 0), 0);
  const members = total('members'), groups = total('groups'), solid = total('solid_members'), solidGroups = total('solid_groups');
  const sunMembers = out.reduce((a, r) => a + (r.sunday ? r.sunday.members : 0), 0), sunPresent = out.reduce((a, r) => a + (r.sunday ? r.sunday.present : 0), 0);
  const all = summarize(rows);
  return { target: t, last_sunday: lastSunday ? lastSunday.service_date : null, networks: out,
    totals: { networks: out.filter((n) => n.id).length, groups, members, solid_members: solid, new_members: members - solid, solid_pct: members ? Math.round((solid / members) * 100) : null,
      solid_groups: solidGroups, solid_groups_pct: groups ? Math.round((solidGroups / groups) * 100) : null, met_this_week: all.met_this_week, consistency_pct: all.consistency_pct,
      devotion_members: total('devotion_members'), devotion_pct: members ? Math.round((total('devotion_members') / members) * 100) : null,
      sunday_pct: sunMembers ? Math.round((sunPresent / sunMembers) * 100) : null },
    by_gender: { boys: summarize(rows.filter((g) => g.gender === 'boys')), girls: summarize(rows.filter((g) => g.gender === 'girls')) },
    structure: structureTiles(db) };
}

/**
 * Church-structure headline numbers per sex: networks, cell leaders (members of a network leader's Lifegroup),
 * and the open / closed cell members of the ordinary Lifegroups (network leaders' own groups excluded — those hold cell leaders).
 */
function structureTiles(db) {
  const LEADS_NET = 'EXISTS (SELECT 1 FROM networks xn WHERE xn.leader_person_id = g.leader_person_id AND xn.is_active = 1)';
  const out = {};
  for (const [key, sex] of [['boys', 'male'], ['girls', 'female']]) {
    const networks = Number(db.prepare('SELECT COUNT(*) AS n FROM networks WHERE is_active = 1 AND gender = ?').get(key).n);
    const cellLeaders = Number(db.prepare(`SELECT COUNT(DISTINCT m.person_id) AS n FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id JOIN lifegroups g ON g.id = m.lifegroup_id
       WHERE m.left_at IS NULL AND p.archived_at IS NULL AND g.is_active = 1 AND p.sex = ? AND ${LEADS_NET}`).get(sex).n);
    const cells = db.prepare(`SELECT COUNT(CASE WHEN m.tier = 'solid' THEN 1 END) AS closed, COUNT(CASE WHEN COALESCE(m.tier, 'new') <> 'solid' THEN 1 END) AS open
       FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id JOIN lifegroups g ON g.id = m.lifegroup_id
       WHERE m.left_at IS NULL AND p.archived_at IS NULL AND g.is_active = 1 AND p.sex = ? AND NOT ${LEADS_NET}`).get(sex);
    const lifegroups = Number(db.prepare(`SELECT COUNT(*) AS n FROM lifegroups g WHERE g.is_active = 1 AND g.gender = ? AND NOT ${LEADS_NET}`).get(key).n);
    out[key] = { networks, cell_leaders: cellLeaders, lifegroups, open_cell: Number(cells.open), closed_cell: Number(cells.closed), members: Number(cells.open) + Number(cells.closed) };
  }
  return out;
}

/** Everything the Progress tab needs: overall numbers, per-network and per-group tables. */
function overview(db, { weeks = 8 } = {}) {
  const s = settings(db);
  const rows = attachCalendars(db, groupRows(db), weeks, s);
  const nets = new Map();
  for (const g of rows) {
    const k = g.network_id || 0;
    if (!nets.has(k)) nets.set(k, { id: g.network_id, name: g.network_name || 'No network yet', gender: g.gender, groups: [] });
    nets.get(k).groups.push(g);
  }
  const networks = [...nets.values()].map((n) => ({ ...n, summary: summarize(n.groups), groups: n.groups.map((g) => ({ ...g, calendar: undefined })) }))
    .sort((a, b) => (a.id ? 0 : 1) - (b.id ? 0 : 1) || a.name.localeCompare(b.name));
  const people = db.prepare(`SELECT COUNT(*) AS n FROM people p WHERE p.archived_at IS NULL AND p.status <> 'inactive'
      AND NOT EXISTS (SELECT 1 FROM lifegroup_memberships m WHERE m.person_id = p.id AND m.left_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM networks xn WHERE xn.leader_person_id = p.id AND xn.is_active = 1)`).get().n;
  return { weeks: recentWeeks(db, weeks, s), target: target(s), summary: { ...summarize(rows), without_group: people, networks: networks.filter((n) => n.id).length },
    networks, groups: rows, boys: summarize(rows.filter((g) => g.gender === 'boys')), girls: summarize(rows.filter((g) => g.gender === 'girls')) };
}

module.exports = { settings, target, recentWeeks, mondayOf, addDays, churchToday, ensureToken, resetToken, groupByToken, members, memberWeeks, meetingsOf, calendar, progress, setTier, leaveMember, restoreMember, formerMembers, recordMeeting, maxMembers, assertRoom, assertNotNetworkLeader, NETWORK_LEADER_MAX, deleteMeeting, networkCalendar, leaderNetworkView, networkStatus, structureTiles, overview, summarize };
