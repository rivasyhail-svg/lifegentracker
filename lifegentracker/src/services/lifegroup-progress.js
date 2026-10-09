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
             WHERE a.person_id = p.id AND mt.lifegroup_id = m.lifegroup_id) AS meetings_attended,
           (SELECT MAX(mt.meeting_date) FROM lifegroup_meeting_attendance a JOIN lifegroup_meetings mt ON mt.id = a.meeting_id
             WHERE a.person_id = p.id AND mt.lifegroup_id = m.lifegroup_id) AS last_meeting_attended
      FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id
     WHERE m.lifegroup_id = ? AND m.left_at IS NULL AND p.archived_at IS NULL
     ORDER BY m.role = 'member', m.tier = 'new', p.last_name COLLATE NOCASE, p.first_name COLLATE NOCASE`).all(groupId);
}

function meetingsOf(db, groupId, limit = 60) {
  const rows = db.prepare(`SELECT mt.*, u.display_name AS submitted_by_user_name FROM lifegroup_meetings mt LEFT JOIN users u ON u.id = mt.submitted_by_user
      WHERE mt.lifegroup_id = ? ORDER BY mt.meeting_date DESC LIMIT ?`).all(groupId, limit);
  const att = db.prepare(`SELECT a.meeting_id, p.id, p.first_name, p.last_name FROM lifegroup_meeting_attendance a JOIN people p ON p.id = a.person_id
      WHERE a.meeting_id IN (SELECT id FROM lifegroup_meetings WHERE lifegroup_id = ?) ORDER BY p.last_name, p.first_name`).all(groupId);
  const by = new Map();
  for (const a of att) { if (!by.has(a.meeting_id)) by.set(a.meeting_id, []); by.get(a.meeting_id).push({ id: a.id, name: `${a.first_name} ${a.last_name}` }); }
  return rows.map((m) => ({ ...m, present: by.get(m.id) || [] }));
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

function progress(db, groupId, { weeks = 12 } = {}) {
  const s = settings(db);
  const g = db.prepare(`SELECT g.id, g.name, g.gender, g.is_active, g.schedule_day, g.schedule_time, g.leader_person_id, g.network_id,
        COALESCE(lp.first_name || ' ' || lp.last_name, g.leader_name) AS leader_name, n.name AS network_name
      FROM lifegroups g LEFT JOIN people lp ON lp.id = g.leader_person_id LEFT JOIN networks n ON n.id = g.network_id WHERE g.id = ?`).get(groupId);
  if (!g) throw new HttpError(404, 'Lifegroup not found.');
  const mem = members(db, groupId);
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
    members: mem, calendar: cal,
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
  db.prepare('UPDATE lifegroup_memberships SET tier = ? WHERE id = ?').run(tier, m.id);
  activity.log(db, user, 'lifegroup.tier', 'person', personId, `${m.first_name} ${m.last_name} marked ${tier === 'solid' ? 'Solid' : 'New / other'}${via === 'leader_link' ? ` by leader ${byName || ''} (report link)` : ''}`.trim());
  return true;
}

/**
 * Upsert the report for one date. body: { meeting_date, held, no_meeting_reason?, topic?, notes?, present_ids: [], new_members: [{ full_name }] }
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
        if (!cur) db.prepare("INSERT INTO lifegroup_memberships (person_id, lifegroup_id, role, tier, joined_at, notes) VALUES (?, ?, 'member', 'new', ?, ?)").run(pid, groupId, date, `Added via Lifegroup report${meta.byName ? ' by ' + meta.byName : ''}`);
      } else {
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
    if (held) { const ins = db.prepare('INSERT OR IGNORE INTO lifegroup_meeting_attendance (meeting_id, person_id) VALUES (?, ?)'); for (const pid of uniq) ins.run(meetingId, pid); }
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
    return { ...g, target: t, is_solid: g.solid >= t, new_members: g.total - g.solid, held_last_4: held4, met_this_week: Boolean(cal[cal.length - 1].meeting && cal[cal.length - 1].meeting.held), calendar: cal };
  });
}

/** Rows = the network leader's own group (if any) + every group in the network, each with a weekly calendar. */
function networkCalendar(db, networkId, { weeks = 8 } = {}) {
  const s = settings(db);
  const n = db.prepare(`SELECT n.id, n.name, n.gender, n.leader_person_id, COALESCE(lp.first_name || ' ' || lp.last_name, n.leader_name) AS leader_name
      FROM networks n LEFT JOIN people lp ON lp.id = n.leader_person_id WHERE n.id = ?`).get(networkId);
  if (!n) throw new HttpError(404, 'Network not found.');
  const own = n.leader_person_id ? groupRows(db, 'AND g.leader_person_id = ?', [n.leader_person_id]) : [];
  const inNet = groupRows(db, 'AND g.network_id = ?', [n.id]).filter((g) => !own.some((o) => o.id === g.id));
  const rows = attachCalendars(db, [...own.map((g) => ({ ...g, is_leader_group: true })), ...inNet], weeks, s);
  return { network: n, weeks: recentWeeks(db, weeks, s), target: target(s), groups: rows, summary: summarize(rows) };
}

function summarize(rows) {
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
      AND NOT EXISTS (SELECT 1 FROM lifegroup_memberships m WHERE m.person_id = p.id AND m.left_at IS NULL)`).get().n;
  return { weeks: recentWeeks(db, weeks, s), target: target(s), summary: { ...summarize(rows), without_group: people, networks: networks.filter((n) => n.id).length },
    networks, groups: rows, boys: summarize(rows.filter((g) => g.gender === 'boys')), girls: summarize(rows.filter((g) => g.gender === 'girls')) };
}

module.exports = { settings, target, recentWeeks, mondayOf, addDays, churchToday, ensureToken, resetToken, groupByToken, members, meetingsOf, calendar, progress, setTier, recordMeeting, deleteMeeting, networkCalendar, overview, summarize };
