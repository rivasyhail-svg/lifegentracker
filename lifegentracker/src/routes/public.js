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

// GET /api/public/register/options — pick-lists + enabled flag for the form
router.get('/register/options', rateLimit('options', 120), wrap((req, res) => {
  res.json(reg.publicOptions(getDb()));
}));

// POST /api/public/register/check { full_name, email } → booleans only (pre-submit hint)
router.post('/register/check', rateLimit('check', SUBMIT_MAX * 4), wrap((req, res) => {
  const db = getDb();
  if (!reg.on(reg.settings(db).qr_registration_enabled)) throw new HttpError(403, 'Registration is currently unavailable.');
  const d = reg.duplicates(db, { email_normalized: normalizeEmail(req.body?.email), full_name_normalized: normalizeName(tidyName(req.body?.full_name)) });
  res.json({ email_taken: d.email_taken, name_match: reg.on(reg.settings(db).qr_name_duplicate_check) && d.name_match });
}));

// POST /api/public/register — the actual submission
router.post('/register', rateLimit('submit', SUBMIT_MAX), wrap((req, res) => {
  const body = req.body || {};
  if (body.website) { // honeypot field — real people never fill it
    return res.status(201).json({ ok: true, ref_code: 'LG-0000-000000', status: 'pending' });
  }
  const result = reg.submit(body, { ip: req.ip, userAgent: req.headers['user-agent'] });
  res.status(201).json({ ok: true, ...result });
}));

module.exports = router;
