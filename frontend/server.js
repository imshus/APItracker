// APItracker frontend server (no dependencies), separate from the backend project.
// Builds dist/, serves it on FRONTEND_PORT, and forwards /api/* to the backend
// (BACKEND_URL) so browsers and the phone app use one address. If API_URL is set,
// the browser calls the backend directly instead (backend CORS_ORIGINS must allow it).
// In production nginx can do the same job: serve frontend/dist and proxy /api.
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { build } = require('./scripts/build');

const env = build();
const DIST = path.join(__dirname, 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const backend = new URL(env.backendUrl);
const client = backend.protocol === 'https:' ? https : http;

function forward(req, res) {
  const headers = { ...req.headers, host: backend.host };
  const visitor = req.socket.remoteAddress || '';
  // Append the real visitor so the backend can tell a phone from this computer.
  headers['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for']}, ${visitor}` : visitor;
  delete headers['x-real-ip'];
  const upstream = client.request({
    protocol: backend.protocol, hostname: backend.hostname, port: backend.port,
    method: req.method, path: req.url, headers,
  }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  upstream.setTimeout(120000, () => upstream.destroy(new Error('Backend timed out')));
  upstream.on('error', (err) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Backend not reachable at ${env.backendUrl} (${err.message}). Start it with: npm start --prefix backend` }));
  });
  req.pipe(upstream);
}

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { urlPath = '/'; }
  let file = path.normalize(path.join(DIST, urlPath));
  if (file !== DIST && !file.startsWith(DIST + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.url === '/api' || req.url.startsWith('/api/')) return forward(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res);
});

server.listen(env.port, env.host, () => {
  console.log(`APItracker dashboard on http://localhost:${env.port}  (forwarding /api to ${env.backendUrl})`);
  const lan = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) lan.push(`http://${a.address}:${env.port}`);
  if (env.host === '0.0.0.0' && lan.length) console.log(`Phone / LAN address: ${lan.join('  ')}`);
});
