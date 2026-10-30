/* Verify the DEPLOYED app, not the local copy.
   Loads the live GitHub Pages URL, confirms the shell and assets are real,
   then extracts a PDF that the site itself is serving.
   Run: node test/live.js
*/
const puppeteer = require("puppeteer-core");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const LIVE = process.env.LIVE_BASE || "https://kosigbesan.github.io/readback/";

const problems = [];
function ok(label, cond, detail) {
  console.log((cond ? "PASS  " : "FAIL  ") + label + (detail ? "  :: " + detail : ""));
  if (!cond) problems.push(label + (detail ? " :: " + detail : ""));
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 });

  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const failed = [];
  page.on("requestfailed", (r) => failed.push(r.url() + " :: " + (r.failure() ? r.failure().errorText : "")));

  console.log("loading " + LIVE);
  await page.goto(LIVE, { waitUntil: "networkidle2", timeout: 45000 });
  await page.waitForFunction("window.__rb && window.__rb.extract", { timeout: 20000 });

  ok("live page boots the app", true, LIVE);
  ok("no JS errors on the live page", errors.length === 0, errors.slice(0, 3).join(" | "));
  ok("no failed requests", failed.length === 0, failed.slice(0, 3).join(" | "));

  const libs = await page.evaluate(() => ({
    pdf: typeof window.pdfjsLib,
    mammoth: typeof window.mammoth,
    jszip: typeof window.JSZip,
    worker: window.pdfjsLib ? window.pdfjsLib.GlobalWorkerOptions.workerSrc : null,
    sw: !!navigator.serviceWorker,
    manifest: !!document.querySelector('link[rel="manifest"]'),
    title: document.title
  }));
  ok("pdf.js served from the site", libs.pdf === "object", libs.pdf);
  ok("mammoth served from the site", libs.mammoth === "object", libs.mammoth);
  ok("jszip served from the site", libs.jszip === "function" || libs.jszip === "object", libs.jszip);
  ok("pdf worker is a relative path", /vendor\/pdf\.worker\.min\.js$/.test(libs.worker || ""), libs.worker);
  ok("manifest linked", libs.manifest === true);
  ok("service worker available", libs.sw === true);
  console.log("      page title: " + libs.title);

  // extract a PDF that the live site serves, through the live app code
  const pdf = await page.evaluate(async () => {
    const buf = await (await fetch("tests/analyst-qa.pdf")).arrayBuffer();
    const f = new File([buf], "analyst-qa.pdf");
    const r = await window.__rb.extract(f);
    return {
      blocks: r.blocks.length,
      kinds: r.blocks.reduce((m, b) => (m[b.kind] = (m[b.kind] || 0) + 1, m), {}),
      first: r.blocks.slice(0, 4).map((b) => b.kind + ": " + b.text.slice(0, 50))
    };
  });
  console.log("      " + JSON.stringify(pdf.kinds) + "\n      " + pdf.first.join("\n      "));
  ok("live app extracts the served PDF", pdf.blocks > 0, pdf.blocks + " blocks");
  ok("live app finds questions in that PDF", (pdf.kinds.q || 0) >= 3, JSON.stringify(pdf.kinds));
  ok("live app finds answers in that PDF", (pdf.kinds.a || 0) >= 3, JSON.stringify(pdf.kinds));

  // manifest + icons really resolve
  const assets = await page.evaluate(async () => {
    const list = ["manifest.json", "service-worker.js", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png"];
    const out = {};
    for (const a of list) {
      try { const r = await fetch(a, { method: "GET" }); out[a] = r.status; }
      catch (e) { out[a] = "ERR"; }
    }
    return out;
  });
  for (const a of Object.keys(assets)) ok("serves " + a, assets[a] === 200, String(assets[a]));

  // paste flow works on the live site
  await page.evaluate(() => { document.querySelector("#fillSample").click(); });
  await page.click("#pasteGo");
  await page.waitForFunction("!document.querySelector('#screenReader').classList.contains('hidden')", { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 500));
  const reader = await page.evaluate(() => ({
    q: document.querySelectorAll("#textPane .qtag").length,
    sents: document.querySelectorAll("#textPane .s").length,
    heads: document.querySelectorAll("#textPane .k-h2").length
  }));
  ok("live paste flow builds a document", reader.sents > 10, JSON.stringify(reader));
  ok("live app tags questions", reader.q >= 4, String(reader.q));

  await page.screenshot({ path: require("path").join(__dirname, "shots", "live-reader.png") });

  await browser.close();
  console.log("\n=========================================");
  if (problems.length) {
    console.log("FAILURES (" + problems.length + "):");
    problems.forEach((p) => console.log("  - " + p));
    process.exit(1);
  }
  console.log("LIVE SITE VERIFIED: " + LIVE);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
