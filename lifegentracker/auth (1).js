'use strict';

const express = require('express');
const { getDb } = require('../db');
const { clean, HttpError, wrap } = require('../lib/util');
const auth = require('../middleware/auth');

const router = express.Router();

function settingsMap(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

function publicUser(user) {
  return { ...user, permissions: auth.permissionsFor(user) };
}

// GET /api/auth/status — used by the front-end on boot
router.get(
  '/status',
  wrap((req, res) => {
    const db = getDb();
    const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const demo = db.prepare('SELECT COUNT(*) AS n FROM people WHERE is_demo = 1').get().n;
    res.json({
      needs_setup: !auth.AUTH_DISABLED && userCount === 0,
      auth_disabled: auth.AUTH_DISABLED,
      user: req.user ? publicUser(req.user) : null,
      settings: settingsMap(db),
      demo_loaded: demo > 0,
    });
  })
);

// POST /api/auth/setup — create the very first admin account (only when no users exist)
router.post(
  '/setup',
  wrap((req, res) => {
    const db = getDb();
    if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) {
      throw new HttpError(403, 'Setup has already been completed.');
    }
    const body = req.body || {};
    const username = clean(body.username);
    const display_name = clean(body.display_name);
    const password = body.password;
    if (!username || !/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
      throw new HttpError(400, 'Username must be 3–32 characters (letters, numbers, . _ -).');
    }
    if (!display_name) throw new HttpError(400, 'Display name is required.');
    auth.validatePassword(password);

    const info = db
      .prepare(`INSERT INTO users (username, display_name, password_hash, role_id) VALUES (?, ?, ?, 'admin')`)
      .run(username, display_name, auth.hashPassword(password));

    const churchName = clean(body.church_name);
    if (churchName) {
      db.prepare("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = 'church_name'").run(churchName);
    }

    const user = db.prepare('SELECT id, username, display_name, role_id FROM users WHERE id = ?').get(info.lastInsertRowid);
    const token = auth.createSession(req, res, user);
    res.status(201).json({ user: publicUser(user), token });
  })
);

// POST /api/auth/login
router.post(
  '/login',
  wrap((req, res) => {
    const db = getDb();
    const username = clean(req.body?.username);
    const password = req.body?.password;
    if (!username || !password) throw new HttpError(400, 'Username and password are required.');

    const throttle = auth.loginThrottle(`${req.ip}|${username.toLowerCase()}`);
    const user = db
      .prepare('SELECT id, username, display_name, role_id, password_hash, is_active FROM users WHERE lower(username) = lower(?)')
      .get(username);

    if (!user || !auth.verifyPassword(password, user.password_hash)) {
      throttle.fail();
      throw new HttpError(401, 'Incorrect username or password.');
    }
    if (!user.is_active) throw new HttpError(403, 'This account has been deactivated.');

    throttle.success();
    const safe = { id: user.id, username: user.username, display_name: user.display_name, role_id: user.role_id };
    const token = auth.createSession(req, res, safe);
    res.json({ user: publicUser(safe), token });
  })
);

// POST /api/auth/logout
router.post(
  '/logout',
  wrap((req, res) => {
    auth.destroySession(req, res);
    res.status(204).end();
  })
);

// GET /api/auth/me
router.get('/me', auth.requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

// POST /api/auth/change-password  { current_password, new_password }
router.post(
  '/change-password',
  auth.requireAuth,
  wrap((req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!auth.verifyPassword(req.body?.current_password || '', row.password_hash)) {
      throw new HttpError(400, 'Current password is incorrect.');
    }
    auth.validatePassword(req.body?.new_password);
    db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
      .run(auth.hashPassword(req.body.new_password), req.user.id);
    res.json({ ok: true });
  })
);

module.exports = router;
