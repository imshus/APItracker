'use strict';

// GST checks made at MRPscan sign-up, for the dashboard's GST screen.
//
// The MRPscan backend keeps them in `gst_verifications`: one row per mobile +
// GST number with the latest outcome (VERIFIED / FAILED), attempt and failure
// counts, what GSTN returned on a pass, the reason on a failure, and
// confirmedAt + businessId once a business was created with that number.
// Here they are grouped per user (mobile) and read-only.
//
// Every open dashboard polls every 20 s, so: one shared MongoClient that
// closes after a few idle minutes, a short result cache, one shared query in
// flight, a remembered failure, and short timeouts so a slow or unreachable
// database answers quickly instead of stalling the page.
const crypto = require('node:crypto');
const { MongoClient, ObjectId } = require('mongodb');
const { secretValues, redact } = require('./util');

const COLLECTION = 'gst_verifications';
const CACHE_MS = 30 * 1000;
const FAILURE_CACHE_MS = 20 * 1000;
const IDLE_CLOSE_MS = 5 * 60 * 1000;
const QUERY_MS = 8000;
const DEADLINE_MS = 12000;
const MAX_ROWS = 5000;

const ROW_FIELDS = {
  gstNumber: 1, fullName: 1, mobile: 1, status: 1, attempts: 1, failures: 1, details: 1,
  verifiedAt: 1, reason: 1, errorCode: 1, statusCode: 1, lastFailedAt: 1,
  firstCheckedAt: 1, lastCheckedAt: 1, resolvedAt: 1, resolvedGstNumber: 1,
  confirmedAt: 1, businessId: 1, createdAt: 1, updatedAt: 1,
};

let pool = null; // { uri, client, busy, timer, retired }
let cache = null; // { key, at, body }
let failure = null; // { key, at, status, error }
let inflight = null; // { key, job }

function closeQuietly(client) {
  client.close().catch(() => {});
}

function acquire(uri) {
  if (pool && pool.uri !== uri) {
    // The URI changed (key rotated): finish what runs on the old client.
    const old = pool;
    pool = null;
    clearTimeout(old.timer);
    old.retired = true;
    if (old.busy === 0) closeQuietly(old.client);
  }
  if (!pool) {
    pool = {
      uri,
      busy: 0,
      timer: null,
      retired: false,
      client: new MongoClient(uri, {
        appName: 'apitracker-gst',
        maxPoolSize: 2,
        minPoolSize: 0,
        maxIdleTimeMS: 60000,
        serverSelectionTimeoutMS: 8000,
        connectTimeoutMS: 5000,
        socketTimeoutMS: 15000,
        readPreference: 'secondaryPreferred',
        retryWrites: false,
        serverMonitoringMode: 'poll',
      }),
    };
  }
  clearTimeout(pool.timer);
  pool.busy += 1;
  return pool;
}

function release(p) {
  p.busy -= 1;
  if (p.busy > 0) return;
  if (p.retired) {
    closeQuietly(p.client);
    return;
  }
  p.timer = setTimeout(() => {
    if (pool === p && p.busy === 0) {
      pool = null;
      closeQuietly(p.client);
    }
  }, IDLE_CLOSE_MS);
  p.timer.unref();
}

async function query(uri) {
  const p = acquire(uri);
  try {
    const db = p.client.db();
    if (!db.databaseName || db.databaseName === 'test') {
      throw Object.assign(new Error('MONGODB_URI names no database (it should end in /pratham or similar)'), { status: 503 });
    }
    // authorizedCollections: works for a read user scoped to collections.
    const found = await db.listCollections({ name: COLLECTION }, { nameOnly: true, authorizedCollections: true }).toArray();
    if (!found.length) return { rows: [], businesses: new Map(), missing: true };

    const rows = await db.collection(COLLECTION)
      .find({}, { projection: ROW_FIELDS, sort: { lastCheckedAt: -1, _id: -1 }, limit: MAX_ROWS + 1, maxTimeMS: QUERY_MS })
      .toArray();

    // businessId is the hex text of a businesses._id; only well-formed ones
    // are looked up (an account deletion can leave a dangling id).
    const ids = [...new Set(rows.map((r) => String(r.businessId || '')).filter((id) => /^[0-9a-f]{24}$/i.test(id)))];
    const businesses = new Map();
    if (ids.length) {
      const list = await db.collection('businesses')
        .find({ _id: { $in: ids.map((id) => new ObjectId(id)) } }, {
          projection: { tradeName: 1, legalName: 1, isRegistered: 1, registrationStep: 1 },
          maxTimeMS: QUERY_MS,
        })
        .toArray();
      for (const b of list) businesses.set(String(b._id), b);
    }
    return { rows, businesses, missing: false };
  } catch (err) {
    // After a failed first connect the driver keeps a closed topology on
    // this client ("Topology is closed" forever): never reuse it.
    if (!(err && err.status) && pool === p) {
      pool = null;
      clearTimeout(p.timer);
      p.retired = true;
    }
    throw err;
  } finally {
    release(p);
  }
}

// ---------- shaping ----------

const text = (v, max = 500) => (v == null ? '' : String(v)).slice(0, max);
const count = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : 0);
const iso = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const time = (v) => (v ? Date.parse(v) || 0 : 0);

// A FAILED row is "unable" when the registry could not be reached (5xx /
// GST_VERIFICATION_FAILED) and "rejected" when the number was refused.
function kindOf(r) {
  if (r.status === 'VERIFIED') return 'verified';
  return Number(r.statusCode) >= 500 || r.errorCode === 'GST_VERIFICATION_FAILED' ? 'unable' : 'rejected';
}

function entry(r, businesses) {
  const kind = kindOf(r);
  const d = r.details && typeof r.details === 'object' ? r.details : null;
  const businessId = text(r.businessId, 40);
  const b = businessId ? businesses.get(businessId) : null;
  const accountCreatedAt = iso(r.confirmedAt);
  return {
    gstNumber: text(r.gstNumber, 20),
    kind,
    attempts: count(r.attempts),
    failures: count(r.failures),
    // The backend keeps an old failure's reason after a later pass; show it
    // only while the latest outcome is a failure.
    reason: kind === 'verified' ? '' : text(r.reason, 300),
    errorCode: kind === 'verified' ? '' : text(r.errorCode, 60),
    statusCode: kind === 'verified' || r.statusCode == null ? null : count(r.statusCode),
    details: d ? {
      legalName: text(d.legalName, 200),
      tradeName: text(d.tradeName, 200),
      businessType: text(d.businessType, 80),
      address: text(d.address, 500),
      stateName: text(d.stateName, 80),
      pincode: text(d.pincode, 10),
      gstStatus: text(d.gstStatus, 40),
      isMock: Boolean(d.isMock),
    } : null,
    firstCheckedAt: iso(r.firstCheckedAt) || iso(r.createdAt),
    lastCheckedAt: iso(r.lastCheckedAt) || iso(r.updatedAt),
    verifiedAt: iso(r.verifiedAt),
    lastFailedAt: iso(r.lastFailedAt),
    resolvedAt: iso(r.resolvedAt),
    resolvedGstNumber: text(r.resolvedGstNumber, 20),
    // confirmedAt = a business was created with this number (the sign-up may
    // still be unfinished: see account.registered / account.step).
    accountCreatedAt,
    account: accountCreatedAt || businessId ? {
      found: Boolean(b),
      name: b ? text(b.tradeName || b.legalName, 200) : '',
      registered: b ? Boolean(b.isRegistered) : null,
      step: b ? text(b.registrationStep, 40) : '',
    } : null,
  };
}

// account (sign-up finished) > started (business created with the GST,
// sign-up not finished) > verified > failed (refused) > unable (registry down).
// confirmedAt alone only means the GST step created a business shell.
function userStatus(gsts) {
  if (gsts.some((g) => g.account && g.account.registered === true)) return 'account';
  if (gsts.some((g) => g.accountCreatedAt && !(g.account && g.account.found === false))) return 'started';
  if (gsts.some((g) => g.kind === 'verified')) return 'verified';
  if (gsts.some((g) => g.kind === 'rejected')) return 'failed';
  return 'unable';
}

// The dashboard is public: phone numbers are masked unless the owner opts
// in (GST_SHOW_PHONES=true), and row ids never carry the number.
const ID_SALT = crypto.randomBytes(16).toString('hex');
const userId = (mobile) => `u${crypto.createHash('sha256').update(`${ID_SALT}:${mobile}`).digest('hex').slice(0, 16)}`;
const maskPhone = (m) => (m.length > 4 ? `${m.slice(0, 2)}${'•'.repeat(m.length - 4)}${m.slice(-2)}` : '••••');

function shape(rows, businesses, { showPhones = false } = {}) {
  const groups = new Map();
  for (const r of rows) {
    const mobile = text(r.mobile, 20);
    // Rows without a mobile are one per GST number.
    const key = mobile || `gst:${text(r.gstNumber, 20)}`;
    if (!groups.has(key)) groups.set(key, { id: mobile ? userId(mobile) : key, mobile, rows: [] });
    groups.get(key).rows.push(r);
  }

  const users = [...groups.values()].map((g) => {
    const byLatest = g.rows.slice().sort((a, b) => time(b.lastCheckedAt || b.updatedAt) - time(a.lastCheckedAt || a.updatedAt));
    const gsts = byLatest.map((r) => entry(r, businesses));
    const name = (byLatest.find((r) => text(r.fullName).trim()) || {}).fullName || '';
    return {
      id: g.id,
      name: text(name, 120).trim(),
      phone: g.mobile && !showPhones ? maskPhone(g.mobile) : g.mobile,
      hits: gsts.reduce((n, x) => n + x.attempts, 0),
      failures: gsts.reduce((n, x) => n + x.failures, 0),
      status: userStatus(gsts),
      firstCheckedAt: gsts.map((x) => x.firstCheckedAt).filter(Boolean).sort()[0] || null,
      lastCheckedAt: gsts.map((x) => x.lastCheckedAt).filter(Boolean).sort().pop() || null,
      gsts,
    };
  });

  // Per user, so each tile matches its filter chip.
  const by = (...statuses) => users.filter((u) => statuses.includes(u.status)).length;
  return {
    users,
    phonesMasked: !showPhones,
    totals: {
      checks: users.reduce((n, u) => n + u.hits, 0),
      users: users.length,
      gstNumbers: users.reduce((n, u) => n + u.gsts.length, 0),
      verified: by('account', 'started', 'verified'),
      failed: by('failed'),
      unable: by('unable'),
      accounts: by('account'),
    },
  };
}

// ---------- the route's data ----------

function describe(err) {
  const name = err && err.name;
  const msg = String((err && err.message) || err);
  if (err && err.status) return msg;
  if (/^timed out after/.test(msg)) return 'The database took too long to answer';
  if (name === 'MongoServerSelectionError' || /ENOTFOUND|ECONNREFUSED|Server selection timed out/i.test(msg)) {
    return 'Cannot reach the database (check Atlas Network Access for this server)';
  }
  if (err && (err.code === 18 || /auth(entication)? failed|bad auth/i.test(msg))) return 'Database login rejected (check MONGODB_URI)';
  if (err && err.code === 13) return 'The database user may not read gst_verifications / businesses';
  if (name === 'MongoTopologyClosedError') return 'Database connection was reset; it is retried on the next refresh';
  return msg.slice(0, 300);
}

function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Never rejects: { status, body } ready for res.status().json().
// opts.showPhones: send full phone numbers (GST_SHOW_PHONES=true).
async function load(env, { showPhones = false } = {}) {
  if (!env) return { status: 503, body: { error: 'The watched .env could not be read' } };
  // A read-only database user can be given separately; the backend's own
  // credential is the fallback.
  const uri = env.MONGODB_READ_URI || env.MONGODB_URI;
  if (!uri) return { status: 503, body: { error: 'MONGODB_URI is not set in the watched .env' } };
  const key = `${uri}|${showPhones}`;

  const now = Date.now();
  if (cache && cache.key === key && now - cache.at < CACHE_MS) return { status: 200, body: cache.body };
  if (failure && failure.key === key && now - failure.at < FAILURE_CACHE_MS) {
    return { status: failure.status, body: { error: failure.error } };
  }
  if (inflight && inflight.key === key) return inflight.job;

  const secrets = secretValues(env);
  const job = withDeadline(query(uri), DEADLINE_MS)
    .then((raw) => {
      const at = Date.now();
      const body = {
        ...shape(raw.rows.slice(0, MAX_ROWS), raw.businesses, { showPhones }),
        updatedAt: new Date(at).toISOString(),
        truncated: raw.rows.length > MAX_ROWS,
        collectionMissing: raw.missing,
      };
      cache = { key, at, body };
      failure = null;
      return { status: 200, body };
    })
    .catch((err) => {
      const status = err && err.status ? err.status : 503;
      const error = redact({ e: describe(err) }, secrets).e;
      failure = { key, at: Date.now(), status, error };
      return { status, body: { error } };
    })
    .finally(() => {
      if (inflight && inflight.job === job) inflight = null;
    });
  inflight = { key, job };
  return job;
}

// Tests only: forget cached data and close the client.
async function reset() {
  cache = null;
  failure = null;
  inflight = null;
  if (pool) {
    const p = pool;
    pool = null;
    clearTimeout(p.timer);
    await p.client.close().catch(() => {});
  }
}

module.exports = { load, shape, reset, MAX_ROWS };
