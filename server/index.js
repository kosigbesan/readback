/* ReadBack API: the money and voice layer.

   Three jobs, and nothing else:
     1. Tell the app what plan a device is on, decided here, not on the phone.
     2. Take money through Stripe and keep the licence in step with it.
     3. Proxy the premium voice so the ElevenLabs key never reaches the client
        and voice minutes can actually be metered.

   createApp() is exported so the tests can drive it with a fake store and a
   mocked voice upstream. index.js only wires the real dependencies in.
*/

import express from "express";
import { PLANS, PRICE_ENV, newLicence, planFor, publicLicence } from "./lib/plans.js";

export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createApp({ store, stripe = null, cfg = {} }) {
  const config = {
    publicBase: cfg.publicBase || "https://kosigbesan.github.io/readback",
    webhookSecret: cfg.webhookSecret || null,
    elevenKey: cfg.elevenKey || null,
    elevenBase: cfg.elevenBase || "https://api.elevenlabs.io",
    elevenModel: cfg.elevenModel || "eleven_turbo_v2_5",
    allowedOrigins: cfg.allowedOrigins || ["*"],
    maxCharsPerRequest: cfg.maxCharsPerRequest || 1200,
    ttsPerMinute: cfg.ttsPerMinute || 40,
    adminToken: cfg.adminToken || null,
    prices: cfg.prices || {},
    // Lets the whole buy loop be walked through with no Stripe account. Only
    // ever active when no real Stripe key is present, so it cannot be used to
    // give away paid plans in production.
    demoCheckout: !!cfg.demoCheckout
  };

  const app = express();
  app.disable("x-powered-by");

  /* ---------- CORS: the app is served from a different origin ---------- */
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const allowAll = config.allowedOrigins.includes("*");
    if (origin && (allowAll || config.allowedOrigins.includes(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    // Without this, the browser hides the metering headers from the app and the
    // remaining voice allowance would silently read as null.
    res.setHeader("Access-Control-Expose-Headers", "X-Voice-Chars-Billed, X-Voice-Chars-Left, Content-Length");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  /* ---------- Stripe must see the exact bytes it signed ---------- */
  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), wrap(async (req, res) => {
    if (!stripe || !config.webhookSecret) {
      return res.status(503).json({ error: "Webhooks are not configured on this server." });
    }
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], config.webhookSecret);
    } catch (err) {
      return res.status(400).json({ error: "Signature verification failed: " + err.message });
    }
    // Stripe retries until it gets a 2xx. Ignore anything already handled.
    if (await store.seenEvent(event.id)) return res.json({ received: true, duplicate: true });

    const out = await applyEvent(event);
    await store.markEvent(event.id, { type: event.type, outcome: out });
    res.json({ received: true, outcome: out });
  }));

  app.use(express.json({ limit: "256kb" }));
  app.use(express.urlencoded({ extended: false }));

  const demoMode = () => config.demoCheckout && !stripe;

  /* ---------- health: says what is wired up, never leaks a key ---------- */
  app.get("/api/health", (req, res) => {
    res.json({
      ok: true,
      service: "readback-api",
      store: store.kind,
      stripe: !!stripe,
      webhooks: !!config.webhookSecret,
      voice: !!config.elevenKey,
      demoCheckout: demoMode(),
      plans: Object.keys(PLANS).length,
      time: new Date().toISOString()
    });
  });

  app.get("/api/plans", (req, res) => {
    res.json({
      plans: Object.values(PLANS).map((p) => ({
        id: p.id, name: p.name, priceLabel: p.priceLabel, mode: p.mode,
        docs: p.docs === Infinity ? null : p.docs,
        listenMinutesPerDay: p.listenMinutesPerDay,
        voiceCharsPerMonth: p.voiceCharsPerMonth,
        premiumVoice: p.premiumVoice,
        buyable: p.mode !== "free"
      }))
    });
  });

  /* ---------- what plan is this device on ---------- */
  app.post("/api/licence", wrap(async (req, res) => {
    const deviceId = cleanId(req.body && req.body.deviceId);
    if (!deviceId) return res.status(400).json({ error: "deviceId is required" });
    const licence = await ensureLicence(deviceId);
    const usage = await store.getUsage(deviceId, monthKey());
    res.json({ licence: publicLicence(licence, usage) });
  }));

  /* ---------- start a purchase ---------- */
  app.post("/api/checkout", wrap(async (req, res) => {
    const { planId, email } = req.body || {};
    const deviceId = cleanId(req.body && req.body.deviceId);
    if (!deviceId) return res.status(400).json({ error: "deviceId is required" });
    const plan = PLANS[planId];
    if (!plan) return res.status(400).json({ error: "Unknown plan" });
    if (plan.mode === "free") return res.status(400).json({ error: "The free plan does not need checkout" });
    if (!stripe) {
      if (demoMode()) {
        // no Stripe yet, so hand back the built in test checkout instead of an error
        const q = "?deviceId=" + encodeURIComponent(deviceId) + "&planId=" + encodeURIComponent(plan.id);
        // absolute, because the app is served from a different origin
        return res.json({ url: selfBase(req) + "/demo/checkout" + q, id: "demo_" + plan.id, demo: true });
      }
      return res.status(503).json({
        error: "Payments are not configured yet. Set STRIPE_SECRET_KEY on the server.",
        code: "no_stripe"
      });
    }
    const price = config.prices[planId] || process.env[PRICE_ENV[planId]];
    if (!price) {
      return res.status(503).json({
        error: "No Stripe price id configured for " + planId + ". Set " + PRICE_ENV[planId] + ".",
        code: "no_price"
      });
    }
    await ensureLicence(deviceId);
    const session = await stripe.checkout.sessions.create({
      mode: plan.mode === "subscription" ? "subscription" : "payment",
      line_items: [{ price, quantity: 1 }],
      success_url: config.publicBase + "/?paid=1&plan=" + plan.id,
      cancel_url: config.publicBase + "/?paid=0&plan=" + plan.id,
      client_reference_id: deviceId,
      customer_email: email || undefined,
      allow_promotion_codes: true,
      metadata: { deviceId, planId: plan.id },
      subscription_data: plan.mode === "subscription"
        ? { metadata: { deviceId, planId: plan.id } }
        : undefined
    });
    res.json({ url: session.url, id: session.id });
  }));

  /* ---------- a test checkout, so the loop can be walked end to end ----------
     Only exists when DEMO_CHECKOUT is on and no Stripe key is set. It charges
     nothing and says so on the page. Set a real Stripe key and these routes
     disappear, so this can never hand out paid plans by accident. */
  app.get("/demo/checkout", (req, res) => {
    if (!demoMode()) return res.status(404).send("Not found");
    const planId = String(req.query.planId || "");
    const deviceId = cleanId(req.query.deviceId);
    const plan = PLANS[planId];
    if (!plan || !deviceId) return res.status(400).send("Bad plan or device");
    res.type("html").send(demoCheckoutPage(plan, deviceId, config.publicBase));
  });

  app.post("/demo/complete", wrap(async (req, res) => {
    if (!demoMode()) return res.status(404).json({ error: "Not found" });
    const deviceId = cleanId(req.body && req.body.deviceId);
    const planId = String((req.body && req.body.planId) || "");
    const licence = await activate(deviceId, planId, {});
    if (!licence) return res.status(400).json({ error: "Unknown plan or device" });
    res.redirect(303, config.publicBase + "/?paid=1&plan=" + encodeURIComponent(planId) + "&demo=1");
  }));

  /* ---------- device voices are free, premium ones are metered ---------- */
  const ttsHits = new Map();

  app.post("/api/tts", wrap(async (req, res) => {
    const { text, voiceId } = req.body || {};
    const deviceId = cleanId(req.body && req.body.deviceId);
    if (!deviceId) return res.status(400).json({ error: "deviceId is required" });
    if (!text || !String(text).trim()) return res.status(400).json({ error: "text is required" });

    const chars = [...String(text)].length;
    if (chars > config.maxCharsPerRequest) {
      return res.status(413).json({ error: "Send shorter pieces. The app splits by sentence anyway." });
    }

    const licence = await ensureLicence(deviceId);
    const plan = planFor(licence);
    const period = monthKey();
    const usage = await store.getUsage(deviceId, period);

    if (!plan.premiumVoice) {
      return res.status(402).json({
        error: "The premium voice comes with a paid plan.",
        code: "plan_required",
        plan: plan.id
      });
    }
    const left = plan.voiceCharsPerMonth - usage.chars;
    if (chars > left) {
      return res.status(402).json({
        error: "Voice allowance used up for this month.",
        code: "allowance_exhausted",
        used: usage.chars,
        limit: plan.voiceCharsPerMonth
      });
    }
    if (!config.elevenKey) {
      return res.status(503).json({ error: "The voice service is not configured on this server.", code: "no_voice" });
    }

    // light rate limit, per device
    const now = Date.now();
    const hits = (ttsHits.get(deviceId) || []).filter((t) => now - t < 60000);
    if (hits.length >= config.ttsPerMinute) {
      return res.status(429).json({ error: "Slow down a moment." });
    }
    hits.push(now);
    ttsHits.set(deviceId, hits);

    const upstream = await fetch(
      config.elevenBase + "/v1/text-to-speech/" + encodeURIComponent(voiceId || "21m00Tcm4TlvDq8ikWAM") +
        "?output_format=mp3_44100_128",
      {
        method: "POST",
        headers: { "xi-api-key": config.elevenKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: String(text),
          model_id: config.elevenModel,
          voice_settings: { stability: 0.5, similarity_boost: 0.75 }
        })
      }
    );
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      return res.status(502).json({
        error: "The voice service rejected that request.",
        status: upstream.status,
        detail: detail.slice(0, 300)
      });
    }

    const audio = Buffer.from(await upstream.arrayBuffer());
    // bill only once the audio actually exists
    const after = await store.addUsage(deviceId, period, chars);

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", String(audio.length));
    res.setHeader("X-Voice-Chars-Billed", String(chars));
    res.setHeader("X-Voice-Chars-Left", String(Math.max(0, plan.voiceCharsPerMonth - after.chars)));
    res.send(audio);
  }));

  app.post("/api/usage", wrap(async (req, res) => {
    const deviceId = cleanId(req.body && req.body.deviceId);
    if (!deviceId) return res.status(400).json({ error: "deviceId is required" });
    const licence = await ensureLicence(deviceId);
    const usage = await store.getUsage(deviceId, monthKey());
    res.json({ period: monthKey(), usage, licence: publicLicence(licence, usage) });
  }));

  /* ---------- a small guarded summary, so you can see the business ---------- */
  app.get("/api/admin/summary", wrap(async (req, res) => {
    if (!config.adminToken) return res.status(404).json({ error: "Not found" });
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (token !== config.adminToken) return res.status(403).json({ error: "Not allowed" });
    const counts = {};
    for (const id of Object.keys(PLANS)) counts[id] = 0;
    const raw = store._raw ? store._raw() : { licences: {}, usage: {} };
    let charsThisMonth = 0;
    for (const l of Object.values(raw.licences || {})) {
      const p = planFor(l);
      counts[p.id] = (counts[p.id] || 0) + 1;
    }
    const period = monthKey();
    for (const byId of Object.values(raw.usage || {})) {
      if (byId[period]) charsThisMonth += byId[period].chars || 0;
    }
    res.json({ devices: Object.keys(raw.licences || {}).length, byPlan: counts, voiceCharsThisMonth: charsThisMonth, period });
  }));

  /* ---------- errors ---------- */
  app.use((err, req, res, next) => {
    const status = err && err.status ? err.status : 500;
    res.status(status).json({ error: err && err.message ? err.message : "Server error" });
  });

  async function ensureLicence(deviceId) {
    let licence = await store.getLicence(deviceId);
    if (!licence) {
      licence = newLicence(deviceId);
      await store.putLicence(licence);
    }
    return licence;
  }

  /* One place that turns a plan into a licence, used by both the Stripe webhook
     and the test checkout, so the two can never drift apart. */
  async function activate(deviceId, planId, opts) {
    const plan = PLANS[planId];
    if (!deviceId || !plan) return null;
    opts = opts || {};
    const licence = await ensureLicence(deviceId);
    licence.plan = plan.id;
    if (opts.email) licence.email = opts.email;
    if (opts.customer) licence.stripeCustomerId = opts.customer;
    licence.stripeSubscriptionId = opts.subscription || null;
    licence.cancelAtPeriodEnd = false;
    licence.expiresAt = plan.mode === "payment" ? Date.now() + plan.durationDays * 864e5 : null;
    await store.putLicence(licence);
    return licence;
  }

  /* Apply a verified Stripe event to a licence. Pure enough to unit test. */
  async function applyEvent(event) {
    const type = event.type;
    const obj = event.data && event.data.object ? event.data.object : {};

    if (type === "checkout.session.completed") {
      const deviceId = cleanId((obj.metadata && obj.metadata.deviceId) || obj.client_reference_id);
      const planId = obj.metadata && obj.metadata.planId;
      const licence = await activate(deviceId, planId, {
        email: obj.customer_details ? obj.customer_details.email : null,
        customer: typeof obj.customer === "string" ? obj.customer : null,
        subscription: typeof obj.subscription === "string" ? obj.subscription : null
      });
      if (!licence) return "ignored: no device or plan on the session";
      return "activated " + licence.plan;
    }

    if (type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
      const deviceId = cleanId(obj.metadata && obj.metadata.deviceId) || await findBySubscription(obj.id);
      if (!deviceId) return "ignored: no matching device";
      const licence = await ensureLicence(deviceId);
      licence.stripeSubscriptionId = obj.id || licence.stripeSubscriptionId;
      licence.cancelAtPeriodEnd = !!obj.cancel_at_period_end;
      const dead = type === "customer.subscription.deleted" || obj.status === "canceled" || obj.status === "unpaid";
      if (dead) {
        licence.plan = "free";
        licence.expiresAt = null;
      } else if (obj.status === "active" || obj.status === "trialing") {
        const planId = obj.metadata && obj.metadata.planId;
        if (PLANS[planId]) licence.plan = planId;
        licence.expiresAt = obj.current_period_end ? obj.current_period_end * 1000 : null;
      }
      await store.putLicence(licence);
      return dead ? "downgraded to free" : "subscription in step";
    }

    return "ignored: " + type;
  }

  async function findBySubscription(subId) {
    if (!subId) return null;
    const raw = store._raw ? store._raw() : { licences: {} };
    const hit = Object.values(raw.licences || {}).find((l) => l.stripeSubscriptionId === subId);
    return hit ? hit.id : null;
  }

  return app;
}

function cleanId(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s || s.length > 80) return null;
  return /^[A-Za-z0-9._:-]+$/.test(s) ? s : null;
}

/* The public address of this service as the caller sees it, which matters
   behind a tunnel or a proxy. */
function selfBase(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const proto = req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http");
  return proto + "://" + host;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function demoCheckoutPage(plan, deviceId, publicBase) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Test checkout: ${esc(plan.name)}</title>
<style>
  :root{--ink:#12100d;--paper:#f4f0e7;--accent:#e8a33d;--mute:#9a917f;--line:rgba(244,240,231,.16)}
  body{margin:0;background:var(--ink);color:var(--paper);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
       display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .card{max-width:400px;width:100%;border:1px solid var(--line);border-radius:16px;padding:26px}
  .flag{display:inline-block;font:600 10px/1 ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;
        color:#1a1408;background:var(--accent);padding:5px 9px;border-radius:5px;margin-bottom:16px}
  h1{font-size:15px;margin:0 0 4px;font-weight:600}
  .price{font-family:Georgia,serif;font-size:34px;letter-spacing:-.03em;margin:10px 0 4px}
  .per{color:var(--mute);font-size:13px}
  p{color:var(--mute);font-size:13px;line-height:1.6}
  button{width:100%;margin-top:18px;padding:15px;border:0;border-radius:11px;background:var(--accent);
         color:#1a1408;font:600 15px/1 inherit;cursor:pointer}
  button:active{transform:scale(.99)}
  .fine{font-size:11.5px;color:var(--mute);margin-top:14px;border-top:1px solid var(--line);padding-top:14px}
  code{font-family:ui-monospace,monospace;font-size:11.5px;color:var(--paper);word-break:break-all}
</style></head>
<body><div class="card">
  <div class="flag">Test mode, no card charged</div>
  <h1>${esc(plan.name)}</h1>
  <div class="price">${esc(plan.priceLabel)}</div>
  <div class="per">${plan.mode === "payment" ? "One payment, then it lapses on its own." : "Billed until you cancel."}</div>
  <p>This is the built in test checkout. It exists so the whole purchase loop can be walked
     through before a Stripe account is connected. Nothing is charged, and the plan it grants
     is real on this device.</p>
  <form method="POST" action="/demo/complete">
    <input type="hidden" name="deviceId" value="${esc(deviceId)}">
    <input type="hidden" name="planId" value="${esc(plan.id)}">
    <button type="submit">Complete test purchase</button>
  </form>
  <div class="fine">
    The moment you set <code>STRIPE_SECRET_KEY</code> on this service, this page stops
    existing and real Checkout takes over. Device <code>${esc(deviceId)}</code>.
  </div>
</div></body></html>`;
}
