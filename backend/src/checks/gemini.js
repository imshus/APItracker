'use strict';

const { request } = require('../util');
const { failText } = require('../report');

module.exports = {
  id: 'gemini',
  name: 'Google Gemini',
  category: 'AI models',
  purpose: 'Gemini tag reader (gemini.service.js)',
  envVars: ['GEMINI_API_KEY'],
  links: {
    Keys: 'https://aistudio.google.com/apikey',
    Usage: 'https://aistudio.google.com/usage',
  },

  // Reading one model's card is free and fails the same way a real call
  // would for a bad, restricted or disabled key.
  async check(env, r) {
    const key = env.GEMINI_API_KEY;
    if (!r.requireKey('GEMINI_API_KEY', key)) return;

    const model = env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
    r.fact('Model', model);

    const res = await request(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`, {
      headers: { 'x-goog-api-key': key },
    });
    r.latency(res.ms);

    if (res.ok) {
      r.summary = `Key valid · ${model} available`;
      r.fact('Input token limit', res.json?.inputTokenLimit?.toLocaleString('en-IN'));
      return;
    }
    const reason = res.json?.error?.details?.find((d) => d.reason)?.reason;
    if (reason) r.fact('Reason', reason);
    if (res.status === 429) return r.fail('warn', failText('Quota / rate limit hit', res), res);
    if (res.status === 404) return r.fail('warn', `Key valid, but ${model} was not found`, res);
    return r.fail('down', failText('Key rejected', res), res);
  },
};
