'use strict';

const crypto = require('node:crypto');
const { worst } = require('./util');

const MAX_INCIDENTS = 500;
const MAX_LOG = 60;

const newId = () => `inc_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

function addLog(incident, t, level, message) {
  incident.log.push({ t, level, message });
  if (incident.log.length > MAX_LOG) incident.log.splice(0, incident.log.length - MAX_LOG);
}

function headline(problems, level) {
  const top = problems.filter((p) => p.level === level).map((p) => p.message);
  if (!top.length) return `Status: ${level}`;
  return top.slice(0, 2).join(' · ') + (top.length > 2 ? ` (+${top.length - 2} more)` : '');
}

function trim(state) {
  if (state.incidents.length <= MAX_INCIDENTS) return;
  const open = state.incidents.filter((i) => !i.resolvedAt);
  const closed = state.incidents.filter((i) => i.resolvedAt).slice(0, Math.max(0, MAX_INCIDENTS - open.length));
  state.incidents = [...open, ...closed].sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));
}

// One open incident per service while its checks see a problem; it closes
// itself on the first clean check. `seen` = false when only the evaluation
// changed (e.g. a manual expiry date), not a new check.
function syncCheck(state, service, ev, at, error, { seen = true } = {}) {
  const open = state.incidents.find((i) => i.source === 'check' && i.serviceId === service.id && !i.resolvedAt);
  const bad = ev.status === 'warn' || ev.status === 'down';

  if (!bad) {
    if (open) {
      open.resolvedAt = at;
      open.resolvedBy = 'check';
      addLog(open, at, 'ok', 'Recovered');
    }
    return;
  }

  const title = headline(ev.problems, ev.status);
  if (!open) {
    state.incidents.unshift({
      id: newId(),
      source: 'check',
      serviceId: service.id,
      serviceName: service.name,
      level: ev.status,
      peak: ev.status,
      title,
      problems: ev.problems,
      error: error || null,
      openedAt: at,
      lastSeenAt: at,
      resolvedAt: null,
      count: 1,
      log: [{ t: at, level: ev.status, message: title }],
    });
    trim(state);
    return;
  }

  if (seen) {
    open.lastSeenAt = at;
    open.count += 1;
  }
  open.problems = ev.problems;
  if (error) open.error = error;
  if (open.title !== title || open.level !== ev.status) {
    addLog(open, at, ev.status, title);
    open.title = title;
    open.level = ev.status;
    open.peak = worst(open.peak, ev.status);
  }
}

// An issue sent in from outside (e.g. the backend hitting a provider error
// during a real request). Repeats of the same open issue are counted.
function report(state, { serviceId, serviceName, level, message, detail }, at) {
  const open = state.incidents.find((i) => i.source === 'report' && i.serviceId === serviceId && i.title === message && !i.resolvedAt);
  if (open) {
    open.lastSeenAt = at;
    open.count += 1;
    open.level = worst(open.level, level);
    open.peak = worst(open.peak, level);
    if (detail) addLog(open, at, level, detail);
    return open;
  }
  const incident = {
    id: newId(),
    source: 'report',
    serviceId,
    serviceName,
    level,
    peak: level,
    title: message,
    problems: [{ level, message }],
    error: null,
    openedAt: at,
    lastSeenAt: at,
    resolvedAt: null,
    count: 1,
    log: [{ t: at, level, message: detail || message }],
  };
  state.incidents.unshift(incident);
  trim(state);
  return incident;
}

function resolve(state, id, at, note) {
  const incident = state.incidents.find((i) => i.id === id);
  if (!incident || incident.resolvedAt) return incident || null;
  incident.resolvedAt = at;
  incident.resolvedBy = 'manual';
  incident.resolveNote = note || null;
  addLog(incident, at, 'ok', note || 'Marked resolved');
  return incident;
}

// A check issue of a service no longer tracked (a provider removed, a URL
// dropped from TRACK_URLS) would never see the clean check that closes it.
// Returns how many were closed.
function closeUntracked(state, trackedIds, at) {
  const tracked = new Set(trackedIds);
  const stale = state.incidents.filter((i) => i.source === 'check' && !i.resolvedAt && !tracked.has(i.serviceId));
  for (const incident of stale) {
    incident.resolvedAt = at;
    incident.resolvedBy = 'untracked';
    addLog(incident, at, 'ok', 'No longer tracked');
  }
  return stale.length;
}

module.exports = { syncCheck, report, resolve, closeUntracked };
