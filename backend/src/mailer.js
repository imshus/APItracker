'use strict';

// The SMTP account the MRPscan backend sends invoices with (SMTP_* in the
// watched .env). The SMTP check signs in to it; email updates go out on it.

function smtpConfig(env) {
  const port = Number(env.SMTP_PORT || 587);
  const secureText = String(env.SMTP_SECURE ?? '').trim().toLowerCase();
  return {
    host: String(env.SMTP_HOST || '').trim(),
    port,
    // Same rule as the backend: port 465 = TLS from the start, else STARTTLS.
    secure: secureText ? secureText === 'true' : port === 465,
    user: String(env.SMTP_USER || '').trim(),
    pass: env.SMTP_PASS || '',
    from: String(env.SMTP_FROM || '').trim(),
  };
}

// Required on use, so a server that pulled without `npm ci` still starts and
// shows why mail is not working instead of crashing.
function createTransport(cfg) {
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch {
    throw new Error('nodemailer is not installed: run `npm ci --omit=dev` in backend/');
  }
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    // On 587 the connection must upgrade with STARTTLS; never sign in or send
    // over a plain connection.
    requireTLS: !cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
}

function describeSmtpError(err) {
  const code = String(err.code || '');
  const rc = err.responseCode;
  const said = String(err.response || err.message || err).replace(/\s+/g, ' ').trim();
  if (code === 'EAUTH' || rc === 535 || rc === 534) return { auth: true, text: `Login rejected${rc ? ` (${rc})` : ''}: ${said}` };
  if (/ETIMEDOUT|ECONNECTION|ESOCKET|ECONNREFUSED|ENOTFOUND|EDNS|EAI_AGAIN/.test(code)) return { text: `Cannot reach the mail server: ${said}` };
  return { text: said };
}

// "MRPscan <x@y>" stays as is; a bare address gets the tracker's name.
function fromHeader(from, name) {
  return from.includes('<') ? from : `${name} <${from}>`;
}

module.exports = { smtpConfig, createTransport, describeSmtpError, fromHeader };
