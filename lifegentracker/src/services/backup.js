'use strict';

/**
 * Backups
 *   * JSON export/import of every table (admin only) — portable, human-readable.
 *   * Automatic SQLite file snapshots (data/backups/lifegen-YYYY-MM-DD.db) made at
 *     start-up and every 24 h using SQLite's online backup API; last 14 are kept.
 */
const fs = require('fs');
const path = require('path');
const { HttpError } = require('../lib/util');

const FORMAT = 'lifegentracker-backup';
const FORMAT_VERSION = 1;
const TABLES = ['users', 'settings', 'people', 'services', 'attendance_records', 'attendance_audit', 'activity_log', 'networks', 'lifegroups', 'lifegroup_memberships', 'registrations'];
const KEEP = 14;

function exportJson(db) {
  const tables = {};
  for (const t of TABLES) tables[t] = db.prepare(`SELECT * FROM ${t}`).all();
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    app: 'LifegenTracker',
    exported_at: new Date().toISOString(),
    counts: Object.fromEntries(TABLES.map((t) => [t, tables[t].length])),
    tables,
  };
}

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

/** Validate the shape of an uploaded backup before touching the database. */
function validate(data) {
  if (!data || typeof data !== 'object') throw new HttpError(400, 'Backup file is not valid JSON.');
  if (data.format !== FORMAT) throw new HttpError(400, 'This file is not a LifegenTracker backup.');
  if (Number(data.version) > FORMAT_VERSION) throw new HttpError(400, 'Backup was made by a newer version of LifegenTracker.');
  if (!data.tables || typeof data.tables !== 'object') throw new HttpError(400, 'Backup has no tables.');
  for (const t of ['people', 'services', 'attendance_records']) {
    if (!Array.isArray(data.tables[t])) throw new HttpError(400, `Backup is missing the "${t}" table.`);
  }
  const peopleIds = new Set(data.tables.people.map((p) => p.id));
  const serviceIds = new Set(data.tables.services.map((s) => s.id));
  for (const p of data.tables.people) {
    if (!p.first_name || !p.last_name || !p.date_registered) throw new HttpError(400, 'A person row in the backup is missing required fields.');
  }
  for (const r of data.tables.attendance_records) {
    if (!peopleIds.has(r.person_id) || !serviceIds.has(r.service_id)) {
      throw new HttpError(400, 'Backup contains attendance records that point to missing people or Sundays.');
    }
  }
  const seen = new Set();
  for (const r of data.tables.attendance_records) {
    const k = `${r.service_id}:${r.person_id}`;
    if (seen.has(k)) throw new HttpError(400, 'Backup contains duplicate attendance records.');
    seen.add(k);
  }
}

/**
 * Replace all data with the backup. Runs in one transaction — if anything fails,
 * the database is left exactly as it was. A file snapshot is taken first.
 */
async function restoreJson(db, data, dbFile) {
  validate(data);
  await snapshot(db, dbFile, 'pre-restore'); // best effort — resolves null where file snapshots are unavailable
  const tx = db.transaction(() => {
    for (const t of [...TABLES].reverse()) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare('DELETE FROM sessions').run();
    for (const t of TABLES) {
      const rows = Array.isArray(data.tables[t]) ? data.tables[t] : [];
      if (!rows.length) continue;
      const cols = columnsOf(db, t);
      const use = cols.filter((c) => Object.prototype.hasOwnProperty.call(rows[0], c));
      if (!use.length) continue;
      const stmt = db.prepare(`INSERT INTO ${t} (${use.join(', ')}) VALUES (${use.map((c) => '@' + c).join(', ')})`);
      for (const row of rows) {
        const obj = {};
        for (const c of use) obj[c] = row[c] === undefined ? null : row[c];
        stmt.run(obj);
      }
    }
    // Older backups (before QR registration) have no normalised columns — rebuild them so
    // duplicate detection keeps working. Later duplicates lose the unique key, never their email text.
    db.prepare("UPDATE people SET email_normalized = lower(trim(email)) WHERE email_normalized IS NULL AND email IS NOT NULL AND trim(email) <> ''").run();
    db.prepare("UPDATE people SET email_normalized = NULL WHERE email_normalized IS NOT NULL AND id NOT IN (SELECT MIN(id) FROM people WHERE email_normalized IS NOT NULL GROUP BY email_normalized)").run();
    db.prepare("UPDATE people SET full_name_normalized = lower(trim(first_name || ' ' || last_name)) WHERE full_name_normalized IS NULL").run();
    // Make sure at least one admin remains usable.
    const admins = db.prepare("SELECT COUNT(*) n FROM users WHERE role_id = 'admin' AND is_active = 1").get().n;
    if (!admins) throw new HttpError(400, 'Backup has no active admin user; restore cancelled.');
    const fk = db.pragma('foreign_key_check');
    if (fk.length) throw new HttpError(400, 'Backup has inconsistent references; restore cancelled.');
    if (typeof db.resyncSequences === 'function') db.resyncSequences(); // Postgres: identity counters past restored ids
  });
  // The foreign_keys pragma cannot change inside a transaction, so toggle it outside.
  db.pragma('foreign_keys = OFF');
  try { tx(); } finally { db.pragma('foreign_keys = ON'); }
  return exportJson(db).counts;
}

// ---------------------------------------------------------------------------
// File snapshots
// ---------------------------------------------------------------------------
const HOSTED_URL = /^(libsql|https?|wss?|postgres(ql)?):\/\//; // Turso / Supabase: no local file, no .db snapshots

function backupDir(dbFile) {
  if (HOSTED_URL.test(dbFile)) return '';
  return path.join(path.dirname(dbFile), 'backups');
}

/** File snapshots need a local .db file and the online-backup API (better-sqlite3). Hosted DBs (Turso) keep their own point-in-time history. */
function snapshotsSupported(db, dbFile) {
  return Boolean(dbFile) && !HOSTED_URL.test(dbFile) && typeof db.backup === 'function' && !(db.constructor && db.constructor.name === 'Database' && db.backup.toString().includes('not implemented'));
}

function snapshot(db, dbFile, label = 'auto') {
  if (!snapshotsSupported(db, dbFile)) return Promise.resolve(null);
  const dir = backupDir(dbFile);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = path.join(dir, `lifegen-${label}-${stamp}.db`);
  // better-sqlite3 backup() is async and uses SQLite's online backup API.
  return db.backup(file).then(() => { prune(dir); return file; }).catch((e) => {
    console.error('[backup] snapshot failed:', e.message);
    return null;
  });
}

function prune(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('lifegen-auto-') && f.endsWith('.db')).sort();
  while (files.length > KEEP) fs.unlinkSync(path.join(dir, files.shift()));
}

function listSnapshots(dbFile) {
  if (HOSTED_URL.test(dbFile)) return [];
  const dir = backupDir(dbFile);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort().reverse().map((f) => {
    const st = fs.statSync(path.join(dir, f));
    return { file: f, size: st.size, created_at: st.mtime.toISOString() };
  });
}

let timer = null;
function scheduleAuto(db, dbFile) {
  if (process.env.LIFEGEN_AUTO_BACKUP === 'off' || !snapshotsSupported(db, dbFile)) return;
  const last = listSnapshots(dbFile).find((s) => s.file.startsWith('lifegen-auto-'));
  const stale = !last || Date.now() - new Date(last.created_at).getTime() > 20 * 3600 * 1000;
  if (stale) snapshot(db, dbFile, 'auto').then((f) => f && console.log(`[backup] snapshot ${path.basename(f)}`));
  timer = setInterval(() => snapshot(db, dbFile, 'auto'), 24 * 3600 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = { exportJson, restoreJson, validate, snapshot, listSnapshots, scheduleAuto, backupDir, snapshotsSupported };
