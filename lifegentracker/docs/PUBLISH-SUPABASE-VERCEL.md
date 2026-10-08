# LifegenTracker — Publish sa Vercel + Supabase (≈ 15 minuto, LIBRE)

Kailangan mo lang: **laptop + browser + Gmail**. Walang credit card. Walang i-i-install.
Tatlong account ang gagawin, lahat gamit ang isang GitHub login: **GitHub → Supabase → Vercel**.

> Ihanda muna: i-download ang **`lifegentracker-deploy.zip`** at i-extract sa Desktop.
> Makikita mo ang folder `lifegentracker/` na may `package.json`, `server.js`, `api/`, `src/`, `public/`, atbp.

---

## HAKBANG 1 — GitHub (dito nakalagay ang code) · 4 min

1. Pumunta sa **https://github.com/signup** → gumawa ng account (o mag-sign in).
2. Click **"+"** (kanan-taas) → **New repository**
   - Repository name: `lifegentracker`
   - **Private** ✅ (para hindi public ang code)
   - Click **Create repository**
3. Sa susunod na page click **"uploading an existing file"** (nasa gitna ng text).
4. Buksan ang na-extract na folder `lifegentracker/` sa File Explorer, **select ALL** ang laman
   (Ctrl+A) at **i-drag papunta sa browser** (Chrome o Edge — kaya nitong mag-drag ng folders).
   > Dapat ang `package.json` ay nasa **root** ng repo, hindi nasa loob ng isang `lifegentracker/` folder.
5. Hintaying matapos ang upload → ibaba, click **Commit changes**.
6. ✅ Check: sa repo page makikita mo ang `api`, `src`, `public`, `vercel.json`, `package.json`.

---

### Para sa repo mo: `rivasyhail-svg/lifegentracker`

| Ano | Link |
|---|---|
| Upload page (dito i-drag ang files) | **https://github.com/rivasyhail-svg/lifegentracker/upload/main** |
| Repo | https://github.com/rivasyhail-svg/lifegentracker |
| Gawing **Private** (inirerekomenda) | https://github.com/rivasyhail-svg/lifegentracker/settings → ibaba, *Danger Zone* → **Change visibility → Private** |
| Check pagkatapos mag-upload (dapat bumukas lahat) | https://github.com/rivasyhail-svg/lifegentracker/blob/main/package.json · https://github.com/rivasyhail-svg/lifegentracker/blob/main/vercel.json · https://github.com/rivasyhail-svg/lifegentracker/blob/main/api/index.js · https://github.com/rivasyhail-svg/lifegentracker/blob/main/server.js · https://github.com/rivasyhail-svg/lifegentracker/tree/main/src/db/migrations |

**Ang ia-upload = laman ng `lifegentracker-deploy.zip`** (86 files, 240 KB). I-extract muna, pagkatapos i-drag ang lahat ng ito:

```
package.json  package-lock.json  server.js  vercel.json  README.md  start.sh      ← files
api/          src/          public/          docs/          scripts/     tests/     ← folders (buong folder i-drag)
Dockerfile  docker-compose.yml  fly.toml  render.yaml                               ← files (para sa ibang host; ok lang isama)
.gitignore  .vercelignore  .dockerignore                                            ← optional (hidden files; ok kung hindi kasama)
```

HUWAG isama: `node_modules/`, `data/`, `vendor-node_modules.tgz`, `single-file/`, `standalone/` (hindi kailangan ng Vercel; ang `data/` ay may local DB mo).

**Alternatibo (kung may VS Code/Git ka):** buksan ang na-extract na folder sa VS Code → Terminal:
```
git init
git add .
git commit -m "LifegenTracker"
git branch -M main
git remote add origin https://github.com/rivasyhail-svg/lifegentracker.git
git push -u origin main
```

## HAKBANG 2 — Supabase (dito nakalagay ang database) · 4 min

1. **https://supabase.com** → **Start your project** → **Continue with GitHub** → Authorize.
2. Gumawa ng organization kung tatanungin (Name: `Lifegen`, Plan: **Free**).
3. **New project**:
   - Project name: `lifegen`
   - Database password: click **Generate a password** → **COPY at i-save sa Notes** (hindi na ito
     ipapakita ulit) 🔑
   - Region: **Southeast Asia (Singapore)** ← importante (malapit sa PH)
   - Click **Create new project** → hintayin 1–2 min hanggang maging "Project is ready".
4. Kunin ang connection string: click **Connect** (button sa itaas ng dashboard)
   - Tab **Connection String** → Type: **URI**
   - Method / Mode: piliin ang **Session pooler** ⚠️ (HUWAG ang "Direct connection" — IPv6 lang iyon at
     hindi maaabot ng Vercel)
   - Makikita ang ganito:
     ```
     postgresql://postgres.abcdefghijklmnop:[YOUR-PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres
     ```
   - I-copy sa Notes at **palitan ang `[YOUR-PASSWORD]`** (kasama ang mga bracket) ng password mula step 3.
     Kung may `@ # / : ? %` ang password, mas madali: bumalik sa **Project Settings → Database → Reset
     database password** at gumawa ng letters+numbers lang.
5. ✅ Dapat ganito na ang itsura ng final na URI mo:
   `postgresql://postgres.abcdefghijklmnop:MyStrongPass123@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`

---

## HAKBANG 3 — Vercel (dito tumatakbo ang website) · 4 min

1. **https://vercel.com/signup** → **Continue with GitHub** → piliin **Hobby** (free) → Authorize.
2. **Add New… → Project** → sa listahan hanapin ang `lifegentracker` → **Import**
   (kung wala sa listahan: *Adjust GitHub App Permissions* → payagan ang repo).
3. Sa **Configure Project**:
   - Framework Preset: **Other**
   - Root Directory: `./` (iwan)
   - Build & Output Settings: **iwan blangko** (walang build command)
   - Buksan ang **Environment Variables** at idagdag ang **TATLO**:

     | Key | Value |
     |---|---|
     | `LIFEGEN_DB_URL` | ang Supabase URI mula Hakbang 2 (may password na) |
     | `LIFEGEN_AUTH` | `on` |
     | `LIFEGEN_AUTO_BACKUP` | `off` |

4. Click **Deploy** → hintayin 2–4 min → "Congratulations!" → click **Visit** / **Continue to Dashboard**.
5. Ang website mo: **`https://lifegentracker-xxxx.vercel.app`** (nasa Dashboard → Domains).
   Sa unang pagbukas, ginagawa ng app ang lahat ng tables sa Supabase (automatic, ~5 segundo).

---

## HAKBANG 4 — Unang setup ng app · 3 min

1. Buksan ang Vercel URL → lalabas ang **First-run setup** → gumawa ng **Admin** account
   (username + malakas na password; **hindi** ito ang Supabase password — ibang password ito). Isulat sa Notes.
2. Mag-login → **Settings**
   - **Church details**: Lifegiver Church of Faith / Lifegen 3rd Service (naka-default na, i-edit kung kailangan)
   - **QR registration**: i-ON → **Public URL** = ilagay ang Vercel URL mo (hal. `https://lifegentracker-xxxx.vercel.app`)
     → Save → **Print poster** (A4) o **Download QR**.
3. **Test gamit ang cellphone**: i-scan ang QR (o buksan ang `…vercel.app/register`) → mag-fill-up ng test
   registration → sa laptop: **Registrations** → dapat lumabas as *Pending* → **Approve** → makikita sa **People**.
4. Gumawa ng accounts ng staff: Settings → **Users** → Add (role: Attendance Staff o Viewer).
5. (Opsyonal) Settings → **Demo data → Remove** kung may nilagay kang demo; **Download backup (JSON)** para masanay.

🎉 **Tapos na — live na ang LifegenTracker.**

---

## Lingguhang paalala (importante sa FREE tier)

| Gawin | Bakit |
|---|---|
| **Buksan ang app kahit isang beses kada linggo** (Sunday attendance = sapat na) | Ang Supabase free project ay **nag-pa-pause pagkatapos ng 7 araw na walang gumagamit**. Kapag na-pause: lalabas "Unexpected server error" → pumunta sa supabase.com → project → **Restore project** (≈1 min) → ok na ulit. Walang data na nawawala. |
| **Download backup (JSON)** kada buwan (Settings → Backup) | Libreng Supabase ay walang automatic backups. Ang JSON ay puwedeng i-restore kahit saan (laptop/SQLite din). |
| Huwag i-share ang Supabase password / URI | Iyon ang susi ng buong database. Admin password ng app lang ang ibigay sa staff. |

---

## Kung may problema

| Nakita mo | Dahilan | Ayos |
|---|---|---|
| Vercel build "Error" / red | Mali ang upload (wala ang `package.json` sa root) | Sa GitHub dapat `package.json` ang nasa unang page ng repo. Ayusin, saka Vercel → Deployments → **Redeploy**. |
| Page nagbubukas pero "Unexpected server error" | (a) Supabase paused, o (b) maling `LIFEGEN_DB_URL` | (a) Supabase → **Restore project**. (b) Vercel → Settings → Environment Variables → i-edit ang URL (Session pooler, port **5432**, tamang password, walang `[ ]`) → **Save** → Deployments → **Redeploy** (hindi awtomatiko ang redeploy pagkatapos mag-edit ng env). |
| Vercel log: `ENETUNREACH` o `connect ETIMEDOUT` | Ginamit ang **Direct connection** (IPv6) | Palitan ng **Session pooler** URI (`…pooler.supabase.com:5432`). |
| Vercel log: `password authentication failed` | Mali/na-encode nang mali ang password | Reset password sa Supabase (letters+numbers lang), i-update ang env var, Redeploy. |
| "Tenant or user not found" | Mali ang user part (`postgres.<ref>`) | Kopyahin ulit ang buong URI mula sa Connect → Session pooler. |
| QR nag-o-open pero "Registration is closed" | Naka-OFF ang QR registration | Settings → QR registration → ON → Save. |
| Nakalimutan ang admin password | — | Supabase → **SQL Editor** → run: `DELETE FROM users;` → buksan ulit ang site → lalabas muli ang first-run setup (mabubura lang ang user accounts, hindi ang people/attendance). |
| Gusto ng sariling domain (hal. `lifegen.lifegiver.ph`) | — | Vercel → Project → Settings → Domains → Add. Pagkatapos i-update ang **Public URL** sa Settings → QR at i-print muli ang poster. |

**Saan tingnan ang logs:** Vercel → project → **Logs** (o Deployments → latest → Functions). Kopyahin ang red line kung
magpapatulong.

---

## Mabilis na buod (cheat sheet)

```
GitHub   : New repo "lifegentracker" (Private) → upload laman ng zip → Commit
Supabase : New project "lifegen" · Singapore · save password → Connect → URI → Session pooler → palitan [YOUR-PASSWORD]
Vercel   : Import repo · Framework = Other · Env: LIFEGEN_DB_URL / LIFEGEN_AUTH=on / LIFEGEN_AUTO_BACKUP=off → Deploy
App      : First-run setup (admin) → Settings → QR registration ON + Public URL → Print poster → test scan
Weekly   : buksan ang app (iwas 7-day pause) · Monthly: Download backup JSON
```
