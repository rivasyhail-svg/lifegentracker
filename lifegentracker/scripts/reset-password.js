#!/usr/bin/env node
'use strict';
/**
 * Reset a user's password from the command line (for when an admin is locked out).
 *   node scripts/reset-password.js <username> <new-password>
 */
const { initDb } = require('../src/db');
const { hashPassword, validatePassword, destroyAllSessions } = require('../src/middleware/auth');

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage: node scripts/reset-password.js <username> <new-password>');
  process.exit(1);
}
const db = initDb();
const user = db.prepare('SELECT id, username FROM users WHERE username = ?').get(username);
if (!user) { console.error(`User "${username}" not found.`); process.exit(1); }
try { validatePassword(password); } catch (e) { console.error(e.message); process.exit(1); }
db.prepare("UPDATE users SET password_hash = ?, is_active = 1, updated_at = datetime('now') WHERE id = ?")
  .run(hashPassword(password), user.id);
destroyAllSessions(user.id);
console.log(`Password for "${user.username}" has been reset. Existing sessions were signed out.`);
