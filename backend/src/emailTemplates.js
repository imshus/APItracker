'use strict';

// The emails APItracker sends from info@mrpscan.com, in MRPscan's own email
// look (the same as the backend's payment invoice, utils/paymentInvoiceHtml.js):
// the cream page, a white card, the deep-red brand band with the serif
// "MRPscan", khaki labels and rounded pills.
//
// Pure functions of plain data, so they can be rendered in tests and
// previews. Tables and inline styles only: that is what mail clients honour.
//
//   alertEmail()   an issue opened, got worse or was resolved (API down,
//                  warnings, expiring keys/certificates, reported problems)
//   reportEmail()  the daily report, and the "test email" button

const C = {
  page: '#FBF7F0',
  card: '#FFFFFF',
  alt: '#F4ECDC',
  border: '#E9DDC4',
  text: '#15120D',
  label: '#857A63',
  brand: '#A81F17',
  brandSoft: '#F6D9D5',
  khaki: '#C7B792',
  down: '#A81F17', downBg: '#FDEAE7',
  warn: '#8A6100', warnBg: '#FBF1D6',
  ok: '#1A7A42', okBg: '#E7F4EC',
  off: '#857A63', offBg: '#F4ECDC',
};
const SERIF = "'Playfair Display', Georgia, 'Times New Roman', serif";
const SANS = "Roboto, 'Segoe UI', Arial, sans-serif";

const LEVEL = {
  down: { word: 'Down', color: C.down, bg: C.downBg },
  warn: { word: 'Needs attention', color: C.warn, bg: C.warnBg },
  ok: { word: 'Resolved', color: C.ok, bg: C.okBg },
};
const STATUS = {
  down: { word: 'Down', color: C.down, bg: C.downBg },
  warn: { word: 'Warning', color: C.warn, bg: C.warnBg },
  ok: { word: 'OK', color: C.ok, bg: C.okBg },
  off: { word: 'Not set', color: C.off, bg: C.offBg },
  pending: { word: 'Not checked', color: C.off, bg: C.offBg },
};

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const clip = (v, n) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
// Only http(s) links go into an href.
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');

const istDateTime = (v) => new Date(v).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
}).replace(/\b(am|pm)\b/, (m) => m.toUpperCase());
const istDay = (v) => new Date(v).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

function duration(fromIso, toIso) {
  const min = Math.max(1, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 48) return m ? `${h} h ${m} min` : `${h} h`;
  return `${(min / 1440).toFixed(1)} days`;
}

// ---------- building blocks ----------

function pill(word, color, bg) {
  return `<span style="display:inline-block;background:${bg};color:${color};font-family:${SANS};font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;padding:4px 10px;border-radius:999px;white-space:nowrap;">${esc(word)}</span>`;
}

function label(text) {
  return `<div style="font-family:${SANS};font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${C.label};margin:0 0 6px;">${esc(text)}</div>`;
}

// A button that also renders in Outlook (a table cell, not a styled <a>).
function button(text, href) {
  const url = safeUrl(href);
  if (!url) return '';
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr>
    <td style="background:${C.brand};border-radius:999px;">
      <a href="${esc(url)}" style="display:inline-block;padding:12px 26px;font-family:${SANS};font-size:14px;font-weight:800;color:#FFFFFF;text-decoration:none;border-radius:999px;">${esc(text)}</a>
    </td>
  </tr></table>`;
}

// The cream page, the white card and the brand band; `body` is table rows.
function frame({ title, preheader, kicker, stamp, body, footer }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;800&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:${C.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page};font-size:1px;line-height:1px;">${esc(preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${C.card};border:1px solid ${C.border};border-radius:18px;overflow:hidden;">

  <tr><td style="background:${C.brand};padding:20px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-family:${SERIF};font-size:26px;font-weight:800;color:#FFFFFF;">MRPscan</td>
      <td align="right" style="font-family:${SANS};">
        <div style="font-size:15px;font-weight:800;color:#FFFFFF;">${esc(kicker)}</div>
        <div style="font-size:12px;font-weight:600;color:${C.brandSoft};margin-top:3px;">${esc(stamp)}</div>
      </td>
    </tr></table>
  </td></tr>
${body}
  <tr><td style="padding:16px 24px 22px;">
    <div style="border-top:1px solid ${C.border};padding-top:14px;font-family:${SANS};font-size:12px;line-height:1.55;color:${C.label};text-align:center;">
      ${footer}
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

function footerText(ctx) {
  return `MRPscan API Monitor · sent from ${esc(ctx.from || 'info@mrpscan.com')} to the MRPscan team.<br>
      Amitaash IT Solutions Private Limited`;
}

// ---------- the alert ----------

// One change: an issue that opened, got worse or was resolved, with the
// service it belongs to (name, purpose, provider links) when known.
function changeCard(c, now) {
  const lv = LEVEL[c.kind];
  const svc = c.service || {};
  const link = Object.entries(svc.links || {}).map(([text, url]) => [text, safeUrl(url)]).find(([, url]) => url);
  const rows = [];
  const row = (k, v) => rows.push(`
          <tr>
            <td valign="top" width="96" style="padding:4px 10px 4px 0;font-family:${SANS};font-size:12.5px;color:${C.label};">${esc(k)}</td>
            <td valign="top" style="padding:4px 0;font-family:${SANS};font-size:13px;line-height:1.5;color:${C.text};">${v}</td>
          </tr>`);
  row(c.kind === 'ok' ? 'Was' : 'Problem', esc(clip(c.title, 300)));
  if (svc.purpose) row('Affects', esc(clip(svc.purpose, 160)));
  if (c.kind === 'ok') {
    row('Back since', esc(istDateTime(c.resolvedAt || now)));
    row('Lasted', esc(duration(c.openedAt, c.resolvedAt || now)));
  } else {
    row('Since', esc(istDateTime(c.openedAt)));
    if (c.worse) row('Change', 'Got worse: now down');
    if (c.source === 'report') row('Reported by', 'the MRPscan app');
  }
  if (link) row('Provider', `<a href="${esc(link[1])}" style="color:${C.brand};font-weight:700;text-decoration:none;">${esc(link[0])} ↗</a>`);
  return `
  <tr><td style="padding:8px 24px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.border};border-left:4px solid ${lv.color};border-radius:14px;">
      <tr><td style="padding:12px 16px 4px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-family:${SANS};font-size:15.5px;font-weight:800;color:${C.text};">${esc(c.serviceName)}</td>
          <td align="right">${pill(c.kind === 'ok' ? 'Resolved' : c.kind === 'down' ? 'Down' : 'Warning', lv.color, lv.bg)}</td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:2px 16px 12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.join('')}
        </table>
      </td></tr>
    </table>
  </td></tr>`;
}

function statusStrip(counts, open) {
  const cell = (n, word, color) => `<td align="center" style="padding:10px 4px;font-family:${SANS};"><div style="font-size:20px;font-weight:900;color:${color};">${n}</div><div style="font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${C.label};">${word}</div></td>`;
  return `
  <tr><td style="padding:14px 24px 0;">
    ${label('Right now')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};border:1px solid ${C.border};border-radius:14px;"><tr>
      ${cell(counts.ok, 'OK', C.ok)}${cell(counts.warn, 'Warning', counts.warn ? C.warn : C.label)}${cell(counts.down, 'Down', counts.down ? C.down : C.label)}${cell(open, 'Open issues', open ? C.down : C.label)}
    </tr></table>
  </td></tr>`;
}

const countStatuses = (services) => ({
  ok: services.filter((s) => s.status === 'ok').length,
  warn: services.filter((s) => s.status === 'warn').length,
  down: services.filter((s) => s.status === 'down').length,
});

/**
 * changes: [{ kind: 'down'|'warn'|'ok', worse?, serviceName, title, openedAt,
 *             resolvedAt?, source, service?: { purpose, links } }]
 * ctx: { services (overview services), openIssues, dashboardUrl, from, now }
 */
function alertEmail(changes, ctx) {
  const now = ctx.now || new Date().toISOString();
  const down = changes.filter((c) => c.kind === 'down');
  const warn = changes.filter((c) => c.kind === 'warn');
  const ok = changes.filter((c) => c.kind === 'ok');
  const top = down.length ? 'down' : warn.length ? 'warn' : 'ok';
  const lv = LEVEL[top];
  const one = changes.length === 1 ? changes[0] : null;

  const headline = one
    ? one.kind === 'down' ? `${one.serviceName} is down`
      : one.kind === 'warn' ? `${one.serviceName} needs attention`
        : `${one.serviceName} is back to normal`
    : [down.length && `${down.length} down`, warn.length && `${warn.length} need${warn.length === 1 ? 's' : ''} attention`, ok.length && `${ok.length} resolved`]
      .filter(Boolean).join(' · ');
  const tag = top === 'down' ? 'URGENT' : top === 'warn' ? 'Attention' : 'Resolved';
  // Short enough for a phone inbox; the problem itself is the preview line.
  const subject = clip(`${tag} · ${headline} — MRPscan API Monitor`, 120);
  const intro = top === 'down'
    ? 'Something MRPscan depends on has stopped working. Customers may be affected until it is fixed.'
    : top === 'warn'
      ? 'Something needs attention soon, before it turns into an outage.'
      : 'Everything below is working again. No action needed.';
  const preheader = one ? clip(one.title, 120) : intro;
  const counts = countStatuses(ctx.services || []);
  const order = { down: 0, warn: 1, ok: 2 };
  const sorted = changes.slice().sort((a, b) => order[a.kind] - order[b.kind]);

  const body = `
  <tr><td style="padding:20px 24px 4px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${lv.bg};border-radius:14px;"><tr>
      <td style="padding:16px 18px;">
        <div style="font-family:${SANS};font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:${lv.color};">${esc(tag === 'URGENT' ? 'Urgent · API down' : tag === 'Attention' ? 'Needs attention' : 'Back to normal')}</div>
        <div style="font-family:${SERIF};font-size:22px;font-weight:800;line-height:1.25;color:${C.text};margin-top:4px;">${esc(headline)}</div>
        <div style="font-family:${SANS};font-size:13px;line-height:1.5;color:${C.text};margin-top:6px;">${esc(intro)}</div>
      </td>
    </tr></table>
  </td></tr>
${sorted.map((c) => changeCard(c, now)).join('')}
${statusStrip(counts, ctx.openIssues || 0)}
  <tr><td style="padding:20px 24px 4px;">${button('Open APItracker', ctx.dashboardUrl)}</td></tr>
  <tr><td style="padding:6px 24px 0;font-family:${SANS};font-size:12px;color:${C.label};text-align:center;">
    ${top === 'ok' ? 'This was checked again and is working.' : 'You will get another email when this is resolved.'}
  </td></tr>`;

  const html = frame({
    title: subject,
    preheader,
    kicker: 'API Monitor',
    stamp: `${istDateTime(now)} IST`,
    body,
    footer: footerText(ctx),
  });

  const text = [
    `MRPscan API Monitor — ${tag}`,
    headline,
    intro,
    '',
    ...sorted.flatMap((c) => [
      `${c.kind === 'ok' ? 'RESOLVED' : c.kind === 'down' ? 'DOWN' : 'WARNING'} · ${c.serviceName}`,
      `  ${c.kind === 'ok' ? 'Was' : 'Problem'}: ${clip(c.title, 300)}`,
      c.service && c.service.purpose ? `  Affects: ${clip(c.service.purpose, 160)}` : '',
      c.kind === 'ok'
        ? `  Back since ${istDateTime(c.resolvedAt || now)} IST (lasted ${duration(c.openedAt, c.resolvedAt || now)})`
        : `  Since ${istDateTime(c.openedAt)} IST${c.worse ? ' · got worse: now down' : ''}`,
      '',
    ]),
    `Right now: ${counts.ok} OK, ${counts.warn} warning, ${counts.down} down, ${ctx.openIssues || 0} open issues`,
    safeUrl(ctx.dashboardUrl) ? `Open APItracker: ${ctx.dashboardUrl}` : '',
    '',
    `MRPscan API Monitor · sent from ${ctx.from || 'info@mrpscan.com'}`,
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n');

  return { subject, html, text, urgent: top === 'down' };
}

// ---------- the daily report / test email ----------

/**
 * rows: [{ name, status, line, balance, expiry }] (already worst-first)
 * open: [{ serviceName, title, openedAt }]
 * kind: 'daily' | 'test'
 */
function reportEmail({ rows, open, kind }, ctx) {
  const now = ctx.now || new Date().toISOString();
  const counts = {
    ok: rows.filter((r) => r.status === 'ok').length,
    warn: rows.filter((r) => r.status === 'warn').length,
    down: rows.filter((r) => r.status === 'down').length,
  };
  const top = counts.down ? 'down' : counts.warn ? 'warn' : counts.ok ? 'ok' : 'none';
  const headline = counts.down ? `${counts.down} service${counts.down === 1 ? '' : 's'} down`
    : counts.warn ? `${counts.warn} need${counts.warn === 1 ? 's' : ''} attention`
      : counts.ok ? 'All good' : 'Nothing checked yet';
  const box = { down: LEVEL.down, warn: LEVEL.warn, ok: LEVEL.ok, none: { color: C.label, bg: C.alt } }[top];
  const isTest = kind === 'test';
  const subject = isTest
    ? 'MRPscan API Monitor · test email'
    : `MRPscan daily API report · ${headline} · ${istDay(now)}`;
  const intro = isTest
    ? 'This is a test email. If you can read it, alerts from APItracker reach this address. No action needed.'
    : `Status of every API, key and balance MRPscan runs on, checked by APItracker.`;

  const serviceRows = rows.map((r) => {
    const st = STATUS[r.status] || STATUS.pending;
    return `
      <tr>
        <td valign="top" style="padding:10px 0 10px 16px;border-top:1px solid ${C.border};">
          <div style="font-family:${SANS};font-size:14px;font-weight:800;color:${C.text};">${esc(r.name)}</div>
          ${r.line ? `<div style="font-family:${SANS};font-size:12.5px;line-height:1.45;color:${r.status === 'ok' ? C.label : st.color};margin-top:2px;">${esc(clip(r.line, 200))}</div>` : ''}
          ${r.balance || r.expiry ? `<div style="font-family:${SANS};font-size:12px;color:${C.label};margin-top:2px;">${esc([r.balance, r.expiry].filter(Boolean).join(' · '))}</div>` : ''}
        </td>
        <td valign="top" align="right" style="padding:10px 16px 10px 8px;border-top:1px solid ${C.border};">${pill(st.word, st.color, st.bg)}</td>
      </tr>`;
  }).join('');

  const openRows = open.map((i) => `
      <tr><td style="padding:6px 0;font-family:${SANS};font-size:13px;line-height:1.5;color:${C.text};border-top:1px solid ${C.border};">
        <b>${esc(i.serviceName)}</b> — ${esc(clip(i.title, 200))}<br><span style="color:${C.label};font-size:12px;">since ${esc(istDateTime(i.openedAt))} IST</span>
      </td></tr>`).join('');

  const body = `
  <tr><td style="padding:20px 24px 4px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${box.bg};border-radius:14px;"><tr>
      <td style="padding:16px 18px;">
        <div style="font-family:${SANS};font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:${box.color};">${isTest ? 'Test email' : 'Daily report'}</div>
        <div style="font-family:${SERIF};font-size:22px;font-weight:800;line-height:1.25;color:${C.text};margin-top:4px;">${esc(headline)}</div>
        <div style="font-family:${SANS};font-size:13px;line-height:1.5;color:${C.text};margin-top:6px;">${esc(intro)}</div>
      </td>
    </tr></table>
  </td></tr>
${statusStrip(counts, open.length)}
  ${open.length ? `<tr><td style="padding:16px 24px 0;">
    ${label('Open issues')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${openRows}
    </table>
  </td></tr>` : ''}
  ${rows.length ? `<tr><td style="padding:16px 24px 0;">
    ${label('Services')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.border};border-radius:14px;">
      <tr style="background:${C.alt};"><td style="padding:9px 16px;font-family:${SANS};font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${C.label};">Service</td><td align="right" style="padding:9px 16px;font-family:${SANS};font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${C.label};">Status</td></tr>${serviceRows}
    </table>
  </td></tr>` : ''}
  <tr><td style="padding:20px 24px 4px;">${button('Open APItracker', ctx.dashboardUrl)}</td></tr>`;

  const html = frame({
    title: subject,
    preheader: isTest ? intro : `${headline} — ${counts.ok} OK, ${counts.warn} warning, ${counts.down} down, ${open.length} open issues`,
    kicker: isTest ? 'Test email' : 'Daily API report',
    stamp: `${istDateTime(now)} IST`,
    body,
    footer: footerText(ctx),
  });

  const text = [
    `MRPscan API Monitor — ${isTest ? 'test email' : 'daily report'}`,
    headline,
    intro,
    '',
    `Right now: ${counts.ok} OK, ${counts.warn} warning, ${counts.down} down, ${open.length} open issues`,
    ...(open.length ? ['', 'Open issues:', ...open.map((i) => `- ${i.serviceName}: ${clip(i.title, 200)} (since ${istDateTime(i.openedAt)} IST)`)] : []),
    ...(rows.length ? ['', 'Services:', ...rows.map((r) => `${(STATUS[r.status] || STATUS.pending).word.toUpperCase()} · ${r.name}${r.line ? `: ${clip(r.line, 200)}` : ''}${r.balance || r.expiry ? ` [${[r.balance, r.expiry].filter(Boolean).join(' · ')}]` : ''}`)] : []),
    '',
    safeUrl(ctx.dashboardUrl) ? `Open APItracker: ${ctx.dashboardUrl}` : '',
    `MRPscan API Monitor · sent from ${ctx.from || 'info@mrpscan.com'}`,
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n');

  return { subject, html, text, urgent: false };
}

module.exports = { alertEmail, reportEmail, duration };
