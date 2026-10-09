-- 002: Person IDs become LG-YYYY-NNNN (year of registration + per-year sequence)
--      and users get an optional email address.
--
-- Renumber existing people so every record follows the new format.
UPDATE people
   SET person_code = 'LG-' || substr(date_registered, 1, 4) || '-' || printf('%04d', x.rn)
  FROM (SELECT id, row_number() OVER (PARTITION BY substr(date_registered, 1, 4) ORDER BY id) AS rn FROM people) AS x
 WHERE people.id = x.id;

ALTER TABLE users ADD COLUMN email TEXT;
