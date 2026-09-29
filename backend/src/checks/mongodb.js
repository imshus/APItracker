'use strict';

const { MongoClient } = require('mongodb');
const { maskUrl, formatBytes } = require('../util');

module.exports = {
  id: 'mongodb',
  name: 'MongoDB Atlas',
  category: 'Databases',
  purpose: 'Main database (users, scans, invoices, payments)',
  envVars: ['MONGODB_URI'],
  links: {
    Atlas: 'https://cloud.mongodb.com/',
  },

  async check(env, r, settings) {
    const uri = env.MONGODB_URI;
    if (!r.requireKey('MONGODB_URI', uri, { display: maskUrl(uri).replace(/\?.*$/, '') })) return;

    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 12000, connectTimeoutMS: 10000, maxPoolSize: 1 });
    const started = performance.now();
    try {
      await client.connect();
      const admin = client.db('admin');
      await admin.command({ ping: 1 });
      r.latency(Math.round(performance.now() - started));

      const db = client.db();
      const [stats, hello, build] = await Promise.all([
        db.stats(),
        admin.command({ hello: 1 }).catch(() => ({})),
        admin.command({ buildInfo: 1 }).catch(() => ({})),
      ]);
      const size = Number(stats.storageSize || 0) + Number(stats.indexSize || 0);
      r.fact('Database', db.databaseName);
      r.fact('Version', build.version);
      r.fact('Replica set', hello.setName ? `${hello.setName} · ${(hello.hosts || []).length} nodes` : null);
      r.fact('Collections', stats.collections);
      r.fact('Documents', Number(stats.objects || 0).toLocaleString('en-IN'));
      r.fact('Data size', formatBytes(stats.dataSize));
      r.fact('Storage + indexes', formatBytes(size));

      if (settings.mongoLimitMb > 0) {
        const limit = settings.mongoLimitMb * 1024 * 1024;
        r.available = { label: 'Storage free', value: Math.max(0, limit - size), total: limit, unit: 'bytes' };
        const pct = (size / limit) * 100;
        if (pct >= 95) r.finding('down', `Storage ${pct.toFixed(0)}% of the ${settings.mongoLimitMb} MB plan limit`);
        else if (pct >= settings.memoryWarnPct) r.finding('warn', `Storage ${pct.toFixed(0)}% of the ${settings.mongoLimitMb} MB plan limit`);
      }
      r.summary = `Connected · ${db.databaseName} · ${formatBytes(size)} stored`;
    } catch (err) {
      r.latency(Math.round(performance.now() - started));
      const msg = String(err.message || err);
      if (err.code === 18 || /auth(entication)? failed|bad auth/i.test(msg)) r.fail('down', 'Username / password rejected');
      else if (/Server selection timed out|ENOTFOUND|ECONNREFUSED|timed out/i.test(msg)) {
        r.fail('down', 'Cannot reach the cluster — check Atlas Network Access (IP allowlist) or the cluster state');
      } else r.fail('down', `Mongo error: ${msg}`);
      r.error = { code: err.code == null ? null : String(err.code), message: msg.slice(0, 600) };
    } finally {
      await client.close().catch(() => {});
    }
  },
};
