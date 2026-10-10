'use strict';

/**
 * Clearly-labelled DEMO data so leaders can explore the system before real
 * registrations begin. Every demo person is named "Demo Person NN", tagged
 * is_demo = 1 and can be removed in one click from Settings.
 * Demo data is never mixed with real records silently: the dashboard shows a
 * banner while it is loaded.
 */

const DEMO_PEOPLE = 24;
const DEMO_SUNDAYS = 10;

function lastSundays(n) {
  const out = [];
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay()); // most recent Sunday (today if Sunday)
  for (let i = 0; i < n; i++) {
    const copy = new Date(d);
    copy.setDate(d.getDate() - i * 7);
    out.push(copy.toISOString().slice(0, 10));
  }
  return out.reverse();
}

function status(db) {
  const people = db.prepare('SELECT COUNT(*) n FROM people WHERE is_demo = 1').get().n;
  const services = db.prepare('SELECT COUNT(*) n FROM services WHERE is_demo = 1').get().n;
  return { loaded: people > 0, people, services };
}

function load(db, userId) {
  if (status(db).loaded) return { ...status(db), message: 'Demo data is already loaded.' };

  const sundays = lastSundays(DEMO_SUNDAYS);
  const statuses = ['regular', 'regular', 'member', 'member', 'regular', 'member', 'leader', 'first_timer'];
  // Deterministic pseudo-random so the demo looks the same each time.
  let seed = 42;
  const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };

  const insertPerson = db.prepare(
    `INSERT INTO people (first_name, last_name, sex, status, date_registered, school, course_year, notes, is_demo, created_by)
     VALUES (@first_name, @last_name, @sex, @status, @date_registered, @school, @course_year, 'DEMO DATA — not a real person', 1, @uid)`
  );
  const setCode = db.prepare('UPDATE people SET person_code = ? WHERE id = ?');
  const nextCode = (dateRegistered) => {
    const year = String(dateRegistered).slice(0, 4);
    const row = db.prepare("SELECT MAX(CAST(substr(person_code, 9) AS INTEGER)) AS n FROM people WHERE person_code LIKE ?").get(`LG-${year}-%`);
    return `LG-${year}-${String((row?.n || 0) + 1).padStart(4, '0')}`;
  };
  const insertService = db.prepare(
    `INSERT OR IGNORE INTO services (service_date, service_type, notes, is_demo, created_by) VALUES (?, 'lifegen', 'DEMO DATA', 1, ?)`
  );
  const getService = db.prepare("SELECT id FROM services WHERE service_date = ? AND service_type = 'lifegen'");
  const insertRecord = db.prepare(
    `INSERT OR IGNORE INTO attendance_records (service_id, person_id, status, classification, recorded_by, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const setFirst = db.prepare('UPDATE people SET date_first_attended = ? WHERE id = ? AND (date_first_attended IS NULL OR date_first_attended > ?)');

  db.transaction(() => {
    const people = [];
    for (let i = 1; i <= DEMO_PEOPLE; i++) {
      // Spread registrations across the demo period so first-timers appear gradually.
      const joinIdx = Math.min(sundays.length - 1, Math.floor(rand() * rand() * sundays.length));
      const info = insertPerson.run({
        first_name: 'Demo',
        last_name: `Person ${String(i).padStart(2, '0')}`,
        sex: i % 2 ? 'male' : 'female',
        status: joinIdx >= sundays.length - 1 ? 'first_timer' : statuses[i % statuses.length],
        date_registered: sundays[joinIdx],
        school: i % 3 === 0 ? 'Demo University' : null,
        course_year: i % 3 === 0 ? `Year ${(i % 4) + 1}` : null,
        uid: userId,
      });
      setCode.run(nextCode(sundays[joinIdx]), info.lastInsertRowid);
      people.push({ id: info.lastInsertRowid, sex: i % 2 ? 'male' : 'female', joinIdx, faithfulness: 0.45 + rand() * 0.5 });
    }

    sundays.forEach((date, idx) => {
      insertService.run(date, userId);
      const sid = getService.get(date).id;
      for (const p of people) {
        if (idx < p.joinIdx) continue; // not yet registered
        const present = idx === p.joinIdx ? true : rand() < p.faithfulness;
        const cls = present ? (idx === p.joinIdx ? 'first_timer' : 'returning') : null;
        insertRecord.run(sid, p.id, present ? 'present' : 'absent', cls, userId, `${date} 15:${String(10 + Math.floor(rand() * 40)).padStart(2, '0')}:00`);
        if (present) setFirst.run(date, p.id, date);
      }
    });

    // Demo Lifegroups: three groups led by demo people; about 60% of demo people get a group,
    // one of them has a move in their history so the UI shows it.
    // Networks and groups are never mixed: a boys network holds boys groups (male leaders/members), a girls network girls groups.
    const males = people.filter((p) => p.sex === 'male'), females = people.filter((p) => p.sex === 'female');
    const insertNet = db.prepare(`INSERT INTO networks (name, gender, leader_person_id, parent_network_id, notes, is_demo, created_by) VALUES (?, ?, ?, ?, 'DEMO DATA', 1, ?)`);
    const netBoys = insertNet.run('Demo Boys Network', 'boys', males[5].id, null, userId).lastInsertRowid;
    const netGirls = insertNet.run('Demo Girls Network', 'girls', females[5].id, null, userId).lastInsertRowid;
    const netA = insertNet.run('Demo Network A (boys)', 'boys', males[9].id, netBoys, userId).lastInsertRowid;
    const netB = insertNet.run('Demo Network B (girls)', 'girls', females[9].id, netGirls, userId).lastInsertRowid;
    const insertGroup = db.prepare(`INSERT INTO lifegroups (name, gender, leader_person_id, network_id, network_manual, network, area, schedule_day, schedule_time, category, capacity, venue, notes, is_demo, created_by)
      VALUES (@name, @gender, @leader, @network_id, 1, @network, @area, @day, @time, @category, @capacity, @venue, 'DEMO DATA', 1, @uid)`);
    const groups = [
      { name: 'Demo Joshua Group', gender: 'boys', leader: males[3].id, network_id: netA, network: 'Demo Network A (boys)', area: 'Kaybanban', day: 'sat', time: '17:00', category: 'Students', capacity: 12, venue: 'Demo venue 1' },
      { name: 'Demo Ruth Group', gender: 'girls', leader: females[3].id, network_id: netB, network: 'Demo Network B (girls)', area: 'Kaybanban', day: 'sat', time: '16:00', category: 'Students', capacity: 12, venue: 'Demo venue 2' },
      { name: 'Demo David Group', gender: 'boys', leader: males[7].id, network_id: netA, network: 'Demo Network A (boys)', area: 'Muzon', day: 'fri', time: '19:00', category: 'Young Pro', capacity: 10, venue: 'Demo venue 3' },
      { name: 'Demo Esther Group', gender: 'girls', leader: females[10].id, network_id: netB, network: 'Demo Network B (girls)', area: 'Tungkong Mangga', day: 'fri', time: '19:30', category: 'Mixed', capacity: null, venue: 'Demo venue 4' },
    ].map((g) => insertGroup.run({ ...g, uid: userId }).lastInsertRowid);
    const [JOSHUA, RUTH, DAVID, ESTHER] = groups;
    const leaderOf = new Map([[males[3].id, JOSHUA], [females[3].id, RUTH], [males[7].id, DAVID], [females[10].id, ESTHER]]);
    const insertM = db.prepare("INSERT INTO lifegroup_memberships (person_id, lifegroup_id, role, tier, joined_at, left_at, assigned_by) VALUES (?, ?, ?, 'new', ?, ?, ?)");
    const areas = ['Kaybanban', 'Muzon', 'Tungkong Mangga', 'Sapang Palay'];
    const setPref = db.prepare('UPDATE people SET preferred_area = ?, preferred_day = ?, preferred_time = ? WHERE id = ?');
    const mid = Math.floor(sundays.length / 2);
    people.forEach((p, i) => {
      setPref.run(areas[i % areas.length], i % 3 ? 'sat' : 'fri', i % 2 ? 'evening' : 'afternoon', p.id);
      if (leaderOf.has(p.id)) { insertM.run(p.id, leaderOf.get(p.id), 'leader', sundays[0], null, userId); return; }
      if (i % 5 === 0) return; // stays unconnected → appears in "Needs Lifegroup"
      const k = (p.sex === 'male' ? males : females).indexOf(p);
      const g = p.sex === 'male' ? (k % 2 ? DAVID : JOSHUA) : (k % 2 ? ESTHER : RUTH);
      if (p === males[1]) { insertM.run(p.id, DAVID, 'member', sundays[0], sundays[mid], userId); insertM.run(p.id, JOSHUA, 'member', sundays[mid], null, userId); return; } // a move, kept in history
      insertM.run(p.id, g, 'member', sundays[Math.min(p.joinIdx + 1, sundays.length - 1)], null, userId);
    });
    // Progress demo: some long-time members tagged Solid, and weekly meeting reports for the last 6 weeks.
    db.prepare(`UPDATE lifegroup_memberships SET tier = 'solid' WHERE left_at IS NULL AND lifegroup_id IN (${groups.join(',')})
      AND person_id IN (SELECT id FROM people WHERE is_demo = 1 AND status IN ('member','leader','regular'))`).run();
    db.prepare("UPDATE lifegroup_memberships SET tier = 'solid' WHERE left_at IS NULL AND lifegroup_id = ?").run(JOSHUA); // one solid Lifegroup in the demo
    const insertMeet = db.prepare(`INSERT OR IGNORE INTO lifegroup_meetings (lifegroup_id, meeting_date, held, no_meeting_reason, topic, notes, present_count, submitted_via, submitted_by_name)
      VALUES (?, ?, ?, ?, ?, 'DEMO DATA', ?, 'leader_link', 'Demo leader')`);
    const insertMA = db.prepare('INSERT OR IGNORE INTO lifegroup_meeting_attendance (meeting_id, person_id, present, devotion) VALUES (?, ?, 1, ?)');
    const topics = ['Prayer', 'Identity in Christ', 'Serving', 'Faith', 'Community', 'Generosity'];
    const dayOffset = { sat: 6, fri: 5 };
    groups.forEach((gid, gi) => {
      const g = db.prepare('SELECT schedule_day FROM lifegroups WHERE id = ?').get(gid);
      const mem = db.prepare('SELECT person_id FROM lifegroup_memberships WHERE lifegroup_id = ? AND left_at IS NULL').all(gid).map((r) => r.person_id);
      for (let w = 6; w >= 1; w -= 1) {
        const mon = new Date(); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7) - 7 * w);
        const d = new Date(mon); d.setDate(d.getDate() + (dayOffset[g.schedule_day] ?? 5));
        const date = d.toISOString().slice(0, 10);
        if ((w + gi) % 5 === 0) { insertMeet.run(gid, date, 0, 'Demo: exams week', null, 0); continue; }
        const present = mem.filter((_, i) => (i + w) % 4 !== 0);
        const id = insertMeet.run(gid, date, 1, null, topics[(w + gi) % topics.length], present.length).lastInsertRowid;
        for (const pid of present) insertMA.run(id, pid, (pid + w) % 3 === 0 ? 0 : 1);
      }
    });
  })();

  return { ...status(db), message: 'Demo data loaded.' };
}

function remove(db) {
  db.transaction(() => {
    db.prepare("DELETE FROM registrations WHERE user_agent = 'DEMO DATA'").run();
    db.prepare('DELETE FROM lifegroup_meeting_attendance WHERE meeting_id IN (SELECT id FROM lifegroup_meetings WHERE lifegroup_id IN (SELECT id FROM lifegroups WHERE is_demo = 1))').run();
    db.prepare('DELETE FROM lifegroup_meetings WHERE lifegroup_id IN (SELECT id FROM lifegroups WHERE is_demo = 1)').run();
    db.prepare('DELETE FROM lifegroup_memberships WHERE lifegroup_id IN (SELECT id FROM lifegroups WHERE is_demo = 1)').run();
    db.prepare('DELETE FROM lifegroups WHERE is_demo = 1').run();
    db.prepare('DELETE FROM networks WHERE is_demo = 1').run();
    db.prepare('DELETE FROM people WHERE is_demo = 1').run(); // cascades to attendance_records + memberships
    // Remove demo services only if no real records remain on them.
    db.prepare(
      `DELETE FROM services WHERE is_demo = 1
         AND NOT EXISTS (SELECT 1 FROM attendance_records r WHERE r.service_id = services.id)`
    ).run();
    db.prepare('DELETE FROM attendance_audit WHERE person_id NOT IN (SELECT id FROM people)').run();
  })();
  return { ...status(db), message: 'Demo data removed.' };
}

module.exports = { status, load, remove };
