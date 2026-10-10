'use strict';
/**
 * Admin side of QR self-registration: the inbox (list/view/edit/approve/reject/delete)
 * and the QR code itself. Every route requires the `registrations:manage` permission (Admin only).
 */
const express = require('express');
const QRCode = require('qrcode');
const { getDb } = require('../db');
const { clean, wrap, intId, HttpError } = require('../lib/util');
const { requirePermission } = require('../middleware/auth');
const reg = require('../services/registrations');
const activity = require('../services/activity');

const router = express.Router();   // mounted at /api/registrations
const qr = express.Router();       // mounted at /api/qr
router.use(requirePermission('registrations:manage'));
qr.use(requirePermission('registrations:manage'));

/** Public registration URL: Settings override, else the host this request came through. Rotating mode appends ?k=TOKEN. */
function registrationUrl(req) {
  const db = getDb();
  const s = reg.settings(db);
  const custom = clean(s.qr_public_url);
  let url;
  if (custom) url = custom.replace(/\/+$/, '').replace(/\/register$/, '') + '/register';
  else { const proto = req.headers['x-forwarded-proto'] || req.protocol; url = `${proto}://${req.get('host')}/register`; }
  if (s.qr_mode === 'rotating') url += `?k=${reg.guard.rotation(db, s).token}`;
  return url;
}

// --- inbox ---
router.get('/counts', wrap((req, res) => res.json(reg.counts(getDb()))));

router.get('/', wrap((req, res) => {
  const db = getDb();
  res.json({ items: reg.list(db, { status: req.query.status || 'pending', q: req.query.q || '' }), counts: reg.counts(db) });
}));

// --- anti-fake controls: blocklist + guard state ---
router.get('/blocks', wrap((req, res) => res.json({ items: reg.listBlocks(getDb()) })));
router.post('/blocks', wrap((req, res) => {
  const b = req.body || {};
  res.status(201).json({ items: reg.addBlock(getDb(), req.user, String(b.kind || ''), b.value, b.reason) });
}));
router.delete('/blocks/:id', wrap((req, res) => { reg.removeBlock(getDb(), req.user, intId(req.params.id)); res.json({ ok: true }); }));
router.get('/guard', wrap((req, res) => res.json(reg.guardState(getDb()))));
router.post('/guard/resume', wrap((req, res) => res.json(reg.resume(getDb(), req.user))));
router.post('/guard/rotate', wrap((req, res) => res.json(reg.rotate(getDb(), req.user))));
router.post('/guard/open-now', wrap((req, res) => res.json(reg.openNow(getDb(), req.user, req.body?.hours))));

router.get('/:id', wrap((req, res) => {
  const db = getDb();
  const r = reg.get(db, intId(req.params.id));
  if (!r) throw new HttpError(404, 'Registration not found.');
  res.json({ ...r, review: reg.reviewContext(db, r) });
}));

router.put('/:id', wrap((req, res) => {
  res.json(reg.update(getDb(), intId(req.params.id), req.user, req.body || {}));
}));

// POST /api/registrations/:id/approve  { mode: 'create' | 'link', person_id?, status? }
router.post('/:id/approve', wrap((req, res) => {
  const db = getDb();
  const id = intId(req.params.id);
  const body = req.body || {};
  const status = ['first_timer', 'returning', 'regular'].includes(body.status) ? body.status : 'first_timer';
  const personId = reg.approve(db, id, req.user, { mode: body.mode === 'link' ? 'link' : 'create', person_id: body.person_id, status });
  res.json({ ...reg.get(db, id), person_id: personId, placed: reg.approve.lastPlacement || null });
}));

router.post('/:id/reject', wrap((req, res) => {
  const b = req.body || {};
  res.json(reg.reject(getDb(), intId(req.params.id), req.user, b.note, { email: Boolean(b.block_email), device: Boolean(b.block_device), ip: Boolean(b.block_ip) }));
}));

// POST /api/registrations/bulk-reject { ids: [], note?, block_email?, block_device? }
router.post('/bulk-reject', wrap((req, res) => {
  const b = req.body || {};
  const ids = Array.isArray(b.ids) ? b.ids.slice(0, 500) : [];
  if (!ids.length) throw new HttpError(400, 'Select at least one registration.');
  res.json(reg.bulkReject(getDb(), ids, req.user, b.note, { email: Boolean(b.block_email), device: Boolean(b.block_device), ip: Boolean(b.block_ip) }));
}));


router.delete('/:id', wrap((req, res) => {
  reg.remove(getDb(), intId(req.params.id), req.user);
  res.json({ ok: true });
}));

// --- QR code (the QR holds ONLY the public URL — never personal data) ---
qr.get('/registration', wrap(async (req, res) => {
  const url = registrationUrl(req);
  const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#111111', light: '#ffffff' } });
  const db = getDb();
  const s = reg.settings(db);
  res.setHeader('Cache-Control', 'no-store');
  const rot = s.qr_mode === 'rotating' ? reg.guard.rotation(db, s) : null;
  res.json({ url, svg, enabled: reg.on(s.qr_registration_enabled), custom_url: Boolean(clean(s.qr_public_url)), mode: rot ? 'rotating' : 'reusable', valid_through: rot ? rot.valid_through : null, token: rot ? rot.token : null });
}));

qr.get('/registration.png', wrap(async (req, res) => {
  const url = registrationUrl(req);
  const size = Math.min(Math.max(Number(req.query.size) || 1024, 256), 2048);
  const buf = await QRCode.toBuffer(url, { type: 'png', errorCorrectionLevel: 'M', margin: 2, width: size });
  activity.log(getDb(), req.user, 'qr.download', 'settings', null, `Downloaded registration QR (${size}px)`);
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', 'attachment; filename="lifegen-registration-qr.png"');
  res.setHeader('Cache-Control', 'no-store');
  res.send(buf);
}));

module.exports = { router, qr };
