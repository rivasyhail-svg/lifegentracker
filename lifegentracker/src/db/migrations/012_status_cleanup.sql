-- Status list trimmed to: First Timer, Regular Attendee, Member, Leader, Inactive.
-- Existing records are folded in (no data lost): New Believer → Regular Attendee, Volunteer → Member.
UPDATE people SET status = 'regular' WHERE status = 'new_believer';
UPDATE people SET status = 'member'  WHERE status = 'volunteer';
