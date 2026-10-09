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

// Open the database. On a hosted setup (Vercel + Supabase/Turso) a wrong connection string or a paused
// database must NOT crash the whole function — the API answers 503 with the real reason instead, and
// /api/health shows it, so the problem can be fixed from the browser without digging through logs.
let dbInitError = null;
function tryInitDb() {
  try { initDb(); dbInitError = null; } catch (e) { dbInitError = e; console.error('[db] startup failed:', e.message); }
  return !dbInitError;
}
tryInitDb();
if (AUTH_DISABLED) {
  console.warn('[auth] WARNING: LIFEGEN_AUTH=off — sign-in is disabled; everyone who can reach this server is an admin.');
}
// Automatic daily database snapshot (data/backups/, last 14 kept).
if (!dbInitError) backup.scheduleAuto(getDb(), DB_FILE);

/** Plain-language hint for the most common hosted-database mistakes. */
function dbHint(err) {
  const m = String(err && err.message || '');
  if (/password authentication failed/i.test(m)) return 'Wrong database password in LIFEGEN_DB_URL. Replace [YOUR-PASSWORD] (including the brackets) with the real Supabase database password, save, then Redeploy.';
  if (/Tenant or user not found/i.test(m)) return 'The user part of LIFEGEN_DB_URL is wrong. Copy the URI again from Supabase → Connect → Session pooler (it looks like postgres.<project-ref>).';
  if (/ENETUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED/i.test(m)) return 'Cannot reach the database host. Use the Supabase “Session pooler” URI (…pooler.supabase.com:5432), not “Direct connection”. If the project is paused, press “Restore project” in Supabase.';
  if (/EROFS|SQLITE_CANTOPEN|read-only file system|LIFEGEN_DB_URL is not set/i.test(m)) return 'LIFEGEN_DB_URL is missing on this host (no disk for a local file). Add it in Vercel → Settings → Environment Variables, then Redeploy.';
  if (/Cannot find module/i.test(m)) return 'A dependency is missing from the deployment; make sure package.json is in the root directory and redeploy without build cache.';
  if (/timed out/i.test(m)) return 'The database did not answer in time. If it is a free Supabase project it may be paused — open the Supabase dashboard and restore it.';
  return 'Check LIFEGEN_DB_URL in the host’s environment variables and redeploy.';
}

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
api.get('/health', (req, res) => {
  if (dbInitError && !tryInitDb()) {
    return res.status(503).json({ ok: false, app: 'LifegenTracker', time: new Date().toISOString(), db: 'error', db_error: dbInitError.message, hint: dbHint(dbInitError) });
  }
  res.json({ ok: true, app: 'LifegenTracker', time: new Date().toISOString(), db: 'ok' });
});
// Every other API call needs the database; answer clearly instead of crashing while it is unavailable.
api.use((req, res, next) => {
  if (!dbInitError || tryInitDb()) return next();
  res.status(503).json({ error: 'Database connection failed: ' + dbInitError.message, hint: dbHint(dbInitError), db: 'error' });
});
api.use(attachUser);
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
