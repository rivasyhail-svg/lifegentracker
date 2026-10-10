-- Lifegroup weekly report: besides "present", the leader can tap "had devotion" per member.
-- present = 1 keeps the old meaning of a row; devotion rows for absent members use present = 0.
ALTER TABLE lifegroup_meeting_attendance ADD COLUMN present  INTEGER NOT NULL DEFAULT 1;
ALTER TABLE lifegroup_meeting_attendance ADD COLUMN devotion INTEGER NOT NULL DEFAULT 0;
