-- 013: Networks are independent roots. There are no sub-networks: a Network leader is never
--      under another Network leader. Any old parent links are flattened (every Network keeps
--      its own row, leader, Lifegroups and history — only the parent pointer is cleared).
UPDATE networks SET parent_network_id = NULL, updated_at = datetime('now') WHERE parent_network_id IS NOT NULL;
DROP INDEX IF EXISTS idx_networks_parent;
