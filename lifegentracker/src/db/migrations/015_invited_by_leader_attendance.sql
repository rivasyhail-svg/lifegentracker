-- 015: QR form "Invited by" + Network leader marks each cell leader Present / Absent from the leader link.
ALTER TABLE registrations ADD COLUMN invited_by TEXT;                                  -- optional, free text
-- An explicit "absent" mark (present = 0, absent = 1). present = 0 / absent = 0 keeps the old meaning: devotion only / not marked.
ALTER TABLE lifegroup_meeting_attendance ADD COLUMN absent    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lifegroup_meeting_attendance ADD COLUMN marked_by TEXT;                    -- who tapped Present / Absent (leader name or user)
ALTER TABLE lifegroup_meeting_attendance ADD COLUMN marked_at TEXT;                    -- when (UTC)
