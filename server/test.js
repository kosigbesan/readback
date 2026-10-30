/* Tests for the ReadBack API. No network, no real Stripe, no real voice spend.

   Stripe signatures are verified with the real SDK crypto, using a webhook
   secret we choose here. The voice upstream is a local mock. Everything else
   is the real server code.

   Run: npm test
*/

import http from "node:http";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { createApp } from "./index.js";
import { memoryStore } from "./lib/store.js";
import { PLANS } from "./lib/plans.js";

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("PASS  " + label); }
  else { fail++; failures.push(label + (detail ? " :: " + detail : "")); console.log("FAIL  " + label + (detail ? "  :: " + detail : "")); }
}
function eq(label, actual, expected) {
  ok(label, actual === expected, "got " + JSON.stringify(actual) + ", wanted " + JSON.stringify(expected));
}

/* ---------------- mock voice upstream ---------------- */
const MOCK_AUDIO = Buffer.from("ID3\x03\x00\x00\x00fake-mp3-bytes-for-tests");
const upstreamCalls = [];
const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    upstreamCalls.push({ url: req.url, key: req.headers["xi-api-key"], body });
    if (req.headers["xi-api-key"] === "bad-key") {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ detail: { message: "invalid api key" } }));
    }
    res.writeHead(200, { "Content-Type": "audio/mpeg" });
    res.end(MOCK_AUDIO);
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamPort = upstream.address().port;

/* ---------------- stripe stub (real crypto, no network) ---------------- */
const realStripe = new Stripe("sk_test_not_a_real_key", { apiVersion: "2024-12-18.acacia" });
const WEBHOOK_SECRET = "whsec_test_secret_for_readback";
let capturedCheckout = null;
const stripeStub = {
  webhooks: realStripe.webhooks,
  checkout: {
    sessions: {
      create: async (params) => {
        capturedCheckout = params;
        return { id: "cs_test_readback", url: "https://checkout.stripe.com/c/pay/cs_test_readback" };
      }
    }
  }
};

/* ---------------- boot the app under test ---------------- */
const store = memoryStore();
const app = createApp({
  store,
  stripe: stripeStub,
  cfg: {
    publicBase: "https://kosigbesan.github.io/readback",
    webhookSecret: WEBHOOK_SECRET,
    elevenKey: "test-eleven-key",
    elevenBase: "http://127.0.0.1:" + upstreamPort,
    adminToken: "admin-secret",
    ttsPerMinute: 40,
    prices: { sprint: "price_sprint_test", pro: "price_pro_monthly_test", proyearly: "price_pro_yearly_test" }
  }
});
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const BASE = "http://127.0.0.1:" + server.address().port;

/* a second instance with no Stripe, to prove the failure is explained */
const noStripeApp = createApp({ store, stripe: null, cfg: { webhookSecret: WEBHOOK_SECRET, elevenKey: "k" } });
const noStripeServer = noStripeApp.listen(0, "127.0.0.1");
await new Promise((r) => noStripeServer.once("listening", r));
const NO_STRIPE_BASE = "http://127.0.0.1:" + noStripeServer.address().port;

/* a third with a tight rate limit */
const limitedApp = createApp({
  store, stripe: stripeStub,
  cfg: { webhookSecret: WEBHOOK_SECRET, elevenKey: "k", elevenBase: "http://127.0.0.1:" + upstreamPort, ttsPerMinute: 3 }
});
const limitedServer = limitedApp.listen(0, "127.0.0.1");
await new Promise((r) => limitedServer.once("listening", r));
const LIMITED_BASE = "http://127.0.0.1:" + limitedServer.address().port;

async function api(path, { body, headers, raw, method } = {}, base) {
  const res = await fetch((base || BASE) + path, {
    method: method || (body || raw ? "POST" : "GET"),
    headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
    body: raw != null ? raw : body != null ? JSON.stringify(body) : undefined
  });
  const ct = res.headers.get("content-type") || "";
  const payload = ct.includes("application/json") ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body: payload };
}

function stripeEvent(type, object, id) {
  return { id: id || "evt_" + Math.random().toString(36).slice(2), type, data: { object } };
}
async function sendWebhook(event, secret, base) {
  const payload = JSON.stringify(event);
  const header = realStripe.webhooks.generateTestHeaderString({ payload, secret: secret || WEBHOOK_SECRET });
  return api("/api/stripe/webhook", { raw: payload, headers: { "stripe-signature": header }, base });
}

console.log("\n--- health and catalogue ---");
{
  const h = await api("/api/health");
  eq("health returns 200", h.status, 200);
  eq("health reports the store", h.body.store, "memory");
  eq("health reports stripe wired", h.body.stripe, true);
  eq("health reports webhooks wired", h.body.webhooks, true);
  eq("health reports voice wired", h.body.voice, true);
  ok("health never leaks the voice key", JSON.stringify(h.body).indexOf("test-eleven-key") === -1);

  const p = await api("/api/plans");
  eq("plans endpoint lists four plans", p.body.plans.length, 4);
  const free = p.body.plans.find((x) => x.id === "free");
  eq("free is not buyable", free.buyable, false);
  const sprint = p.body.plans.find((x) => x.id === "sprint");
  eq("sprint is buyable", sprint.buyable, true);
  eq("sprint voice allowance", sprint.voiceCharsPerMonth, 60000);
  eq("sprint is not a subscription", sprint.mode, "payment");
}

console.log("\n--- licence for a new device ---");
{
  const r = await api("/api/licence", { body: { deviceId: "device-A" } });
  eq("licence returns 200", r.status, 200);
  eq("new device starts on free", r.body.licence.plan, "free");
  eq("free has no premium voice", r.body.licence.premiumVoice, false);
  eq("free voice allowance is zero", r.body.licence.voiceCharsPerMonth, 0);
  eq("free document limit", r.body.licence.docs, 1);

  const bad = await api("/api/licence", { body: { deviceId: "has spaces/slashes" } });
  eq("rejects a malformed device id", bad.status, 400);
  const missing = await api("/api/licence", { body: {} });
  eq("rejects a missing device id", missing.status, 400);
}

console.log("\n--- the free plan cannot use the paid voice ---");
{
  const t = await api("/api/tts", { body: { deviceId: "device-A", text: "Hello there.", voiceId: "v1" } });
  eq("free device gets 402", t.status, 402);
  eq("and is told why", t.body.code, "plan_required");
  eq("no upstream call was made", upstreamCalls.length, 0);
}

console.log("\n--- checkout ---");
{
  const noStripe = await api("/api/checkout", { body: { deviceId: "device-A", planId: "sprint" } }, NO_STRIPE_BASE);
  eq("checkout without Stripe explains itself", noStripe.status, 503);
  eq("and names the code", noStripe.body.code, "no_stripe");

  const r = await api("/api/checkout", { body: { deviceId: "device-A", planId: "sprint", email: "a@example.com" } });
  eq("checkout returns a url", r.status, 200);
  ok("the url points at Stripe checkout", /checkout\.stripe\.com/.test(r.body.url), r.body.url);
  eq("sprint is a one off payment", capturedCheckout.mode, "payment");
  eq("device is carried on the session", capturedCheckout.client_reference_id, "device-A");
  eq("device is in metadata", capturedCheckout.metadata.deviceId, "device-A");
  eq("plan is in metadata", capturedCheckout.metadata.planId, "sprint");
  eq("the configured price is used", capturedCheckout.line_items[0].price, "price_sprint_test");
  ok("no subscription_data for a one off", capturedCheckout.subscription_data === undefined);

  const sub = await api("/api/checkout", { body: { deviceId: "device-A", planId: "pro" } });
  eq("pro checkout succeeds", sub.status, 200);
  eq("pro is a subscription", capturedCheckout.mode, "subscription");
  eq("subscription carries the device in metadata", capturedCheckout.subscription_data.metadata.deviceId, "device-A");

  const freeBuy = await api("/api/checkout", { body: { deviceId: "device-A", planId: "free" } });
  eq("you cannot buy the free plan", freeBuy.status, 400);
  const unknown = await api("/api/checkout", { body: { deviceId: "device-A", planId: "nonsense" } });
  eq("unknown plan rejected", unknown.status, 400);
}

console.log("\n--- webhook security ---");
{
  const noSig = await api("/api/stripe/webhook", { raw: "{}" });
  eq("unsigned webhook rejected", noSig.status, 400);

  const event = stripeEvent("checkout.session.completed", { metadata: { deviceId: "device-A", planId: "sprint" } });
  const wrongSig = await sendWebhook(event, "whsec_the_wrong_secret");
  eq("wrongly signed webhook rejected", wrongSig.status, 400);
  ok("and says it was the signature", /Signature verification failed/.test(wrongSig.body.error), wrongSig.body.error);

  const tampered = await (async () => {
    const payload = JSON.stringify(event);
    const header = realStripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    const bodyWise = JSON.stringify({ ...event, type: "customer.subscription.deleted" });
    return api("/api/stripe/webhook", { raw: bodyWise, headers: { "stripe-signature": header } });
  })();
  eq("a tampered payload is rejected", tampered.status, 400);
}

console.log("\n--- the sprint pass activates and expires on its own ---");
{
  const event = stripeEvent("checkout.session.completed", {
    metadata: { deviceId: "device-B", planId: "sprint" },
    customer: "cus_test_1",
    customer_details: { email: "b@example.com" }
  });
  const r = await sendWebhook(event);
  eq("webhook accepted", r.status, 200);
  eq("licence activated", r.body.outcome, "activated sprint");

  const lic = await api("/api/licence", { body: { deviceId: "device-B" } });
  eq("device B is on sprint", lic.body.licence.plan, "sprint");
  eq("sprint unlocks the premium voice", lic.body.licence.premiumVoice, true);
  eq("sprint voice allowance", lic.body.licence.voiceCharsPerMonth, 60000);
  ok("sprint has an expiry about 30 days out", (() => {
    const days = (lic.body.licence.expiresAt - Date.now()) / 864e5;
    return days > 29 && days < 31;
  })(), String(lic.body.licence.expiresAt));

  const again = await sendWebhook(event);
  eq("the same event is not applied twice", again.body.duplicate, true);

  // simulate the pass running out
  const raw = store._raw();
  raw.licences["device-B"].expiresAt = Date.now() - 1000;
  const expired = await api("/api/licence", { body: { deviceId: "device-B" } });
  eq("an expired sprint falls back to free", expired.body.licence.plan, "free");
  eq("and loses the premium voice", expired.body.licence.premiumVoice, false);

  // back on for the next block
  raw.licences["device-B"].expiresAt = Date.now() + 10 * 864e5;
}

console.log("\n--- subscription lifecycle ---");
{
  await api("/api/checkout", { body: { deviceId: "device-C", planId: "pro" } });
  const completed = stripeEvent("checkout.session.completed", {
    metadata: { deviceId: "device-C", planId: "pro" },
    customer: "cus_test_2",
    subscription: "sub_test_2"
  });
  await sendWebhook(completed);
  let lic = await api("/api/licence", { body: { deviceId: "device-C" } });
  eq("subscription activated", lic.body.licence.plan, "pro");
  eq("subscription has no expiry", lic.body.licence.expiresAt, null);

  const cancelPending = stripeEvent("customer.subscription.updated", {
    id: "sub_test_2", status: "active", cancel_at_period_end: true,
    metadata: { deviceId: "device-C", planId: "pro" },
    current_period_end: Math.floor(Date.now() / 1000) + 86400
  });
  await sendWebhook(cancelPending);
  lic = await api("/api/licence", { body: { deviceId: "device-C" } });
  eq("still pro until the period ends", lic.body.licence.plan, "pro");
  eq("but flagged as cancelling", lic.body.licence.cancelAtPeriodEnd, true);

  const deleted = stripeEvent("customer.subscription.deleted", {
    id: "sub_test_2", status: "canceled", metadata: { deviceId: "device-C", planId: "pro" }
  });
  const d = await sendWebhook(deleted);
  eq("deletion downgrades", d.body.outcome, "downgraded to free");
  lic = await api("/api/licence", { body: { deviceId: "device-C" } });
  eq("device C is back on free", lic.body.licence.plan, "free");

  // a subscription event with no device in metadata should still find the licence
  const anonymous = stripeEvent("customer.subscription.deleted", { id: "sub_test_2", status: "canceled", metadata: {} });
  const a = await sendWebhook(anonymous);
  ok("falls back to looking the subscription up", /downgraded to free/.test(a.body.outcome), a.body.outcome);
}

console.log("\n--- the voice proxy meters and bills correctly ---");
{
  const before = upstreamCalls.length;
  const r = await api("/api/tts", {
    body: { deviceId: "device-B", text: "Tell me about a time you failed.", voiceId: "voice-abc" }
  });
  eq("paid device gets audio", r.status, 200);
  eq("content type is audio", r.headers.get("content-type"), "audio/mpeg");
  ok("the audio bytes came from upstream", Buffer.compare(r.body, MOCK_AUDIO) === 0, "length " + r.body.length);
  eq("the server passed its own key upstream", upstreamCalls[before].key, "test-eleven-key");
  ok("the voice id reached upstream", /voice-abc/.test(upstreamCalls[before].url), upstreamCalls[before].url);
  ok("upstream was asked for json", /"text":"Tell me about a time you failed."/.test(upstreamCalls[before].body), upstreamCalls[before].body.slice(0, 80));

  const billed = Number(r.headers.get("x-voice-chars-billed"));
  eq("billed the character count", billed, "Tell me about a time you failed.".length);
  const left = Number(r.headers.get("x-voice-chars-left"));
  eq("reports the remaining allowance", left, 60000 - billed);

  const u = await api("/api/usage", { body: { deviceId: "device-B" } });
  eq("usage is recorded", u.body.usage.chars, billed);
  eq("usage counts requests", u.body.usage.requests, 1);

  // empty text is not billed
  const empty = await api("/api/tts", { body: { deviceId: "device-B", text: "   " } });
  eq("empty text rejected", empty.status, 400);

  // too long in one piece
  const long = await api("/api/tts", { body: { deviceId: "device-B", text: "x".repeat(2000) } });
  eq("oversized request rejected", long.status, 413);

  // exhaust the allowance and prove it stops
  const raw = store._raw();
  raw.usage["device-B"]["2026-10"] && (raw.usage["device-B"]["2026-10"].chars = 0);
  const period = new Date().toISOString().slice(0, 7);
  raw.usage["device-B"] = raw.usage["device-B"] || {};
  raw.usage["device-B"][period] = { chars: 60000, requests: 99 };
  const spent = await api("/api/tts", { body: { deviceId: "device-B", text: "One more sentence." } });
  eq("an exhausted allowance stops the request", spent.status, 402);
  eq("and says which limit", spent.body.code, "allowance_exhausted");
  eq("and reports the limit", spent.body.limit, 60000);
  raw.usage["device-B"][period] = { chars: 100, requests: 2 };

  // an upstream failure is not billed
  const brokenKeyApp = createApp({
    store, stripe: stripeStub,
    cfg: { webhookSecret: WEBHOOK_SECRET, elevenKey: "bad-key", elevenBase: "http://127.0.0.1:" + upstreamPort }
  });
  const bs = brokenKeyApp.listen(0, "127.0.0.1");
  await new Promise((r) => bs.once("listening", r));
  const bBase = "http://127.0.0.1:" + bs.address().port;
  const charsBefore = (await api("/api/usage", { body: { deviceId: "device-B" } })).body.usage.chars;
  const rejected = await api("/api/tts", { body: { deviceId: "device-B", text: "This one fails upstream." } }, bBase);
  eq("upstream rejection becomes a 502", rejected.status, 502);
  const charsAfter = (await api("/api/usage", { body: { deviceId: "device-B" } })).body.usage.chars;
  eq("a failed render is not billed", charsAfter, charsBefore);
  bs.close();
}

console.log("\n--- rate limit ---");
{
  const lic = await api("/api/licence", { body: { deviceId: "device-D" } }, LIMITED_BASE);
  eq("limited instance is reachable", lic.status, 200);
  const raw = store._raw();
  raw.licences["device-D"].plan = "sprint";
  raw.licences["device-D"].expiresAt = Date.now() + 864e5;
  const codes = [];
  for (let i = 0; i < 5; i++) {
    const r = await api("/api/tts", { body: { deviceId: "device-D", text: "Sentence " + i + "." } }, LIMITED_BASE);
    codes.push(r.status);
  }
  eq("first three are allowed", codes.slice(0, 3).join(","), "200,200,200");
  eq("the fourth is rate limited", codes[3], 429);
  ok("the whole run is 200,200,200,429,429", codes.join(",") === "200,200,200,429,429", codes.join(","));
}

console.log("\n--- admin summary is guarded ---");
{
  // the instance with no admin token configured should not expose the route
  const open = await api("/api/admin/summary", {}, NO_STRIPE_BASE);
  eq("no token configured means no route", open.status, 404);
  const appWithAdmin = createApp({ store, stripe: stripeStub, cfg: { adminToken: "admin-secret" } });
  const as = appWithAdmin.listen(0, "127.0.0.1");
  await new Promise((r) => as.once("listening", r));
  const aBase = "http://127.0.0.1:" + as.address().port;
  const wrong = await api("/api/admin/summary", { headers: { Authorization: "Bearer nope" } }, aBase);
  eq("wrong token is refused", wrong.status, 403);
  const right = await api("/api/admin/summary", { headers: { Authorization: "Bearer admin-secret" } }, aBase);
  eq("right token is allowed", right.status, 200);
  ok("summary counts devices", right.body.devices >= 4, JSON.stringify(right.body));
  ok("summary counts plans", typeof right.body.byPlan.pro === "number", JSON.stringify(right.body.byPlan));
  as.close();
}

console.log("\n--- cross origin, for the Pages app ---");
{
  const r = await api("/api/health", { headers: { Origin: "https://kosigbesan.github.io" } });
  eq("allows the app origin", r.headers.get("access-control-allow-origin"), "https://kosigbesan.github.io");
  const exposed = r.headers.get("access-control-expose-headers");
  ok("exposes the metering headers to the app", /X-Voice-Chars-Left/.test(exposed || ""), String(exposed));
  const pre = await fetch(BASE + "/api/tts", { method: "OPTIONS", headers: { Origin: "https://kosigbesan.github.io" } });
  eq("preflight is answered", pre.status, 204);
}

/* ---------------- done ---------------- */
server.close(); noStripeServer.close(); limitedServer.close();
await new Promise((r) => upstream.close(r));

console.log("\n=========================================");
console.log(pass + " passed, " + fail + " failed");
if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
console.log("API LAYER VERIFIED");
