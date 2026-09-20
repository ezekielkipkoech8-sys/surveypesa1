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
HASHBACK_API_KEY=your_api_key_here        # <- replace with your real HashBack API key
HASHBACK_STK_ENDPOINT=your_hashback_stk_endpoint_here   # <- replace with the real STK endpoint URL
CORS_ORIGIN=                              # optional: e.g. http://localhost:8080,https://surveypesa.co.ke
```

Keep `.env` secret — it is already listed in `.gitignore`.

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
  "message": "STK push sent. Check the phone for the M-Pesa payment prompt and enter your PIN.",
  "request": { "phone": "254712345678", "amount": 99, "tier": 99 },
  "provider": { "...raw HashBack response..." : true }
}
```

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

## 7. Production notes

- Run behind HTTPS (e.g. with nginx or a platform like Render/Railway) — the
  browser blocks mixed content on HTTPS pages otherwise.
- Never commit `.env`; rotate the API key if it ever leaks.
- If HashBack expects a different auth header or payload field names, adjust
  the marked section in `server.js` (`providerPayload` / `Authorization`).
