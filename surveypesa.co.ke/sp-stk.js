/**
 * SurveyPesa STK Push frontend handler (sp-stk.js)
 * ------------------------------------------------
 * Replaces the old WordPress admin-ajax M-Pesa script (the wpo-minify
 * "mpesa-stk-js" bundle), which posted to
 * https://surveypesa.co.ke/wp-admin/admin-ajax.php and caused CORS / network
 * errors whenever the payment pages are opened from anywhere that is not the
 * WordPress origin (local previews, static mirrors, etc.).
 *
 * It now talks to the surveypesa-backend Express server instead:
 *   POST /api/stk/initiate     { amount: <number>, msisdn: '2547XXXXXXXX' }
 *   GET  /api/stk/status/:ref  -> { status: 'pending'|'success'|'failed'|'amount_mismatch', receipt, ... }
 *
 * The backend sends permissive CORS headers (Access-Control-Allow-Origin: *,
 * OPTIONS preflights answered with 204), so these calls are not blocked by
 * the browser even from a file:// preview.
 *
 * Behaviour kept from the old script: disable the button while sending,
 * status-line feedback, poll every 3s (max 20 attempts), show the M-Pesa
 * receipt on success, then redirect.
 * Behaviour changed on purpose:
 * - the phone is normalised client-side to 2547XXXXXXXX / 2541XXXXXXXX
 *   before sending (the old script posted the raw "07XX XXX XXX" input);
 * - the amount is sent as a NUMBER read from the page's readonly tier input
 *   (the backend rejects anything that is not exactly 99 / 149 / 199);
 * - the reference is NOT sent — the backend generates a unique "SP-…"
 *   reference per order (the old pages hardcoded shared "Order-…" values).
 */
/* global jQuery */
(function ($) {
  'use strict';

  // Configuration comes from sp-config.js — the single point of
  // configuration, loaded before this file on every tier page (see
  // surveypesa-backend/README.md for how to switch environments). The
  // object below is only a fallback for pages that omit sp-config.js.
  var CONFIG = window.SP_STK_CONFIG || {
    apiBase: 'http://localhost:3001',
    redirectUrl: 'https://surveypesa.co.ke/users',
    redirectDelaySeconds: 0
  };

  var POLL_INTERVAL_MS = 3000;
  var MAX_POLL_ATTEMPTS = 20;

  /**
   * Accepts the formats users actually type ("0712345678", "0712 345 678",
   * "+254712345678", "712345678", "254712345678" ...) and returns the
   * 2547XXXXXXXX / 2541XXXXXXXX form the backend and Safaricom require,
   * or null when the number cannot be used.
   */
  function normalizePhone(raw) {
    if (raw === undefined || raw === null) return null;
    var p = String(raw).replace(/[\s\-().]/g, '');
    if (p.charAt(0) === '+') p = p.slice(1);
    if (/^0(7|1)\d{8}$/.test(p)) {
      p = '254' + p.slice(1);
    } else if (/^(7|1)\d{8}$/.test(p)) {
      p = '254' + p;
    }
    if (!/^254(7|1)\d{8}$/.test(p)) return null;
    return p;
  }

  function pollStatus(reference, $status, $button, attempt) {
    if (attempt >= MAX_POLL_ATTEMPTS) {
      $status
        .removeClass('is-success')
        .addClass('is-error')
        .text('Still waiting on confirmation. If you approved the prompt, this page will update shortly — you can also refresh.');
      $button.prop('disabled', false);
      return;
    }
    window.setTimeout(function () {
      fetch(CONFIG.apiBase + '/api/stk/status/' + encodeURIComponent(reference))
        .then(function (r) {
          return r.json().then(function (body) { return { ok: r.ok, body: body }; });
        })
        .then(function (res) {
          if (!res.ok) {
            // e.g. 404 unknown reference (backend restarted) — stop polling.
            $status.removeClass('is-success').addClass('is-error')
              .text((res.body && res.body.message) || 'Payment status could not be confirmed. Please contact support.');
            $button.prop('disabled', false);
            return;
          }
          var st = res.body && res.body.status;
          if (st === 'success') {
            $status.removeClass('is-error').addClass('is-success')
              .text('Payment received. Receipt: ' + ((res.body && res.body.receipt) || ''));
            $button.prop('disabled', true).text('Paid');
            redirectAfterSuccess();
          } else if (st === 'failed') {
            $status.removeClass('is-success').addClass('is-error')
              .text('Payment was not completed. No money has left the account. Please try again.');
            $button.prop('disabled', false).text('Try Again');
          } else if (st === 'amount_mismatch') {
            $status.removeClass('is-success').addClass('is-error')
              .text('We could not verify this payment (amount mismatch). Please contact support with your M-Pesa message.');
            $button.prop('disabled', false);
          } else {
            // 'pending' — keep polling.
            pollStatus(reference, $status, $button, attempt + 1);
          }
        })
        .catch(function () {
          // Transient network error — keep polling like the old script did.
          pollStatus(reference, $status, $button, attempt + 1);
        });
    }, POLL_INTERVAL_MS);
  }

  function redirectAfterSuccess() {
    var url = CONFIG.redirectUrl;
    if (!url) return;
    var delay = parseInt(CONFIG.redirectDelaySeconds, 10);
    if (isNaN(delay)) delay = 2;
    window.setTimeout(function () { window.location.href = url; }, delay * 1000);
  }

  $(document).on('submit', '.mpesa-stk-form', function (e) {
    e.preventDefault();
    var $form = $(this);
    var $status = $form.find('.mpesa-stk-status');
    var $button = $form.find('.mpesa-stk-submit');
    var $phone = $form.find('[name="phone"]');
    var $amount = $form.find('[name="amount"]');
    var originalLabel = $button.data('sp-label') || $button.text();
    $button.data('sp-label', originalLabel);

    var msisdn = normalizePhone($phone.val());
    if (!msisdn) {
      $status.removeClass('is-success').addClass('is-error')
        .text('Enter a valid Safaricom number, e.g. 0712 345 678 or 254712345678.');
      return;
    }

    // Amount comes from the page's readonly tier input and is sent as a
    // NUMBER — the backend validates it against 99 / 149 / 199 exactly.
    var amount = Number(String($amount.val() == null ? '' : $amount.val()).trim());

    $button.prop('disabled', true).text('Sending request...');
    $status.removeClass('is-error is-success').text('');

    fetch(CONFIG.apiBase + '/api/stk/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amount, msisdn: msisdn })
    })
      .then(function (r) {
        return r.json().then(function (body) { return { ok: r.ok, body: body }; });
      })
      .then(function (res) {
        if (!res.ok || !res.body || res.body.success !== true || !res.body.reference) {
          $status.removeClass('is-success').addClass('is-error')
            .text((res.body && res.body.message) || 'Something went wrong. Please try again.');
          $button.prop('disabled', false).text(originalLabel);
          return;
        }
        $status.removeClass('is-error').addClass('is-success')
          .text('STK push sent. Check your phone and enter your M-Pesa PIN.');
        $button.prop('disabled', true).text('Waiting for confirmation...');
        pollStatus(res.body.reference, $status, $button, 0);
      })
      .catch(function () {
        $status.removeClass('is-success').addClass('is-error')
          .text('Network error: could not reach the payment server. Please try again.');
        $button.prop('disabled', false).text(originalLabel);
      });
  });

})(jQuery);
