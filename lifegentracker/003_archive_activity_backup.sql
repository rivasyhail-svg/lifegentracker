-- 003: production hardening
--   * people.archived_at / archived_by — archive instead of delete (history is kept)
--   * activity_log — who did what, when (people, settings, users, backups, demo data)
--   * extra indexes for the queries that run on every screen

ALTER TABLE people ADD COLUMN archived_at TEXT;
ALTER TABLE people ADD COLUMN archived_by INTEGER REFERENCES users (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_people_archived ON people (archived_at);
CREATE INDEX IF NOT EXISTS idx_people_email    ON people (email);
CREATE INDEX IF NOT EXISTS idx_att_service_status ON attendance_records (service_id, status);

CREATE TABLE IF NOT EXISTS activity_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  action      TEXT    NOT NULL,            -- e.g. person.create, person.archive, settings.update, backup.restore
  entity_type TEXT,                        -- person | user | settings | service | system
  entity_id   INTEGER,
  summary     TEXT,                        -- short human-readable line
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log (created_at);
