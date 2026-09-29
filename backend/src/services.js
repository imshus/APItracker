'use strict';

const { urlService } = require('./checks/url');

const FIXED = [
  require('./checks/openai'),
  require('./checks/gemini'),
  require('./checks/razorpay'),
  require('./checks/msg91'),
  require('./checks/resend'),
  require('./checks/sandbox'),
  require('./checks/pdfmonkey'),
  require('./checks/metals'),
  require('./checks/mongodb'),
  require('./checks/redis'),
  require('./checks/secrets'),
];

// The fixed providers plus one entry per watched URL (PRATHAM_AI_URL from
// the watched .env, TRACK_URLS from the tracker's own settings).
function listServices(env, settings) {
  const urls = [];
  if (env.PRATHAM_AI_URL) {
    urls.push(urlService(env.PRATHAM_AI_URL, { envVar: 'PRATHAM_AI_URL', name: '24/7', purpose: '24/7 voice agent the app dials' }));
  }
  for (const url of settings.trackUrls) {
    urls.push(urlService(url, { envVar: 'TRACK_URLS' }));
  }
  const seen = new Set();
  return [...FIXED, ...urls].filter((s) => (seen.has(s.id) ? false : seen.add(s.id)));
}

module.exports = { listServices };
