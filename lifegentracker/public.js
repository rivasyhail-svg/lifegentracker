'use strict';
/**
 * Public (no-login) endpoints used only by the /register page that the printed QR opens.
 * Everything here is rate-limited per IP and returns no personal data about anyone else.
 */
const express = require('express');
const { getDb } = require('../db');
const { wrap, HttpError } = require('../lib/util');
const reg = require('../services/registrations');
const { normalizeEmail, normalizeName, tidyName } = require('../lib/normalize');
const prog = require('../services/lifegroup-progress');

const router = express.Router();

// --- tiny in-memory rate limiter (per process; good enough for one church server) ---
const WINDOW_MS = 15 * 60 * 1000;
// Many registrants share the church Wi-Fi (one public IP), so the submit limit is per 15 minutes and generous
// enough for a real Sunday crowd while still stopping scripted spam. Override with LIFEGEN_RATE_LIMIT_SUBMIT.
const SUBMIT_MAX = Math.max(1, Number(process.env.LIFEGEN_RATE_LIMIT_SUBMIT) || 40);
const buckets = new Map();
function rateLimit(name, max) {
  return (req, res, next) => {
    const key = `${name}|${req.ip}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.first > WINDOW_MS) { b = { first: now, count: 0 }; buckets.set(key, b); }
    b.count += 1;
    if (buckets.size > 5000) for (const [k, v] of buckets) if (now - v.first > WINDOW_MS) buckets.delete(k);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - b.count)));
    if (b.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((WINDOW_MS - (now - b.first)) / 1000)));
      return next(new HttpError(429, 'Too many attempts from this device. Please wait a few minutes and try again.'));
    }
    next();
  };
}
router._resetRateLimit = () => buckets.clear(); // tests only

router.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

// GET /api/public/register/options?k=TOKEN — pick-lists + open/closed state for the form.
// Also mints the signed device cookie (one registration per phone) and a form token (timing + origin proof).
router.get('/register/options', rateLimit('options', 300), wrap((req, res) => {
  const db = getDb();
  const deviceId = reg.guard.device(db, req, res);
  res.json(reg.publicOptions(db, { token: req.query.k, device_id: deviceId }));
}));

// POST /api/public/register/check { full_name, email } → booleans only (pre-submit hint)
router.post('/register/check', rateLimit('check', SUBMIT_MAX * 4), wrap((req, res) => {
  const db = getDb();
  const s = reg.settings(db);
  const st = reg.guard.status(db, s, { token: req.body?.qr_token });
  if (!st.open) throw new HttpError(403, st.message, { reason: st.reason });
  const d = reg.duplicates(db, { email_normalized: normalizeEmail(req.body?.email), full_name_normalized: normalizeName(tidyName(req.body?.full_name)) });
  res.json({ email_taken: d.email_taken, name_match: reg.on(s.qr_name_duplicate_check) && d.name_match });
}));

// POST /api/public/register — the actual submission
router.post('/register', rateLimit('submit', SUBMIT_MAX), wrap((req, res) => {
  const body = req.body || {};
  if (body.website) { // honeypot field — real people never fill it
    return res.status(201).json({ ok: true, ref_code: 'LG-0000-000000', status: 'pending' });
  }
  const db = getDb();
  const deviceId = reg.guard.device(db, req, res);
  const result = reg.submit(body, { ip: req.ip, userAgent: req.headers['user-agent'], deviceId, token: body.qr_token });
  res.status(201).json({ ok: true, ...result });
}));

// ---------------------------------------------------------------------------
// Leader report link: /lifegroup?t=TOKEN → these endpoints. The token is the group's private key;
// no login. Only first/last names of the group's own members are exposed — never contact details.
// ---------------------------------------------------------------------------
function groupOr404(token) {
  const g = prog.groupByToken(getDb(), token);
  if (!g) throw new HttpError(404, 'This Lifegroup link is not valid anymore. Please ask the Lifegen admin for a new link.');
  return g;
}
const pubMember = (m) => ({ id: m.id, name: `${m.first_name} ${m.last_name}`, tier: m.tier, role: m.role, meetings_attended: m.meetings_attended, devotions: m.devotions, last_meeting_attended: m.last_meeting_attended, last4: m.last4 });

router.get('/lifegroup/:token', rateLimit('lg-get', 240), wrap((req, res) => {
  const db = getDb();
  const g = groupOr404(req.params.token);
  const p = prog.progress(db, g.id, { weeks: 8 });
  const s = prog.settings(db);
  res.json({
    group: { id: g.id, name: g.name, gender: g.gender, leader_name: g.leader_display, schedule_day: g.schedule_day, schedule_time: g.schedule_time, venue: g.venue },
    church_name: s.church_name, today: prog.churchToday(db, s), target: p.target, solid: p.solid, new_members: p.new_members, total: p.total, is_solid: p.is_solid, percent: p.percent,
    streak: p.streak, held_last_4: p.held_last_4, met_this_week: p.met_this_week, last_meeting: p.last_meeting,
    members: p.members.map(pubMember), calendar: p.calendar,
    recent: prog.meetingsOf(db, g.id, 6).map((m) => ({ id: m.id, meeting_date: m.meeting_date, held: Boolean(m.held), present_count: m.present_count, no_meeting_reason: m.no_meeting_reason, present: m.present.map((x) => x.name), present_ids: m.present.map((x) => x.id), devotion_ids: m.devotion.map((x) => x.id) })),
    network: prog.leaderNetworkView(db, g.leader_person_id, { weeks: 4 }),
  });
}));

router.post('/lifegroup/:token/report', rateLimit('lg-report', 60), wrap((req, res) => {
  const db = getDb();
  const g = groupOr404(req.params.token);
  const out = prog.recordMeeting(db, g.id, req.body || {}, { via: 'leader_link', byName: g.leader_display || 'leader' });
  const p = prog.progress(db, g.id, { weeks: 8 });
  res.status(out.updated ? 200 : 201).json({ ok: true, ...out, solid: p.solid, new_members: p.new_members, total: p.total, target: p.target, is_solid: p.is_solid, streak: p.streak, members: p.members.map(pubMember), calendar: p.calendar });
}));

router.put('/lifegroup/:token/members/:personId/tier', rateLimit('lg-tier', 120), wrap((req, res) => {
  const db = getDb();
  const g = groupOr404(req.params.token);
  const pid = Number(req.params.personId);
  prog.setTier(db, g.id, pid, String(req.body?.tier || ''), { via: 'leader_link', byName: g.leader_display || 'leader' });
  const p = prog.progress(db, g.id, { weeks: 8 });
  res.json({ ok: true, solid: p.solid, new_members: p.new_members, total: p.total, target: p.target, is_solid: p.is_solid, members: p.members.map(pubMember) });
}));

// Network leader (via their own group's link) tags a member of one of the Lifegroups in their network as Solid / other.
router.put('/lifegroup/:token/groups/:groupId/members/:personId/tier', rateLimit('lg-tier', 120), wrap((req, res) => {
  const db = getDb();
  const g = groupOr404(req.params.token);
  const gid = Number(req.params.groupId), pid = Number(req.params.personId);
  const ok = g.leader_person_id && db.prepare('SELECT 1 FROM lifegroups lg JOIN networks n ON n.id = lg.network_id WHERE lg.id = ? AND n.leader_person_id = ? AND n.is_active = 1').get(gid, g.leader_person_id);
  if (!ok) throw new HttpError(403, 'That Lifegroup is not in your network.');
  prog.setTier(db, gid, pid, String(req.body?.tier || ''), { via: 'leader_link', byName: `${g.leader_display || 'network leader'} (network leader)` });
  res.json({ ok: true, network: prog.leaderNetworkView(db, g.leader_person_id, { weeks: 4 }) });
}));

module.exports = router;
