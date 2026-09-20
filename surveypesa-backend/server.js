/**
 * SurveyPesa (surveypesa.co.ke) HashBack M-Pesa STK Push backend
 * --------------------------------------------------------------
 * Activation-payment backend for the Lite / Standard / Premium tiers
 * (Ksh 99 / Ksh 149 / Ksh 199). Talks to the same HashBack account as the
 * Hela Sasa backend (stk-push-server/, port 3000) but runs on its own port
 * (3001) and stamps fallback references with an "SP-" prefix, so
 * transactions from the two sites can be told apart in the HashBack
 * dashboard.
 *
 * Endpoints:
 *   POST /api/stk/initiate      -> body: { amount, msisdn, reference? }
 *   GET  /api/stk/status/:ref   -> order status (pending/success/failed/amount_mismatch)
 *   POST /api/webhook/hashpay   -> signed HashPay payment webhook
 *
 * NOTE: orders are stored in an in-memory Map, which is fine for local dev.
 * (They are lost on restart and not shared across serverless instances —
 * wire up a real store before relying on this in production.)
 */

require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();

const PORT = process.env.PORT || 3001;
const HASHBACK_API_KEY = process.env.HASHBACK_API_KEY || '';
const HASHBACK_ACCOUNT_ID = process.env.HASHBACK_ACCOUNT_ID || '';
const HASHBACK_WEBHOOK_SECRET = process.env.HASHBACK_WEBHOOK_SECRET || '';

const HASHBACK_STK_URL = 'https://api.hashback.co.ke/initiatestk';

/* ------------------------------------------------------------------ */
/* Activation tiers                                                    */
/* ------------------------------------------------------------------ */

// Lite / Standard / Premium activation prices. This site has NO
// user-entered pricing, so there is no reason to trust the client on
// amount — any other value is rejected outright.
const ALLOWED_AMOUNTS = [99, 149, 199];

// Safaricom STK push expects 2547XXXXXXXX / 2541XXXXXXXX.
const MSISDN_RE = /^254[71]\d{8}$/;

/* ------------------------------------------------------------------ */
/* In-memory order store                                               */
/* ------------------------------------------------------------------ */

// Map<reference, { reference, amount, msisdn, status, checkout_id, receipt, createdAt }>
// Fine for local dev; NOT persistent and NOT shared across instances.
const orders = new Map();

/**
 * Fallback reference when the frontend omits one. The "SP-" prefix is
 * deliberately different from the Hela Sasa backend's "HS-" prefix so the
 * two sites' transactions are distinguishable in the HashBack dashboard.
 */
function generateReference() {
  return 'SP-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

/* ------------------------------------------------------------------ */
/* Middleware: permissive CORS + OPTIONS preflight                     */
/* ------------------------------------------------------------------ */

app.use(function (req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Hashpay-Signature');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

/* ------------------------------------------------------------------ */
/* POST /api/webhook/hashpay                                           */
/*                                                                     */
/* Registered BEFORE the global express.json() parser: this route uses  */
/* express.raw() so the HMAC-SHA256 signature can be verified over the  */
/* exact bytes HashPay sent.                                           */
/* ------------------------------------------------------------------ */

app.post('/api/webhook/hashpay', express.raw({ type: 'application/json' }), function (req, res) {
  const signature = req.headers['x-hashpay-signature'];

  if (!Buffer.isBuffer(req.body)) {
    return res.status(400).json({
      success: false,
      message: 'Expected a raw JSON body (Content-Type: application/json).'
    });
  }

  if (!HASHBACK_WEBHOOK_SECRET || typeof signature !== 'string' || signature.indexOf('sha256=') !== 0) {
    console.error('[surveypesa-backend] webhook rejected: missing secret or signature');
    return res.status(401).json({ success: false, message: 'Invalid or missing signature.' });
  }

  const expected = crypto
    .createHmac('sha256', HASHBACK_WEBHOOK_SECRET)
    .update(req.body)
    .digest('hex');
  const received = signature.slice('sha256='.length);
  const expectedBuf = Buffer.from(expected, 'utf8');
  const receivedBuf = Buffer.from(received, 'utf8');

  if (expectedBuf.length !== receivedBuf.length || !crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
    console.error('[surveypesa-backend] webhook rejected: signature mismatch');
    return res.status(401).json({ success: false, message: 'Invalid signature.' });
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    console.error('[surveypesa-backend] webhook: unparseable JSON body: ' + err.message);
    // Acknowledge anyway — an authenticated-but-malformed payload should
    // not make HashPay retry forever.
    return res.status(200).json({ received: true, processed: false, message: 'Invalid JSON body.' });
  }

  // A "payment.success" event — or a payload with no explicit event type
  // but clear payment fields (some HashPay payloads carry no event name).
  const rawEventType =
    (typeof payload.event === 'string' && payload.event) ||
    (typeof payload.type === 'string' && payload.type) ||
    null;
  const eventType = rawEventType ? String(rawEventType).toLowerCase() : null;
  const hasPaymentFields =
    payload.ResponseCode !== undefined ||
    payload.TransactionAmount !== undefined ||
    payload.Amount !== undefined ||
    payload.TransactionReference !== undefined ||
    payload.Reference !== undefined;
  const validEvent = eventType === null ? hasPaymentFields : eventType === 'payment.success';

  if (!validEvent) {
    console.log('[surveypesa-backend] webhook: ignoring event "' + (eventType || '(none)') + '"');
    return res.status(200).json({ received: true, processed: false, message: 'Event ignored.' });
  }

  if (payload.ResponseCode !== 0 && payload.ResponseCode !== '0') {
    console.log(
      '[surveypesa-backend] webhook: ResponseCode ' + payload.ResponseCode + ' — payment not successful, ignoring'
    );
    return res.status(200).json({ received: true, processed: false, message: 'Payment not successful.' });
  }

  const reference = String(payload.TransactionReference || payload.Reference || '');
  const order = reference ? orders.get(reference) : null;
  if (!order) {
    console.error('[surveypesa-backend] webhook: no order for reference "' + reference + '"');
    return res.status(200).json({ received: true, processed: false, message: 'Unknown reference.' });
  }

  // Guard against a tampered/mismatched webhook amount before trusting it.
  const paidAmount = payload.TransactionAmount !== undefined ? payload.TransactionAmount : payload.Amount;
  if (Number(paidAmount) !== order.amount) {
    order.status = 'amount_mismatch';
    console.error(
      '[surveypesa-backend] webhook: AMOUNT MISMATCH for "' + reference +
      '" — expected ' + order.amount + ', webhook says ' + paidAmount
    );
    return res.status(200).json({ received: true, processed: true, status: order.status });
  }

  order.status = 'success';
  order.receipt =
    payload.TransactionReceipt || payload.Receipt || payload.MpesaReceiptNumber || order.receipt || null;
  if (!order.checkout_id && payload.CheckoutRequestID) {
    order.checkout_id = payload.CheckoutRequestID;
  }
  console.log('[surveypesa-backend] webhook: order "' + reference + '" marked success (receipt: ' + order.receipt + ')');
  return res.status(200).json({ received: true, processed: true, status: order.status });
});

/* ------------------------------------------------------------------ */
/* Global JSON body parser (the webhook route above deliberately runs   */
/* first, on the raw body)                                             */
/* ------------------------------------------------------------------ */

app.use(express.json());

/* ------------------------------------------------------------------ */
/* POST /api/stk/initiate                                              */
/* ------------------------------------------------------------------ */

app.post('/api/stk/initiate', async function (req, res) {
  const body = req.body || {};
  const amount = body.amount;
  const msisdn = body.msisdn;
  const requestedReference = body.reference;

  /* --- amount: checked FIRST, before anything else happens --------- */
  // Exact match against the fixed tier prices (no coercion — a string
  // "99" is rejected just like 99.50 or 500).
  if (!ALLOWED_AMOUNTS.includes(amount)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid amount. This site only accepts Ksh 99, Ksh 149, or Ksh 199.'
    });
  }

  /* --- phone number ------------------------------------------------- */
  if (typeof msisdn !== 'string' || !MSISDN_RE.test(msisdn)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid phone number. Use the format 2547XXXXXXXX or 2541XXXXXXXX.'
    });
  }

  /* --- reference (generated here when the frontend omits one) ------- */
  const reference =
    typeof requestedReference === 'string' && requestedReference.trim() !== ''
      ? requestedReference.trim()
      : generateReference();

  /* --- store the order as pending ----------------------------------- */
  const order = {
    reference: reference,
    amount: amount,
    msisdn: msisdn,
    status: 'pending',
    checkout_id: null,
    receipt: null,
    createdAt: new Date().toISOString()
  };
  orders.set(reference, order);

  /* --- forward the STK push to HashBack ------------------------------ */
  try {
    const response = await fetch(HASHBACK_STK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: HASHBACK_API_KEY,
        account_id: HASHBACK_ACCOUNT_ID,
        amount: amount,
        msisdn: msisdn,
        reference: reference
      }),
      signal: AbortSignal.timeout(15000)
    });

    let data = null;
    try {
      data = await response.json();
    } catch (parseErr) {
      // Non-JSON body — data stays null; still logged below with the status.
    }

    // Success = a checkout id under any of the spellings HashBack might
    // use, or a ResponseCode of 0, or success:true.
    const checkoutId =
      (data && (data.checkout_id || data.CheckoutRequestID || data.CheckoutRequestId || data.CheckoutID)) || null;
    const success =
      Boolean(checkoutId) ||
      data?.ResponseCode === 0 ||
      data?.ResponseCode === '0' ||
      data?.success === true;

    if (!success) {
      // HashBack answered but did NOT indicate success. Log the HTTP status
      // and the FULL response body — a rejected-but-still-JSON response
      // needs to be visible for debugging, not just thrown fetch errors.
      console.error(
        '[surveypesa-backend] HashBack initiate failed: HTTP ' + response.status + ' body: ' + JSON.stringify(data)
      );
      order.status = 'failed';
      return res.status(502).json({
        success: false,
        message: 'The payment provider rejected the STK push request.',
        providerStatus: response.status,
        providerError: data
      });
    }

    order.checkout_id = checkoutId;
    return res.json({
      success: true,
      checkout_id: checkoutId,
      reference: reference
    });
  } catch (err) {
    // fetch itself threw (network / DNS failure / the 15s timeout).
    console.error('[surveypesa-backend] HashBack initiate unreachable: ' + err.message);
    order.status = 'failed';
    return res.status(502).json({
      success: false,
      message: 'Could not reach the payment provider. Please try again.'
    });
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/stk/status/:reference — polled by the frontend             */
/* ------------------------------------------------------------------ */

app.get('/api/stk/status/:reference', function (req, res) {
  const order = orders.get(req.params.reference);
  if (!order) {
    return res.status(404).json({ success: false, message: 'Unknown reference.' });
  }
  return res.json({
    success: true,
    reference: order.reference,
    amount: order.amount,
    status: order.status, // pending | success | failed | amount_mismatch
    checkout_id: order.checkout_id,
    receipt: order.receipt,
    createdAt: order.createdAt
  });
});

/* ------------------------------------------------------------------ */
/* Static files                                                        */
/* ------------------------------------------------------------------ */

// Static roots, in priority order: the sibling frontend folder
// (../surveypesa.co.ke) FIRST, so GET / and GET /index.html serve the real
// site homepage. backend/public/ is second and only fills in anything the
// site folder doesn't have (its placeholder index.html is effectively
// unreachable at the root — a harmless stub).
app.use(express.static(path.join(__dirname, '..', 'surveypesa.co.ke')));
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/* Error handler                                                       */
/* ------------------------------------------------------------------ */

app.use(function (err, req, res, next) {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ success: false, message: 'Invalid JSON body.' });
  }
  console.error('[surveypesa-backend] unhandled error:', err);
  return res.status(500).json({ success: false, message: 'Unexpected server error. Please try again.' });
});

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

// Only bind a port when run directly (node server.js / npm start / npm run
// dev). When Vercel's @vercel/node builder requires this file (see
// vercel.json) it uses the exported Express app instead.
if (require.main === module) {
  app.listen(PORT, function () {
    console.log('[surveypesa-backend] listening on http://localhost:' + PORT);
    console.log(
      '[surveypesa-backend] amounts: ' + ALLOWED_AMOUNTS.join('/') +
      ' | api key: ' + (HASHBACK_API_KEY ? 'configured' : 'MISSING') +
      ' | webhook secret: ' + (HASHBACK_WEBHOOK_SECRET ? 'configured' : 'MISSING')
    );
  });
}

module.exports = app;



