-- QR anti-fake hardening (additive): device lock, blocklist, risk flags, Sunday window, rotating QR.
ALTER TABLE registrations ADD COLUMN device_id   TEXT;   -- signed httpOnly cookie id of the phone that registered (no personal data)
ALTER TABLE registrations ADD COLUMN risk_flags  TEXT;   -- comma list: fast, same_device, ip_burst, email_typo, name_odd (admin hints only)
ALTER TABLE registrations ADD COLUMN form_seconds INTEGER; -- how long the form was open before submit
CREATE INDEX IF NOT EXISTS idx_registrations_device ON registrations (device_id);
CREATE INDEX IF NOT EXISTS idx_registrations_ip ON registrations (ip_hash, submitted_at);

-- Admin blocklist: emails, email domains, devices (cookie ids) and IP hashes that may not register again.
CREATE TABLE IF NOT EXISTS registration_blocks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('email','domain','device','ip')),
  value       TEXT NOT NULL,
  reason      TEXT,
  created_by  INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, value)
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('qr_mode',            'reusable'),      -- reusable | rotating (new QR every week; old prints stop working)
  ('qr_window',          'sunday'),        -- always | sunday (open only on Sundays between start–end, church time)
  ('qr_window_start',    '12:00'),
  ('qr_window_end',      '17:00'),
  ('qr_timezone',        'Asia/Manila'),
  ('qr_device_lock',     '1'),             -- one registration per phone/browser
  ('qr_hourly_cap',      '60'),            -- more than this many submissions in 60 min → auto-pause
  ('qr_ip_daily_cap',    '50'),            -- per network/IP per 24 h (church Wi-Fi is shared, keep generous)
  ('qr_auto_paused_at',  ''),              -- set by the server when the cap trips; admin clears it with Resume
  ('qr_open_until',      ''),              -- admin "Open now" override (ISO time) — ignores the Sunday window until then
  ('qr_rotation_epoch',  '0');             -- bumped by "New QR code" so the current week's token changes
