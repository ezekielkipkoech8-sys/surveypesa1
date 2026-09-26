# SurveyPesa STK Push Server

A simple Node.js + Express backend that accepts M-Pesa activation payments
(KSh 49 / 99 / 149) from the SurveyPesa activation pages and forwards them to
the **HashBack API** as an STK Push request.

```
Browser (activation page)  -->  POST /api/stk-push  -->  this server  -->  HashBack STK API  -->  M-Pesa prompt on the phone
```

## 1. Prerequisites

- [Node.js](https://nodejs.org) 18+ (Node 22 is installed on this machine)
- Your HashBack API key and STK Push endpoint URL

## 2. Install dependencies

Open a terminal in this folder (`stk-push-server`) and run:

```bash
npm install
```

This installs the four dependencies declared in `package.json`:
`express`, `cors`, `dotenv`, `axios`.

## 3. Configure `.env`

Edit the `.env` file in this folder:

```
PORT=3000
HASHBACK_API_KEY=your_api_key_here        # Settings > Credentials
HASHBACK_ACCOUNT_ID=your_account_id       # Settings > Payment Channels (NOT the Wallet ID)
HASHBACK_STK_ENDPOINT=https://api.hashback.co.ke/initiatestk
CORS_ORIGIN=                              # optional: e.g. http://localhost:8080,https://surveypesa.co.ke
DRY_RUN=1                                 # optional: log the request, send nothing
```

Keep `.env` secret — it is already listed in `.gitignore`.

A secret-free template is provided as `.env.example`; copy it if you need to
start over:

```bash
cp .env.example .env    # Windows PowerShell:  Copy-Item .env.example .env
```

> **Account ID vs Wallet ID.** The Credentials tab shows a *Wallet ID*
> (`HW…`) for the B2C wallet product. The STK push API needs the *Account ID*
> from **Payment Channels**. They are different identifiers.

### If it still says `NOT CONFIGURED`

`isConfigured()` needs **all three** of `HASHBACK_API_KEY`,
`HASHBACK_ACCOUNT_ID` and `HASHBACK_STK_ENDPOINT`. The endpoint must start
with `http://` or `https://` and must not still be a placeholder (anything
starting with `your_`, `change_me`, `xxx…` or `placeholder` is rejected).

## 4. Run the server

```bash
npm start          # production start
npm run dev        # same, but auto-restarts when server.js changes
```

You should see:

```
STK push server listening on http://localhost:3000
POST /api/stk-push  (tiers: 49, 99, 149)
HashBack endpoint: https://...      (or "NOT CONFIGURED" until you edit .env)
```

Quick check: open <http://localhost:3000/health> in a browser — it should
return `{"success":true,"status":"ok",...}`.

## 5. API reference

### `GET /health`

Returns server status and whether the HashBack credentials are configured.

### `POST /api/stk-push`

Request body (JSON):

| Field    | Type           | Required | Notes                                                        |
|----------|----------------|----------|--------------------------------------------------------------|
| `phone`  | string         | yes      | Kenyan number: `07…`, `01…`, `+2547…`, `2547…` — normalized automatically |
| `amount` | whole number   | optional | KSh amount; if omitted, the `tier` price is used             |
| `tier`   | 49, 99 or 149  | optional | Must be one of the activation tiers; validates the amount    |

Success response (`200`):

```json
{
  "success": true,
  "message": "STK push sent. Check the phone for the M-Pesa payment prompt and enter your PIN. …",
  "request": { "phone": "254712345678", "amount": 99, "tier": 99, "reference": "HS-…" },
  "checkout_id": "ws_CO_16092026004400759796721744",
  "provider": { "...raw HashBack response..." : true }
}
```

> `success` here means the **prompt was delivered**, not that the customer
> paid. Wait for the webhook (or poll `https://api.hashback.co.ke/transactionstatus`
> with the `checkout_id`) before releasing anything of value.

Error responses (all JSON, with clear `message`):

- `400` — missing/invalid phone, invalid tier, invalid amount
- `500` — server not configured (`.env` still has placeholders)
- `502` — HashBack rejected the request or was unreachable (includes `providerStatus` / `providerError` when available)

### Example test calls

PowerShell:

```powershell
# health
Invoke-RestMethod http://localhost:3000/health

# activation payment for the Standard tier (KSh 99)
Invoke-RestMethod -Uri http://localhost:3000/api/stk-push -Method Post `
  -ContentType 'application/json' `
  -Body '{"phone":"0712345678","tier":99}'
```

curl:

```bash
curl -X POST http://localhost:3000/api/stk-push \
  -H "Content-Type: application/json" \
  -d '{"phone":"0712345678","tier":149}'
```

## 6. Call it from the activation page (frontend wiring)

Add a small script to `activation.html` / the pay pages (or your own frontend)
so the tier buttons trigger an STK push instead of just navigating:

```html
<script>
async function startActivationPayment(phone, tier) {
  const res = await fetch('http://localhost:3000/api/stk-push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: phone, tier: tier })
  });
  const data = await res.json();
  if (data.success) {
    alert(data.message);          // tell the user to check their phone
  } else {
    alert(data.message);          // validation / provider error message
  }
}
// Example: wire the Standard tier button (KSh 99)
// startActivationPayment('0712345678', 99);
</script>
```

For production, point `fetch` at your deployed server URL and add that origin
to `CORS_ORIGIN` in `.env`.

## 7. How the HashBack call is made

`server.js` translates our `{ phone, tier }` request into HashBack's documented
format. The source of truth is the **official docs**, not this file:
<https://hashback.co.ke/documentation> → *Initiate STK Push*.

```
POST https://api.hashback.co.ke/initiatestk
Content-Type: application/json

{
  "api_key":    "…",
  "account_id": "…",
  "amount":     "99",
  "msisdn":     "254712345678",
  "reference":  "HS-…"
}
```

Things worth knowing, because they are easy to get wrong:

- **Auth is in the body**, as `api_key`. There is **no `Authorization`
  header** on this endpoint. HashBack *does* use `Authorization: Bearer` — but
  only on its **SMS API** (`/sms/*`). Sending a Bearer header here is what the
  old scaffold did, and it was wrong.
- **All five body fields are required**, and HashBack types every one of them
  as a string — including `amount` (`"99"`, not `99`).
- `msisdn` must already be normalised to `2547XXXXXXXX`. Our
  `normalizeKenyanPhone()` does that before the request is built.
- `reference` must be unique and URL-encoded; ours is generated server-side
  with an `HS-` prefix and contains only URL-safe characters.
- Our `tier` and `timestamp` are **local concepts** and are deliberately not
  forwarded to HashBack.

### Testing without charging a real handset

```bash
npm test          # 27 assertions against a local mock, no network
```

`_test-hashback-shape.mjs` stands up a local HTTP server in place of HashBack,
records exactly what arrived, and asserts the method, path, headers, body field
names and types against the documented spec. It also boots a second instance
with `DRY_RUN=1` pointed at a dead port to prove the dry-run path opens no
socket at all.

To inspect the request built from your real credentials — still without sending
anything — set `DRY_RUN=1` in `.env` and restart:

```
POST https://api.hashback.co.ke/initiatestk
headers: {"Content-Type":"application/json"}
body   : { "api_key": "…", "account_id": "…", "amount": "99",
           "msisdn": "254712345678", "reference": "HS-…" }
```

The response is returned as `{"success":true,"dryRun":true,…,"wouldSend":{…}}`.

## 8. Production notes

- **HashBack is phasing these endpoints out.** Their docs mark the low-level
  STK endpoints as *"being phased out"* and *"will be discontinued"*, steering
  new integrations to a **Payment Button SDK** (`hashpay.js`) that handles
  initiation, status polling and the payer UI. It works for existing
  integrations, but raise it with HashBack before committing to it long-term.
- **A `200` is not a payment.** It means the prompt reached the handset. Wait
  for the webhook or poll `/transactionstatus` with the `checkout_id` before
  granting access.
- **Only live and Pay-As-You-Go channels can accept a push**, and test pushes
  only reach your own nominated numbers.
- Run behind HTTPS (e.g. with nginx or a platform like Render/Railway) — the
  browser blocks mixed content on HTTPS pages otherwise.
- Never commit `.env`; rotate the API key if it ever leaks.
- If HashBack expects a different auth header or payload field names, adjust
  the marked section in `server.js` (`providerPayload` / `Authorization`).
