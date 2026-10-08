'use strict';
/**
 * Shared normalisation used by manual registration (people route) and QR registration,
 * so both paths detect duplicates the same way.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizeEmail(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s || null;
}
function isValidEmail(v) {
  const s = normalizeEmail(v);
  return Boolean(s && s.length <= 254 && EMAIL_RE.test(s));
}
/** "  Juan   Dela-Cruz. " → "juan dela cruz" (case, spaces, punctuation and accents ignored) */
function normalizeName(v) {
  return String(v ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[.,'’`"\-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
/** Pretty-cased copy of a typed name: single spaces, trimmed (keeps the user's capitalisation otherwise). */
function tidyName(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}
const PARTICLES = new Set(['de', 'del', 'dela', 'de la', 'la', 'las', 'los', 'san', 'sta', 'santa', 'santo', 'sto', 'van', 'von', 'da', 'di', 'du', 'mac', 'mc']);
/** "Juan Miguel Dela Cruz" → { first_name: 'Juan Miguel', last_name: 'Dela Cruz' } */
function splitFullName(full) {
  const parts = tidyName(full).split(' ').filter(Boolean);
  if (parts.length <= 1) return { first_name: parts[0] || '', last_name: '' };
  let i = parts.length - 1;
  while (i > 1 && PARTICLES.has(parts[i - 1].toLowerCase().replace(/\./g, ''))) i -= 1;
  return { first_name: parts.slice(0, i).join(' '), last_name: parts.slice(i).join(' ') };
}
function isSqliteUnique(err, indexName) {
  return err && err.code && String(err.code).startsWith('SQLITE_CONSTRAINT') && (!indexName || String(err.message).includes(indexName));
}

module.exports = { normalizeEmail, isValidEmail, normalizeName, tidyName, splitFullName, isSqliteUnique };
