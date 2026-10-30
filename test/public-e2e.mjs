/* The whole loop across the public internet:
   the DEPLOYED app on GitHub Pages, buying through the LIVE service.

   Usage: node test/public-e2e.mjs https://your-tunnel.trycloudflare.com
*/

import puppeteer from "puppeteer-core";

const SERVICE = process.argv[2];
const APP = "https://kosigbesan.github.io/readback/";
if (!SERVICE) { console.error("pass the service url"); process.exit(2); }

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("PASS  " + label); }
  else { fail++; console.log("FAIL  " + label + (detail ? "  :: " + detail : "")); }
}

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"]
});
const page = await browser.newPage();
await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 });

console.log("app     " + APP);
console.log("service " + SERVICE + "\n");

/* ---------- is the service publicly reachable ---------- */
const health = await (await fetch(SERVICE + "/api/health")).json();
ok("the service answers over the public internet", health.ok === true, JSON.stringify(health));
ok("it is in test checkout mode", health.demoCheckout === true, String(health.demoCheckout));

/* ---------- the live app ---------- */
await page.goto(APP, { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForFunction("window.__rb && window.__rb.refreshLicence", { timeout: 30000 });
ok("the deployed app boots", true, APP);

const before = await page.evaluate(async (base) => {
  window.__rb.setMode("sell");
  window.__rb.state.settings.apiBase = base;
  localStorage.setItem("rb_settings", JSON.stringify(window.__rb.state.settings));
  await window.__rb.refreshLicence();
  return {
    source: window.__rb.state.licenceSource,
    plan: window.__rb.state.L ? window.__rb.state.L.plan : null,
    pill: document.querySelector("#planPill").textContent,
    device: window.__rb.deviceId()
  };
}, SERVICE);
ok("the live app reached the live service", before.source === "server", before.source);
ok("and reads Free to start", before.plan === "free", String(before.plan));
ok("with the pill agreeing", before.pill === "Free", before.pill);
console.log("      device id: " + before.device + "\n");

/* ---------- buy, on the real site, through the real service ---------- */
await page.evaluate(() => window.__rb.purchase("sprint"));
await page.waitForFunction("!!document.querySelector('form[action=\"/demo/complete\"]')", { timeout: 30000 });
ok("the app redirected to the checkout page", /demo\/checkout/.test(page.url()), page.url());

const checkout = await page.evaluate(() => ({
  title: document.title,
  flag: (document.querySelector(".flag") || {}).textContent || "",
  price: (document.querySelector(".price") || {}).textContent || "",
  plan: (document.querySelector("h1") || {}).textContent || ""
}));
ok("the checkout names the plan", /Interview Sprint/.test(checkout.plan), checkout.plan);
ok("and shows the price", /\$19/.test(checkout.price), checkout.price);
ok("and is honest that it charges nothing", /no card charged/i.test(checkout.flag), checkout.flag);

// capture where the service sends the buyer, rather than reading the address
// bar later, because the app tidies the query string off once it has handled it
let redirectTo = null;
page.on("response", (res) => {
  if (res.url().includes("/demo/complete")) {
    const h = res.headers();
    if (h.location) redirectTo = h.location;
  }
});

await Promise.all([
  page.waitForNavigation({ waitUntil: "networkidle2", timeout: 45000 }),
  page.click("form[action='/demo/complete'] button")
]);
ok("paying sent the buyer back to the app", /kosigbesan\.github\.io\/readback/.test(page.url()), page.url());
ok("with the paid flag on the redirect", /paid=1/.test(redirectTo || ""), String(redirectTo));

await page.waitForFunction("window.__rb && window.__rb.state", { timeout: 30000 });
await new Promise((r) => setTimeout(r, 2500));

const after = await page.evaluate(() => ({
  pro: window.__rb.state.pro,
  plan: window.__rb.state.L ? window.__rb.state.L.plan : null,
  planName: window.__rb.state.L ? window.__rb.state.L.planName : null,
  chars: window.__rb.state.L ? window.__rb.state.L.voiceCharsPerMonth : null,
  pill: document.querySelector("#planPill").textContent
}));
ok("the app came back on the paid plan", after.pro === true, JSON.stringify(after));
ok("the plan is the sprint pass", after.plan === "sprint", String(after.plan));
ok("with the voice allowance", after.chars === 60000, String(after.chars));
ok("and the pill updated on its own", after.pill === "Sprint", after.pill);

/* ---------- and the server agrees ---------- */
const lic = await (await fetch(SERVICE + "/api/licence", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ deviceId: before.device })
})).json();
ok("the service has the same view of the device", lic.licence.plan === "sprint", JSON.stringify(lic.licence));

await page.screenshot({ path: "test/shots/public-paid.png" });
await browser.close();

console.log("\n=========================================");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
console.log("PAID END TO END ACROSS THE PUBLIC INTERNET");
