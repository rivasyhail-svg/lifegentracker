'use strict';

/**
 * Users, settings, global search and demo-data management.
 */
const express = require('express');
const { getDb } = require('../db');
const { clean, HttpError, wrap, CONTACT_DIGITS_SQL, intId } = require('../lib/util');
const activity = require('../services/activity');
const backup = require('../services/backup');
const { DB_FILE } = require('../db');
const auth = require('../middleware/auth');
const { sanitize } = require('./people');
const demo = require('../services/demo');

const router = express.Router();

// ---------------------------------------------------------------------------
// Global search  GET /api/search?q=
// ---------------------------------------------------------------------------
router.get(
  '/search',
  auth.requirePermission('people:view'),
  wrap((req, res) => {
    const db = getDb();
    const q = clean(req.query.q);
    if (!q || q.length < 2) return res.json({ people: [] });
    const digits = q.replace(/\D/g, '');
    const priv = auth.can(req.user, 'people:view_private');
    const sex = ['male', 'female'].includes(req.query.sex) ? req.query.sex : null; // e.g. only boys for a boys group
    const rows = db
      .prepare(
        `SELECT p.id, p.person_code, p.first_name, p.last_name, p.photo, p.sex, p.status, p.contact_number
           FROM people p
          WHERE p.archived_at IS NULL ${sex ? 'AND p.sex = @sex' : ''} AND (
                p.first_name || ' ' || p.last_name LIKE @q
             OR p.last_name || ', ' || p.first_name LIKE @q
             OR p.person_code LIKE @q
             ${digits.length >= 3 && priv ? `OR ${CONTACT_DIGITS_SQL} LIKE @d` : ''})
          ORDER BY p.status = 'inactive', p.last_name COLLATE NOCASE LIMIT 12`
      )
      .all({ q: `%${q}%`, d: `%${digits}%`, sex });
    res.json({ people: rows.map((p) => sanitize(p, req.user)) });
  })
);

// ---------------------------------------------------------------------------
// Users (admin)
// ---------------------------------------------------------------------------
const USER_SELECT = `SELECT u.id, u.username, u.display_name, u.role_id, r.name AS role_name, u.is_active,
                            u.email, u.last_login_at, u.created_at FROM users u JOIN roles r ON r.id = u.role_id`;

router.get('/roles', auth.requireAuth, wrap((req, res) => res.json(getDb().prepare('SELECT * FROM roles').all())));

router.get(
  '/users',
  auth.requirePermission('users:manage'),
  wrap((req, res) => res.json(getDb().prepare(`${USER_SELECT} ORDER BY u.created_at`).all()))
);

router.post(
  '/users',
  auth.requirePermission('users:manage'),
  wrap((req, res) => {
    const db = getDb();
    const username = clean(req.body?.username);
    const display_name = clean(req.body?.display_name);
    const role_id = clean(req.body?.role_id);
    const email = clean(req.body?.email);
    if (!username || !/^[a-zA-Z0-9._-]{3,32}$/.test(username)) throw new HttpError(400, 'Username must be 3–32 characters (letters, numbers, . _ -).');
    if (!display_name) throw new HttpError(400, 'Display name is required.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Email address looks invalid.');
    if (!db.prepare('SELECT 1 FROM roles WHERE id = ?').get(role_id)) throw new HttpError(400, 'Invalid role.');
    auth.validatePassword(req.body?.password);
    if (db.prepare('SELECT 1 FROM users WHERE lower(username) = lower(?)').get(username)) throw new HttpError(409, 'That username is already taken.');
    const info = db
      .prepare('INSERT INTO users (username, display_name, email, password_hash, role_id) VALUES (?, ?, ?, ?, ?)')
      .run(username, display_name, email, auth.hashPassword(req.body.password), role_id);
    activity.log(db, req.user, 'user.create', 'user', info.lastInsertRowid, `Created user ${username} (${role_id})`);
    res.status(201).json(db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(info.lastInsertRowid));
  })
);

router.put(
  '/users/:id',
  auth.requirePermission('users:manage'),
  wrap((req, res) => {
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(intId(req.params.id));
    if (!user) throw new HttpError(404, 'User not found.');
    const display_name = clean(req.body?.display_name) || user.display_name;
    const role_id = clean(req.body?.role_id) || user.role_id;
    const email = req.body?.email === undefined ? user.email : clean(req.body.email);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Email address looks invalid.');
    const is_active = req.body?.is_active === undefined ? user.is_active : (req.body.is_active ? 1 : 0);
    if (!db.prepare('SELECT 1 FROM roles WHERE id = ?').get(role_id)) throw new HttpError(400, 'Invalid role.');

    // Protect against locking everyone out.
    if (user.id === req.user.id && (role_id !== 'admin' || !is_active)) {
      throw new HttpError(400, 'You cannot remove your own admin access.');
    }
    const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role_id = 'admin' AND is_active = 1").get().n;
    if (user.role_id === 'admin' && user.is_active && (role_id !== 'admin' || !is_active) && admins <= 1) {
      throw new HttpError(400, 'At least one active admin is required.');
    }

    db.prepare("UPDATE users SET display_name = ?, email = ?, role_id = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?")
      .run(display_name, email, role_id, is_active, user.id);
    if (!is_active) auth.destroyAllSessions(user.id);
    if (req.body?.password) {
      auth.validatePassword(req.body.password);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(req.body.password), user.id);
      if (user.id !== req.user.id) auth.destroyAllSessions(user.id);
    }
    const bits = [];
    if (role_id !== user.role_id) bits.push(`role ${user.role_id} → ${role_id}`);
    if (is_active !== user.is_active) bits.push(is_active ? 'activated' : 'deactivated');
    if (req.body?.password) bits.push('password reset');
    if (display_name !== user.display_name) bits.push('renamed');
    activity.log(db, req.user, 'user.update', 'user', user.id, `Updated user ${user.username}${bits.length ? ': ' + bits.join(', ') : ''}`);
    res.json(db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(user.id));
  })
);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const QR_KEYS = ['qr_registration_enabled', 'qr_require_approval', 'qr_show_leaders', 'qr_name_duplicate_check', 'qr_public_url', 'qr_ministries',
  'qr_mode', 'qr_window', 'qr_window_start', 'qr_window_end', 'qr_timezone', 'qr_device_lock', 'qr_hourly_cap', 'qr_ip_daily_cap'];
const QR_ENUM = { qr_mode: ['reusable', 'rotating'], qr_window: ['always', 'sunday'] };
const QR_TEXT = new Set(['qr_public_url', 'qr_ministries', 'qr_window_start', 'qr_window_end', 'qr_timezone', 'qr_hourly_cap', 'qr_ip_daily_cap', ...Object.keys(QR_ENUM)]);
const RULE_KEYS = ['attendance_sunday_lock', 'lifegroup_solid_target'];
const SETTING_KEYS = ['church_name', 'service_name', 'church_address', 'church_contact', 'privacy_contact', ...QR_KEYS, ...RULE_KEYS];
const OPTIONAL_SETTINGS = new Set(['church_address', 'church_contact', 'privacy_contact', ...QR_KEYS]);

router.put(
  '/settings',
  auth.requirePermission('settings:manage'),
  wrap((req, res) => {
    const db = getDb();
    const upd = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')");
    db.transaction(() => {
      for (const k of SETTING_KEYS) {
        if (req.body?.[k] !== undefined) {
          const v = clean(req.body[k]) || '';
          if (!v && !OPTIONAL_SETTINGS.has(k)) throw new HttpError(400, `${k.replace('_', ' ')} cannot be empty.`);
          if (v.length > (k === 'qr_ministries' ? 1000 : 300)) throw new HttpError(400, `${k.replace('_', ' ')} is too long.`);
          if (k === 'qr_public_url' && v && !/^https?:\/\/[^\s]+$/i.test(v)) throw new HttpError(400, 'Public URL must start with http:// or https://');
          if (QR_ENUM[k] && !QR_ENUM[k].includes(v)) throw new HttpError(400, `${k} must be one of: ${QR_ENUM[k].join(', ')}.`);
          if ((k === 'qr_window_start' || k === 'qr_window_end') && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(v)) throw new HttpError(400, 'Window times must look like 12:00 (24-hour clock).');
          if ((k === 'qr_hourly_cap' || k === 'qr_ip_daily_cap') && !/^\d{1,4}$/.test(v)) throw new HttpError(400, 'Caps must be a whole number (0 = off).');
          if (k === 'qr_timezone') { try { new Intl.DateTimeFormat('en-US', { timeZone: v }); } catch { throw new HttpError(400, 'Unknown time zone. Example: Asia/Manila'); } }
          if (k.startsWith('qr_') && !QR_TEXT.has(k) && !['0', '1'].includes(v)) throw new HttpError(400, `${k} must be on (1) or off (0).`);
          if (k === 'attendance_sunday_lock' && !['0', '1'].includes(v)) throw new HttpError(400, 'attendance_sunday_lock must be on (1) or off (0).');
          if (k === 'lifegroup_solid_target' && !/^([1-9]|[1-4]\d|50)$/.test(v)) throw new HttpError(400, 'Solid target must be a whole number from 1 to 50.');
          upd.run(k, v);
        }
      }
    })();
    const out = {};
    for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
    activity.log(db, req.user, 'settings.update', 'settings', null, `Updated settings: ${SETTING_KEYS.filter((k) => req.body?.[k] !== undefined).join(', ')}`);
    res.json(out);
  })
);

// ---------------------------------------------------------------------------
// Demo data (clearly labelled; admin only)
// ---------------------------------------------------------------------------
router.get(
  '/demo',
  auth.requirePermission('settings:manage'),
  wrap((req, res) => res.json(demo.status(getDb())))
);
router.post(
  '/demo/load',
  auth.requirePermission('settings:manage'),
  wrap((req, res) => { const out = demo.load(getDb(), req.user.id); activity.log(getDb(), req.user, 'demo.load', 'system', null, 'Loaded demo data'); res.json(out); })
);
router.post(
  '/demo/remove',
  auth.requirePermission('settings:manage'),
  wrap((req, res) => { const out = demo.remove(getDb()); activity.log(getDb(), req.user, 'demo.remove', 'system', null, 'Removed demo data'); res.json(out); })
);

// ---------------------------------------------------------------------------
// Activity log (admin)  GET /api/activity?limit=
// ---------------------------------------------------------------------------
router.get(
  '/activity',
  auth.requirePermission('settings:manage'),
  wrap((req, res) => res.json(activity.recent(getDb(), { limit: req.query.limit })))
);

// ---------------------------------------------------------------------------
// Backup & restore (admin)
// ---------------------------------------------------------------------------
router.get(
  '/backup',
  auth.requirePermission('settings:manage'),
  wrap((req, res) => {
    const db = getDb();
    const data = backup.exportJson(db);
    activity.log(db, req.user, 'backup.export', 'system', null, `Downloaded backup (${data.counts.people} people, ${data.counts.attendance_records} attendance records)`);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="lifegentracker-backup-${stamp}.json"`);
    res.json(data);
  })
);

router.get(
  '/backup/snapshots',
  auth.requirePermission('settings:manage'),
  wrap((req, res) => res.json({ dir: backup.backupDir(DB_FILE), snapshots: backup.listSnapshots(DB_FILE), supported: backup.snapshotsSupported(getDb(), DB_FILE) }))
);

router.post(
  '/backup/snapshot',
  auth.requirePermission('settings:manage'),
  wrap(async (req, res) => {
    if (!backup.snapshotsSupported(getDb(), DB_FILE)) throw new HttpError(400, 'File snapshots are not available on this host (hosted database). Use “Download backup” — the JSON file restores anywhere.');
    const file = await backup.snapshot(getDb(), DB_FILE, 'manual');
    if (!file) throw new HttpError(500, 'Snapshot failed.');
    activity.log(getDb(), req.user, 'backup.snapshot', 'system', null, 'Created database snapshot');
    res.json({ ok: true, file: require('path').basename(file) });
  })
);

// Body: the JSON produced by GET /api/backup. Requires { confirm: 'RESTORE' } alongside.
router.post(
  '/restore',
  auth.requirePermission('settings:manage'),
  express.json({ limit: '50mb' }),
  wrap(async (req, res) => {
    const db = getDb();
    const body = req.body || {};
    if (body.confirm !== 'RESTORE') throw new HttpError(400, 'Type RESTORE to confirm replacing all data.');
    const counts = await backup.restoreJson(db, body.backup, DB_FILE);
    activity.log(db, req.user, 'backup.restore', 'system', null, `Restored backup from ${body.backup?.exported_at || 'unknown date'} (${counts.people} people, ${counts.attendance_records} attendance records)`);
    res.json({ ok: true, counts });
  })
);

// System info
router.get(
  '/system',
  auth.requirePermission('settings:manage'),
  wrap((req, res) => {
    const db = getDb();
    const counts = {
      people: db.prepare('SELECT COUNT(*) n FROM people').get().n,
      services: db.prepare('SELECT COUNT(*) n FROM services').get().n,
      attendance_records: db.prepare('SELECT COUNT(*) n FROM attendance_records').get().n,
      users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
      archived: db.prepare('SELECT COUNT(*) n FROM people WHERE archived_at IS NOT NULL').get().n,
      lifegroups: db.prepare('SELECT COUNT(*) n FROM lifegroups').get().n,
    };
    const snapshots = backup.listSnapshots(DB_FILE);
    const migrations = db.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version').all();
    res.json({ counts, migrations, db_file: DB_FILE, node: process.version, auth_disabled: auth.AUTH_DISABLED, last_snapshot: snapshots[0] || null, snapshot_count: snapshots.length, snapshots_supported: backup.snapshotsSupported(getDb(), DB_FILE), hosted_db: require('../db').REMOTE });
  })
);

module.exports = router;
