'use strict';
/**
 * QR self-registration — the public form writes to the `registrations` inbox; when an
 * Admin approves, the person is created in (or linked to) the SAME `people` table that
 * manual registration uses. There is no second people database.
 */
const crypto = require('crypto');
const { getDb } = require('../db');
const { clean, HttpError, today } = require('../lib/util');
const { normalizeEmail, isValidEmail, normalizeName, tidyName, splitFullName, isSqliteUnique } = require('../lib/normalize');
const activity = require('./activity');

const ci = (a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }); // case-insensitive sort (dialect-free)

const MIN_AGE = 5, MAX_AGE = 100;
const FIELDS = ['full_name', 'email', 'age', 'school', 'leader_name', 'network_leader_name', 'ministry'];

function settings(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}
const on = (v) => v !== '0' && v !== 'false' && v !== '';

function ministries(db, s = settings(db)) {
  return String(s.qr_ministries || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
}

/** What the public form may see: never personal data, only pick-lists. */
function publicOptions(db) {
  const s = settings(db);
  const enabled = on(s.qr_registration_enabled);
  const out = { enabled, church_name: s.church_name, service_name: s.service_name, ministries: ministries(db, s), schools: [], leaders: [], network_leaders: [], name_check: on(s.qr_name_duplicate_check) };
  if (!enabled) return out;
  out.schools = db.prepare("SELECT DISTINCT trim(school) AS v FROM people WHERE school IS NOT NULL AND trim(school) <> '' AND archived_at IS NULL LIMIT 300").all().map((r) => r.v).sort(ci);
  if (on(s.qr_show_leaders)) {
    // first + last name of active leaders only (no contact details, no ids)
    out.leaders = db.prepare(`SELECT DISTINCT COALESCE(lp.first_name || ' ' || lp.last_name, g.leader_name) AS v
        FROM lifegroups g LEFT JOIN people lp ON lp.id = g.leader_person_id
       WHERE g.is_active = 1 AND (g.leader_person_id IS NOT NULL OR g.leader_name IS NOT NULL) `).all().map((r) => r.v).filter(Boolean).sort(ci);
    out.network_leaders = db.prepare(`SELECT DISTINCT COALESCE(lp.first_name || ' ' || lp.last_name, n.leader_name) AS v
        FROM networks n LEFT JOIN people lp ON lp.id = n.leader_person_id
       WHERE n.is_active = 1 AND (n.leader_person_id IS NOT NULL OR n.leader_name IS NOT NULL) `).all().map((r) => r.v).filter(Boolean).sort(ci);
  }
  return out;
}

/** Validate + normalise a public submission (also used by the admin Edit). Throws 400 with per-field errors. */
function validate(body, db) {
  const b = body || {};
  const data = {
    full_name: tidyName(b.full_name),
    email: String(b.email ?? '').trim(),
    age: b.age === '' || b.age === null || b.age === undefined ? NaN : Number(b.age),
    school: clean(b.school),
    leader_name: tidyName(b.leader_name),
    network_leader_name: tidyName(b.network_leader_name),
    ministry: clean(b.ministry),
  };
  const errors = {};
  if (!data.full_name) errors.full_name = 'Please enter your full name.';
  else if (data.full_name.length < 3 || data.full_name.length > 120) errors.full_name = 'Please enter your real full name.';
  else if (data.full_name.split(' ').length < 2) errors.full_name = 'Please enter your first and last name.';
  else if (!/^[\p{L}\p{M}][\p{L}\p{M}\s.'’-]*$/u.test(data.full_name)) errors.full_name = 'Names can only contain letters, spaces, dots, apostrophes and hyphens.';
  if (!data.email) errors.email = 'Please enter your email / Gmail.';
  else if (!isValidEmail(data.email)) errors.email = 'That email address does not look valid (e.g. name@gmail.com).';
  if (!Number.isFinite(data.age)) errors.age = 'Please enter your age.';
  else if (!Number.isInteger(data.age) || String(b.age).includes('.')) errors.age = 'Age must be a whole number.';
  else if (data.age < MIN_AGE || data.age > MAX_AGE) errors.age = `Age must be between ${MIN_AGE} and ${MAX_AGE}.`;
  if (!data.school) errors.school = 'Please enter your school.';
  else if (data.school.length > 120) errors.school = 'School name is too long.';
  if (!data.leader_name) errors.leader_name = "Please enter your leader's name.";
  else if (data.leader_name.length > 120) errors.leader_name = 'Leader name is too long.';
  if (!data.network_leader_name) errors.network_leader_name = "Please enter your network leader's name.";
  else if (data.network_leader_name.length > 120) errors.network_leader_name = 'Network leader name is too long.';
  if (!data.ministry) errors.ministry = 'Please choose a ministry.';
  else {
    const list = ministries(db);
    if (list.length && !list.some((m) => m.toLowerCase() === data.ministry.toLowerCase())) errors.ministry = 'Please choose a ministry from the list.';
    else if (list.length) data.ministry = list.find((m) => m.toLowerCase() === data.ministry.toLowerCase());
  }
  if (Object.keys(errors).length) throw new HttpError(400, Object.values(errors)[0], errors);
  data.email_normalized = normalizeEmail(data.email);
  data.full_name_normalized = normalizeName(data.full_name);
  return data;
}

/** Duplicate findings for a normalised name/email. Never returns the other person's details. */
function duplicates(db, { email_normalized, full_name_normalized }, excludeRegId = null) {
  const out = { email_taken: false, name_match: false };
  if (email_normalized) {
    out.email_taken = Boolean(
      db.prepare('SELECT 1 FROM people WHERE email_normalized = ?').get(email_normalized) // archived too — the unique index covers them
      || db.prepare('SELECT 1 FROM registrations WHERE email_normalized = ? AND id IS NOT ?').get(email_normalized, excludeRegId)
    );
  }
  if (full_name_normalized) {
    const p = db.prepare('SELECT person_code FROM people WHERE full_name_normalized = ? AND archived_at IS NULL LIMIT 1').get(full_name_normalized);
    const r = !p && db.prepare("SELECT ref_code FROM registrations WHERE full_name_normalized = ? AND id IS NOT ? AND status <> 'rejected' LIMIT 1").get(full_name_normalized, excludeRegId);
    out.name_match = Boolean(p || r);
    out.name_match_ref = p ? p.person_code : r ? r.ref_code : null; // internal only — not sent to the public
  }
  return out;
}

const EMAIL_TAKEN_MSG = 'This email is already registered. If you believe this is an error, please contact the Lifegen admin.';

function nextRefCode(db) {
  const year = String(today()).slice(0, 4);
  // Registration Reference: LG-YYYY-NNNNNN (6 digits) — distinct from the 4-digit Person ID LG-YYYY-NNNN given on approval.
  const row = db.prepare("SELECT MAX(CAST(substr(ref_code, 9) AS INTEGER)) AS n FROM registrations WHERE ref_code LIKE ? AND length(ref_code) = 14").get(`LG-${year}-%`);
  return `LG-${year}-${String((row?.n || 0) + 1).padStart(6, '0')}`;
}

/** Public submit. Returns { ref_code, status }. */
function submit(body, meta = {}) {
  const db = getDb();
  const s = settings(db);
  if (!on(s.qr_registration_enabled)) throw new HttpError(403, 'Registration is currently unavailable. Please ask the Lifegen team.');
  const data = validate(body, db);
  const ipHash = meta.ip ? crypto.createHash('sha256').update(String(meta.ip)).digest('hex').slice(0, 24) : null;
  const requireApproval = on(s.qr_require_approval);
  try {
    // One transaction: duplicate look-up + insert are atomic (SQLite serialises writers), and the
    // UNIQUE index on email_normalized is the final guard if two identical submits race.
    return db.transaction(() => {
      const dup = duplicates(db, data);
      if (dup.email_taken) throw new HttpError(409, EMAIL_TAKEN_MSG, { email: EMAIL_TAKEN_MSG });
      const flag = on(s.qr_name_duplicate_check) && dup.name_match;
      const info = db.prepare(`INSERT INTO registrations (full_name, full_name_normalized, email, email_normalized, age, school, leader_name, network_leader_name, ministry,
          possible_duplicate, duplicate_note, ip_hash, user_agent)
        VALUES (@full_name, @full_name_normalized, @email, @email_normalized, @age, @school, @leader_name, @network_leader_name, @ministry, @flag, @note, @ip, @ua)`)
        .run({ ...data, flag: flag ? 1 : 0, note: flag ? `Same name as ${dup.name_match_ref} (different email) — please review.` : null, ip: ipHash, ua: String(meta.userAgent || '').slice(0, 160) });
      const id = info.lastInsertRowid;
      const ref = nextRefCode(db);
      db.prepare('UPDATE registrations SET ref_code = ? WHERE id = ?').run(ref, id);
      activity.log(db, null, 'registration.submit', 'registration', id, `New QR registration: ${data.full_name} (${ref})${flag ? ' — possible duplicate' : ''}`);
      let status = 'pending';
      if (!requireApproval) { approve(db, id, null, { mode: 'create' }); status = 'approved'; }
      return { ref_code: ref, status, possible_duplicate: flag };
    })();
  } catch (err) {
    if (isSqliteUnique(err, 'email_normalized')) throw new HttpError(409, EMAIL_TAKEN_MSG, { email: EMAIL_TAKEN_MSG });
    throw err;
  }
}

function get(db, id) {
  return db.prepare(`SELECT r.*, p.person_code, u.display_name AS reviewed_by_name
      FROM registrations r LEFT JOIN people p ON p.id = r.person_id LEFT JOIN users u ON u.id = r.reviewed_by WHERE r.id = ?`).get(id);
}

/** Possible matches shown to the Admin when reviewing (admin-only; includes codes/names). */
function reviewContext(db, reg) {
  const sameName = db.prepare('SELECT id, person_code, first_name, last_name, email, status, school FROM people WHERE full_name_normalized = ? AND archived_at IS NULL LIMIT 5').all(reg.full_name_normalized);
  const sameEmail = db.prepare('SELECT id, person_code, first_name, last_name, status FROM people WHERE email_normalized = ? AND archived_at IS NULL LIMIT 1').get(reg.email_normalized);
  const leaderMatch = db.prepare(`SELECT g.id, g.name, g.gender, COALESCE(lp.first_name || ' ' || lp.last_name, g.leader_name) AS leader_name
      FROM lifegroups g LEFT JOIN people lp ON lp.id = g.leader_person_id
     WHERE g.is_active = 1 AND lower(COALESCE(lp.first_name || ' ' || lp.last_name, g.leader_name)) = lower(?) LIMIT 3`).all(reg.leader_name);
  return { same_name: sameName, same_email: sameEmail || null, matching_groups: leaderMatch };
}

/**
 * Approve: create a person in the shared people table (mode 'create') or link to an existing
 * person (mode 'link', person_id) when the Admin decides the registration is the same human.
 */
function approve(db, id, user, { mode = 'create', person_id = null, status = 'first_timer' } = {}) {
  const reg = get(db, id);
  if (!reg) throw new HttpError(404, 'Registration not found.');
  if (reg.status === 'approved') throw new HttpError(409, 'This registration is already approved.');
  const run = db.transaction(() => {
    let pid;
    if (mode === 'link') {
      const p = db.prepare('SELECT * FROM people WHERE id = ? AND archived_at IS NULL').get(Number(person_id));
      if (!p) throw new HttpError(400, 'Choose an existing person to link to.');
      if (p.email_normalized && p.email_normalized !== reg.email_normalized) throw new HttpError(409, `${p.first_name} ${p.last_name} already has a different email on file.`);
      // fill the blanks only — never overwrite what staff already recorded
      db.prepare(`UPDATE people SET email = COALESCE(NULLIF(email, ''), @email), email_normalized = COALESCE(email_normalized, @email_normalized),
          school = COALESCE(NULLIF(school, ''), @school), age = COALESCE(age, @age), ministry = COALESCE(NULLIF(ministry, ''), @ministry),
          registration_id = COALESCE(registration_id, @rid), updated_at = datetime('now') WHERE id = @pid`)
        .run({ email: reg.email, email_normalized: reg.email_normalized, school: reg.school, age: reg.age, ministry: reg.ministry, rid: reg.id, pid: p.id });
      pid = p.id;
    } else {
      const { first_name, last_name } = splitFullName(reg.full_name);
      const notes = `QR registration ${reg.ref_code} · Leader: ${reg.leader_name} · Network leader: ${reg.network_leader_name}`;
      const info = db.prepare(`INSERT INTO people (first_name, last_name, email, email_normalized, full_name_normalized, school, age, ministry, status, date_registered, notes,
          registration_source, registered_at, registration_id, created_by)
        VALUES (@first_name, @last_name, @email, @email_normalized, @full_name_normalized, @school, @age, @ministry, @status, @date_registered, @notes, 'qr', @registered_at, @rid, @uid)`)
        .run({ first_name, last_name: last_name || first_name, email: reg.email, email_normalized: reg.email_normalized, full_name_normalized: reg.full_name_normalized, school: reg.school, age: reg.age, ministry: reg.ministry,
          status, date_registered: String(reg.submitted_at).slice(0, 10), notes, registered_at: reg.submitted_at, rid: reg.id, uid: user ? user.id : null });
      pid = info.lastInsertRowid;
      const year = String(reg.submitted_at).slice(0, 4);
      const row = db.prepare("SELECT MAX(CAST(substr(person_code, 9) AS INTEGER)) AS n FROM people WHERE person_code LIKE ?").get(`LG-${year}-%`);
      db.prepare('UPDATE people SET person_code = ? WHERE id = ?').run(`LG-${year}-${String((row?.n || 0) + 1).padStart(4, '0')}`, pid);
    }
    db.prepare("UPDATE registrations SET status = 'approved', person_id = ?, approved_at = datetime('now'), rejected_at = NULL, reviewed_by = ?, updated_at = datetime('now') WHERE id = ?").run(pid, user ? user.id : null, id);
    const p = db.prepare('SELECT person_code, first_name, last_name FROM people WHERE id = ?').get(pid);
    activity.log(db, user, 'registration.approve', 'registration', id, `${user ? 'Approved' : 'Auto-approved'} QR registration ${reg.ref_code} → ${p.first_name} ${p.last_name} (${p.person_code})${mode === 'link' ? ' (linked to existing person)' : ''}`);
    return pid;
  });
  try {
    return run();
  } catch (err) {
    if (isSqliteUnique(err, 'email_normalized')) throw new HttpError(409, 'A person with this email already exists — link the registration to that person instead.');
    throw err;
  }
}

function reject(db, id, user, note) {
  const reg = get(db, id);
  if (!reg) throw new HttpError(404, 'Registration not found.');
  if (reg.status === 'approved') throw new HttpError(409, 'Already approved — edit the person instead.');
  db.prepare("UPDATE registrations SET status = 'rejected', rejected_at = datetime('now'), reviewed_by = ?, review_note = ?, updated_at = datetime('now') WHERE id = ?").run(user.id, clean(note), id);
  activity.log(db, user, 'registration.reject', 'registration', id, `Rejected QR registration ${reg.ref_code} (${reg.full_name})${note ? ': ' + clean(note) : ''}`);
  return get(db, id);
}

function update(db, id, user, body) {
  const reg = get(db, id);
  if (!reg) throw new HttpError(404, 'Registration not found.');
  if (reg.status === 'approved') throw new HttpError(409, 'Already approved — edit the person record instead.');
  const data = validate({ ...reg, ...body }, db);
  const dup = duplicates(db, data, id);
  if (dup.email_taken) throw new HttpError(409, 'That email already belongs to another person or registration.');
  try {
    db.prepare(`UPDATE registrations SET full_name=@full_name, full_name_normalized=@full_name_normalized, email=@email, email_normalized=@email_normalized, age=@age, school=@school,
        leader_name=@leader_name, network_leader_name=@network_leader_name, ministry=@ministry, possible_duplicate=@flag, updated_at=datetime('now') WHERE id=@id`)
      .run({ ...data, flag: dup.name_match ? 1 : 0, id });
  } catch (err) {
    if (isSqliteUnique(err, 'email_normalized')) throw new HttpError(409, 'That email already belongs to another registration.');
    throw err;
  }
  activity.log(db, user, 'registration.update', 'registration', id, `Edited QR registration ${reg.ref_code}`);
  return get(db, id);
}

function remove(db, id, user) {
  const reg = get(db, id);
  if (!reg) throw new HttpError(404, 'Registration not found.');
  if (reg.status === 'approved' && reg.person_id) throw new HttpError(409, 'Approved registrations are kept as the audit trail of the person. Delete the person instead if needed.');
  db.prepare('DELETE FROM registrations WHERE id = ?').run(id);
  activity.log(db, user, 'registration.delete', 'registration', id, `Deleted QR registration ${reg.ref_code} (${reg.full_name})`);
}

function list(db, { status = 'pending', q = '' } = {}) {
  const where = [];
  const params = {};
  if (['pending', 'approved', 'rejected'].includes(status)) { where.push('r.status = @status'); params.status = status; }
  const qq = clean(q);
  if (qq) {
    where.push('(r.full_name LIKE @q OR r.email LIKE @q OR r.school LIKE @q OR r.leader_name LIKE @q OR r.network_leader_name LIKE @q OR r.ministry LIKE @q OR r.ref_code LIKE @q)');
    params.q = `%${qq}%`;
  }
  return db.prepare(`SELECT r.*, p.person_code, u.display_name AS reviewed_by_name
      FROM registrations r LEFT JOIN people p ON p.id = r.person_id LEFT JOIN users u ON u.id = r.reviewed_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.submitted_at DESC LIMIT 500`).all(params);
}

function counts(db) {
  const row = db.prepare("SELECT SUM(status='pending') AS pending, SUM(status='approved') AS approved, SUM(status='rejected') AS rejected, COUNT(*) AS total, SUM(status='pending' AND possible_duplicate=1) AS flagged FROM registrations").get();
  return { pending: row.pending || 0, approved: row.approved || 0, rejected: row.rejected || 0, total: row.total || 0, flagged: row.flagged || 0 };
}

module.exports = { FIELDS, MIN_AGE, MAX_AGE, publicOptions, validate, duplicates, submit, get, list, counts, approve, reject, update, remove, reviewContext, settings, on, EMAIL_TAKEN_MSG };
