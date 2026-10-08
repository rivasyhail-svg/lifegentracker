# LifegenTracker — Production-Readiness Audit

Date: 2026-10-07 · Scope: existing app only (no redesign, no rewrite). Incremental fixes.

## STEP 1 — Audit method

* Static review of `server.js`, `src/**`, `public/js/**`, `public/css/styles.css`, migrations 001–002.
* Schema inspection (`sqlite3 .schema`) for constraints and indexes.
* Live probes against the running server (API calls, invalid ids, double marking, viewer role).
* Playwright run at 12 viewport widths (320 → 1920) plus 200 % zoom on every page with a
  deliberately long-text person (very long name / email / address / school).

## STEP 2 — Problems found

### Critical
| # | Area | Finding |
|---|------|---------|
| C1 | Data loss | No archive; the only removal is permanent `DELETE` (cascades attendance). |
| C2 | Backup | No server-side backup/restore; a disk failure or accidental delete is unrecoverable. |
| C3 | Security | Cookie session is `SameSite=None` (needed for the embedded preview) but there is **no CSRF defence**, so a cross-site page could trigger state-changing calls when sign-in is on. |

### High
| # | Area | Finding |
|---|------|---------|
| H1 | Duplicates | No duplicate detection on registration (same name/contact can be saved twice). |
| H2 | Attendance | Marking an already-present person re-writes the record and adds a redundant audit row (`update` with identical values). Not idempotent. |
| H3 | Accountability | No general activity log — only attendance has an audit trail; person edits/deletes, settings and user changes are untracked. |
| H4 | Auth | `start.sh` defaults `LIFEGEN_AUTH=off`; a copy-paste deploy would be open to anyone on the network. (User asked for no login *for now* — must stay switchable, but default should be safe and the open state visible.) |
| H5 | Responsive | At 320 px the mobile topbar overflows by 20 px → whole page scrolls sideways on every screen. |
| H6 | Responsive | People table is a plain table on phones (horizontal scroll, truncated names); should stack like the other tables. |

### Medium
| # | Area | Finding |
|---|------|---------|
| M1 | Performance | `GET /api/people` returns up to 1000 rows with no pagination; roster renders every person (fine ≤ 300, degrades after). |
| M2 | Reliability | `api.js` has no request timeout — a stalled connection leaves a spinner forever. |
| M3 | Validation | Numeric `:id` params are passed straight to SQL (safe from injection via parameters, but `abc` gives a 404 rather than 400 and `1e9` is accepted). |
| M4 | Security | No `Content-Security-Policy` header. |
| M5 | Indexes | Missing `attendance_records(service_id, status)` composite and `people(email)`. |
| M6 | Text overflow | Long emails / IDs can exceed cell width in profile `dl` and roster rows (`word-break` only on `dd`). |

### Low
| # | Area | Finding |
|---|------|---------|
| L1 | UX | "Already marked" tap gives no feedback other than the confirm-to-undo dialog. |
| L2 | Ops | No `backups/` retention policy or scheduled snapshot. |
| L3 | Docs | README lacks backup/restore & archive instructions. |
| L4 | Person ID | Spec example shows 6 digits (`LG-2026-000001`); existing data uses `LG-YYYY-NNNN`. Renumbering would break printed IDs — keep 4 digits (room for 9 999 / year), note in report. |

Already OK (verified): UNIQUE(service_id, person_id); UNIQUE(service_date, service_type); UNIQUE person_code;
indexes on people name/status/contact, services date, attendance person/service, audit service; FK cascade;
scrypt passwords; opaque hashed session tokens; login throttle; viewer sanitisation; rate = present ÷ registered base;
`express.json` 1 MB limit; `no-store`; `X-Frame-Options`, `nosniff`; central error handler hides 500 details.

## STEP 3 — Fix plan (in required order)

1. **Data / reliability** — migration 003 (archive columns, activity_log, indexes); duplicate check endpoint + form warning; archive/restore endpoints; activity logging; JSON backup/restore + automatic daily DB file backups.
2. **Attendance integrity** — idempotent mark (no write, no audit when nothing changes) → `already_marked`; UI toast.
3. **DB / API reliability** — pagination (`limit/offset/total`), id validation, request timeout, consistent error shape.
4. **Auth / security** — CSRF header check, CSP, safe default for `LIFEGEN_AUTH`, visible "sign-in is off" banner.
5. **Responsive** — topbar fix, People table stacking, roster long-text, verified at 12 widths + 200 % zoom.
6. **Text overflow** — `min-width:0` + `overflow-wrap:anywhere` on identity cells.
7. **Performance** — "Load more" paging, roster cap with narrowing hint, composite indexes.
8. **Tests** — API tests (`tests/api.test.js`) + Playwright e2e + responsive sweep; rebuild single-file & standalone.
