'use strict';
/**
 * The ONE place that decides which address goes into every QR code and leader link.
 * Priority (first that exists wins):
 *   1. Settings → QR Registration → Public URL (qr_public_url)
 *   2. env LIFEGEN_PUBLIC_URL
 *   3. Vercel's production domain (VERCEL_PROJECT_PRODUCTION_URL, set automatically on Vercel) — so even a
 *      QR generated from a preview deployment points at the real site
 *   4. the host this request came through (local / self-hosted)
 * Result never has a trailing slash or a trailing /register.
 */
const { clean } = require('./util');

function tidy(u) {
  return String(u || '').trim().replace(/\/+$/, '').replace(/\/register$/, '').replace(/\/+$/, '');
}
function publicBase(db, req) {
  const custom = clean(db.prepare("SELECT value FROM settings WHERE key = 'qr_public_url'").get()?.value);
  if (custom) return tidy(/^https?:\/\//i.test(custom) ? custom : `https://${custom}`);
  if (clean(process.env.LIFEGEN_PUBLIC_URL)) return tidy(/^https?:\/\//i.test(process.env.LIFEGEN_PUBLIC_URL) ? process.env.LIFEGEN_PUBLIC_URL : `https://${process.env.LIFEGEN_PUBLIC_URL}`);
  if (clean(process.env.VERCEL_PROJECT_PRODUCTION_URL)) return `https://${tidy(process.env.VERCEL_PROJECT_PRODUCTION_URL)}`;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}
/** Which rule produced the address (shown to the admin so they can tell a temporary preview from the real site). */
function publicBaseSource(db) {
  if (clean(db.prepare("SELECT value FROM settings WHERE key = 'qr_public_url'").get()?.value)) return 'settings';
  if (clean(process.env.LIFEGEN_PUBLIC_URL)) return 'env';
  if (clean(process.env.VERCEL_PROJECT_PRODUCTION_URL)) return 'vercel';
  return 'request';
}
module.exports = { publicBase, publicBaseSource };
