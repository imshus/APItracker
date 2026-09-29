'use strict';

const { worst } = require('./util');

const DAY = 24 * 3600 * 1000;

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

// Manual dates are whole days in IST; they run out at the end of that day.
function manualExpiry(meta) {
  if (!meta || !/^\d{4}-\d{2}-\d{2}$/.test(meta.expiresOn || '')) return null;
  return { label: meta.expiryLabel || 'Renewal / expiry', at: new Date(`${meta.expiresOn}T23:59:59+05:30`).toISOString(), source: 'manual', info: false };
}

// A stored result plus what has changed since it was taken (time passing
// towards an expiry date, a manually entered date) → current status and
// the list of problems behind it.
function evaluate(result, meta, settings, now = Date.now()) {
  const expiries = [...((result && result.expiries) || [])];
  const manual = manualExpiry(meta);
  if (manual) expiries.push(manual);

  const problems = [];
  let status = result ? result.status : 'pending';
  if (result && result.failLevel) problems.push({ level: result.failLevel, message: result.summary });
  for (const f of (result && result.findings) || []) problems.push(f);

  const withDays = expiries.map((e) => {
    const daysLeft = Math.ceil((Date.parse(e.at) - now) / DAY);
    if (!e.info) {
      if (Date.parse(e.at) < now) problems.push({ level: 'down', message: `${e.label} expired on ${fmtDate(e.at)}` });
      else if (daysLeft <= settings.expiryWarnDays) {
        problems.push({ level: 'warn', message: `${e.label} expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (${fmtDate(e.at)})` });
      }
    }
    return { ...e, daysLeft };
  });

  for (const p of problems) status = status === 'pending' || status === 'off' ? worst('ok', p.level) : worst(status, p.level);
  return { status, problems, expiries: withDays };
}

module.exports = { evaluate, fmtDate };
