'use strict';

/**
 * Activity log — one line per meaningful change (who, what, when).
 * Attendance marks have their own detailed audit table (attendance_audit);
 * this table covers everything else and the two are merged in GET /api/activity.
 */
function log(db, user, action, entityType, entityId, summary) {
  try {
    db.prepare(
      'INSERT INTO activity_log (user_id, action, entity_type, entity_id, summary) VALUES (?, ?, ?, ?, ?)'
    ).run(user ? user.id : null, action, entityType || null, entityId == null ? null : Number(entityId), summary || null);
  } catch (e) {
    // Logging must never break the action itself.
    console.error('[activity] failed to log', action, e.message);
  }
}

function recent(db, { limit = 100 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return db
    .prepare(
      `SELECT * FROM (
         SELECT a.id, a.created_at, a.action, a.entity_type, a.entity_id, a.summary,
                u.display_name AS user_name, 'activity' AS source
           FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
         UNION ALL
         SELECT x.id, x.created_at,
                'attendance.' || x.action AS action, 'attendance' AS entity_type, x.person_id AS entity_id,
                COALESCE(p.first_name || ' ' || p.last_name, 'Person #' || x.person_id) || ' — ' ||
                  CASE x.action WHEN 'mark' THEN 'marked ' || COALESCE(x.new_status, '')
                                WHEN 'undo' THEN 'mark removed'
                                ELSE 'changed ' || COALESCE(x.old_status, '-') || '/' || COALESCE(x.old_classification, '-') ||
                                     ' → ' || COALESCE(x.new_status, '-') || '/' || COALESCE(x.new_classification, '-') END ||
                  ' (' || s.service_date || ')' AS summary,
                u.display_name AS user_name, 'attendance' AS source
           FROM attendance_audit x
           LEFT JOIN users u ON u.id = x.user_id
           LEFT JOIN people p ON p.id = x.person_id
           LEFT JOIN services s ON s.id = x.service_id
       ) ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(n);
}

module.exports = { log, recent };
