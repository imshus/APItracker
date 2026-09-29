'use strict';

const STATUS_LABEL = { ok: 'OK', warn: 'Warning', down: 'Down', off: 'Not set', pending: 'Not checked' };

const state = {
  data: null,
  tab: 'services',
  issueFilter: 'open',
  issues: [],
  openDetails: new Set(),
  openIssues: new Set(),
  metaFor: null,
  pollTimer: null,
};

const $ = (sel) => document.querySelector(sel);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Sign-in lives in an HttpOnly cookie set by /api/login; the page never
// stores the password.
async function api(path, options = {}) {
  // Empty apiUrl = same address; the frontend server forwards /api to the backend.
  const base = (window.APITRACKER_CONFIG && window.APITRACKER_CONFIG.apiUrl) || '';
  const res = await fetch(`${base}/api${path}`, {
    ...options,
    credentials: base ? 'include' : 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (res.status === 401 && path !== '/login') {
    askToSignIn();
    throw new Error('unauthorized');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
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
  return (n) => Number(n).toLocaleString('en-IN');
}
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
  renderTiles(d);
  if (state.tab === 'services') renderServices(d);
  if (state.tab === 'expiry') renderExpiry(d);
  if (state.tab === 'issues') renderIssues();
}

function renderHeader(d) {
  const checking = d.services.some((s) => s.checking);
  const btn = $('#checkAll');
  btn.disabled = checking;
  btn.textContent = checking ? 'Checking…' : 'Check all now';

  const parts = [];
  if (d.lastRun?.finishedAt) parts.push(`Last run ${ago(d.lastRun.finishedAt)}`);
  if (d.nextRunAt) parts.push(`next ${until(d.nextRunAt)}`);
  parts.push(`every ${d.intervalMinutes} min`);
  $('#runInfo').textContent = parts.join(' · ');

  const banner = $('#banner');
  const msg = d.envError || d.lastRun?.skipped || '';
  banner.hidden = !msg;
  banner.textContent = msg;

  const count = $('#issueCount');
  count.hidden = !d.openIssues;
  count.textContent = d.openIssues;
}

function renderTiles(d) {
  const by = (st) => d.services.filter((s) => s.status === st).length;
  const nextExp = d.services
    .flatMap((s) => s.expiries.filter((e) => !e.info).map((e) => ({ ...e, service: s.name })))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
  const tiles = [
    { label: 'Healthy', value: by('ok'), cls: 'ok', hint: `of ${d.services.length} tracked` },
    { label: 'Warnings', value: by('warn'), cls: by('warn') ? 'warn' : '', hint: 'need attention soon' },
    { label: 'Down', value: by('down'), cls: by('down') ? 'down' : '', hint: 'failing right now' },
    { label: 'Open issues', value: d.openIssues, cls: d.openIssues ? 'down' : '', hint: 'see Issues tab' },
    nextExp
      ? { label: 'Next expiry', value: daysText(nextExp), cls: daysClass(nextExp), hint: `${nextExp.service} · ${nextExp.label}` }
      : { label: 'Next expiry', value: '—', cls: '', hint: 'no dates known yet' },
  ];
  $('#tiles').innerHTML = tiles.map((t) => `
    <div class="tile">
      <div class="label">${esc(t.label)}</div>
      <div class="value ${t.cls}">${esc(t.value)}</div>
      <div class="hint">${esc(t.hint)}</div>
    </div>`).join('');
}

function renderServices(d) {
  const groups = [];
  for (const s of d.services) {
    let g = groups.find((x) => x.name === s.category);
    if (!g) groups.push(g = { name: s.category, items: [] });
    g.items.push(s);
  }
  $('#tab-services').innerHTML = groups.map((g) => `
    <h2 class="group-title">${esc(g.name)}</h2>
    <div class="grid">${g.items.map(card).join('')}</div>`).join('');
}

function card(s) {
  const r = s.result;
  const pill = s.checking
    ? '<span class="pill checking">Checking</span>'
    : `<span class="pill ${s.status}">${esc(STATUS_LABEL[s.status] || s.status)}</span>`;
  const summary = r ? r.summary : 'Waiting for the first check…';
  const problems = s.problems.filter((p) => p.message !== r?.summary);

  return `
  <article class="card ${s.status}" data-id="${esc(s.id)}">
    <div class="card-head">
      <div>
        <h3>${esc(s.name)}</h3>
        <p class="purpose">${esc(s.purpose)}</p>
      </div>
      ${pill}
    </div>
    <p class="summary">${esc(summary)}</p>
    ${problems.length ? `<ul class="problems">${problems.map((p) => `<li class="${p.level}">${esc(p.message)}</li>`).join('')}</ul>` : ''}
    ${r?.available ? availBlock(r.available, s.status) : ''}
    ${s.expiries.length ? `<div class="exp">${s.expiries.map(expRow).join('')}</div>` : ''}
    ${s.meta?.plan || s.meta?.notes ? `<div class="meta-note">${s.meta.plan ? `<strong>${esc(s.meta.plan)}</strong>` : ''}${s.meta.plan && s.meta.notes ? ' · ' : ''}${esc(s.meta.notes || '')}</div>` : ''}
    ${details(s)}
    <div class="card-foot">
      <div class="stats">
        ${spark(s.history)}
        ${s.uptime7d != null ? `<span title="Share of checks in the last 7 days that were not down">${s.uptime7d}% up (7d)</span>` : ''}
        ${r?.ms != null ? `<span>${r.ms.toLocaleString('en-IN')} ms</span>` : ''}
        <span title="${r ? esc(dateTime(r.checkedAt)) : ''}">${r ? `checked ${ago(r.checkedAt)}` : 'not checked yet'}</span>
      </div>
      <div class="actions">
        <span class="links">${Object.entries(s.links || {}).map(([label, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`).join('')}</span>
        <button type="button" class="btn small ghost" data-action="meta" data-id="${esc(s.id)}">Set expiry</button>
        <button type="button" class="btn small" data-action="check" data-id="${esc(s.id)}" ${s.checking ? 'disabled' : ''}>Check</button>
      </div>
    </div>
  </article>`;
}

function availBlock(a, status) {
  const fmt = formatAvail(a);
  const pct = a.total ? Math.max(0, Math.min(100, (a.value / a.total) * 100)) : null;
  const cls = a.value <= 0 ? 'down' : status === 'warn' && pct != null && pct < 15 ? 'warn' : '';
  return `
    <div class="avail">
      <div class="row"><span>${esc(a.label)}</span><span class="num">${esc(fmt(a.value))}${a.total ? ` <span class="muted">/ ${esc(fmt(a.total))}</span>` : ''}${a.unit && a.unit !== 'bytes' ? ` <span class="muted">${esc(a.unit)}</span>` : ''}</span></div>
      ${pct != null ? `<div class="meter"><span class="${cls}" style="width:${pct.toFixed(1)}%"></span></div>` : ''}
    </div>`;
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
  const open = state.openDetails.has(s.id) ? 'open' : '';
  return `
    <details class="more" data-id="${esc(s.id)}" ${open}>
      <summary>Keys & details</summary>
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

function renderExpiry(d) {
  const rows = d.services
    .flatMap((s) => s.expiries.map((e) => ({ ...e, service: s.name })))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (!rows.length) {
    $('#expiryList').innerHTML = '<div class="empty">No expiry dates yet. They appear after the first check (TLS certificates, trials, tokens) or when you add one with "Set expiry".</div>';
    return;
  }
  $('#expiryList').innerHTML = `
    <div class="table-wrap"><table class="expiry">
      <thead><tr><th>Service</th><th>What</th><th>Date</th><th>Left</th><th>Source</th></tr></thead>
      <tbody>${rows.map((e) => `
        <tr class="${e.info ? 'info' : ''}">
          <td>${esc(e.service)}</td>
          <td>${esc(e.label)}</td>
          <td>${esc(e.info ? dateTime(e.at) : dateOnly(e.at))}</td>
          <td><span class="days ${daysClass(e)}">${esc(daysText(e))}</span></td>
          <td>${e.source === 'manual' ? 'entered by you' : 'from the API'}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>
    <p class="muted small">Warnings start ${d.expiryWarnDays} days before a date. Keys with no expiry the API can report (OpenAI credit, plan renewals) can be given one with "Set expiry" on their card.</p>`;
}

async function loadIssues() {
  try {
    const { issues } = await api(`/issues?status=${state.issueFilter}`);
    state.issues = issues;
    renderIssues();
  } catch { /* shown via key dialog or next poll */ }
}

function renderIssues() {
  const list = state.issues;
  if (!list.length) {
    const what = state.issueFilter === 'open' ? 'No open issues — every check is passing.' : 'Nothing here yet.';
    $('#issues').innerHTML = `<div class="empty">${what}</div>`;
    return;
  }
  $('#issues').innerHTML = list.map((i) => {
    const level = i.resolvedAt ? 'resolved' : i.level;
    const open = state.openIssues.has(i.id) ? 'open' : '';
    const status = i.resolvedAt
      ? `resolved ${ago(i.resolvedAt)} after ${duration(i.openedAt, i.resolvedAt)}`
      : `open for ${duration(i.openedAt)} · last seen ${ago(i.lastSeenAt)}`;
    return `
    <div class="issue ${level}">
      <div class="issue-head">
        <div>
          <div class="issue-title">${esc(i.serviceName)} — ${esc(i.title)}</div>
          <div class="issue-sub">
            ${esc(status)} · started ${esc(dateTime(i.openedAt))} · seen ${i.count}× · ${i.source === 'report' ? 'reported by app' : 'found by check'}
          </div>
        </div>
        ${i.resolvedAt ? `<span class="pill ok">Resolved</span>` : `<span class="pill ${i.level}">${esc(STATUS_LABEL[i.level])}</span>`}
      </div>
      <details class="more" data-issue="${esc(i.id)}" ${open}>
        <summary>Timeline${i.error ? ' & error' : ''}</summary>
        ${(i.problems || []).length > 1 ? `<ul class="problems" style="margin-top:8px">${i.problems.map((p) => `<li class="${p.level}">${esc(p.message)}</li>`).join('')}</ul>` : ''}
        <ul class="timeline">${[...i.log].reverse().map((l) => `<li class="${esc(l.level)}"><time>${esc(dateTime(l.t))}</time>${esc(l.message)}</li>`).join('')}</ul>
        ${i.error ? `<pre class="body">${esc(errorText(i.error))}</pre>` : ''}
      </details>
      ${i.resolvedAt ? '' : `<div class="actions" style="margin-top:8px"><span class="links"></span><button type="button" class="btn small ghost" data-action="resolve" data-id="${esc(i.id)}">Mark resolved</button></div>`}
    </div>`;
  }).join('');
}

// ---------- data flow ----------
async function refresh() {
  try {
    state.data = await api('/overview');
    render();
    if (state.tab === 'issues') await loadIssues();
  } catch (err) {
    if (err.message !== 'unauthorized') {
      const banner = $('#banner');
      banner.hidden = false;
      banner.textContent = `Cannot reach the tracker: ${err.message}`;
    }
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
  } catch { /* sign-in dialog or banner */ }
  schedule();
}

function askToSignIn() {
  const dlg = $('#loginDialog');
  $('#logoutBtn').hidden = true;
  if (!dlg.open) {
    $('#loginError').hidden = true;
    dlg.showModal();
    $('#loginForm').password.focus();
  }
}

async function signIn(password) {
  const err = $('#loginError');
  try {
    await api('/login', { method: 'POST', body: JSON.stringify({ password }) });
    $('#loginDialog').close();
    $('#loginForm').reset();
    await showSessionButtons();
    refresh();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
}

// "Sign out" only when a password is set and this is a real session (not open
// access, not a trusted laptop).
async function showSessionButtons() {
  try {
    const s = await api('/session');
    $('#logoutBtn').hidden = !(s.signedIn && !s.local && !s.open);
  } catch { /* shown on next sign-in */ }
}

function openMeta(id) {
  const s = state.data.services.find((x) => x.id === id);
  if (!s) return;
  state.metaFor = id;
  const f = $('#metaForm');
  $('#metaTitle').textContent = `Set expiry — ${s.name}`;
  f.expiryLabel.value = s.meta?.expiryLabel || '';
  f.expiresOn.value = s.meta?.expiresOn || '';
  f.plan.value = s.meta?.plan || '';
  f.notes.value = s.meta?.notes || '';
  $('#metaDialog').showModal();
}

async function saveMeta(clear) {
  const f = $('#metaForm');
  const body = clear ? {} : {
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
  const btn = e.target.closest('[data-action]');
  if (btn) {
    const { action, id } = btn.dataset;
    if (action === 'check') runCheck([id]);
    if (action === 'meta') openMeta(id);
    if (action === 'resolve') {
      api(`/issues/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: '{}' }).then(refresh).catch(() => {});
    }
    return;
  }
  const tab = e.target.closest('.tabs [data-tab]');
  if (tab) {
    state.tab = tab.dataset.tab;
    document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.classList.toggle('active', b === tab));
    for (const name of ['services', 'issues', 'expiry']) $(`#tab-${name}`).hidden = name !== state.tab;
    render();
    if (state.tab === 'issues') loadIssues();
    return;
  }
  const chip = e.target.closest('[data-filter]');
  if (chip) {
    state.issueFilter = chip.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach((c) => c.classList.toggle('active', c === chip));
    loadIssues();
  }
});

// Keep expanded sections open across the periodic re-render.
document.addEventListener('toggle', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLDetailsElement)) return;
  const set = el.dataset.issue ? state.openIssues : state.openDetails;
  const id = el.dataset.issue || el.dataset.id;
  if (!id) return;
  if (el.open) set.add(id); else set.delete(id);
}, true);

$('#checkAll').addEventListener('click', () => runCheck(null));
// Inside the phone app: change which tracker server it opens.
if (window.APITrackerShell) {
  $('#serverBtn').hidden = false;
  $('#serverBtn').addEventListener('click', () => window.APITrackerShell.openSettings());
}
$('#metaForm').addEventListener('submit', (e) => { e.preventDefault(); saveMeta(false); });
$('#metaClear').addEventListener('click', () => saveMeta(true));
$('#metaCancel').addEventListener('click', () => $('#metaDialog').close());
$('#loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  signIn(e.target.password.value);
});
// The dashboard is empty without a session, so Esc must not close sign-in.
$('#loginDialog').addEventListener('cancel', (e) => e.preventDefault());
$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/logout', { method: 'POST', body: '{}' }); } catch { /* signing in again shows anyway */ }
  state.data = null;
  askToSignIn();
});

// Old builds kept an access key here; it is no longer used.
try { localStorage.removeItem('apitracker-key'); } catch { /* private mode */ }
showSessionButtons();
refresh();
