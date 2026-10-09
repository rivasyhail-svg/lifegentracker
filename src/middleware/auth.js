'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');
const { HttpError } = require('../lib/util');

const COOKIE_NAME = 'lifegen_session';
const SESSION_DAYS = 30;

// ---------------------------------------------------------------------------
// Permissions — the single place that defines what each role may do.
// Add new permission keys here when future modules arrive.
// ---------------------------------------------------------------------------
const PERMISSIONS = {
  'dashboard:view':      ['admin', 'staff', 'viewer'],
  'reports:view':        ['admin', 'staff', 'viewer'],
  'people:view':         ['admin', 'staff', 'viewer'],
  'people:view_private': ['admin', 'staff'],           // contact details, address, birthday
  'people:write':        ['admin', 'staff'],
  'people:delete':       ['admin'],
  'attendance:view':     ['admin', 'staff', 'viewer'],
  'attendance:write':    ['admin', 'staff'],
  'lifegroups:view':     ['admin', 'staff', 'viewer'],
  'lifegroups:manage':   ['admin', 'staff'],
  'registrations:manage': ['admin'],                  // QR registration inbox + QR code
  'users:manage':        ['admin'],
  'settings:manage':     ['admin'],
};

function can(user, permission) {
  const roles = PERMISSIONS[permission];
  return Boolean(user && roles && roles.includes(user.role_id));
}

function permissionsFor(user) {
  return Object.keys(PERMISSIONS).filter((p) => can(user, p));
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt, no native deps)
// ---------------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, salt, hash] = stored.split('$');
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  if (pw.length > 128) throw new HttpError(400, 'Password is too long.');
}

// ---------------------------------------------------------------------------
// Sessions (opaque token in httpOnly cookie; only its hash is stored)
// ---------------------------------------------------------------------------
const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isSecure(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function createSession(req, res, user) {
  const db = getDb();
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  db.prepare('INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)').run(
    tokenHash(token), user.id, expires.toISOString(), String(req.headers['user-agent'] || '').slice(0, 200)
  );
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  // When served over HTTPS (e.g. behind a proxy or inside an embedded preview) the
  // cookie must be SameSite=None; Secure, otherwise browsers drop it in iframes.
  const secure = isSecure(req);
  const attrs = [
    `${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', secure ? 'SameSite=None' : 'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 86400}`,
  ];
  if (secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
  // The token is also returned to the client so it can be sent as a Bearer header
  // in environments where cookies are blocked (third-party iframe contexts).
  return token;
}

function tokenFromRequest(req) {
  const x = req.headers['x-session-token'];
  if (x) return String(x).trim();
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7).trim();
  return parseCookies(req.headers.cookie)[COOKIE_NAME] || null;
}

function destroySession(req, res) {
  const token = tokenFromRequest(req);
  if (token) getDb().prepare('DELETE FROM sessions WHERE id = ?').run(tokenHash(token));
  const secure = isSecure(req);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; ${secure ? 'SameSite=None; Secure' : 'SameSite=Lax'}; Max-Age=0`);
}

function destroyAllSessions(userId) {
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/**
 * Open-access mode (LIFEGEN_AUTH=off): every request runs as the first active
 * admin (created automatically as "admin" if none exists). Intended for demos
 * and trusted single-device use only — set LIFEGEN_AUTH=on for real use.
 */
const AUTH_DISABLED = String(process.env.LIFEGEN_AUTH || 'on').toLowerCase() === 'off';

function openAccessUser() {
  const db = getDb();
  let u = db.prepare("SELECT id, username, display_name, role_id FROM users WHERE role_id = 'admin' AND is_active = 1 ORDER BY id LIMIT 1").get();
  if (!u) {
    const info = db
      .prepare("INSERT INTO users (username, display_name, password_hash, role_id) VALUES ('admin', 'Admin', ?, 'admin')")
      .run(hashPassword(crypto.randomBytes(24).toString('base64url')));
    u = db.prepare('SELECT id, username, display_name, role_id FROM users WHERE id = ?').get(info.lastInsertRowid);
  }
  return u;
}

/** Attaches req.user when a valid session cookie is present. */
function attachUser(req, res, next) {
  req.user = null;
  if (AUTH_DISABLED) { req.user = openAccessUser(); return next(); }
  const token = tokenFromRequest(req);
  if (token) {
    const db = getDb();
    const hash = tokenHash(token);
    const row = db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.role_id, u.is_active, s.expires_at
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = ?`
      )
      .get(hash);
    const now = Date.now();
    if (row && row.is_active && new Date(row.expires_at).getTime() > now) {
      req.user = { id: row.id, username: row.username, display_name: row.display_name, role_id: row.role_id };
      // Sliding expiration: extend the session while it is in active use.
      if (new Date(row.expires_at).getTime() - now < (SESSION_DAYS / 2) * 86400000) {
        db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
          .run(new Date(now + SESSION_DAYS * 86400000).toISOString(), hash);
      }
    }
  }
  // Opportunistic cleanup of expired sessions (cheap, occasional)
  if (Math.random() < 0.01) getDb().prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in to continue.'));
  next();
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'Please sign in to continue.'));
    if (!can(req.user, permission)) return next(new HttpError(403, 'You do not have permission to do that.'));
    next();
  };
}

// ---------------------------------------------------------------------------
// Simple in-memory login throttle (per username + IP)
// ---------------------------------------------------------------------------
const attempts = new Map();
const MAX_ATTEMPTS = 6;
const WINDOW_MS = 15 * 60 * 1000;

function loginThrottle(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (rec && now - rec.first > WINDOW_MS) attempts.delete(key);
  const cur = attempts.get(key);
  if (cur && cur.count >= MAX_ATTEMPTS) {
    const mins = Math.ceil((WINDOW_MS - (now - cur.first)) / 60000);
    throw new HttpError(429, `Too many failed attempts. Try again in ${mins} minute(s).`);
  }
  return {
    fail() {
      const r = attempts.get(key) || { first: now, count: 0 };
      r.count += 1;
      attempts.set(key, r);
    },
    success() { attempts.delete(key); },
  };
}

module.exports = {
  AUTH_DISABLED, PERMISSIONS, can, permissionsFor,
  hashPassword, verifyPassword, validatePassword,
  createSession, destroySession, destroyAllSessions,
  attachUser, requireAuth, requirePermission, loginThrottle,
};
