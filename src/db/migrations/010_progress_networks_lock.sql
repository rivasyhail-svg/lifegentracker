-- 1) Attendance: Sunday-only marking; admin corrections carry a reason.
ALTER TABLE attendance_audit ADD COLUMN reason TEXT;
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('attendance_sunday_lock', '1'),      -- staff may mark only on the Sunday itself (church time); admins correct with a reason
  ('lifegroup_solid_target', '6');      -- a Lifegroup is "solid" when it has this many solid members

-- 2) Networks form automatically from membership (leader of group B is a member of group A → B is in A's network).
ALTER TABLE networks   ADD COLUMN is_auto        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lifegroups ADD COLUMN network_manual INTEGER NOT NULL DEFAULT 0;  -- 1 = admin pinned the network by hand
UPDATE lifegroups SET network_manual = 1 WHERE network_id IS NOT NULL;

-- 3) Lifegroup progress: solid/new members, weekly meeting reports, private leader link.
ALTER TABLE lifegroup_memberships ADD COLUMN tier TEXT NOT NULL DEFAULT 'new' CHECK (tier IN ('solid','new'));
ALTER TABLE lifegroups ADD COLUMN report_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_lifegroups_report_token ON lifegroups (report_token) WHERE report_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS lifegroup_meetings (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  lifegroup_id      INTEGER NOT NULL REFERENCES lifegroups (id) ON DELETE CASCADE,
  meeting_date      TEXT    NOT NULL,                    -- YYYY-MM-DD
  held              INTEGER NOT NULL DEFAULT 1,          -- 0 = reported "no lifegroup this week"
  no_meeting_reason TEXT,
  topic             TEXT,
  notes             TEXT,
  present_count     INTEGER NOT NULL DEFAULT 0,
  submitted_via     TEXT    NOT NULL DEFAULT 'admin' CHECK (submitted_via IN ('admin','leader_link')),
  submitted_by_user INTEGER REFERENCES users (id) ON DELETE SET NULL,
  submitted_by_name TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (lifegroup_id, meeting_date)
);
CREATE INDEX IF NOT EXISTS idx_lgmeet_group_date ON lifegroup_meetings (lifegroup_id, meeting_date);

CREATE TABLE IF NOT EXISTS lifegroup_meeting_attendance (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id  INTEGER NOT NULL REFERENCES lifegroup_meetings (id) ON DELETE CASCADE,
  person_id   INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  UNIQUE (meeting_id, person_id)
);
CREATE INDEX IF NOT EXISTS idx_lgma_person ON lifegroup_meeting_attendance (person_id);

ALTER TABLE people ADD COLUMN added_via TEXT;   -- 'lifegroup_link' when a leader added them from the report form
