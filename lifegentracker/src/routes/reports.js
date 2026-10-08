'use strict';

const express = require('express');
const { getDb } = require('../db');
const { wrap, clean, isValidDate, HttpError, toCsv, sendCsv, quarterRange, monthRange } = require('../lib/util');
const { requirePermission, can } = require('../middleware/auth');
const stats = require('../services/stats');

const router = express.Router();

/** Resolve ?from&to | ?year | ?year&quarter | ?year&month into a date range. */
function resolveRange(query) {
  const year = Number(query.year);
  const quarter = Number(query.quarter);
  const month = Number(query.month);
  let from = clean(query.from);
  let to = clean(query.to);
  let label;

  if (year && quarter >= 1 && quarter <= 4) {
    ({ from, to } = quarterRange(year, quarter));
    label = `Q${quarter} ${year}`;
  } else if (year && month >= 1 && month <= 12) {
    ({ from, to } = monthRange(year, month));
    label = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  } else if (year) {
    from = `${year}-01-01`;
    to = `${year}-12-31`;
    label = `Year ${year}`;
  } else {
    if (from && !isValidDate(from)) throw new HttpError(400, 'Invalid "from" date.');
    if (to && !isValidDate(to)) throw new HttpError(400, 'Invalid "to" date.');
    const nice = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    if (from && to && from === to) label = `Sunday, ${nice(from)}`;
    else label = from || to ? `${from ? nice(from) : 'Beginning'} – ${to ? nice(to) : 'Today'}` : 'All time';
  }
  if (from && to && from > to) throw new HttpError(400, '"From" date must be before "to" date.');
  return { from, to, label };
}

// GET /api/reports/summary
router.get(
  '/summary',
  requirePermission('reports:view'),
  wrap((req, res) => {
    const db = getDb();
    const range = resolveRange(req.query);
    const rows = stats.serviceSummaries(db, { from: range.from, to: range.to });
    const totals = stats.aggregate(rows);

    const uniq = db
      .prepare(
        `SELECT COUNT(DISTINCT r.person_id) AS n
           FROM attendance_records r JOIN services s ON s.id = r.service_id
          WHERE r.status = 'present' AND s.service_date >= ? AND s.service_date <= ?`
      )
      .get(range.from || '0000-01-01', range.to || '9999-12-31').n;

    const newRegistrations = db
      .prepare('SELECT COUNT(*) AS n FROM people WHERE date_registered >= ? AND date_registered <= ?')
      .get(range.from || '0000-01-01', range.to || '9999-12-31').n;

    res.json({
      range,
      totals: { ...totals, unique_attendees: uniq, new_registrations: newRegistrations },
      weekly: rows,
      monthly: stats.monthlyBreakdown(rows),
    });
  })
);

// GET /api/reports/years — years with data
router.get(
  '/years',
  requirePermission('reports:view'),
  wrap((req, res) => {
    const db = getDb();
    const years = db
      .prepare("SELECT DISTINCT strftime('%Y', service_date) AS y FROM services ORDER BY y DESC")
      .all()
      .map((r) => Number(r.y));
    const cur = new Date().getFullYear();
    if (!years.includes(cur)) years.unshift(cur);
    res.json(years);
  })
);

// GET /api/reports/export/weekly.csv
router.get(
  '/export/weekly.csv',
  requirePermission('reports:view'),
  wrap((req, res) => {
    const db = getDb();
    const range = resolveRange(req.query);
    const rows = stats.serviceSummaries(db, { from: range.from, to: range.to }).map((r) => ({
      sunday: r.service_date,
      service: 'Lifegen / 3rd Service',
      present: r.present_count,
      first_timers: r.first_timer_count,
      returning: r.returning_count,
      absent: r.absent_count,
      registered_base: r.registered_base,
      attendance_rate_pct: r.attendance_rate ?? '',
      notes: r.notes || '',
    }));
    sendCsv(res, `lifegen-weekly-${(range.label || 'report').replace(/\s+/g, '-').toLowerCase()}.csv`,
      toCsv(['sunday', 'service', 'present', 'first_timers', 'returning', 'absent', 'registered_base', 'attendance_rate_pct', 'notes'], rows));
  })
);

// GET /api/reports/export/monthly.csv
router.get(
  '/export/monthly.csv',
  requirePermission('reports:view'),
  wrap((req, res) => {
    const db = getDb();
    const range = resolveRange(req.query);
    const rows = stats.monthlyBreakdown(stats.serviceSummaries(db, { from: range.from, to: range.to }));
    sendCsv(res, 'lifegen-monthly.csv', toCsv(['month', 'services', 'present', 'average', 'first_timers', 'returning', 'absent'], rows));
  })
);

// GET /api/reports/export/detail.csv — one row per attendance record
router.get(
  '/export/detail.csv',
  requirePermission('reports:view'),
  wrap((req, res) => {
    const db = getDb();
    const range = resolveRange(req.query);
    const rows = db
      .prepare(
        `SELECT s.service_date AS sunday, p.person_code, p.last_name, p.first_name, p.status AS person_status,
                r.status AS attendance, r.classification, r.recorded_at, u.display_name AS recorded_by
           FROM attendance_records r
           JOIN services s ON s.id = r.service_id
           JOIN people p ON p.id = r.person_id
           LEFT JOIN users u ON u.id = r.recorded_by
          WHERE s.service_date >= ? AND s.service_date <= ?
          ORDER BY s.service_date, p.last_name, p.first_name`
      )
      .all(range.from || '0000-01-01', range.to || '9999-12-31');
    sendCsv(res, 'lifegen-attendance-detail.csv',
      toCsv(['sunday', 'person_code', 'last_name', 'first_name', 'person_status', 'attendance', 'classification', 'recorded_at', 'recorded_by'], rows));
  })
);

// GET /api/reports/export/people.csv
router.get(
  '/export/people.csv',
  requirePermission('people:view'),
  wrap((req, res) => {
    const db = getDb();
    const priv = can(req.user, 'people:view_private');
    const rows = db
      .prepare(
        `SELECT p.person_code, p.last_name, p.first_name, p.middle_name, p.sex, p.birthdate, p.contact_number, p.email,
                p.address, p.school, p.course_year, p.occupation, p.status, p.date_registered, p.date_first_attended,
                (SELECT COUNT(*) FROM attendance_records r WHERE r.person_id = p.id AND r.status = 'present') AS sundays_attended,
                CASE WHEN p.archived_at IS NULL THEN '' ELSE 'archived' END AS archived
           FROM people p ORDER BY p.archived_at IS NOT NULL, p.last_name, p.first_name`
      )
      .all();
    const headers = ['person_code', 'last_name', 'first_name', 'middle_name', 'sex',
      ...(priv ? ['birthdate', 'contact_number', 'email', 'address'] : []),
      'school', 'course_year', 'occupation', 'status', 'date_registered', 'date_first_attended', 'sundays_attended', 'archived'];
    sendCsv(res, 'lifegen-people.csv', toCsv(headers, rows));
  })
);

// GET /api/reports/lifegroups — snapshot of who is connected: per network / per group, boys vs girls
function lifegroupReport(db) {
  const groups = db.prepare(`
    SELECT g.id AS group_id, g.name AS group_name, g.gender, g.area, g.is_active, g.network_id,
           COALESCE(lp.first_name || ' ' || lp.last_name, g.leader_name) AS leader_name, g.leader_person_id,
           n.name AS network_name, n.gender AS network_gender, COALESCE(nl.first_name || ' ' || nl.last_name, n.leader_name) AS network_leader_name,
           (SELECT COUNT(*) FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id WHERE m.lifegroup_id = g.id AND m.left_at IS NULL AND p.archived_at IS NULL) AS members,
           (SELECT COUNT(*) FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id WHERE m.lifegroup_id = g.id AND m.left_at IS NULL AND p.archived_at IS NULL AND p.sex = 'male') AS boys,
           (SELECT COUNT(*) FROM lifegroup_memberships m JOIN people p ON p.id = m.person_id WHERE m.lifegroup_id = g.id AND m.left_at IS NULL AND p.archived_at IS NULL AND p.sex = 'female') AS girls
      FROM lifegroups g
      LEFT JOIN people lp ON lp.id = g.leader_person_id
      LEFT JOIN networks n ON n.id = g.network_id
      LEFT JOIN people nl ON nl.id = n.leader_person_id
     WHERE g.is_active = 1
     ORDER BY n.name IS NULL, n.name COLLATE NOCASE, g.name COLLATE NOCASE`).all();
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const finish = (r) => ({ ...r, unknown: r.members - r.boys - r.girls, boys_pct: pct(r.boys, r.members), girls_pct: pct(r.girls, r.members) });
  const byNet = new Map();
  for (const g of groups) {
    const k = g.network_id || 0;
    if (!byNet.has(k)) byNet.set(k, { network_id: g.network_id, network_name: g.network_name || 'No network', network_gender: g.network_gender || null, network_leader_name: g.network_leader_name, groups: 0, boys_groups: 0, girls_groups: 0, members: 0, boys: 0, girls: 0 });
    const n = byNet.get(k); n.groups += 1; n.members += g.members; n.boys += g.boys; n.girls += g.girls; if (g.gender === 'boys') n.boys_groups += 1; if (g.gender === 'girls') n.girls_groups += 1;
  }
  const totals = groups.reduce((t, g) => ({ groups: t.groups + 1, boys_groups: t.boys_groups + (g.gender === 'boys'), girls_groups: t.girls_groups + (g.gender === 'girls'), members: t.members + g.members, boys: t.boys + g.boys, girls: t.girls + g.girls }), { groups: 0, boys_groups: 0, girls_groups: 0, members: 0, boys: 0, girls: 0 });
  // people not in any group, by sex — the "who still needs connecting" side of the ratio
  const nc = db.prepare(`SELECT SUM(sex = 'male') AS boys, SUM(sex = 'female') AS girls, COUNT(*) AS total FROM people p
     WHERE p.archived_at IS NULL AND p.status <> 'inactive' AND NOT EXISTS (SELECT 1 FROM lifegroup_memberships m WHERE m.person_id = p.id AND m.left_at IS NULL)`).get();
  // growth: per group, last 30 days (joins − leaves) and %
  const g30 = db.prepare(`SELECT g.id,
      (SELECT COUNT(*) FROM lifegroup_memberships m WHERE m.lifegroup_id = g.id AND m.joined_at >= date('now', '-30 days')) AS joined_30d,
      (SELECT COUNT(*) FROM lifegroup_memberships m WHERE m.lifegroup_id = g.id AND m.left_at IS NOT NULL AND m.left_at >= date('now', '-30 days')) AS left_30d
     FROM lifegroups g WHERE g.is_active = 1`).all();
  const g30Map = new Map(g30.map((r) => [r.id, r]));
  const withGrowth = (g) => {
    const r = g30Map.get(g.group_id) || { joined_30d: 0, left_30d: 0 };
    const net = r.joined_30d - r.left_30d; const base = g.members - net;
    return { ...g, joined_30d: r.joined_30d, left_30d: r.left_30d, net_30d: net, growth_30d_pct: base > 0 ? Math.round((net / base) * 1000) / 10 : (net > 0 ? null : 0) };
  };
  return { groups: groups.map(finish).map(withGrowth), networks: [...byNet.values()].map(finish), totals: finish(totals), not_connected: { total: nc.total || 0, boys: nc.boys || 0, girls: nc.girls || 0 }, growth: growthSeries(db) };
}

/** Monthly growth of boys groups vs girls groups: members at month end, joins, leaves, % growth vs previous month. */
function growthSeries(db, months = 12) {
  const first = db.prepare('SELECT MIN(joined_at) AS d FROM lifegroup_memberships').get().d;
  const now = new Date(); const out = [];
  const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
  const firstDate = first ? new Date(first + 'T12:00:00') : null;
  const from = firstDate && firstDate > start ? new Date(firstDate.getFullYear(), firstDate.getMonth(), 1) : start;
  const stmt = db.prepare(`SELECT g.gender,
      SUM(m.joined_at <= @end AND (m.left_at IS NULL OR m.left_at > @end)) AS at_end,
      SUM(m.joined_at >= @start AND m.joined_at <= @end) AS joined,
      SUM(m.left_at IS NOT NULL AND m.left_at >= @start AND m.left_at <= @end) AS left_
    FROM lifegroup_memberships m JOIN lifegroups g ON g.id = m.lifegroup_id JOIN people p ON p.id = m.person_id
    WHERE p.archived_at IS NULL AND g.gender IN ('boys','girls') GROUP BY g.gender`);
  const pad = (n) => String(n).padStart(2, '0');
  let prev = { boys: null, girls: null };
  for (let d = new Date(from); d <= now; d.setMonth(d.getMonth() + 1)) {
    const y = d.getFullYear(), mo = d.getMonth();
    const startS = `${y}-${pad(mo + 1)}-01`; const endD = new Date(y, mo + 1, 0); const endS = `${y}-${pad(mo + 1)}-${pad(endD.getDate())}`;
    const rows = Object.fromEntries(stmt.all({ start: startS, end: endS }).map((r) => [r.gender, r]));
    const row = { month: `${y}-${pad(mo + 1)}` };
    for (const k of ['boys', 'girls']) {
      const r = rows[k] || {}; const end = r.at_end || 0;
      row[`${k}_end`] = end; row[`${k}_joined`] = r.joined || 0; row[`${k}_left`] = r.left_ || 0;
      row[`${k}_growth_pct`] = prev[k] === null ? null : prev[k] > 0 ? Math.round(((end - prev[k]) / prev[k]) * 1000) / 10 : (end > 0 ? null : 0);
      prev[k] = end;
    }
    out.push(row);
  }
  // summary: now vs 30 / 90 days ago
  const at = (dateS) => Object.fromEntries(stmt.all({ start: '0000-01-01', end: dateS }).map((r) => [r.gender, r.at_end || 0]));
  const iso = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  const today = iso(now); const d30 = new Date(now); d30.setDate(d30.getDate() - 30); const d90 = new Date(now); d90.setDate(d90.getDate() - 90);
  const cur = at(today), m1 = at(iso(d30)), m3 = at(iso(d90));
  const pct = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : (a > 0 ? null : 0));
  const summary = {};
  for (const k of ['boys', 'girls']) summary[k] = { now: cur[k] || 0, days30_ago: m1[k] || 0, days90_ago: m3[k] || 0, change_30d: (cur[k] || 0) - (m1[k] || 0), pct_30d: pct(cur[k] || 0, m1[k] || 0), change_90d: (cur[k] || 0) - (m3[k] || 0), pct_90d: pct(cur[k] || 0, m3[k] || 0) };
  return { months: out, summary };
}

router.get('/lifegroups', requirePermission('lifegroups:view'), wrap((req, res) => {
  res.json(lifegroupReport(getDb()));
}));

// GET /api/reports/export/lifegroups.csv — one row per active group
router.get('/export/lifegroups.csv', requirePermission('lifegroups:view'), wrap((req, res) => {
  const r = lifegroupReport(getDb());
  const rows = r.groups.map((g) => ({ network: g.network_name || '', network_leader: g.network_leader_name || '', group: g.group_name, type: g.gender === 'boys' ? 'Boys group' : g.gender === 'girls' ? 'Girls group' : '', leader: g.leader_name || '', area: g.area || '',
    members: g.members, boys: g.boys, girls: g.girls, unknown: g.unknown, boys_pct: g.boys_pct ?? '', girls_pct: g.girls_pct ?? '', joined_30d: g.joined_30d, left_30d: g.left_30d, net_30d: g.net_30d, growth_30d_pct: g.growth_30d_pct ?? '' }));
  rows.push({ network: 'TOTAL', network_leader: '', group: '', type: `${r.totals.boys_groups} boys groups / ${r.totals.girls_groups} girls groups`, leader: '', area: '', members: r.totals.members, boys: r.totals.boys, girls: r.totals.girls, unknown: r.totals.unknown, boys_pct: r.totals.boys_pct ?? '', girls_pct: r.totals.girls_pct ?? '' });
  sendCsv(res, 'lifegen-lifegroups.csv', toCsv(['network', 'network_leader', 'group', 'type', 'leader', 'area', 'members', 'boys', 'girls', 'unknown', 'boys_pct', 'girls_pct', 'joined_30d', 'left_30d', 'net_30d', 'growth_30d_pct'], rows));
}));

// GET /api/reports/export/lifegroup-growth.csv — month by month, boys groups vs girls groups
router.get('/export/lifegroup-growth.csv', requirePermission('lifegroups:view'), wrap((req, res) => {
  const g = growthSeries(getDb());
  const rows = g.months.map((m) => ({ month: m.month, boys_members: m.boys_end, boys_joined: m.boys_joined, boys_left: m.boys_left, boys_growth_pct: m.boys_growth_pct ?? '', girls_members: m.girls_end, girls_joined: m.girls_joined, girls_left: m.girls_left, girls_growth_pct: m.girls_growth_pct ?? '' }));
  sendCsv(res, 'lifegen-lifegroup-growth.csv', toCsv(['month', 'boys_members', 'boys_joined', 'boys_left', 'boys_growth_pct', 'girls_members', 'girls_joined', 'girls_left', 'girls_growth_pct'], rows));
}));

module.exports = router;
