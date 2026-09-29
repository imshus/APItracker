'use strict';

const { request, jwtClaims } = require('../util');
const { failText } = require('../report');

module.exports = {
  id: 'sandbox',
  name: 'Sandbox GST',
  category: 'Compliance',
  purpose: 'GSTIN verification at signup (sandbox.co.in)',
  envVars: ['SANDBOX_API_KEY', 'SANDBOX_API_SECRET', 'SANDBOX_API_VERSION', 'GST_VERIFY_MODE'],
  links: {
    Console: 'https://console.sandbox.co.in/',
  },
  // Each run mints a fresh 24h access token; a few a day is plenty.
  everyMinutes: 180,

  // POST /authenticate is how the backend itself logs in. The token it
  // returns is read for its expiry and then dropped.
  async check(env, r) {
    const key = env.SANDBOX_API_KEY;
    const secret = env.SANDBOX_API_SECRET;
    const test = /^key_test_/.test(key || '');
    const mode = /^key_live_/.test(key || '') ? 'live' : test ? 'test' : null;
    const okKey = r.requireKey('SANDBOX_API_KEY', key, { mode });
    const okSecret = r.requireKey('SANDBOX_API_SECRET', secret);

    const verifyMode = env.GST_VERIFY_MODE || 'live';
    r.fact('GST verify mode', verifyMode);
    if (verifyMode === 'mock' && env.NODE_ENV === 'production') {
      r.finding('warn', 'GST_VERIFY_MODE=mock on production — any GSTIN is accepted with stub data');
    }
    if (!okKey || !okSecret) return;

    const base = test ? 'https://test-api.sandbox.co.in' : 'https://api.sandbox.co.in';
    const res = await request(`${base}/authenticate`, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'x-api-secret': secret,
        'x-api-version': env.SANDBOX_API_VERSION || '1.0.0',
        'Content-Type': 'application/json',
      },
    });
    r.latency(res.ms);

    const token = res.json?.data?.access_token || res.json?.access_token;
    if (!res.ok || !token) {
      if (res.status === 401 || res.status === 403) return r.fail('down', failText('Key / secret rejected', res), res);
      return r.fail('down', failText('Authenticate failed', res), res);
    }
    const claims = jwtClaims(token) || {};
    const expires = claims.exp ? claims.exp * 1000 : Date.now() + 24 * 3600 * 1000;
    r.expiry('Access token (auto-renewed by backend)', expires, { info: true });
    r.summary = `Keys valid · access token issued (${mode || 'unknown'} mode)`;
  },
};
