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
