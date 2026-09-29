'use strict';

const Redis = require('ioredis');
const { maskUrl, formatBytes } = require('../util');

function parseInfo(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0 && !line.startsWith('#')) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

module.exports = {
  id: 'redis',
  name: 'Redis',
  category: 'Databases',
  purpose: 'Gold/MCX rate cache, OTP and session data',
  envVars: ['REDIS_URL'],
  links: {
    Console: 'https://cloud.redis.io/',
  },

  async check(env, r, settings) {
    const url = env.REDIS_URL;
    if (!r.requireKey('REDIS_URL', url, { display: maskUrl(url) })) return;
    if (String(env.USE_MEMORY_STORE).toLowerCase() === 'true') r.fact('USE_MEMORY_STORE', 'true');

    const client = new Redis(url, {
      lazyConnect: true,
      connectTimeout: 10000,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    client.on('error', () => {});
    const started = performance.now();
    try {
      await client.connect();
      await client.ping();
      r.latency(Math.round(performance.now() - started));
      const info = parseInfo(await client.info());
      const keys = await client.dbsize();

      r.fact('Version', info.redis_version);
      r.fact('Keys', Number(keys).toLocaleString('en-IN'));
      r.fact('Memory used', info.used_memory_human || formatBytes(info.used_memory));
      r.fact('Memory peak', info.used_memory_peak_human);
      r.fact('Clients', info.connected_clients);
      r.fact('Evicted keys', info.evicted_keys);
      r.fact('Rejected connections', info.rejected_connections);
      r.fact('Uptime', info.uptime_in_days ? `${info.uptime_in_days} days` : null);

      const used = Number(info.used_memory);
      const max = Number(info.maxmemory);
      if (max > 0 && Number.isFinite(used)) {
        r.available = { label: 'Memory free', value: Math.max(0, max - used), total: max, unit: 'bytes' };
        r.fact('Memory limit', formatBytes(max));
        const pct = (used / max) * 100;
        if (pct >= 95) r.finding('down', `Memory ${pct.toFixed(0)}% full — writes may be refused or keys evicted`);
        else if (pct >= settings.memoryWarnPct) r.finding('warn', `Memory ${pct.toFixed(0)}% full`);
      }
      if (Number(info.evicted_keys) > 0) r.finding('warn', `${info.evicted_keys} keys evicted (memory pressure)`);
      r.summary = `Connected · ${Number(keys).toLocaleString('en-IN')} keys · ${info.used_memory_human || formatBytes(used)} used`;
    } catch (err) {
      r.latency(Math.round(performance.now() - started));
      const msg = String(err.message || err);
      const level = 'down';
      if (/WRONGPASS|NOAUTH|invalid password|invalid username/i.test(msg)) r.fail(level, 'Password rejected');
      else if (/ENOTFOUND|EAI_AGAIN/.test(msg)) r.fail(level, 'Host not found (DNS)');
      else r.fail(level, `Cannot connect: ${msg}`);
      r.error = { message: msg };
    } finally {
      client.disconnect();
    }
  },
};
