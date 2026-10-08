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

/** Public registration URL: Settings override, else the host this request came through. */
function registrationUrl(req) {
  const custom = clean(reg.settings(getDb()).qr_public_url);
  if (custom) return custom.replace(/\/+$/, '').replace(/\/register$/, '') + '/register';
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.get('host')}/register`;
}

// --- inbox ---
router.get('/counts', wrap((req, res) => res.json(reg.counts(getDb()))));

router.get('/', wrap((req, res) => {
  const db = getDb();
  res.json({ items: reg.list(db, { status: req.query.status || 'pending', q: req.query.q || '' }), counts: reg.counts(db) });
}));

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
  res.json({ ...reg.get(db, id), person_id: personId });
}));

router.post('/:id/reject', wrap((req, res) => {
  res.json(reg.reject(getDb(), intId(req.params.id), req.user, req.body?.note));
}));

router.delete('/:id', wrap((req, res) => {
  reg.remove(getDb(), intId(req.params.id), req.user);
  res.json({ ok: true });
}));

// --- QR code (the QR holds ONLY the public URL — never personal data) ---
qr.get('/registration', wrap(async (req, res) => {
  const url = registrationUrl(req);
  const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#111111', light: '#ffffff' } });
  const s = reg.settings(getDb());
  res.setHeader('Cache-Control', 'no-store');
  res.json({ url, svg, enabled: reg.on(s.qr_registration_enabled), custom_url: Boolean(clean(s.qr_public_url)) });
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
