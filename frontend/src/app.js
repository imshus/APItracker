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

async function api(path, options = {}) {
  // Empty apiUrl = same address; the frontend server forwards /api to the backend.
  const base = (window.APITRACKER_CONFIG && window.APITRACKER_CONFIG.apiUrl) || '';
  const res = await fetch(`${base}/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
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

// The date that matters most: the soonest real expiry, else an info-only one
// (e.g. a token the backend renews itself).
function expiryOf(s) {
  const byDate = (a, b) => Date.parse(a.at) - Date.parse(b.at);
  return s.expiries.filter((e) => !e.info).sort(byDate)[0] || s.expiries.slice().sort(byDate)[0] || null;
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
    ${figures(s)}
    ${r?.available?.total ? meter(r.available, s.status) : ''}
    ${s.expiries.length > 1 ? `<div class="exp">${s.expiries.map(expRow).join('')}</div>` : ''}
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
        <button type="button" class="btn small ghost" data-action="meta" data-id="${esc(s.id)}">Balance &amp; expiry</button>
        <button type="button" class="btn small" data-action="check" data-id="${esc(s.id)}" ${s.checking ? 'disabled' : ''}>Check</button>
      </div>
    </div>
  </article>`;
}

// Left · Total · Expires, on every card. Anything the API does not report
// links to the dialog where it can be entered by hand.
function figures(s) {
  const b = balanceOf(s);
  const e = expiryOf(s);
  const add = (text) => `<button type="button" class="fig-add" data-action="meta" data-id="${esc(s.id)}">${esc(text)}</button>`;
  const cell = (label, value, sub) => `
      <div class="fig">
        <span class="fig-label">${esc(label)}</span>
        <span class="fig-value">${value}</span>
        <span class="fig-sub">${sub}</span>
      </div>`;
  const manualTag = b?.manual ? '<span class="tag">manual</span>' : '';
  return `
    <div class="figures">
      ${cell('Left', b?.left ? esc(b.left) + manualTag : '—', b ? esc(b.sub) : add('not reported · add'))}
      ${cell('Total', b?.total ? esc(b.total) : '—', b?.total ? (b.manual ? 'entered by you' : 'plan total') : add(b ? 'add total' : 'not reported · add'))}
      ${cell('Expires', e ? esc(dateOnly(e.at)) + (e.source === 'manual' ? '<span class="tag">manual</span>' : '') : '—',
        e ? `<span class="days ${daysClass(e)}">${esc(daysText(e))}</span> · ${esc(e.label)}` : add('no expiry reported · add'))}
    </div>`;
}

function meter(a, status) {
  const pct = Math.max(0, Math.min(100, (a.value / a.total) * 100));
  const cls = a.value <= 0 ? 'down' : status === 'warn' && pct < 15 ? 'warn' : '';
  return `<div class="meter" title="${pct.toFixed(0)}% left"><span class="${cls}" style="width:${pct.toFixed(1)}%"></span></div>`;
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

// One row per service: what is left, the total, and the next expiry —
// soonest expiry first, services with no date after.
function renderExpiry(d) {
  const rows = d.services.map((s) => ({ s, b: balanceOf(s), e: expiryOf(s) }));
  const when = (r) => (r.e && !r.e.info ? Date.parse(r.e.at) : Infinity);
  rows.sort((x, y) => when(x) - when(y));
  $('#expiryList').innerHTML = `
    <div class="table-wrap"><table class="expiry">
      <thead><tr><th>Service</th><th>Left</th><th>Total</th><th>Expires</th><th>In</th><th></th></tr></thead>
      <tbody>${rows.map(({ s, b, e }) => `
        <tr>
          <td><span class="dot ${esc(s.status)}"></span>${esc(s.name)}</td>
          <td>${b?.left ? `<strong>${esc(b.left)}</strong>` : '<span class="muted">—</span>'}${b ? `<div class="muted small">${esc(b.sub)}</div>` : ''}</td>
          <td>${b?.total ? esc(b.total) : '<span class="muted">—</span>'}</td>
          <td>${e ? `${esc(e.info ? dateTime(e.at) : dateOnly(e.at))}<div class="muted small">${esc(e.label)}${e.source === 'manual' ? ' · entered by you' : ''}</div>` : '<span class="muted">—</span>'}</td>
          <td>${e ? `<span class="days ${daysClass(e)}">${esc(daysText(e))}</span>` : ''}</td>
          <td><button type="button" class="btn small ghost" data-action="meta" data-id="${esc(s.id)}">Edit</button></td>
        </tr>`).join('')}
      </tbody>
    </table></div>
    <p class="muted small">OpenAI and Sandbox do not report balance or renewal to an API key: add them with <b>Edit</b> (or "Balance &amp; expiry" on the card). Warnings start ${d.expiryWarnDays} days before a date.</p>`;
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
    // The server was updated since this page loaded: load the new page.
    const loaded = window.APITRACKER_CONFIG && window.APITRACKER_CONFIG.uiVersion;
    if (loaded && state.data.uiVersion && state.data.uiVersion !== loaded) {
      window.location.reload();
      return;
    }
    render();
    if (state.tab === 'issues') await loadIssues();
  } catch (err) {
    const banner = $('#banner');
    banner.hidden = false;
    banner.textContent = `Cannot reach the tracker: ${err.message}`;
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
  $('#metaTitle').textContent = `Balance & expiry — ${s.name}`;
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

// Old builds kept an access key here; it is no longer used.
try { localStorage.removeItem('apitracker-key'); } catch { /* private mode */ }
refresh();
