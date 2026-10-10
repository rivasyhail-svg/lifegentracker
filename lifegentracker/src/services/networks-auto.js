'use strict';
/**
 * Auto networks. Rule: the leader of Lifegroup B is a current member of Lifegroup A (led by P)
 * → B belongs to P's network. Networks therefore grow by themselves as leaders are placed in
 * groups; an admin can still pin a group to a network by hand (lifegroups.network_manual = 1).
 */
const activity = require('./activity');

function syncNetworks(db, user = null) {
  const run = db.transaction(() => {
    const groups = db.prepare(`SELECT g.id, g.name, g.gender, g.leader_person_id, g.network_id, g.network_manual
        FROM lifegroups g WHERE g.is_active = 1`).all();
    const parentOf = db.prepare(`SELECT pg.id AS group_id, pg.gender, pg.leader_person_id AS leader_id, lp.first_name, lp.last_name, lp.sex
        FROM lifegroup_memberships m JOIN lifegroups pg ON pg.id = m.lifegroup_id LEFT JOIN people lp ON lp.id = pg.leader_person_id
       WHERE m.person_id = ? AND m.left_at IS NULL AND pg.is_active = 1 AND pg.leader_person_id IS NOT NULL AND pg.leader_person_id <> ? LIMIT 1`);
    const netByLeader = db.prepare('SELECT id, is_active, gender FROM networks WHERE leader_person_id = ? ORDER BY is_auto DESC, is_active DESC, id LIMIT 1');
    const created = [];
    const ensureNet = (p) => {
      const n = netByLeader.get(p.leader_id);
      if (n) {
        if (!n.is_active) db.prepare("UPDATE networks SET is_active = 1, updated_at = datetime('now') WHERE id = ?").run(n.id);
        return n.id;
      }
      const info = db.prepare(`INSERT INTO networks (name, leader_person_id, gender, is_auto, notes) VALUES (?, ?, ?, 1, ?)`)
        .run(`${p.first_name} ${p.last_name} Network`, p.leader_id, p.gender, 'Formed automatically from Lifegroup membership.');
      created.push(`${p.first_name} ${p.last_name} Network`);
      return info.lastInsertRowid;
    };
    const setNet = db.prepare("UPDATE lifegroups SET network_id = ?, updated_at = datetime('now') WHERE id = ?");
    for (const g of groups) {
      if (g.network_manual) continue;
      const parent = g.leader_person_id ? parentOf.get(g.leader_person_id, g.leader_person_id) : null;
      let target = null;
      if (parent && parent.gender === g.gender) target = ensureNet(parent);
      if ((g.network_id || null) !== (target || null)) {
        // never silently steal a group from a hand-made network: only auto networks (or nothing) are replaced
        const curAuto = g.network_id ? db.prepare('SELECT is_auto FROM networks WHERE id = ?').get(g.network_id)?.is_auto : 1;
        if (curAuto || target) setNet.run(target, g.id);
      }
    }
    // Networks are flat: every Network has the same shape (network leader → cell leaders → their Lifegroups); no parent/sub-network linking.
    // auto networks with nothing under them go dormant (history kept)
    db.prepare(`UPDATE networks SET is_active = 0, updated_at = datetime('now') WHERE is_auto = 1 AND is_active = 1
        AND NOT EXISTS (SELECT 1 FROM lifegroups g WHERE g.network_id = networks.id AND g.is_active = 1)
        AND NOT EXISTS (SELECT 1 FROM networks c WHERE c.parent_network_id = networks.id AND c.is_active = 1)`).run();
    return created;
  });
  const created = run();
  for (const name of created) activity.log(db, user, 'network.auto', 'network', null, `Network formed automatically: ${name}`);
  return created;
}

module.exports = { syncNetworks };
