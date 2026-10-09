-- A Network is either a boys network or a girls network — never combined (church rule).
ALTER TABLE networks ADD COLUMN gender TEXT CHECK (gender IN ('boys','girls'));

-- Best-effort fill: a network whose active groups are all one type takes that type.
UPDATE networks SET gender = (
  SELECT CASE
    WHEN COUNT(*) > 0 AND SUM(g.gender = 'girls') = 0 AND SUM(g.gender IS NULL) = 0 THEN 'boys'
    WHEN COUNT(*) > 0 AND SUM(g.gender = 'boys') = 0 AND SUM(g.gender IS NULL) = 0 THEN 'girls'
    ELSE NULL END
  FROM lifegroups g WHERE g.network_id = networks.id AND g.is_active = 1
) WHERE gender IS NULL;
-- ...or, if it has no groups of its own, the type of its child networks.
UPDATE networks SET gender = (
  SELECT CASE
    WHEN COUNT(*) > 0 AND SUM(c.gender = 'girls') = 0 AND SUM(c.gender IS NULL) = 0 THEN 'boys'
    WHEN COUNT(*) > 0 AND SUM(c.gender = 'boys') = 0 AND SUM(c.gender IS NULL) = 0 THEN 'girls'
    ELSE NULL END
  FROM networks c WHERE c.parent_network_id = networks.id
) WHERE gender IS NULL;

-- Data privacy: when the person agreed that Lifegen keeps their details (Data Privacy Act of 2012).
ALTER TABLE people ADD COLUMN privacy_consent_at TEXT;

-- Real business details shown on the Privacy page / print header.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('church_address', ''),
  ('church_contact', ''),
  ('privacy_contact', '');
