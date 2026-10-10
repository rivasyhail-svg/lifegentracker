'use strict';

const fs = require('fs');
const path = require('path');
/**
 * Two ways to store data, same code path (both drivers share the better-sqlite3 API):
 *   - default: local file  data/lifegen.db  via better-sqlite3 (server / laptop / Docker)
 *   - LIFEGEN_DB_URL=libsql://... + LIFEGEN_DB_TOKEN: a hosted Turso/libSQL database via the `libsql`
 *     driver — needed on serverless hosts (Vercel) that have no persistent disk.
 *   - LIFEGEN_DB_URL=postgresql://...: Supabase / any Postgres via the synchronous driver in ./pg-sync.js
 *     (SQLite statements are translated by ./sqlite-to-pg.js — the rest of the app is unchanged).
 *   LIFEGEN_DB_DRIVER=libsql forces the libsql driver for a local file (testing).
 */
const DB_URL = process.env.LIFEGEN_DB_URL || '';
const IS_PG = /^postgres(ql)?:\/\//.test(DB_URL);
const REMOTE = IS_PG || /^(libsql|https?|wss?):\/\//.test(DB_URL);
// eslint-disable-next-line global-require
const Database = IS_PG ? require('./pg-sync') : (REMOTE || process.env.LIFEGEN_DB_DRIVER === 'libsql' ? require('libsql') : require('better-sqlite3'));

const DATA_DIR = process.env.LIFEGEN_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const DB_FILE = REMOTE ? DB_URL.replace(/:\/\/[^@]*@/, '://***@').replace(/\?.*$/, '') : (process.env.LIFEGEN_DB_FILE || path.join(DATA_DIR, 'lifegen.db'));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

let db;

/**
 * Open (or create) the SQLite database and apply any pending migrations.
 * Migrations are plain .sql files in src/db/migrations named NNN_description.sql
 * and are applied in order exactly once. To add a future feature (e.g. cell
 * groups) simply drop a new 002_cell_groups.sql file in that folder.
 */
function initDb() {
  if (db) return db;

  if (IS_PG) {
    db = new Database(DB_URL); // Supabase / Postgres via the synchronous worker driver
  } else if (REMOTE) {
    db = new Database(DB_URL, { authToken: process.env.LIFEGEN_DB_TOKEN || undefined });
  } else {
    if (process.env.VERCEL && !process.env.LIFEGEN_DB_FILE) {
      throw new Error('LIFEGEN_DB_URL is not set — this host has no persistent disk, so a hosted database (Supabase postgresql:// or Turso libsql://) is required.');
    }
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    db = new Database(DB_FILE);
    // Rollback journal (not WAL) so every committed write lands in the single
    // lifegen.db file immediately. This keeps backups/snapshots a one-file copy
    // and survives abrupt shutdowns without needing a checkpoint.
    db.pragma('journal_mode = DELETE');
    db.pragma('synchronous = FULL');
  }
  try { db.pragma('foreign_keys = ON'); } catch (e) { console.warn('[db] foreign_keys pragma not applied:', e.message); }

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const markApplied = db.prepare('INSERT INTO schema_migrations (version) VALUES (?)');

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      markApplied.run(file);
    })();
    console.log(`[db] applied migration ${file}`);
  }
  if (IS_PG) {
    // SQLite's "username COLLATE NOCASE" → case-insensitive unique index on Postgres.
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username_ci ON users (lower(username))');
  }
  enforceIndependentNetworks(db);
  require('../middleware/auth').refreshOptions(db);

  return db;
}

/**
 * Database-level guarantee that Networks are independent roots (no sub-networks):
 * networks.parent_network_id must stay NULL. The column is kept only so old rows and backups
 * still load; nothing in the app reads or writes it any more.
 *   - Postgres: CHECK constraint.
 *   - SQLite / libSQL (no ADD CONSTRAINT): BEFORE INSERT / BEFORE UPDATE triggers that abort.
 * Idempotent — safe to run on every start.
 */
function enforceIndependentNetworks(db) {
  const MSG = 'Networks are independent: a Network cannot be placed under another Network';
  if (IS_PG) {
    const has = db.prepare("SELECT 1 AS ok FROM pg_constraint WHERE conname = 'ck_networks_independent'").get();
    if (!has) db.exec('ALTER TABLE networks ADD CONSTRAINT ck_networks_independent CHECK (parent_network_id IS NULL)');
    return;
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_networks_independent_ins BEFORE INSERT ON networks
    WHEN NEW.parent_network_id IS NOT NULL BEGIN SELECT RAISE(ABORT, '${MSG}'); END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_networks_independent_upd BEFORE UPDATE OF parent_network_id ON networks
    WHEN NEW.parent_network_id IS NOT NULL BEGIN SELECT RAISE(ABORT, '${MSG}'); END;`);
}


function getDb() {
  if (!db) initDb();
  return db;
}

module.exports = { initDb, getDb, DB_FILE, REMOTE, IS_PG };
