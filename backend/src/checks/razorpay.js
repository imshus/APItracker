'use strict';

const { request } = require('../util');
const { failText } = require('../report');

module.exports = {
  id: 'razorpay',
  name: 'Razorpay',
  category: 'Payments',
  purpose: 'Licence purchase and credit recharge payments + webhook',
  envVars: ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'],
  links: {
    Dashboard: 'https://dashboard.razorpay.com/app/dashboard',
    Webhooks: 'https://dashboard.razorpay.com/app/webhooks',
  },

  async check(env, r) {
    const id = env.RAZORPAY_KEY_ID;
    const secret = env.RAZORPAY_KEY_SECRET;
    const webhook = env.RAZORPAY_WEBHOOK_SECRET;
    if (!id && !secret) return r.off('Not configured');

    const mode = /^rzp_live_/.test(id || '') ? 'live' : /^rzp_test_/.test(id || '') ? 'test' : null;
    r.key('RAZORPAY_KEY_ID', id, { mode });
    r.key('RAZORPAY_KEY_SECRET', secret);
    r.key('RAZORPAY_WEBHOOK_SECRET', webhook);

    if (mode === 'test' && env.NODE_ENV === 'production') {
      r.finding('warn', 'Test key on a production server — payments are not real');
    }
    if (!webhook) {
      r.finding('warn', 'RAZORPAY_WEBHOOK_SECRET is not set — webhook signatures fall back to the key secret');
    } else if (/^https?:\/\//i.test(webhook.trim())) {
      r.finding('warn', 'RAZORPAY_WEBHOOK_SECRET holds a URL, not the webhook secret. Webhook signatures are checked with this value, so every webhook is rejected unless that exact URL was typed as the secret in Razorpay → Webhooks.');
    }
    if (!id || !secret) return r.fail('down', 'Key ID and Key Secret are both needed');

    const auth = Buffer.from(`${id}:${secret}`).toString('base64');
    const get = (path) => request(`https://api.razorpay.com${path}`, { headers: { Authorization: `Basic ${auth}` } });
    const [res, balance, settlement] = await Promise.all([
      get('/v1/payments?count=1'),
      get('/v1/balance'),
      get('/v1/settlements?count=1'),
    ]);
    r.latency(res.ms);

    if (!res.ok) {
      if (res.status === 401) return r.fail('down', failText('Key ID / secret rejected', res), res);
      return r.fail('down', failText('Razorpay call failed', res), res);
    }
    r.summary = `Keys valid · ${mode || 'unknown'} mode`;

    // Amounts come in paise. "credits" = payments that can still be taken
    // without a Razorpay fee; "balance" = collected money not yet settled.
    const b = balance.ok ? balance.json : null;
    if (b) {
      const rupees = (p) => Number(p || 0) / 100;
      const inr = (p) => `₹${rupees(p).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      r.setAvailable({ label: 'Fee-free credit left', value: rupees(b.credits), money: 'INR', quiet: true });
      r.fact('Account balance (unsettled)', inr(b.balance));
      if (Number(b.refund_credits)) r.fact('Refund credits', inr(b.refund_credits));
      if (Number(b.locked_balance)) r.fact('Locked balance', inr(b.locked_balance));
      r.summary += ` · ${inr(b.credits)} fee-free credit left`;
    }

    const when = (s) => new Date(s * 1000).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    const last = res.json?.items?.[0];
    r.fact('Latest payment', last?.created_at ? `${when(last.created_at)} · ${last.status}` : 'none yet');
    const s = settlement.ok ? settlement.json?.items?.[0] : null;
    if (s) r.fact('Latest settlement', `₹${(Number(s.amount) / 100).toLocaleString('en-IN')} · ${s.status} · ${when(s.created_at)}`);
  },
};
