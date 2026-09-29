'use strict';

const tls = require('node:tls');

const RANK = { off: 0, ok: 1, warn: 2, down: 3 };
const worst = (a, b) => ((RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a);

// Keeps a recognisable prefix (sk-proj-, rzp_live_, key_live_, re_ …) so two
// keys can be told apart, and never more than the last 4 characters.
function mask(value) {
  const v = String(value || '');
  if (!v) return '';
  if (v.length <= 8) return '•'.repeat(v.length);
  const prefix = (v.match(/^([a-z]{1,8}[_-](?:[a-z]{1,8}[_-])?)/i) || [''])[0];
  const rest = v.slice(prefix.length);
  const head = rest.length >= 16 ? rest.slice(0, 2) : '';
  return `${prefix}${head}••••${v.slice(-4)}`;
}

// scheme://user:password@host → scheme://user:••••@host
function maskUrl(value) {
  return String(value || '').replace(/^([a-z][a-z0-9+.-]*:\/\/[^:/@]*):([^@]*)@/i, '$1:••••@');
}

function urlPassword(value) {
  const m = String(value || '').match(/^[a-z][a-z0-9+.-]*:\/\/[^:/@]*:([^@]*)@/i);
  return m ? m[1] : '';
}

// Every value that must never reach the UI or the data file, even when a
// provider echoes it back inside an error message.
function secretValues(env) {
  const out = new Set();
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (/(KEY|SECRET|TOKEN|PASS|AUTH)/i.test(name) && value.length >= 6) out.add(value);
    const pw = urlPassword(value);
    if (pw.length >= 4) out.add(pw);
  }
  for (const v of [...out]) {
    const enc = encodeURIComponent(v);
    if (enc !== v) out.add(enc);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

function redact(data, secrets) {
  let text = JSON.stringify(data);
  for (const s of secrets) {
    const json = JSON.stringify(s).slice(1, -1);
    text = text.split(json).join(JSON.stringify(mask(s)).slice(1, -1));
  }
  return JSON.parse(text);
}

function networkReason(err) {
  if (!err) return 'unknown error';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timed out';
  const cause = err.cause || err;
  const code = cause.code || '';
  const known = {
    ENOTFOUND: 'host not found (DNS)',
    ECONNREFUSED: 'connection refused',
    ECONNRESET: 'connection reset',
    ETIMEDOUT: 'connection timed out',
    EAI_AGAIN: 'DNS lookup failed',
    CERT_HAS_EXPIRED: 'TLS certificate expired',
    UND_ERR_CONNECT_TIMEOUT: 'connection timed out',
  };
  return known[code] || [code, cause.message].filter(Boolean).join(': ') || String(err);
}

async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
  const started = performance.now();
  try {
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { ok: res.ok, status: res.status, headers: res.headers, text, json, ms: Math.round(performance.now() - started) };
  } catch (err) {
    return { ok: false, status: 0, text: '', json: null, networkError: networkReason(err), ms: Math.round(performance.now() - started) };
  }
}

// The provider's own words for a failed call, whatever shape its JSON takes.
function providerMessage(res) {
  const j = res.json;
  if (j && typeof j === 'object') {
    const e = j.error;
    const candidates = [
      e && typeof e === 'object' ? (e.message || e.description) : e,
      j.message, j.msg, j.error_message, j.errors && JSON.stringify(j.errors),
    ];
    const hit = candidates.find((c) => typeof c === 'string' && c.trim());
    if (hit) return hit.trim();
  }
  const text = String(res.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, 300);
}

function tlsCertificate(host, port = 443, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate();
      done({
        authorized: socket.authorized,
        authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
        validFrom: cert.valid_from ? new Date(cert.valid_from).toISOString() : null,
        validTo: cert.valid_to ? new Date(cert.valid_to).toISOString() : null,
        issuer: cert.issuer ? (cert.issuer.O || cert.issuer.CN) : null,
        subject: cert.subject ? cert.subject.CN : null,
        protocol: socket.getProtocol(),
      });
      socket.end();
    });
    socket.setTimeout(timeoutMs, () => { socket.destroy(); done({ error: 'timed out' }); });
    socket.on('error', (err) => done({ error: networkReason(err) }));
  });
}

function jwtClaims(token) {
  try {
    const part = String(token).split('.')[1];
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
  return `${x.toFixed(x >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

module.exports = {
  RANK, worst, mask, maskUrl, secretValues, redact, request, providerMessage,
  tlsCertificate, jwtClaims, formatBytes, networkReason,
};
