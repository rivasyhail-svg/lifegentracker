#!/usr/bin/env node
'use strict';
/**
 * Large demo: simulates ~3 months of real use — 1,000 people, 14 Sundays of attendance,
 * ~75 Lifegroups with leaders, networks formed automatically, Solid/New tiers, 12 weeks of
 * leader meeting reports, and a QR registration inbox. EVERYTHING is flagged is_demo = 1
 * (registrations: user_agent = 'DEMO DATA') and is removed by Settings → Remove demo data.
 *
 *   node scripts/seed-large-demo.js            # uses the same DB settings as the server
 *   PEOPLE=500 node scripts/seed-large-demo.js # smaller
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const { initDb, getDb } = require('../src/db');
const { syncNetworks } = require('../src/services/networks-auto');
const { normalizeName, normalizeEmail } = require('../src/lib/normalize');

const N = Math.max(50, Number(process.env.PEOPLE) || 1000);
let seed = 20261009;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rand() * a.length)];
const chance = (p) => rand() < p;
const pad = (n, w) => String(n).padStart(w, '0');

const MALE = ['Juan', 'Mark', 'Paolo', 'Joshua', 'Daniel', 'James', 'John Paul', 'Kenneth', 'Carlo', 'Miguel', 'Angelo', 'Christian', 'Jerome', 'Ryan', 'Nathaniel', 'Elijah', 'Gabriel', 'Joseph', 'Adrian', 'Lance', 'Vince', 'Jericho', 'Kyle', 'Rafael', 'Timothy', 'Samuel', 'Marco', 'Enzo', 'Josh', 'Ivan', 'Aaron', 'Jacob', 'Noel', 'Rey', 'Dominic', 'Francis', 'Lorenzo', 'Patrick', 'Renz', 'Jay'];
const FEMALE = ['Maria', 'Angela', 'Joy', 'Grace', 'Faith', 'Hannah', 'Andrea', 'Bea', 'Kyla', 'Nicole', 'Jasmine', 'Princess', 'Ella', 'Danica', 'Shaina', 'Trisha', 'Camille', 'Patricia', 'Mikaela', 'Sophia', 'Kristine', 'Erika', 'Lea', 'Abigail', 'Ruth', 'Esther', 'Janine', 'Rhea', 'Pauline', 'Alyssa', 'Chloe', 'Jenny', 'Hazel', 'Clarisse', 'Diane', 'Monica', 'Sarah', 'Louise', 'Ivy', 'Bianca'];
const LAST = ['Dela Cruz', 'Santos', 'Reyes', 'Garcia', 'Bautista', 'Mendoza', 'Villanueva', 'Ramos', 'Cruz', 'Torres', 'Flores', 'Gonzales', 'Castillo', 'Rivera', 'Aquino', 'Fernandez', 'Lopez', 'Navarro', 'Domingo', 'Pascual', 'Soriano', 'Mercado', 'Salazar', 'Tolentino', 'Manalo', 'Marquez', 'Hernandez', 'Ocampo', 'Padilla', 'Lim', 'Tan', 'Rosales', 'Alvarez', 'Velasco', 'Santiago', 'Cabrera', 'Dizon', 'Jimenez', 'Magno', 'Perez', 'Yap', 'Sison', 'Estrada', 'Gutierrez', 'Agustin', 'Buenaventura', 'Dimaculangan', 'Evangelista', 'Macaraeg', 'Villar'];
const SCHOOLS = ['Bulacan State University', 'SJDM Polytechnic', 'La Consolacion', 'Colegio de SJDM', 'Centro Escolar Malolos', 'PUP San Jose', 'St. Paul Bulacan', 'Towerville NHS', 'Muzon NHS', 'Kaypian NHS', 'Sapang Palay NHS', ''];
const AREAS = ['Kaybanban', 'Muzon', 'Tungkong Mangga', 'Sapang Palay', 'Towerville', 'Kaypian', 'Graceville', 'Minuyan', 'San Rafael', 'Francisco Homes'];
const CATEGORIES = ['Students', 'Young Pro', 'Senior High', 'College', 'Mixed'];
const TOPICS = ['Prayer', 'Identity in Christ', 'Serving', 'Faith', 'Community', 'Generosity', 'Forgiveness', 'Purpose', 'Holy Spirit', 'Discipleship', 'Family', 'Evangelism'];
const NO_MEET = ['Exams week', 'Leader was sick', 'Holiday', 'Heavy rain / flooding', 'Venue not available', 'Church-wide event instead'];
const MINISTRIES = ['Worship Team', 'Ushering', 'Media / Tech', 'Kids Ministry', 'Dance / Creative', 'Prayer', 'Production', 'Not yet in a ministry'];

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
function lastSundays(n) {
  const mnl = new Date(Date.now() + 8 * 3600e3);
  let s = iso(mnl); const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); s = iso(d);
  const out = []; for (let i = n - 1; i >= 0; i -= 1) out.push(addDays(s, -7 * i)); return out;
}

(async () => {
  await initDb();
  const db = getDb();
  const uid = db.prepare("SELECT id FROM users WHERE role_id = 'admin' ORDER BY id LIMIT 1").get()?.id || null;
  const already = db.prepare('SELECT COUNT(*) n FROM people WHERE is_demo = 1').get().n;
  if (already > 0) { console.log(`Demo data already present (${already} people). Remove it first: Settings → Remove demo data.`); process.exit(1); }

  const sundays = lastSundays(14);           // 14 Sundays ≈ 3 months + this week
  const start = addDays(sundays[0], -7);     // registrations begin one week before the first demo Sunday
  const today = iso(new Date(Date.now() + 8 * 3600e3));
  const t0 = Date.now();

  db.transaction(() => {
    const year = sundays[0].slice(0, 4);
    const codeRow = db.prepare("SELECT MAX(CAST(substr(person_code, 9) AS INTEGER)) AS n FROM people WHERE person_code LIKE ?").get(`LG-${year}-%`);
    let codeN = codeRow?.n || 0;
    const insP = db.prepare(`INSERT INTO people (person_code, first_name, last_name, sex, birthdate, contact_number, email, email_normalized, full_name_normalized, address, school, course_year, status, date_registered, notes, is_demo, registration_source, registered_at, privacy_consent_at, created_by, created_at)
      VALUES (@code, @first_name, @last_name, @sex, @birthdate, @contact, @email, @email_n, @name_n, @address, @school, @course, @status, @date_registered, 'DEMO DATA — not a real person', 1, @src, @reg_at, @reg_at, @uid, @reg_at)`);
    const insS = db.prepare("INSERT OR IGNORE INTO services (service_date, service_type, notes, is_demo, created_by) VALUES (?, 'lifegen', 'DEMO DATA', 1, ?)");
    const getS = db.prepare("SELECT id FROM services WHERE service_date = ? AND service_type = 'lifegen'");
    const insR = db.prepare("INSERT OR IGNORE INTO attendance_records (service_id, person_id, status, classification, recorded_by, recorded_at) VALUES (?, ?, 'present', ?, ?, ?)");
    const insA = db.prepare("INSERT INTO attendance_audit (service_id, person_id, action, new_status, new_classification, user_id, created_at) VALUES (?, ?, 'mark', 'present', ?, ?, ?)");
    const setFirst = db.prepare('UPDATE people SET date_first_attended = ? WHERE id = ?');

    // ---- people ---------------------------------------------------------
    const people = [];
    const usedNames = new Set(), usedEmails = new Set();
    // 6 network leaders + ~70 group leaders come first so they exist from the start
    for (let i = 0; i < N; i += 1) {
      const sex = i % 2 ? 'female' : 'male';
      let first, last, key;
      do { first = pick(sex === 'male' ? MALE : FEMALE); last = pick(LAST); key = normalizeName(`${first} ${last}`); } while (usedNames.has(key));
      usedNames.add(key);
      const isNetLeader = i < 6, isLeader = i < 86;
      const r = rand();
      const status = isLeader ? 'leader' : r < 0.12 ? 'first_timer' : r < 0.22 ? 'new_believer' : r < 0.52 ? 'regular' : r < 0.80 ? 'member' : r < 0.90 ? 'volunteer' : 'inactive';
      // registration date: leaders & members early; first timers mostly in the last weeks
      let dayOff;
      if (isLeader) dayOff = -Math.floor(rand() * 30);
      else if (status === 'first_timer') dayOff = 60 + Math.floor(rand() * 42);
      else if (status === 'new_believer') dayOff = 20 + Math.floor(rand() * 70);
      else dayOff = Math.floor(rand() * 84) - 20;
      let dateReg = addDays(start, dayOff); if (dateReg > today) dateReg = today;
      // most join on a Sunday
      const dr = new Date(`${dateReg}T00:00:00Z`); if (chance(0.8)) { dr.setUTCDate(dr.getUTCDate() - dr.getUTCDay()); dateReg = iso(dr) < start ? start : iso(dr); }
      const age = 15 + Math.floor(rand() * 16);
      const by = Number(year) - age;
      const birthdate = `${by}-${pad(1 + Math.floor(rand() * 12), 2)}-${pad(1 + Math.floor(rand() * 28), 2)}`;
      const emailBase = `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '');
      let email = null; if (chance(0.6)) { let e = `${emailBase}@gmail.com`, k = 1; while (usedEmails.has(e)) { k += 1; e = `${emailBase}${k}@gmail.com`; } usedEmails.add(e); email = e; }
      const viaQr = !isLeader && chance(0.35) && dateReg >= addDays(sundays[0], 14);
      const area = pick(AREAS);
      codeN += 1;
      const regAt = `${dateReg} ${pad(10 + Math.floor(rand() * 6), 2)}:${pad(Math.floor(rand() * 60), 2)}:00`;
      const id = insP.run({ code: `LG-${year}-${pad(codeN, 4)}`, first_name: first, last_name: last, sex, birthdate, contact: `09${pad(Math.floor(rand() * 1e9), 9)}`, email, email_n: email ? normalizeEmail(email) : null, name_n: key,
        address: `${area}, San Jose del Monte, Bulacan`, school: pick(SCHOOLS) || null, course: chance(0.5) ? `${pick(['BSIT', 'BSBA', 'BSEd', 'BSN', 'STEM', 'HUMSS', 'ABM', 'BSA', 'BSCrim'])} ${1 + Math.floor(rand() * 4)}` : null,
        status, date_registered: dateReg, src: viaQr ? 'qr' : 'manual', reg_at: regAt, uid }).lastInsertRowid;
      // attendance propensity by status
      const p = status === 'leader' ? 0.92 : status === 'member' ? 0.82 : status === 'volunteer' ? 0.85 : status === 'regular' ? 0.68 : status === 'new_believer' ? 0.6 : status === 'first_timer' ? 0.45 : 0.15;
      people.push({ id, sex, status, first, last, dateReg, area, p: p * (0.8 + rand() * 0.3), isNetLeader, isLeader, email });
    }

    // ---- Sundays + attendance ----------------------------------------------
    const svcIds = sundays.map((d) => { insS.run(d, uid); return getS.get(d).id; });
    let records = 0;
    for (const person of people) {
      let firstDone = false;
      // inactive people: attended early then stopped
      sundays.forEach((d, i) => {
        if (d < person.dateReg || d > today) return;
        let p = person.p;
        if (person.status === 'inactive') p = i < 5 ? 0.7 : 0.03;
        if (person.status === 'first_timer' && firstDone) p = 0.35;
        if (!firstDone && d === person.dateReg) p = 0.97; // registered that Sunday → present
        if (!chance(p)) return;
        const at = `${d} ${pad(12 + Math.floor(rand() * 2), 2)}:${pad(Math.floor(rand() * 60), 2)}:${pad(Math.floor(rand() * 60), 2)}`;
        insR.run(svcIds[i], person.id, firstDone ? 'returning' : 'first_timer', uid, at);
        insA.run(svcIds[i], person.id, firstDone ? 'returning' : 'first_timer', uid, at);
        if (!firstDone) { setFirst.run(d, person.id); firstDone = true; }
        records += 1;
      });
    }

    // ---- Lifegroups -----------------------------------------------------------
    const insG = db.prepare(`INSERT INTO lifegroups (name, gender, leader_person_id, area, schedule_day, schedule_time, category, capacity, venue, notes, is_demo, created_by, created_at)
      VALUES (@name, @gender, @leader, @area, @day, @time, @category, @capacity, @venue, 'DEMO DATA', 1, @uid, @created)`);
    const insM = db.prepare("INSERT INTO lifegroup_memberships (person_id, lifegroup_id, role, tier, joined_at, assigned_by) VALUES (?, ?, ?, ?, ?, ?)");
    const netLeaders = people.filter((x) => x.isNetLeader);
    const subLeaders = people.filter((x) => x.isLeader && !x.isNetLeader);
    const groups = [];
    const mkGroup = (leader, members) => {
      const gender = leader.sex === 'male' ? 'boys' : 'girls';
      const created = `${addDays(start, Math.floor(rand() * 10))} 10:00:00`;
      const gid = insG.run({ name: `${leader.first} ${leader.last.split(' ')[0]} Group`, gender, leader: leader.id, area: leader.area, day: pick(['fri', 'fri', 'sat', 'sat', 'sat', 'wed', 'thu']), time: pick(['16:00', '17:00', '18:00', '19:00', '19:30']), category: pick(CATEGORIES), capacity: chance(0.6) ? 10 + Math.floor(rand() * 6) : null, venue: chance(0.7) ? `${leader.area} ${pick(['covered court', 'residence', 'chapel', 'coffee shop', 'school grounds'])}` : null, uid, created }).lastInsertRowid;
      // (the leader is not a membership row of their own group — same as the app; sub-leaders sit as members of the network leader's group)
      const g = { id: gid, leader, gender, members: [] };
      for (const m of members) { const joined = m.dateReg > start ? m.dateReg : addDays(start, Math.floor(rand() * 21)); insM.run(m.id, gid, 'member', 'new', joined, uid); m.joined = joined; g.members.push(m); }
      groups.push(g); return g;
    };
    // network leaders' own groups hold the sub-leaders (this is what forms the networks automatically)
    const subBySex = { male: subLeaders.filter((x) => x.sex === 'male'), female: subLeaders.filter((x) => x.sex === 'female') };
    netLeaders.forEach((nl, i) => { const pool = subBySex[nl.sex]; const take = pool.splice(0, Math.ceil(pool.length / (3 - Math.floor(i / 2)))); mkGroup(nl, take); });
    // members for sub-leaders' groups
    const pool = { male: people.filter((x) => !x.isLeader && x.sex === 'male' && x.status !== 'inactive'), female: people.filter((x) => !x.isLeader && x.sex === 'female' && x.status !== 'inactive') };
    for (const k of ['male', 'female']) pool[k].sort(() => rand() - 0.5);
    for (const sl of subLeaders) { const n = 4 + Math.floor(rand() * 9); mkGroup(sl, pool[sl.sex].splice(0, n)); }
    // ~20% of the rest stay without a Lifegroup (shows up in "Needs Lifegroup")

    // tiers: longer-standing, consistent members become Solid
    const upTier = db.prepare("UPDATE lifegroup_memberships SET tier = 'solid' WHERE person_id = ? AND lifegroup_id = ? AND left_at IS NULL");
    for (const g of groups) for (const m of g.members) if (m.joined <= addDays(sundays[0], 42) && m.p > 0.6 && chance(0.75)) upTier.run(m.id, g.id);

    // ---- 12 weeks of leader reports ------------------------------------------------
    const insMeet = db.prepare(`INSERT OR IGNORE INTO lifegroup_meetings (lifegroup_id, meeting_date, held, no_meeting_reason, topic, notes, present_count, submitted_via, submitted_by_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'leader_link', ?, ?)`);
    const insMA = db.prepare('INSERT OR IGNORE INTO lifegroup_meeting_attendance (meeting_id, person_id, present, devotion) VALUES (?, ?, ?, ?)');
    const DAYN = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
    let meetings = 0;
    for (const g of groups) {
      const day = db.prepare('SELECT schedule_day FROM lifegroups WHERE id = ?').get(g.id).schedule_day;
      const consistency = 0.55 + rand() * 0.45;
      const todayD = new Date(`${today}T00:00:00Z`);
      const thisMonday = addDays(today, -((todayD.getUTCDay() + 6) % 7));
      for (let w = 13; w >= 0; w -= 1) {
        const mon = addDays(thisMonday, -7 * w);
        const date = addDays(mon, DAYN[day]);
        if (date > today || date < start) continue;
        if (w === 0 && chance(0.3)) continue; // some of this week's reports are not in yet
        if (!chance(consistency)) { if (chance(0.6)) { insMeet.run(g.id, date, 0, pick(NO_MEET), null, null, 0, `${g.leader.first} ${g.leader.last}`, `${date} 21:00:00`); meetings += 1; } continue; }
        const present = g.members.filter((m) => m.joined <= date).filter((m) => chance(m.p));
        const mid = insMeet.run(g.id, date, 1, null, pick(TOPICS), chance(0.2) ? 'Prayer requests noted. DEMO DATA' : null, present.length, `${g.leader.first} ${g.leader.last}`, `${date} 21:${pad(Math.floor(rand() * 60), 2)}:00`).lastInsertRowid;
        for (const m of present) insMA.run(mid, m.id, 1, chance(m.p > 0.7 ? 0.7 : 0.35) ? 1 : 0);
        for (const m of g.members.filter((x) => x.joined <= date && !present.includes(x))) if (chance(0.2)) insMA.run(mid, m.id, 0, 1);
        meetings += 1;
      }
    }

    // ---- QR registration inbox ------------------------------------------------------
    const insReg = db.prepare(`INSERT INTO registrations (ref_code, full_name, full_name_normalized, email, email_normalized, age, school, leader_name, network_leader_name, ministry, source, status, possible_duplicate, person_id, submitted_at, approved_at, rejected_at, reviewed_by, review_note, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'qr', ?, ?, ?, ?, ?, ?, ?, ?, 'DEMO DATA')`);
    const refRow = db.prepare("SELECT MAX(CAST(substr(ref_code, 9) AS INTEGER)) AS n FROM registrations WHERE ref_code LIKE ?").get(`LG-${year}-%`);
    let refN = refRow?.n || 0;
    let regs = 0;
    const lastSun = sundays.filter((d) => d <= today).pop();
    for (let i = 0; i < 38; i += 1) {
      const sex = i % 2 ? 'female' : 'male';
      let first, last, key; do { first = pick(sex === 'male' ? MALE : FEMALE); last = pick(LAST); key = normalizeName(`${first} ${last}`); } while (usedNames.has(key) && rand() < 0.9);
      const dup = usedNames.has(key); usedNames.add(key);
      let email = `${first}.${last}.${i}`.toLowerCase().replace(/[^a-z.0-9]/g, '') + '@gmail.com';
      const g = pick(groups.filter((x) => x.gender === (sex === 'male' ? 'boys' : 'girls')));
      const netLeader = netLeaders.find((n) => n.sex === sex) || netLeaders[0];
      const status = i < 24 ? 'pending' : i < 33 ? 'approved' : 'rejected';
      const when = status === 'pending' ? `${lastSun} ${pad(12 + Math.floor(rand() * 5), 2)}:${pad(Math.floor(rand() * 60), 2)}:00` : `${addDays(lastSun, -7 * (1 + Math.floor(rand() * 4)))} 13:${pad(Math.floor(rand() * 60), 2)}:00`;
      refN += 1;
      insReg.run(`LG-${year}-${pad(refN, 6)}`, `${first} ${last}`, key, email, normalizeEmail(email), 15 + Math.floor(rand() * 14), pick(SCHOOLS) || 'Not in school', `${g.leader.first} ${g.leader.last}`, `${netLeader.first} ${netLeader.last}`, pick(MINISTRIES),
        status, dup ? 1 : 0, null, when, status === 'approved' ? when.slice(0, 10) + ' 20:00:00' : null, status === 'rejected' ? when.slice(0, 10) + ' 20:00:00' : null, status === 'pending' ? null : uid, status === 'rejected' ? pick(['Duplicate of an existing person', 'Troll / joke name', 'Asked to register personally']) : null);
      regs += 1;
    }

    console.log(`people ${people.length} · sundays ${sundays.length} · attendance ${records} · groups ${groups.length} · meeting reports ${meetings} · registrations ${regs}`);
  })();

  const nets = syncNetworks(db, null);
  console.log(`networks formed automatically: ${nets.length} → ${nets.join(', ')}`);
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
