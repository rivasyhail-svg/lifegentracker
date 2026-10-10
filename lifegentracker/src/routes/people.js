'use strict';

const express = require('express');
const { getDb } = require('../db');
const { clean, isValidDate, today, HttpError, wrap, CONTACT_DIGITS_SQL, intId } = require('../lib/util');
const activity = require('../services/activity');
const lifegroups = require('./lifegroups');
const networks = require('./networks');
const { requirePermission, can } = require('../middleware/auth');
const { normalizeEmail, isValidEmail, normalizeName, isSqliteUnique } = require('../lib/normalize');

const router = express.Router();

const STATUSES = ['first_timer', 'regular', 'member', 'leader', 'inactive'];
const PRIVATE_FIELDS = ['birthdate', 'contact_number', 'email', 'email_normalized', 'address', 'notes'];
const MAX_PHOTO_CHARS = 400 * 1024; // ~300 KB image as data URL

const PERSON_SELECT = `
  SELECT p.*,
         (SELECT COUNT(*) FROM attendance_records r WHERE r.person_id = p.id AND r.status = 'present') AS sundays_attended,
         (SELECT MAX(s.service_date) FROM attendance_records r JOIN services s ON s.id = r.service_id
           WHERE r.person_id = p.id AND r.status = 'present') AS last_attended,
         (SELECT g.name FROM lifegroup_memberships m JOIN lifegroups g ON g.id = m.lifegroup_id
           WHERE m.person_id = p.id AND m.left_at IS NULL) AS lifegroup_name,
         (SELECT m.lifegroup_id FROM lifegroup_memberships m WHERE m.person_id = p.id AND m.left_at IS NULL) AS lifegroup_id
    FROM people p`;

/** Hide private contact details from roles without people:view_private. */
function sanitize(person, user) {
  if (!person) return person;
  if (can(user, 'people:view_private')) return person;
  const copy = { ...person };
  for (const f of PRIVATE_FIELDS) copy[f] = undefined;
  copy.private_hidden = true;
  return copy;
}

function validatePerson(body, existing = null) {
  const src = existing ? { ...existing, ...body } : body;
  const data = {
    first_name: clean(src.first_name),
    last_name: clean(src.last_name),
    middle_name: clean(src.middle_name),
    photo: src.photo === undefined ? (existing ? existing.photo : null) : clean(src.photo),
    birthdate: clean(src.birthdate),
    sex: clean(src.sex),
    contact_number: clean(src.contact_number),
    email: clean(src.email),
    address: clean(src.address),
    school: clean(src.school),
    course_year: clean(src.course_year),
    occupation: clean(src.occupation),
    status: clean(src.status) || 'first_timer',
    date_registered: clean(src.date_registered) || today(),
    date_first_attended: clean(src.date_first_attended),
    notes: clean(src.notes),
    preferred_area: clean(src.preferred_area),
    preferred_day: clean(src.preferred_day),
    preferred_time: clean(src.preferred_time),
    preferred_category: clean(src.preferred_category),
    // Data privacy consent: body.privacy_consent true → keep/set the timestamp; false → clear it
    privacy_consent_at: body.privacy_consent === undefined ? (existing ? existing.privacy_consent_at : null)
      : (body.privacy_consent ? (existing?.privacy_consent_at || today()) : null),
    age: src.age === undefined || src.age === null || src.age === '' ? null : Number(src.age),
    ministry: clean(src.ministry),
  };
  // shared with QR registration → both paths detect duplicates the same way
  data.email_normalized = normalizeEmail(data.email);
  data.full_name_normalized = normalizeName(`${data.first_name || ''} ${data.last_name || ''}`);

  const errors = [];
  if (data.email && !isValidEmail(data.email)) errors.push('Email address looks invalid.');
  if (data.age !== null && (!Number.isInteger(data.age) || data.age < 5 || data.age > 100)) errors.push('Age must be a whole number between 5 and 100.');
  if (data.preferred_day && !lifegroups.DAYS.includes(data.preferred_day)) errors.push('Invalid preferred day.');
  if (data.preferred_time && !lifegroups.TIMES.includes(data.preferred_time)) errors.push('Invalid preferred time.');
  if (!data.first_name) errors.push('First name is required.');
  if (!data.last_name) errors.push('Last name is required.');
  if (!data.contact_number && !(existing && existing.registration_source === 'qr' && !existing.contact_number)) errors.push('Contact number is required.'); // QR registrants have no number yet — staff can add it later
  else if (data.contact_number && data.contact_number.replace(/\D/g, '').length < 7) errors.push('Contact number looks too short.');
  if (!clean(src.status)) errors.push('Status is required.');
  if (data.sex && !['male', 'female'].includes(data.sex)) errors.push('Invalid sex value.');
  if (!STATUSES.includes(data.status)) errors.push('Invalid status.');
  if (data.birthdate && !isValidDate(data.birthdate)) errors.push('Birthday must be a valid date.');
  if (!isValidDate(data.date_registered)) errors.push('Date registered must be a valid date.');
  if (data.date_first_attended && !isValidDate(data.date_first_attended)) errors.push('Date first attended must be a valid date.');
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errors.push('Email address looks invalid.');
  if (data.photo && (!data.photo.startsWith('data:image/') || data.photo.length > MAX_PHOTO_CHARS)) {
    errors.push('Photo must be an image under 300 KB (it is resized automatically in the browser).');
  }
  if (errors.length) throw new HttpError(400, errors.join(' '), errors);
  return data;
}

/**
 * Next Person ID for a registration year: LG-YYYY-NNNN.
 * The sequence restarts every year and never reuses a number (it is derived
 * from the highest existing code for that year, not from a count).
 */
/** One email = one person. The UNIQUE index is the real guard; this turns the DB error into a friendly 409. */
function withEmailGuard(db, data, excludeId, run) {
  try {
    return run();
  } catch (err) {
    if (!isSqliteUnique(err, 'email_normalized')) throw err;
    const other = db.prepare('SELECT id, person_code, first_name, last_name FROM people WHERE email_normalized = ? AND id IS NOT ?').get(data.email_normalized, excludeId);
    const pending = !other && db.prepare("SELECT ref_code FROM registrations WHERE email_normalized = ? AND status = 'pending'").get(data.email_normalized);
    throw new HttpError(409, other
      ? `This email is already used by ${other.first_name} ${other.last_name} (${other.person_code}). One email = one person.`
      : pending ? `This email has a pending QR registration (${pending.ref_code}) — approve it instead of registering again.` : 'This email is already registered.');
  }
}

function nextPersonCode(db, dateRegistered) {
  const year = String(dateRegistered).slice(0, 4);
  const row = db
    .prepare("SELECT MAX(CAST(substr(person_code, 9) AS INTEGER)) AS n FROM people WHERE person_code LIKE ?")
    .get(`LG-${year}-%`);
  return `LG-${year}-${String((row?.n || 0) + 1).padStart(4, '0')}`;
}

function getPerson(db, id) {
  return db.prepare(`${PERSON_SELECT} WHERE p.id = ?`).get(id);
}

// GET /api/people
//   ?q=            name / person ID / contact number
//   ?status=       one of STATUSES | 'active' (everything but inactive) | 'all'
//   ?attendance=   'attended' | 'never' | 'recent' (last 4 Sundays) | 'missing' (not in last 4 Sundays)
//   ?first_timer=1 people whose status is first_timer
//   ?sort=         name | recent | attendance | last_attended
router.get(
  '/',
  requirePermission('people:view'),
  wrap((req, res) => {
    const db = getDb();
    const where = [];
    const params = {};

    const q = clean(req.query.q);
    if (q) {
      const digits = q.replace(/\D/g, '');
      where.push(`(p.first_name || ' ' || p.last_name LIKE @q
                OR p.last_name || ', ' || p.first_name LIKE @q
                OR p.last_name || ' ' || p.first_name LIKE @q
                OR p.person_code LIKE @q
                ${digits.length >= 3 && can(req.user, 'people:view_private') ? `OR ${CONTACT_DIGITS_SQL} LIKE @digits` : ''})`);
      params.q = `%${q}%`;
      params.digits = `%${digits}%`;
    }

    const status = clean(req.query.status) || 'active';
    if (status === 'archived') where.push('p.archived_at IS NOT NULL');
    else {
      where.push('p.archived_at IS NULL'); // archived people never appear in normal lists
      if (status === 'active') where.push("p.status <> 'inactive'");
      else if (status !== 'all' && STATUSES.includes(status)) { where.push('p.status = @status'); params.status = status; }
    }

    if (req.query.first_timer === '1') where.push("p.status = 'first_timer'");

    const attendance = clean(req.query.attendance);
    if (attendance === 'attended') where.push("EXISTS (SELECT 1 FROM attendance_records r WHERE r.person_id = p.id AND r.status = 'present')");
    if (attendance === 'never') where.push("NOT EXISTS (SELECT 1 FROM attendance_records r WHERE r.person_id = p.id AND r.status = 'present')");
    if (attendance === 'recent' || attendance === 'missing') {
      const recent = `EXISTS (SELECT 1 FROM attendance_records r JOIN services s ON s.id = r.service_id
                       WHERE r.person_id = p.id AND r.status = 'present'
                         AND s.id IN (SELECT id FROM services ORDER BY service_date DESC LIMIT 4))`;
      where.push(attendance === 'recent' ? recent : `NOT ${recent}`);
    }

    const sortMap = {
      name: 'p.last_name COLLATE NOCASE, p.first_name COLLATE NOCASE',
      recent: 'p.created_at DESC, p.id DESC',
      attendance: 'sundays_attended DESC, p.last_name COLLATE NOCASE',
      last_attended: 'last_attended IS NULL, last_attended DESC, p.last_name COLLATE NOCASE',
    };
    const orderBy = sortMap[req.query.sort] || sortMap.name;
    const limit = Math.min(Math.max(Number(req.query.limit) || 1000, 1), 2000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const sql = `${PERSON_SELECT} ${whereSql} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`;
    const rows = db.prepare(sql).all(params).map((p) => sanitize(p, req.user));
    // Paged shape when the client asks for it (?paged=1); plain array otherwise (backwards compatible).
    if (req.query.paged === '1') {
      const total = db.prepare(`SELECT COUNT(*) AS n FROM people p ${whereSql}`).get(params).n;
      return res.json({ rows, total, limit, offset, has_more: offset + rows.length < total });
    }
    res.json(rows);
  })
);

// GET /api/people/duplicates?first_name&last_name&contact_number&email&birthdate&exclude_id
// Possible duplicates for the registration form (same contact/email, or same name).
router.get(
  '/duplicates',
  requirePermission('people:write'),
  wrap((req, res) => {
    const db = getDb();
    const first = clean(req.query.first_name), last = clean(req.query.last_name);
    const digits = (clean(req.query.contact_number) || '').replace(/\D/g, '');
    const email = (clean(req.query.email) || '').toLowerCase();
    const birthdate = clean(req.query.birthdate);
    const excludeId = req.query.exclude_id ? intId(req.query.exclude_id) : 0;
    const reasons = [];
    const params = { ex: excludeId };
    if (digits.length >= 7) { reasons.push(`${CONTACT_DIGITS_SQL} = @digits`); params.digits = digits; }
    if (email) { reasons.push('lower(p.email) = @email'); params.email = email; }
    if (first && last) {
      reasons.push('(lower(p.first_name) = @first AND lower(p.last_name) = @last)');
      params.first = first.toLowerCase(); params.last = last.toLowerCase();
    }
    if (!reasons.length) return res.json({ matches: [] });
    const rows = db
      .prepare(`SELECT p.id, p.person_code, p.first_name, p.last_name, p.status, p.contact_number, p.email,
                       p.birthdate, p.archived_at, p.date_registered
                  FROM people p WHERE p.id <> @ex AND (${reasons.join(' OR ')})
                 ORDER BY p.archived_at IS NOT NULL, p.last_name COLLATE NOCASE LIMIT 10`)
      .all(params);
    const matches = rows.map((r) => {
      const why = [];
      if (digits.length >= 7 && (r.contact_number || '').replace(/\D/g, '') === digits) why.push('same contact number');
      if (email && (r.email || '').toLowerCase() === email) why.push('same email');
      if (first && last && r.first_name.toLowerCase() === first.toLowerCase() && r.last_name.toLowerCase() === last.toLowerCase()) {
        why.push(birthdate && r.birthdate === birthdate ? 'same name and birthday' : 'same name');
      }
      return { ...sanitize(r, req.user), reasons: why };
    });
    res.json({ matches });
  })
);

// GET /api/people/statuses — for dropdowns
router.get('/statuses', requirePermission('people:view'), (req, res) => res.json(STATUSES));

// GET /api/people/:id — profile + attendance history
router.get(
  '/:id',
  requirePermission('people:view'),
  wrap((req, res) => {
    const db = getDb();
    const person = getPerson(db, intId(req.params.id));
    if (!person) throw new HttpError(404, 'Person not found.');

    const history = db
      .prepare(
        `SELECT r.id, s.id AS service_id, s.service_date, r.status, r.classification, r.recorded_at,
                u.display_name AS recorded_by
           FROM attendance_records r
           JOIN services s ON s.id = r.service_id
           LEFT JOIN users u ON u.id = r.recorded_by
          WHERE r.person_id = ?
          ORDER BY s.service_date DESC`
      )
      .all(person.id);

    const since = person.date_first_attended || person.date_registered;
    const servicesSince = db.prepare('SELECT COUNT(*) AS n FROM services WHERE service_date >= ?').get(since).n;
    const rate = servicesSince ? Math.round((person.sundays_attended / servicesSince) * 1000) / 10 : null;

    const lg = lifegroups.membershipFor(db, person.id, req.user);
    res.json({ ...sanitize(person, req.user), history, services_since: servicesSince, attendance_rate: rate,
      lifegroup: lg.current, lifegroup_history: lg.history, leadership: networks.leadershipFor(db, person.id) });
  })
);

// POST /api/people
router.post(
  '/',
  requirePermission('people:write'),
  wrap((req, res) => {
    const db = getDb();
    const data = validatePerson(req.body || {});
    const id = withEmailGuard(db, data, null, () => db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO people (first_name, last_name, middle_name, photo, birthdate, sex, contact_number, email,
                               address, school, course_year, occupation, status, date_registered,
                               date_first_attended, notes, preferred_area, preferred_day, preferred_time, preferred_category, privacy_consent_at,
                               age, ministry, email_normalized, full_name_normalized, registration_source, registered_at, created_by)
           VALUES (@first_name, @last_name, @middle_name, @photo, @birthdate, @sex, @contact_number, @email,
                   @address, @school, @course_year, @occupation, @status, @date_registered,
                   @date_first_attended, @notes, @preferred_area, @preferred_day, @preferred_time, @preferred_category, @privacy_consent_at,
                   @age, @ministry, @email_normalized, @full_name_normalized, 'manual', datetime('now'), @created_by)`
        )
        .run({ ...data, created_by: req.user.id });
      const newId = info.lastInsertRowid;
      db.prepare('UPDATE people SET person_code = ? WHERE id = ?').run(nextPersonCode(db, data.date_registered), newId);
      return newId;
    })());
    const created = getPerson(db, id);
    activity.log(db, req.user, 'person.create', 'person', id, `Registered ${created.first_name} ${created.last_name} (${created.person_code})`);
    res.status(201).json(created);
  })
);

// PUT /api/people/:id
router.put(
  '/:id',
  requirePermission('people:write'),
  wrap((req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM people WHERE id = ?').get(intId(req.params.id));
    if (!existing) throw new HttpError(404, 'Person not found.');
    const data = validatePerson(req.body || {}, existing);
    withEmailGuard(db, data, existing.id, () => db.prepare(
      `UPDATE people SET first_name=@first_name, last_name=@last_name, middle_name=@middle_name, photo=@photo,
              birthdate=@birthdate, sex=@sex, contact_number=@contact_number, email=@email, address=@address,
              school=@school, course_year=@course_year, occupation=@occupation, status=@status,
              date_registered=@date_registered, date_first_attended=@date_first_attended, notes=@notes,
              preferred_area=@preferred_area, preferred_day=@preferred_day, preferred_time=@preferred_time, preferred_category=@preferred_category,
              privacy_consent_at=@privacy_consent_at, age=@age, ministry=@ministry, email_normalized=@email_normalized, full_name_normalized=@full_name_normalized,
              updated_at=datetime('now')
        WHERE id=@id`
    ).run({ ...data, id: existing.id }));
    const changed = Object.keys(data).filter((k) => k !== 'photo' && (existing[k] ?? null) !== (data[k] ?? null));
    if (data.photo !== existing.photo) changed.push('photo');
    activity.log(db, req.user, 'person.update', 'person', existing.id,
      `Edited ${data.first_name} ${data.last_name} (${existing.person_code})${changed.length ? ': ' + changed.join(', ') : ''}`);
    res.json(getPerson(db, existing.id));
  })
);

// PATCH /api/people/:id/status  { status }
router.patch(
  '/:id/status',
  requirePermission('people:write'),
  wrap((req, res) => {
    const db = getDb();
    const status = clean(req.body?.status);
    if (!STATUSES.includes(status)) throw new HttpError(400, 'Invalid status.');
    const id = intId(req.params.id);
    const before = db.prepare('SELECT first_name, last_name, person_code, status FROM people WHERE id = ?').get(id);
    if (!before) throw new HttpError(404, 'Person not found.');
    db.prepare("UPDATE people SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
    if (before.status !== status) {
      activity.log(db, req.user, 'person.status', 'person', id, `${before.first_name} ${before.last_name} (${before.person_code}): status ${before.status} → ${status}`);
    }
    res.json(getPerson(db, id));
  })
);

// DELETE /api/people/:id — admin only; permanently removes the person and their attendance
router.delete(
  '/:id',
  requirePermission('people:delete'),
  wrap((req, res) => {
    const db = getDb();
    const id = intId(req.params.id);
    const p = db.prepare('SELECT first_name, last_name, person_code FROM people WHERE id = ?').get(id);
    if (!p) throw new HttpError(404, 'Person not found.');
    const n = db.prepare('SELECT COUNT(*) AS n FROM attendance_records WHERE person_id = ?').get(id).n;
    db.prepare('DELETE FROM people WHERE id = ?').run(id);
    activity.log(db, req.user, 'person.delete', 'person', id, `Permanently deleted ${p.first_name} ${p.last_name} (${p.person_code}) and ${n} attendance record(s)`);
    res.status(204).end();
  })
);

// PUT /api/people/:id/preferences { preferred_area, preferred_day, preferred_time, preferred_category }
router.put(
  '/:id/preferences',
  requirePermission('people:write'),
  wrap((req, res) => {
    const db = getDb();
    const id = intId(req.params.id);
    if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(id)) throw new HttpError(404, 'Person not found.');
    const b = req.body || {};
    const prefs = { preferred_area: clean(b.preferred_area), preferred_day: clean(b.preferred_day), preferred_time: clean(b.preferred_time), preferred_category: clean(b.preferred_category) };
    if (prefs.preferred_day && !lifegroups.DAYS.includes(prefs.preferred_day)) throw new HttpError(400, 'Invalid preferred day.');
    if (prefs.preferred_time && !lifegroups.TIMES.includes(prefs.preferred_time)) throw new HttpError(400, 'Invalid preferred time.');
    db.prepare("UPDATE people SET preferred_area=@preferred_area, preferred_day=@preferred_day, preferred_time=@preferred_time, preferred_category=@preferred_category, updated_at=datetime('now') WHERE id=@id").run({ ...prefs, id });
    if (b.sex !== undefined && b.sex !== null && b.sex !== '') { // Boy/Girl can be completed from the "Find a Lifegroup" dialog
      if (!['male', 'female'].includes(b.sex)) throw new HttpError(400, 'Invalid sex value.');
      db.prepare('UPDATE people SET sex = ? WHERE id = ?').run(b.sex, id);
    }
    res.json(getPerson(db, id));
  })
);

// POST /api/people/:id/archive — hide from lists/rosters; attendance history is kept
router.post(
  '/:id/archive',
  requirePermission('people:write'),
  wrap((req, res) => {
    const db = getDb();
    const id = intId(req.params.id);
    const p = db.prepare('SELECT first_name, last_name, person_code, archived_at FROM people WHERE id = ?').get(id);
    if (!p) throw new HttpError(404, 'Person not found.');
    if (!p.archived_at) {
      db.prepare("UPDATE people SET archived_at = datetime('now'), archived_by = ?, updated_at = datetime('now') WHERE id = ?").run(req.user.id, id);
      activity.log(db, req.user, 'person.archive', 'person', id, `Archived ${p.first_name} ${p.last_name} (${p.person_code})`);
    }
    res.json(getPerson(db, id));
  })
);

// POST /api/people/:id/restore — bring an archived person back
router.post(
  '/:id/restore',
  requirePermission('people:write'),
  wrap((req, res) => {
    const db = getDb();
    const id = intId(req.params.id);
    const p = db.prepare('SELECT first_name, last_name, person_code, archived_at FROM people WHERE id = ?').get(id);
    if (!p) throw new HttpError(404, 'Person not found.');
    if (p.archived_at) {
      db.prepare("UPDATE people SET archived_at = NULL, archived_by = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
      activity.log(db, req.user, 'person.restore', 'person', id, `Restored ${p.first_name} ${p.last_name} (${p.person_code}) from archive`);
    }
    res.json(getPerson(db, id));
  })
);

module.exports = router;
module.exports.STATUSES = STATUSES;
module.exports.sanitize = sanitize;
