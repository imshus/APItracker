'use strict';

const { request } = require('../util');
const { failText } = require('../report');

const DAY = 24 * 3600 * 1000;
const usd = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const parseAmount = (text) => {
  const n = Number(String(text || '').replace(/[^0-9.]/g, ''));
  return String(text || '').trim() && Number.isFinite(n) ? n : null;
};
const dayStartUtc = (ms) => Math.floor(ms / DAY) * DAY;

// Daily spend from the Costs API (Admin key only), oldest first:
// [{ day: ms at 00:00 UTC, amount: USD }].
async function dailyCosts(base, adminKey, fromMs) {
  const days = [];
  let page = null;
  for (let guard = 0; guard < 6; guard += 1) {
    const qs = new URLSearchParams({ start_time: String(Math.floor(fromMs / 1000)), bucket_width: '1d', limit: '180' });
    if (page) qs.set('page', page);
    const res = await request(`${base}/v1/organization/costs?${qs}`, { headers: { Authorization: `Bearer ${adminKey}` } });
    if (!res.ok) return { error: res };
    for (const b of res.json?.data || []) {
      const amount = (b.results || []).reduce((sum, x) => sum + Number(x.amount?.value || 0), 0);
      days.push({ day: Number(b.start_time) * 1000, amount });
    }
    if (!res.json?.has_more || !res.json?.next_page) break;
    page = res.json.next_page;
  }
  return { days };
}

module.exports = {
  id: 'openai',
  name: 'OpenAI',
  category: 'AI models',
  purpose: 'Reads jewellery tags on every scan',
  envVars: ['OPENAI_API_KEY', 'OPENAI_ADMIN_KEY', 'OPENAI_MODEL', 'OPENAI_SERVICE_TIER', 'OPENAI_REASONING_EFFORT'],
  links: {
    Usage: 'https://platform.openai.com/usage',
    Billing: 'https://platform.openai.com/settings/organization/billing/overview',
    'Admin keys': 'https://platform.openai.com/settings/organization/admin-keys',
  },

  // GET /v1/models/{model} is free and proves both the key and that this
  // key's project can use the model the backend asks for. With an Admin key
  // the Costs API adds real spend; OpenAI never shows the credit balance to
  // any key, so a balance entered once by hand is counted down by that spend.
  async check(env, r, settings, meta = {}) {
    const key = env.OPENAI_API_KEY;
    const kind = /^sk-proj-/.test(key || '') ? 'project key' : /^sk-admin-/.test(key || '') ? 'admin key' : null;
    if (!r.requireKey('OPENAI_API_KEY', key, { mode: kind })) return;
    const base = settings.openaiApiBase;

    const model = env.OPENAI_MODEL || 'gpt-6-luna';
    r.fact('Model', model);
    r.fact('Service tier', env.OPENAI_SERVICE_TIER);
    r.fact('Reasoning effort', env.OPENAI_REASONING_EFFORT);

    const res = await request(`${base}/v1/models/${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    r.latency(res.ms);

    if (!res.ok) {
      const code = res.json?.error?.code;
      if (res.status === 401) return r.fail('down', failText('Key rejected', res), res);
      if (res.status === 404) return r.fail('warn', `Key valid, but ${model} is not available to this key`, res);
      if (res.status === 429 && code === 'insufficient_quota') return r.fail('down', 'Out of credit (insufficient_quota)', res);
      if (res.status === 429) return r.fail('warn', failText('Rate limited', res), res);
      return r.fail('down', failText('OpenAI call failed', res), res);
    }
    r.summary = `Key valid · ${model} available`;

    const adminKey = env.OPENAI_ADMIN_KEY;
    r.key('OPENAI_ADMIN_KEY', adminKey, { mode: adminKey ? 'admin key' : null });
    if (!adminKey) {
      r.note('Add OPENAI_ADMIN_KEY (Admin keys link) to track spend and count your credit down automatically.');
      return;
    }

    const now = Date.now();
    const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
    const anchor = parseAmount(meta.amountLeft);
    const anchorAt = anchor != null && meta.amountUpdatedAt ? Date.parse(meta.amountUpdatedAt) : null;
    // Spend on the day the balance was entered is already in that balance;
    // count whole days after it (at most ~180 days back).
    const sinceDay = anchorAt ? dayStartUtc(anchorAt) + DAY : null;
    const from = Math.max(now - 179 * DAY, Math.min(monthStart, sinceDay ?? monthStart));

    const costs = await dailyCosts(base, adminKey, from);
    if (costs.error) {
      r.finding('warn', failText('Spend not readable with OPENAI_ADMIN_KEY', costs.error));
      return;
    }
    const sum = (fromMs) => costs.days.filter((d) => d.day >= fromMs).reduce((s, d) => s + d.amount, 0);
    const month = sum(monthStart);
    const today = sum(dayStartUtc(now));
    r.fact('Spent this month', usd(month));
    r.fact('Spent today (UTC)', usd(today));
    r.summary += ` · ${usd(month)} spent this month`;

    if (anchor != null && anchorAt) {
      const spentSince = sinceDay > now ? 0 : sum(sinceDay);
      const total = parseAmount(meta.amountTotal);
      const left = Math.max(0, anchor - spentSince);
      r.fact('Spent since balance was entered', `${usd(spentSince)} (entered ${usd(anchor)} on ${new Date(anchorAt).toISOString().slice(0, 10)})`);
      r.setAvailable({
        label: 'Credit left (entered balance minus spend)',
        value: Number(left.toFixed(2)),
        total,
        money: 'USD',
        lowAt: total ? total * 0.1 : 5,
      });
      r.summary += ` · ~${usd(left)} credit left`;
    }
  },
};
