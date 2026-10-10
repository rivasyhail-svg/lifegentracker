'use strict';
/**
 * "Is this Gmail real?" — the strongest checks possible WITHOUT sending mail or calling an outside service:
 *   1. Gmail address rules (what Google actually allows when creating an account):
 *      6–30 characters, letters / digits / dots only, no leading, trailing or doubled dots; "+tag" allowed.
 *   2. The domain must be able to receive mail: an MX record (or at least an A record) must exist. Results are
 *      cached in memory; DNS time-outs / network trouble fail OPEN so a real person is never blocked by a hiccup.
 * True proof of ownership would need a confirmation email — this app deliberately has no mail sending.
 */
const dns = require('dns').promises;

const GMAIL = new Set(['gmail.com', 'googlemail.com']);
// Big providers never need a DNS round-trip.
const KNOWN_MAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.com.ph', 'ymail.com', 'rocketmail.com', 'outlook.com', 'outlook.ph', 'hotmail.com', 'hotmail.ph', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'protonmail.com', 'proton.me', 'aol.com', 'zoho.com', 'yandex.com', 'mail.com', 'gmx.com', 'example.com', 'example.org', 'example.net', 'localhost']);

/** Returns a user-facing problem string, or null when the address passes Gmail's own rules. Non-Gmail → null. */
function gmailProblem(rawEmail) {
  const s = String(rawEmail || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at <= 0) return null;
  const domain = s.slice(at + 1);
  if (!GMAIL.has(domain)) return null;
  let local = s.slice(0, at);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus); // "+tag" is allowed by Gmail; the rules apply to the part before it
  if (!/^[a-z0-9.]+$/.test(local)) return 'A Gmail address can only have letters, numbers and dots before the @.';
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return 'A Gmail address cannot start or end with a dot, or have two dots in a row.';
  const len = local.replace(/\./g, '').length;
  if (len < 6) return 'That does not look like a real Gmail — Gmail usernames have at least 6 letters or numbers.';
  if (len > 30) return 'That does not look like a real Gmail — Gmail usernames have at most 30 letters or numbers.';
  return null;
}

const cache = new Map(); // domain → { ok, until }
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), ms))]);
const NO_SUCH = new Set(['ENOTFOUND', 'ENODATA', 'ESERVFAIL', 'NXDOMAIN']); // "the name/record does not exist" (not network trouble)
const enabled = () => !['off', '0', 'false'].includes(String(process.env.LIFEGEN_EMAIL_DNS_CHECK || 'on').toLowerCase());

/** true = the domain can receive mail (or we could not tell). false = DNS says the domain / its mail records do not exist. */
async function domainAcceptsMail(domain) {
  domain = String(domain || '').toLowerCase();
  if (!enabled() || !domain || KNOWN_MAIL_DOMAINS.has(domain)) return true;
  const hit = cache.get(domain);
  if (hit && hit.until > Date.now()) return hit.ok;
  let ok = true;
  try {
    const mx = await withTimeout(dns.resolveMx(domain), 2500);
    ok = Array.isArray(mx) && mx.length > 0;
    if (!ok) ok = await hasAddress(domain);
  } catch (e) {
    ok = NO_SUCH.has(e && e.code) ? await hasAddress(domain) : true; // network trouble → fail open
  }
  cache.set(domain, { ok, until: Date.now() + (ok ? 6 : 1) * 60 * 60 * 1000 });
  return ok;
}
async function hasAddress(domain) {
  try { const a = await withTimeout(dns.resolve4(domain), 2500); return a.length > 0; } catch (e) { return !NO_SUCH.has(e && e.code); }
}
const DOMAIN_MSG = 'This email domain does not exist or cannot receive mail. Please check your email address.';

/** Throws nothing; returns a problem string or null. Use after the sync validation passed. */
async function emailDomainProblem(email) {
  const domain = String(email || '').split('@')[1];
  if (!domain) return null;
  return (await domainAcceptsMail(domain)) ? null : DOMAIN_MSG;
}

module.exports = { gmailProblem, domainAcceptsMail, emailDomainProblem, DOMAIN_MSG, _cache: cache };
