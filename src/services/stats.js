'use strict';

/**
 * Shared attendance statistics.
 * All dashboard / report numbers are computed from attendance_records rows so
 * that every screen agrees with every other screen.
 *
 * Attendance rate for a Sunday = present ÷ "registered base", where the
 * registered base is the number of people who were already registered (or had
 * already first attended) on or before that Sunday and are not currently inactive.
 */

const SERVICE_SUMMARY_SQL = `
  SELECT s.id, s.service_date, s.service_type, s.notes, s.is_demo, s.created_at, s.updated_at,
         COALESCE(SUM(r.status = 'present'), 0)                                        AS present_count,
         COALESCE(SUM(r.status = 'present' AND r.classification = 'first_timer'), 0)  AS first_timer_count,
         COALESCE(SUM(r.status = 'present' AND r.classification = 'returning'), 0)    AS returning_count,
         COALESCE(SUM(r.status = 'absent'), 0)                                         AS absent_count,
         COUNT(r.id)                                                                   AS recorded_count,
         (SELECT COUNT(*) FROM people p
           WHERE MIN(p.date_registered, COALESCE(p.date_first_attended, p.date_registered)) <= s.service_date
             AND p.status <> 'inactive' AND p.archived_at IS NULL)                      AS registered_base
    FROM services s
    LEFT JOIN attendance_records r ON r.service_id = s.id`;

function withRate(row) {
  if (!row) return row;
  const rate = row.registered_base > 0 ? Math.round((row.present_count / row.registered_base) * 1000) / 10 : null;
  return { ...row, attendance_rate: rate };
}

/** Per-service summaries, chronological (oldest → newest). */
function serviceSummaries(db, { from, to, limit, order = 'ASC' } = {}) {
  const where = ["s.service_type = 'lifegen'"];
  const params = {};
  if (from) { where.push('s.service_date >= @from'); params.from = from; }
  if (to)   { where.push('s.service_date <= @to');   params.to = to; }
  let sql = `${SERVICE_SUMMARY_SQL} WHERE ${where.join(' AND ')} GROUP BY s.id ORDER BY s.service_date ${order === 'DESC' ? 'DESC' : 'ASC'}`;
  if (limit) sql += ` LIMIT ${Number(limit)}`;
  return db.prepare(sql).all(params).map(withRate);
}

function serviceSummary(db, id) {
  const row = db.prepare(`${SERVICE_SUMMARY_SQL} WHERE s.id = ? GROUP BY s.id`).get(id);
  return row && row.id ? withRate(row) : null;
}

/** Aggregate a list of service summaries into report totals. */
function aggregate(rows) {
  const n = rows.length;
  const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const present = sum('present_count');
  const rated = rows.filter((r) => r.attendance_rate !== null);
  return {
    services: n,
    total_attendance: present,
    first_timers: sum('first_timer_count'),
    returning: sum('returning_count'),
    absent: sum('absent_count'),
    average_attendance: n ? Math.round((present / n) * 10) / 10 : 0,
    highest: n ? rows.reduce((a, r) => (r.present_count > a.present_count ? r : a), rows[0]) : null,
    lowest: n ? rows.reduce((a, r) => (r.present_count < a.present_count ? r : a), rows[0]) : null,
    average_rate: rated.length
      ? Math.round((rated.reduce((a, r) => a + r.attendance_rate, 0) / rated.length) * 10) / 10
      : null,
  };
}

/** Monthly breakdown from a list of service summaries. */
function monthlyBreakdown(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = r.service_date.slice(0, 7);
    const m = map.get(key) || { month: key, services: 0, present: 0, first_timers: 0, returning: 0, absent: 0 };
    m.services += 1;
    m.present += r.present_count;
    m.first_timers += r.first_timer_count;
    m.returning += r.returning_count;
    m.absent += r.absent_count;
    map.set(key, m);
  }
  return [...map.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({ ...m, average: m.services ? Math.round((m.present / m.services) * 10) / 10 : 0 }));
}

module.exports = { serviceSummaries, serviceSummary, aggregate, monthlyBreakdown, withRate };
