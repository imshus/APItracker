'use strict';

const { request, providerMessage } = require('../util');

// balance.php answers "0" for an unknown key too, so the key is proven with
// validate.php ("Valid", or an error code such as 201) and the balances are
// only read after that. Wallet accounts keep their money on type 0 while
// the old per-route balances stay 0, so the largest one counts.
const BALANCES = [
  { type: '0', label: 'main' },
  { type: '106', label: 'OTP route' },
  { type: '4', label: 'transactional route' },
];

module.exports = {
  id: 'msg91',
  name: 'MSG91',
  category: 'Messaging',
  purpose: 'Login / signup OTP SMS',
  envVars: ['MSG91_AUTH_KEY', 'MSG91_TEMPLATE_ID'],
  links: {
    Dashboard: 'https://control.msg91.com/app/',
    'Auth keys': 'https://control.msg91.com/app/m/l/settings/security/authkey',
  },

  async check(env, r, settings) {
    const key = env.MSG91_AUTH_KEY;
    if (!r.requireKey('MSG91_AUTH_KEY', key)) return;
    r.key('MSG91_TEMPLATE_ID', env.MSG91_TEMPLATE_ID, { plain: true });
    if (!env.MSG91_TEMPLATE_ID) r.finding('down', 'MSG91_TEMPLATE_ID is not set — OTP sends fail');

    const auth = encodeURIComponent(key);
    const valid = await request(`https://control.msg91.com/api/validate.php?authkey=${auth}`);
    r.latency(valid.ms);
    const answer = String(valid.text || '').trim();
    if (valid.networkError || !valid.ok) return r.fail('down', `MSG91 unreachable: ${valid.networkError || `HTTP ${valid.status}`}`, valid);
    if (!/^valid$/i.test(answer)) {
      return r.fail('down', `Auth key rejected (MSG91 answered ${providerMessage(valid) || 'nothing'})`, valid);
    }

    const results = await Promise.all(BALANCES.map(async (b) => {
      const res = await request(`https://control.msg91.com/api/balance.php?authkey=${auth}&type=${b.type}`);
      const text = String(res.text || '').trim();
      return { ...b, value: res.ok && /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : null };
    }));
    for (const b of results) r.fact(`Balance (${b.label})`, b.value == null ? 'not readable' : b.value.toLocaleString('en-IN'));

    const readable = results.filter((b) => b.value != null);
    if (!readable.length) {
      r.summary = 'Key valid · balance not readable';
      r.finding('warn', 'MSG91 did not return any balance');
      return;
    }
    const best = readable.reduce((a, b) => (b.value > a.value ? b : a));
    r.setAvailable({ label: `SMS balance (${best.label})`, value: best.value, lowAt: settings.msg91LowBalance });
    r.summary = `Key valid · balance ${best.value.toLocaleString('en-IN')} (${best.label})`;
  },
};
