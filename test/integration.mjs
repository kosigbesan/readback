/* Integration: the real app in a real browser against the real API server.

   This is what proves the two halves actually talk: licence handshake, the
   offline fallback, the premium voice going through the proxy, metering, and
   a genuine Stripe Checkout redirect.

   Run: node test/integration.mjs
*/

import puppeteer from "puppeteer-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// stripe is installed under server/, so resolve it from there
const serverRequire = createRequire(path.join(__dirname, "..", "server", "package.json"));
const Stripe = serverRequire("stripe");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("PASS  " + label); }
  else { fail++; failures.push(label + (detail ? " :: " + detail : "")); console.log("FAIL  " + label + (detail ? "  :: " + detail : "")); }
}
const eq = (l, a, e) => ok(l, a === e, "got " + JSON.stringify(a) + ", wanted " + JSON.stringify(e));

/* ---------------- static server for the app ---------------- */
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".ico": "image/x-icon", ".pdf": "application/pdf",
  ".txt": "text/plain", ".css": "text/css", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
};
const staticServer = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end("not found");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => staticServer.listen(0, "127.0.0.1", r));
const APP = "http://127.0.0.1:" + staticServer.address().port + "/";

/* ---------------- mocked voice upstream ---------------- */
const MOCK_AUDIO = Buffer.from("ID3\x03\x00\x00\x00fake-mp3-for-integration");
let upstreamHits = 0;
const upstream = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => {
    upstreamHits++;
    res.writeHead(200, { "Content-Type": "audio/mpeg" });
    res.end(MOCK_AUDIO);
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));

async function loadServer() {
  const { createApp } = await import("../server/index.js");
  const { memoryStore } = await import("../server/lib/store.js");
  const realStripe = new Stripe("sk_test_not_real", { apiVersion: "2024-12-18.acacia" });
  const captured = { checkout: null };
  return {
    captured,
    realStripe,
    store: memoryStore(),
    createApp,
    stripeStub: {
      webhooks: realStripe.webhooks,
      checkout: { sessions: { create: async (params) => {
        captured.checkout = params;
        return { id: "cs_test_int", url: "https://checkout.stripe.com/c/pay/cs_test_int" };
      } } }
    }
  };
}

const WEBHOOK_SECRET = "whsec_integration_secret";
const { createApp, store, stripeStub, realStripe, captured } = await loadServer();

const api = createApp({
  store, stripe: stripeStub,
  cfg: {
    publicBase: "https://kosigbesan.github.io/readback",
    webhookSecret: WEBHOOK_SECRET,
    elevenKey: "integration-key",
    elevenBase: "http://127.0.0.1:" + upstream.address().port,
    prices: { pro: "price_pro_int", sprint: "price_sprint_int", proyearly: "price_year_int" }
  }
});
const apiSrv = api.listen(0, "127.0.0.1");
await new Promise((r) => apiSrv.once("listening", r));
const API = "http://127.0.0.1:" + apiSrv.address().port;

// a second API with no Stripe, to prove the app says so instead of pretending
const noStripeApi = createApp({
  store, stripe: null,
  cfg: { webhookSecret: WEBHOOK_SECRET, elevenKey: "k", elevenBase: "http://127.0.0.1:" + upstream.address().port }
});
const noStripeSrv = noStripeApi.listen(0, "127.0.0.1");
await new Promise((r) => noStripeSrv.once("listening", r));
const API_NO_STRIPE = "http://127.0.0.1:" + noStripeSrv.address().port;

/* ---------------- helpers ---------------- */
async function webhook(type, object) {
  const event = { id: "evt_int_" + Math.random().toString(36).slice(2), type, data: { object } };
  const payload = JSON.stringify(event);
  const header = realStripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const r = await fetch(API + "/api/stripe/webhook", {
    method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": header }, body: payload
  });
  return r.status;
}
async function serverUsage(deviceId) {
  const r = await fetch(API + "/api/usage", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId })
  });
  return (await r.json()).usage;
}

/* ---------------- browser ---------------- */
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"]
});
const page = await browser.newPage();
await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 });

const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

/* This test deliberately provokes failures: a 402 for the unpaid voice, a 503
   from a server with no Stripe, and an unreachable host. Those show up as
   console noise and must not be counted as app errors. */
const DELIBERATE = [/402 \(Payment Required\)/, /503 \(Service Unavailable\)/, /ERR_CONNECTION_REFUSED/, /ERR_UNSAFE_PORT/];

await page.goto(APP, { waitUntil: "networkidle2", timeout: 45000 });
await page.waitForFunction("window.__rb && window.__rb.refreshLicence", { timeout: 20000 });

console.log("\n--- phase 1: the app with no service connected ---");
{
  // this half of the test is about selling, so say so explicitly
  await page.evaluate(() => window.__rb.setMode("sell"));
  const st = await page.evaluate(() => ({
    source: window.__rb.state.licenceSource,
    pro: window.__rb.state.pro,
    pill: document.querySelector("#planPill").textContent
  }));
  eq("starts disconnected", st.source, "local");
  eq("starts on the free plan", st.pro, false);
  eq("pill says Free", st.pill, "Free");

  // buying with no service unlocks locally and says so
  await page.evaluate(() => { document.querySelector("#planPill").click(); });
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(() => {
    const b = document.querySelector("#planList button[data-plan='pro']");
    b.click();
  });
  await new Promise((r) => setTimeout(r, 600));
  const after = await page.evaluate(() => ({
    pro: window.__rb.state.pro,
    toast: document.querySelector("#toast").textContent,
    url: location.href
  }));
  eq("local purchase flips the plan", after.pro, true);
  ok("and says it is device only", /device only/i.test(after.toast), after.toast);
  ok("and does not navigate away", !/checkout\.stripe\.com/.test(after.url), after.url);
}

console.log("\n--- phase 2: connecting the app to the service ---");
await page.evaluate(() => { localStorage.clear(); });
await page.goto(APP, { waitUntil: "networkidle2" });
await page.waitForFunction("window.__rb && window.__rb.refreshLicence", { timeout: 20000 });

const deviceId = await page.evaluate((base) => {
  window.__rb.setMode("sell");
  window.__rb.state.settings.apiBase = base;
  localStorage.setItem("rb_settings", JSON.stringify(window.__rb.state.settings));
  return window.__rb.deviceId();
}, API);
ok("the app has a stable device id", /^dev_/.test(deviceId), deviceId);

const lic = await page.evaluate(async () => {
  await window.__rb.refreshLicence();
  return {
    source: window.__rb.state.licenceSource,
    pro: window.__rb.state.pro,
    plan: window.__rb.state.L ? window.__rb.state.L.plan : null,
    planName: window.__rb.state.L ? window.__rb.state.L.planName : null,
    pill: document.querySelector("#planPill").textContent
  };
});
eq("licence now comes from the service", lic.source, "server");
eq("the service says free", lic.plan, "free");
eq("the app believes the service", lic.pro, false);
eq("pill still Free", lic.pill, "Free");

console.log("\n--- the free plan cannot use the paid voice ---");
{
  const before = upstreamHits;
  const r = await page.evaluate(async () => {
    try {
      const b = await window.__rb.fetchVoice("This should be refused.");
      return { ok: true, size: b.size };
    } catch (e) { return { ok: false, status: e.status, message: e.message }; }
  });
  eq("premium voice refused", r.ok, false);
  eq("with a 402", r.status, 402);
  ok("and a readable reason", /paid plan/i.test(r.message || ""), r.message);
  eq("nothing was sent to the voice provider", upstreamHits, before);
}

console.log("\n--- a real webhook upgrades the device ---");
{
  const status = await webhook("checkout.session.completed", {
    metadata: { deviceId, planId: "sprint" },
    customer: "cus_int_1",
    customer_details: { email: "driver@example.com" }
  });
  eq("webhook accepted by the server", status, 200);

  const lic2 = await page.evaluate(async () => {
    await window.__rb.refreshLicence();
    return {
      pro: window.__rb.state.pro,
      plan: window.__rb.state.L.plan,
      chars: window.__rb.state.L.voiceCharsPerMonth,
      pill: document.querySelector("#planPill").textContent,
      svc: document.querySelector("#svcNote") ? document.querySelector("#svcNote").textContent : ""
    };
  });
  eq("the app picks up the paid plan", lic2.pro, true);
  eq("plan is the sprint pass", lic2.plan, "sprint");
  eq("premium allowance arrives", lic2.chars, 60000);
  eq("pill changed to Sprint", lic2.pill, "Sprint");
  ok("settings explain the connected state", /Connected/i.test(lic2.svc), lic2.svc);
}

console.log("\n--- the premium voice now goes through the proxy ---");
{
  const text = "Tell me about a time you shipped something that failed.";
  const before = upstreamHits;
  const r = await page.evaluate(async (t) => {
    const b = await window.__rb.fetchVoice(t);
    const buf = new Uint8Array(await b.arrayBuffer());
    return { size: b.size, type: b.type, first: Array.from(buf.slice(0, 3)), left: window.__rb.state.voiceCharsLeft };
  }, text);
  ok("the app received audio", r.size > 0, JSON.stringify(r));
  eq("it is mp3", r.type, "audio/mpeg");
  eq("and it is the upstream bytes", r.first.join(","), "73,68,51");
  eq("the voice provider was called once", upstreamHits - before, 1);
  eq("the remaining allowance reached the app", r.left, 60000 - text.length);

  const usage = await serverUsage(deviceId);
  eq("the server metered exactly the characters", usage.chars, text.length);
  eq("and counted the request", usage.requests, 1);
}

console.log("\n--- offline grace: no signal in the car ---");
{
  const r = await page.evaluate(async () => {
    // point the app at a port with nothing listening
    window.__rb.state.settings.apiBase = "http://127.0.0.1:45999";
    await window.__rb.refreshLicence();
    return {
      source: window.__rb.state.licenceSource,
      pro: window.__rb.state.pro,
      plan: window.__rb.state.L ? window.__rb.state.L.plan : null,
      pill: document.querySelector("#planPill").textContent
    };
  });
  eq("falls back to the cached licence", r.source, "cached");
  eq("and stays on the paid plan", r.pro, true);
  eq("with the right plan remembered", r.plan, "sprint");
  eq("pill stays Sprint", r.pill, "Sprint");

  // restore
  await page.evaluate((base) => {
    window.__rb.state.settings.apiBase = base;
    localStorage.setItem("rb_settings", JSON.stringify(window.__rb.state.settings));
    return window.__rb.refreshLicence();
  }, API);
}

console.log("\n--- checkout: a real redirect, and an honest failure ---");
{
  // with no Stripe on the server, the app must not pretend
  const j = await page.evaluate(async (base) => {
    await new Promise((r) => {
      window.__rb.state.settings.apiBase = base;
      localStorage.setItem("rb_settings", JSON.stringify(window.__rb.state.settings));
      setTimeout(r, 50);
    });
    await window.__rb.purchase("pro");
    return { toast: document.querySelector("#toast").textContent, url: location.href };
  }, API_NO_STRIPE);
  ok("no-stripe server surfaces an error", /not configured|Payments/i.test(j.toast), j.toast);
  ok("and the app stays put", !/checkout\.stripe\.com/.test(j.url), j.url);
  eq("no checkout session was fabricated", captured.checkout, null);

  // with Stripe, the app should hand off to Checkout
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (req.url().includes("checkout.stripe.com")) {
      return req.respond({ status: 200, contentType: "text/html", body: "<html><body>stub checkout</body></html>" });
    }
    req.continue();
  });
  await page.evaluate(async (base) => {
    window.__rb.setMode("sell");
    window.__rb.state.settings.apiBase = base;
    localStorage.setItem("rb_settings", JSON.stringify(window.__rb.state.settings));
    await window.__rb.purchase("pro");
  }, API);
  await new Promise((r) => setTimeout(r, 1200));
  ok("the app redirected to Stripe Checkout", /checkout\.stripe\.com/.test(page.url()), page.url());
  ok("the checkout session carried the device", captured.checkout && captured.checkout.client_reference_id === deviceId,
     captured.checkout ? captured.checkout.client_reference_id : "no session");
  eq("and the right plan", captured.checkout ? captured.checkout.metadata.planId : null, "pro");
  eq("at the configured price", captured.checkout ? captured.checkout.line_items[0].price : null, "price_pro_int");
}

console.log("\n--- no errors anywhere in the app ---");
ok("no uncaught exceptions", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
const unexpected = consoleErrors.filter((e) => !DELIBERATE.some((re) => re.test(e)));
ok("no unexpected console errors", unexpected.length === 0, unexpected.slice(0, 3).join(" | "));
console.log("      (suppressed " + (consoleErrors.length - unexpected.length) + " errors provoked on purpose by this test)");

await browser.close();
apiSrv.close(); noStripeSrv.close(); staticServer.close();
await new Promise((r) => upstream.close(r));

console.log("\n=========================================");
console.log(pass + " passed, " + fail + " failed");
if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
console.log("APP AND SERVICE VERIFIED TOGETHER");
