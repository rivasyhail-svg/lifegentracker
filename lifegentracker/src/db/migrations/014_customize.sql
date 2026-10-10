-- 014: Admin-customisable features & rules (Settings → Customize). Defaults keep today's behaviour.
ALTER TABLE registrations ADD COLUMN contact_number TEXT;   -- asked on the QR form only when qr_ask_contact = 1
ALTER TABLE registrations ADD COLUMN sex TEXT;              -- 'male' | 'female', asked only when qr_ask_sex = 1
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('module_lifegroups', '1'),            -- Lifegroups & Networks section
  ('module_registrations', '1'),         -- QR registration section + public /register
  ('module_reports', '1'),               -- Reports section
  ('perm_staff_registrations', '0'),     -- Attendance Staff may review/approve QR registrations
  ('perm_staff_attendance_correct', '0'),-- Attendance Staff may correct past Sundays (reason still required)
  ('perm_staff_lifegroups', '1'),        -- Attendance Staff may manage Lifegroups / Networks
  ('perm_viewer_private', '0'),          -- Viewer sees contact details, birthdays, notes
  ('network_leader_max', '6'),           -- cell leaders under one network leader
  ('qr_window_days', '0'),               -- days the form is open (0 = Sunday … 6 = Saturday), comma separated
  ('qr_ask_age', '1'), ('qr_ask_school', '1'), ('qr_ask_ministry', '1'), ('qr_ask_leader', '1'),
  ('qr_ask_contact', '0'), ('qr_ask_sex', '0');
