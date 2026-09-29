'use strict';

const { request } = require('../util');
const { failText } = require('../report');

const ERRORS = {
  1101: 'API key is invalid',
  1203: 'Monthly quota (including grace) is used up',
};

module.exports = {
  id: 'metals',
  name: 'metals.dev',
  category: 'Market data',
  purpose: 'MCX gold rate fallback for the rate scheduler',
  envVars: ['METALS_API_KEY'],
  links: {
    Dashboard: 'https://metals.dev/dashboard',
  },
  // /usage does not count against the monthly quota (checked 29 Sep 2026:
  // "used" stayed the same across repeated calls).
  async check(env, r) {
    const key = env.METALS_API_KEY;
    if (!r.requireKey('METALS_API_KEY', key)) return;

    const res = await request(`https://api.metals.dev/usage?api_key=${encodeURIComponent(key)}`);
    r.latency(res.ms);
    const j = res.json || {};

    if (res.ok && j.status === 'success') {
      r.fact('Plan', j.plan);
      r.fact('Used this month', `${Number(j.used).toLocaleString('en-IN')} of ${Number(j.total).toLocaleString('en-IN')}`);
      const total = Number(j.total);
      r.setAvailable({
        label: 'Requests left this month',
        value: j.remaining,
        total,
        unit: 'requests',
        lowAt: Number.isFinite(total) ? Math.ceil(total * 0.1) : null,
      });
      r.summary = `Key valid · ${Number(j.remaining).toLocaleString('en-IN')} requests left (${j.plan})`;
      r.note('Quota resets every month.');
      return;
    }
    const code = j.error_code;
    if (code && ERRORS[code]) return r.fail('down', `${ERRORS[code]} (${code})`, res);
    return r.fail('down', failText('metals.dev refused', res), res);
  },
};
