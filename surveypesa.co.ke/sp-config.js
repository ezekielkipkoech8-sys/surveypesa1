/**
 * SurveyPesa payment pages — SINGLE point of configuration.
 * ----------------------------------------------------------
 * Every tier page (pay-99.html, pay-149.html, pay-199.html, pay.html) loads
 * this file BEFORE sp-stk.js. sp-stk.js reads window.SP_STK_CONFIG from
 * here.
 *
 * apiBase is resolved by the IIFE below rather than being a bare
 * window.location.origin - see the note above the IIFE for why a static
 * preview (VS Code Live Server on :5500) broke that assumption, and for the
 * full resolution order.
 */
/*
 * Resolution order for the API base URL (first match wins):
 *   1. ?api=<url>          per-tab override, e.g. pay-99.html?api=http://127.0.0.1:3001
 *   2. window.SP_API_BASE  injected by a <script> tag before this file
 *   3. DEV_API_BASE below  when the page is opened from a local static preview
 *   4. PROD_API_BASE below everything else (production)
 *
 * Why not just window.location.origin? That works when ONE deployment serves
 * both the pages and the API, but it silently breaks on a static preview:
 * opened from VS Code Live Server (port 5500) it resolves to
 * http://127.0.0.1:5500, so every STK request is POSTed at the static file
 * server, which answers 405 Method Not Allowed. The request never left the
 * preview server — the browser was never the problem.
 *
 * WHICH BACKEND, AND WHY 3001
 * --------------------------
 * DEV_API_BASE points at surveypesa-backend (3001) because that is the
 * service that actually serves the two routes sp-stk.js calls:
 *     POST /api/stk/initiate     { amount, msisdn }
 *     GET  /api/stk/status/:ref  -> pending | success | failed
 * and it validates tier prices 99 / 149 / 199.
 *
 * stk-push-server (3000) is the Hela Sasa service and has a DIFFERENT
 * contract: POST /api/stk-push with { phone, tier }, tiers 49/99/149, and NO
 * status endpoint at all. Pointing this config at 3000 would turn the 405 into
 * a 404, because /api/stk/initiate does not exist there. Use the ?api=
 * override if you are deliberately testing that server.
 */
(function () {
  'use strict';

  /** Local dev backend. Change this one line to switch dev environments. */
  var DEV_API_BASE = 'http://127.0.0.1:3001';

  /**
   * Optional production override. Leave EMPTY: in production the backend
   * serves the pages and the API from one origin, so window.location.origin
   * is correct and also survives Vercel preview deploys (random
   * *.vercel.app hostnames), which a hardcoded domain would get wrong.
   * Set it only if you host the pages and the API on different domains.
   */
  var PROD_API_BASE = '';

  function isLocalPreview() {
    var h = window.location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '';
  }

  function fromQuery() {
    try {
      var v = new URLSearchParams(window.location.search).get('api');
      return v ? String(v) : null;
    } catch (e) {
      return null; // very old browser without URLSearchParams
    }
  }

  function resolveApiBase() {
    var injected = typeof window.SP_API_BASE === 'string' ? window.SP_API_BASE : null;
    var chosen =
      fromQuery() ||
      injected ||
      (isLocalPreview() ? DEV_API_BASE : (PROD_API_BASE || window.location.origin));
    // Strip trailing slashes so CONFIG.apiBase + '/api/...' never doubles up.
    return String(chosen).replace(/\/+$/, '');
  }

  var apiBase = resolveApiBase();

  window.SP_STK_CONFIG = {
    apiBase: apiBase,
    redirectUrl: 'https://surveypesa.co.ke/users',
    redirectDelaySeconds: 0
  };

  // Makes the active target obvious in the browser console while debugging.
  if (window.console && console.info) {
    console.info('[sp-config] STK API base:', apiBase);
  }
})();
