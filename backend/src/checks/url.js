'use strict';

const { request, tlsCertificate } = require('../util');
const { failText } = require('../report');

// One watched address: is it up, how fast, and when does its TLS
// certificate run out.
function urlService(url, { envVar, name, purpose }) {
  let parsed;
  try { parsed = new URL(url); } catch { parsed = null; }
  const id = `url:${parsed ? parsed.host + parsed.pathname.replace(/\/+$/, '') : url}`;

  return {
    id,
    name: name || (parsed ? parsed.host : url),
    category: 'Endpoints',
    purpose: purpose || (parsed ? parsed.pathname.replace(/\/+$/, '') || '/' : ''),
    envVars: [envVar],
    links: parsed ? { Open: url } : {},

    async check(env, r, settings) {
      r.key(envVar, url, { plain: true });
      if (!parsed || !/^https?:$/.test(parsed.protocol)) return r.fail('down', `Not a valid http(s) URL: ${url}`);

      const res = await request(url, { timeoutMs: 20000 });
      r.latency(res.ms);
      if (res.networkError) return r.fail('down', `Unreachable: ${res.networkError}`, res);

      r.fact('HTTP status', res.status);
      const appStatus = res.json && typeof res.json === 'object' ? res.json.status : null;
      if (typeof appStatus === 'string') r.fact('Reported status', appStatus);

      if (res.status >= 500) r.fail('down', failText('Server error', res), res);
      else if (res.status >= 400) r.fail('warn', failText('Client error', res), res);
      else r.summary = `Up · HTTP ${res.status} · ${res.ms} ms`;
      if (res.ms > settings.slowMs) r.finding('warn', `Slow: answered in ${(res.ms / 1000).toFixed(1)} s`);

      if (parsed.protocol === 'https:') {
        const cert = await tlsCertificate(parsed.hostname, Number(parsed.port) || 443);
        if (cert.error) {
          r.finding('warn', `TLS certificate could not be read: ${cert.error}`);
        } else {
          r.expiry('TLS certificate', cert.validTo);
          r.fact('Certificate issuer', cert.issuer);
          r.fact('Certificate for', cert.subject);
          r.fact('TLS', cert.protocol);
          if (!cert.authorized) r.finding('down', `Certificate not trusted: ${cert.authorizationError}`);
        }
      }
    },
  };
}

module.exports = { urlService };
