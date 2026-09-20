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
 * Configuration lives in .env:
 *   PORT=3000
 *   HASHBACK_API_KEY=your_api_key_here
 *   HASHBACK_STK_ENDPOINT=your_hashback_stk_endpoint_here
 *   CORS_ORIGIN=            (optional; comma-separated allow-list)
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const HASHBACK_API_KEY = process.env.HASHBACK_API_KEY || '';
const HASHBACK_STK_ENDPOINT = process.env.HASHBACK_STK_ENDPOINT || '';

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
    !PLACEHOLDER_RE.test(HASHBACK_API_KEY) &&
    /^https?:\/\//i.test(HASHBACK_STK_ENDPOINT) &&
    !PLACEHOLDER_RE.test(HASHBACK_STK_ENDPOINT)
  );
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
        message: 'Server is not configured. Set HASHBACK_API_KEY and HASHBACK_STK_ENDPOINT in .env and restart the server.'
      });
    }

    /* --- forward the STK push to HashBack ---------------------------- */
    // NOTE: if the HashBack API you signed up with expects different field
    // names or a different auth header (e.g. "X-API-Key" instead of
    // "Authorization: Bearer"), adjust them here — everything else stays.
    const providerPayload = {
      phone: phone,
      amount: amount,
      tier: tier,
      timestamp: new Date().toISOString()
    };
    const providerResponse = await axios.post(HASHBACK_STK_ENDPOINT, providerPayload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + HASHBACK_API_KEY
      },
      timeout: 30000
    });

    return res.json({
      success: true,
      message: 'STK push sent. Check the phone for the M-Pesa payment prompt and enter your PIN.',
      request: { phone: phone, amount: amount, tier: tier },
      provider: providerResponse.data
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
});
