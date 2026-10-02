'use strict';

const STATUS_LABEL = { ok: 'OK', warn: 'Warning', down: 'Down', off: 'Not set', pending: 'Not checked' };
// Worst first, so what needs attention is always at the top.
const ORDER = { down: 0, warn: 1, pending: 2, off: 3, ok: 4 };

const state = {
  data: null,
  tab: 'services',
  issueFilter: 'open',
  issues: [],
  openSvc: new Set(),
  openDetails: new Set(),
  openIssues: new Set(),
  metaFor: null,
  pollTimer: null,
  gst: {
    status: 'idle', users: [], totals: null, updatedAt: null, missing: false, truncated: false, message: '',
    q: '', filter: 'all', sort: { key: 'last', dir: 'desc' }, shown: 100, shell: false, open: new Set(), loading: false,
  },
};

const $ = (sel) => document.querySelector(sel);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, options = {}) {
  // Empty apiUrl = same address; the frontend server forwards /api to the backend.
  const base = (window.APITRACKER_CONFIG && window.APITRACKER_CONFIG.apiUrl) || '';
  const res = await fetch(`${base}/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
  return body;
}

// ---------- time ----------
function ago(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
function until(iso) {
  const s = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (s <= 30) return 'now';
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))} min`;
  return `in ${Math.round(s / 3600)} h`;
}
function duration(fromIso, toIso) {
  const s = Math.max(0, Math.round((Date.parse(toIso || new Date().toISOString()) - Date.parse(fromIso)) / 1000));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `${(s / 3600).toFixed(s < 36000 ? 1 : 0)} h`;
  return `${(s / 86400).toFixed(1)} d`;
}
function dateTime(iso) {
  return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
function dateOnly(iso) {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
function daysText(e) {
  if (e.daysLeft < 0 || Date.parse(e.at) < Date.now()) return 'expired';
  if (e.daysLeft === 0) return 'today';
  if (e.daysLeft === 1 && Date.parse(e.at) - Date.now() < 86400000) {
    const h = Math.max(1, Math.round((Date.parse(e.at) - Date.now()) / 3600000));
    return `in ${h} h`;
  }
  return `in ${e.daysLeft} days`;
}
function daysClass(e) {
  if (e.info) return 'info';
  if (Date.parse(e.at) < Date.now()) return 'down';
  return e.daysLeft <= (state.data?.expiryWarnDays ?? 15) ? 'warn' : 'ok';
}

function formatAvail(a) {
  if (a.unit === 'bytes') return (n) => bytes(n);
  if (a.money) return (n) => Number(n).toLocaleString('en-IN', { style: 'currency', currency: a.money, maximumFractionDigits: 2 });
  return (n) => `${Number(n).toLocaleString('en-IN')}${a.unit ? ` ${a.unit}` : ''}`;
}

// Left / total for a service: what its API reports, else what was entered
// by hand in "Balance & expiry".
function balanceOf(s) {
  const a = s.result?.available;
  const m = s.meta || {};
  if (a) {
    const fmt = formatAvail(a);
    return {
      left: fmt(a.value),
      total: a.total ? fmt(a.total) : (m.amountTotal || null),
      sub: a.label,
      manual: false,
    };
  }
  if (m.amountLeft || m.amountTotal) {
    return { left: m.amountLeft || null, total: m.amountTotal || null, sub: `entered ${ago(m.amountUpdatedAt)}`, manual: true };
  }
  return null;
}

const byDate = (a, b) => Date.parse(a.at) - Date.parse(b.at);
// The soonest real expiry (info-only dates, like a token the backend renews itself, don't count).
const realExpiry = (s) => s.expiries.filter((e) => !e.info).sort(byDate)[0] || null;
// Same, but falls back to an info-only date (used on the Expiry tab).
const expiryOf = (s) => realExpiry(s) || s.expiries.slice().sort(byDate)[0] || null;

function bytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let x = Number(n);
  let i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
  return `${x.toFixed(x >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// ---------- rendering ----------
function render() {
  const d = state.data;
  if (!d) return;
  renderHeader(d);
  renderHero(d);
  $('#hero').hidden = state.tab !== 'services';
  $('#checkAll').hidden = state.tab === 'gst';
  if (state.tab === 'services') renderServices(d);
  if (state.tab === 'expiry') renderExpiry(d);
  if (state.tab === 'issues') renderIssues();
  if (state.tab === 'gst') renderGst();
}

function renderHeader(d) {
  const checking = d.services.some((s) => s.checking);
  const btn = $('#checkAll');
  btn.disabled = checking;
  btn.textContent = checking ? 'Checking…' : 'Check all';

  const parts = [];
  if (d.lastRun?.finishedAt) parts.push(`Checked ${ago(d.lastRun.finishedAt)}`);
  if (d.nextRunAt) parts.push(`next ${until(d.nextRunAt)}`);
  const info = $('#runInfo');
  info.textContent = parts.join(' · ');
  info.title = `Runs every ${d.intervalMinutes} min`;

  const banner = $('#banner');
  const msg = d.envError || d.lastRun?.skipped || '';
  banner.hidden = !msg;
  banner.textContent = msg;

  const count = $('#issueCount');
  count.hidden = !d.openIssues;
  count.textContent = d.openIssues;
}

// One summary instead of five tiles: how bad is it, then the numbers.
function renderHero(d) {
  const by = (st) => d.services.filter((s) => s.status === st).length;
  const ok = by('ok'); const warn = by('warn'); const down = by('down');
  const off = d.services.length - ok - warn - down;
  const level = down ? 'down' : warn ? 'warn' : 'ok';
  const title = { ok: 'All good', warn: 'Needs attention', down: 'Something is down' }[level];
  const nextExp = d.services
    .flatMap((s) => s.expiries.filter((e) => !e.info).map((e) => ({ ...e, service: s.name })))
    .sort(byDate)[0];
  const stat = (n, label, cls) => `<div><b class="${cls}">${n}</b><span>${label}</span></div>`;
  const el = $('#hero');
  el.className = `hero ${level}`;
  el.innerHTML = `
    <div class="hero-top"><span class="hero-dot"></span><h2>${title}</h2></div>
    <div class="hero-stats">
      ${stat(ok, 'Healthy', 'ok')}${stat(warn, 'Warnings', 'warn')}${stat(down, 'Down', 'down')}${off ? stat(off, 'Not set', '') : ''}
      ${d.openIssues ? `<button type="button" class="hero-link" data-goto="issues"><b>${d.openIssues}</b><span>Issues</span></button>` : ''}
    </div>
    ${nextExp ? `<p class="hero-next">Next expiry: <b>${esc(nextExp.service)}</b> · ${esc(nextExp.label.toLowerCase())} <span class="days ${daysClass(nextExp)}">${esc(daysText(nextExp))}</span></p>` : ''}`;
}

function renderServices(d) {
  const list = d.services.slice().sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || a.name.localeCompare(b.name));
  $('#tab-services').innerHTML = `<div class="svc-list">${list.map(svc).join('')}</div>`;
}

// A service is one compact row; tap it for keys, history and actions.
function svc(s) {
  const r = s.result;
  const checking = s.checking;
  const label = checking ? 'Checking' : (STATUS_LABEL[s.status] || s.status);
  const headline = (s.problems[0] && s.problems[0].message) || (r ? r.summary : 'Waiting for the first check…');
  const b = balanceOf(s);
  const e = realExpiry(s);
  // A warning like "Trial expires in 9 days" already says it: don't repeat the date.
  const said = Boolean(e) && s.problems.some((p) => p.message.toLowerCase().includes(e.label.toLowerCase()));
  const figs = [
    b && b.left ? `<span><b>${esc(b.left)}</b> left${b.total ? ` of ${esc(b.total)}` : ''}</span>` : '',
    e && !said ? `<span>${esc(e.label)} <b class="days ${daysClass(e)}">${esc(daysText(e))}</b></span>` : '',
  ].filter(Boolean).join('');
  const a = r?.available;
  return `
  <details class="svc ${esc(s.status)}" data-svc="${esc(s.id)}" ${state.openSvc.has(s.id) ? 'open' : ''}>
    <summary>
      <span class="dot ${esc(s.status)}"></span>
      <span class="svc-main">
        <span class="svc-name">${esc(s.name)}</span>
        <span class="svc-line ${s.status === 'ok' ? '' : esc(s.status)}">${esc(headline)}</span>
        ${figs ? `<span class="svc-figs">${figs}</span>` : ''}
        ${a && a.total ? meter(a, s.status) : ''}
      </span>
      <span class="pill ${checking ? 'checking' : esc(s.status)}">${esc(label)}</span>
    </summary>
    <div class="svc-body">${svcBody(s)}</div>
  </details>`;
}

function svcBody(s) {
  const r = s.result;
  const extra = s.problems.slice(1);
  return `
    <p class="purpose">${esc(s.purpose)}</p>
    ${r && s.problems.length && r.summary ? `<p class="summary">Last check: ${esc(r.summary)}</p>` : ''}
    ${extra.length ? `<ul class="problems">${extra.map((p) => `<li class="${esc(p.level)}">${esc(p.message)}</li>`).join('')}</ul>` : ''}
    ${s.expiries.length ? `<div class="exp">${s.expiries.map(expRow).join('')}</div>` : ''}
    ${s.meta?.plan || s.meta?.notes ? `<div class="meta-note">${s.meta.plan ? `<strong>${esc(s.meta.plan)}</strong>` : ''}${s.meta.plan && s.meta.notes ? ' · ' : ''}${esc(s.meta.notes || '')}</div>` : ''}
    ${s.id === 'smtp' ? emailUpdates(state.data.notify) : ''}
    ${details(s)}
    <div class="svc-foot">
      <div class="stats">
        ${spark(s.history)}
        ${s.uptime7d != null ? `<span title="Share of checks in the last 7 days that were not down">${s.uptime7d}% up (7d)</span>` : ''}
        ${r?.ms != null ? `<span>${r.ms.toLocaleString('en-IN')} ms</span>` : ''}
        <span title="${r ? esc(dateTime(r.checkedAt)) : ''}">${r ? `checked ${ago(r.checkedAt)}` : 'not checked yet'}</span>
      </div>
      <div class="actions">
        <button type="button" class="btn small ghost" data-action="meta" data-id="${esc(s.id)}">Balance &amp; expiry</button>
        <button type="button" class="btn small" data-action="check" data-id="${esc(s.id)}" ${s.checking ? 'disabled' : ''}>Check now</button>
      </div>
      ${Object.keys(s.links || {}).length ? `<div class="links">${Object.entries(s.links).map(([label, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`).join('')}</div>` : ''}
    </div>`;
}

// Follow-up emails go out over this same SMTP account.
function emailUpdates(n) {
  if (!n) return '';
  if (!n.enabled) {
    return '<div class="mail-box"><b>Email updates are off</b><p>Set <span class="mono">ALERT_EMAIL_TO</span> in backend/.env to get an email when an issue opens or is resolved, plus a daily summary.</p></div>';
  }
  const daily = n.dailyHour >= 0 ? ` and a daily summary after ${n.dailyHour}:00` : '';
  const last = n.lastError
    ? `<p class="error">Last email failed ${esc(ago(n.lastErrorAt))}: ${esc(n.lastError)}</p>`
    : n.lastSentAt ? `<p>Last sent ${esc(ago(n.lastSentAt))}: ${esc(n.lastSubject || '')}</p>` : '<p>Nothing sent yet.</p>';
  return `
    <div class="mail-box">
      <b>Email updates → ${esc(n.to.join(', '))}</b>
      <p>An email when an issue opens, gets worse or is resolved${daily}.</p>
      <p>From ${n.from ? esc(n.from) : '<span class="error">no sender set (ALERT_GMAIL_USER or SMTP_*)</span>'}</p>
      ${last}
      <button type="button" class="btn small ghost" data-action="notify-test">Send test update</button>
    </div>`;
}

function meter(a, status) {
  const pct = Math.max(0, Math.min(100, (a.value / a.total) * 100));
  const cls = a.value <= 0 ? 'down' : status === 'warn' && pct < 15 ? 'warn' : '';
  return `<span class="meter" title="${pct.toFixed(0)}% left"><span class="${cls}" style="width:${pct.toFixed(1)}%"></span></span>`;
}

function expRow(e) {
  return `
    <div class="exp-row">
      <span>${esc(e.label)}${e.source === 'manual' ? '<span class="tag">manual</span>' : ''}</span>
      <span class="when">${esc(dateOnly(e.at))} · <span class="days ${daysClass(e)}">${esc(daysText(e))}</span></span>
    </div>`;
}

function details(s) {
  const r = s.result;
  if (!r) return '';
  const keys = (r.keys || []).map((k) => `
    <dt class="mono">${esc(k.env)}</dt>
    <dd>${k.set ? `<span class="mono">${esc(k.value)}</span>` : '<span class="error">not set</span>'}${k.mode ? `<span class="tag ${esc(k.mode)}">${esc(k.mode)}</span>` : ''}</dd>`).join('');
  const facts = (r.facts || []).map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd>`).join('');
  const err = r.error ? `<pre class="body">${esc(errorText(r.error))}</pre>` : '';
  const notes = (r.notes || []).map((n) => `<p class="note">${esc(n)}</p>`).join('');
  if (!keys && !facts && !err && !notes) return '';
  return `
    <details class="more" data-id="${esc(s.id)}" ${state.openDetails.has(s.id) ? 'open' : ''}>
      <summary>Keys and details</summary>
      <dl class="kv">${keys}${facts}</dl>
      ${notes}
      ${err}
    </details>`;
}

function errorText(e) {
  if (e.network) return `Network: ${e.network}`;
  return [
    e.httpStatus ? `HTTP ${e.httpStatus}` : null,
    e.code ? `Code: ${e.code}` : null,
    e.message ? `Message: ${e.message}` : null,
    e.body && e.body !== e.message ? `\n${e.body}` : null,
  ].filter(Boolean).join('\n');
}

function spark(history) {
  if (!history?.length) return '';
  const last = history.slice(-30);
  return `<span class="spark" title="Last ${last.length} checks">${last.map((h) => `<i class="${esc(h.s)}" title="${esc(dateTime(h.t))} · ${esc(STATUS_LABEL[h.s] || h.s)}${h.ms != null ? ` · ${h.ms} ms` : ''}"></i>`).join('')}</span>`;
}

// One row per service, soonest expiry first, services with no date after.
// Tap a row to add or change its balance and dates.
function renderExpiry(d) {
  const rows = d.services.map((s) => ({ s, b: balanceOf(s), e: expiryOf(s) }));
  const when = (r) => (r.e && !r.e.info ? Date.parse(r.e.at) : Infinity);
  rows.sort((x, y) => when(x) - when(y));
  $('#expiryList').innerHTML = `
    <div class="rows">${rows.map(({ s, b, e }) => `
      <button type="button" class="row" data-action="meta" data-id="${esc(s.id)}">
        <span class="dot ${esc(s.status)}"></span>
        <span class="row-main"><b>${esc(s.name)}</b><small>${b && b.left ? `${esc(b.left)} left${b.total ? ` of ${esc(b.total)}` : ''}` : 'No balance known'}</small></span>
        <span class="row-end">${e
    ? `<b class="days ${daysClass(e)}">${esc(daysText(e))}</b><small>${esc(e.info ? dateTime(e.at) : dateOnly(e.at))}</small>`
    : '<small class="add">Add date</small>'}</span>
      </button>`).join('')}
    </div>
    <p class="muted small hint">Tap a row to add or change its balance and renewal date. Warnings start ${d.expiryWarnDays} days before a date.</p>`;
}

async function loadIssues() {
  try {
    const { issues } = await api(`/issues?status=${state.issueFilter}`);
    state.issues = issues;
    renderIssues();
  } catch { /* shown via the banner on the next poll */ }
}

function renderIssues() {
  const list = state.issues;
  if (!list.length) {
    const what = state.issueFilter === 'open' ? 'No open issues. Every check is passing.' : 'Nothing here yet.';
    $('#issues').innerHTML = `<div class="empty">${what}</div>`;
    return;
  }
  $('#issues').innerHTML = `<div class="rows">${list.map((i) => {
    const level = i.resolvedAt ? 'resolved' : i.level;
    const status = i.resolvedAt
      ? `Resolved ${ago(i.resolvedAt)} after ${duration(i.openedAt, i.resolvedAt)}`
      : `Open for ${duration(i.openedAt)} · seen ${i.count}×`;
    return `
    <details class="issue ${esc(level)}" data-issue="${esc(i.id)}" ${state.openIssues.has(i.id) ? 'open' : ''}>
      <summary>
        <span class="dot ${i.resolvedAt ? 'ok' : esc(i.level)}"></span>
        <span class="svc-main">
          <span class="svc-name">${esc(i.serviceName)}</span>
          <span class="svc-line ${i.resolvedAt ? '' : esc(i.level)}">${esc(i.title)}</span>
          <span class="svc-figs"><span>${esc(status)}</span></span>
        </span>
        ${i.resolvedAt ? '<span class="pill ok">Resolved</span>' : `<span class="pill ${esc(i.level)}">${esc(STATUS_LABEL[i.level])}</span>`}
      </summary>
      <div class="svc-body">
        <p class="purpose">Started ${esc(dateTime(i.openedAt))} · ${i.source === 'report' ? 'reported by the app' : 'found by a check'}</p>
        ${(i.problems || []).length > 1 ? `<ul class="problems">${i.problems.map((p) => `<li class="${esc(p.level)}">${esc(p.message)}</li>`).join('')}</ul>` : ''}
        <ul class="timeline">${[...i.log].reverse().map((l) => `<li class="${esc(l.level)}"><time>${esc(dateTime(l.t))}</time>${esc(l.message)}</li>`).join('')}</ul>
        ${i.error ? `<pre class="body">${esc(errorText(i.error))}</pre>` : ''}
        ${i.resolvedAt ? '' : `<div class="actions"><button type="button" class="btn small" data-action="resolve" data-id="${esc(i.id)}">Mark resolved</button></div>`}
      </div>
    </details>`;
  }).join('')}</div>`;
}

// ---------- GST tracker ----------
// Every GST check made at MRPscan sign-up (the backend's gst_verifications),
// grouped per user:
//   GET /api/gst  ->  { users: [{ id, name, phone, hits, failures, status, firstCheckedAt, lastCheckedAt,
//                                 gsts: [{ gstNumber, kind, attempts, failures, reason, errorCode, statusCode,
//                                          details, verifiedAt, lastFailedAt, resolvedAt, resolvedGstNumber,
//                                          accountCreatedAt, account, firstCheckedAt, lastCheckedAt }] }],
//                       totals: { checks, users, gstNumbers, verified, failed, unable, accounts },
//                       updatedAt, truncated, collectionMissing }
// hits = GST checks (verify attempts) by that user. A 404 (an older server) shows "Not connected yet".
const gst = state.gst;
const fmtNum = (n) => Number(n).toLocaleString('en-IN');
const USER_STATUS = {
  account: { dot: 'ok', text: 'Account created' },
  started: { dot: 'ok', text: 'GST confirmed, sign-up not finished' },
  verified: { dot: 'ok', text: 'GST verified, no account yet' },
  failed: { dot: 'down', text: 'GST failed' },
  unable: { dot: 'warn', text: 'Couldn’t verify (registry unreachable)' },
};
const GST_KIND = { verified: ['ok', 'Verified'], rejected: ['down', 'Failed'], unable: ['warn', 'Not verified'] };
// Each chip matches the tile of the same name (both count users).
const GST_FILTERS = {
  all: () => true,
  verified: (u) => u.status === 'account' || u.status === 'started' || u.status === 'verified',
  failed: (u) => u.status === 'failed',
  unable: (u) => u.status === 'unable',
  account: (u) => u.status === 'account',
};

const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v) => (v == null ? '' : String(v));

function normalizeGstUser(u, i) {
  const gsts = arr(u.gsts).map((g) => ({
    gstNumber: str(g.gstNumber),
    kind: GST_KIND[g.kind] ? g.kind : 'rejected',
    attempts: num(g.attempts),
    failures: num(g.failures),
    reason: str(g.reason),
    errorCode: str(g.errorCode),
    statusCode: g.statusCode == null ? null : num(g.statusCode),
    details: g.details && typeof g.details === 'object' ? g.details : null,
    firstCheckedAt: g.firstCheckedAt || null,
    lastCheckedAt: g.lastCheckedAt || null,
    verifiedAt: g.verifiedAt || null,
    lastFailedAt: g.lastFailedAt || null,
    resolvedAt: g.resolvedAt || null,
    resolvedGstNumber: str(g.resolvedGstNumber),
    accountCreatedAt: g.accountCreatedAt || null,
    account: g.account && typeof g.account === 'object' ? g.account : null,
  }));
  return {
    id: str(u.id ?? i),
    name: str(u.name) || 'Unknown user',
    phone: str(u.phone),
    hits: num(u.hits),
    failures: num(u.failures),
    status: USER_STATUS[u.status] ? u.status : 'failed',
    firstCheckedAt: u.firstCheckedAt || null,
    lastCheckedAt: u.lastCheckedAt || null,
    gsts,
    // Everything the search box matches, lower-cased once.
    search: [u.name, u.phone, ...gsts.flatMap((g) => [g.gstNumber, g.details?.legalName, g.details?.tradeName, g.account?.name])]
      .map((x) => str(x).toLowerCase()).join('\n'),
  };
}

async function loadGst(silent) {
  if (gst.loading) return; // a poll and a click must not overlap
  gst.loading = true;
  if (!silent) { gst.status = 'loading'; renderGst(); }
  try {
    const body = await api('/gst');
    gst.users = arr(body.users).map(normalizeGstUser);
    gst.totals = body.totals && typeof body.totals === 'object' ? body.totals : null;
    gst.updatedAt = body.updatedAt || null;
    gst.missing = Boolean(body.collectionMissing);
    gst.truncated = Boolean(body.truncated);
    gst.phonesMasked = Boolean(body.phonesMasked);
    gst.loadedAt = Date.now();
    gst.status = 'ok';
  } catch (err) {
    gst.loading = false;
    if (silent && gst.status === 'ok') return; // keep showing the last data
    gst.status = err.status === 404 ? 'unavailable' : 'error';
    gst.message = err.message;
  }
  gst.loading = false;
  renderGst();
}

function renderGst() {
  const body = $('#gstBody');
  if (gst.status !== 'ok') {
    gst.shell = false; gst.rowsHtml = '';
    const box = {
      loading: '<div class="loading"><span class="spinner"></span>Loading…</div>',
      unavailable: '<div class="empty"><b>Not connected yet</b><p>This server does not have the GST screen yet. Update the APItracker backend.</p><button type="button" class="btn small" data-action="gst-retry">Check again</button></div>',
      error: `<div class="empty"><b>Couldn’t load GST checks</b><p>${esc(gst.message)}</p><button type="button" class="btn small" data-action="gst-retry">Try again</button></div>`,
      idle: '',
    }[gst.status];
    body.innerHTML = box;
    return;
  }
  if (!gst.shell) {
    const chip = (key, label) => `<button type="button" class="chip${gst.filter === key ? ' active' : ''}" data-gstfilter="${key}">${label}</button>`;
    body.innerHTML = `
      <div class="stat-tiles gst-tiles" id="gstTiles"></div>
      <div class="filters gst-filters">${chip('all', 'All')}${chip('verified', 'Verified')}${chip('failed', 'Failed')}${chip('unable', 'Couldn’t verify')}${chip('account', 'Account created')}</div>
      <div class="gst-search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="gstSearch" type="search" placeholder="Search name, phone, GST no or business" autocomplete="off" aria-label="Search GST checks" value="${esc(gst.q)}">
      </div>
      <div class="gst-card" role="table" aria-label="GST checks per user">
        <div class="gst-grid head" role="row">
          <button type="button" data-sort="name" role="columnheader">User<i></i></button>
          <span role="columnheader">Phone no</span>
          <button type="button" data-sort="hits" class="num" role="columnheader">GST checks<i></i></button>
        </div>
        <div id="gstRows" role="rowgroup"></div>
      </div>
      <p id="gstMeta" class="muted small hint"></p>
      <div id="gstMore" class="more-wrap"></div>`;
    gst.shell = true; gst.rowsHtml = '';
  }
  updateGstRows();
}

// Per user, the same rule as the chips (the backend sends the same numbers).
function gstTotals() {
  if (gst.totals) return gst.totals;
  const by = (f) => gst.users.filter(GST_FILTERS[f]).length;
  return {
    checks: gst.users.reduce((n, u) => n + u.hits, 0),
    users: gst.users.length,
    verified: by('verified'),
    failed: by('failed'),
    unable: by('unable'),
    accounts: by('account'),
  };
}

function userLine(u) {
  const refused = u.gsts.find((g) => g.kind === 'rejected');
  const bits = [USER_STATUS[u.status].text];
  if (u.status === 'failed' && refused && refused.reason) bits[0] = `Failed: ${refused.reason}`;
  if (u.gsts.length > 1) bits.push(`${u.gsts.length} GST numbers`);
  if (u.failures) bits.push(`${fmtNum(u.failures)} failed`);
  if (u.lastCheckedAt) bits.push(ago(u.lastCheckedAt));
  return bits.join(' · ');
}

// force: a user action (filter, sort, search, open/close). A poll leaves the
// rows alone when nothing changed, or while text in them is selected.
function updateGstRows(force) {
  const q = gst.q.trim().toLowerCase();
  // Phone searches: +91 or a leading 0 still match the stored 10 digits;
  // digits inside a GST number or business name are not a phone search.
  const phoneLike = /^[\d\s+()-]+$/.test(q);
  let qDigits = q.replace(/\D/g, '');
  if (/^\+\s*91/.test(q)) qDigits = qDigits.slice(2);
  else if (qDigits.length > 10) qDigits = qDigits.slice(-10);
  else if (qDigits.length === 11 && qDigits[0] === '0') qDigits = qDigits.slice(1);
  const { key, dir } = gst.sort;
  const keep = GST_FILTERS[gst.filter] || GST_FILTERS.all;
  const sorter = {
    name: (x, y) => x.name.localeCompare(y.name),
    hits: (x, y) => x.hits - y.hits,
    last: (x, y) => (Date.parse(x.lastCheckedAt) || 0) - (Date.parse(y.lastCheckedAt) || 0),
  }[key] || ((x, y) => x.hits - y.hits);
  const list = gst.users
    .filter(keep)
    .filter((u) => !q || u.search.includes(q) || (phoneLike && qDigits.length >= 3 && u.phone.includes(qDigits)))
    .sort((x, y) => sorter(x, y) * (dir === 'asc' ? 1 : -1));
  const max = gst.users.reduce((m, u) => Math.max(m, u.hits), 1);
  const shown = list.slice(0, gst.shown);

  const t = gstTotals();
  const tile = (label, value, cls = '') => `<div class="stat"><div class="label">${label}</div><div class="value ${cls}">${fmtNum(value || 0)}</div></div>`;
  $('#gstTiles').innerHTML = tile('GST checks', t.checks) + tile('Users', t.users)
    + tile('Verified', t.verified, 'ok') + tile('Failed', t.failed, t.failed ? 'down' : '')
    + tile('Couldn’t verify', t.unable, t.unable ? 'warn' : '') + tile('Accounts created', t.accounts, 'ok');
  document.querySelectorAll('.gst-grid.head [data-sort]').forEach((b) => {
    const active = b.dataset.sort === key;
    b.querySelector('i').textContent = active ? (dir === 'asc' ? ' ▲' : ' ▼') : '';
    b.setAttribute('aria-sort', active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
  });

  const rowsHtml = shown.length
    ? shown.map((u) => {
      const open = gst.open.has(u.id);
      return `
      <div class="gst-grid gst-row${open ? ' open' : ''}" role="row" tabindex="0" aria-expanded="${open}" data-gst-user="${esc(u.id)}" style="--p:${Math.round((u.hits / max) * 100)}">
        <span class="g-name" role="cell"><span class="g-title"><span class="dot ${USER_STATUS[u.status].dot}"></span>${esc(u.name)}</span><small class="g-sub">${esc(userLine(u))}</small></span>
        <span class="g-phone" role="cell">${esc(u.phone || '—')}</span>
        <span class="g-hits" role="cell">${fmtNum(u.hits)}</span>
      </div>
      ${open ? `<div class="gst-detail" role="row"><div role="cell">${u.gsts.map(gstEntry).join('')}</div></div>` : ''}`;
    }).join('')
    : `<div class="gst-empty">${gst.users.length ? 'No user matches this search or filter.'
      : gst.missing ? 'No GST checks recorded yet. They appear once the MRPscan backend with the GST log is deployed and someone signs up.'
        : 'No GST checks recorded yet.'}</div>`;
  const rowsEl = $('#gstRows');
  if (rowsHtml !== gst.rowsHtml) {
    const sel = window.getSelection();
    const selecting = Boolean(sel && !sel.isCollapsed && rowsEl.contains(sel.anchorNode));
    if (force || !selecting) {
      // Keep keyboard focus on the same row across the redraw.
      const active = document.activeElement;
      const focused = active && active.matches && active.matches('[data-gst-user]:focus-visible') ? active.dataset.gstUser : null;
      rowsEl.innerHTML = rowsHtml;
      gst.rowsHtml = rowsHtml;
      const again = focused && rowsEl.querySelector(`[data-gst-user="${CSS.escape(focused)}"]`);
      if (again) again.focus({ preventScroll: true });
    }
  }

  const sortedBy = key === 'last' ? ' · latest check first' : '';
  $('#gstMeta').textContent = `${fmtNum(list.length)} of ${fmtNum(gst.users.length)} users${sortedBy}${gst.updatedAt ? ` · updated ${ago(gst.updatedAt)}` : ''}${gst.phonesMasked ? ' · phone numbers partly hidden' : ''}${gst.truncated ? ' · only the latest 5,000 GST numbers are shown' : ''}`;
  const rest = list.length - shown.length;
  $('#gstMore').innerHTML = rest > 0 ? `<button type="button" class="btn" data-action="gst-more">Show ${Math.min(100, rest)} more</button>` : '';
}

// One GST number a user tried: what GSTN returned, or why it failed, and
// whether an account was created with it.
function gstEntry(g) {
  const [cls, label] = GST_KIND[g.kind];
  const d = g.details;
  const rows = [];
  const add = (k, v) => { if (v) rows.push(`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`); };
  if (d) {
    if (d.legalName && d.legalName !== d.tradeName) add('Legal name', d.legalName);
    add('GST status', d.gstStatus);
    add('Business type', d.businessType);
    add('Address', d.address && d.address !== 'N/A' ? d.address : '');
    add('State', [d.stateName, d.pincode].filter(Boolean).join(' · '));
  }
  if (g.kind !== 'verified') {
    add('Reason', g.reason || (g.kind === 'unable' ? 'The GST registry could not be reached' : 'Refused'));
    add('Error', [g.errorCode, g.statusCode ? `HTTP ${g.statusCode}` : ''].filter(Boolean).join(' · '));
  }
  add('Checks', `${fmtNum(g.attempts)} total${g.failures ? ` · ${fmtNum(g.failures)} failed` : ''}`);
  add('First check', g.firstCheckedAt ? dateTime(g.firstCheckedAt) : '');
  add('Last check', g.lastCheckedAt ? `${dateTime(g.lastCheckedAt)} (${ago(g.lastCheckedAt)})` : '');
  if (g.kind === 'verified') add('Verified', g.verifiedAt ? dateTime(g.verifiedAt) : '');
  else add('Last failure', g.lastFailedAt ? dateTime(g.lastFailedAt) : '');
  if (g.accountCreatedAt) {
    // confirmedAt = the GST step created the business; the account exists
    // once that business finished sign-up.
    const a = g.account || {};
    const where = a.found === false ? 'business since deleted'
      : a.registered ? 'account created (sign-up completed)'
        : `sign-up not finished${a.step ? ` (${a.step.replace(/_/g, ' ').toLowerCase()})` : ''}`;
    add('Business', [where, a.name, `GST confirmed ${dateTime(g.accountCreatedAt)}`].filter(Boolean).join(' · '));
  }
  if (g.resolvedAt && g.kind !== 'verified') {
    add('Resolved', `Verified later with ${g.resolvedGstNumber || 'another number'} · ${dateTime(g.resolvedAt)}`);
  }
  const title = d ? (d.tradeName || d.legalName) : '';
  return `
    <div class="gst-entry ${esc(g.kind)}">
      <div class="ge-head">
        <span class="mono ge-no">${esc(g.gstNumber || '—')}</span>
        ${d && d.isMock ? '<span class="tag test">test data</span>' : ''}
        <span class="pill ${cls}">${label}</span>
      </div>
      ${title ? `<div class="ge-biz">${esc(title)}</div>` : ''}
      <dl class="kv">${rows.join('')}</dl>
    </div>`;
}

function toggleGstUser(id) {
  if (gst.open.has(id)) gst.open.delete(id); else gst.open.add(id);
  updateGstRows(true);
}

// ---------- data flow ----------
async function refresh() {
  try {
    state.data = await api('/overview');
    // The server was updated since this page loaded: load the new page.
    const loaded = window.APITRACKER_CONFIG && window.APITRACKER_CONFIG.uiVersion;
    if (loaded && state.data.uiVersion && state.data.uiVersion !== loaded) {
      window.location.reload();
      return;
    }
    render();
    if (state.tab === 'issues') await loadIssues();
    // The server caches GST data for 30 s: no need to ask more often than every 20 s.
    if (state.tab === 'gst' && Date.now() - (gst.loadedAt || 0) >= 20000) await loadGst(true);
  } catch (err) {
    const banner = $('#banner');
    banner.hidden = false;
    banner.textContent = `Can't reach the tracker (${err.message}). Trying again…`;
  }
  schedule();
}

function schedule() {
  clearTimeout(state.pollTimer);
  const busy = state.data?.services.some((s) => s.checking);
  state.pollTimer = setTimeout(refresh, busy ? 1500 : 20000);
}

async function sendTestUpdate(btn) {
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const out = await api('/notify/test', { method: 'POST', body: '{}' });
    state.data.notify = out.notify;
    btn.textContent = 'Sent';
  } catch (err) {
    alert(`Not sent: ${err.message}`);
  }
  setTimeout(render, 1500);
}

async function runCheck(ids) {
  try {
    state.data = await api('/check', { method: 'POST', body: JSON.stringify(ids ? { ids } : {}) });
    render();
  } catch { /* banner on the next refresh */ }
  schedule();
}

function openMeta(id) {
  const s = state.data.services.find((x) => x.id === id);
  if (!s) return;
  state.metaFor = id;
  const f = $('#metaForm');
  $('#metaTitle').textContent = `${s.name}: balance & expiry`;
  f.amountTotal.value = s.meta?.amountTotal || '';
  f.amountLeft.value = s.meta?.amountLeft || '';
  f.expiryLabel.value = s.meta?.expiryLabel || '';
  f.expiresOn.value = s.meta?.expiresOn || '';
  f.plan.value = s.meta?.plan || '';
  f.notes.value = s.meta?.notes || '';
  $('#metaDialog').showModal();
}

async function saveMeta(clear) {
  const f = $('#metaForm');
  const body = clear ? {} : {
    amountTotal: f.amountTotal.value,
    amountLeft: f.amountLeft.value,
    expiryLabel: f.expiryLabel.value,
    expiresOn: f.expiresOn.value,
    plan: f.plan.value,
    notes: f.notes.value,
  };
  try {
    state.data = await api(`/meta/${encodeURIComponent(state.metaFor)}`, { method: 'PUT', body: JSON.stringify(body) });
    $('#metaDialog').close();
    render();
  } catch (err) {
    alert(`Not saved: ${err.message}`);
  }
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-goto]');
  if (go) {
    const tabBtn = document.querySelector(`.dock [data-tab="${go.dataset.goto}"]`);
    if (tabBtn) tabBtn.click();
    return;
  }
  const gstUser = e.target.closest('[data-gst-user]');
  if (gstUser) {
    const sel = window.getSelection();
    if (e.detail > 1 || (sel && !sel.isCollapsed && gstUser.contains(sel.anchorNode))) return;
    toggleGstUser(gstUser.dataset.gstUser);
    return;
  }
  const gstChip = e.target.closest('[data-gstfilter]');
  if (gstChip) {
    gst.filter = gstChip.dataset.gstfilter;
    document.querySelectorAll('[data-gstfilter]').forEach((c) => c.classList.toggle('active', c === gstChip));
    gst.shown = 100;
    updateGstRows(true);
    return;
  }
  const sort = e.target.closest('.gst-grid.head [data-sort]');
  if (sort) {
    const k = sort.dataset.sort;
    // first tap: natural order, second: reversed, third: back to latest check first.
    const natural = k === 'name' ? 'asc' : 'desc';
    if (gst.sort.key !== k) gst.sort = { key: k, dir: natural };
    else if (gst.sort.dir === natural) gst.sort = { key: k, dir: natural === 'asc' ? 'desc' : 'asc' };
    else gst.sort = { key: 'last', dir: 'desc' };
    gst.shown = 100;
    updateGstRows(true);
    return;
  }
  const btn = e.target.closest('[data-action]');
  if (btn) {
    const { action, id } = btn.dataset;
    if (action === 'gst-retry') loadGst();
    if (action === 'gst-more') { gst.shown += 100; updateGstRows(true); }
    if (action === 'check') runCheck([id]);
    if (action === 'meta') openMeta(id);
    if (action === 'notify-test') sendTestUpdate(btn);
    if (action === 'resolve') {
      api(`/issues/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: '{}' }).then(refresh).catch(() => {});
    }
    return;
  }
  const tab = e.target.closest('.dock [data-tab]');
  if (tab) {
    state.tab = tab.dataset.tab;
    document.querySelectorAll('.dock [data-tab]').forEach((b) => b.classList.toggle('active', b === tab));
    for (const name of ['services', 'issues', 'expiry', 'gst']) $(`#tab-${name}`).hidden = name !== state.tab;
    window.scrollTo({ top: 0 });
    render();
    if (state.tab === 'issues') loadIssues();
    if (state.tab === 'gst') loadGst(gst.status === 'ok');
    return;
  }
  const chip = e.target.closest('[data-filter]');
  if (chip) {
    state.issueFilter = chip.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach((c) => c.classList.toggle('active', c === chip));
    loadIssues();
  }
});

// Keep expanded rows open across the periodic re-render.
document.addEventListener('toggle', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLDetailsElement)) return;
  const set = el.dataset.issue ? state.openIssues : el.dataset.svc ? state.openSvc : state.openDetails;
  const id = el.dataset.issue || el.dataset.svc || el.dataset.id;
  if (!id) return;
  if (el.open) set.add(id); else set.delete(id);
}, true);

$('#checkAll').addEventListener('click', () => runCheck(null));
// GST rows open with Enter or Space too.
document.addEventListener('keydown', (e) => {
  const row = e.target.closest && e.target.closest('[data-gst-user]');
  if (!row || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  toggleGstUser(row.dataset.gstUser);
});
document.addEventListener('input', (e) => {
  if (e.target.id !== 'gstSearch') return;
  gst.q = e.target.value; gst.shown = 100; updateGstRows(true);
});
// Inside the phone app: change which tracker server it opens.
if (window.APITrackerShell) {
  $('#serverBtn').hidden = false;
  $('#serverBtn').addEventListener('click', () => window.APITrackerShell.openSettings());
}
$('#metaForm').addEventListener('submit', (e) => { e.preventDefault(); saveMeta(false); });
$('#metaClear').addEventListener('click', () => saveMeta(true));
$('#metaCancel').addEventListener('click', () => $('#metaDialog').close());

// Old builds kept an access key here; it is no longer used.
try { localStorage.removeItem('apitracker-key'); } catch { /* private mode */ }
refresh();
