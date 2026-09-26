/**
 * Guards against tier-price drift.
 *
 * The SurveyPesa prices live in exactly one place — pricing.json — and this
 * test asserts that everything else agrees with it:
 *   - surveypesa-backend's ALLOWED_AMOUNTS whitelist
 *   - the value="..." attribute of every HTML tier page
 *   - the KSh figure rendered as visible page text
 *
 * This is the check that would have caught the mismatch reported on
 * 2026-09-26 immediately instead of at click time.
 *
 * Purely static: no server is booted and nothing is sent to HashBack.
 *
 * Run:  node _test-pricing-sync.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SITE = fileURLToPath(new URL('../surveypesa.co.ke/', import.meta.url));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

const pricing = JSON.parse(readFileSync(HERE + 'pricing.json', 'utf8'));
const expected = pricing.tiers.map((t) => t.amount);

console.log('\n=== 1. pricing.json is well formed ===\n');

check('has a tiers array', Array.isArray(pricing.tiers) && pricing.tiers.length > 0, pricing.tiers);
check('every amount is a positive whole number',
  pricing.tiers.every((t) => Number.isInteger(t.amount) && t.amount > 0),
  pricing.tiers.map((t) => t.amount));
check('no duplicate amounts', new Set(expected).size === expected.length, expected);
check('currency is KES', pricing.currency === 'KES', pricing.currency);
console.log('  source of truth: ' + JSON.stringify(expected) + '\n');

console.log('=== 2. backend whitelist derives from it ===\n');

const serverSrc = readFileSync(HERE + 'server.js', 'utf8');
check('server.js no longer hardcodes a tier array',
  !/const\s+ALLOWED_AMOUNTS\s*=\s*\[[^\]]*\]/.test(serverSrc),
  'found a literal [..] assignment');
check('server.js reads pricing.json',
  /pricing\.json/.test(serverSrc), 'no pricing.json reference');

console.log('=== 3. HTML tier pages carry the same amounts ===\n');

for (const tier of pricing.tiers) {
  const file = SITE + tier.page;
  if (!existsSync(file)) { check(tier.page + ' exists', false, file); continue; }
  const html = readFileSync(file, 'utf8');

  const input = html.match(/name="amount"[^>]*value="(\d+)"/);
  check(tier.page + ' readonly amount input = ' + tier.amount,
    input !== null && Number(input[1]) === tier.amount,
    input ? input[1] : 'no amount input found');

  check(tier.page + ' is readonly (client cannot change the price)',
    /name="amount"[^>]*readonly/.test(html) || /readonly[^>]*name="amount"/.test(html),
    'not readonly');

  const priceText = new RegExp('KSh\\s*' + tier.amount + '\\b').test(html);
  check(tier.page + ' shows "KSh ' + tier.amount + '" to the user', priceText, 'no matching price text');
}

console.log('=== 4. legacy pages ===\n');

for (const legacy of pricing.legacyPages || []) {
  const file = SITE + legacy.page;
  if (!existsSync(file)) { check(legacy.page + ' exists', false, file); continue; }
  const html = readFileSync(file, 'utf8');
  const input = html.match(/name="amount"[^>]*value="(\d+)"/);
  check(legacy.page + ' carries its declared amount ' + legacy.amount,
    input !== null && Number(input[1]) === legacy.amount,
    input ? input[1] : 'no amount input found');
  check(legacy.page + ' amount is an allowed tier',
    input !== null && expected.includes(Number(input[1])),
    input ? input[1] : null);
}

console.log('=== 5. every allowed tier has a page ===\n');

for (const amount of expected) {
  const tier = pricing.tiers.find((t) => t.amount === amount);
  check('Ksh ' + amount + ' has a declared page', !!tier && existsSync(SITE + tier.page), tier && tier.page);
}

console.log('\n' + '-'.repeat(46));
console.log('  passed: ' + passed + '   failed: ' + failed);
console.log('-'.repeat(46));
process.exit(failed === 0 ? 0 : 1);
