'use strict';

// Follow-up emails, sent from a Gmail account (ALERT_GMAIL_USER + an App
// Password) or else over the backend's SMTP account (see mailer.js), in
// MRPscan's email look (emailTemplates.js):
// - when an issue opens, gets worse (warning → down) or is resolved, one email
//   per run that changed something; "down" goes out as high priority;
// - a daily report at DAILY_SUMMARY_HOUR (IST) with every service's status,
//   balance and next expiry.
// Off until ALERT_EMAIL_TO is set in the tracker's own .env.
const { smtpConfig, createTransport, describeSmtpError, fromHeader } = require('./mailer');
const { alertEmail, reportEmail } = require('./emailTemplates');

const RANK = { ok: 0, warn: 1, down: 2 };
const TEST_GAP_MS = 10 * 60 * 1000;
const SUMMARY_RETRY_MS = 30 * 60 * 1000;
const SENDER_NAME = 'MRPscan API Monitor';
const REPORT_MAILS_PER_HOUR = 10;

function istNow(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

function maskEmail(addr) {
  const [local, domain] = String(addr).split('@');
  if (!domain) return '••••';
  return `${local.slice(0, 2)}••••@${domain}`;
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
  const e = (s.expiries || []).filter((x) => !x.info).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
  if (!e) return '';
  const date = new Date(e.at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
  // The date itself decides (as evaluate() does): hours past it is expired,
  // not "in 0 days".
  const past = Date.parse(e.at) < Date.now();
  return `${e.label}: ${date} (${past ? 'expired' : `in ${e.daysLeft} day${e.daysLeft === 1 ? '' : 's'}`})`;
}

class Notifier {
  // summary(): the dashboard overview (services with status, result, meta,
  // expiries, purpose, links) — used to describe what each issue affects and
  // for the daily report.
  constructor({ store, settings, readEnv, summary }) {
    this.store = store;
    this.settings = settings;
    this.readEnv = readEnv;
    this.summary = summary;
    // Issues from before this way of tracking count as already emailed, so
    // the first run after an update does not mail every open issue again.
    if (!this.record.trackedOnIssues) {
      for (const i of this.store.state.incidents) {
        if (i.resolvedAt) i.notifiedResolved = true;
        else i.notifiedLevel = i.level;
      }
      this.record.trackedOnIssues = true;
      this.store.save();
    }
  }

  get enabled() {
    return this.settings.alertEmailTo.length > 0;
  }

  get record() {
    if (!this.store.state.notify) this.store.state.notify = {};
    return this.store.state.notify;
  }

  // The account the updates go out from: the Gmail sender when
  // ALERT_GMAIL_USER is set, else the backend's SMTP account.
  sender() {
    const { alertGmailUser: user, alertGmailPass: pass } = this.settings;
    if (user) return { via: 'Gmail', host: 'smtp.gmail.com', port: 465, secure: true, user, pass, from: user };
    return { via: 'backend SMTP', ...smtpConfig(this.readEnv() || {}) };
  }

  status() {
    const n = this.store.state.notify || {};
    const s = this.sender();
    return {
      enabled: this.enabled,
      to: this.settings.alertEmailTo.map(maskEmail),
      from: s.from ? `${maskEmail(s.from.replace(/^.*<|>.*$/g, ''))} (${s.via})` : null,
      dailyHour: this.settings.dailySummaryHour,
      lastSentAt: n.lastSentAt || null,
      lastSubject: n.lastSubject || null,
      lastError: n.lastError || null,
      lastErrorAt: n.lastErrorAt || null,
    };
  }

  // What every template needs to know about the moment it is sent.
  context() {
    const d = this.summary();
    const cfg = this.sender();
    return {
      services: d.services || [],
      openIssues: this.store.state.incidents.filter((i) => !i.resolvedAt).length,
      dashboardUrl: this.settings.dashboardUrl,
      from: String(cfg.from || '').replace(/^.*<|>.*$/g, ''),
      now: new Date().toISOString(),
    };
  }

  // mail: { subject, text, html, urgent }
  async send(mail) {
    const cfg = this.sender();
    if (cfg.via === 'Gmail' && !cfg.pass) throw new Error('ALERT_GMAIL_APP_PASSWORD is not set in backend/.env');
    if (!cfg.host || !cfg.from) throw new Error('No sender: set ALERT_GMAIL_USER in backend/.env, or SMTP_HOST / SMTP_FROM in the watched .env');
    const transport = createTransport(cfg);
    try {
      await transport.sendMail({
        from: fromHeader(cfg.from, SENDER_NAME),
        to: this.settings.alertEmailTo.join(', '),
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        // "API down" is flagged urgent in the inbox (X-Priority 1 / Importance: high).
        ...(mail.urgent ? { priority: 'high' } : {}),
      });
    } finally {
      transport.close();
    }
  }

  // Sends and remembers the outcome; never throws (a mail problem must not
  // break a check run).
  async deliver(mail) {
    const rec = this.record;
    try {
      await this.send(mail);
      rec.lastSentAt = new Date().toISOString();
      rec.lastSubject = mail.subject;
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

  // Callers do not await these two; they must never reject.
  afterChange() {
    return this.changeMail().catch((err) => console.error('[notify] change email:', err));
  }

  maybeDailySummary() {
    return this.dailyMail().catch((err) => console.error('[notify] daily summary:', err));
  }

  // What each issue has already been emailed as lives on the issue itself
  // (notifiedLevel / notifiedResolved), and is marked before anything is
  // awaited: a run and a dashboard click at the same moment cannot both
  // send the same change. Marked even while email is off, so turning it on
  // later does not mail the backlog.
  takeChanges() {
    const list = this.store.state.incidents;
    const opened = list.filter((i) => !i.resolvedAt && !i.notifiedLevel);
    const worse = list.filter((i) => !i.resolvedAt && i.notifiedLevel && RANK[i.level] > RANK[i.notifiedLevel]);
    const resolved = list.filter((i) => i.resolvedAt && i.notifiedLevel && !i.notifiedResolved);
    // Opened and closed between two emails: nobody was told it opened.
    const silent = list.filter((i) => i.resolvedAt && !i.notifiedLevel && !i.notifiedResolved);
    for (const i of [...opened, ...worse]) i.notifiedLevel = i.level;
    for (const i of [...resolved, ...silent]) i.notifiedResolved = true;
    if (opened.length || worse.length || resolved.length || silent.length) this.store.save();
    return { opened, worse, resolved };
  }

  // Problems posted to the public POST /api/issues: at most this many emails
  // an hour, so the endpoint cannot be used to flood the team's inboxes.
  allowReportMail() {
    const rec = this.record;
    const hourAgo = Date.now() - 3600 * 1000;
    rec.reportMails = (rec.reportMails || []).filter((t) => Date.parse(t) > hourAgo);
    if (rec.reportMails.length >= REPORT_MAILS_PER_HOUR) return false;
    rec.reportMails.push(new Date().toISOString());
    return true;
  }

  async changeMail() {
    let { opened, worse, resolved } = this.takeChanges();
    if (!this.enabled) return;
    const isReport = (i) => i.source === 'report';
    if ([...opened, ...worse, ...resolved].some(isReport) && !this.allowReportMail()) {
      console.warn('[notify] report emails limited to', REPORT_MAILS_PER_HOUR, 'an hour; report changes not emailed');
      opened = opened.filter((i) => !isReport(i));
      worse = worse.filter((i) => !isReport(i));
      resolved = resolved.filter((i) => !isReport(i));
    }
    if (!opened.length && !worse.length && !resolved.length) return;

    const ctx = this.context();
    const service = (i) => {
      const s = ctx.services.find((x) => x.id === i.serviceId);
      return s ? { purpose: s.purpose, links: s.links } : null;
    };
    const change = (i, kind, extra = {}) => ({
      kind,
      serviceName: i.serviceName,
      title: i.title,
      openedAt: i.openedAt,
      resolvedAt: i.resolvedAt,
      // check (a clean check) | manual (dashboard button) | untracked
      resolvedBy: i.resolvedBy || (i.source === 'report' ? 'manual' : 'check'),
      resolveNote: i.resolveNote || null,
      source: i.source,
      service: service(i),
      ...extra,
    });
    const changes = [
      ...opened.map((i) => change(i, i.level === 'down' ? 'down' : 'warn')),
      ...worse.map((i) => change(i, i.level === 'down' ? 'down' : 'warn', { worse: true })),
      ...resolved.map((i) => change(i, 'ok')),
    ];
    await this.deliver(alertEmail(changes, ctx));
  }

  reportMail(kind) {
    const ctx = this.context();
    const order = { down: 0, warn: 1, pending: 2, off: 3, ok: 4 };
    const rows = ctx.services
      .slice()
      .sort((a, b) => (order[a.status] ?? 5) - (order[b.status] ?? 5) || a.name.localeCompare(b.name))
      .map((s) => ({
        name: s.name,
        status: s.status,
        line: (s.problems && s.problems[0] && s.problems[0].message) || (s.result && s.result.summary) || '',
        balance: balanceText(s),
        expiry: expiryText(s),
      }));
    const open = this.store.state.incidents
      .filter((i) => !i.resolvedAt)
      .map((i) => ({ serviceName: i.serviceName, title: i.title, openedAt: i.openedAt }));
    return reportEmail({ rows, open, kind }, ctx);
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
    const out = await this.deliver(this.reportMail('daily'));
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
    return this.deliver(this.reportMail('test'));
  }
}

module.exports = { Notifier, istNow };
