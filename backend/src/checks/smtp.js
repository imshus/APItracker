'use strict';

const { smtpConfig, createTransport, describeSmtpError } = require('../mailer');

module.exports = {
  id: 'smtp',
  name: 'SMTP email',
  category: 'Messaging',
  purpose: 'Invoice and payment emails from the backend (Titan mailbox)',
  envVars: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'],
  links: {
    'Titan webmail': 'https://secureserver.titan.email/mail/',
  },

  // Connects, upgrades to TLS and signs in exactly as the backend does, then
  // quits: nothing is sent.
  async check(env, r) {
    const cfg = smtpConfig(env);
    if (!cfg.host) {
      r.key('SMTP_HOST', '');
      return r.off('Not configured');
    }
    r.key('SMTP_HOST', `${cfg.host}:${cfg.port}`, { plain: true, mode: cfg.secure ? 'tls' : 'starttls' });
    r.key('SMTP_USER', cfg.user, { plain: true });
    r.key('SMTP_PASS', cfg.pass);
    r.key('SMTP_FROM', cfg.from, { plain: true });

    if (!cfg.from) r.finding('down', 'SMTP_FROM is not set: the backend refuses to send invoice emails (503)');
    if (!cfg.user || !cfg.pass) return r.fail('down', 'SMTP_USER / SMTP_PASS not set: invoice and payment emails cannot be sent');

    let transport;
    try {
      transport = createTransport(cfg);
    } catch (err) {
      return r.fail('warn', err.message);
    }
    const started = performance.now();
    try {
      await transport.verify();
      r.latency(Math.round(performance.now() - started));
      r.summary = `Login OK · ${cfg.user} on ${cfg.host}`;
    } catch (err) {
      r.latency(Math.round(performance.now() - started));
      const d = describeSmtpError(err);
      r.fail('down', d.text);
      r.error = { code: err.code ? String(err.code) : null, message: String(err.response || err.message).slice(0, 600) };
      if (d.auth && /titan/i.test(cfg.host)) {
        r.note('Titan: switch on "Enable Titan on other apps" in the mailbox settings and keep 2FA off (Titan has no app passwords).');
      }
    } finally {
      transport.close();
    }
  },
};
