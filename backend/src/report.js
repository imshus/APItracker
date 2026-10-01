'use strict';

const { RANK, worst, mask, providerMessage } = require('./util');

// What one check found. Checks fill it in; the runner redacts and stores it.
class Report {
  constructor() {
    this.status = 'ok';
    this.summary = '';
    this.keys = [];
    this.facts = [];
    this.available = null;
    this.expiries = [];
    this.findings = [];
    this.notes = [];
    this.error = null;
    this.ms = null;
  }

  raise(level) {
    this.status = worst(this.status, level);
  }

  // opts.plain shows the value as is (ids, URLs); everything else is masked.
  key(env, value, opts = {}) {
    this.keys.push({
      env,
      set: Boolean(value),
      value: value ? (opts.plain ? String(value) : (opts.display || mask(value))) : null,
      mode: opts.mode || null,
    });
  }

  requireKey(env, value, opts = {}) {
    this.key(env, value, opts);
    if (value) return true;
    this.fail('down', `${env} is not set`);
    return false;
  }

  fact(label, value) {
    if (value === undefined || value === null || value === '') return;
    this.facts.push({ label, value: String(value) });
  }

  finding(level, message) {
    this.findings.push({ level, message });
    this.raise(level);
  }

  note(text) {
    this.notes.push(text);
  }

  // info: shown with its date but never raises a warning (e.g. a 24h token
  // the backend renews on its own).
  expiry(label, at, opts = {}) {
    const date = at ? new Date(at) : null;
    if (!date || Number.isNaN(date.getTime())) return;
    this.expiries.push({ label, at: date.toISOString(), source: 'api', info: Boolean(opts.info) });
  }

  // lowAt: threshold in the same unit as value. money: currency code (value
  // in whole units, e.g. rupees). quiet: a balance that is normally 0 (e.g.
  // money waiting for settlement) — shown, never warned about.
  setAvailable({ label, value, total = null, unit = '', lowAt = null, money = null, quiet = false }) {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    this.available = { label, value: v, total: total == null ? null : Number(total), unit, money };
    if (quiet) return;
    if (v <= 0) this.finding('down', `${label}: none left`);
    else if (lowAt != null && v < lowAt) this.finding('warn', `${label}: only ${v.toLocaleString('en-IN')} ${unit}`.trim());
  }

  latency(ms) {
    if (Number.isFinite(ms)) this.ms = ms;
  }

  fail(level, summary, res) {
    this.raise(level);
    this.summary = summary;
    this.failLevel = level;
    if (res) this.error = httpError(res);
  }

  off(summary) {
    this.status = 'off';
    this.summary = summary;
  }

  toJSON() {
    return { ...this, failLevel: this.failLevel || null };
  }
}

function httpError(res) {
  if (res.networkError) return { network: res.networkError };
  const j = res.json && typeof res.json === 'object' ? res.json : null;
  const code = j && (j.error?.code || j.error?.status || j.error?.type || j.error_code || j.code || j.name);
  return {
    httpStatus: res.status,
    code: code == null ? null : String(code),
    message: providerMessage(res),
    body: String(res.text || '').slice(0, 600),
  };
}

// Headline for a failed call: provider's words if it gave any.
function failText(prefix, res) {
  if (res.networkError) return `${prefix}: ${res.networkError}`;
  const msg = providerMessage(res);
  return msg ? `${prefix} (HTTP ${res.status}): ${msg}` : `${prefix} (HTTP ${res.status})`;
}

module.exports = { Report, RANK, failText };
