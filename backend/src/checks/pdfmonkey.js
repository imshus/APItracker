'use strict';

const { request } = require('../util');
const { failText } = require('../report');

const BASE = 'https://api.pdfmonkey.io/api/v1';

const TEMPLATES = [
  ['PDFMONKEY_TEMPLATE_ID_FOR_PREVIEW_INVOICE', 'Invoice template'],
  ['PDFMONKEY_TEMPLATE_ID_FOR_E_INVOICE', 'E-invoice template'],
];

module.exports = {
  id: 'pdfmonkey',
  name: 'PDFMonkey',
  category: 'Documents',
  purpose: 'Invoice and e-invoice PDF rendering',
  envVars: ['PDFMONKEY_API_SECRET', ...TEMPLATES.map(([name]) => name)],
  links: {
    Dashboard: 'https://dashboard.pdfmonkey.io/',
  },

  async check(env, r, settings) {
    const secret = env.PDFMONKEY_API_SECRET;
    if (!r.requireKey('PDFMONKEY_API_SECRET', secret)) return;
    const headers = { Authorization: `Bearer ${secret}` };

    const res = await request(`${BASE}/current_user`, { headers });
    r.latency(res.ms);
    if (!res.ok) return r.fail('down', failText('Secret rejected', res), res);

    const u = res.json?.current_user || {};
    r.fact('Plan', [u.current_plan, u.current_plan_interval].filter(Boolean).join(' / '));
    r.fact('Paying customer', u.paying_customer ? 'yes' : 'no');
    if (!u.paying_customer && u.trial_ends_on) r.expiry('Trial', u.trial_ends_on);
    r.setAvailable({ label: 'Documents left', value: u.available_documents, unit: 'documents', lowAt: settings.pdfmonkeyLowDocs });

    for (const [name, label] of TEMPLATES) {
      const id = env[name] || env.PDFMONKEY_TEMPLATE_ID;
      r.key(name, id, { plain: true });
      if (!id) {
        r.fact(label, 'not set here — the backend uses its built-in default');
        continue;
      }
      const t = await request(`${BASE}/document_templates/${encodeURIComponent(id)}`, { headers });
      if (t.ok) r.fact(label, `found · ${t.json?.document_template?.identifier || id}`);
      else if (t.status === 404) r.finding('down', `${label} ${id} not found — invoices using it will fail`);
      else r.finding('warn', `${label} could not be checked (HTTP ${t.status || t.networkError})`);
    }

    const left = Number(u.available_documents);
    r.summary = `Secret valid · ${Number.isFinite(left) ? left.toLocaleString('en-IN') : '?'} documents left`;
  },
};
