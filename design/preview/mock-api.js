// Mock of the APItracker backend /api so the dashboard can be previewed without any real API key.
// Shapes mirror backend/src/server.js overview() + the issues/meta/check routes. All data is fake.
const http = require('http');
const PORT = 4310;

const DAY = 86400000;
const now = () => Date.now();
const iso = (t) => new Date(t).toISOString();
const ago = (ms) => iso(now() - ms);
const inDays = (d) => iso(now() + d * DAY);
const daysLeft = (at) => Math.floor((Date.parse(at) - now()) / DAY);
const expiry = (label, at, extra = {}) => ({ label, at, source: 'api', info: false, ...extra, daysLeft: daysLeft(at) });

let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const history = (pattern) => Array.from({ length: 40 }, (_, i) => {
  const s = typeof pattern === 'function' ? pattern(i) : pattern;
  return { t: iso(now() - (40 - i) * 30 * 60000), s, ms: s === 'down' ? null : Math.round(120 + rnd() * 380) };
});
const key = (env, value, mode = null) => ({ env, set: Boolean(value), value: value || null, mode });

const result = (o) => ({
  status: 'ok', summary: '', keys: [], facts: [], available: null, expiries: [], findings: [], notes: [], error: null, ms: 240,
  checkedAt: ago(7 * 60000), failLevel: null, ...o,
});

const SERVICES = [
  {
    id: 'openai', name: 'OpenAI', category: 'AI models', purpose: 'Reads jewellery tags on every scan', status: 'warn',
    links: { Billing: 'https://platform.openai.com/settings/organization/billing', Usage: 'https://platform.openai.com/usage' },
    problems: [{ level: 'warn', message: 'Credit left: only $7.40' }],
    result: result({
      summary: 'Key valid, model access OK', ms: 412,
      keys: [key('OPENAI_API_KEY', 'sk-p…9f2a'), key('OPENAI_ADMIN_KEY', 'sk-a…c71e')],
      facts: [{ label: 'Model', value: 'gpt-5-mini' }, { label: 'Spend this month', value: '$42.60' }, { label: 'Spend today', value: '$1.84' }],
      available: { label: 'Credit left (entered $50 − spend since)', value: 7.4, total: 50, unit: '', money: 'USD' },
    }),
    meta: { amountTotal: '$50', amountLeft: '$7.40', amountUpdatedAt: ago(2 * 3600000), plan: 'Pay as you go', notes: 'Card on file: HDFC ****4821' },
    uptime7d: 100, hist: () => 'ok',
  },
  {
    id: 'razorpay', name: 'Razorpay', category: 'Payments', purpose: 'Licence purchase and credit recharge payments + webhook', status: 'ok',
    links: { Dashboard: 'https://dashboard.razorpay.com' },
    result: result({
      summary: 'Live key valid', ms: 318,
      keys: [key('RAZORPAY_KEY_ID', 'rzp_live_…Qk8s', 'live'), key('RAZORPAY_KEY_SECRET', '••••••••'), key('RAZORPAY_WEBHOOK_SECRET', '••••••••')],
      facts: [{ label: 'Latest payment', value: '₹1,180 · captured · 3 h ago' }, { label: 'Webhook secret', value: 'set, 32+ chars' }],
    }),
    meta: {}, uptime7d: 100, hist: () => 'ok',
  },
  {
    id: 'msg91', name: 'MSG91', category: 'Messaging', purpose: 'Login / signup OTP SMS', status: 'warn',
    links: { Dashboard: 'https://control.msg91.com' },
    problems: [{ level: 'warn', message: 'SMS balance: only 412 SMS' }],
    result: result({
      summary: 'Key valid', ms: 276, keys: [key('MSG91_AUTH_KEY', '4a1f…e9c0'), key('MSG91_TEMPLATE_ID', '65f2…aa31', 'plain')],
      facts: [{ label: 'Sender', value: 'MRPSCN' }],
      available: { label: 'SMS balance', value: 412, total: 5000, unit: 'SMS', money: null },
    }),
    meta: {}, uptime7d: 99.3, hist: (i) => (i === 17 ? 'warn' : 'ok'),
  },
  {
    id: 'sandbox', name: 'Sandbox GST', category: 'Compliance', purpose: 'GSTIN verification at signup (sandbox.co.in)', status: 'ok',
    links: { Dashboard: 'https://console.sandbox.co.in' },
    result: result({
      summary: 'Keys valid, token issued', ms: 905, keys: [key('SANDBOX_API_KEY', 'key_l…7d2b'), key('SANDBOX_API_SECRET', '••••••••')],
      facts: [{ label: 'Environment', value: 'live' }],
      expiries: [{ label: 'Access token (renewed by the backend)', at: inDays(0.9), source: 'api', info: true, daysLeft: 0 }],
    }),
    meta: { expiresOn: '2026-11-12', expiryLabel: 'Plan renewal', plan: 'Starter' },
    manualExpiry: expiry('Plan renewal', '2026-11-12T00:00:00.000Z', { source: 'manual' }),
    uptime7d: 100, hist: () => 'ok',
  },
  {
    id: 'pdfmonkey', name: 'PDFMonkey', category: 'Documents', purpose: 'Invoice and e-invoice PDF rendering', status: 'warn',
    links: { Dashboard: 'https://dashboard.pdfmonkey.io' },
    problems: [{ level: 'warn', message: 'Trial expires in 9 days (11 Oct 2026)' }],
    result: result({
      summary: 'Key valid, both templates found', ms: 366, keys: [key('PDFMONKEY_API_KEY', 'pdfm…3b9e'), key('PDFMONKEY_INVOICE_TEMPLATE_ID', '8c1d…02ab', 'plain')],
      facts: [{ label: 'Plan', value: 'Trial' }],
      available: { label: 'Documents left', value: 842, total: 1000, unit: 'docs', money: null },
      expiries: [expiry('Trial', inDays(9.4))],
    }),
    meta: {}, uptime7d: 100, hist: () => 'ok',
  },
  {
    id: 'metals', name: 'metals.dev', category: 'Market data', purpose: 'MCX gold rate fallback for the rate scheduler', status: 'ok',
    links: { Dashboard: 'https://metals.dev/dashboard' },
    result: result({
      summary: 'Key valid', ms: 190, keys: [key('METALS_DEV_API_KEY', 'MDK…41fc')],
      available: { label: 'Requests left this month', value: 1640, total: 2000, unit: 'requests', money: null },
    }),
    meta: {}, uptime7d: 100, hist: () => 'ok',
  },
  {
    id: 'mongodb', name: 'MongoDB Atlas', category: 'Databases', purpose: 'Main database (users, scans, invoices, payments)', status: 'ok',
    links: { Atlas: 'https://cloud.mongodb.com' },
    result: result({
      summary: 'Reachable', ms: 88, keys: [key('MONGO_URI', 'mongodb+srv://…@cluster0', 'plain')],
      facts: [{ label: 'Database', value: 'pratham' }, { label: 'Size', value: '412 MB' }, { label: 'Documents', value: '184,203' }],
    }),
    meta: {}, uptime7d: 100, hist: () => 'ok',
  },
  {
    id: 'redis', name: 'Redis', category: 'Databases', purpose: 'Gold/MCX rate cache, OTP and session data', status: 'down',
    links: { Console: 'https://app.redislabs.com' },
    problems: [{ level: 'down', message: 'Redis unreachable: connect ECONNREFUSED 10.0.0.12:6379' }],
    result: result({
      status: 'down', summary: 'Redis unreachable: connect ECONNREFUSED 10.0.0.12:6379', ms: null, failLevel: 'down',
      keys: [key('REDIS_URL', 'redis://10.0.0.12:6379', 'plain')],
      error: { network: 'connect ECONNREFUSED 10.0.0.12:6379' },
    }),
    meta: {}, uptime7d: 87.5, hist: (i) => (i >= 34 ? 'down' : 'ok'),
  },
  {
    id: 'secrets', name: 'Server secrets', category: 'Secrets', purpose: 'JWT login tokens and e-invoice password encryption', status: 'ok',
    links: {},
    result: result({ summary: 'All present and strong', ms: 2, keys: [key('JWT_SECRET', '••••••••'), key('EINVOICE_ENC_KEY', '••••••••')] }),
    meta: {}, uptime7d: 100, hist: () => 'ok',
  },
  {
    id: 'url-pratham-ai', name: 'Pratham AI', category: 'Endpoints', purpose: 'Voice agent the app dials', status: 'ok',
    links: { Open: 'https://ai.mrpscan.com' },
    result: result({
      summary: 'Up, HTTP 200', ms: 238, keys: [key('PRATHAM_AI_URL', 'https://ai.mrpscan.com', 'plain')],
      expiries: [expiry('TLS certificate', inDays(41))],
    }),
    meta: {}, uptime7d: 100, hist: () => 'ok',
  },
];

const incidents = [
  { id: 'inc_redis1', source: 'check', serviceId: 'redis', serviceName: 'Redis', level: 'down', peak: 'down', title: 'Redis unreachable: connect ECONNREFUSED 10.0.0.12:6379',
    problems: [{ level: 'down', message: 'Redis unreachable: connect ECONNREFUSED 10.0.0.12:6379' }], error: { network: 'connect ECONNREFUSED 10.0.0.12:6379' },
    openedAt: ago(3 * 3600000), lastSeenAt: ago(7 * 60000), resolvedAt: null, count: 6,
    log: [{ t: ago(3 * 3600000), level: 'down', message: 'Redis unreachable: connect ECONNREFUSED 10.0.0.12:6379' }, { t: ago(60 * 60000), level: 'down', message: 'Still unreachable' }] },
  { id: 'inc_openai1', source: 'check', serviceId: 'openai', serviceName: 'OpenAI', level: 'warn', peak: 'warn', title: 'Credit left: only $7.40',
    problems: [{ level: 'warn', message: 'Credit left: only $7.40' }], error: null,
    openedAt: ago(26 * 3600000), lastSeenAt: ago(7 * 60000), resolvedAt: null, count: 52,
    log: [{ t: ago(26 * 3600000), level: 'warn', message: 'Credit left: only $9.90' }, { t: ago(2 * 3600000), level: 'warn', message: 'Credit left: only $7.40' }] },
  { id: 'inc_msg1', source: 'check', serviceId: 'msg91', serviceName: 'MSG91', level: 'warn', peak: 'warn', title: 'SMS balance: only 412 SMS',
    problems: [{ level: 'warn', message: 'SMS balance: only 412 SMS' }], error: null,
    openedAt: ago(5 * 3600000), lastSeenAt: ago(7 * 60000), resolvedAt: null, count: 10,
    log: [{ t: ago(5 * 3600000), level: 'warn', message: 'SMS balance: only 412 SMS' }] },
  { id: 'inc_rep1', source: 'report', serviceId: 'razorpay', serviceName: 'Razorpay', level: 'warn', peak: 'warn', title: 'Webhook retried 3 times for order_Qk8sX1',
    problems: [], error: null, openedAt: ago(9 * 3600000), lastSeenAt: ago(8 * 3600000), resolvedAt: null, count: 3,
    log: [{ t: ago(9 * 3600000), level: 'warn', message: 'Webhook retried 3 times for order_Qk8sX1' }] },
  { id: 'inc_old1', source: 'check', serviceId: 'metals', serviceName: 'metals.dev', level: 'down', peak: 'down', title: 'metals.dev: HTTP 503',
    problems: [{ level: 'down', message: 'metals.dev: HTTP 503' }], error: { httpStatus: 503, code: null, message: 'Service Unavailable', body: 'Service Unavailable' },
    openedAt: ago(4 * DAY), lastSeenAt: ago(4 * DAY - 40 * 60000), resolvedAt: ago(4 * DAY - 45 * 60000), count: 2,
    log: [{ t: ago(4 * DAY), level: 'down', message: 'metals.dev: HTTP 503' }, { t: ago(4 * DAY - 45 * 60000), level: 'ok', message: 'Recovered' }] },
  { id: 'inc_old2', source: 'check', serviceId: 'url-pratham-ai', serviceName: 'Pratham AI', level: 'warn', peak: 'warn', title: 'Slow response: 3,100 ms',
    problems: [{ level: 'warn', message: 'Slow response: 3,100 ms' }], error: null,
    openedAt: ago(6 * DAY), lastSeenAt: ago(6 * DAY - 30 * 60000), resolvedAt: ago(6 * DAY - 70 * 60000), count: 1,
    log: [{ t: ago(6 * DAY), level: 'warn', message: 'Slow response: 3,100 ms' }, { t: ago(6 * DAY - 70 * 60000), level: 'ok', message: 'Recovered' }] },
];

// GST tracker (backend not built yet): { users: [{ id, name, phone, hits }], updatedAt }
const GST_NAMES = ['Rakesh Soni', 'Meera Agarwal', 'Vikram Chauhan', 'Pooja Mehta', 'Arjun Verma', 'Sunita Jain', 'Imran Qureshi', 'Harpreet Kaur', 'Anil Bansal', 'Neha Kapoor', 'Sandeep Rathore', 'Kavita Joshi', 'Mohit Saxena', 'Farhan Ali', 'Divya Nair', 'Gurpreet Singh', 'Lata Deshmukh', 'Yogesh Patil', 'Rina Dutta', 'Tarun Malhotra', 'Shalini Iyer', 'Deepak Yadav', 'Bhavna Shah', 'Kunal Mehra', 'Seema Pandey', 'Ritesh Kumar', 'Anjali Gupta', 'Manoj Tiwari'];
const GST_USERS = GST_NAMES.map((name, i) => ({ id: 'u' + (i + 1), name, phone: '9' + String(100000000 + ((i * 7919231) % 899999999)).padStart(9, '0'), hits: i === 5 ? 0 : Math.round(380 / (i + 1.4) + ((i * 37) % 11)) }));

const checking = new Set();
const lastRun = { startedAt: ago(7 * 60000 + 4000), finishedAt: ago(7 * 60000), skipped: null };

function overview() {
  const services = SERVICES.map((s) => {
    const base = s.result.expiries.filter((e) => !(s.manualExpiry && e.source === 'manual'));
    const manual = s.meta.expiresOn ? [expiry(s.meta.expiryLabel || 'Expiry', `${s.meta.expiresOn}T00:00:00.000Z`, { source: 'manual' })] : [];
    const open = incidents.find((i) => i.serviceId === s.id && !i.resolvedAt);
    return {
      id: s.id, name: s.name, category: s.category, purpose: s.purpose, envVars: s.result.keys.map((k) => k.env), links: s.links, everyMinutes: 30,
      meta: s.meta, result: s.result, status: s.status, problems: s.problems || [],
      expiries: [...base, ...manual].map((e) => ({ ...e, daysLeft: daysLeft(e.at) })),
      history: history(s.hist), uptime7d: s.uptime7d, checking: checking.has(s.id), openIssueId: open ? open.id : null,
    };
  });
  return {
    now: iso(now()), lastRun, nextRunAt: iso(now() + 23 * 60000), intervalMinutes: 30, expiryWarnDays: 15,
    watchEnvFile: '../mrpscan/backend/.env', envError: null, openIssues: incidents.filter((i) => !i.resolvedAt).length, uiVersion: null, services,
  };
}

const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const p = url.pathname;
  if (p === '/api/health') return send(200, { ok: true });
  if (p === '/api/overview') return send(200, overview());
  if (p === '/api/gst') return setTimeout(() => send(200, { users: GST_USERS, updatedAt: ago(4 * 60000) }), 250);
  if (p === '/api/check' && req.method === 'POST') {
    const { ids } = await readBody(req);
    const list = Array.isArray(ids) && ids.length ? ids : SERVICES.map((s) => s.id);
    list.forEach((id) => checking.add(id));
    setTimeout(() => { list.forEach((id) => { checking.delete(id); const s = SERVICES.find((x) => x.id === id); if (s) s.result.checkedAt = iso(now()); }); lastRun.finishedAt = iso(now()); }, 1600);
    return send(202, overview());
  }
  if (p === '/api/issues' && req.method === 'GET') {
    const status = url.searchParams.get('status') || 'all';
    const list = incidents.filter((i) => status === 'all' || (status === 'open' ? !i.resolvedAt : i.resolvedAt));
    return send(200, { issues: list });
  }
  let m = p.match(/^\/api\/issues\/([^/]+)\/resolve$/);
  if (m && req.method === 'POST') {
    const i = incidents.find((x) => x.id === m[1]); if (!i) return send(404, { error: 'No such issue' });
    i.resolvedAt = iso(now()); i.log.push({ t: i.resolvedAt, level: 'ok', message: 'Marked resolved' }); return send(200, { issue: i });
  }
  m = p.match(/^\/api\/meta\/([^/]+)$/);
  if (m && req.method === 'PUT') {
    const s = SERVICES.find((x) => x.id === m[1]); if (!s) return send(404, { error: 'No such service' });
    const b = await readBody(req); const t = (v, max) => String(v || '').trim().slice(0, max) || null;
    s.meta = { expiresOn: b.expiresOn || null, expiryLabel: t(b.expiryLabel, 60), amountTotal: t(b.amountTotal, 40), amountLeft: t(b.amountLeft, 40), plan: t(b.plan, 80), notes: t(b.notes, 1000),
      amountUpdatedAt: b.amountTotal || b.amountLeft ? iso(now()) : null };
    return send(200, overview());
  }
  send(404, { error: 'Not found' });
}).listen(PORT, () => console.log(`mock tracker api on http://localhost:${PORT}`));
