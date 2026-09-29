'use strict';

const { Report } = require('./report');
const { listServices } = require('./services');
const { evaluate } = require('./evaluate');
const incidents = require('./incidents');
const { secretValues, redact, request } = require('./util');
const { readWatchedEnv } = require('./config');

const CHECK_TIMEOUT_MS = 45000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class Runner {
  constructor(store, settings) {
    this.store = store;
    this.settings = settings;
    this.queue = Promise.resolve();
    this.checking = new Set();
    this.nextRunAt = null;
    this.envError = null;
  }

  readEnv() {
    try {
      const env = readWatchedEnv();
      this.envError = null;
      return env;
    } catch (err) {
      this.envError = `Cannot read ${this.settings.watchEnvFile}: ${err.message}`;
      return null;
    }
  }

  services() {
    return listServices(this.readEnv() || {}, this.settings);
  }

  // ids = null → every service that is due (or all of them with force).
  // Runs are queued, never overlapped; the ids show as "checking" at once.
  run({ ids = null, force = false } = {}) {
    const known = this.services().map((s) => s.id);
    const marked = ids ? ids.filter((id) => known.includes(id)) : force ? known : [];
    marked.forEach((id) => this.checking.add(id));
    const job = this.queue.then(() => this.execute({ ids, force })).catch((err) => {
      console.error('[runner] run failed:', err);
    }).finally(() => marked.forEach((id) => this.checking.delete(id)));
    this.queue = job;
    return job;
  }

  due(service, now) {
    const last = this.store.state.results[service.id]?.checkedAt;
    if (!last) return true;
    const everyMs = Math.max(this.settings.intervalMinutes, service.everyMinutes || 0) * 60000;
    return now - Date.parse(last) >= everyMs - 60000;
  }

  async execute({ ids, force }) {
    const { state } = this.store;
    const startedAt = new Date().toISOString();
    const env = this.readEnv();
    if (!env) {
      state.lastRun = { startedAt, finishedAt: new Date().toISOString(), skipped: this.envError };
      this.store.save();
      return;
    }
    const all = listServices(env, this.settings);
    const now = Date.now();
    const chosen = ids ? all.filter((s) => ids.includes(s.id)) : all.filter((s) => force || this.due(s, now));
    if (!chosen.length) return;

    const net = await request(this.settings.connectivityUrl, { timeoutMs: 8000 });
    if (net.networkError) {
      state.lastRun = { startedAt, finishedAt: new Date().toISOString(), skipped: `Tracker is offline (${net.networkError}) — nothing was checked` };
      this.store.save();
      return;
    }

    const secrets = secretValues(env);
    chosen.forEach((s) => this.checking.add(s.id));
    await Promise.all(chosen.map(async (service) => {
      const r = new Report();
      try {
        await withTimeout(service.check(env, r, this.settings), CHECK_TIMEOUT_MS);
      } catch (err) {
        r.fail('down', `Check did not finish: ${err.message}`);
      }
      if (!r.summary) r.summary = r.status === 'ok' ? 'OK' : r.status;
      const result = redact({ ...r.toJSON(), checkedAt: new Date().toISOString() }, secrets);
      state.results[service.id] = result;
      this.store.pushHistory(service.id, { t: result.checkedAt, s: result.status, ms: result.ms });
      const ev = evaluate(result, state.meta[service.id], this.settings);
      incidents.syncCheck(state, service, ev, result.checkedAt, result.error);
      this.checking.delete(service.id);
    }));

    state.lastRun = { startedAt, finishedAt: new Date().toISOString(), ran: chosen.map((s) => s.id) };
    this.store.save();
  }

  start() {
    const intervalMs = this.settings.intervalMinutes * 60000;
    const tick = async () => {
      await this.run();
      this.nextRunAt = Date.now() + intervalMs;
      this.timer = setTimeout(tick, intervalMs);
    };
    this.nextRunAt = Date.now() + 3000;
    this.timer = setTimeout(tick, 3000);
  }
}

module.exports = { Runner };
