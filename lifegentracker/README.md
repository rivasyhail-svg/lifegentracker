# LifegenTracker

Internal attendance system for **Lifegiver Church of Faith** — Phase 1: people registration and
**Lifegen / 3rd Service** Sunday attendance tracking.

## Features (Phase 1)

| Area | What it does |
|------|--------------|
| **Dashboard** | Latest Sunday attendance, registered people, first timers, returning attendees, attendance rate, current month & quarter totals, weekly / monthly / trend / first-timer-vs-returning charts |
| **People** | Register (required: name, contact number, status), search (name · Person ID · contact), profile page with photo, edit, change status / deactivate; auto Person ID `LG-2026-0001` (year of registration + sequence) |
| **Attendance** | Pick a Sunday → open the roster → mark Present / Absent, auto first-timer vs returning (with manual override), undo, live summary, walk-in "Register first timer" that registers **and** marks present in one step |
| **History** | Every Sunday with totals, per-Sunday detail (present / absent / not marked) and a full change log (who recorded what, when) |
| **Reports** | Month / quarter / year / custom range → totals, average, highest, lowest, first timers, returning, attendance %, weekly & monthly breakdowns, charts; CSV export and print-to-PDF |
| **Registrations (QR)** | Printable QR → public `/register` form on the visitor's phone → admin inbox (approve / link / reject) → person in the same People table; one Gmail = one registration, enforced by the database. See [QR self-registration](#qr-self-registration-server-deployment-only) |
| **Security** | Sign-in with hashed passwords (scrypt), httpOnly session cookies, login throttling, roles: **Admin · Attendance Staff · Viewer/Leader** (viewers never see contact details) |

## Run it

> Want it online as a real website (HTTPS URL that phones can scan)? See **[docs/DEPLOY.md](docs/DEPLOY.md)** (quick Taglish guide: [docs/PUBLISH-SUPABASE-VERCEL.md](docs/PUBLISH-SUPABASE-VERCEL.md)) — **free on Vercel + Turso or Vercel + Supabase**, or Render / Fly.io / Railway / Docker / church-Wi-Fi laptop.

```bash
npm install
npm start            # http://localhost:3000
# or: bash ./start.sh  — restores node_modules from vendor-node_modules.tgz if npm install was never run
```

Open the app in a browser. On first launch a **one-time setup screen** asks you to create the Admin
account — there are no default passwords. Add staff/viewer accounts later under **Settings → Users**.

Environment variables (optional):

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `LIFEGEN_DB_FILE` | `./data/lifegen.db` | SQLite database location |
| `LIFEGEN_AUTH` | `on` | `off` = open access (no sign-in; everyone is Admin) — demos only |
| `LIFEGEN_AUTO_BACKUP` | `on` | `off` disables the daily snapshot in `data/backups/` |

**Back up `data/lifegen.db` regularly** (see *Backups* below) — it holds every record.

### Demo data

Settings → *Sample / demo data* loads clearly-labelled records ("Demo Person 01…24", tagged `is_demo`)
so leaders can explore charts before real registrations begin. A banner shows while demo data is present,
and it can be removed completely in one click. Never mix demo data with live records.

## Project structure

```
server.js                  Express app, security headers, SPA fallback
src/db/index.js            SQLite connection + versioned migrations runner
src/db/migrations/         001_init.sql … (add 002_*.sql for future modules)
src/middleware/auth.js     Sessions, password hashing, role → permission map
src/services/stats.js      Single source of truth for all attendance statistics
src/services/demo.js       Labelled demo data load / remove
src/routes/                auth · people · services (attendance) · dashboard · reports · admin
public/                    Front-end (vanilla JS modules, no build step)
  js/app.js                Router, layout, global search, permissions
  js/views/                One module per screen
  js/charts.js             Dependency-free SVG charts
  css/styles.css           Design system
```

## Data model

```
roles ──< users ──< sessions
people ──< attendance_records >── services
attendance_audit   (append-only log of every mark / change / undo)
settings           (church_name, service_name, …)
networks ──< lifegroups ──< lifegroup_memberships >── people   (networks may nest via parent_network_id)
```

* Attendance is **never** a counter on a person — each Sunday produces one row per person in
  `attendance_records` (`UNIQUE (service_id, person_id)` prevents duplicates), carrying status,
  first-timer/returning classification, who recorded it and when.
* Historical Sundays are preserved; corrections are logged in `attendance_audit`.
* **Attendance rate** = present ÷ people registered (or first attended) on/before that Sunday and not inactive.

## Roles

| Permission | Admin | Attendance Staff | Viewer / Leader |
|-----------|:-----:|:----------------:|:---------------:|
| Dashboard & reports | ✓ | ✓ | ✓ |
| View people & attendance history | ✓ | ✓ | ✓ (contact details hidden) |
| Register / edit people, record attendance | ✓ | ✓ | — |
| Permanently delete people | ✓ | — | — |
| QR registrations inbox & QR code | ✓ | — | — |
| Users, settings, demo data | ✓ | — | — |

## Future phases (architecture is ready; Lifegroups done, the rest not yet built)

Each module arrives as **a migration + a router + a permission key + a view** — no rebuild:

* **Cell Groups (Lifegroups)** — ✅ built: `lifegroups`, `lifegroup_memberships` (history). Lifegroup attendance could follow as `lifegroup_attendance`.
* **LifeClass** — `lifeclass_enrollments (person_id, stage: pre_encounter | encounter | post_encounter)`
* **Discipleship** — `discipleship_progress (person_id, track: undercover | school_of_leaders)`
* **Ministry** — `ministries`, `ministry_members (person_id, role, from, to)`
* **Quarterly report** — joins Sunday attendance with the modules above via `people.id`

`services.service_type` already exists so other services can be tracked without schema changes.


## Sign-in on / off

`./start.sh` starts the app with **sign-in ON** (the safe default). For a quick open-access demo, where
everyone who opens the site acts as Admin, run:

```bash
LIFEGEN_AUTH=off ./start.sh     # open access — a warning banner is shown on the dashboard
```

Forgot the admin password? `npm run reset-password -- <username> <new-password>`.

## Backups, archive and activity log

* **Automatic snapshots** — on start-up and every 24 h the server copies the database to
  `data/backups/lifegen-auto-<timestamp>.db` (last 14 kept). Set `LIFEGEN_AUTO_BACKUP=off` to disable.
* **Download backup** — Settings → Backup & restore → *Download backup* saves a JSON file
  (`lifegentracker-backup-YYYY-MM-DD.json`) with every table. Keep it off the server (e.g. Google Drive).
* **Restore** — Settings → *Restore from file…*; type `RESTORE` to confirm. The current database is
  snapshotted first and the restore is all-or-nothing (invalid files are rejected and nothing changes).
  Everyone is signed out afterwards.
* **Archive instead of delete** — a person's profile has *Archive*: they disappear from People, search and
  the Sunday roster but all attendance history and past totals stay. People → *Archived* filter → *Restore*.
  *Delete permanently* remains admin-only, requires typing `DELETE`, and is written to the activity log.
* **Activity log** — Settings (admin) shows who registered/edited/archived/deleted people, changed settings
  or users, loaded demo data, made backups, plus every attendance mark/undo.

## Lifegroups (connection tool)

After attendance, connect people to a cell group. **Lifegroups** in the sidebar:

* **Groups** — name, leader (a registered person, or a typed name), network, area, day/time, category,
  capacity, venue. Members list, former members (history is kept), inactive groups stay for history.
* **Needs Lifegroup** — active people without a current group, most recent attendees first → *Find a Lifegroup*.
* **Find a Lifegroup** (also on every profile) — preferred area / day / time / category →
  *Recommended Lifegroups* ranked by match (same area +3, day +2, time +1, category +1; full groups hidden) → *Assign*.
  Preferences are saved to the profile. Moving to a new group closes the old membership (`left_at`) instead of
  overwriting it, so the profile shows e.g. *Jan 2026 → David Group · Apr 2026 → Joshua Group*.
* **Dashboard → Lifegroup overview** — groups, leaders, with/without group, new people needing connection,
  groups with slots, plus the top "Needs Lifegroup" names.
* Permissions: `lifegroups:view` (all roles), `lifegroups:manage` (Admin, Staff). Every assign/move/leave is in the activity log.

### Boys groups and girls groups — never mixed

Every Lifegroup is either a **boys group** or a **girls group** (required when creating/editing). The rule is enforced
everywhere: only boys can join a boys group (assign / move / "Add member" → clear error otherwise), a group's leader must
match, a group with members cannot be flipped to the other type, *Find a Lifegroup* only recommends groups of the person's
sex (and asks for Boy/Girl first if the profile has none), and the Groups list can be filtered *Boys groups / Girls groups*.
Network cards, the Network structure page and the Lifegroup report show *boys groups / girls groups* counts.
Migration 006 adds `lifegroups.gender` and fills it for existing groups whose current members are all one sex.

The other sex is **not even offered**: the *Add member* picker in a boys group searches boys only (`GET /api/search?sex=male`),
the *Leader* picker in the group form follows the Boys/Girls choice (and is locked until one is chosen; switching the choice
clears the picked leader).

### Networks are boys or girls too — never combined

A **Network is either a boys network or a girls network** (required when creating/editing; migration 007 adds
`networks.gender` and fills it from the groups inside). Enforced on both server and standalone: a boys network can only
hold boys groups (and boys sub-networks), its leader must be a boy, flipping the type is refused while anything inside
would become mixed, and the pickers never offer the other side (group form shows only same-type networks and auto-sets
Boys/Girls when a network is picked; network form filters parents + leader the same way). The Networks tab is split into two divisions — **Boys networks** and **Girls networks** (plus a *Not set yet* section for
networks made before the rule) — each with its own totals, so boys and girls numbers are never mixed in one bar. Demo data: Demo Boys Network → Network A (boys: Joshua, David);
Demo Girls Network → Network B (girls: Ruth, Esther).

### Growth — boys groups vs girls groups

**Reports → Lifegroups** has a *Growth* section: members at the end of each month for all boys groups vs all girls groups
(last 12 months, two-line chart + table with joined / left / % growth vs the previous month), 30- and 90-day change for
each side, a *growth ratio* (new boys : new girls in the last 30 days), and a *Last 30 days* column per group.
API: `growth` in `GET /api/reports/lifegroups`; CSV `GET /api/reports/export/lifegroup-growth.csv`
(the groups CSV also gained `joined_30d, left_30d, net_30d, growth_30d_pct`). A move between groups counts as left + joined.

### Networks (leaders of leaders)

A **Network** is the layer above Lifegroups: it has its own **Network leader**, and every Lifegroup can belong to
one Network — so a Lifegroup leader *reports to* the Network leader. A Network can also report to a parent Network
(e.g. *Main Network → Network A → Joshua Group → member*).

* **Lifegroups → Networks** tab: **one card per Network** — Network leader, Lifegroups / Leaders / Members counts
  (a parent network's totals include its sub-networks) and a **boys : girls** ratio bar. *New Network* / edit /
  delete (only when empty). Group form has a Network dropdown.
* **Network page → Structure**: Network leader → each Lifegroup leader (with member count and boys/girls) → *Show members*
  (name, Boy/Girl, status, role, since). Plus a *Boys & girls* table per group.
* **Reports → Lifegroups** tab (`#/reports?view=lifegroups`): connected members, boys, girls, boys : girls ratio, not-yet-connected
  (also split by boys/girls), per-Network and per-Lifegroup tables, Print/PDF and **CSV** (`/api/reports/export/lifegroups.csv`).
  Data: `GET /api/reports/lifegroups`. Sex comes from the person profile (Male/Female); people without it are counted as "not set".
* Group page shows *Network* and *Network leader*; a person's profile shows the Network plus a **Reports to** chain
  (Lifegroup leader → Network leader → parent Network leader) and, for leaders, what they **lead**.
* API: `GET/POST /api/networks`, `GET/PUT/DELETE /api/networks/:id` (same permissions as Lifegroups; delete = Admin, 409 when in use;
  loops in the parent chain are rejected). `GET /api/people/:id` includes `leadership`.

## Privacy, consent & accessibility (launch checklist)

- **Privacy notice + Terms of use** page at `#/privacy` — reachable before sign-in (login footer) and from the sidebar.
  Written for the Data Privacy Act of 2012 (RA 10173): what is collected (only what's needed), why, who sees it,
  retention, cookies (one strictly-necessary session cookie, no tracking → no banner), and how to exercise rights.
- **Consent on the person form** — "The person agreed that Lifegen keeps their details…" checkbox, stored as
  `people.privacy_consent_at` (date), shown on the profile; API `privacy_consent: true|false`.
- **Real business details** — Settings → Church details: address, church contact, data privacy contact (optional,
  shown on the Privacy page). `PUT /api/settings` accepts `church_address`, `church_contact`, `privacy_contact`.
- **No third parties** — no CDN scripts, fonts, analytics, embeds or external images (inline SVG icons only).
- **Accessibility** — all text meets WCAG AA contrast (muted grey darkened to `#62676e`), visible `:focus-visible` ring,
  "Skip to content" link, labels/aria-labels on every control, Esc closes dialogs, forms submit with Enter.
- **No unsupported claims** — copy says what the app does, nothing about guarantees or certifications.

## QR self-registration (server deployment only)

Visitors scan a printed QR, open the public form on their own phone, and land in an **admin inbox** — not directly in People.

**How it flows**
1. Admin → Settings → *QR registration*: preview, **Copy link**, **Download PNG**, **Print poster** (`#/qr-poster`,
   "LIFEGEN / NEW HERE? / Scan to Register"). The QR encodes only the URL `…/register` — never personal data — so one print
   keeps working even when rules change. Set *Public URL* if people reach the app through a different domain.
2. `/register` (no login, mobile-first, 3 steps: Basic info → Ministry & leaders → Review → Submit): Full name, Email/Gmail,
   Age (5–100), School, Leader, Network leader, Ministry (dropdown from Settings). Privacy notice on the review step.
   Success screen shows a reference `LG-YYYY-NNNNNN` (6 digits — the 4-digit Person ID `LG-YYYY-NNNN` is given on approval); a network failure shows **Retry** with the answers kept.
3. Admin → **Registrations** (sidebar badge + dashboard notice show the pending count): filters Pending/Approved/Rejected/All,
   search by name/email/school/leader/ministry/reference; View · Edit · Approve · Reject · Delete.
4. **Approve** inserts the person into the *same* `people` table the manual form uses (`LG-YYYY-NNNN`, status First Timer by
   default, `registration_source = 'qr'`, leader names kept in notes) — or **Link to this person** when the admin decides it is
   someone already registered (fills only empty fields; ID, status and attendance untouched). Rejected/pending rows never
   appear in People, attendance or reports.

**Rules (Settings → QR registration)**: allow new registrations (off → form says "Registration is currently unavailable"),
require admin approval (off → auto-approve), flag same-name registrations, suggest active leader names, ministry list, public URL.

**Duplicate protection** — one Gmail = one registration, enforced by the database, not just the UI:
- emails are normalised (trim + lowercase) and `registrations.email_normalized` is `UNIQUE`; `people.email_normalized` has a
  partial unique index, so the manual form shares the rule (friendly 409 instead of a crash). Concurrent identical submits →
  exactly one succeeds (checked by the tests).
- same normalised name + different email → accepted, flagged *Possible duplicate*; the user sees a warning, the admin sees the
  matching people with a one-click **Link**.

**Security** — public endpoints live under `/api/public/register*` (options, check, submit) with per-IP rate limiting
(`LIFEGEN_RATE_LIMIT_SUBMIT`, default 40 per 15 min — many registrants share the church Wi-Fi), a honeypot field, strict
server-side validation and the same CSRF header as the app. Everything else (`/api/registrations*`, `/api/qr/*`) requires the
`registrations:manage` permission (Admin only). Registrations are included in backups and in the activity log.

**Not available in the standalone `index.html`** — that build stores data inside one browser, so phones cannot write to it.
Settings there says so plainly instead of pretending. Use `node server.js` or the single-file build.

## Tests

```bash
node tests/api.test.js     # starts a private server on a temp DB with sign-in ON; 61 checks (incl. 15 QR-registration acceptance tests)
```

## Single-file build

`npm run build:single` bundles the entire app into **single-file/lifegentracker.js** (server + migrations + web app).
Copy that file plus `single-file/package.json` anywhere, then `npm install && node lifegentracker.js` (installs express, better-sqlite3, qrcode).
Regenerate it after changing the source.

## Standalone build (no server — one index.html)

`npm run build:standalone` produces **standalone/index.html**: the whole app in a single HTML file that opens directly in a browser.
Records are stored in that browser (localStorage) — single device, no user accounts. Use **Settings → Download backup** regularly;
the backup is a JSON file that can be restored on another device.

**Admin sign-in (optional):** Settings → *Admin sign-in* → set a username + password (min. 8 chars). From then on the file asks
for sign-in every time it is opened (closing the tab signs out; 6 wrong tries → 15-minute lock). The password never leaves the
browser — only a salted PBKDF2/SHA-256 hash is stored. It can be changed or turned off again with the current password.
There is no "forgot password" — if lost, restore a backup into a fresh copy of the file.
