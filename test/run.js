/* End-to-end check for ReadBack, driven through real Chrome.
   Loads the app, extracts each supported format using the app's own code,
   walks the paste -> reader -> play flow, and captures screenshots.
   Run: node test/run.js
*/
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = "http://127.0.0.1:8765/";
const SHOTS = path.join(__dirname, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

const problems = [];
const notes = [];

function ok(label, cond, detail) {
  const line = (cond ? "PASS  " : "FAIL  ") + label + (detail ? "  :: " + detail : "");
  console.log(line);
  if (!cond) problems.push(label + (detail ? " :: " + detail : ""));
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 });

  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + e.message));

  await page.goto(BASE, { waitUntil: "networkidle2", timeout: 45000 });
  await page.waitForFunction("window.__rb && window.__rb.extract", { timeout: 15000 });

  /* ---------- 1. clean load ---------- */
  ok("page loads with no JS errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  const globals = await page.evaluate(() => ({
    pdf: typeof window.pdfjsLib,
    mammoth: typeof window.mammoth,
    jszip: typeof window.JSZip,
    worker: window.pdfjsLib ? window.pdfjsLib.GlobalWorkerOptions.workerSrc : null,
    speech: typeof window.speechSynthesis,
    hasSheet: !!document.querySelector("#sheetUpgrade")
  }));
  ok("pdf.js loaded", globals.pdf === "object", globals.pdf);
  ok("mammoth loaded", globals.mammoth === "object", globals.mammoth);
  ok("jszip loaded", globals.jszip === "function" || globals.jszip === "object", globals.jszip);
  ok("pdf worker points at a local file", /vendor\/pdf\.worker\.min\.js$/.test(globals.worker || ""), globals.worker);
  notes.push("speechSynthesis in headless: " + globals.speech);

  /* ---------- what a personal user gets on first open ---------- */
  const personal = await page.evaluate(() => ({
    mode: window.__rb.state.settings.mode,
    pillHidden: getComputedStyle(document.querySelector("#planPill")).display === "none",
    usage: document.querySelector("#usageLine").textContent.trim(),
    upgradeReachable: !!document.querySelector("#planPill").offsetParent
  }));
  ok("defaults to personal mode, not selling", personal.mode === "personal", String(personal.mode));
  ok("no plan pill is shown", personal.pillHidden === true, JSON.stringify(personal));
  ok("no listening meter is shown", personal.usage === "", JSON.stringify(personal.usage));
  ok("nothing to press to reach a paywall", personal.upgradeReachable === false, JSON.stringify(personal));

  /* ---------- 2. sentence splitting ---------- */
  const split = await page.evaluate(() => {
    const cases = {
      simple: window.__rb.splitSentences("One thing. Two things! Three?"),
      abbrev: window.__rb.splitSentences("I met Dr. Adeyemi at 9 a.m. Then we left."),
      decimal: window.__rb.splitSentences("Revenue rose 3.5 percent. Costs held flat."),
      initials: window.__rb.splitSentences("J. Adewale wrote it. She signed off."),
      quote: window.__rb.splitSentences('He said "go home." Then he left.')
    };
    return cases;
  });
  ok("splits plain sentences", split.simple.length === 3, JSON.stringify(split.simple));
  ok("does not split on Dr. or a.m.", split.abbrev.length === 2, JSON.stringify(split.abbrev));
  ok("does not split on decimals", split.decimal.length === 2, JSON.stringify(split.decimal));
  ok("does not split on initials", split.initials.length === 2, JSON.stringify(split.initials));
  ok("handles closing quote", split.quote.length === 2, JSON.stringify(split.quote));

  /* ---------- 3. question and answer detection ---------- */
  const cls = await page.evaluate(() => ({
    q1: window.__rb.classify("Q: Tell me about a time you failed."),
    q2: window.__rb.classify("Question: Why this company?"),
    a1: window.__rb.classify("A: I owned the call and reversed it."),
    a2: window.__rb.classify("Answer: Start from the cost of yes."),
    p1: window.__rb.classify("Just an ordinary paragraph about the role.")
  }));
  ok("detects Q: prefix", cls.q1.kind === "q" && cls.q1.text.indexOf("Q:") === -1, JSON.stringify(cls.q1));
  ok("detects Question: prefix", cls.q2.kind === "q");
  ok("detects A: prefix", cls.a1.kind === "a", JSON.stringify(cls.a1));
  ok("detects Answer: prefix", cls.a2.kind === "a");
  ok("leaves prose alone", cls.p1.kind === "p");

  /* ---------- 4. real file extraction ---------- */
  const files = ["interview-qa.docx", "analyst-qa.pdf", "job-spec.txt", "dummy.pdf"];
  for (const name of files) {
    const res = await page.evaluate(async (n) => {
      const buf = await (await fetch("tests/" + n)).arrayBuffer();
      const f = new File([buf], n);
      try {
        const r = await window.__rb.extract(f);
        return {
          okFile: true, name: r.name, ext: r.ext, blocks: r.blocks.length,
          words: r.blocks.reduce((a, b) => a + b.text.split(/\s+/).length, 0),
          kinds: r.blocks.reduce((m, b) => (m[b.kind] = (m[b.kind] || 0) + 1, m), {}),
          sample: r.blocks.slice(0, 6).map((b) => b.kind + ": " + b.text.slice(0, 60))
        };
      } catch (e) {
        return { okFile: false, err: String(e && e.message || e) };
      }
    }, name);
    if (res.okFile) {
      notes.push(name + " -> " + res.blocks + " blocks, " + res.words + " words, kinds " + JSON.stringify(res.kinds));
      console.log("      " + name + " sample:\n        " + res.sample.join("\n        "));
      ok("extracted " + name, res.blocks > 0, res.blocks + " blocks");
      if (/qa/.test(name)) {
        ok("  found question blocks in " + name, (res.kinds.q || 0) >= 3, JSON.stringify(res.kinds));
        ok("  found answer blocks in " + name, (res.kinds.a || 0) >= 3, JSON.stringify(res.kinds));
      }
    } else {
      ok("extracted " + name, false, res.err);
    }
  }

  await page.screenshot({ path: path.join(SHOTS, "1-upload.png"), fullPage: false });

  /* ---------- 5. paste flow through the real UI ---------- */
  await page.evaluate(() => { document.querySelector("#fillSample").click(); });
  await page.click("#pasteGo");
  await page.waitForFunction("!document.querySelector('#screenReader').classList.contains('hidden')", { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 600));

  const reader = await page.evaluate(() => ({
    name: document.querySelector("#docName").textContent,
    sentences: document.querySelectorAll("#textPane .s").length,
    headings: document.querySelectorAll("#textPane .k-h1, #textPane .k-h2").length,
    qtags: document.querySelectorAll("#textPane .qtag").length,
    pos: document.querySelector("#posTxt").textContent,
    docSentences: window.__rb.state.doc ? window.__rb.state.doc.sentences.length : 0,
    sections: window.__rb.state.doc ? window.__rb.state.doc.sections.length : 0
  }));
  ok("paste created a document", /Pasted notes/.test(reader.name), reader.name);
  ok("reader rendered sentence spans", reader.sentences > 10, String(reader.sentences));
  ok("reader rendered headings", reader.headings >= 3, String(reader.headings));
  ok("reader showed Q tags", reader.qtags >= 4, String(reader.qtags));
  ok("sections detected from headings", reader.sections >= 3, String(reader.sections));
  notes.push("sample doc: " + reader.sentences + " sentences, " + reader.sections + " sections, " + reader.headings + " headings");

  await page.screenshot({ path: path.join(SHOTS, "2-reader.png") });

  /* ---------- 6. play state machine (no audio in headless) ---------- */
  const playFail = await page.evaluate(() => {
    try {
      document.querySelector("#playBtn").click();
      return null;
    } catch (e) { return String(e); }
  });
  await new Promise((r) => setTimeout(r, 400));
  const playing = await page.evaluate(() => ({
    playing: window.__rb.state.playing,
    cur: window.__rb.state.cur,
    secStart: window.__rb.state.secStart,
    secEnd: window.__rb.state.secEnd,
    highlighted: document.querySelectorAll("#textPane .s.on").length
  }));
  ok("play() does not throw", playFail === null, playFail || "");
  ok("play set the playing flag", playing.playing === true, JSON.stringify(playing));
  ok("play highlighted exactly one sentence", playing.highlighted === 1, String(playing.highlighted));

  /* ---------- the silent track that keeps the car session alive ---------- */
  const kaOn = await page.evaluate(() => window.__rb.keepAliveRunning());
  ok("a silent track runs while playing, to hold the car session", kaOn === true, String(kaOn));
  await page.evaluate(() => document.querySelector("#playBtn").click());
  await new Promise((r) => setTimeout(r, 400));
  const kaOff = await page.evaluate(() => window.__rb.keepAliveRunning());
  ok("and stops when paused", kaOff === false, String(kaOff));

  /* ---------- 7. seek, section tracking, driving mode ---------- */
  const seekRes = await page.evaluate(() => {
    const n = window.__rb.state.doc.sentences.length;
    const mid = Math.floor(n / 2);
    const el = document.querySelector('#textPane .s[data-i="' + mid + '"]');
    if (!el) return { clicked: false, mid: mid };
    el.click();
    return { clicked: true, mid: mid, cur: window.__rb.state.cur, highlight: document.querySelectorAll("#textPane .s.on").length };
  });
  ok("tapping a sentence seeks to it", seekRes.clicked && seekRes.cur === seekRes.mid, JSON.stringify(seekRes));
  ok("seek leaves one sentence highlighted", seekRes.highlight === 1, String(seekRes.highlight));

  const sec = await page.evaluate(() => ({
    start: window.__rb.state.secStart, end: window.__rb.state.secEnd,
    cur: window.__rb.state.cur, sections: window.__rb.state.doc.sections.length
  }));
  ok("section bounds track the current sentence",
     sec.end > sec.start && sec.cur >= sec.start && sec.cur <= sec.end, JSON.stringify(sec));

  /* ---------- 8. car stereo / lock screen wiring ---------- */
  const media = await page.evaluate(() => {
    if (!("mediaSession" in navigator)) return { supported: false };
    const md = navigator.mediaSession.metadata;
    return {
      supported: true,
      title: md ? md.title : null,
      artist: md ? md.artist : null,
      state: navigator.mediaSession.playbackState,
      docName: window.__rb.state.doc ? window.__rb.state.doc.name : null
    };
  });
  if (media.supported) {
    ok("media metadata names the document", media.title === media.docName, JSON.stringify(media));
    ok("media playback state reported", media.state === "playing" || media.state === "paused", media.state);
  } else {
    notes.push("mediaSession not exposed in this headless build");
  }

  await page.evaluate(() => document.querySelector("#nextBtn").click());
  const afterNext = await page.evaluate(() => window.__rb.state.cur);
  ok("next jumps to a later sentence", afterNext > seekRes.mid, seekRes.mid + " -> " + afterNext);

  await page.evaluate(() => document.querySelector("#driveBtn").click());
  await page.waitForFunction("document.body.classList.contains('driving')", { timeout: 5000 });
  const drive = await page.evaluate(() => ({
    cls: document.body.classList.contains("driving"),
    flag: getComputedStyle(document.querySelector(".driveflag")).display,
    playSize: Math.round(document.querySelector(".tbtn.play").getBoundingClientRect().width)
  }));
  ok("driving mode applies", drive.cls === true);
  ok("driving flag visible", drive.flag !== "none", drive.flag);
  ok("driving play button is bigger", drive.playSize >= 80, drive.playSize + "px");
  await page.screenshot({ path: path.join(SHOTS, "3-driving.png") });

  await page.evaluate(() => document.querySelector("#driveBtn").click());

  /* ---------- 8. outline sheet ---------- */
  await page.evaluate(() => document.querySelector("#outlineBtn").click());
  await new Promise((r) => setTimeout(r, 500));
  const outline = await page.evaluate(() => ({
    shown: document.querySelector("#sheetOutline").classList.contains("show"),
    rows: document.querySelectorAll("#outlineList .oi").length,
    first: document.querySelector("#outlineList .oi b") ? document.querySelector("#outlineList .oi b").textContent : ""
  }));
  ok("outline sheet opens", outline.shown === true);
  ok("outline lists sections", outline.rows >= 3, String(outline.rows));
  await page.screenshot({ path: path.join(SHOTS, "4-outline.png") });
  await page.evaluate(() => document.querySelector("#scrim").click());

  /* ---------- 9. the freemium gate, with selling switched on ---------- */
  await page.evaluate(() => document.querySelector("#backBtn").click());
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(() => window.__rb.setMode("sell"));
  await page.evaluate(() => {
    const buf = new TextEncoder().encode("Another document entirely. It has plenty of words so it counts. ".repeat(28));
    const f = new File([buf], "second-job-spec.txt");
    window.__rb.importFile ? window.__rb.importFile(f) : null;
    const inp = document.querySelector("#file");
    const dt = new DataTransfer();
    dt.items.add(f);
    inp.files = dt.files;
    inp.dispatchEvent(new Event("change"));
  });
  await new Promise((r) => setTimeout(r, 2500));
  const gate = await page.evaluate(() => ({
    upgradeShown: document.querySelector("#sheetUpgrade").classList.contains("show"),
    used: window.__rb.state.usage.docs,
    plan: document.querySelector("#planPill").textContent,
    plans: document.querySelectorAll("#planList .plan").length,
    proPrice: document.querySelector("#planList .plan.best .price") ? document.querySelector("#planList .plan.best .price").textContent.trim() : ""
  }));
  ok("second document is blocked on free plan", gate.upgradeShown === true, "upgrade sheet shown: " + gate.upgradeShown);
  ok("upgrade sheet lists plans", gate.plans === 3, String(gate.plans));
  notes.push("best plan price shown: " + gate.proPrice);
  await page.screenshot({ path: path.join(SHOTS, "5-upgrade.png"), fullPage: false });

  /* ---------- 10. purchase unlock ---------- */
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("#planList .plan button"));
    const pro = btns.find((b) => !b.disabled);
    pro.click();
  });
  await new Promise((r) => setTimeout(r, 600));
  const pro = await page.evaluate(() => ({
    pro: window.__rb.state.pro,
    pill: document.querySelector("#planPill").textContent,
    pillClass: document.querySelector("#planPill").className
  }));
  ok("activating a plan sets pro", pro.pro === true);
  ok("plan pill updates", /Pro/.test(pro.pill) && /pro/.test(pro.pillClass), pro.pill + " / " + pro.pillClass);

  /* ---------- 11. back to personal mode, through the real switch ---------- */
  const beforeCount = await page.evaluate(() => {
    document.querySelector("#scrim").click();
    return document.querySelectorAll("#lib .lib").length;
  });
  await page.evaluate(() => document.querySelector("#swSell").click());
  await new Promise((r) => setTimeout(r, 300));
  const switched = await page.evaluate(() => ({
    mode: window.__rb.state.settings.mode,
    pillHidden: getComputedStyle(document.querySelector("#planPill")).display === "none",
    usage: document.querySelector("#usageLine").textContent.trim()
  }));
  ok("the switch turns selling off", switched.mode === "personal", JSON.stringify(switched));
  ok("and the plan pill disappears", switched.pillHidden === true, JSON.stringify(switched));
  ok("and the listening meter disappears", switched.usage === "", JSON.stringify(switched.usage));

  await page.evaluate(() => {
    const buf = new TextEncoder().encode(("A third document. It has plenty of words to listen to. ").repeat(22));
    const f = new File([buf], "third-notes.txt");
    const inp = document.querySelector("#file");
    const dt = new DataTransfer();
    dt.items.add(f);
    inp.files = dt.files;
    inp.dispatchEvent(new Event("change"));
  });
  await new Promise((r) => setTimeout(r, 3000));
  const open = await page.evaluate(() => ({
    upgradeShown: document.querySelector("#sheetUpgrade").classList.contains("show"),
    documents: document.querySelectorAll("#lib .lib").length
  }));
  ok("personal mode adds a document without a wall",
     open.upgradeShown === false && open.documents > beforeCount, beforeCount + " -> " + JSON.stringify(open));
  ok("and never shows the upgrade sheet", open.upgradeShown === false, JSON.stringify(open));

  /* ---------- summary ---------- */
  console.log("\n---------- notes ----------");
  notes.forEach((n) => console.log("  " + n));
  const remaining = await page.evaluate(() => (window.__rb.state && window.__rb.state.doc) ? true : false);
  console.log("\nreader still holds a document: " + remaining);
  if (consoleErrors.length) {
    console.log("\n---------- console errors captured during the run ----------");
    consoleErrors.forEach((e) => console.log("  " + e));
  }

  await browser.close();

  console.log("\n=========================================");
  if (problems.length) {
    console.log("FAILURES (" + problems.length + "):");
    problems.forEach((p) => console.log("  - " + p));
    process.exit(1);
  }
  console.log("ALL CHECKS PASSED");
})().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(2);
});
