/**
 * SurveyPesa STK Push backend
 * ---------------------------
 * Simple Express server that accepts activation-payment requests from the
 * activation / pay pages and forwards them to the HashBack M-Pesa STK Push API.
 *
 * Endpoints:
 *   GET  /health        -> quick check that the server is running and configured
 *   POST /api/stk-push  -> body: { phone, amount?, tier }  (tier: 49 | 99 | 149)
 *
 * Provider: HashBack "Initiate STK Push"
 *   POST https://api.hashback.co.ke/initiatestk
 *   Header : Content-Type: application/json ONLY. The key travels in the body
 *            as `api_key`; `Authorization: Bearer` is NOT used by this endpoint
 *            (HashBack reserves Bearer for its SMS API under /sms/*).
 *   Body   : api_key, account_id, amount, msisdn, reference - all required,
 *            all typed as strings by HashBack.
 *   Docs   : https://hashback.co.ke/documentation
 *
 * NOTE: HashBack marks these low-level STK endpoints as being phased out in
 * favour of their Payment Button SDK (hashpay.js). The endpoint still works
 * for existing integrations, but check with them before a new go-live.
 *
 * Configuration lives in .env:
 *   PORT=3000                            (optional)
 *   HASHBACK_API_KEY=...                 (required)
 *   HASHBACK_ACCOUNT_ID=...              (required)  your HashPay Account ID
 *   HASHBACK_STK_ENDPOINT=...            (required)
 *   CORS_ORIGIN=                         (optional; comma-separated allow-list)
 *   DRY_RUN=1                            (optional; build+log the request, send nothing)
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const HASHBACK_API_KEY = process.env.HASHBACK_API_KEY || '';
const HASHBACK_ACCOUNT_ID = process.env.HASHBACK_ACCOUNT_ID || '';
const HASHBACK_STK_ENDPOINT = process.env.HASHBACK_STK_ENDPOINT || '';

/**
 * DRY_RUN=1 builds and logs the outgoing request but never opens a socket.
 * Use it to inspect the exact endpoint/headers/body without spending money
 * or texting a real handset. See _mock-hashback.mjs for the end-to-end test.
 */
const DRY_RUN = /^(1|true|yes)$/i.test(String(process.env.DRY_RUN || '').trim());

/** Activation tiers offered on the activation page (KSh). */
const ALLOWED_TIERS = [49, 99, 149];

/** Values that still mean "not configured yet" in .env. */
const PLACEHOLDER_RE = /^(your_|change_me|xxx+|placeholder)/i;

/* ------------------------------------------------------------------ */
/* Middleware                                                          */
/* ------------------------------------------------------------------ */

// CORS so the frontend (localhost preview or the production domain) can call
// this API from the browser. Restrict with CORS_ORIGIN in .env (comma
// separated list); otherwise every origin is allowed.
const corsOriginEnv = (process.env.CORS_ORIGIN || '').trim();
app.use(
  cors(
    corsOriginEnv
      ? { origin: corsOriginEnv.split(',').map(function (s) { return s.trim(); }).filter(Boolean) }
      : undefined
  )
);

// Accept JSON bodies (and form-encoded bodies as a fallback).
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function isConfigured() {
  return (
    HASHBACK_API_KEY.length > 0 &&
    HASHBACK_ACCOUNT_ID.length > 0 &&
    !PLACEHOLDER_RE.test(HASHBACK_API_KEY) &&
    !PLACEHOLDER_RE.test(HASHBACK_ACCOUNT_ID) &&
    /^https?:\/\//i.test(HASHBACK_STK_ENDPOINT) &&
    !PLACEHOLDER_RE.test(HASHBACK_STK_ENDPOINT)
  );
}

/**
 * Unique transaction reference. HashBack echoes it back in the webhook, and
 * the docs require it to be URL-encoded (ours is already URL-safe).
 * "HS-" matches the Hela Sasa prefix convention used by the sibling backend.
 */
function generateReference() {
  return 'HS-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

/**
 * Builds the request exactly as documented at
 * https://hashback.co.ke/documentation -> "Initiate STK Push".
 *
 * Docs-verified facts this encodes:
 *   - POST https://api.hashback.co.ke/initiatestk
 *   - headers: Content-Type: application/json ONLY.
 *     `Authorization: Bearer` is NOT part of this endpoint - HashBack uses
 *     Bearer for the SMS API (/sms/*); the key travels in the body here.
 *   - all five body fields are Required strings.
 *
 * Returning a plain descriptor (instead of calling axios inline) lets the
 * same builder feed the dry-run logger and a local mock server unchanged.
 */
function buildProviderRequest(phone, amount, reference) {
  return {
    url: HASHBACK_STK_ENDPOINT,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      api_key: HASHBACK_API_KEY,
      account_id: HASHBACK_ACCOUNT_ID,
      amount: String(amount), // docs type this as String, e.g. "1"
      msisdn: phone, // 2547XXXXXXXX, not "phone"
      reference: reference
    }
  };
}

/**
 * Accepts common Kenyan phone formats and normalizes them to the
 * 2547XXXXXXXX / 2541XXXXXXXX form Safaricom expects for STK push:
 *   0712345678 / 0112345678  ->  254712345678 / 254112345678
 *   +254712345678            ->  254712345678
 *   712345678                ->  254712345678
 * Returns null when the number cannot be normalized.
 */
function normalizeKenyanPhone(raw) {
  if (raw === undefined || raw === null) return null;
  let p = String(raw).replace(/[\s\-().]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (/^0(7|1)\d{8}$/.test(p)) {
    p = '254' + p.slice(1);
  } else if (/^(7|1)\d{8}$/.test(p)) {
    p = '254' + p;
  }
  if (!/^254(7|1)\d{8}$/.test(p)) return null;
  return p;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

app.get('/health', function (req, res) {
  res.json({
    success: true,
    status: 'ok',
    configured: isConfigured(),
    allowedTiers: ALLOWED_TIERS,
    uptimeSeconds: Math.round(process.uptime())
  });
});

app.post('/api/stk-push', async function (req, res) {
  try {
    const body = req.body || {};
    const rawPhone = body.phone;
    let rawAmount = body.amount;
    const rawTier = body.tier;

    /* --- phone ------------------------------------------------------ */
    if (rawPhone === undefined || rawPhone === null || String(rawPhone).trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Phone number is required (e.g. 0712345678).'
      });
    }
    const phone = normalizeKenyanPhone(rawPhone);
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number. Use a Kenyan number like 07XXXXXXXX, 01XXXXXXXX or +2547XXXXXXXX.'
      });
    }

    /* --- tier (optional, but validated when present) ----------------- */
    let tier = null;
    if (rawTier !== undefined && rawTier !== null && String(rawTier).trim() !== '') {
      tier = Number(rawTier);
      if (!ALLOWED_TIERS.includes(tier)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid tier ' + rawTier + '. Allowed tiers are: ' + ALLOWED_TIERS.join(', ') + '.'
        });
      }
    }

    /* --- amount (falls back to the tier price) ----------------------- */
    if (rawAmount === undefined || rawAmount === null || String(rawAmount).trim() === '') {
      rawAmount = tier !== null ? tier : undefined;
    }
    if (rawAmount === undefined || rawAmount === null) {
      return res.status(400).json({
        success: false,
        message: 'Amount is required (or send a tier: 49, 99 or 149).'
      });
    }
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be a positive whole number of KSh.'
      });
    }

    /* --- server configuration --------------------------------------- */
    if (!isConfigured()) {
      return res.status(500).json({
        success: false,
        message:
          'Server is not configured. Set HASHBACK_API_KEY, HASHBACK_ACCOUNT_ID and HASHBACK_STK_ENDPOINT in .env and restart the server.'
      });
    }

    const reference = generateReference();
    const providerRequest = buildProviderRequest(phone, amount, reference);

    /* --- dry run: log the request, never open a socket ---------------- */
    if (DRY_RUN) {
      console.log('[stk-push] DRY_RUN - nothing was sent. Request that WOULD go out:');
      console.log('  ' + providerRequest.method + ' ' + providerRequest.url);
      console.log('  headers: ' + JSON.stringify(providerRequest.headers));
      console.log('  body   : ' + JSON.stringify(providerRequest.body, null, 2).replace(/\n/g, '\n           '));
      return res.json({
        success: true,
        dryRun: true,
        message: 'DRY_RUN is enabled - no request was made to HashBack and no handset was charged.',
        request: { phone: phone, amount: amount, tier: tier, reference: reference },
        wouldSend: providerRequest
      });
    }

    /* --- forward the STK push to HashBack ---------------------------- */
    // Auth is the `api_key` field in the body - NOT an Authorization header.
    const providerResponse = await axios.post(providerRequest.url, providerRequest.body, {
      headers: providerRequest.headers,
      timeout: 15000
    });

    const providerData = providerResponse.data || {};
    // checkout_id and CheckoutRequestID always carry the same value; accept
    // either so we keep working if HashBack ever returns only the Safaricom name.
    const checkoutId = providerData.checkout_id || providerData.CheckoutRequestID || null;

    return res.json({
      success: true,
      message:
        'STK push sent. Check the phone for the M-Pesa payment prompt and enter your PIN. ' +
        'This only means the prompt was delivered - wait for the webhook or poll /transactionstatus before releasing anything of value.',
      request: { phone: phone, amount: amount, tier: tier, reference: reference },
      checkout_id: checkoutId,
      provider: providerData
    });
  } catch (err) {
    if (err.response) {
      // HashBack answered with an error status.
      console.error('[stk-push] provider error', err.response.status, err.response.data);
      return res.status(502).json({
        success: false,
        message: 'The payment provider rejected the STK push request.',
        providerStatus: err.response.status,
        providerError: err.response.data
      });
    }
    if (err.request) {
      // No response at all (network / DNS / timeout).
      console.error('[stk-push] provider unreachable:', err.message);
      return res.status(502).json({
        success: false,
        message: 'Could not reach the payment provider. Check HASHBACK_STK_ENDPOINT and your internet connection, then try again.'
      });
    }
    console.error('[stk-push] unexpected error:', err);
    return res.status(500).json({
      success: false,
      message: 'Unexpected server error. Please try again.'
    });
  }
});

app.listen(PORT, function () {
  console.log('STK push server listening on http://localhost:' + PORT);
  console.log('POST /api/stk-push  (tiers: ' + ALLOWED_TIERS.join(', ') + ')');
  console.log('HashBack endpoint: ' + (isConfigured() ? HASHBACK_STK_ENDPOINT : 'NOT CONFIGURED (edit .env)'));
  console.log('HashBack account id: ' + (HASHBACK_ACCOUNT_ID || '(missing)'));
  console.log('Dry run: ' + (DRY_RUN ? 'ON - requests are logged, never sent' : 'off'));
});
