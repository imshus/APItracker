'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '..');
const OWN_ENV = path.join(ROOT, '.env');
dotenv.config({ path: OWN_ENV });

const num = (value, fallback) => {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
};
const list = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);

const settings = {
  root: ROOT,
  port: num(process.env.TRACKER_PORT, 4310),
  host: process.env.TRACKER_HOST || '127.0.0.1',
  corsOrigins: list(process.env.CORS_ORIGINS ?? 'http://localhost:4300,http://127.0.0.1:4300').map((o) => o.replace(/\/+$/, '')),
  intervalMinutes: Math.max(1, num(process.env.CHECK_INTERVAL_MINUTES, 30)),
  expiryWarnDays: num(process.env.EXPIRY_WARN_DAYS, 15),
  slowMs: num(process.env.SLOW_MS, 5000),
  msg91LowBalance: num(process.env.MSG91_LOW_BALANCE, 100),
  pdfmonkeyLowDocs: num(process.env.PDFMONKEY_LOW_DOCS, 20),
  memoryWarnPct: num(process.env.MEMORY_WARN_PCT, 85),
  // Plan limits the providers do not report (defaults: the free plans,
  // Atlas M0 512 MB and Redis Cloud 30 MB). 0 hides them.
  mongoLimitMb: num(process.env.MONGO_STORAGE_LIMIT_MB, 512),
  redisLimitMb: num(process.env.REDIS_MEMORY_LIMIT_MB, 30),
  trackUrls: list(process.env.TRACK_URLS),
  // Email updates over the backend's SMTP account: who gets them, the IST
  // hour of the daily summary ("off" = issue emails only) and the link in them.
  alertEmailTo: list(process.env.ALERT_EMAIL_TO),
  // Optional Gmail sender for the updates. Google shows App Passwords in
  // groups of four; the spaces are not part of it.
  alertGmailUser: String(process.env.ALERT_GMAIL_USER || '').trim(),
  alertGmailPass: String(process.env.ALERT_GMAIL_APP_PASSWORD || '').replace(/\s+/g, ''),
  dailySummaryHour: (() => {
    const v = String(process.env.DAILY_SUMMARY_HOUR ?? '9').trim().toLowerCase();
    if (v === '' || v === 'off') return -1;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 23 ? n : 9;
  })(),
  dashboardUrl: (process.env.DASHBOARD_URL || 'https://apitracker.mrpscan.com').replace(/\/+$/, ''),
  // GST screen: full phone numbers only on purpose (the dashboard is public).
  gstShowPhones: String(process.env.GST_SHOW_PHONES || '').trim().toLowerCase() === 'true',
  // Only for tests against a fake OpenAI; the real API otherwise.
  openaiApiBase: (process.env.OPENAI_API_BASE || 'https://api.openai.com').replace(/\/+$/, ''),
  serveFrontend: String(process.env.SERVE_FRONTEND ?? 'true').toLowerCase() !== 'false',
  frontendDir: path.resolve(ROOT, process.env.FRONTEND_DIR || '../frontend/src'),
  watchEnvFile: process.env.WATCH_ENV_FILE ? path.resolve(ROOT, process.env.WATCH_ENV_FILE) : OWN_ENV,
  dataFile: process.env.DATA_FILE ? path.resolve(ROOT, process.env.DATA_FILE) : path.join(ROOT, 'data', 'state.json'),
  // Fetched before every run: when this fails the tracker itself is offline
  // and the run is skipped instead of blaming every API.
  connectivityUrl: process.env.CONNECTIVITY_URL || 'https://www.gstatic.com/generate_204',
};

// Re-read on every run so a rotated key is picked up without a restart.
function readWatchedEnv() {
  return dotenv.parse(fs.readFileSync(settings.watchEnvFile, 'utf8'));
}

module.exports = { settings, readWatchedEnv };
