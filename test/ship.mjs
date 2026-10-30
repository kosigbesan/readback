/* Ready to hand to a real person who is not technical.

   Checks the things that decide whether this survives contact with someone
   else's phone: is it installable, does it work with no signal, does a
   stranger see any paywall, and does the first document actually play.

   Run: node test/ship.mjs   (starts its own static server)
*/

import puppeteer from "puppeteer-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("PASS  " + label); }
  else { fail++; failures.push(label + (detail ? " :: " + detail : "")); console.log("FAIL  " + label + (detail ? "  :: " + detail : "")); }
}
const eq = (l, a, e) => ok(l, a === e, "got " + JSON.stringify(a) + ", wanted " + JSON.stringify(e));

/* ---------- static server ---------- */
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png",
  ".ico": "image/x-icon", ".pdf": "application/pdf", ".txt": "text/plain", ".css": "text/css" };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end("not found");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const APP = "http://127.0.0.1:" + srv.address().port + "/";

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"]
});

/* ================= 1. is it installable ================= */
console.log("--- can it be installed on a phone ---");
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await page.goto(APP, { waitUntil: "networkidle2", timeout: 45000 });
await page.waitForFunction("window.__rb && window.__rb.state", { timeout: 20000 });

const manifest = await page.evaluate(async () => {
  const r = await fetch("manifest.json");
  return { status: r.status, m: await r.json() };
});
eq("a manifest is served", manifest.status, 200);
eq("it names the app", manifest.m.name, "ReadBack: interview prep, out loud");
eq("with a short name for the home screen", manifest.m.short_name, "ReadBack");
eq("it launches on its own, without browser chrome", manifest.m.display, "standalone");
eq("it starts at the app root", manifest.m.start_url, "./");
ok("it declares the 192 icon", manifest.m.icons.some((i) => i.sizes === "192x192"), JSON.stringify(manifest.m.icons));
ok("it declares the 512 icon", manifest.m.icons.some((i) => i.sizes === "512x512"), JSON.stringify(manifest.m.icons));
ok("it declares a maskable icon, so Android does not crop it badly",
   manifest.m.icons.some((i) => i.purpose === "maskable"), JSON.stringify(manifest.m.icons));

const icons = await page.evaluate(async () => {
  const out = [];
  for (const src of ["icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png"]) {
    const r = await fetch(src);
    const bmp = await createImageBitmap(await r.blob());
    out.push({ src, status: r.status, w: bmp.width, h: bmp.height });
  }
  return out;
});
for (const i of icons) ok("the icon actually loads at its stated size: " + i.src, i.status === 200 && i.w === i.h && i.w >= 180,
  JSON.stringify(i));

const sw = await page.evaluate(async () => {
  if (!("serviceWorker" in navigator)) return { supported: false };
  const reg = await navigator.serviceWorker.ready;
  return { supported: true, scope: reg.scope, active: reg.active ? reg.active.state : null,
           controller: !!navigator.serviceWorker.controller };
});
ok("a service worker is registered and active", sw.supported && sw.active === "activated", JSON.stringify(sw));

/* ================= 2. what a stranger sees ================= */
console.log("\n--- what your sister sees on first open ---");
const first = await page.evaluate(() => {
  const screen = document.querySelector("#screenUpload");
  return {
    mode: window.__rb.state.settings.mode,
    pill: getComputedStyle(document.querySelector("#planPill")).display,
    meter: document.querySelector("#usageLine").textContent.trim(),
    screenText: screen.innerText,
    price: screen.innerText.match(/\$\d/g) || [],
    upgradeSheetOpen: document.querySelector("#sheetUpgrade").classList.contains("show")
  };
});
eq("it opens in personal mode", first.mode, "personal");
eq("no plan badge in the header", first.pill, "none");
eq("no listening meter", first.meter, "");
eq("no prices on the screen she lands on", first.price.length, 0, JSON.stringify(first.price));
ok("nothing on that screen asks for money",
   /upgrade|subscribe|free plan|per month/i.test(first.screenText) === false,
   first.screenText.slice(0, 140).replace(/\n/g, " | "));
eq("and no upgrade sheet is open", first.upgradeSheetOpen, false);

/* ================= 3. the first document actually plays ================= */
console.log("\n--- the first run, end to end ---");
await page.evaluate(() => document.querySelector("#fillSample").click());
await page.click("#pasteGo");
await page.waitForFunction("!document.querySelector('#screenReader').classList.contains('hidden')", { timeout: 15000 });
await page.click("#playBtn");
await new Promise((r) => setTimeout(r, 700));
const journey = await page.evaluate(() => ({
  sentences: window.__rb.state.doc ? window.__rb.state.doc.sentences.length : 0,
  questions: document.querySelectorAll("#textPane .qtag").length,
  playing: window.__rb.state.playing,
  highlighted: document.querySelectorAll("#textPane .s.on").length,
  media: navigator.mediaSession && navigator.mediaSession.metadata ? navigator.mediaSession.metadata.title : null
}));
ok("the sample becomes a document", journey.sentences > 15, JSON.stringify(journey));
ok("questions are recognised", journey.questions >= 4, String(journey.questions));
ok("pressing play starts it", journey.playing === true, String(journey.playing));
ok("and it highlights what is being read", journey.highlighted === 1, String(journey.highlighted));
ok("and it registers with the media session, for the car", journey.media !== null, String(journey.media));
await page.screenshot({ path: path.join(__dirname, "shots", "ship-first-run.png") });

/* ================= 4. it works with no signal ================= */
console.log("\n--- no signal, which is the whole point in a car ---");
await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? true : false;
});
// give the worker a moment to finish precaching the shell and the parsers
await new Promise((r) => setTimeout(r, 3500));
await page.setOfflineMode(true);
await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForFunction("window.__rb && window.__rb.state", { timeout: 25000 });
const offline = await page.evaluate(() => ({
  booted: !!window.__rb,
  pdfjs: typeof window.pdfjsLib,
  mammoth: typeof window.mammoth,
  jszip: typeof window.JSZip,
  sheet: document.querySelector("#screenUpload") ? "ok" : "missing"
}));
ok("the app boots with the network off", offline.booted === true, JSON.stringify(offline));
ok("the PDF reader is available offline", offline.pdfjs === "object", String(offline.pdfjs));
ok("the Word reader is available offline", offline.mammoth === "object", String(offline.mammoth));
ok("the zip reader is available offline", offline.jszip === "function" || offline.jszip === "object", String(offline.jszip));

// and it can still read a document while offline
const offlineRead = await page.evaluate(async () => {
  const buf = await (await fetch("tests/interview-qa.docx")).arrayBuffer();
  const f = new File([buf], "interview-qa.docx");
  try {
    const r = await window.__rb.extract(f);
    return { ok: true, blocks: r.blocks.length, q: r.blocks.filter((b) => b.kind === "q").length };
  } catch (e) { return { ok: false, message: e.message }; }
});
ok("and it reads a Word file with no signal", offlineRead.ok === true && offlineRead.q >= 3, JSON.stringify(offlineRead));
await page.setOfflineMode(false);

/* ================= 5. the install nudge ================= */
console.log("\n--- the install nudge ---");
const iphone = await browser.newPage();
await iphone.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1");
await iphone.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await iphone.goto(APP, { waitUntil: "networkidle2", timeout: 45000 });
await iphone.waitForFunction("window.__rb && window.__rb.state", { timeout: 20000 });
await new Promise((r) => setTimeout(r, 2000));

// headless Chrome still fires the Android install event under an iPhone user
// agent, so clear it. That is precisely what iOS Safari lacks.
const env = await iphone.evaluate(() => window.__rb.install.state());
ok("the headless browser reports the Android capability, as expected here", env.hasPrompt === true, JSON.stringify(env));
await iphone.evaluate(() => { window.__rb.install.clearPrompt(); window.__rb.install.show(); });
const iosCard = await iphone.evaluate(() => {
  const c = document.querySelector("#installCard");
  return { shown: c.classList.contains("on"), text: c.innerText, hasSteps: document.querySelectorAll("#installSteps li").length };
});
ok("on iPhone it explains the two taps", iosCard.shown === true && /Add to Home Screen/i.test(iosCard.text), iosCard.text.replace(/\n/g, " | "));
ok("and lists the steps", iosCard.hasSteps === 3, String(iosCard.hasSteps));
await iphone.screenshot({ path: path.join(__dirname, "shots", "ship-ios-install.png") });

await iphone.evaluate(() => document.querySelector("#installLater").click());
await new Promise((r) => setTimeout(r, 300));
const afterLater = await iphone.evaluate(() => document.querySelector("#installCard").classList.contains("on"));
eq("and it goes away when dismissed", afterLater, false);
await iphone.reload({ waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 2400));
const afterReload = await iphone.evaluate(() => document.querySelector("#installCard").classList.contains("on"));
eq("and does not nag again next time", afterReload, false);

await browser.close();
srv.close();

console.log("\n=========================================");
console.log(pass + " passed, " + fail + " failed");
if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
console.log("READY TO HAND TO SOMEONE");
