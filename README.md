# APItracker

One dashboard for every API key MRPscan runs on: is the key valid, how much balance/quota is left, when something expires, and a log of every issue.

## Layout

| Folder | What | Port |
|---|---|---|
| `backend/` | API only: runs the checks, holds the keys (`backend/.env`), stores `backend/data/state.json` | 4310 (127.0.0.1) |
| `frontend/` | Dashboard (`src/` → `dist/`) + a zero-dependency server that forwards `/api` to the backend | 4300 |
| `android/` | Phone app (WebView of the frontend) | — |

## Run

Double-click **`Start APItracker.cmd`** (starts both), or:

```
npm run setup      # backend packages, once
npm start          # backend + frontend
npm run start:backend
npm run start:frontend
```

Open http://localhost:4300. Checks run on start and every `CHECK_INTERVAL_MINUTES` (30); **Check all now** / **Check** run them on demand.

## What is tracked

| Service | Checks (all free, read-only) | Shows |
|---|---|---|
| OpenAI | `GET /v1/models/{OPENAI_MODEL}` | key valid, model access |
| Google Gemini | `GET /v1beta/models/gemini-2.5-flash-lite` | key valid, model access |
| Razorpay | `GET /v1/payments?count=1` | key valid, live/test, latest payment, webhook-secret sanity |
| MSG91 | `validate.php` + `balance.php` | key valid, SMS balance |
| Resend | `GET /domains` | key valid, domain verification |
| Sandbox GST | `POST /authenticate` | keys valid, access-token expiry |
| PDFMonkey | `GET /current_user`, both templates | documents left, plan, trial end, templates exist |
| metals.dev | `GET /usage` (does not use quota) | requests left this month |
| MongoDB Atlas | ping + dbStats | reachable, size, documents |
| Redis | PING + INFO | reachable, keys, memory |
| Server secrets | local only | JWT / e-invoice key present and strong |
| URLs (`PRATHAM_AI_URL`, `TRACK_URLS`) | GET + TLS handshake | up, latency, certificate expiry |

**Expiry dates**: from the APIs (TLS certificates, trials, tokens) plus any you add with **Set expiry** (plan renewal, credit top-up…). Warnings start `EXPIRY_WARN_DAYS` (15) before.

**Issues**: a failing or warning check opens an issue; it closes itself when the check passes. The backend (or anything else) can also log problems it hits in real use:

```
POST /api/issues
{ "service": "openai", "message": "429 during scan", "level": "warn", "detail": "…" }
```

## Deploy (apitracker.mrpscan.com)

The backend also serves the dashboard at `/` (`SERVE_FRONTEND=true`), so the server runs one process. It needs Node 18+, PM2 and nginx.

```bash
git clone https://github.com/imshus/APItracker.git
cd APItracker/backend
npm ci --omit=dev
cp .env.example .env
nano .env
pm2 start src/server.js --name apitracker
pm2 save
sudo cp ../deploy/apitracker.conf /etc/nginx/conf.d/apitracker.conf
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d apitracker.mrpscan.com
```

In `backend/.env` on the server:
- `TRACKER_HOST=127.0.0.1`, `TRACKER_PORT=4310` (nginx proxies to it).
- The keys: paste them below the settings, or set `WATCH_ENV_FILE=/path/to/mrpscan/backend/.env` to read the MRPscan backend's own .env (re-read every run, so rotated keys show up without a restart).

Update later: `git pull && pm2 restart apitracker`.

## Phone app (APK)

`APItracker.apk` (source in `android/`) opens the frontend's dashboard. It holds no API keys.

- Default address = `http://apitracker.mrpscan.com` (nginx redirects to https once certbot has run). **Server** (top of the dashboard) or the connect screen changes it.
- Laptop on the same Wi-Fi instead: enter `http://<laptop IP>:4300` (the frontend listens on the Wi-Fi; allow Node through the Windows firewall).
- Rebuild: `cd android` → `gradlew assembleRelease` with `JAVA_HOME` = Android Studio's `jbr`. `android/.env` `SERVER_URL` bakes a different default. Signing key: `android/app/keystore/apitracker.jks` + `android/keystore.properties` — back them up; every update must be signed with the same key.

## Settings

`backend/.env` (copy `backend/.env.example`):
- `TRACKER_PORT` (4310), `TRACKER_HOST` (127.0.0.1 = only the frontend server on this machine reaches it)
- No sign-in: anyone who can open the address sees the dashboard (keys are only ever shown masked).
- Manual **Check** skips a service checked in the last 30 s, so clicks cannot hammer the providers.
- `CORS_ORIGINS` dashboards allowed to call the backend straight from the browser (only needed with frontend `API_URL`)
- `WATCH_ENV_FILE` read keys from another .env (e.g. the MRPscan backend's) — re-read every run
- `TRACK_URLS` extra URLs, comma separated
- Optional thresholds: `EXPIRY_WARN_DAYS`, `MSG91_LOW_BALANCE`, `PDFMONKEY_LOW_DOCS`, `SLOW_MS`, `MEMORY_WARN_PCT`, `MONGO_STORAGE_LIMIT_MB` (512, Atlas free plan), `REDIS_MEMORY_LIMIT_MB` (30, Redis Cloud free plan)

`frontend/.env` (nothing secret): `FRONTEND_PORT` (4300), `FRONTEND_HOST` (0.0.0.0), `BACKEND_URL` (http://127.0.0.1:4310), `API_URL` (empty = forward through this server).

Key values never leave the backend: the dashboard and `state.json` only hold masked forms.
