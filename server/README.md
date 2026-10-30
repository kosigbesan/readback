# ReadBack API

The money and voice layer. Three jobs and nothing else:

1. Say what plan a device is on. Decided here, not on the phone.
2. Take money through Stripe and keep the licence in step with it.
3. Proxy the premium voice, so the ElevenLabs key never reaches the client and
   voice characters can actually be metered.

Run it locally:

```
cd server
npm install
npm test          # 85 checks, no network, no real Stripe spend
npm start         # listens on :8787
```

## Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/api/health` | Which integrations are configured. Never returns a key. |
| GET | `/api/plans` | The catalogue, so the app and the server cannot drift. |
| POST | `/api/licence` | `{deviceId}` in, plan and usage out. Creates the licence on first sight. |
| POST | `/api/checkout` | `{deviceId, planId, email}` in, a Stripe Checkout URL out. |
| POST | `/api/stripe/webhook` | Raw-body, signature verified, idempotent. |
| POST | `/api/tts` | `{deviceId, text, voiceId}` in, audio out. Meters and enforces. |
| POST | `/api/usage` | Usage for this month, for the current device. |
| GET | `/api/admin/summary` | Counts by plan. Needs a bearer token, 404s if unset. |

## Environment

Copy `.env.example` to `.env` and fill it in. Nothing works without the keys you
choose to add, and the app degrades honestly when they are missing:

- No `STRIPE_SECRET_KEY`: the app says payments are not configured instead of
  pretending. `npm test` covers this path.
- No `ELEVENLABS_API_KEY`: premium voice returns a clear 503.
- No `STRIPE_WEBHOOK_SECRET`: the webhook returns 503 rather than trusting
  unverified bodies.

## Stripe setup, in order

1. Stripe dashboard, Product catalogue. Create three products: Interview Sprint
   ($19 one off), Pro monthly ($7.99/month), Pro annual ($49/year).
2. Copy each price id into `STRIPE_PRICE_SPRINT`, `STRIPE_PRICE_PRO_MONTHLY`,
   `STRIPE_PRICE_PRO_YEARLY`.
3. Developers, Webhooks, add an endpoint pointing at
   `https://your-service/api/stripe/webhook`, subscribed to
   `checkout.session.completed`, `customer.subscription.updated` and
   `customer.subscription.deleted`.
4. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
5. Test with Stripe test keys and card `4242 4242 4242 4242` before going live.

## Deploying

Replit: import the repo, set the env vars under Secrets, and publish. Render:
new Web Service, root directory `server`, build `npm install`, start `npm start`.

Whichever you pick, set `PUBLIC_BASE` to where the app is served, because that
is where Stripe sends the buyer back to, and set `ALLOWED_ORIGINS` to the app
origin rather than `*` once you are live.

## Storage

`lib/store.js` exposes five methods over an object store. The default is a JSON
file, which is plenty for the first few hundred customers and needs no database
to provision. When that stops being enough, implement the same five methods over
Postgres or Supabase and change one line in `start.js`. Nothing above that file
knows which one is in use.

The one thing not to skip when you do move: the webhook idempotency table. Stripe
retries until it gets a 2xx, so an event applied twice would double-apply.

## What the tests cover

Signature verification against a wrong secret and a tampered payload, webhook
idempotency, the sprint pass activating and expiring on its own, the full
subscription lifecycle including cancellation, metering that bills only after the
audio exists, a failed render not being billed, allowance exhaustion, rate
limiting, CORS including the exposed metering headers, and the free plan being
unable to reach the paid voice at all.
