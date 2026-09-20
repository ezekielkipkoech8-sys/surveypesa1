# surveypesa-backend — HashBack M-Pesa STK Push backend (surveypesa.co.ke)

Express backend powering the Lite / Standard / Premium activation payments
(Ksh 99 / 149 / 199) on the SurveyPesa tier pages. Talks to the same HashBack
account as the Hela Sasa backend (`../stk-push-server/`, port 3000) but runs
on port **3001** and stamps orders with `SP-`-prefixed references so the two
sites' transactions are distinguishable in the HashBack dashboard.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/stk/initiate` | Body `{ amount, msisdn, reference? }`. `amount` must be exactly `99`, `149` or `199` (number, not string); `msisdn` must match `/^254[71]\d{8}$/`. Forwards an STK push to HashBack. |
| GET | `/api/stk/status/:reference` | Order status: `pending` / `success` / `failed` / `amount_mismatch` (polled by the frontend every 3s). |
| POST | `/api/webhook/hashpay` | Signed payment webhook (HMAC-SHA256, `X-Hashpay-Signature: sha256=...`). Marks orders `success` and stores the M-Pesa receipt. |
| GET | `/` | Serves the frontend site (surveypesa.co.ke first; `public/` as fallback). |

CORS is permissive on purpose (`Access-Control-Allow-Origin: *`, OPTIONS →
204) so the static tier pages can call the API from any origin, including a
`file://` preview.

## Local setup

    cd surveypesa-backend
    copy .env.example .env      # then fill in the real values
    npm install
    npm start                   # or: npm run dev (auto-restart on change)

`.env` keys:

- `HASHBACK_API_KEY` — HashBack API key
- `HASHBACK_ACCOUNT_ID` — `HP120819` (shared with the Hela Sasa project)
- `HASHBACK_WEBHOOK_SECRET` — from HashPay Settings → Webhooks
- `PORT` — defaults to 3001

## Frontend wiring — single point of configuration

The tier pages (`../surveypesa.co.ke/pay-99.html`, `pay-149.html`,
`pay-199.html`, `pay.html`) each load, in order:

1. `sp-config.js` — **the single place** defining `window.SP_STK_CONFIG`
   (`apiBase`, redirect URL, redirect delay). All four pages pull from this
   one file; no page hardcodes an API URL anymore.
2. `sp-stk.js` — the submit/poll handler: normalizes the phone to
   `2547…/2541…`, sends `{ amount: <number>, msisdn }` to
   `POST /api/stk/initiate`, polls `GET /api/stk/status/:reference`,
   shows the M-Pesa receipt and redirects to `/users` on success.

**No URL editing is needed anywhere.** `apiBase` is derived from
`window.location.origin` in `sp-config.js`, so the pages always call the API
on the origin that serves them:

- **Local unified dev:** `cd surveypesa-backend && npm start`, then open the
  pages on the backend's own origin — e.g. `http://localhost:3001/pay-99.html`
  or `http://localhost:3001/test-flow.html`. Pages and API in one place.
- **Production:** the single Vercel deployment serves both the static pages
  and the API from one origin, so `window.location.origin` points at the API
  automatically.

(Only if you deliberately serve the pages from a static host WITHOUT the API
— e.g. a plain static server on another port — would payment calls 404; use
the unified server, or set `apiBase` to an absolute URL again.)

The per-page tier price is **not** in the config: each page carries its
amount in the readonly tier input (`value="99|149|199"`), which `sp-stk.js`
reads and sends as a number. The backend re-validates it against
`[99, 149, 199]` and rejects anything else with a 400.

## Deployment (Vercel)

`vercel.json` is included (`@vercel/node` build of `server.js` with a
catch-all route). Before going live:

1. Set `HASHBACK_API_KEY`, `HASHBACK_ACCOUNT_ID` and
   `HASHBACK_WEBHOOK_SECRET` in the Vercel project's environment variables.
2. Nothing to point or edit: `sp-config.js` derives `apiBase` from
   `window.location.origin`, so one deployment serving the static pages and
   the API together is all it takes. (If you instead host the static pages
   somewhere else, set `apiBase` in `sp-config.js` to the API's absolute
   URL.)
3. In HashPay → Settings → Webhooks, point the webhook at
   `https://<your-backend>/api/webhook/hashpay` using the same secret as
   `HASHBACK_WEBHOOK_SECRET` (webhooks are verified with HMAC-SHA256 and
   rejected with 401 otherwise).

**Limitation:** orders are kept in an in-memory `Map` — fine for local dev,
but lost on restart and NOT shared between serverless instances. For real
production traffic, move the store to a database and keep the same endpoint
contracts.

## Tests

    node _test-backend.mjs        # full endpoint suite on port 3107 (boots its own server)
    node _test-frontend-flow.mjs  # replays the pages' exact fetches + static checks
                                  # for the tier pages (port 3001, boots its own server)

Both boot `server.js` themselves with dummy credentials — no real payments
are initiated. Note: the initiate tests DO reach
`https://api.hashback.co.ke` with a dummy key; HashBack currently answers
`403 {"success":false,"message":"Account expired. Please renew to continue."}`
for invalid credentials — verify/renew the account in the HashBack dashboard
and set the real API key before going live.

## Tier pages

| Page | Tier | Amount sent |
|---|---|---|
| `pay-99.html` | Lite | 99 |
| `pay-149.html` | Standard | 149 |
| `pay-199.html` | Premium | 199 |
| `pay.html` | legacy page, realigned to the Lite tier (was the old KSh 49 page) | 99 |

Backups of the pre-migration pages (original WordPress admin-ajax versions):
`pay-99.html.bak`, `pay-149.html.bak`, `pay.html.bak`.
