/**
 * Verifies that the payment pages resolve the right STK API base URL and
 * that the request actually REACHES a backend (i.e. is no longer the 405
 * Live Server used to return).
 *
 * It loads the REAL sp-config.js in a sandboxed fake window whose origin is
 * the Live Server preview, then replays the exact preflight + POST that
 * sp-stk.js performs.
 *
 * NOTHING here reaches HashBack: the probe deliberately sends amount: 1,
 * which surveypesa-backend rejects at validation (400) before it ever calls
 * the payment provider. A 400 with a real message is the SUCCESS signal here
 * — it proves the request landed on the API. A 405 would mean it hit the
 * static file server; a 404 would mean the route does not exist there.
 *
 * Run:  node _verify-api-routing.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PREVIEW_ORIGIN = 'http://127.0.0.1:5500';

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

/** Runs the real sp-config.js against a fake window and returns its config. */
function resolveConfigFor(href) {
  const url = new URL(href);
  const sandbox = {
    window: {
      location: { hostname: url.hostname, origin: url.origin, search: url.search },
      console: { info() {} }
    },
    URLSearchParams,
    console: { info() {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(HERE + 'sp-config.js', 'utf8'), sandbox);
  return sandbox.window.SP_STK_CONFIG;
}

async function preflight(base, path, origin) {
  return fetch(base + path, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type'
    }
  });
}

console.log('\n=== 1. apiBase resolution ===\n');

const liveServer = resolveConfigFor(PREVIEW_ORIGIN + '/pay-99.html');
console.log('  page origin      : ' + PREVIEW_ORIGIN);
console.log('  resolved apiBase : ' + liveServer.apiBase);
console.log('  (old code gave   : ' + PREVIEW_ORIGIN + '  <- the 405)\n');

check('apiBase is not the static preview origin', liveServer.apiBase !== PREVIEW_ORIGIN, liveServer.apiBase);
check('apiBase points at a real backend port', /:300[01]$/.test(liveServer.apiBase), liveServer.apiBase);
check('no trailing slash (no //api double-up)', !/\/$/.test(liveServer.apiBase), liveServer.apiBase);

const withQuery = resolveConfigFor(PREVIEW_ORIGIN + '/pay-99.html?api=http://127.0.0.1:3000');
check('?api= override wins', withQuery.apiBase === 'http://127.0.0.1:3000', withQuery.apiBase);

const prod = resolveConfigFor('https://surveypesa.co.ke/pay-99.html');
check('production resolves to the page origin', prod.apiBase === 'https://surveypesa.co.ke', prod.apiBase);

// Vercel preview deploys get random hostnames; a hardcoded domain would break.
const preview = resolveConfigFor('https://surveypesa-backend-abc123.vercel.app/pay-99.html');
check('Vercel preview deploy follows its own origin', preview.apiBase === 'https://surveypesa-backend-abc123.vercel.app', preview.apiBase);

console.log('\n=== 2. CORS preflight from the preview origin ===\n');

let pre;
try {
  pre = await preflight(liveServer.apiBase, '/api/stk/initiate', PREVIEW_ORIGIN);
  check('preflight is 2xx (not blocked)', pre.status >= 200 && pre.status < 300, pre.status);
  check('Access-Control-Allow-Origin present', !!pre.headers.get('access-control-allow-origin'), pre.headers.get('access-control-allow-origin'));
  check('POST is allowed', /POST/i.test(pre.headers.get('access-control-allow-methods') || ''), pre.headers.get('access-control-allow-methods'));
} catch (e) {
  check('preflight reached the backend', false, e.message);
}

console.log('\n=== 3. the POST sp-stk.js actually makes (amount:1 -> safe 400) ===\n');

try {
  const res = await fetch(liveServer.apiBase + '/api/stk/initiate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: PREVIEW_ORIGIN },
    body: JSON.stringify({ amount: 1, msisdn: '254712345678' })
  });
  const text = await res.text();
  console.log('  POST ' + liveServer.apiBase + '/api/stk/initiate');
  console.log('  -> ' + res.status + '  ' + text.slice(0, 110) + '\n');

  check('is NOT 405 (no longer hitting the static server)', res.status !== 405, res.status);
  check('is NOT 404 (route exists on this backend)', res.status !== 404, res.status);
  check('reached application logic (400 from validation)', res.status === 400, res.status);
  check('body is JSON from the API', /application\/json/.test(res.headers.get('content-type') || ''), res.headers.get('content-type'));
  check('no HashBack call was made (rejected pre-provider)', /Invalid amount/.test(text), text.slice(0, 80));
} catch (e) {
  check('POST reached the backend', false, e.message);
}

console.log('\n' + '-'.repeat(46));
console.log('  passed: ' + passed + '   failed: ' + failed);
console.log('-'.repeat(46));
process.exit(failed === 0 ? 0 : 1);
