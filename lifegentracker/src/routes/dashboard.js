'use strict';

const express = require('express');
const { getDb } = require('../db');
const { wrap, today, quarterOf, quarterRange, monthRange } = require('../lib/util');
const { requirePermission, can } = require('../middleware/auth');
const stats = require('../services/stats');
const lifegroups = require('./lifegroups');

const router = express.Router();

// GET /api/dashboard
router.get(
  '/',
  requirePermission('dashboard:view'),
  wrap((req, res) => {
    const db = getDb();
    const now = today();
    const year = Number(now.slice(0, 4));
    const month = Number(now.slice(5, 7));
    const quarter = quarterOf(now);

    const people = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(status <> 'inactive') AS active,
                SUM(status = 'inactive') AS inactive,
                SUM(status = 'first_timer') AS first_timers,
                SUM(strftime('%Y-%m', date_registered) = strftime('%Y-%m', 'now', 'localtime')) AS registered_this_month
           FROM people WHERE archived_at IS NULL`
      )
      .get();

    const all = stats.serviceSummaries(db, {});
    const latest = all.length ? all[all.length - 1] : null;
    const previous = all.length > 1 ? all[all.length - 2] : null;

    const mr = monthRange(year, month);
    const qr = quarterRange(year, quarter);
    const monthRows = all.filter((r) => r.service_date >= mr.from && r.service_date <= mr.to);
    const quarterRows = all.filter((r) => r.service_date >= qr.from && r.service_date <= qr.to);
    const yearRows = all.filter((r) => r.service_date.startsWith(String(year)));

    const monthly = stats.monthlyBreakdown(yearRows);

    res.json({
      today: now,
      people: {
        total: people.total || 0,
        active: people.active || 0,
        inactive: people.inactive || 0,
        first_timers: people.first_timers || 0,
        registered_this_month: people.registered_this_month || 0,
      },
      services_recorded: all.length,
      latest,
      previous,
      change_vs_previous: latest && previous ? latest.present_count - previous.present_count : null,
      month: { label: mr.from.slice(0, 7), ...stats.aggregate(monthRows) },
      quarter: { label: `Q${quarter} ${year}`, quarter, year, ...stats.aggregate(quarterRows) },
      year: { label: String(year), ...stats.aggregate(yearRows) },
      weekly: all.slice(-12),
      recent: all.slice(-8).reverse(),
      average_attendance: yearRows.length ? stats.aggregate(yearRows).average_attendance : (all.length ? stats.aggregate(all.slice(-8)).average_attendance : null),
      trend: all.slice(-26),
      monthly,
      demo_loaded: db.prepare('SELECT COUNT(*) AS n FROM people WHERE is_demo = 1').get().n > 0,
      // QR registrations waiting for review — admin only (others get null, not 0, so the UI hides it)
      pending_registrations: can(req.user, 'registrations:manage') ? db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE status = 'pending'").get().n : null,
      lifegroups: lifegroups.overview(db),
      needs_lifegroup: db.prepare(`
        SELECT p.id, p.person_code, p.first_name, p.last_name, p.photo, p.status, p.date_registered,
               (SELECT MAX(s.service_date) FROM attendance_records r JOIN services s ON s.id = r.service_id WHERE r.person_id = p.id AND r.status = 'present') AS last_attended
          FROM people p
         WHERE p.archived_at IS NULL AND p.status <> 'inactive'
           AND NOT EXISTS (SELECT 1 FROM lifegroup_memberships m WHERE m.person_id = p.id AND m.left_at IS NULL)
         ORDER BY last_attended IS NULL, last_attended DESC, p.date_registered DESC LIMIT 6`).all(),
    });
  })
);

module.exports = router;
