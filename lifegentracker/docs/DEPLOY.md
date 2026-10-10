# Deploying LifegenTracker as a real website

LifegenTracker is one Node.js process + one SQLite file. Any host that can run Docker **and keep a persistent disk**
works. The database must live on that disk (`LIFEGEN_DATA_DIR=/data`) — on hosts without a disk (Vercel, Netlify,
Render *free* tier) the records would be wiped on every deploy, so those are not suitable.

| Option | Cost | Best for | Files used |
|---|---|---|---|
| **0. Vercel + Turso (FREE)** | US$0 (Vercel Hobby + Turso free tier) | Free public HTTPS website incl. QR registration | `vercel.json`, `api/index.js` |
| **0b. Vercel + Supabase (FREE)** | US$0 (Vercel Hobby + Supabase free tier) | Same as above, Postgres database; pauses after 7 idle days | `vercel.json`, `api/index.js` |
| **A. Render.com** (easiest) | Starter ≈ US$7/mo + disk ≈ US$0.25/GB | Public HTTPS URL in ~10 minutes, no server admin | `render.yaml`, `Dockerfile` |
| **B. Fly.io** | ≈ US$2–5/mo (shared-cpu + 1 GB volume) | Cheap, Singapore region | `fly.toml`, `Dockerfile` |
| **C. Railway.app** | ≈ US$5/mo | Also easy; add a Volume mounted at `/data` | `Dockerfile` |
| **D. Own VPS / PC with Docker** | server cost only | Full control, custom domain | `docker-compose.yml` |
| **E. Laptop on church Wi-Fi** | free | Sundays only, same Wi-Fi | `start.sh` |

## 0. Vercel + Turso — free (step by step)

Vercel runs the Node app as a serverless function (no disk), so the database lives in **Turso** (hosted SQLite,
free tier: 5 databases / 5 GB / 500 M reads). The app talks to it through the `libsql` driver — the same code,
switched on by two environment variables. Nothing changes for local/Docker installs.

**Accounts needed (all free):** GitHub → Vercel → Turso.

1. **GitHub**: create a repo `lifegentracker` and upload the contents of `lifegentracker-deploy.zip`
   (web upload: *Add file → Upload files*, drag the folders in Chrome/Edge).
2. **Turso** (https://turso.tech → Sign up with GitHub): *Create Database* → name `lifegen`, group/region
   **Singapore (aws-ap-southeast-1)** → open the database → copy the **URL** (`libsql://lifegen-<you>.aws-ap-southeast-1.turso.io`)
   and create a **Token** (*Generate token*, no expiry, read-write).
3. **Vercel** (https://vercel.com → Sign up with GitHub): *Add New → Project* → import `lifegentracker` →
   Framework preset **Other** → open **Environment Variables** and add:
   | Name | Value |
   |---|---|
   | `LIFEGEN_DB_URL` | the Turso URL from step 2 |
   | `LIFEGEN_DB_TOKEN` | the Turso token |
   | `LIFEGEN_AUTH` | `on` |
   | `LIFEGEN_AUTO_BACKUP` | `off` |
   → **Deploy** (2–4 min). Your site: `https://lifegentracker-<you>.vercel.app`.
4. Open it → **first-run setup** (create the admin; nothing is pre-set) → Settings → Church details →
   **QR registration → Public URL** = your Vercel URL → **Print poster**.

Notes for this host
- `vercel.json` pins region **sin1** (Singapore) so the function sits next to the Turso database (low latency).
- File `.db` snapshots are not available (no disk) — Settings shows this; **Download backup (JSON)** still works and
  Turso keeps its own point-in-time history. Restore works normally.
- Login throttling / registration rate limits are per function instance (Vercel may run several); the database-level
  rules (unique email, hashed passwords, sessions) are unaffected.
- Free tiers can change; if Vercel/Turso limits are hit the site returns errors rather than losing data.
- The driver swap was verified with the full test suite locally (`LIFEGEN_DB_DRIVER=libsql npm test`); the remote
  (Turso URL) mode uses the same API — if anything differs on your first deploy, send the Vercel log line and it is a
  small fix.

## 0b. Vercel + Supabase (Postgres) — free (step by step)

> Taglish, click-by-click na bersyon na may troubleshooting table: **[PUBLISH-SUPABASE-VERCEL.md](PUBLISH-SUPABASE-VERCEL.md)**

Same idea as section 0, but the data lives in a **Supabase** Postgres database. The app includes a small Postgres
driver (`src/db/pg-sync.js`) that translates its SQLite statements on the fly, so nothing else changes. Turn it on with
one variable: `LIFEGEN_DB_URL=postgresql://…`. Verified locally with the full test suite against PostgreSQL 17
(`LIFEGEN_DB_URL=postgres://… npm test` → 62/62) plus demo data, reports, exports, QR flow and backup/restore.

**Accounts needed (all free):** GitHub → Vercel → Supabase.

1. **GitHub**: create a repo `lifegentracker` and upload the contents of `lifegentracker-deploy.zip`.
2. **Supabase** (https://supabase.com → Sign in with GitHub): *New project* → name `lifegen`, **Region: Southeast Asia
   (Singapore)**, choose a strong **database password** and keep it. Wait ~2 min until the project is ready.
3. Still in Supabase: click **Connect** (top bar) → tab **Connection string / URI** → choose **Session pooler**
   (*not* "Direct connection" — direct is IPv6-only and Vercel cannot reach it) → copy the URI, which looks like
   `postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`
   → replace `[YOUR-PASSWORD]` with your password. If the password contains `@ : / # ?` write it URL-encoded
   (`@` → `%40`, `#` → `%23`, …).
4. **Vercel** (https://vercel.com → Sign up with GitHub): *Add New → Project* → import `lifegentracker` →
   Framework preset **Other** → **Environment Variables**:
   | Name | Value |
   |---|---|
   | `LIFEGEN_DB_URL` | the Supabase URI from step 3 |
   | `LIFEGEN_AUTH` | `on` |
   | `LIFEGEN_AUTO_BACKUP` | `off` |
   → **Deploy** (2–4 min). Your site: `https://lifegentracker-<you>.vercel.app`.
   The first request creates all tables (migrations run automatically; you can see them in Supabase → Table Editor).
5. Open it → **first-run setup** (create the admin) → Settings → Church details → **QR registration → Public URL** =
   your Vercel URL → **Print poster**.

Notes for this host
- **Free-tier pause:** Supabase pauses a free project after **7 days without activity**; the site then shows
  "Unexpected server error" until you press **Restore project** in the Supabase dashboard (≈1 min). Opening the app
  once a week (any Sunday) keeps it awake. Paid Supabase (US$25/mo) never pauses — Turso (section 0) has no such pause.
- Use the **Session pooler** URI (port 5432). The *Transaction pooler* (port 6543) also works for this app, but Session
  is simpler. SSL is on automatically.
- File `.db` snapshots are not available (no disk) — **Download backup (JSON)** and **Restore** work as usual; Supabase
  also keeps daily backups on paid plans only, so download a JSON backup regularly.
- Same per-instance note as section 0 for login throttling / rate limits.
- Postgres compares text case-sensitively; the app adapts (searches are case-insensitive, usernames/emails are
  normalised), so behaviour matches the SQLite version.

### Free, static alternative (no QR registration)
If you only need the **standalone** version online: drag `standalone/index.html` onto https://app.netlify.com/drop
(Netlify Drop) — instant free HTTPS URL. Data stays in each visitor's browser (same limits as the standalone build).

## A. Render (step by step)
1. Push this folder to a GitHub repo (private is fine). Exclude `data/` and `node_modules/` (already in `.gitignore`).
2. Render dashboard → **New + → Blueprint** → choose the repo → it reads `render.yaml` → **Apply**.
3. Wait for the first deploy (3–5 min). Your site: `https://lifegentracker-xxxx.onrender.com`.
4. Open it → **first-run setup** creates the admin user (choose a strong password; nothing is pre-set).
5. **Settings → QR registration → Public URL** = your Render URL → Save → **Print poster**.
6. Optional: Settings → Custom Domains on Render to use `lifegen.yourchurch.org`.

## B. Fly.io
```bash
fly auth login
fly launch --copy-config --no-deploy        # accepts fly.toml; pick app name if taken
fly volumes create lifegen_data --size 1 --region sin
fly deploy
fly open
```

## C. Railway
New Project → Deploy from GitHub repo → it detects the `Dockerfile`. Add **Variables**: `LIFEGEN_AUTH=on`,
`LIFEGEN_DATA_DIR=/data`. Add a **Volume** mounted at `/data`. Generate a domain under Settings → Networking.

## D. VPS / PC with Docker
```bash
git clone <your repo> lifegentracker && cd lifegentracker
docker compose up -d
# → http://<server-ip>:3000  — put Caddy/Nginx in front for HTTPS + domain
```
Caddy example (`Caddyfile`): `lifegen.yourchurch.org { reverse_proxy localhost:3000 }` — Caddy issues HTTPS automatically.

## E. Laptop on church Wi-Fi (no internet needed)
```bash
bash start.sh            # Windows: install Node 20, then `npm install && set LIFEGEN_AUTH=on && node server.js`
```
Find the laptop IP (`ipconfig` / `ifconfig`, e.g. 192.168.1.20) → phones on the same Wi-Fi open
`http://192.168.1.20:3000/register`. Set that as **Public URL** in Settings so the QR points there.

## After deploying — checklist
- [ ] First-run setup done; admin password strong and not shared in chat/QR/poster.
- [ ] Settings → Church details filled (name, address, privacy contact).
- [ ] Settings → QR registration → Public URL = the address phones will use → test by scanning once.
- [ ] Settings → Remove demo data (if loaded) before real records.
- [ ] Download a backup (Settings → Backup) and keep it off-server; automatic daily snapshots stay in `/data/backups`.
- [ ] Only HTTPS in public (Render/Fly/Railway give it free; VPS → Caddy).

## Environment variables
| Var | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | listening port |
| `LIFEGEN_AUTH` | on | `off` disables sign-in — never in public |
| `LIFEGEN_DATA_DIR` | `./data` | where `lifegen.db` + `backups/` live (mount a disk here) |
| `LIFEGEN_RATE_LIMIT_SUBMIT` | 40 | public registration submits per IP per 15 min |
| `LIFEGEN_AUTO_BACKUP` | on | daily `.db` snapshots (keeps 14); auto-skipped on hosted databases |
| `LIFEGEN_DB_URL` | — | `libsql://…turso.io` (Turso/libSQL) **or** `postgresql://…` (Supabase/any Postgres) → hosted database instead of a local file |
| `LIFEGEN_DB_TOKEN` | — | auth token for a Turso `LIFEGEN_DB_URL` (not used for Postgres — the password is in the URI) |

## QR anti-fake protection (Settings → QR registration)

No external services are used (no SMS/email OTP, no CAPTCHA). Everything runs inside LifegenTracker:

| Rule | Default | Where |
|---|---|---|
| Registration window | **Sundays only, 12:00 PM – 5:00 PM** (Asia/Manila) — "Open now for 3 h" override for special events | Settings → Anti-fake protection |
| QR mode | **Reusable** (one print) or **Rotating** (new `?k=` code each Mon–Sun week; "New QR code" invalidates the current print at once) | same |
| One registration per phone | on — signed `lg_dev` cookie; second attempt shows the earlier reference; rejected rows free the phone | same |
| Auto-pause | more than 60 submissions in 60 min → form paused, admin **Resume** | same + banner in Registrations |
| Per-network limit | 50 per IP per day (church Wi-Fi is shared → keep generous) | same |
| Real-name rules | always on: ≥ 2 real words, no "test/asdf/…", no repeated letters, placeholder names (Juan Dela Cruz) flagged not rejected | server (`src/services/qrguard.js`) |
| Email rules | always on: Gmail dots / `+tag` / googlemail = same inbox; temporary-mail domains rejected; `gmail.con` typos caught | server |
| Form timing | form open < 6 s → "too fast"; token older than 4 h → refresh; `LIFEGEN_MIN_FORM_SECONDS` overrides | server |
| Blocklist | email / domain / phone / IP — from the Reject dialog ("Also block…") or Settings → Blocklist; bulk reject in the inbox | Registrations |

Risk hints shown in the inbox: *Filled in under 20 s*, *Same phone*, *Burst*, *Odd email*, *Placeholder name*. They never block — the admin decides.

## Sunday lock, automatic Networks and Lifegroup progress (2026-10-09)

**Attendance — Sunday only.** With *Settings → Attendance & Lifegroup rules → Sunday-only attendance marking* ON
(default), the PRESENT button works only on the actual Sunday (Philippine time, `qr_timezone`). Any other date is a
*correction*: Admins only, a reason is required, and the reason is stored in `attendance_audit.reason` and shown in the
Activity log and the Sunday's audit. Staff see a locked notice. Turn the rule OFF to let staff mark any Sunday.

**Networks form automatically.** Rule: if the leader of Lifegroup B is a current member of Lifegroup A (led by P), then
B belongs to *P's network* (created on the fly, `networks.is_auto = 1`, named "P Network"). Networks follow membership
changes; an auto network with nothing under it goes inactive (history kept) and is revived when needed. There is no
"New Network" button any more. To override, edit a Lifegroup and pick a network by hand (`lifegroups.network_manual = 1`);
"Auto" puts it back under the rule. Boys/girls separation still applies.

**Lifegroup progress.**
- Every current member has a tier: **Solid** or **New / other** (`lifegroup_memberships.tier`). It is set by hand by the
  leader (report link) or staff — never automatically. A Lifegroup is **solid** once it has `lifegroup_solid_target`
  (default 6) solid members.
- Leaders report weekly without logging in through a **private link/QR** (`/lifegroup?t=TOKEN`, from the group's Progress
  card → *Leader link & QR*). They tick who was present, add newcomers (registered in People as First Timer, status
  "New / other", `people.added_via = 'lifegroup_link'`), mark Solid, or report "no Lifegroup this week" with a reason.
  "New link" invalidates the previous token. The link exposes only the group's member names — no contact details.
- Tables: `lifegroup_meetings` (one per group per date, `held`, `no_meeting_reason`, `present_count`, `submitted_via`)
  and `lifegroup_meeting_attendance`. Both are included in backups.
- Views: Lifegroups → **Progress** tab (overall, boys vs girls, per network, every group with an 8-week grid), each
  Network page (**Weekly Lifegroups** grid: the network leader's own group first, then each group under it), each
  Lifegroup page (**Progress** card with tiers, 12-week strip, meeting reports, leader link).
- API: `GET /api/lifegroups/progress/overview`, `GET /api/lifegroups/:id/progress`, `PUT /api/lifegroups/:id/members/:pid/tier`,
  `POST/DELETE /api/lifegroups/:id/meetings(/:mid)`, `POST /api/lifegroups/:id/report-link/reset`, `GET /api/networks/:id/calendar`;
  public (rate-limited): `GET /api/public/lifegroup/:token`, `POST …/report`, `PUT …/members/:pid/tier`.
- Migration `010_progress_networks_lock.sql` runs automatically on first start (SQLite and Postgres).

## Closed/open cell, devotion taps, network-leader view, network statistics (2026-10-09, update 2)

Migration `011_devotion.sql` adds `present` / `devotion` columns to `lifegroup_meeting_attendance` (applies automatically on start, SQLite and Postgres).

- **Member sections everywhere**: *Solid · closed cell* (committed, consistent) and *New · open cell* (newcomers). Same tier field as before — only the presentation changed. Boy/Girl columns were removed from group and network member lists because every Lifegroup and Network is single-sex.
- **Leader link (`/lifegroup?t=…`) is tap-only**: date → "We met / No Lifegroup" → tap names present, tap *Devo* for devotion → Send. Newcomers via "+ New person this week". Topic/notes are gone from the leader form (staff still have them in *Report a meeting*).
- **Network leaders** open the *same* link for their own group and get a second tab, *My leaders*: every Lifegroup in their network, this week's status, and each member's last 4 weeks (attended / absent / devotion) in Solid / New sections, with *Mark Solid* taps. API: `GET /api/public/lifegroup/:token` → `network` (null for non-network leaders); `PUT /api/public/lifegroup/:token/groups/:gid/members/:pid/tier` (403 outside the leader's network).
- **Reports → Lifegroups** now opens with **Network status**: Lifegroups, members, solid, solid %, solid groups, met this week, held (4 weeks), average LG attendance, devotion %, members present last Sunday. `GET /api/reports/network-status`, CSV `GET /api/reports/export/network-status.csv`. The Lifegroups CSV has `solid_members / new_members / solid_pct` instead of per-group boys/girls.
- `GET /api/networks/:id/calendar?members=1` adds `members_last4` (per group → per person).
- Removed duplicates: per-group boys/girls ratios, the "Boys & girls" card on the Network page, Boys-vs-girls / By-network tables on the Progress tab (now in Reports), the always-identical "Source" column in Registrations.
- Demo seed for load testing: `node scripts/seed-large-demo.js` (1,000 people, 14 Sundays, 86 groups, 6 auto networks, 38 registrations) — refuses to run if demo data exists; *Settings → Remove demo data* deletes everything it created.

## 2026-10-10 update 3 — Closed cell / Open cell, auto-placement, no more Area

What changed (upload the whole update zip again, then Vercel redeploys automatically):

- **Terminology:** "Solid" → **Closed cell** (matagal na, committed, consistent); "New" → **Open cell** (mga bago). One field (`tier`), same database — no migration needed.
- **Members everywhere** (Lifegroup detail, Network detail, leader QR page): two side-by-side sections — **Open cell on the LEFT, Closed cell on the RIGHT** (stacked on phones). Names are clickable. Buttons: *Closed →* / *← Open*.
- **Auto-placement on Approve:** when a QR registration is approved, the person is put under the Lifegroup of the leader they typed (case-insensitive name match; if two leaders share a name, the network leader's name decides; if still unsure → stays in *Needs Lifegroup*). Added as **Open cell**; boy/girl is inferred from the group when missing. Toast tells the admin where they were placed. Activity log: `lifegroup.assign … automatically`.
- **Registrations:** default tab is *Pending* (approved rows leave the main view); Approved tab shows the person link, who approved, and the **Lifegroup** column (or *Needs Lifegroup*). Email folded under the name so the table fits the screen.
- **Leader QR page** (`/lifegroup?t=…`): tabs **My members** (default) · **Weekly report** · **My leaders** (network leaders only). Leaders move members between Open/Closed cell (saves instantly), tap **Not active** to end a membership (history kept), and **Bring back** former members. New public routes: `PUT /api/public/lifegroup/:token/members/:pid/inactive` and `…/restore` (409 if the person is now in another group).
- **Lifegroups list:** split into **Boys Lifegroups** and **Girls Lifegroups** tables; Area column + "All areas" filter removed; columns now Group · Leader · Network · Schedule · Members · Closed cell · Open cell · Last held. KPI tiles (Lifegroups page and Dashboard) now include **Closed cell** and **Open cell** totals and every tile is clickable.
- **Area removed everywhere** (one church only): group form, list, detail, Find a Lifegroup, network tree, CSV (`area` column dropped), recommendations. Person form: "Lifegroup preferences" section and the boy/girl help text removed. DB columns stay (harmless).
- **Reports → Lifegroups / Network status:** columns renamed Closed cell · Open cell · Closed %. CSV headers: `closed_cell, open_cell, closed_pct`.
- QR per Lifegroup is **permanent and unique** (unchanged); the Leader link dialog now says so.
- Tests: 77/77 on SQLite and Postgres.

### 2026-10-10 update 3b — status list trimmed
Status choices are now **First Timer · Regular Attendee · Member · Leader · Inactive** (New Believer and Volunteer removed). Migration `012_status_cleanup.sql` runs automatically on first start and folds existing records in: New Believer → Regular Attendee, Volunteer → Member. Nothing is deleted.

### 2026-10-10 update 3c — leader QR page format + network leader rule (max 6)
- **Regular Lifegroup leader page is back to the original one-page format:** date → We met / No Lifegroup → tap names (+Devo) → Send report; below it the progress card with a collapsible **Members** list (Open cell / Closed cell buttons, *Not active*, *Bring back*). No tabs.
- **Network leader page** (leader whose group members are themselves leaders): tabs **My members** · **Weekly report** · **My leaders**. *My members* shows the open/closed-cell columns and, under each member, **the Lifegroup they handle** (name · members · closed cell · met / not yet reported this week).
- **Church rule enforced server-side:** a network leader's own Lifegroup holds **at most 6 members**. Admin *Add member*, the leader's "New person this week", *Bring back* and QR auto-placement all refuse the 7th with a clear message. Lifegroup list/detail show `n / 6` for those groups. Groups already above 6 keep their members (nothing is removed) but cannot add more.
- Demo seed now creates 14 networks with ≤6 leaders each.
- Tests: 78/78 on SQLite and Postgres.

### 2026-10-10 update 3d — closed cell capped at 6
The closed cell of every Lifegroup holds at most the solid target (6). Moving a 7th member to the closed cell is refused (409 "The closed cell is full (6)…") — they stay in the open cell. Matches the church diagram: network leader → 6 leaders → each with 6 closed-cell members + open cell. Demo seed respects it.

### 2026-10-10 update 3e — network leader page: "My cell leaders"
Network leader's QR page now has two tabs only: **My cell leaders** (names + their last-4-weeks presence in the network leader's Lifegroup; tap a name → that cell leader's own members in Open cell / Closed cell, movable there) and **Weekly report**. The network leader's own members are never sorted into open/closed cells — cells apply under each cell leader. Regular leaders keep the one-page format.

### 2026-10-10 update 3f — cell leader tracking on the network leader page
In **My cell leaders**, each name now shows a badge for *their* Lifegroup this week (**Held LG** / **No LG** / **No report**) next to the dots (present in the network leader's Lifegroup). Tapping the name shows "Their Lifegroup · n/4 held" (4-week strip) and **Who was present** — the last 4 reports with the names present or the no-meeting reason — above their Open / Closed cell. Public network view now includes `recent` per group (names only, no contact details).

## Update 3g — admin Lifegroup detail follows the church structure (2026-10-10)
- Capacity field removed from the Lifegroup form; the `capacity` column is ignored everywhere.
- Network leader's Lifegroup: tiles show **Cell leaders n/6** + **Their Lifegroups k (x solid)**; the Members card becomes a **Cell leaders** table (presence dots, their Lifegroup, members, Closed cell x/6, Open cell, last held, Remove).
- Regular Lifegroup: tiles **Members · Closed cell x/6 (green when solid) · Open cell (no limit) · Schedule**; Members card = Open cell (left) / Closed cell (right).
- API: `GET /api/lifegroups/:id` now also returns `led_groups` and `solid_target`; `max_members` is 6 for network-leader groups, otherwise null.
- Tests 78/78 on SQLite and Postgres. Upload the same way as before (update zip → GitHub upload → Commit to main → top Vercel row Ready → Ctrl+F5).

## Update 3h — click a cell leader to see their Open / Closed cell (2026-10-10)
- Admin detail of a network leader's Lifegroup: clicking a row in the **Cell leaders** table expands that leader's own Lifegroup — Open cell (left) / Closed cell (right) with 4-week dots. Staff can move members between cells right there (closed-cell cap of 6 still enforced); the summary row updates in place. Click again to collapse.
- Front-end only (public/js, public/css); no DB or API changes.

## Update 3i — Network QR per Network + simplified Lifegroup report tiles (2026-10-10)
- **Network page (`#/networks/:id`)**: top buttons **Report a meeting** and **Network QR**, plus a "Network QR" card under the title showing the QR of that Network only (link = the network leader's permanent leader link). Copy link / Print / **New QR** (resets the token so an old, leaked QR stops working). Every Network gets its QR automatically as soon as its leader leads a Lifegroup — nothing to set up.
- **Reports → Lifegroups**: the headline tiles are now two sections, **Boys** and **Girls**, each with only Networks · Cell leaders · Open cell · Closed cell (cell leaders = members of a network leader's Lifegroup; open/closed counts are from the ordinary Lifegroups).
- API: `GET /api/reports/network-status` adds `structure.{boys,girls}` = { networks, cell_leaders, lifegroups, open_cell, closed_cell, members }. Tests 78/78 on SQLite and Postgres.

## Update 3j — flat Networks, table-style Networks tab, move cells from the Network page (2026-10-10)
- **No more top-level / sub-networks.** Every Network has the same shape: Network leader → their Lifegroup (= the cell leaders, max 6) → each cell leader's own Lifegroup. The "Reports to (parent network)" field is gone from the Network form, the auto-network sync no longer links parents, and the Network page no longer shows "Top-level / Sub-network". (Existing data is untouched — the column simply isn't used.)
- **Lifegroups → Networks tab** is now a table like the Groups tab: Boys networks / Girls networks with Network · Network leader · Cell leaders n/6 · Lifegroups · Members · Closed cell · Open cell · Last held. Inactive networks are hidden behind a "Show n inactive" link.
- **Network page**: tiles are Cell leaders n/6 · Lifegroups · Members · Closed cell · Open cell; in the Structure tree each Lifegroup's Open / Closed cell now has **Closed → / ← Open** buttons (staff only; closed-cell cap of 6 still applies; the tree stays open after a move).
- **Demo data** now shows the full structure: "Demo Network A Leaders" (network leader's Lifegroup holding the 2 boys cell leaders) and "Demo Network B Leaders" for girls, plus the 4 ordinary demo Lifegroups. Reload demo data (Settings → Demo data → Remove, then Load) to see it.
- API: `GET /api/networks` rows add `cell_leaders`, `closed_cell`, `open_cell`, `last_held`. Tests 78/78 on SQLite and Postgres.

## Update 3k — structure shown on the leader QR page (2026-10-10)
- Every leader QR page now starts with a small **structure card**:
  - Network leader page: *Network leader → Cell leaders n / 6 (max 6 — bawal pang-7) → Each cell leader: Closed cell max 6 (= solid Lifegroup) + Open cell / new members (walang limit)*.
  - Regular leader page: *Closed cell x / 6 (max 6 — 6 = solid Lifegroup) · Open cell y (walang limit)*.
- "My cell leaders" header shows **n / 6 (max 6)**; each expanded cell leader shows *Closed cell x / 6 (solid ✓)* and *Open cell y*; the cell headers say *max 6 = solid* / *walang limit*.
- Weekly report tab of a network leader: progress bar = **My cell leaders n / 6**; the "+ New cell leader this week" button disappears at 6 with the note *Puno na — max 6 cell leaders. Bawal pang-7.* (the server also refuses a 7th).
- Front-end only (public/js/lifegroup.js, public/css/styles.css). Tests 78/78 on SQLite and Postgres.

## Update 3l — one "Network" tab, version stamp (2026-10-10)
- **Lifegroups page tabs are now: Network · Needs Lifegroup · Progress.** The old "Groups" and "Networks" tabs were merged into **Network**: Boys / Girls sections, one block per Network (name → network page & QR, network leader, cell leaders n/6, Lifegroups, members, closed/open cell) and under it the table of that Network's Lifegroups — the network leader's own Lifegroup first (tagged), then each cell leader's Lifegroup with Members · Closed cell x/6 · Open cell · Last held. Lifegroups without a Network are listed in a "No Network yet" block. Search / Boys / Girls / Active filters kept; old `?tab=networks` links land here.
- **Version stamp**: the sidebar shows `v2026.10.10-3m` under the church name and `/api/health` returns `version` — if the sidebar shows an older or no version, the browser is still on cached files (open an Incognito window or clear cached files).
- Tests 78/78 on SQLite and Postgres.

## Update 3m — cleaner Lifegroups header (2026-10-10)
- Removed the explanatory paragraph above the Network tab.
- The six tiles on the Lifegroups page (and the Dashboard "Lifegroup overview") now follow the structure: **Networks · Cell leaders · Lifegroups · Closed cell · Open cell · Without Lifegroup**, each with boys · girls underneath. Closed / Open cell count only the cell leaders' Lifegroups (the network leaders' own Lifegroups hold the cell leaders, so they are no longer mixed into those numbers). `GET /api/lifegroups/overview` adds `structure`.
- Version is now `v2026.10.10-3m`.

## Update 3n — independent networks, no sub-networks (2026-10-10)
**Rule (non-negotiable):** every Network leader is the root of their own independent Network. A Network leader is never under another Network leader; there are no sub-networks, parent networks or nested networks.

Enforced in three layers:
- **Database** — migration `013_networks_independent.sql` clears any old parent links (rows, leaders, Lifegroups and history are kept) and drops the parent index. On start the app adds a guard that the database itself enforces: Postgres `CHECK (parent_network_id IS NULL)` (`ck_networks_independent`), SQLite/libSQL `BEFORE INSERT/UPDATE` triggers that abort. Restoring an old backup that contained nested networks flattens them.
- **Backend** — `POST/PUT /api/networks` refuse any `parent_network_id` / `parent_id` / `parent` (400 "Networks are independent…"); responses no longer carry `parent_network_id`, `parent_name`, `child_count` or `children`; `total_*` = the network's own counts. One person leads exactly one active Network. A person who is still a member of someone's Lifegroup cannot be made a Network leader (remove them first). A Network leader can never be added as a member of any Lifegroup (409). A Network leader's own Lifegroup always lives in their own Network — pinning it to another Network is refused (400). Auto-networks follow the membership chain up to the root leader only; nothing is ever nested. A Network leader "reports to" nobody and is never listed under "Needs Lifegroup". On start the server re-derives the Lifegroup → Network links once.
- **Frontend** — one card per Network on the Lifegroups → Network tab (network leader's Lifegroup first, then the cell leaders' Lifegroups); the Network page shows only that Network (root = network leader with the cell leaders listed, children = cell leaders' Lifegroups); no parent picker anywhere; the Progress tab labels the network leader's Lifegroup and shows "n / 6 cell leaders" instead of a closed-cell badge.
- Network counts (Lifegroups, members, Closed/Open cell) exclude the network leader's own Lifegroup (it holds the cell leaders, which are counted as "Cell leaders n / 6").
- Tests: new "Independent networks" test covers the 7 required scenarios (create A, create B while A exists, several leaders, every way of nesting rejected via API, cells belong only to their network, no shared members/permissions, DB-level guard); 79/79 on SQLite and Postgres.
- Version `v2026.10.10-3n`.

## Update 3o — Network QR always loads (2026-10-10)
- Before: a Network whose leader had no Lifegroup yet showed an empty QR box ("… does not lead a Lifegroup yet"). The Network QR is the leader's own Lifegroup link, so without that Lifegroup there was nothing to show.
- Now: opening a Network page (staff/admin) creates the leader's own Lifegroup once — **"<Network name> Leaders"** (same boys/girls type, in that Network, holds the cell leaders, max 6) — and the QR, Copy link, Link/print/New QR and Report a meeting all work immediately. Never duplicated; if the leader already leads a Lifegroup that one is used.
- New endpoint `POST /api/networks/:id/leader-group` (lifegroups:manage) → `{ lifegroup_id, name, created }`; clear 400 messages when the Network has no registered leader or no boys/girls type (press Edit first).
- QR-only change; nothing else touched. Version `v2026.10.10-3o`.
