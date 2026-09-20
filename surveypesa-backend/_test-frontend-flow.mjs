/**
 * Verifies the exact request flow the new payment-page script (sp-stk.js)
 * makes against surveypesa-backend: boots server.js on its default port
 * (3001, matching sp-config.js apiBase), replays the JSON payloads the
 * frontend sends (all tiers incl. the 199 Premium page), unit-checks the
 * phone normalization kept in sync with sp-stk.js, and statically checks
 * that every tier page pulls its config from the single source
 * (sp-config.js) instead of hardcoding apiBase.
 * Run:  node _test-frontend-flow.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://localhost:3001';
const HERE = fileURLToPath(new URL('.', import.meta.url));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

/* normalizePhone — kept in sync with surveypesa.co.ke/sp-stk.js */
function normalizePhone(raw) {
  if (raw === undefined || raw === null) return null;
  var p = String(raw).replace(/[\s\-().]/g, '');
  if (p.charAt(0) === '+') p = p.slice(1);
  if (/^0(7|1)\d{8}$/.test(p)) p = '254' + p.slice(1);
  else if (/^(7|1)\d{8}$/.test(p)) p = '254' + p;
  if (!/^254(7|1)\d{8}$/.test(p)) return null;
  return p;
}

const child = spawn(process.execPath, ['server.js'], {
  cwd: HERE,
  env: {
    ...process.env,
    HASHBACK_API_KEY: 'dummy-key-for-tests',
    HASHBACK_ACCOUNT_ID: 'HP120819',
    HASHBACK_WEBHOOK_SECRET: 'whsec_test_123'
  }
});
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));
child.on('error', (e) => { out += '\nCHILD SPAWN ERROR: ' + e.message; });
child.on('exit', (code, signal) => { out += '\nCHILD EXIT code=' + code + ' signal=' + signal; });

try {
  // Wait for the server's own "listening" log line (stdout may be buffered
  // when piped, so also probe HTTP) — up to ~20s for slow cold starts.
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    if (out.indexOf('listening on http://localhost:3001') !== -1) { up = true; break; }
    try {
      const r = await fetch(BASE + '/api/stk/status/diag');
      if (r.status === 404) { up = true; break; } // server up, unknown ref
    } catch { /* not up yet */ }
    await sleep(200);
  }
  check('backend boots on default port 3001 (matches SP_STK_CONFIG.apiBase)', up, out.slice(-400));
  if (!up) throw new Error('server did not start. child output:\n' + out);

  /* --- phone normalization, exactly as the pages call it --- */
  const cases = [
    ['0712 345 678', '254712345678'],
    ['0712345678', '254712345678'],
    ['+254 712 345 678', '254712345678'],
    ['712345678', '254712345678'],
    ['0112345678', '254112345678'],
    ['0119 345 678', '254119345678'],
    ['254712345678', '254712345678'],
    ['07123456789', null],
    ['123', null],
    ['', null]
  ];
  for (const [input, expected] of cases) {
    check(
      'normalizePhone(' + JSON.stringify(input) + ') === ' + JSON.stringify(expected),
      normalizePhone(input) === expected,
      normalizePhone(input)
    );
  }

  /* --- replay the exact fetches sp-stk.js performs --- */
  async function initiate(payload) {
    const r = await fetch(BASE + '/api/stk/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }

  let r = await initiate({ amount: 99, msisdn: '254712345678' });
  check('numeric amount 99 + normalized msisdn passes validation (reaches provider)', r.status === 502, r);
  check('provider rejection carries the clear message', r.body?.message === 'The payment provider rejected the STK push request.', r.body);

  r = await initiate({ amount: 149, msisdn: '254712345678' });
  check('numeric amount 149 passes validation', r.status === 502, r.status);

  r = await initiate({ amount: 199, msisdn: '254712345678' });
  check('numeric amount 199 (Premium tier) passes validation', r.status === 502, r.status);

  r = await initiate({ amount: 49, msisdn: '254712345678' });
  check('legacy KSh 49 tier still rejected -> 400 with clear message', r.status === 400 && r.body?.message === 'Invalid amount. This site only accepts Ksh 99, Ksh 149, or Ksh 199.', r.body);

  r = await initiate({ amount: '99', msisdn: '254712345678' });
  check('string amount (old behavior) rejected -> 400', r.status === 400, r.body);

  r = await initiate({ amount: 99, msisdn: '0712 345 678' });
  check('un-normalized phone rejected -> 400 (why sp-stk.js normalizes)', r.status === 400, r.body);

  /* --- static checks: every tier page pulls from the single config source --- */
  const SITE = path.join(HERE, '..', 'surveypesa.co.ke');
  const tierPages = { 'pay-99.html': '99', 'pay-149.html': '149', 'pay-199.html': '199', 'pay.html': '99' };
  for (const [file, amount] of Object.entries(tierPages)) {
    const html = fs.readFileSync(path.join(SITE, file), 'utf8');
    check(file + ' charges KSh ' + amount + ' (readonly tier input)', html.includes('value="' + amount + '" readonly'));
    check(
      file + ' loads sp-config.js before sp-stk.js',
      html.indexOf('src="sp-config.js"') !== -1 &&
        html.indexOf('src="sp-config.js"') < html.indexOf('src="sp-stk.js"')
    );
    check(file + ' has no hardcoded apiBase (config is single-source)', !html.includes('localhost:3001'));
  }
  check('pay.html no longer references KSh 49', !fs.readFileSync(path.join(SITE, 'pay.html'), 'utf8').includes('KSh 49'));
  const cfg = fs.readFileSync(path.join(SITE, 'sp-config.js'), 'utf8');
  check('sp-config.js defines window.SP_STK_CONFIG with apiBase', cfg.includes('window.SP_STK_CONFIG') && cfg.includes('apiBase'));
  check('sp-config.js derives apiBase from window.location.origin (no hardcoded URL)', cfg.includes('window.location.origin') && !cfg.includes('localhost:3001'));

  /* --- unified static serving: the API origin also serves the site --- */
  const sitePage = await fetch(BASE + '/pay-99.html');
  check('GET /pay-99.html served from the backend origin (unified deployment)', sitePage.status === 200 && (await sitePage.text()).includes('Pay KSh 99'), sitePage.status);
  const cfgServed = await fetch(BASE + '/sp-config.js');
  check('GET /sp-config.js served from the backend origin', cfgServed.status === 200, cfgServed.status);
  const rootPage = await fetch(BASE + '/');
  const rootBody = await rootPage.text();
  check('GET / serves the real site homepage (surveypesa.co.ke static root first)', rootPage.status === 200 && rootBody.includes('Survey Pesa') && !rootBody.includes('SurveyPesa HashBack'), rootPage.status);
} catch (e) {
  failed++;
  console.error('FATAL: ' + e.message);
} finally {
  child.kill();
  await sleep(300);
  console.log('\n--- backend output (tail) ---');
  console.log(out.split('\n').slice(-12).join('\n'));
  console.log('--- results: ' + passed + ' passed, ' + failed + ' failed ---');
  process.exit(failed ? 1 : 0);
}
