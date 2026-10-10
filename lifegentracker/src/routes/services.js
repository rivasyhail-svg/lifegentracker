'use strict';

const express = require('express');
const { getDb } = require('../db');
const { clean, isSunday, HttpError, wrap, intId } = require('../lib/util');
const { requirePermission, can } = require('../middleware/auth');
const stats = require('../services/stats');
const guard = require('../services/qrguard');

const router = express.Router();
const SERVICE_TYPE = 'lifegen';

function rosterFor(db, serviceId, user) {
  const rows = db
    .prepare(
      `SELECT p.id, p.person_code, p.first_name, p.last_name, p.photo, p.sex, p.status,
              p.contact_number, p.date_first_attended, p.date_registered,
              r.id AS record_id, r.status AS att_status, r.classification, r.recorded_at,
              u.display_name AS recorded_by,
              EXISTS (SELECT 1 FROM attendance_records r2 JOIN services s2 ON s2.id = r2.service_id
                       WHERE r2.person_id = p.id AND r2.status = 'present'
                         AND s2.service_date < (SELECT service_date FROM services WHERE id = @sid)) AS attended_before
         FROM people p
         LEFT JOIN attendance_records r ON r.person_id = p.id AND r.service_id = @sid
         LEFT JOIN users u ON u.id = r.recorded_by
        WHERE (p.status <> 'inactive' AND p.archived_at IS NULL) OR r.id IS NOT NULL
        ORDER BY p.last_name COLLATE NOCASE, p.first_name COLLATE NOCASE`
    )
    .all({ sid: serviceId });

  const showPrivate = can(user, 'people:view_private');
  if (!showPrivate) for (const p of rows) p.contact_number = undefined;
  return rows;
}

/** Recompute date_first_attended from remaining present records when an auto-set date is undone. */
function rollbackFirstAttended(db, personId, serviceDate) {
  const p = db.prepare('SELECT date_first_attended FROM people WHERE id = ?').get(personId);
  if (!p || p.date_first_attended !== serviceDate) return;
  const min = db
    .prepare(
      `SELECT MIN(s.service_date) AS d FROM attendance_records r JOIN services s ON s.id = r.service_id
        WHERE r.person_id = ? AND r.status = 'present'`
    )
    .get(personId).d;
  db.prepare("UPDATE people SET date_first_attended = ?, updated_at = datetime('now') WHERE id = ?").run(min, personId);
}

/** Determine first-timer vs returning for a person on a given Sunday. */
function autoClassify(db, personId, serviceDate) {
  const row = db
    .prepare(
      `SELECT p.date_first_attended,
              EXISTS (SELECT 1 FROM attendance_records r JOIN services s ON s.id = r.service_id
                       WHERE r.person_id = p.id AND r.status = 'present' AND s.service_date < ?) AS before_
         FROM people p WHERE p.id = ?`
    )
    .get(serviceDate, personId);
  if (!row) return null;
  if (row.before_ || (row.date_first_attended && row.date_first_attended < serviceDate)) return 'returning';
  return 'first_timer';
}

// GET /api/services?from=&to=&limit=   (history list, newest first)
router.get(
  '/',
  requirePermission('attendance:view'),
  wrap((req, res) => {
    const db = getDb();
    res.json(stats.serviceSummaries(db, {
      from: clean(req.query.from), to: clean(req.query.to),
      limit: Number(req.query.limit) || undefined, order: 'DESC',
    }));
  })
);


// ---------------------------------------------------------------------------
// Sunday lock: staff may mark attendance only on the Sunday itself (church time).
// Any other day/date is a *correction*: Admin only, reason required, kept in the audit.
// ---------------------------------------------------------------------------
function lockState(db, user, serviceDate) {
  const s = {};
  for (const r of db.prepare("SELECT key, value FROM settings WHERE key IN ('attendance_sunday_lock', 'qr_timezone')").all()) s[r.key] = r.value;
  const enabled = s.attendance_sunday_lock !== '0';
  const now = guard.churchNow(s.qr_timezone || 'Asia/Manila');
  const live = now.dow === 0 && now.date === serviceDate;
  const admin = can(user, 'attendance:correct');
  return {
    enabled, live: !enabled || live, can_correct: admin, church_date: now.date, church_day: guard.DAY_NAMES[now.dow],
    message: enabled && !live ? (admin ? 'Correction mode — this is not today\'s Sunday, so every change needs a reason and is logged.'
      : `Attendance can only be marked on the Sunday itself (church time: ${guard.DAY_NAMES[now.dow]} ${now.date}). Past Sundays can be corrected by an Admin.`) : '',
  };
}
/** Throws unless the user may change `serviceDate` now; returns the correction reason (null when live). */
function requireEditable(db, req, serviceDate, reasonRaw) {
  const st = lockState(db, req.user, serviceDate);
  if (st.live) return null;
  if (!st.can_correct) throw new HttpError(403, st.message);
  const reason = clean(reasonRaw);
  if (!reason) throw new HttpError(400, 'Please give a reason for this correction (e.g. "forgot to tap on Sunday").', { reason: 'required' });
  return reason.slice(0, 200);
}

// GET /api/services/by-date/:date  → { exists, service? }
router.get(
  '/by-date/:date',
  requirePermission('attendance:view'),
  wrap((req, res) => {
    const db = getDb();
    const date = req.params.date;
    if (!isSunday(date)) throw new HttpError(400, 'Lifegen attendance is Sunday only — please choose a Sunday.');
    const row = db.prepare('SELECT id FROM services WHERE service_date = ? AND service_type = ?').get(date, SERVICE_TYPE);
    const lock = lockState(db, req.user, date);
    if (!row) return res.json({ exists: false, service_date: date, lock });
    res.json({ exists: true, service: stats.serviceSummary(db, row.id), lock });
  })
);

// GET /api/services/:id  → summary + roster
router.get(
  '/:id',
  requirePermission('attendance:view'),
  wrap((req, res) => {
    const db = getDb();
    const service = stats.serviceSummary(db, intId(req.params.id));
    if (!service) throw new HttpError(404, 'Service not found.');
    const roster = rosterFor(db, service.id, req.user).map((p) => {
      const expected =
        p.attended_before || (p.date_first_attended && p.date_first_attended < service.service_date)
          ? 'returning' : 'first_timer';
      return { ...p, expected_classification: p.classification || expected };
    });
    res.json({ ...service, roster });
  })
);

// GET /api/services/:id/audit — change log for the Sunday
router.get(
  '/:id/audit',
  requirePermission('attendance:view'),
  wrap((req, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT a.*, u.display_name AS user_name, p.first_name, p.last_name, p.person_code
           FROM attendance_audit a
           LEFT JOIN users u ON u.id = a.user_id
           LEFT JOIN people p ON p.id = a.person_id
          WHERE a.service_id = ? ORDER BY a.id DESC LIMIT 200`
      )
      .all(intId(req.params.id));
    res.json(rows);
  })
);

// POST /api/services  { service_date, notes? }  — open attendance for a Sunday
router.post(
  '/',
  requirePermission('attendance:write'),
  wrap((req, res) => {
    const db = getDb();
    const date = clean(req.body?.service_date);
    if (!isSunday(date)) throw new HttpError(400, 'Lifegen attendance is Sunday only — please choose a Sunday.');
    const dup = db.prepare('SELECT id FROM services WHERE service_date = ? AND service_type = ?').get(date, SERVICE_TYPE);
    if (dup) return res.json(stats.serviceSummary(db, dup.id));
    const st = lockState(db, req.user, date);
    if (!st.live && !st.can_correct) throw new HttpError(403, st.message);
    const info = db
      .prepare('INSERT INTO services (service_date, service_type, notes, created_by) VALUES (?, ?, ?, ?)')
      .run(date, SERVICE_TYPE, clean(req.body?.notes), req.user.id);
    res.status(201).json(stats.serviceSummary(db, info.lastInsertRowid));
  })
);

// PUT /api/services/:id  { notes }
router.put(
  '/:id',
  requirePermission('attendance:write'),
  wrap((req, res) => {
    const db = getDb();
    const info = db
      .prepare("UPDATE services SET notes = ?, updated_at = datetime('now') WHERE id = ?")
      .run(clean(req.body?.notes), intId(req.params.id));
    if (!info.changes) throw new HttpError(404, 'Service not found.');
    res.json(stats.serviceSummary(db, req.params.id));
  })
);

// DELETE /api/services/:id — admin only, only when no records exist
router.delete(
  '/:id',
  requirePermission('settings:manage'),
  wrap((req, res) => {
    const db = getDb();
    const n = db.prepare('SELECT COUNT(*) AS n FROM attendance_records WHERE service_id = ?').get(intId(req.params.id)).n;
    if (n > 0) throw new HttpError(409, 'This Sunday already has attendance records and cannot be deleted. Historical records are preserved.');
    const info = db.prepare('DELETE FROM services WHERE id = ?').run(req.params.id);
    if (!info.changes) throw new HttpError(404, 'Service not found.');
    res.status(204).end();
  })
);

// PUT /api/services/:id/records/:personId  { status: 'present'|'absent', classification? }
router.put(
  '/:id/records/:personId',
  requirePermission('attendance:write'),
  wrap((req, res) => {
    const db = getDb();
    const service = db.prepare('SELECT id, service_date FROM services WHERE id = ?').get(intId(req.params.id));
    if (!service) throw new HttpError(404, 'Service not found.');
    const person = db.prepare('SELECT id, date_first_attended, status FROM people WHERE id = ?').get(intId(req.params.personId, 'person id'));
    if (!person) throw new HttpError(404, 'Person not found.');

    const status = clean(req.body?.status);
    if (!['present', 'absent'].includes(status)) throw new HttpError(400, 'Status must be present or absent.');
    const reason = requireEditable(db, req, service.service_date, req.body?.reason);
    let classification = clean(req.body?.classification);
    if (classification && !['first_timer', 'returning'].includes(classification)) throw new HttpError(400, 'Invalid classification.');

    const existing = db
      .prepare('SELECT * FROM attendance_records WHERE service_id = ? AND person_id = ?')
      .get(service.id, person.id);

    if (status === 'present') {
      if (!classification) classification = (existing && existing.classification) || autoClassify(db, person.id, service.service_date);
    } else {
      classification = null;
    }

    const recordFor = () => db
      .prepare(
        `SELECT r.*, u.display_name AS recorded_by_name FROM attendance_records r
           LEFT JOIN users u ON u.id = r.recorded_by WHERE r.service_id = ? AND r.person_id = ?`
      )
      .get(service.id, person.id);

    // Idempotent: an identical mark (e.g. a double tap, a retried request, or two
    // devices marking the same person) changes nothing and is not audited.
    if (existing && existing.status === status && (existing.classification || null) === (classification || null)) {
      return res.json({ record: recordFor(), summary: stats.serviceSummary(db, service.id), already_marked: true });
    }

    db.transaction(() => {
      if (existing) {
        db.prepare(
          `UPDATE attendance_records SET status = ?, classification = ?, recorded_by = ?, updated_at = datetime('now')
            WHERE id = ?`
        ).run(status, classification, req.user.id, existing.id);
      } else {
        db.prepare(
          `INSERT INTO attendance_records (service_id, person_id, status, classification, recorded_by)
           VALUES (?, ?, ?, ?, ?)`
        ).run(service.id, person.id, status, classification, req.user.id);
      }
      db.prepare(
        `INSERT INTO attendance_audit (service_id, person_id, action, old_status, new_status,
                                       old_classification, new_classification, user_id, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(service.id, person.id, existing ? 'update' : 'mark', existing?.status || null, status,
            existing?.classification || null, classification, req.user.id, reason);

      // First attendance bookkeeping
      if (status === 'present') {
        if (!person.date_first_attended || person.date_first_attended > service.service_date) {
          db.prepare("UPDATE people SET date_first_attended = ?, updated_at = datetime('now') WHERE id = ?")
            .run(service.service_date, person.id);
        }
      } else if (existing && existing.status === 'present') {
        rollbackFirstAttended(db, person.id, service.service_date);
      }
    })();

    res.json({ record: recordFor(), summary: stats.serviceSummary(db, service.id), already_marked: false });
  })
);

// DELETE /api/services/:id/records/:personId — undo a mark (logged in audit)
router.delete(
  '/:id/records/:personId',
  requirePermission('attendance:write'),
  wrap((req, res) => {
    const db = getDb();
    const existing = db
      .prepare('SELECT * FROM attendance_records WHERE service_id = ? AND person_id = ?')
      .get(intId(req.params.id), intId(req.params.personId, 'person id'));
    if (!existing) throw new HttpError(404, 'No attendance record to undo.');
    const svcDate = db.prepare('SELECT service_date FROM services WHERE id = ?').get(existing.service_id).service_date;
    const reason = requireEditable(db, req, svcDate, req.query.reason ?? req.body?.reason);
    db.transaction(() => {
      db.prepare('DELETE FROM attendance_records WHERE id = ?').run(existing.id);
      db.prepare(
        `INSERT INTO attendance_audit (service_id, person_id, action, old_status, new_status,
                                       old_classification, new_classification, user_id, reason)
         VALUES (?, ?, 'undo', ?, NULL, ?, NULL, ?, ?)`
      ).run(existing.service_id, existing.person_id, existing.status, existing.classification, req.user.id, reason);
      if (existing.status === 'present') {
        const svc = db.prepare('SELECT service_date FROM services WHERE id = ?').get(existing.service_id);
        rollbackFirstAttended(db, existing.person_id, svc.service_date);
      }
    })();
    res.json({ summary: stats.serviceSummary(db, req.params.id) });
  })
);

module.exports = router;
