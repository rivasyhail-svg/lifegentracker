-- QR self-registration: public form → registrations inbox → admin approves → row in the SAME people table.
-- People get the shared normalised columns so "one Gmail = one registration" holds across manual + QR.
ALTER TABLE people ADD COLUMN email_normalized      TEXT;      -- lower(trim(email))
ALTER TABLE people ADD COLUMN full_name_normalized  TEXT;      -- lower, single spaces, no punctuation
ALTER TABLE people ADD COLUMN age                   INTEGER;   -- asked on the QR form (birthday unknown)
ALTER TABLE people ADD COLUMN ministry              TEXT;
ALTER TABLE people ADD COLUMN registration_source   TEXT NOT NULL DEFAULT 'manual' CHECK (registration_source IN ('manual','qr'));
ALTER TABLE people ADD COLUMN registered_at         TEXT;      -- when the QR form was submitted (manual: created_at)
ALTER TABLE people ADD COLUMN registration_id       INTEGER;   -- → registrations.id

UPDATE people SET email_normalized = lower(trim(email)) WHERE email IS NOT NULL AND trim(email) <> '';
UPDATE people SET full_name_normalized = lower(trim(first_name || ' ' || last_name));
-- Existing duplicates (made before the rule) keep their email text; only the first keeps the unique key.
UPDATE people SET email_normalized = NULL
 WHERE email_normalized IS NOT NULL
   AND id NOT IN (SELECT MIN(id) FROM people WHERE email_normalized IS NOT NULL GROUP BY email_normalized);
CREATE UNIQUE INDEX IF NOT EXISTS uq_people_email_normalized ON people (email_normalized) WHERE email_normalized IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_people_full_name_normalized ON people (full_name_normalized);

CREATE TABLE IF NOT EXISTS registrations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_code              TEXT    UNIQUE,                         -- LG-2026-000001 (Registration Reference shown to the registrant; 6 digits ≠ 4-digit Person ID)
  full_name             TEXT    NOT NULL,
  full_name_normalized  TEXT    NOT NULL,
  email                 TEXT    NOT NULL,
  email_normalized      TEXT    NOT NULL UNIQUE,                -- one Gmail = one registration (DB-enforced)
  age                   INTEGER NOT NULL,
  school                TEXT    NOT NULL,
  leader_name           TEXT    NOT NULL,
  network_leader_name   TEXT    NOT NULL,
  ministry              TEXT    NOT NULL,
  source                TEXT    NOT NULL DEFAULT 'qr',
  status                TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  possible_duplicate    INTEGER NOT NULL DEFAULT 0,             -- same name as an existing person/registration
  duplicate_note        TEXT,
  person_id             INTEGER REFERENCES people (id) ON DELETE SET NULL,
  submitted_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  approved_at           TEXT,
  rejected_at           TEXT,
  reviewed_by           INTEGER REFERENCES users (id) ON DELETE SET NULL,
  review_note           TEXT,
  ip_hash               TEXT,
  user_agent            TEXT,
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_registrations_status ON registrations (status, submitted_at);
CREATE INDEX IF NOT EXISTS idx_registrations_name   ON registrations (full_name_normalized);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('qr_registration_enabled', '1'),
  ('qr_require_approval',     '1'),
  ('qr_show_leaders',         '1'),
  ('qr_name_duplicate_check', '1'),
  ('qr_public_url',           ''),
  ('qr_ministries',           'Worship Team, Ushering, Media / Tech, Kids Ministry, Dance / Creative, Prayer, Production, Not yet in a ministry');
