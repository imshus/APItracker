'use strict';

const { request } = require('../util');
const { failText } = require('../report');

module.exports = {
  id: 'resend',
  name: 'Resend',
  category: 'Messaging',
  purpose: 'Email OTP / transactional email',
  envVars: ['RESEND_API_KEY'],
  links: {
    Dashboard: 'https://resend.com/overview',
    Domains: 'https://resend.com/domains',
  },

  async check(env, r) {
    const key = env.RESEND_API_KEY;
    if (!key) {
      r.key('RESEND_API_KEY', key);
      return r.off('Not configured (optional)');
    }
    r.key('RESEND_API_KEY', key);

    const res = await request('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${key}` } });
    r.latency(res.ms);

    // A sending-only key cannot list domains, which still proves it is valid.
    if (res.status === 401 && /restricted/i.test(res.json?.name || res.text)) {
      r.summary = 'Key valid (sending-only key)';
      r.fact('Access', 'sending only');
      return;
    }
    if (!res.ok) return r.fail('down', failText('Key rejected', res), res);

    const domains = Array.isArray(res.json?.data) ? res.json.data : [];
    r.fact('Access', 'full');
    for (const d of domains) {
      r.fact(`Domain ${d.name}`, `${d.status}${d.region ? ` · ${d.region}` : ''}`);
      if (d.status !== 'verified') r.finding('warn', `Domain ${d.name} is ${d.status} — mail from it may not send`);
    }
    if (!domains.length) r.finding('warn', 'No sending domain added — mail can only go to your own address');
    r.summary = `Key valid · ${domains.length} domain${domains.length === 1 ? '' : 's'}`;
  },
};
