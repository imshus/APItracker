'use strict';

const { request } = require('../util');
const { failText } = require('../report');

module.exports = {
  id: 'openai',
  name: 'OpenAI',
  category: 'AI models',
  purpose: 'Reads jewellery tags on every scan',
  envVars: ['OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_SERVICE_TIER', 'OPENAI_REASONING_EFFORT'],
  links: {
    Usage: 'https://platform.openai.com/usage',
    Billing: 'https://platform.openai.com/settings/organization/billing/overview',
  },

  // GET /v1/models/{model} is free and proves both the key and that this
  // key's project can use the model the backend asks for.
  async check(env, r) {
    const key = env.OPENAI_API_KEY;
    const kind = /^sk-proj-/.test(key || '') ? 'project key' : /^sk-admin-/.test(key || '') ? 'admin key' : null;
    if (!r.requireKey('OPENAI_API_KEY', key, { mode: kind })) return;

    const model = env.OPENAI_MODEL || 'gpt-5.6-luna';
    r.fact('Model', model);
    r.fact('Service tier', env.OPENAI_SERVICE_TIER);
    r.fact('Reasoning effort', env.OPENAI_REASONING_EFFORT);

    const res = await request(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    r.latency(res.ms);

    if (res.ok) {
      r.summary = `Key valid · ${model} available`;
      r.note('OpenAI does not show the credit balance to API keys — use "Set expiry" for the billing/credit renewal date.');
      return;
    }
    const code = res.json?.error?.code;
    if (res.status === 401) return r.fail('down', failText('Key rejected', res), res);
    if (res.status === 404) return r.fail('warn', `Key valid, but ${model} is not available to this key`, res);
    if (res.status === 429 && code === 'insufficient_quota') return r.fail('down', 'Out of credit (insufficient_quota)', res);
    if (res.status === 429) return r.fail('warn', failText('Rate limited', res), res);
    return r.fail('down', failText('OpenAI call failed', res), res);
  },
};
