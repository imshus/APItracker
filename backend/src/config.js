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
  token: process.env.TRACKER_TOKEN || '',
  trustLocalhost: String(process.env.TRUST_LOCALHOST).toLowerCase() === 'true',
  intervalMinutes: Math.max(1, num(process.env.CHECK_INTERVAL_MINUTES, 30)),
  expiryWarnDays: num(process.env.EXPIRY_WARN_DAYS, 15),
  slowMs: num(process.env.SLOW_MS, 5000),
  msg91LowBalance: num(process.env.MSG91_LOW_BALANCE, 100),
  pdfmonkeyLowDocs: num(process.env.PDFMONKEY_LOW_DOCS, 20),
  memoryWarnPct: num(process.env.MEMORY_WARN_PCT, 85),
  mongoLimitMb: num(process.env.MONGO_STORAGE_LIMIT_MB, 0),
  trackUrls: list(process.env.TRACK_URLS),
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
