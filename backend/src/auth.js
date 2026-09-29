'use strict';

// Optional password sign-in for the dashboard. With TRACKER_PASSWORD empty
// (the default) everything is open: no sign-in, no key. With a password,
// POST /api/login sets a signed session cookie (30 days); scripts can send
// the password in the x-tracker-password header instead. Sessions are signed
// with a key derived from the password, so changing it signs everyone out.
const crypto = require('node:crypto');

const COOKIE = 'apitracker_session';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

const isLoopbackAddr = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';

function createAuth(settings) {
  const open = !settings.password;
  const sessionKey = crypto.createHash('sha256').update(`apitracker-session:${settings.password}`).digest();
  const fails = new Map();

  const originAllowed = (origin) => Boolean(origin)
    && (settings.corsOrigins.includes('*') || settings.corsOrigins.includes(origin.replace(/\/+$/, '')));

  // Behind the frontend server or nginx the socket is 127.0.0.1 and the real
  // visitor is the last X-Forwarded-For hop.
  function clientIp(req) {
    const socket = req.socket.remoteAddress || '';
    const fwd = req.get('x-forwarded-for');
    return isLoopbackAddr(socket) && fwd ? fwd.split(',').pop().trim() : socket;
  }

  // TRUST_LOCALHOST=true lets this same computer skip sign-in (laptop only).
  // A page from an origin that is not allowed never counts as local, so a
  // random website open on the laptop cannot read the API through localhost.
  function isLocal(req) {
    if (!settings.trustLocalhost || !isLoopbackAddr(req.socket.remoteAddress)) return false;
    const origin = req.get('origin');
    if (origin && !originAllowed(origin)) return false;
    return isLoopbackAddr(clientIp(req));
  }

  function passwordMatches(given) {
    // Compare digests so the lengths always match for timingSafeEqual.
    const a = crypto.createHash('sha256').update(String(given || '')).digest();
    const b = crypto.createHash('sha256').update(settings.password).digest();
    return crypto.timingSafeEqual(a, b);
  }

  function sign(value) {
    return crypto.createHmac('sha256', sessionKey).update(value).digest('base64url');
  }

  function readCookie(req) {
    const header = req.get('cookie') || '';
    for (const part of header.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === COOKIE) return rest.join('=');
    }
    return '';
  }

  function hasSession(req) {
    const [expires, sig] = readCookie(req).split('.');
    if (!expires || !sig || !(Number(expires) > Date.now())) return false;
    const expected = Buffer.from(sign(expires));
    const got = Buffer.from(sig);
    return expected.length === got.length && crypto.timingSafeEqual(expected, got);
  }

  function isHttps(req) {
    return req.secure || String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https';
  }

  function setSession(req, res) {
    const expires = String(Date.now() + SESSION_MS);
    res.cookie(COOKIE, `${expires}.${sign(expires)}`, {
      httpOnly: true, sameSite: 'lax', secure: isHttps(req), path: '/', maxAge: SESSION_MS,
    });
  }

  function clearSession(req, res) {
    res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: isHttps(req), path: '/' });
  }

  function isSignedIn(req) {
    return open || isLocal(req) || hasSession(req) || (req.get('x-tracker-password') ? passwordMatches(req.get('x-tracker-password')) : false);
  }

  function requireAuth(req, res, next) {
    if (isSignedIn(req)) return next();
    return res.status(401).json({ error: 'Sign in required', authRequired: true });
  }

  // Returns seconds to wait when this address has failed too often.
  function lockedFor(ip) {
    const f = fails.get(ip);
    if (!f || f.resetAt < Date.now()) return 0;
    return f.count >= MAX_FAILS ? Math.ceil((f.resetAt - Date.now()) / 1000) : 0;
  }

  function recordFail(ip) {
    const now = Date.now();
    const f = fails.get(ip);
    if (!f || f.resetAt < now) fails.set(ip, { count: 1, resetAt: now + FAIL_WINDOW_MS });
    else f.count += 1;
    if (fails.size > 5000) for (const [k, v] of fails) if (v.resetAt < now) fails.delete(k);
  }

  function login(req, res) {
    if (open) return res.json({ ok: true });
    const ip = clientIp(req);
    const wait = lockedFor(ip);
    if (wait) return res.status(429).json({ error: `Too many wrong passwords. Try again in ${Math.ceil(wait / 60)} min.` });
    if (!passwordMatches(req.body?.password)) {
      recordFail(ip);
      return res.status(401).json({ error: 'Wrong password' });
    }
    fails.delete(ip);
    setSession(req, res);
    return res.json({ ok: true });
  }

  function logout(req, res) {
    clearSession(req, res);
    res.json({ ok: true });
  }

  function session(req, res) {
    res.json({ open, local: isLocal(req), signedIn: isSignedIn(req) });
  }

  return { open, originAllowed, isLocal, requireAuth, login, logout, session };
}

module.exports = { createAuth };
