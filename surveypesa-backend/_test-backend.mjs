/**
 * Smoke tests for surveypesa-backend.
 * Boots server.js on port 3107 with dummy HashBack credentials and exercises
 * every endpoint. The initiate calls reach the real HashBack API with an
 * invalid key, which is exactly the failure path we want to see logged.
 * Run:  node _test-backend.mjs
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const PORT = 3107;
const BASE = 'http://localhost:' + PORT;
const SECRET = 'whsec_test_123';
const HERE = fileURLToPath(new URL('.', import.meta.url));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
const hmac = (raw) =>
  'sha256=' + crypto.createHmac('sha256', SECRET).update(Buffer.from(raw, 'utf8')).digest('hex');

async function req(method, path, body, headers = {}, rawBody) {
  const h = { ...headers };
  let payload = rawBody;
  if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, acao: res.headers.get('access-control-allow-origin') };
}

const child = spawn(process.execPath, ['server.js'], {
  cwd: HERE,
  env: {
    ...process.env,
    PORT: String(PORT),
    HASHBACK_API_KEY: 'dummy-key-for-tests',
    HASHBACK_ACCOUNT_ID: 'HP120819',
    HASHBACK_WEBHOOK_SECRET: SECRET
  }
});
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { await req('GET', '/'); up = true; break; } catch { await sleep(200); }
  }
  check('server boots on port ' + PORT, up);
  if (!up) throw new Error('server did not start\n' + out);

  /* --- CORS / preflight --- */
  {
    const r = await req('OPTIONS', '/api/stk/initiate');
    check('OPTIONS preflight -> 204', r.status === 204, r.status);
    check('preflight sends Access-Control-Allow-Origin: *', r.acao === '*', r.acao);
    const g = await req('GET', '/api/stk/status/nope');
    check('GET responses carry Access-Control-Allow-Origin: *', g.acao === '*', g.acao);
  }

  /* --- initiate validation (400s before anything else happens) --- */
  {
    const bad500 = await req('POST', '/api/stk/initiate', { amount: 500, msisdn: '254712345678' });
    check('amount 500 -> 400', bad500.status === 400, bad500.status);
    check(
      'amount 500 message is exact',
      bad500.json?.message === 'Invalid amount. This site only accepts Ksh 99, Ksh 149, or Ksh 199.',
      bad500.json
    );
    const strAmt = await req('POST', '/api/stk/initiate', { amount: '99', msisdn: '254712345678' });
    check("string amount '99' -> 400 (no coercion)", strAmt.status === 400, strAmt.status);
    const frac = await req('POST', '/api/stk/initiate', { amount: 99.5, msisdn: '254712345678' });
    check('amount 99.5 -> 400', frac.status === 400, frac.status);
    const badPhone = await req('POST', '/api/stk/initiate', { amount: 99, msisdn: '0712345678' });
    check('msisdn 0712345678 -> 400', badPhone.status === 400, badPhone.status);
  }

  /* --- unknown reference --- */
  {
    const r = await req('GET', '/api/stk/status/SP-DOES-NOT-EXIST');
    check('status of unknown reference -> 404', r.status === 404, r.status);
  }

  /* --- real initiate attempts (dummy key -> provider rejects -> 502) --- */
  await req('POST', '/api/stk/initiate', { amount: 99, msisdn: '254712345678', reference: 'SP-TEST-001' });
  await req('POST', '/api/stk/initiate', { amount: 149, msisdn: '254712345678', reference: 'SP-TEST-002' });
  await req('POST', '/api/stk/initiate', { amount: 199, msisdn: '254712345678', reference: 'SP-TEST-003' });
  {
    const s1 = await req('GET', '/api/stk/status/SP-TEST-001');
    check('SP-TEST-001 stored with amount 99', s1.json?.amount === 99, s1.json);
    check('SP-TEST-001 marked failed after provider rejection', s1.json?.status === 'failed', s1.json?.status);
  }

  /* --- webhook: signature enforcement --- */
  const goodBody = JSON.stringify({
    event: 'payment.success',
    ResponseCode: 0,
    TransactionReference: 'SP-TEST-002',
    TransactionAmount: 149,
    TransactionReceipt: 'QGH7XYZ12'
  });
  {
    const noSig = await req('POST', '/api/webhook/hashpay', undefined, { 'Content-Type': 'application/json' }, goodBody);
    check('webhook without signature -> 401', noSig.status === 401, noSig.status);
    const badSig = await req('POST', '/api/webhook/hashpay', undefined,
      { 'Content-Type': 'application/json', 'X-Hashpay-Signature': 'sha256=' + '0'.repeat(64) }, goodBody);
    check('webhook with wrong signature -> 401', badSig.status === 401, badSig.status);
  }

  /* --- webhook: amount mismatch --- */
  {
    const raw = JSON.stringify({ event: 'payment.success', ResponseCode: 0, TransactionReference: 'SP-TEST-001', TransactionAmount: 999 });
    const r = await req('POST', '/api/webhook/hashpay', undefined,
      { 'Content-Type': 'application/json', 'X-Hashpay-Signature': hmac(raw) }, raw);
    check('mismatched webhook amount -> 200 + amount_mismatch', r.status === 200 && r.json?.status === 'amount_mismatch', r.json);
    const s = await req('GET', '/api/stk/status/SP-TEST-001');
    check('status poll shows amount_mismatch', s.json?.status === 'amount_mismatch', s.json?.status);
  }

  /* --- webhook: happy path --- */
  {
    const r = await req('POST', '/api/webhook/hashpay', undefined,
      { 'Content-Type': 'application/json', 'X-Hashpay-Signature': hmac(goodBody) }, goodBody);
    check('valid payment.success webhook -> 200 + success', r.status === 200 && r.json?.status === 'success', r.json);
    const s = await req('GET', '/api/stk/status/SP-TEST-002');
    check('status poll shows success + receipt', s.json?.status === 'success' && s.json?.receipt === 'QGH7XYZ12', s.json);
  }

  /* --- webhook: no event type, Amount/Reference/Receipt fallbacks --- */
  {
    const raw = JSON.stringify({ ResponseCode: '0', Reference: 'SP-TEST-003', Amount: 199, Receipt: 'RCP-ALT-9' });
    const r = await req('POST', '/api/webhook/hashpay', undefined,
      { 'Content-Type': 'application/json', 'X-Hashpay-Signature': hmac(raw) }, raw);
    check('event-less payload -> processed as success', r.status === 200 && r.json?.status === 'success', r.json);
    const s = await req('GET', '/api/stk/status/SP-TEST-003');
    check('fallback Receipt stored', s.json?.receipt === 'RCP-ALT-9', s.json);
  }

  /* --- webhook: ignored-but-acked cases (always 200) --- */
  {
    const raw = JSON.stringify({ event: 'payment.failed', ResponseCode: 1, TransactionReference: 'SP-TEST-002' });
    const r = await req('POST', '/api/webhook/hashpay', undefined,
      { 'Content-Type': 'application/json', 'X-Hashpay-Signature': hmac(raw) }, raw);
    check('non-success ResponseCode -> 200, not processed', r.status === 200 && r.json?.processed === false, r.json);

    const raw2 = JSON.stringify({ event: 'payment.success', ResponseCode: 0, TransactionReference: 'SP-NOPE', TransactionAmount: 99 });
    const r2 = await req('POST', '/api/webhook/hashpay', undefined,
      { 'Content-Type': 'application/json', 'X-Hashpay-Signature': hmac(raw2) }, raw2);
    check('unknown reference -> 200, not processed', r2.status === 200 && r2.json?.processed === false, r2.json);

    const raw3 = '{"event":"payment.success", oops';
    const r3 = await req('POST', '/api/webhook/hashpay', undefined,
      { 'Content-Type': 'application/json', 'X-Hashpay-Signature': hmac(raw3) }, raw3);
    check('unparseable JSON (valid sig) -> 200, not processed', r3.status === 200 && r3.json?.processed === false, r3.json);
  }

  /* --- static file serving --- */
  {
    const r = await req('GET', '/');
    check('GET / serves public/index.html', r.status === 200 && r.text.includes('SurveyPesa HashBack backend'), r.status);
  }
} catch (e) {
  failed++;
  console.error('FATAL: ' + e.message);
} finally {
  child.kill();
  await sleep(300);
  console.log('\n--- server output (tail) ---');
  console.log(out.split('\n').slice(-25).join('\n'));
  console.log('--- results: ' + passed + ' passed, ' + failed + ' failed ---');
  process.exit(failed ? 1 : 0);
}

