-- 004: Lifegroups (cell groups) — Person ↔ Lifegroup relationship with history.
--   lifegroups             the groups themselves (leader is a registered person)
--   lifegroup_memberships  one row per person per stay in a group; left_at NULL = current
--   people.preferred_*     what the person told us, used for "Recommended Lifegroups"

CREATE TABLE IF NOT EXISTS lifegroups (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  leader_person_id INTEGER REFERENCES people (id) ON DELETE SET NULL,
  leader_name      TEXT,                        -- fallback when the leader is not registered
  network          TEXT,                        -- optional grouping (e.g. a network / cluster name)
  area             TEXT,                        -- e.g. Kaybanban, Muzon
  schedule_day     TEXT    CHECK (schedule_day IN ('mon','tue','wed','thu','fri','sat','sun') OR schedule_day IS NULL),
  schedule_time    TEXT,                        -- HH:MM (24h)
  category         TEXT,                        -- e.g. Students, Young Pro, Mixed
  capacity         INTEGER,                     -- NULL = no limit
  venue            TEXT,
  notes            TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1,
  is_demo          INTEGER NOT NULL DEFAULT 0,
  created_by       INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lifegroups_area   ON lifegroups (area);
CREATE INDEX IF NOT EXISTS idx_lifegroups_leader ON lifegroups (leader_person_id);

CREATE TABLE IF NOT EXISTS lifegroup_memberships (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id     INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  lifegroup_id  INTEGER NOT NULL REFERENCES lifegroups (id) ON DELETE CASCADE,
  role          TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('member','leader','assistant')),
  joined_at     TEXT    NOT NULL,              -- YYYY-MM-DD
  left_at       TEXT,                          -- NULL = current membership
  notes         TEXT,
  assigned_by   INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lgm_person ON lifegroup_memberships (person_id, left_at);
CREATE INDEX IF NOT EXISTS idx_lgm_group  ON lifegroup_memberships (lifegroup_id, left_at);
-- Only one current membership per person.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lgm_current ON lifegroup_memberships (person_id) WHERE left_at IS NULL;

ALTER TABLE people ADD COLUMN preferred_area TEXT;
ALTER TABLE people ADD COLUMN preferred_day  TEXT;
ALTER TABLE people ADD COLUMN preferred_time TEXT;   -- morning | afternoon | evening
ALTER TABLE people ADD COLUMN preferred_category TEXT;
