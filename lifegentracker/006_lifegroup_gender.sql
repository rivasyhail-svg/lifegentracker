-- Every Lifegroup is either a boys group or a girls group — never mixed.
ALTER TABLE lifegroups ADD COLUMN gender TEXT CHECK (gender IN ('boys','girls'));

-- Best-effort fill for existing groups: if every current member (and the leader) is one sex, use it.
UPDATE lifegroups SET gender = (
  SELECT CASE
    WHEN COUNT(*) > 0 AND SUM(p.sex = 'female') = 0 AND SUM(p.sex IS NULL) = 0 THEN 'boys'
    WHEN COUNT(*) > 0 AND SUM(p.sex = 'male') = 0 AND SUM(p.sex IS NULL) = 0 THEN 'girls'
    ELSE NULL END
  FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id
  WHERE m.lifegroup_id = lifegroups.id AND m.left_at IS NULL
) WHERE gender IS NULL;
