-- ============================================================================
-- LifegenTracker — Lifegiver Church of Faith
-- Migration 001: core schema (Phase 1: people + Lifegen Sunday attendance)
--
-- Design notes
--  * people, services, attendance_records, users and roles are separate tables.
--  * Attendance is NEVER stored as a counter on a person; every Sunday produces
--    one historical row per person in attendance_records (UNIQUE per person +
--    service), and every change is appended to attendance_audit.
--  * Future modules (cell groups, LifeClass, discipleship, ministries) will be
--    added in later migrations as new tables that reference people(id),
--    users(id) and services(id). Nothing here needs to be rebuilt for that.
-- ============================================================================

-- --------------------------------------------------------------------------
-- Users & roles
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  id          TEXT PRIMARY KEY,                -- 'admin' | 'staff' | 'viewer'
  name        TEXT NOT NULL,
  description TEXT
);

INSERT OR IGNORE INTO roles (id, name, description) VALUES
  ('admin',  'Admin',            'Full access to the system, users and settings.'),
  ('staff',  'Attendance Staff', 'Can register people and manage Lifegen attendance.'),
  ('viewer', 'Viewer / Leader',  'Can view dashboards and reports. Private contact details are hidden.');

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name   TEXT    NOT NULL,
  password_hash  TEXT    NOT NULL,
  role_id        TEXT    NOT NULL REFERENCES roles (id),
  is_active      INTEGER NOT NULL DEFAULT 1,
  last_login_at  TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,                -- random token (hashed)
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT    NOT NULL,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

-- --------------------------------------------------------------------------
-- App settings (key/value)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('church_name',  'Lifegiver Church of Faith'),
  ('service_name', 'Lifegen / 3rd Service');

-- --------------------------------------------------------------------------
-- People
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS people (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  person_code          TEXT    UNIQUE,         -- auto: LG-0001 (set right after insert)
  first_name           TEXT    NOT NULL,
  last_name            TEXT    NOT NULL,
  middle_name          TEXT,
  photo                TEXT,                   -- data URL (resized client-side) or null
  birthdate            TEXT,                   -- YYYY-MM-DD
  sex                  TEXT    CHECK (sex IN ('male','female') OR sex IS NULL),
  contact_number       TEXT,
  email                TEXT,
  address              TEXT,
  school               TEXT,
  course_year          TEXT,
  occupation           TEXT,
  status               TEXT    NOT NULL DEFAULT 'first_timer'
                       CHECK (status IN ('first_timer','new_believer','regular','member','leader','volunteer','inactive')),
  date_registered      TEXT    NOT NULL,       -- YYYY-MM-DD
  date_first_attended  TEXT,                   -- YYYY-MM-DD (first Lifegen Sunday)
  notes                TEXT,
  is_demo              INTEGER NOT NULL DEFAULT 0,   -- 1 = clearly-labelled sample data
  created_by           INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_people_name    ON people (last_name, first_name);
CREATE INDEX IF NOT EXISTS idx_people_status  ON people (status);
CREATE INDEX IF NOT EXISTS idx_people_contact ON people (contact_number);

-- --------------------------------------------------------------------------
-- Services (one row per Sunday Lifegen service)
-- service_type exists so other services can be tracked later without
-- restructuring. Phase 1 uses only 'lifegen'.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS services (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  service_date  TEXT    NOT NULL,              -- YYYY-MM-DD, Sunday only (validated in app)
  service_type  TEXT    NOT NULL DEFAULT 'lifegen',
  notes         TEXT,
  is_demo       INTEGER NOT NULL DEFAULT 0,
  created_by    INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (service_date, service_type)
);
CREATE INDEX IF NOT EXISTS idx_services_date ON services (service_date);

-- --------------------------------------------------------------------------
-- Attendance records — one historical row per person per service
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_records (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id      INTEGER NOT NULL REFERENCES services (id) ON DELETE CASCADE,
  person_id       INTEGER NOT NULL REFERENCES people   (id) ON DELETE CASCADE,
  status          TEXT    NOT NULL CHECK (status IN ('present','absent')),
  classification  TEXT    CHECK (classification IN ('first_timer','returning') OR classification IS NULL),
  recorded_by     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  recorded_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (service_id, person_id)               -- prevents duplicate records
);
CREATE INDEX IF NOT EXISTS idx_att_person  ON attendance_records (person_id);
CREATE INDEX IF NOT EXISTS idx_att_service ON attendance_records (service_id);

-- Append-only log of every attendance change (who / when / what).
CREATE TABLE IF NOT EXISTS attendance_audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id      INTEGER NOT NULL,
  person_id       INTEGER NOT NULL,
  action          TEXT    NOT NULL,            -- 'mark' | 'update' | 'undo'
  old_status      TEXT,
  new_status      TEXT,
  old_classification TEXT,
  new_classification TEXT,
  user_id         INTEGER,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_service ON attendance_audit (service_id);
