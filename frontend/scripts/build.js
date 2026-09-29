// Builds the static web app: src/ -> dist/, plus config.js telling the page
// where the API is. dist/ can be served by any static host (nginx, server.js).
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./env');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

function build() {
  const env = loadEnv();
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  for (const name of fs.readdirSync(SRC)) {
    const from = path.join(SRC, name);
    if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(DIST, name));
  }
  fs.writeFileSync(path.join(DIST, 'config.js'), `window.APITRACKER_CONFIG = ${JSON.stringify({ apiUrl: env.apiUrl })};\n`);
  return env;
}

if (require.main === module) {
  const env = build();
  console.log(`Built frontend/dist (API: ${env.apiUrl || 'same address, /api'})`);
}

module.exports = { build };
