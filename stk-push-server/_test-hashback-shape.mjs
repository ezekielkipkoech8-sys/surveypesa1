/**
 * Verifies the HashBack STK push request shape in server.js against the
 * OFFICIAL docs (https://hashback.co.ke/documentation -> "Initiate STK Push").
 *
 * NOTHING here touches HashBack or a real handset. A local mock stands in
 * for the provider, records exactly what arrived, and replies with the
 * documented 200 response. A second pass boots the server with DRY_RUN=1
 * pointed at a dead port to prove the dry-run path sends nothing at all.
 *
 * Run:  node _test-hashback-shape.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const APP_PORT = 3108;   // our server.js
const MOCK_PORT = 59998; // stand-in for api.hashback.co.ke
const DEAD_PORT = 59999; // nothing listens here (DRY_RUN proof)
const BASE = 'http://localhost:' + APP_PORT;
const HERE = fileURLToPath(new URL('.', import.meta.url));

const EXPECTED_KEY = 'test-key-for-shape';
const EXPECTED_ACCOUNT = 'HP120819';

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

/* ------------------------------------------------------------------ */
/* Mock HashBack - records the request, replies like the docs say      */
/* ------------------------------------------------------------------ */

const captured = [];
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = JSON.parse(raw); } catch { /* keep null */ }
    captured.push({ method: req.method, url: req.url, headers: req.headers, raw, body });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Shape copied verbatim from the documented "Response 200" example.
    res.end(JSON.stringify({
      success: true,
      message: 'STK push initiated successfully',
      checkout_id: 'ws_CO_16092026004400759796721744',
      MerchantRequestID: 'f718-44d8-a5df-b9b3b074c8e717034596',
      CheckoutRequestID: 'ws_CO_16092026004400759796721744',
      ResponseCode: '0',
      ResponseDescription: 'Success. Request accepted for processing',
      CustomerMessage: 'Success. Request accepted for processing'
    }));
  });
});

function boot(env) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: HERE,
    env: { ...process.env, PORT: String(APP_PORT), ...env }
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  return { child, log: () => out };
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/health'); return true; } catch { await sleep(200); }
  }
  return false;
}

async function post(body) {
  const res = await fetch(BASE + '/api/stk-push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}


// Start the stand-in provider. Port 59998 is local-only and short-lived.
await new Promise((r) => mock.listen(MOCK_PORT, r));

/* ================================================================== */
/* PASS 1 - real axios path, pointed at the mock                      */
/* ================================================================== */

console.log('\nPASS 1 - request shape vs official HashBack docs\n');

const app = boot({
  HASHBACK_API_KEY: EXPECTED_KEY,
  HASHBACK_ACCOUNT_ID: EXPECTED_ACCOUNT,
  HASHBACK_STK_ENDPOINT: 'http://127.0.0.1:' + MOCK_PORT + '/initiatestk',
  DRY_RUN: ''
});

try {
  if (!(await waitUp())) throw new Error('server did not start\n' + app.log());

  const h = await (await fetch(BASE + '/health')).json();
  check('health reports configured=true', h.configured === true, h);

  // 0712345678 -> 254712345678, but it only ever reaches the local mock.
  const r = await post({ phone: '0712345678', tier: 99 });
  check('POST /api/stk-push returns 200', r.status === 200, r);
  check('response surfaces checkout_id', r.json.checkout_id === 'ws_CO_16092026004400759796721744', r.json.checkout_id);
  check('mock was actually called once', captured.length === 1, captured.length);

  const call = captured[0];
  if (!call) throw new Error('no request reached the mock');

  /* --- method + endpoint --- */
  check('method is POST', call.method === 'POST', call.method);
  check('path is /initiatestk', call.url === '/initiatestk', call.url);

  /* --- headers --- */
  check('Content-Type is application/json', /application\/json/.test(call.headers['content-type'] || ''), call.headers['content-type']);
  check('NO Authorization header (key goes in the body)', call.headers.authorization === undefined, call.headers.authorization);
  check('NO stray auth-ish headers',
    call.headers['x-api-key'] === undefined && call.headers.api_key === undefined,
    { 'x-api-key': call.headers['x-api-key'], api_key: call.headers.api_key });

  /* --- body field names (exact, per docs) --- */
  const b = call.body || {};
  const keys = Object.keys(b).sort();
  check('body has exactly the 5 documented fields',
    JSON.stringify(keys) === JSON.stringify(['account_id', 'amount', 'api_key', 'msisdn', 'reference']),
    keys);
  check('api_key sent in body', b.api_key === EXPECTED_KEY, b.api_key);
  check('account_id sent in body', b.account_id === EXPECTED_ACCOUNT, b.account_id);
  check('msisdn normalized to 2547XXXXXXXX', b.msisdn === '254712345678', b.msisdn);
  check('amount is a STRING (docs type it String)', typeof b.amount === 'string', typeof b.amount);
  check('amount value is "99"', b.amount === '99', b.amount);
  check('reference present', typeof b.reference === 'string' && b.reference.length > 0, b.reference);
  check('reference is URL-safe', /^[A-Za-z0-9\-_.~]+$/.test(b.reference), b.reference);

  /* --- old guessed fields must be gone --- */
  check('old field "phone" no longer sent to provider', b.phone === undefined, b.phone);
  check('old field "tier" no longer sent to provider', b.tier === undefined, b.tier);
  check('old field "timestamp" no longer sent to provider', b.timestamp === undefined, b.timestamp);
} catch (e) {
  check('pass 1 completed without throwing', false, String(e.message || e));
} finally {
  app.child.kill();
  await sleep(400);
}

/* ================================================================== */
/* PASS 2 - DRY_RUN points at a dead port and must send nothing        */
/* ================================================================== */

console.log('\nPASS 2 - DRY_RUN=1 never touches the network\n');

const before = captured.length;
const dry = boot({
  HASHBACK_API_KEY: EXPECTED_KEY,
  HASHBACK_ACCOUNT_ID: EXPECTED_ACCOUNT,
  HASHBACK_STK_ENDPOINT: 'http://127.0.0.1:' + DEAD_PORT + '/initiatestk',
  DRY_RUN: '1'
});

try {
  if (!(await waitUp())) throw new Error('server did not start\n' + dry.log());

  const r = await post({ phone: '0112345678', tier: 49 });
  check('dry run still returns 200', r.status === 200, r);
  check('response is flagged dryRun=true', r.json.dryRun === true, r.json);
  check('no 502 from the dead port (nothing was sent)', r.status !== 502, r.status);
  check('wouldSend body is the documented shape',
    JSON.stringify(Object.keys(r.json.wouldSend.body).sort()) ===
    JSON.stringify(['account_id', 'amount', 'api_key', 'msisdn', 'reference']),
    Object.keys(r.json.wouldSend.body));
  check('wouldSend target is the dead port', String(r.json.wouldSend.url).includes(String(DEAD_PORT)), r.json.wouldSend.url);
  check('zero network calls made during dry run', captured.length === before, captured.length - before);
  check('startup log announces dry run', /Dry run: ON/.test(dry.log()), 'no "Dry run: ON" line');
} catch (e) {
  check('pass 2 completed without throwing', false, String(e.message || e));
} finally {
  dry.child.kill();
  mock.close();
}

console.log('\n' + '-'.repeat(46));
console.log('  passed: ' + passed + '   failed: ' + failed);
console.log('-'.repeat(46));
process.exit(failed === 0 ? 0 : 1);
