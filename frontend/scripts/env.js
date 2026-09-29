// Minimal .env reader (no dependencies). Values already in process.env win.
const fs = require('fs');
const path = require('path');

function loadEnv(file = path.join(__dirname, '..', '.env')) {
  const out = {};
  if (fs.existsSync(file)) {
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let value = m[2];
      if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
      out[m[1]] = value;
    }
  }
  const pick = (key, fallback) => {
    const v = process.env[key] ?? out[key];
    return v === undefined || v === '' ? fallback : v;
  };
  return {
    port: Number(pick('FRONTEND_PORT', '4300')),
    host: pick('FRONTEND_HOST', '0.0.0.0'),
    backendUrl: pick('BACKEND_URL', 'http://127.0.0.1:4310').replace(/\/+$/, ''),
    apiUrl: pick('API_URL', '').replace(/\/+$/, ''),
  };
}

module.exports = { loadEnv };
