'use strict';

const MIN_LENGTH = 32;

module.exports = {
  id: 'secrets',
  name: 'Server secrets',
  category: 'Secrets',
  purpose: 'JWT login tokens and e-invoice password encryption',
  envVars: ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'EINVOICE_CRED_KEY'],
  links: {},

  // Nothing to call: these only need to exist and be strong.
  async check(env, r) {
    const access = env.JWT_ACCESS_SECRET;
    const refresh = env.JWT_REFRESH_SECRET;
    const cred = env.EINVOICE_CRED_KEY;

    for (const [name, value] of [['JWT_ACCESS_SECRET', access], ['JWT_REFRESH_SECRET', refresh]]) {
      r.key(name, value);
      if (!value) r.finding('down', `${name} is not set — the backend will not start`);
      else if (value.length < MIN_LENGTH) r.finding('warn', `${name} is only ${value.length} characters — use at least ${MIN_LENGTH} random characters`);
    }
    if (access && refresh && access === refresh) r.finding('warn', 'JWT access and refresh secrets are the same');

    r.key('EINVOICE_CRED_KEY', cred);
    if (!cred) r.finding('warn', 'EINVOICE_CRED_KEY is not set — e-invoice credentials cannot be saved');
    else if (cred.length < MIN_LENGTH) r.finding('warn', `EINVOICE_CRED_KEY is only ${cred.length} characters`);

    r.note('These never expire. Changing a JWT secret logs every user out; changing EINVOICE_CRED_KEY makes saved e-invoice passwords unreadable.');
    const problems = r.findings.length;
    r.summary = problems ? `${problems} issue${problems === 1 ? '' : 's'} found` : 'All present and strong';
  },
};
