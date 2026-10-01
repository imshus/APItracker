'use strict';

// Follow-up emails over the backend's SMTP account (see mailer.js):
// - when an issue opens, gets worse (warning → down) or is resolved, one email
//   per run that changed something;
// - a daily summary at DAILY_SUMMARY_HOUR (IST) with every service's status,
//   balance and next expiry.
// Off until ALERT_EMAIL_TO is set in the tracker's own .env.
const { smtpConfig, createTransport, describeSmtpError, fromHeader } = require('./mailer');

const RANK = { ok: 0, warn: 1, down: 2 };
const LEVEL = { warn: 'Warning', down: 'Down', ok: 'Resolved' };
const STATUS = { ok: 'OK', warn: 'Warning', down: 'Down', off: 'Not set', pending: 'Not checked' };
const TEST_GAP_MS = 10 * 60 * 1000;
const SUMMARY_RETRY_MS = 30 * 60 * 1000;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function istNow(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

const when = (iso) => new Date(iso).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
});

function maskEmail(addr) {
  const [local, domain] = String(addr).split('@');
  if (!domain) return '••••';
  return `${local.slice(0, 2)}••••@${domain}`;
}

function duration(fromIso, toIso) {
  const min = Math.max(1, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60000));
  if (min < 60) return `${min} min`;
  if (min < 1440) return `${(min / 60).toFixed(min < 600 ? 1 : 0)} h`;
  return `${(min / 1440).toFixed(1)} days`;
}

function amount(a, value) {
  if (a.unit === 'bytes') {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let x = Number(value); let i = 0;
    while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
    return `${x.toFixed(x >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
  }
  if (a.money) return Number(value).toLocaleString(a.money === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency: a.money });
  return `${Number(value).toLocaleString('en-IN')}${a.unit ? ` ${a.unit}` : ''}`;
}

// "₹4,99,999 left" / "$12.40 left of $50 (entered)" / ''.
function balanceText(s) {
  const a = s.result?.available;
  if (a) return `${amount(a, a.value)} left${a.total ? ` of ${amount(a, a.total)}` : ''}`;
  const m = s.meta || {};
  if (m.amountLeft || m.amountTotal) return `${m.amountLeft || '?'} left${m.amountTotal ? ` of ${m.amountTotal}` : ''} (entered)`;
  return '';
}

function expiryText(s) {
  const e = s.expiries.filter((x) => !x.info).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
  if (!e) return '';
  const date = new Date(e.at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
  return `${e.label}: ${date} (${e.daysLeft < 0 ? 'expired' : `in ${e.daysLeft} days`})`;
}

class Notifier {
  // summary(): the dashboard overview (services with status, result, meta,
  // expiries) — used for the daily email and the test email.
  constructor({ store, settings, readEnv, summary }) {
    this.store = store;
    this.settings = settings;
    this.readEnv = readEnv;
    this.summary = summary;
  }

  get enabled() {
    return this.settings.alertEmailTo.length > 0;
  }

  get record() {
    if (!this.store.state.notify) this.store.state.notify = {};
    return this.store.state.notify;
  }

  status() {
    const n = this.store.state.notify || {};
    return {
      enabled: this.enabled,
      to: this.settings.alertEmailTo.map(maskEmail),
      dailyHour: this.settings.dailySummaryHour,
      lastSentAt: n.lastSentAt || null,
      lastSubject: n.lastSubject || null,
      lastError: n.lastError || null,
      lastErrorAt: n.lastErrorAt || null,
    };
  }

  async send(subject, text, html) {
    const cfg = smtpConfig(this.readEnv() || {});
    if (!cfg.host || !cfg.from) throw new Error('SMTP_HOST / SMTP_FROM are not set in the watched .env');
    const transport = createTransport(cfg);
    try {
      await transport.sendMail({
        from: fromHeader(cfg.from, 'APItracker'),
        to: this.settings.alertEmailTo.join(', '),
        subject,
        text,
        html,
      });
    } finally {
      transport.close();
    }
  }

  // Sends and remembers the outcome; never throws (a mail problem must not
  // break a check run).
  async deliver(subject, text, html) {
    const rec = this.record;
    try {
      await this.send(subject, text, html);
      rec.lastSentAt = new Date().toISOString();
      rec.lastSubject = subject;
      rec.lastError = null;
      return { ok: true };
    } catch (err) {
      rec.lastError = describeSmtpError(err).text;
      rec.lastErrorAt = new Date().toISOString();
      console.error('[notify]', rec.lastError);
      return { ok: false, error: rec.lastError };
    } finally {
      this.store.save();
    }
  }

  // Open issues and their level, before a change.
  snapshot() {
    return new Map(this.store.state.incidents.filter((i) => !i.resolvedAt).map((i) => [i.id, i.level]));
  }

  // Callers do not await these two; they must never reject.
  afterChange(before) {
    return this.changeMail(before).catch((err) => console.error('[notify] change email:', err));
  }

  maybeDailySummary() {
    return this.dailyMail().catch((err) => console.error('[notify] daily summary:', err));
  }

  async changeMail(before) {
    if (!this.enabled) return;
    const list = this.store.state.incidents;
    const opened = list.filter((i) => !i.resolvedAt && !before.has(i.id));
    const worse = list.filter((i) => !i.resolvedAt && before.has(i.id) && RANK[i.level] > RANK[before.get(i.id)]);
    const resolved = list.filter((i) => i.resolvedAt && before.has(i.id));
    const changes = [
      ...opened.map((i) => ({ i, kind: i.level, text: i.title, note: `opened ${when(i.openedAt)}` })),
      ...worse.map((i) => ({ i, kind: i.level, text: i.title, note: `now ${LEVEL[i.level].toLowerCase()}, open since ${when(i.openedAt)}` })),
      ...resolved.map((i) => ({ i, kind: 'ok', text: i.title, note: `resolved after ${duration(i.openedAt, i.resolvedAt)}` })),
    ];
    if (!changes.length) return;

    const subject = changes.length === 1
      ? `APItracker · ${LEVEL[changes[0].kind]}: ${changes[0].i.serviceName} — ${changes[0].text}`.slice(0, 180)
      : `APItracker · ${[
        opened.length && `${opened.length} new issue${opened.length === 1 ? '' : 's'}`,
        worse.length && `${worse.length} got worse`,
        resolved.length && `${resolved.length} resolved`,
      ].filter(Boolean).join(', ')}`;
    const url = this.settings.dashboardUrl;
    const text = [
      ...changes.map((c) => `${LEVEL[c.kind].toUpperCase()} · ${c.i.serviceName}: ${c.text} (${c.note})`),
      '',
      `Open issues now: ${list.filter((i) => !i.resolvedAt).length}`,
      `Dashboard: ${url}`,
    ].join('\n');
    const colour = { warn: '#8a6100', down: '#a81f17', ok: '#1a7a42' };
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#15120d">
      ${changes.map((c) => `<p style="margin:0 0 10px"><b style="color:${colour[c.kind]}">${LEVEL[c.kind]}</b> · <b>${esc(c.i.serviceName)}</b><br>${esc(c.text)}<br><span style="color:#857a63">${esc(c.note)}</span></p>`).join('')}
      <p style="color:#857a63">Open issues now: ${list.filter((i) => !i.resolvedAt).length} · <a href="${esc(url)}">Open APItracker</a></p></div>`;
    await this.deliver(subject, text, html);
  }

  summaryMail(title) {
    const d = this.summary();
    const order = { down: 0, warn: 1, pending: 2, off: 3, ok: 4 };
    const services = d.services.slice().sort((a, b) => (order[a.status] ?? 5) - (order[b.status] ?? 5) || a.name.localeCompare(b.name));
    const count = (st) => services.filter((s) => s.status === st).length;
    const headline = count('down') ? `${count('down')} down`
      : count('warn') ? `${count('warn')} need attention`
        : count('ok') ? 'All good' : 'Nothing checked yet';
    const lines = services.map((s) => {
      const bits = [balanceText(s), expiryText(s)].filter(Boolean).join(' · ');
      const what = s.problems[0]?.message || s.result?.summary || '';
      return { s, what, bits };
    });
    const open = this.store.state.incidents.filter((i) => !i.resolvedAt);
    const url = this.settings.dashboardUrl;
    const subject = `APItracker ${title} · ${headline}`;
    const text = [
      `${headline} — ${count('ok')} OK, ${count('warn')} warning, ${count('down')} down`,
      '',
      ...lines.map(({ s, what, bits }) => `${STATUS[s.status] || s.status} · ${s.name}: ${what}${bits ? ` [${bits}]` : ''}`),
      '',
      `Open issues: ${open.length}`,
      ...open.map((i) => `- ${i.serviceName}: ${i.title} (since ${when(i.openedAt)})`),
      '',
      `Dashboard: ${url}`,
    ].join('\n');
    const colour = { ok: '#1a7a42', warn: '#8a6100', down: '#a81f17' };
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#15120d">
      <h2 style="font-size:18px;margin:0 0 4px">${esc(headline)}</h2>
      <p style="color:#857a63;margin:0 0 12px">${count('ok')} OK · ${count('warn')} warning · ${count('down')} down · ${open.length} open issue${open.length === 1 ? '' : 's'}</p>
      <table cellpadding="6" style="border-collapse:collapse;font-size:13px">
        ${lines.map(({ s, what, bits }) => `<tr style="border-top:1px solid #e9ddc4"><td style="color:${colour[s.status] || '#857a63'};font-weight:bold;white-space:nowrap">${esc(STATUS[s.status] || s.status)}</td><td><b>${esc(s.name)}</b><br>${esc(what)}${bits ? `<br><span style="color:#857a63">${esc(bits)}</span>` : ''}</td></tr>`).join('')}
      </table>
      <p><a href="${esc(url)}">Open APItracker</a></p></div>`;
    return { subject, text, html };
  }

  // Called every few minutes; sends once a day after the set IST hour.
  async dailyMail() {
    const hour = this.settings.dailySummaryHour;
    if (!this.enabled || hour < 0) return;
    const now = istNow();
    const rec = this.record;
    if (now.hour < hour || rec.lastSummaryDay === now.day) return;
    if (rec.lastSummaryTry && Date.now() - Date.parse(rec.lastSummaryTry) < SUMMARY_RETRY_MS) return;
    rec.lastSummaryTry = new Date().toISOString();
    const mail = this.summaryMail('daily summary');
    const out = await this.deliver(mail.subject, mail.text, mail.html);
    if (out.ok) {
      rec.lastSummaryDay = now.day;
      this.store.save();
    }
  }

  // The button on the dashboard (which may be public), so at most one per
  // ten minutes.
  async test() {
    if (!this.enabled) return { ok: false, error: 'Email updates are off: set ALERT_EMAIL_TO in backend/.env' };
    const rec = this.record;
    if (rec.lastTestAt && Date.now() - Date.parse(rec.lastTestAt) < TEST_GAP_MS) {
      return { ok: false, error: 'A test email was sent in the last 10 minutes' };
    }
    rec.lastTestAt = new Date().toISOString();
    const mail = this.summaryMail('test update');
    return this.deliver(mail.subject, mail.text, mail.html);
  }
}

module.exports = { Notifier, istNow };
