# Stock GMAO — mobile stock app

A minimal mobile app for the stock module of your GMAO (CMMS) ERP: search articles,
issue stock (BSM), receive against purchase orders, and return stock (BRM).

Two parts:
- **`backend/`** — a small Node/Express "connector" service. It is the only thing
  that talks to SQL Server, using the same tables the desktop app uses
  (`article`, `bsm`/`bsm_article`, `reception`/`reception_article`,
  `brm`/`brm_article`, `commande`/`commande_article`, `utilisateur`, etc.).
- **`frontend/`** — a single mobile-first HTML page. Works in any phone browser,
  and can be "installed" to the home screen (PWA) so it feels like a native app.

## Why there's a backend at all

Phones can't open a raw SQL Server (TDS) connection, and shipping your database
password inside an app that leaves the building is a real exposure — anyone
can pull it back out (that's literally how I read your desktop app's schema
for this project). The backend here is intentionally thin: it does *only* the
four operations you asked for, with parameterized queries, no ORM, no extra
abstraction — about as close to "direct" as this can safely get.

## Setup

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env
# edit .env: DB_SERVER, DB_NAME, DB_USER, DB_PASSWORD, JWT_SECRET
npm start
```

Create a **dedicated SQL Server login** for this service (not `sa`, not the
desktop app's own account) and grant it only what it needs: `SELECT` on the
tables it reads, `SELECT/INSERT/UPDATE` on `article`, `bsm`, `bsm_article`,
`bsm_equipement`, `brm`, `brm_article`, `reception`, `reception_commande`,
`reception_article`, `modification_article`.

Runs on `http://localhost:4000` by default. Deploy it on a machine on the
same network as SQL Server (or reachable from it), reachable by phones over
your Wi-Fi/VPN.

### 2. Frontend — install it like a real app, on any phone

`frontend/` is a PWA (Progressive Web App): `manifest.json` + `sw.js` (offline
app-shell caching) + icons, no app store needed, works on both Android and
iPhone. Host the whole `frontend/` folder on **any HTTPS web server**
(HTTPS is required for install/offline to work — `localhost` is also fine
for testing on the same machine, e.g. Netlify, Vercel, GitHub Pages, your
own nginx with a certificate, or served straight from the backend).

Before deploying, point it at your backend — open `index.html` and either:
- hardcode it: change the `API_BASE` fallback near the top of the `<script>`, or
- set it once per device from the phone's browser console:
  ```js
  window.localStorage.setItem('gmao_api_base', 'http://YOUR-SERVER-IP:4000/api');
  ```

**Installing on a phone:**
- **Android (Chrome)**: open the page → a banner offers "Installer" → tap
  it → app icon appears on the home screen, opens full-screen, no browser
  chrome.
- **iPhone (Safari only — Chrome on iOS can't install PWAs)**: open the
  page → the banner tells you to tap Share → "Sur l'écran d'accueil" /
  "Add to Home Screen".

Once installed it behaves like a native app: its own icon, full-screen (no
address bar), and the app shell still opens with no connection — only live
stock actions need the network.

**If you need it in an app store** (company MDM, internal enterprise store,
or you want push notifications/barcode-scanner hardware access beyond what
a browser allows), the same `frontend/` code can be wrapped with
[Capacitor](https://capacitorjs.com/) into a real Android `.apk`/`.aab` and
iOS `.ipa` with minimal changes — ask if you want that scaffolded too.

## Known gaps / things to verify before going live

- **Passwords**: `utilisateur.mot_passe` is compared in plaintext in the
  original app. The backend supports bcrypt hashes but falls back to
  plaintext for un-migrated rows — plan to hash existing passwords.
- **`commande.statut` codes**: the exact status enum wasn't recoverable from
  the decompiled source, so "open purchase orders" is computed from
  ordered-vs-received quantities instead of the status field. Cross-check
  against your live data if you also want to exclude e.g. cancelled orders.
- **Concurrent stock writes**: BSM/BRM/reception use SQL transactions with
  row locks so two people can't oversell the same part at the same instant —
  worth a load test with your real DB before rollout.
- **No offline mode yet**: the app needs connectivity to your backend for
  every action. If warehouse Wi-Fi is patchy, offline queuing would be a
  good next addition.
- **Multi-warehouse (`magasin`) filtering** is wired into article search but
  not yet surfaced as a picker in the UI — easy to add once you confirm
  whether users work one warehouse at a time or need to switch.

## Extending

The three other stock features from your analysis — DA (purchase requests),
commande creation, and reporting/valorisation — aren't built yet; the route
structure (`backend/src/routes/`) is set up so each is a same-shaped addition
when you're ready.

## Run the backend automatically at boot (Windows)

Right-click `install-autostart.bat` > *Run as administrator*. It creates a scheduled task "GMAO Backend"
that starts the backend when the PC boots (no login needed) and restarts it 5 s after a crash.
Logs: `backend\logs\backend.log`. Remove it with `uninstall-autostart.bat`. Close `start-backend.bat` first
(only one copy can use port 4000).

## Security settings (backend/.env, all optional)

- `JWT_SECRET` - use a long random value (24+ characters); a warning is logged otherwise.
- `LOGIN_MAX_FAILS` (default 5) - wrong passwords per login and client before a 15-minute lock.
- `RATE_LIMIT_PER_MIN` (default 600) - API requests per minute per client.
- `CORS_ORIGIN` - comma separated list of allowed web origins. Default: the Android app only
  (`http://localhost`, `capacitor://localhost`...). Use `*` to allow everything (not recommended).

## Extra app tables (GMAO_APP, run once in SSMS)

`sql/05_di_photos.sql` (DI photos), `sql/06_engin_seuil.sql` (per-engine fuel alert threshold),
`sql/07_user_permissions.sql` (per-user feature permissions), `sql/08_ot_notes.sql` (OT notes and closing requests),
`sql/09_client_ref.sql` (protects against a BSM / DI sent twice by the offline queue).

## Permissions per user

Administrators open *Utilisateurs* > 🔐 next to a user and tick / untick every feature of the app. Only the exceptions
to the role's defaults are stored. Set `PERMISSION_ADMINS=marwen` in `.env` to limit who may edit permissions to
the listed logins (default: every Administrateur).

## Offline use on the phone

Recent lists (DI, OT, agenda, DA, reference data, stock alerts, fuel) stay readable without network, with a bar saying
so. A new BSM or DI created without network is kept on the phone and sent automatically when the server answers again
(tap the bar to see / cancel the queue). If the request is refused at that time (for example not enough stock any
more) it stays in the queue with the reason.

## Know when the backend is down (external monitor)

A stopped backend cannot send a notification itself, so use a free external monitor:

1. Create an account on UptimeRobot (or Better Stack / Freshping) and add an **HTTP(s) monitor**.
2. URL: `https://gmao.ibb.sarl/api/health?deep=1` - answers 200 when the web server and both SQL databases work, 503 when the
   database cannot be reached. Interval: 5 minutes.
3. Add your phone as an alert contact (e-mail and/or the monitor's mobile app) so you are warned within minutes.

`run-backend-loop.bat` (installed by `install-autostart.bat`) already restarts the backend after a crash; this monitor
covers a stopped PC, a lost internet connection or a stopped Cloudflare tunnel.

## Xiaomi phones

See `docs/NOTIFICATIONS_XIAOMI.md` (autostart, battery and lock settings so that notifications arrive).
