/**
 * FREEZE HUNTER: 60 s cruise recording per-frame state.
 * Catches: frame deltas > 250 ms (the "random freeze"), long tasks,
 * and correlates each freeze with tile-queue depth + fetch bursts.
 */
import puppeteer from "puppeteer-core";

const GAME_URL = "http://127.0.0.1:5173/?devtest=1";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 600000,
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
         "--enable-webgl", "--ignore-gpu-blocklist", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 740, deviceScaleFactor: 1 });
await page.goto(GAME_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.SKY_DEV, { timeout: 60000, polling: 500 });
await page.waitForFunction(() => {
  const b = document.getElementById("startBtn");
  return window.SKY_DEV?.boot?.pageGone === true && b && !b.disabled;
}, { timeout: 150000, polling: 500 });
await page.click("#startBtn");
await page.waitForFunction(() => SKY_DEV.currentState === "PICK_SPAWN", { timeout: 30000, polling: 250 });
await page.evaluate(() => SKY_DEV.placeSpawn(-98.5, 38.5, "Kansas"));
await sleep(500);
await page.evaluate(() => document.getElementById("confirmSpawnBtn")?.click());
await page.waitForFunction(() => SKY_DEV.currentState === "FLYING", { timeout: 120000, polling: 500 });
console.log("FLYING. warmup 8s...");
await sleep(8000);

await page.evaluate(() => {
  const W = window;
  W.__rec = { frames: [], longtasks: [], fetches: [] };
  const origRAF = W.requestAnimationFrame.bind(W);
  W.requestAnimationFrame = (cb) => origRAF((t) => {
    const now = performance.now();
    const last = W.__rec.frames.length ? W.__rec.frames[W.__rec.frames.length - 1].t : 0;
    const d = last ? now - last : 16;
    let q = -1, skip = -1;
    try {
      q = SKY_DEV.viewer.scene.globe._surface?._tileLoadQueueHigh?.length || 0;
      skip = SKY_DEV.perf.globeSkip;
    } catch (e) { }
    W.__rec.frames.push({ t: now, d: +d.toFixed(1), q, skip });
    if (W.__rec.frames.length > 20000) W.__rec.frames.splice(0, 10000);
    return cb(t);
  });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) W.__rec.longtasks.push({ t: Math.round(e.startTime), ms: Math.round(e.duration) });
  }).observe({ entryTypes: ["longtask"] });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (e.name.includes("arcgisonline")) W.__rec.fetches.push(Math.round(e.startTime));
  }).observe({ entryTypes: ["resource"] });
});

console.log("measuring 60s...");
await sleep(60000);

const R = await page.evaluate(() => {
  const fr = window.__rec.frames;
  const freezes = [];
  for (const f of fr) {
    if (f.d > 250) {
      // fetches in the 1s window before the freeze
      const f0 = window.__rec.fetches.filter((t) => t > f.t - 1000 && t <= f.t).length;
      freezes.push({ at: Math.round(f.t), ms: f.d, q: f.q, skip: f.skip, fetchesBefore: f0 });
    }
  }
  const deltas = fr.map((f) => f.d).sort((a, b) => a - b);
  const maxLong = Math.max(0, ...window.__rec.longtasks.map((l) => l.ms));
  return {
    frames: fr.length,
    med: +deltas[deltas.length >> 1].toFixed(1),
    p99: +deltas[Math.floor(deltas.length * 0.99)].toFixed(1),
    max: +deltas[deltas.length - 1].toFixed(1),
    freezes,
    longtasks: window.__rec.longtasks.slice(0, 10),
    maxLong,
    longtaskCount: window.__rec.longtasks.length,
  };
});
console.log(JSON.stringify(R, null, 1));
const red = R.freezes.length > 0 || R.maxLong > 150;
console.log(red ? "RED: freezes/longtasks present" : "GREEN: no freezes > 250ms, no longtask > 150ms");
await browser.close();
process.exit(red ? 1 : 0);
