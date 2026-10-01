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
  gst: { status: 'idle', users: [], updatedAt: null, message: '', q: '', sort: { key: 'hits', dir: 'desc' }, shown: 100, shell: false },
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
// Backend contract (the backend for this screen is still to be built):
//   GET /api/gst  ->  { "users": [ { "id": "…", "name": "Rakesh Soni", "phone": "9928688065", "hits": 42 } ], "updatedAt": "ISO date" }
// hits = how many times that user has called the GST verification API. Until the route exists
// the screen says so (a 404 from the server is treated as "not connected yet").
const gst = state.gst;
const fmtNum = (n) => Number(n).toLocaleString('en-IN');

async function loadGst(silent) {
  if (!silent) { gst.status = 'loading'; renderGst(); }
  try {
    const body = await api('/gst');
    gst.users = (Array.isArray(body.users) ? body.users : []).map((u, i) => ({
      id: u.id ?? i, name: String(u.name ?? '') || 'Unknown user', phone: String(u.phone ?? ''), hits: Number(u.hits) || 0,
    }));
    gst.updatedAt = body.updatedAt || null;
    gst.status = 'ok';
  } catch (err) {
    if (silent && gst.status === 'ok') return; // keep showing the last data
    gst.status = err.status === 404 ? 'unavailable' : 'error';
    gst.message = err.message;
  }
  renderGst();
}

function renderGst() {
  const body = $('#gstBody');
  if (gst.status !== 'ok') {
    gst.shell = false;
    const box = {
      loading: '<div class="loading"><span class="spinner"></span>Loading…</div>',
      unavailable: '<div class="empty"><b>Not connected yet</b><p>This screen fills up once the backend starts recording GST API hits per user.</p><button type="button" class="btn small" data-action="gst-retry">Check again</button></div>',
      error: `<div class="empty"><b>Couldn’t load GST hits</b><p>${esc(gst.message)}</p><button type="button" class="btn small" data-action="gst-retry">Try again</button></div>`,
      idle: '',
    }[gst.status];
    body.innerHTML = box;
    return;
  }
  if (!gst.shell) {
    body.innerHTML = `
      <div class="stat-tiles">
        <div class="stat"><div class="label">Total GST hits</div><div class="value" id="gstTotal"></div></div>
        <div class="stat"><div class="label">Users</div><div class="value" id="gstUsers"></div></div>
      </div>
      <div class="gst-search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="gstSearch" type="search" placeholder="Search name or phone" autocomplete="off" aria-label="Search GST users" value="${esc(gst.q)}">
      </div>
      <div class="gst-card">
        <div class="gst-grid head" role="row">
          <button type="button" data-sort="name">User name<i></i></button>
          <span>Phone no</span>
          <button type="button" data-sort="hits" class="num">GST API hits<i></i></button>
        </div>
        <div id="gstRows" role="rowgroup"></div>
      </div>
      <p id="gstMeta" class="muted small hint"></p>
      <div id="gstMore" class="more-wrap"></div>`;
    gst.shell = true;
  }
  updateGstRows();
}

function updateGstRows() {
  const q = gst.q.trim().toLowerCase();
  const { key, dir } = gst.sort;
  const list = gst.users
    .filter((u) => !q || u.name.toLowerCase().includes(q) || u.phone.replace(/\D/g, '').includes(q.replace(/\D/g, '') || '\u0000') || u.phone.includes(q))
    .sort((x, y) => (key === 'name' ? x.name.localeCompare(y.name) : x.hits - y.hits) * (dir === 'asc' ? 1 : -1));
  const max = Math.max(1, ...gst.users.map((u) => u.hits));
  const shown = list.slice(0, gst.shown);
  $('#gstTotal').textContent = fmtNum(gst.users.reduce((n, u) => n + u.hits, 0));
  $('#gstUsers').textContent = fmtNum(gst.users.length);
  document.querySelectorAll('.gst-grid.head [data-sort]').forEach((b) => {
    b.querySelector('i').textContent = b.dataset.sort === key ? (dir === 'asc' ? ' ▲' : ' ▼') : '';
  });
  $('#gstRows').innerHTML = shown.length
    ? shown.map((u) => `
      <div class="gst-grid gst-row" role="row" style="--p:${Math.round((u.hits / max) * 100)}">
        <span class="g-name" role="cell">${esc(u.name)}</span>
        <span class="g-phone" role="cell">${esc(u.phone || '—')}</span>
        <span class="g-hits" role="cell">${fmtNum(u.hits)}</span>
      </div>`).join('')
    : `<div class="gst-empty">${gst.users.length ? 'No user matches your search.' : 'No GST API hits recorded yet.'}</div>`;
  $('#gstMeta').textContent = `${fmtNum(list.length)} of ${fmtNum(gst.users.length)} users${gst.updatedAt ? ` · updated ${ago(gst.updatedAt)}` : ''}`;
  const rest = list.length - shown.length;
  $('#gstMore').innerHTML = rest > 0 ? `<button type="button" class="btn" data-action="gst-more">Show ${Math.min(100, rest)} more</button>` : '';
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
    if (state.tab === 'gst') await loadGst(true);
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
  const sort = e.target.closest('[data-sort]');
  if (sort) {
    const k = sort.dataset.sort;
    gst.sort = gst.sort.key === k ? { key: k, dir: gst.sort.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: k === 'name' ? 'asc' : 'desc' };
    gst.shown = 100;
    updateGstRows();
    return;
  }
  const btn = e.target.closest('[data-action]');
  if (btn) {
    const { action, id } = btn.dataset;
    if (action === 'gst-retry') loadGst();
    if (action === 'gst-more') { gst.shown += 100; updateGstRows(); }
    if (action === 'check') runCheck([id]);
    if (action === 'meta') openMeta(id);
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
document.addEventListener('input', (e) => {
  if (e.target.id !== 'gstSearch') return;
  gst.q = e.target.value; gst.shown = 100; updateGstRows();
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
