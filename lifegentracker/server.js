'use strict';

/**
 * LifegenTracker — Lifegiver Church of Faith
 * Internal system for Lifegen / 3rd Service Sunday registration & attendance.
 *
 * Layout
 *   src/db/            SQLite connection + versioned SQL migrations
 *   src/middleware/    Authentication, sessions, role permissions
 *   src/services/      Shared business logic (statistics, demo data)
 *   src/routes/        One Express router per domain
 *   public/            Front-end single-page app (vanilla JS modules, no build step)
 *
 * Future modules (Cell Groups, LifeClass, Discipleship, Ministries) are added
 * as: a new migration  +  a new router  +  a new permission key  +  a new view.
 */

const path = require('path');
const express = require('express');
const { initDb, getDb, DB_FILE } = require('./src/db');
const { attachUser, AUTH_DISABLED } = require('./src/middleware/auth');
const backup = require('./src/services/backup');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

initDb();
if (AUTH_DISABLED) {
  console.warn('[auth] WARNING: LIFEGEN_AUTH=off — sign-in is disabled; everyone who can reach this server is an admin.');
}
// Automatic daily database snapshot (data/backups/, last 14 kept).
backup.scheduleAuto(getDb(), DB_FILE);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

// Basic security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  // The front-end is self-hosted vanilla JS; nothing external is allowed to run.
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'");
  // App code is small; never cache it so fixes reach every device immediately.
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// --- API ------------------------------------------------------------------
const api = express.Router();
// Lightweight request log for auth endpoints and rejected requests (helps diagnose sign-in issues).
api.use((req, res, next) => {
  res.on('finish', () => {
    if (req.path.startsWith('/auth') || res.statusCode >= 400) {
      const ua = String(req.headers['user-agent'] || '').slice(0, 40);
      const how = req.headers['x-session-token'] ? 'hdr' : req.headers.authorization ? 'bearer' : (req.headers.cookie || '').includes('lifegen_session') ? 'cookie' : 'none';
      console.log(`[api] ${req.method} ${req.path} -> ${res.statusCode} auth=${how} ip=${req.ip} proto=${req.headers['x-forwarded-proto'] || req.protocol} ua="${ua}"`);
    }
  });
  next();
});
// CSRF defence: browsers never add custom headers to cross-site form posts or
// top-level navigations, so every state-changing API call must carry one.
api.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['x-requested-with'] === 'LifegenTracker') return next();
  res.status(403).json({ error: 'Request rejected (missing X-Requested-With header).' });
});
api.use(attachUser);
api.get('/health', (req, res) => res.json({ ok: true, app: 'LifegenTracker', time: new Date().toISOString() }));
api.use('/public', require('./src/routes/public')); // QR self-registration form (no login, rate-limited)
api.use('/auth', require('./src/routes/auth'));
api.use('/people', require('./src/routes/people'));
api.use('/services', require('./src/routes/services'));
api.use('/lifegroups', require('./src/routes/lifegroups'));
api.use('/networks', require('./src/routes/networks'));
api.use('/dashboard', require('./src/routes/dashboard'));
api.use('/reports', require('./src/routes/reports'));
api.use('/registrations', require('./src/routes/registrations').router); // QR inbox (admin only)
api.use('/qr', require('./src/routes/registrations').qr);                     // QR code (admin only)
api.use('/', require('./src/routes/admin')); // /search, /users, /roles, /settings, /demo, /system
api.use((req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use('/api', api);

// --- Static front-end ------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, 'public');
// Public registration page opened by the printed QR code (no login).
app.get('/register', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(path.join(PUBLIC_DIR, 'register.html')); });
app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// --- Errors ----------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : err.type === 'entity.too.large' ? 413 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: status >= 500 ? 'Unexpected server error.' : err.message,
    details: err.details,
  });
});

module.exports = app;

// Start listening only when run directly (`node server.js`). Serverless hosts (Vercel) import the app instead.
if (require.main === module || process.env.LIFEGEN_FORCE_LISTEN === '1') {
  app.listen(PORT, HOST, () => {
    console.log(`LifegenTracker running at http://${HOST}:${PORT}`);
    console.log(`Database: ${DB_FILE}`);
  });
}
