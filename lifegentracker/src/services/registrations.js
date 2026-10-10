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
const guard = require('./qrguard');

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
function publicOptions(db, { token, device_id } = {}) {
  const s = settings(db);
  const st = guard.status(db, s, { token });
  const enabled = st.open;
  const out = { enabled, closed_reason: enabled ? null : st.reason, closed_message: enabled ? null : st.message, window: st.window, window_label: st.window_label,
    church_name: s.church_name, service_name: s.service_name, ministries: ministries(db, s), schools: [], leaders: [], network_leaders: [], name_check: on(s.qr_name_duplicate_check),
    device_lock: on(s.qr_device_lock), min_seconds: guard.MIN_FORM_SECONDS };
  if (!enabled) return out;
  if (out.device_lock && device_id) {
    const prev = db.prepare("SELECT ref_code FROM registrations WHERE device_id = ? AND status <> 'rejected' ORDER BY id DESC LIMIT 1").get(device_id);
    if (prev) { out.already_registered = true; out.ref_code = prev.ref_code; }
  }
  out.form_token = guard.formToken(db);
  out.schools = db.prepare("SELECT DISTINCT trim(school) AS v FROM people WHERE school IS NOT NULL AND trim(school) <> '' AND archived_at IS NULL LIMIT 300").all().map((r) => r.v).sort(ci);
  if (on(s.qr_show_leaders)) {
    // first + last name of active leaders only (no contact details, no ids)
    out.leaders = db.prepare(`SELECT DISTINCT COALESCE(lp.first_name || ' ' || lp.last_name, g.leader_name) AS v
        FROM lifegroups g LEFT JOIN people lp ON lp.id = g.leader_person_id
       WHERE g.is_active = 1 AND (g.leader_person_id IS NOT NULL OR g.leader_name IS NOT NULL) `).all().map((r) => r.v).filter(Boolean).sort(ci);
    out.network_leaders = db.prepare(`SELECT DISTINCT COALESCE(lp.first_name || ' ' || lp.last_name, n.leader_name) AS v
        FROM networks n LEFT JOIN people lp ON lp.id = n.leader_person_id
       WHERE n.is_active = 1 AND (n.leader_person_id IS NOT NULL OR n.leader_name IS NOT NULL) `).all().map((r) => r.v).filter(Boolean).sort(ci);
    // Tap-to-pick lists (names only — no ids, no contact details). Leaders = cell leaders with an open cell
    // (network leaders' own Lifegroups hold the cell leaders, so they are not offered as "your leader").
    out.leader_options = db.prepare(`SELECT DISTINCT COALESCE(lp.first_name || ' ' || lp.last_name, g.leader_name) AS name, g.gender,
          COALESCE(np.first_name || ' ' || np.last_name, n.leader_name) AS network_leader
        FROM lifegroups g LEFT JOIN people lp ON lp.id = g.leader_person_id
        LEFT JOIN networks n ON n.id = g.network_id LEFT JOIN people np ON np.id = n.leader_person_id
       WHERE g.is_active = 1 AND (g.leader_person_id IS NOT NULL OR g.leader_name IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM networks xn WHERE xn.leader_person_id = g.leader_person_id AND xn.is_active = 1)`).all()
      .filter((r) => r.name).map((r) => ({ name: r.name, gender: r.gender || null, network_leader: r.network_leader || null })).sort((a, b) => ci(a.name, b.name));
    out.network_leader_options = db.prepare(`SELECT DISTINCT COALESCE(lp.first_name || ' ' || lp.last_name, n.leader_name) AS name, n.gender
        FROM networks n LEFT JOIN people lp ON lp.id = n.leader_person_id
       WHERE n.is_active = 1 AND (n.leader_person_id IS NOT NULL OR n.leader_name IS NOT NULL)`).all()
      .filter((r) => r.name).map((r) => ({ name: r.name, gender: r.gender || null })).sort((a, b) => ci(a.name, b.name));
  }
  return out;
}

/** Validate + normalise a public submission (also used by the admin Edit). Throws 400 with per-field errors. */
function validate(body, db, { strict = false } = {}) {
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
  data.email_normalized = normalizeEmail(data.email);
  data.full_name_normalized = normalizeName(data.full_name);
  if (strict) { // public form: real-person rules (admin Edit keeps the relaxed rules so staff can fix odd-but-real names)
    if (!errors.full_name) { const p = guard.nameProblem(data.full_name_normalized); if (p) errors.full_name = p; }
    if (!errors.email) { const p = guard.emailProblem(data.email_normalized); if (p) errors.email = p; }
    for (const k of ['school', 'leader_name', 'network_leader_name']) {
      if (!errors[k] && /(.)\1\1\1/.test(data[k]) ) errors[k] = 'Please check this field — it does not look right.';
    }
  }
  if (Object.keys(errors).length) throw new HttpError(400, Object.values(errors)[0], errors);
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
  const st = guard.status(db, s, { token: meta.token ?? body?.qr_token });
  if (!st.open) throw new HttpError(403, st.message, { reason: st.reason });
  const formSeconds = guard.checkFormToken(db, body?.form_token);
  const data = validate(body, db, { strict: true });
  const ipHash = meta.ip ? crypto.createHash('sha256').update(String(meta.ip)).digest('hex').slice(0, 24) : null;
  const deviceId = meta.deviceId || null;
  const requireApproval = on(s.qr_require_approval);
  // blocklist first (quiet, generic message), then volume caps, then the per-device rule
  if (guard.blocked(db, { email_normalized: data.email_normalized, device_id: deviceId, ip_hash: ipHash })) throw new HttpError(403, guard.BLOCKED_MSG, { reason: 'blocked' });
  guard.enforceCaps(db, s, { ip_hash: ipHash });
  try {
    // One transaction: duplicate look-up + insert are atomic (SQLite serialises writers), and the
    // UNIQUE index on email_normalized is the final guard if two identical submits race.
    return db.transaction(() => {
      if (on(s.qr_device_lock) && deviceId) {
        const prev = db.prepare("SELECT ref_code FROM registrations WHERE device_id = ? AND status <> 'rejected' ORDER BY id DESC LIMIT 1").get(deviceId);
        if (prev) throw new HttpError(409, `This phone already submitted a registration (${prev.ref_code}). One registration per person — if you need to change something, please tell your leader or the Lifegen admin.`, { reason: 'device', ref_code: prev.ref_code });
      }
      const dup = duplicates(db, data);
      if (dup.email_taken) throw new HttpError(409, EMAIL_TAKEN_MSG, { email: EMAIL_TAKEN_MSG });
      const flag = on(s.qr_name_duplicate_check) && dup.name_match;
      const flags = guard.riskFlags(db, { device_id: deviceId, ip_hash: ipHash, form_seconds: formSeconds, email_normalized: data.email_normalized, full_name_normalized: data.full_name_normalized });
      const info = db.prepare(`INSERT INTO registrations (full_name, full_name_normalized, email, email_normalized, age, school, leader_name, network_leader_name, ministry,
          possible_duplicate, duplicate_note, ip_hash, user_agent, device_id, risk_flags, form_seconds)
        VALUES (@full_name, @full_name_normalized, @email, @email_normalized, @age, @school, @leader_name, @network_leader_name, @ministry, @flag, @note, @ip, @ua, @device, @risk, @secs)`)
        .run({ ...data, flag: flag ? 1 : 0, note: flag ? `Same name as ${dup.name_match_ref} (different email) — please review.` : null, ip: ipHash, ua: String(meta.userAgent || '').slice(0, 160),
          device: deviceId, risk: flags.length ? flags.join(',') : null, secs: formSeconds });
      const id = info.lastInsertRowid;
      const ref = nextRefCode(db);
      db.prepare('UPDATE registrations SET ref_code = ? WHERE id = ?').run(ref, id);
      activity.log(db, null, 'registration.submit', 'registration', id, `New QR registration: ${data.full_name} (${ref})${flag ? ' — possible duplicate' : ''}${flags.length ? ' — flags: ' + flags.join(', ') : ''}`);
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
  return db.prepare(`SELECT r.*, p.person_code, u.display_name AS reviewed_by_name,
             (SELECT g.name FROM lifegroup_memberships m JOIN lifegroups g ON g.id = m.lifegroup_id WHERE m.person_id = r.person_id AND m.left_at IS NULL LIMIT 1) AS lifegroup_name,
             (SELECT m.lifegroup_id FROM lifegroup_memberships m WHERE m.person_id = r.person_id AND m.left_at IS NULL LIMIT 1) AS lifegroup_id
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
 * After approval, put the person straight under the Lifegroup of the leader they named (as open cell / new),
 * so the leader sees them on the QR page without the admin assigning by hand.
 * Match = active group whose leader name equals the typed leader name (case-insensitive); when several leaders
 * share a name, the one whose network leader matches wins; otherwise nothing is done (admin assigns manually).
 */
function autoPlace(db, pid, reg, user) {
  if (!reg.leader_name) return null;
  const cur = db.prepare('SELECT lifegroup_id FROM lifegroup_memberships WHERE person_id = ? AND left_at IS NULL').get(pid);
  if (cur) return null; // already in a Lifegroup — never move people automatically
  const rows = db.prepare(`SELECT g.id, g.name, g.gender, g.capacity, COALESCE(lp.first_name || ' ' || lp.last_name, g.leader_name) AS leader_name,
        COALESCE(np.first_name || ' ' || np.last_name, n.leader_name) AS network_leader_name,
        (SELECT COUNT(*) FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id WHERE m.lifegroup_id = g.id AND m.left_at IS NULL AND p.archived_at IS NULL) AS member_count
      FROM lifegroups g LEFT JOIN people lp ON lp.id = g.leader_person_id LEFT JOIN networks n ON n.id = g.network_id LEFT JOIN people np ON np.id = n.leader_person_id
     WHERE g.is_active = 1 AND lower(COALESCE(lp.first_name || ' ' || lp.last_name, g.leader_name)) = lower(?)`).all(reg.leader_name);
  if (!rows.length) return null;
  let pick = rows[0];
  if (rows.length > 1) {
    const byNet = rows.filter((r) => r.network_leader_name && reg.network_leader_name && r.network_leader_name.toLowerCase() === reg.network_leader_name.toLowerCase());
    if (byNet.length !== 1) return null; // ambiguous — leave it to the admin
    pick = byNet[0];
  }
  const person = db.prepare('SELECT sex FROM people WHERE id = ?').get(pid);
  const want = pick.gender === 'boys' ? 'male' : pick.gender === 'girls' ? 'female' : null;
  if (person.sex && want && person.sex !== want) return null; // never put a girl in a boys group or vice versa
  if (!person.sex && want) db.prepare("UPDATE people SET sex = ?, updated_at = datetime('now') WHERE id = ?").run(want, pid); // the group tells us
  try { require('./lifegroup-progress').assertRoom(db, pick.id, pick.name); } catch { return null; } // full → admin places by hand
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  db.prepare("INSERT INTO lifegroup_memberships (person_id, lifegroup_id, role, tier, joined_at, assigned_by, notes) VALUES (?, ?, 'member', 'new', ?, ?, ?)")
    .run(pid, pick.id, today, user ? user.id : null, `Placed automatically from QR registration ${reg.ref_code} (leader: ${reg.leader_name})`);
  activity.log(db, user, 'lifegroup.assign', 'person', pid, `Placed under ${pick.name} (open cell) automatically — leader named on QR registration ${reg.ref_code}`);
  return { id: pick.id, name: pick.name, leader_name: pick.leader_name, full: pick.capacity != null && pick.member_count + 1 > pick.capacity };
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
    const placed = autoPlace(db, pid, reg, user);
    return { pid, placed };
  });
  try {
    const out = run();
    if (out.placed) { try { require('./networks-auto').syncNetworks(db, user || null); } catch { /* best effort */ } }
    approve.lastPlacement = out.placed;
    return out.pid;
  } catch (err) {
    if (isSqliteUnique(err, 'email_normalized')) throw new HttpError(409, 'A person with this email already exists — link the registration to that person instead.');
    throw err;
  }
}

function reject(db, id, user, note, blocks = {}) {
  const reg = get(db, id);
  if (!reg) throw new HttpError(404, 'Registration not found.');
  if (reg.status === 'approved') throw new HttpError(409, 'Already approved — edit the person instead.');
  db.prepare("UPDATE registrations SET status = 'rejected', rejected_at = datetime('now'), reviewed_by = ?, review_note = ?, updated_at = datetime('now') WHERE id = ?").run(user.id, clean(note), id);
  activity.log(db, user, 'registration.reject', 'registration', id, `Rejected QR registration ${reg.ref_code} (${reg.full_name})${note ? ': ' + clean(note) : ''}`);
  const reason = `Rejected ${reg.ref_code}${note ? ': ' + clean(note) : ''}`;
  if (blocks.email) addBlock(db, user, 'email', reg.email_normalized, reason);
  if (blocks.device && reg.device_id) addBlock(db, user, 'device', reg.device_id, reason);
  if (blocks.ip && reg.ip_hash) addBlock(db, user, 'ip', reg.ip_hash, reason);
  return get(db, id);
}

/** Reject many pending rows at once (troll bursts). Returns { rejected, skipped }. */
function bulkReject(db, ids, user, note, blocks = {}) {
  const out = { rejected: 0, skipped: 0 };
  db.transaction(() => {
    for (const raw of ids) {
      const id = Number(raw);
      const r = Number.isInteger(id) ? get(db, id) : null;
      if (!r || r.status !== 'pending') { out.skipped += 1; continue; }
      reject(db, id, user, note, blocks);
      out.rejected += 1;
    }
  })();
  return out;
}

// --- blocklist ---------------------------------------------------------------
const BLOCK_KINDS = ['email', 'domain', 'device', 'ip'];
function addBlock(db, user, kind, value, reason) {
  if (!BLOCK_KINDS.includes(kind)) throw new HttpError(400, 'Unknown block type.');
  let v = clean(value);
  if (!v) throw new HttpError(400, 'Value is required.');
  if (kind === 'email') { v = normalizeEmail(v); if (!isValidEmail(v)) throw new HttpError(400, 'Enter a valid email address.'); }
  if (kind === 'domain') { v = v.toLowerCase().replace(/^@/, ''); if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) throw new HttpError(400, 'Enter a domain like example.com.'); }
  db.prepare('INSERT OR IGNORE INTO registration_blocks (kind, value, reason, created_by) VALUES (?, ?, ?, ?)').run(kind, v, clean(reason) || null, user ? user.id : null);
  activity.log(db, user, 'registration.block', 'registration_block', null, `Blocked ${kind} ${kind === 'email' || kind === 'domain' ? v : v.slice(0, 8) + '…'}${reason ? ' — ' + clean(reason) : ''}`);
  return listBlocks(db);
}
function removeBlock(db, user, id) {
  const b = db.prepare('SELECT * FROM registration_blocks WHERE id = ?').get(id);
  if (!b) throw new HttpError(404, 'Block not found.');
  db.prepare('DELETE FROM registration_blocks WHERE id = ?').run(id);
  activity.log(db, user, 'registration.unblock', 'registration_block', id, `Unblocked ${b.kind} ${b.kind === 'email' || b.kind === 'domain' ? b.value : b.value.slice(0, 8) + '…'}`);
}
function listBlocks(db) {
  return db.prepare(`SELECT b.*, u.display_name AS created_by_name,
      (SELECT COUNT(*) FROM registrations r WHERE (b.kind = 'email' AND r.email_normalized = b.value) OR (b.kind = 'device' AND r.device_id = b.value) OR (b.kind = 'ip' AND r.ip_hash = b.value)) AS linked
      FROM registration_blocks b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.created_at DESC, b.id DESC LIMIT 500`).all();
}

// --- guard controls (admin) ----------------------------------------------------
function guardState(db) {
  const s = settings(db);
  const st = guard.status(db, s, { token: s.qr_mode === 'rotating' ? guard.rotation(db, s).token : undefined });
  const rot = guard.rotation(db, s);
  const now = guard.churchNow(s.qr_timezone);
  return {
    mode: s.qr_mode === 'rotating' ? 'rotating' : 'reusable', window: st.window, window_label: st.window_label,
    window_start: s.qr_window_start || '12:00', window_end: s.qr_window_end || '17:00', timezone: s.qr_timezone || 'Asia/Manila',
    device_lock: on(s.qr_device_lock), hourly_cap: Number(s.qr_hourly_cap) || 0, ip_daily_cap: Number(s.qr_ip_daily_cap) || 0,
    paused_at: s.qr_auto_paused_at || null, open_until: s.qr_open_until && Date.parse(s.qr_open_until) > Date.now() ? s.qr_open_until : null,
    open_now: st.open, closed_reason: st.open ? null : st.reason,
    church_time: `${guard.DAY_NAMES[now.dow]} ${guard.fmtTime(now.minutes)}`, church_date: now.date,
    rotation: { token: rot.token, week_start: rot.week_start, valid_through: rot.valid_through },
    last_hour: guard.recentCount(db, 60), blocks: db.prepare('SELECT COUNT(*) AS n FROM registration_blocks').get().n,
  };
}
function setSetting(db, key, value) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')").run(key, value);
}
function resume(db, user) {
  setSetting(db, 'qr_auto_paused_at', '');
  activity.log(db, user, 'registration.resume', 'settings', null, 'QR registration resumed after auto-pause');
  return guardState(db);
}
function rotate(db, user) {
  const s = settings(db);
  setSetting(db, 'qr_rotation_epoch', String((Number(s.qr_rotation_epoch) || 0) + 1));
  activity.log(db, user, 'qr.rotate', 'settings', null, 'Generated a new rotating QR code — older printed codes no longer work');
  return guardState(db);
}
function openNow(db, user, hours) {
  const h = Math.min(12, Math.max(0, Number(hours) || 0));
  const until = h ? new Date(Date.now() + h * 3600 * 1000).toISOString() : '';
  setSetting(db, 'qr_open_until', until);
  activity.log(db, user, 'qr.open_now', 'settings', null, h ? `Opened QR registration outside the Sunday window for ${h} hour${h === 1 ? '' : 's'}` : 'Closed the temporary registration window');
  return guardState(db);
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
  return db.prepare(`SELECT r.*, p.person_code, u.display_name AS reviewed_by_name,
             (SELECT g.name FROM lifegroup_memberships m JOIN lifegroups g ON g.id = m.lifegroup_id WHERE m.person_id = r.person_id AND m.left_at IS NULL LIMIT 1) AS lifegroup_name,
             (SELECT m.lifegroup_id FROM lifegroup_memberships m WHERE m.person_id = r.person_id AND m.left_at IS NULL LIMIT 1) AS lifegroup_id
      FROM registrations r LEFT JOIN people p ON p.id = r.person_id LEFT JOIN users u ON u.id = r.reviewed_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.submitted_at DESC LIMIT 500`).all(params);
}

function counts(db) {
  const row = db.prepare("SELECT SUM(status='pending') AS pending, SUM(status='approved') AS approved, SUM(status='rejected') AS rejected, COUNT(*) AS total, SUM(status='pending' AND possible_duplicate=1) AS flagged FROM registrations").get();
  return { pending: row.pending || 0, approved: row.approved || 0, rejected: row.rejected || 0, total: row.total || 0, flagged: row.flagged || 0 };
}

module.exports = { FIELDS, MIN_AGE, MAX_AGE, publicOptions, validate, duplicates, submit, get, list, counts, approve, reject, bulkReject, update, remove, reviewContext, settings, on, EMAIL_TAKEN_MSG,
  BLOCK_KINDS, addBlock, removeBlock, listBlocks, guardState, resume, rotate, openNow, guard };
