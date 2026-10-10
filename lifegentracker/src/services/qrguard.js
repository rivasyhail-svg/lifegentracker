'use strict';
/**
 * QR anti-fake guard — everything that decides whether a scan may register right now and
 * whether a submission looks like a real person. No external services: only server-side rules,
 * a per-device signed cookie, a weekly rotating QR token, an admin blocklist and volume caps.
 */
const crypto = require('crypto');
const { HttpError } = require('../lib/util');
const activity = require('./activity');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MIN_FORM_SECONDS = process.env.LIFEGEN_MIN_FORM_SECONDS !== undefined ? Math.max(0, Number(process.env.LIFEGEN_MIN_FORM_SECONDS) || 0) : 6;
const FORM_TOKEN_MAX_AGE = 4 * 3600; // seconds — reload the page after this

// ---------------------------------------------------------------------------
// Secret (generated once, stored in settings — never in code or env)
// ---------------------------------------------------------------------------
function secret(db) {
  let row = db.prepare("SELECT value FROM settings WHERE key = 'qr_secret'").get();
  if (!row || !row.value) {
    const fresh = crypto.randomBytes(32).toString('hex');
    if (!row) db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('qr_secret', ?)").run(fresh);
    else db.prepare("UPDATE settings SET value = ? WHERE key = 'qr_secret' AND (value = '' OR value IS NULL)").run(fresh);
    row = db.prepare("SELECT value FROM settings WHERE key = 'qr_secret'").get();
  }
  return row.value;
}
const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// ---------------------------------------------------------------------------
// Church-time helpers (Intl, so Vercel/UTC servers still think in Asia/Manila)
// ---------------------------------------------------------------------------
function churchNow(tz, date = new Date()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit' }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit' }).formatToParts(date);
  }
  const g = (t) => parts.find((p) => p.type === t)?.value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday'));
  const hour = Number(g('hour')) % 24, minute = Number(g('minute'));
  return { date: `${g('year')}-${g('month')}-${g('day')}`, dow, minutes: hour * 60 + minute };
}
const toMin = (hhmm, dflt) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim()); return m ? Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2])) : dflt; };
function fmtTime(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
/** Monday (YYYY-MM-DD) of the church-time week containing `date` — the key of the rotating token. */
function weekKey(tz, date = new Date()) {
  const n = churchNow(tz, date);
  const d = new Date(`${n.date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((n.dow + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function weekSunday(mondayKey) {
  const d = new Date(`${mondayKey}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 6); return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Rotating QR token: 8 unambiguous chars derived from secret + epoch + week — the QR still holds only a URL.
// ---------------------------------------------------------------------------
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function tokenFor(db, s, key) {
  const h = crypto.createHmac('sha256', secret(db)).update(`rot:${s.qr_rotation_epoch || '0'}:${key}`).digest();
  let out = '';
  for (let i = 0; i < 8; i += 1) out += ALPHABET[h[i] % ALPHABET.length];
  return out;
}
/** Current token + the Sunday it is valid through (rotating mode). */
function rotation(db, s) {
  const key = weekKey(s.qr_timezone);
  return { token: tokenFor(db, s, key), week_start: key, valid_through: weekSunday(key) };
}
function tokenOk(db, s, token) {
  if (s.qr_mode !== 'rotating') return true;
  const t = String(token || '').trim().toUpperCase();
  return t.length === 8 && safeEq(t, tokenFor(db, s, weekKey(s.qr_timezone)));
}

// ---------------------------------------------------------------------------
// Open / closed decision
// ---------------------------------------------------------------------------
function windowDays(s) {
  const days = [...new Set(String(s.qr_window_days ?? '0').split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
  return days.length ? days : [0];
}
function windowInfo(s) {
  const start = toMin(s.qr_window_start, 12 * 60), end = toMin(s.qr_window_end, 17 * 60);
  const days = windowDays(s);
  const dayLabel = days.length === 7 ? 'every day' : days.map((d) => DAY_NAMES[d]).join(' & ');
  return { mode: s.qr_window === 'always' ? 'always' : 'sunday', start, end, days, label: `${dayLabel}, ${fmtTime(start)} – ${fmtTime(end)}` };
}
/**
 * Returns { open: true } or { open: false, reason: 'disabled'|'paused'|'window'|'expired', message, ...extras }.
 * Order matters: a switched-off form beats everything; an expired QR is reported before the window so an old poster
 * never pretends it will work later.
 */
function status(db, s, { token } = {}) {
  const on = (v) => v !== '0' && v !== 'false' && v !== '';
  const win = windowInfo(s);
  const base = { window: win.mode, window_label: win.label, mode: s.qr_mode === 'rotating' ? 'rotating' : 'reusable' };
  if (!on(s.qr_registration_enabled) || (s.module_registrations !== undefined && !on(s.module_registrations))) return { ...base, open: false, reason: 'disabled', message: 'Registration is currently unavailable. Please ask the Lifegen team.' };
  if (!tokenOk(db, s, token)) return { ...base, open: false, reason: 'expired', message: 'This QR code has expired. Please scan the latest QR code posted at the venue.' };
  if (s.qr_auto_paused_at) return { ...base, open: false, reason: 'paused', message: 'Registration is paused for a moment because of unusually high volume. Please try again in a few minutes or approach an usher.' };
  const override = s.qr_open_until && !Number.isNaN(Date.parse(s.qr_open_until)) && Date.parse(s.qr_open_until) > Date.now();
  if (win.mode === 'sunday' && !override) {
    const now = churchNow(s.qr_timezone);
    const openNow = win.days.includes(now.dow) && now.minutes >= win.start && now.minutes < win.end;
    if (!openNow) {
      return { ...base, open: false, reason: 'window', message: `Registration is open ${win.days.length === 7 ? '' : 'every '}${win.label} (Philippine time). Please scan the QR again during Lifegen service.`, today: DAY_NAMES[now.dow] };
    }
  }
  return { ...base, open: true, override: Boolean(override) };
}

// ---------------------------------------------------------------------------
// Device cookie (lg_dev = id.signature) — identifies the phone, holds no personal data
// ---------------------------------------------------------------------------
const DEVICE_COOKIE = 'lg_dev';
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function signDevice(db, id) { return `${id}.${hmac(secret(db), `dev:${id}`).slice(0, 20)}`; }
function readDevice(db, raw) {
  const m = /^([a-f0-9]{24})\.([a-f0-9]{20})$/.exec(String(raw || ''));
  if (!m) return null;
  return safeEq(signDevice(db, m[1]), raw) ? m[1] : null;
}
/** Reads (or mints) the device id for this request and (re)sets the cookie. Returns the bare id. */
function device(db, req, res) {
  const incoming = parseCookies(req.headers.cookie)[DEVICE_COOKIE] || req.headers['x-lifegen-device'];
  let id = readDevice(db, incoming);
  if (!id) id = crypto.randomBytes(12).toString('hex');
  const signed = signDevice(db, id);
  const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  const attrs = [`${DEVICE_COOKIE}=${signed}`, 'Path=/', 'HttpOnly', secure ? 'SameSite=None' : 'SameSite=Lax', `Max-Age=${400 * 86400}`];
  if (secure) attrs.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, attrs.join('; ')) : attrs.join('; '));
  res.setHeader('X-Lifegen-Device', signed); // fallback for browsers that drop third-party cookies
  return id;
}

// ---------------------------------------------------------------------------
// Form token — proves the form was loaded from the server and measures how long it was open
// ---------------------------------------------------------------------------
function formToken(db) {
  const ts = Math.floor(Date.now() / 1000);
  return `${ts}.${hmac(secret(db), `form:${ts}`).slice(0, 20)}`;
}
/** Returns seconds the form was open, or throws a friendly 400. */
function checkFormToken(db, raw) {
  const m = /^(\d{9,11})\.([a-f0-9]{20})$/.exec(String(raw || ''));
  if (!m || !safeEq(`${m[1]}.${hmac(secret(db), `form:${m[1]}`).slice(0, 20)}`, raw)) {
    throw new HttpError(400, 'Your form session has expired. Please reload the page and try again.', { form: 'expired' });
  }
  const age = Math.floor(Date.now() / 1000) - Number(m[1]);
  if (age > FORM_TOKEN_MAX_AGE) throw new HttpError(400, 'Your form session has expired. Please reload the page and try again.', { form: 'expired' });
  if (age < MIN_FORM_SECONDS) throw new HttpError(400, 'That was too fast — please review your answers and submit again.', { form: 'too_fast' });
  return Math.max(0, age);
}

// ---------------------------------------------------------------------------
// Real-person heuristics (public form only; admin Edit keeps the relaxed rules)
// ---------------------------------------------------------------------------
const TROLL_WORDS = new Set(['test', 'testing', 'tester', 'asdf', 'asdfg', 'qwerty', 'qwe', 'abc', 'abcd', 'xyz', 'fake', 'sample', 'lorem', 'ipsum', 'none', 'null', 'undefined',
  'admin', 'anonymous', 'anon', 'unknown', 'nobody', 'someone', 'hahaha', 'haha', 'lol', 'lmao', 'hehe', 'wala', 'ewan', 'pogi', 'ganda', 'tanga', 'bobo', 'gago', 'gaga', 'putang', 'puta',
  'tangina', 'tanginamo', 'kupal', 'bwisit', 'ulol', 'pakyu', 'fuck', 'shit', 'bitch', 'ass', 'penis', 'dick', 'sex', 'nigga', 'yourname', 'fullname', 'firstname', 'lastname']);
// "Juan Dela Cruz" is the Filipino "John Doe" — real people do carry these names, so they are only FLAGGED for the admin, never rejected.
const PLACEHOLDER_NAMES = new Set(['juan dela cruz', 'juan de la cruz', 'maria clara', 'john doe', 'jane doe', 'pedro penduko', 'juan tamad']);
const NAME_PARTICLES = new Set(['de', 'del', 'dela', 'la', 'las', 'los', 'san', 'sta', 'da', 'di', 'du', 'van', 'von', 'mac', 'mc', 'y', 'jr', 'sr', 'ii', 'iii']);

/** Returns an error message if the name is clearly not a real full name; null if fine. */
function nameProblem(fullNormalized) {
  const words = fullNormalized.split(' ').filter(Boolean);
  if (words.length < 2) return 'Please enter your first and last name.';
  const real = words.filter((w) => !NAME_PARTICLES.has(w));
  if (real.length < 2) return 'Please enter your first and last name.';
  if (real.filter((w) => w.length >= 2).length < 2) return 'Please enter your full first and last name (initials alone are not enough).'; // "Juan D. Cruz" ok, "J Cruz" not
  if (/(.)\1\1/.test(fullNormalized.replace(/\s/g, ''))) return 'Please enter your real full name.';            // "aaa", "Jhoooon"
  if (new Set(real).size === 1) return 'Please enter your real full name.';                                    // "Juan Juan"
  if (real.some((w) => TROLL_WORDS.has(w))) return 'Please enter your real full name.';
  if (real.some((w) => /^[^aeiouy]{5,}$/.test(w))) return 'Please enter your real full name.';                   // "xkcdq"
  if (real.some((w) => /^(?:[a-z])(?:[a-z])?\1*$/.test(w) && w.length > 3)) return 'Please enter your real full name.';
  if (/^(?:[a-z]{1,3} ?)+$/.test(fullNormalized) && fullNormalized.replace(/\s/g, '').length < 6) return 'Please enter your real full name.';
  return null;
}

const DISPOSABLE = new Set(('mailinator.com,guerrillamail.com,guerrillamail.net,guerrillamail.org,sharklasers.com,10minutemail.com,10minutemail.net,temp-mail.org,tempmail.com,tempmail.net,tempmailo.com,' +
  'throwawaymail.com,yopmail.com,yopmail.fr,trashmail.com,trashmail.me,getnada.com,nada.email,dispostable.com,fakeinbox.com,maildrop.cc,mailnesia.com,mintemail.com,mohmal.com,' +
  'emailondeck.com,tempr.email,discard.email,spamgourmet.com,mytemp.email,burnermail.io,inboxkitten.com,mailsac.com,tmail.ws,tmpmail.net,tmpmail.org,moakt.com,1secmail.com,1secmail.net,' +
  'temp-mail.io,tempail.com,luxusmail.org,harakirimail.com,anonbox.net,mailcatch.com,mail-temp.com,crazymailing.com,emailfake.com,generator.email,fakemail.net,dropmail.me,tempinbox.com,' +
  'minutemail.com,33mail.com,spam4.me,getairmail.com,mailtemp.net,disposablemail.com,example.com,example.org,example.net,test.com,email.com').split(','));
const TYPOS = { 'gmail.co': 'gmail.com', 'gmail.con': 'gmail.com', 'gmail.cm': 'gmail.com', 'gmai.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gnail.com': 'gmail.com', 'gmial.com': 'gmail.com', 'gmaill.com': 'gmail.com', 'gmail.comm': 'gmail.com', 'gmail.om': 'gmail.com', 'gmail.vom': 'gmail.com', 'gmail.xom': 'gmail.com', 'googlemail.co': 'googlemail.com',
  'yahoo.co': 'yahoo.com', 'yahoo.con': 'yahoo.com', 'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'hotmail.co': 'hotmail.com', 'hotmail.con': 'hotmail.com', 'hotmal.com': 'hotmail.com', 'hotmai.com': 'hotmail.com', 'outlook.co': 'outlook.com', 'outlook.con': 'outlook.com', 'outlok.com': 'outlook.com', 'icloud.co': 'icloud.com', 'iclod.com': 'icloud.com' };

/** Returns an error message for throwaway / mistyped email domains; null if fine. */
function emailProblem(emailNormalized) {
  const domain = String(emailNormalized || '').split('@')[1] || '';
  if (!domain) return null;
  if (TYPOS[domain]) return `Did you mean @${TYPOS[domain]}? Please check your email address.`;
  if (DISPOSABLE.has(domain) || /^(?:temp|tmp|trash|fake|spam|disposable|throwaway)[a-z0-9-]*\./.test(domain)) return 'Temporary email addresses are not accepted. Please use your real Gmail / email.';
  const local = emailNormalized.split('@')[0];
  if (/^(test|asdf|qwerty|fake|sample|abc|xyz|aaa|none|null)\d*$/.test(local)) return 'Please use your real email address.';
  return null;
}

// ---------------------------------------------------------------------------
// Blocklist + volume caps
// ---------------------------------------------------------------------------
function blocked(db, { email_normalized, device_id, ip_hash }) {
  const domain = String(email_normalized || '').split('@')[1] || null;
  const rows = db.prepare(`SELECT kind FROM registration_blocks WHERE (kind = 'email' AND value = ?) OR (kind = 'domain' AND value = ?) OR (kind = 'device' AND value = ?) OR (kind = 'ip' AND value = ?) LIMIT 1`)
    .all(email_normalized || '', domain || '', device_id || '', ip_hash || '');
  return rows.length ? rows[0].kind : null;
}
const BLOCKED_MSG = 'Registration could not be submitted from this device or email. Please approach the Lifegen team at the venue.';

const sqlTs = (d) => d.toISOString().slice(0, 19).replace('T', ' '); // same shape as datetime('now')
/** Counts in the last `minutes`; used by the hourly cap, the per-IP cap and the burst flag. */
function recentCount(db, minutes, where = '', params = []) {
  const since = sqlTs(new Date(Date.now() - minutes * 60 * 1000));
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM registrations WHERE submitted_at >= ? ${where}`).get(since, ...params)?.n || 0);
}
/** Trip the auto-pause when the hourly cap is exceeded. Returns true when newly paused. */
function enforceCaps(db, s, { ip_hash }) {
  const cap = Math.max(0, Number(s.qr_hourly_cap) || 0);
  if (cap && recentCount(db, 60) >= cap) {
    db.prepare("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = 'qr_auto_paused_at'").run(new Date().toISOString());
    activity.log(db, null, 'registration.autopause', 'settings', null, `QR registration auto-paused: more than ${cap} submissions in 60 minutes. Resume it in Settings → QR registration.`);
    throw new HttpError(403, 'Registration is paused for a moment because of unusually high volume. Please try again in a few minutes or approach an usher.', { reason: 'paused' });
  }
  const ipCap = Math.max(0, Number(s.qr_ip_daily_cap) || 0);
  if (ipCap && ip_hash && recentCount(db, 24 * 60, 'AND ip_hash = ?', [ip_hash]) >= ipCap) {
    throw new HttpError(429, 'Too many registrations from this network today. Please approach an usher so the team can register you.', { reason: 'ip_cap' });
  }
}
/** Non-blocking hints for the admin inbox. */
function riskFlags(db, { device_id, ip_hash, form_seconds, email_normalized, full_name_normalized }) {
  const flags = [];
  if (full_name_normalized && PLACEHOLDER_NAMES.has(full_name_normalized)) flags.push('placeholder_name');
  if (form_seconds !== null && form_seconds !== undefined && form_seconds < 20) flags.push('fast');
  if (device_id && db.prepare('SELECT 1 FROM registrations WHERE device_id = ? LIMIT 1').get(device_id)) flags.push('same_device');
  if (ip_hash && recentCount(db, 10, 'AND ip_hash = ?', [ip_hash]) >= 3) flags.push('ip_burst');
  const local = String(email_normalized || '').split('@')[0];
  if (/\d{5,}/.test(local)) flags.push('email_numeric');
  return flags;
}

module.exports = {
  DEVICE_COOKIE, MIN_FORM_SECONDS, BLOCKED_MSG, DAY_NAMES,
  secret, status, windowInfo, rotation, tokenOk, churchNow, weekKey, fmtTime,
  device, readDevice, parseCookies, formToken, checkFormToken,
  nameProblem, emailProblem, blocked, enforceCaps, riskFlags, recentCount,
};
