-- 005: Networks — a Lifegroup belongs to a Network; a Network has its own leader
--      (so every Lifegroup leader reports to a Network leader). Networks can nest
--      (parent_network_id) for bigger structures.

CREATE TABLE IF NOT EXISTS networks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  leader_person_id  INTEGER REFERENCES people (id) ON DELETE SET NULL,
  leader_name       TEXT,                       -- fallback when the leader is not registered
  parent_network_id INTEGER REFERENCES networks (id) ON DELETE SET NULL,
  notes             TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1,
  is_demo           INTEGER NOT NULL DEFAULT 0,
  created_by        INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_networks_leader ON networks (leader_person_id);
CREATE INDEX IF NOT EXISTS idx_networks_parent ON networks (parent_network_id);

ALTER TABLE lifegroups ADD COLUMN network_id INTEGER REFERENCES networks (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_lifegroups_network ON lifegroups (network_id);

-- Promote any free-text network names already typed on groups into real Network rows.
INSERT INTO networks (name, is_demo)
  SELECT DISTINCT network, MAX(is_demo) FROM lifegroups WHERE network IS NOT NULL AND network <> '' GROUP BY network;
UPDATE lifegroups SET network_id = (SELECT n.id FROM networks n WHERE n.name = lifegroups.network)
  WHERE network IS NOT NULL AND network <> '';
