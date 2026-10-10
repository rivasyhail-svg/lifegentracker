'use strict';
/**
 * Auto networks — independent roots only.
 *
 * Structure (church rule, non-negotiable):
 *   Network leader (root)  →  cell leaders (members of the network leader's own Lifegroup)  →  their Lifegroups
 * A Network leader is never under another Network leader; there are no sub-networks.
 *
 * Rules applied to every active Lifegroup that is not pinned by hand (lifegroups.network_manual = 0):
 *   1. Led by someone who leads an active Network  → that person's OWN Network (never anyone else's).
 *   2. Otherwise follow the membership chain upward (leader is a member of group X led by P, P is a member of
 *      group Y led by Q, …) until the top: the first person who leads a Network, or who is in no group.
 *      That top person is the root; the group belongs to the root's Network (created automatically when missing).
 *   3. No chain → no network yet.
 * Admins can still pin a group to a network by hand; pins are never changed here.
 */
const activity = require('./activity');

const MAX_HOPS = 20;

function syncNetworks(db, user = null) {
  const run = db.transaction(() => {
    const groups = db.prepare(`SELECT g.id, g.name, g.gender, g.leader_person_id, g.network_id, g.network_manual
        FROM lifegroups g WHERE g.is_active = 1`).all();
    const groupOf = db.prepare(`SELECT pg.id AS group_id, pg.gender, pg.leader_person_id AS leader_id, lp.first_name, lp.last_name, lp.sex
        FROM lifegroup_memberships m JOIN lifegroups pg ON pg.id = m.lifegroup_id LEFT JOIN people lp ON lp.id = pg.leader_person_id
       WHERE m.person_id = ? AND m.left_at IS NULL AND pg.is_active = 1 AND pg.leader_person_id IS NOT NULL AND pg.leader_person_id <> ? LIMIT 1`);
    const netByLeader = db.prepare('SELECT id, is_active, gender FROM networks WHERE leader_person_id = ? ORDER BY is_active DESC, is_auto ASC, id LIMIT 1');
    const personRow = db.prepare('SELECT id, first_name, last_name, sex FROM people WHERE id = ?');
    const created = [];
    const ensureNet = (leaderId, gender) => {
      const n = netByLeader.get(leaderId);
      if (n) {
        if (!n.is_active) db.prepare("UPDATE networks SET is_active = 1, updated_at = datetime('now') WHERE id = ?").run(n.id);
        return n.id;
      }
      const p = personRow.get(leaderId);
      if (!p) return null;
      const name = `${p.first_name} ${p.last_name} Network`;
      const info = db.prepare('INSERT INTO networks (name, leader_person_id, gender, is_auto, notes) VALUES (?, ?, ?, 1, ?)')
        .run(name, leaderId, gender, 'Formed automatically from Lifegroup membership. Independent network.');
      created.push(name);
      return info.lastInsertRowid;
    };
    /** Walk up the membership chain from a person to the root leader. Returns { leaderId, gender } or null. */
    const rootOf = (personId, gender) => {
      let cur = personId; let hops = 0; const seen = new Set([personId]);
      while (hops++ < MAX_HOPS) {
        const n = netByLeader.get(cur);
        if (n && n.is_active) return cur === personId ? null : { leaderId: cur, gender: n.gender }; // reached a Network leader (root)
        const up = groupOf.get(cur, cur);
        if (!up || up.gender !== gender) return cur === personId ? null : { leaderId: cur, gender }; // top of the chain
        if (seen.has(up.leader_id)) return null; // loop in data — leave the group alone
        seen.add(up.leader_id); cur = up.leader_id;
      }
      return null;
    };
    const setNet = db.prepare("UPDATE lifegroups SET network_id = ?, updated_at = datetime('now') WHERE id = ?");
    const isAuto = db.prepare('SELECT is_auto FROM networks WHERE id = ?');
    for (const g of groups) {
      if (!g.leader_person_id) continue;
      let target = null;
      const own = netByLeader.get(g.leader_person_id);
      if (own && own.is_active) {
        target = own.id; // rule 1: a Network leader's Lifegroup is the root of their own Network — never under another leader
      } else if (g.network_manual) {
        continue; // pinned by an admin
      } else {
        const root = rootOf(g.leader_person_id, g.gender);
        if (root) target = ensureNet(root.leaderId, root.gender);
      }
      if ((g.network_id || null) !== (target || null)) {
        // never silently steal a group from a hand-made network: only auto networks (or nothing) are replaced —
        // except for a Network leader's own group, which always lives in their own Network.
        const curAuto = g.network_id ? isAuto.get(g.network_id)?.is_auto : 1;
        if (curAuto || target) setNet.run(target, g.id);
      }
    }
    // auto networks with nothing under them go dormant (history kept)
    db.prepare(`UPDATE networks SET is_active = 0, updated_at = datetime('now') WHERE is_auto = 1 AND is_active = 1
        AND NOT EXISTS (SELECT 1 FROM lifegroups g WHERE g.network_id = networks.id AND g.is_active = 1
                        AND (g.leader_person_id IS NULL OR g.leader_person_id <> networks.leader_person_id))`).run();
    return created;
  });
  const created = run();
  for (const name of created) activity.log(db, user, 'network.auto', 'network', null, `Network formed automatically: ${name}`);
  return created;
}

module.exports = { syncNetworks };
