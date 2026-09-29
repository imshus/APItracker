'use strict';

// APItracker backend: the JSON API. The dashboard is the separate frontend
// project, whose server forwards /api here (or the browser calls it directly
// when the frontend's API_URL is set and its address is in CORS_ORIGINS).
// When the frontend sits next to it (SERVE_FRONTEND, default on) the backend
// also serves the dashboard at /, so a server needs only this process.
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { settings } = require('./config');
const { Store } = require('./store');
const { Runner } = require('./runner');
const { evaluate } = require('./evaluate');
const incidents = require('./incidents');
const { createAuth } = require('./auth');

const store = new Store(settings.dataFile);
const runner = new Runner(store, settings);
const auth = createAuth(settings);
const { originAllowed } = auth;

function uptime(history, now) {
  const week = history.filter((h) => now - Date.parse(h.t) <= 7 * 24 * 3600 * 1000 && h.s !== 'off');
  if (!week.length) return null;
  return Math.round((1000 * week.filter((h) => h.s !== 'down').length) / week.length) / 10;
}

function overview() {
  const { state } = store;
  const now = Date.now();
  const services = runner.services().map((s) => {
    const result = state.results[s.id] || null;
    const meta = state.meta[s.id] || {};
    const ev = evaluate(result, meta, settings, now);
    const history = state.history[s.id] || [];
    const open = state.incidents.find((i) => i.serviceId === s.id && !i.resolvedAt);
    return {
      id: s.id,
      name: s.name,
      category: s.category,
      purpose: s.purpose,
      envVars: s.envVars,
      links: s.links,
      everyMinutes: Math.max(settings.intervalMinutes, s.everyMinutes || 0),
      meta,
      result,
      status: ev.status,
      problems: ev.problems,
      expiries: ev.expiries,
      history: history.slice(-40),
      uptime7d: uptime(history, now),
      checking: runner.checking.has(s.id),
      openIssueId: open ? open.id : null,
    };
  });
  return {
    now: new Date(now).toISOString(),
    lastRun: state.lastRun,
    nextRunAt: runner.nextRunAt ? new Date(runner.nextRunAt).toISOString() : null,
    intervalMinutes: settings.intervalMinutes,
    expiryWarnDays: settings.expiryWarnDays,
    watchEnvFile: path.relative(settings.root, settings.watchEnvFile) || settings.watchEnvFile,
    envError: runner.envError,
    openIssues: state.incidents.filter((i) => !i.resolvedAt).length,
    services,
  };
}

const app = express();
app.disable('x-powered-by');

// CORS: only for a frontend that calls this API straight from the browser
// (frontend API_URL set). Through the frontend server it is not needed.
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (originAllowed(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Content-Type, x-tracker-password');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.set('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(originAllowed(origin) ? 204 : 403);
  return next();
});
app.use(express.json({ limit: '64kb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/session', auth.session);
app.post('/api/login', auth.login);
app.post('/api/logout', auth.logout);
app.use('/api', auth.requireAuth);

app.get('/api/overview', (req, res) => res.json(overview()));

// Starts the checks and answers at once; the page polls overview while
// services show as "checking".
app.post('/api/check', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null;
  runner.run({ ids, force: true });
  res.status(202).json(overview());
});

app.get('/api/issues', (req, res) => {
  const status = String(req.query.status || 'all');
  let list = store.state.incidents;
  if (status === 'open') list = list.filter((i) => !i.resolvedAt);
  if (status === 'resolved') list = list.filter((i) => i.resolvedAt);
  if (req.query.service) list = list.filter((i) => i.serviceId === req.query.service);
  res.json({ issues: list.slice(0, 300) });
});

// For the backend (or anything else) to log a problem it hit in real use:
// POST /api/issues { service, message, level?: "warn"|"down", detail? }
app.post('/api/issues', (req, res) => {
  const body = req.body || {};
  const message = String(body.message || '').trim().slice(0, 300);
  const service = String(body.service || '').trim().slice(0, 80);
  if (!message || !service) return res.status(400).json({ error: 'service and message are required' });
  const level = body.level === 'warn' ? 'warn' : 'down';
  const known = runner.services().find((s) => s.id === service || s.name.toLowerCase() === service.toLowerCase());
  const incident = incidents.report(store.state, {
    serviceId: known ? known.id : service,
    serviceName: known ? known.name : service,
    level,
    message,
    detail: body.detail ? String(body.detail).slice(0, 2000) : null,
  }, new Date().toISOString());
  store.save();
  res.status(201).json({ id: incident.id, count: incident.count });
});

app.post('/api/issues/:id/resolve', (req, res) => {
  const note = req.body?.note ? String(req.body.note).slice(0, 300) : null;
  const incident = incidents.resolve(store.state, req.params.id, new Date().toISOString(), note);
  if (!incident) return res.status(404).json({ error: 'No such issue' });
  store.save();
  res.json({ issue: incident });
});

// Dates and notes the APIs cannot tell us: plan renewal, card expiry,
// credit top-up date. expiresOn = YYYY-MM-DD or null to clear.
app.put('/api/meta/:id', (req, res) => {
  const service = runner.services().find((s) => s.id === req.params.id);
  if (!service) return res.status(404).json({ error: 'No such service' });
  const body = req.body || {};
  const expiresOn = body.expiresOn ? String(body.expiresOn) : '';
  if (expiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) return res.status(400).json({ error: 'expiresOn must be YYYY-MM-DD' });
  const meta = {
    expiresOn: expiresOn || null,
    expiryLabel: String(body.expiryLabel || '').trim().slice(0, 60) || null,
    plan: String(body.plan || '').trim().slice(0, 80) || null,
    notes: String(body.notes || '').trim().slice(0, 1000) || null,
  };
  const empty = Object.values(meta).every((v) => v == null);
  if (empty) delete store.state.meta[service.id];
  else store.state.meta[service.id] = meta;

  const result = store.state.results[service.id];
  if (result) {
    const ev = evaluate(result, store.state.meta[service.id], settings);
    incidents.syncCheck(store.state, service, ev, new Date().toISOString(), null, { seen: false });
  }
  store.save();
  res.json(overview());
});

const frontendIndex = path.join(settings.frontendDir, 'index.html');
const servesFrontend = settings.serveFrontend && fs.existsSync(frontendIndex);
if (servesFrontend) {
  // Same address as the API, so the page always calls its own /api.
  app.get('/config.js', (req, res) => {
    res.type('text/javascript').set('Cache-Control', 'no-store').send('window.APITRACKER_CONFIG = {"apiUrl":""};\n');
  });
  app.use(express.static(settings.frontendDir, { index: 'index.html', setHeaders: (res) => res.set('Cache-Control', 'no-store') }));
  app.get(/^(?!\/api(\/|$)).*/, (req, res) => res.set('Cache-Control', 'no-store').sendFile(frontendIndex));
}

app.use((req, res) => res.status(404).json({ error: 'Not found. This is the APItracker API; open the frontend for the dashboard.' }));

app.listen(settings.port, settings.host, () => {
  console.log(`APItracker backend (API) on http://${settings.host === '0.0.0.0' ? 'localhost' : settings.host}:${settings.port}/api`);
  console.log(servesFrontend ? `Dashboard also served at / from ${settings.frontendDir}` : 'Dashboard not served here (SERVE_FRONTEND=false or frontend/src missing).');
  if (auth.open) console.log('Open access: no TRACKER_PASSWORD, anyone who can reach this address sees the dashboard.');
  else console.log(settings.trustLocalhost ? 'Password on; TRUST_LOCALHOST=true lets this computer skip it (laptop only).' : 'Password required for every visitor.');
  console.log(`Watching keys in ${settings.watchEnvFile}; checks every ${settings.intervalMinutes} min`);
  console.log(settings.corsOrigins.length ? `Browsers may call it directly from: ${settings.corsOrigins.join(', ')}` : 'No CORS origins: browsers reach it only through the frontend server.');
  if (process.env.NO_SCHEDULE !== 'true') runner.start();
});
