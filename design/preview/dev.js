// Preview the dashboard without API keys: a mock API (4310), the real frontend server (4300)
// pointed at it, and an Android-style phone frame (4301). All data is fake.
//   node design/preview/dev.js   ->   open http://localhost:4301
const path = require('path');
const fs = require('fs');
const http = require('http');

process.env.BACKEND_URL = 'http://127.0.0.1:4310';
process.env.API_URL = '';
process.env.FRONTEND_PORT = '4300';
require('./mock-api.js');
require(path.join(__dirname, '..', '..', 'frontend', 'server.js'));

const phoneFile = path.join(__dirname, 'phone.html');
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(phoneFile));
}).listen(4301, () => console.log('Android phone view on http://localhost:4301'));
