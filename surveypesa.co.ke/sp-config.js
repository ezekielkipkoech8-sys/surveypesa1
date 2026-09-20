/**
 * SurveyPesa payment pages — SINGLE point of configuration.
 * ----------------------------------------------------------
 * Every tier page (pay-99.html, pay-149.html, pay-199.html, pay.html) loads
 * this file BEFORE sp-stk.js. sp-stk.js reads window.SP_STK_CONFIG from
 * here.
 *
 * apiBase is derived from window.location.origin, so the SAME file works in
 * every environment with no manual URL edit:
 *   - local unified dev: `npm start` in surveypesa-backend, which now also
 *     serves these pages — just open them on the backend's own origin
 *   - production: the single deployment serves the pages and the API from
 *     one origin
 * (Only a static host that does NOT run the API would need apiBase pointed
 * at an absolute URL again.)
 */
window.SP_STK_CONFIG = {
  apiBase: window.location.origin,
  redirectUrl: 'https://surveypesa.co.ke/users',
  redirectDelaySeconds: 0
};
