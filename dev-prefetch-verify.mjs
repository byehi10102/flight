/**
 * PREFETCH VERIFICATION: three fetch paths + picker drag stalls.
 *   1. picker pan prefetch: drag -> count Esri fetches + p95 frame delta
 *   2. spawn radius preload: confirm spawn -> count fetches during preparing
 *   3. flight mid ring: 15 s cruise -> count fetches at coarse levels
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
console.log("PICK_SPAWN. settle 4s...");
await sleep(4000);

await page.evaluate(() => {
  const W = window;
  W.__fetch = 0; W.__raf = []; W.__last = 0;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (e.name.includes("arcgisonline")) W.__fetch++;
  }).observe({ entryTypes: ["resource"] });
  const origRAF = W.requestAnimationFrame.bind(W);
  W.requestAnimationFrame = (cb) => origRAF((t) => {
    const now = performance.now();
    if (W.__last) { const d = now - W.__last; if (d > 0 && d < 5000) W.__raf.push(d); }
    W.__last = now;
    return cb(t);
  });
});

// 1. Picker drag #1 (fresh area — pan far)
const f0 = await page.evaluate(() => window.__fetch);
await page.mouse.move(640, 370);
await page.mouse.down();
for (let i = 0; i < 30; i++) { await page.mouse.move(640 + i * 14, 370 + Math.sin(i / 3) * 25); await sleep(28); }
await page.mouse.up();
await sleep(1200);
const p1 = await page.evaluate(() => {
  const f = [...window.__raf].sort((a, b) => a - b);
  return { fetches: window.__fetch, p95: f.length ? +f[Math.floor(f.length * 0.95)].toFixed(1) : 0, med: f.length ? +f[f.length >> 1].toFixed(1) : 0 };
});
console.log(`PICKER drag1: fetches=${p1.fetches - f0} frameMed=${p1.med}ms frameP95=${p1.p95}ms`);

// Second drag (cache warm now)
await page.evaluate(() => { window.__raf.length = 0; window.__last = 0; });
await page.mouse.move(500, 370);
await page.mouse.down();
for (let i = 0; i < 30; i++) { await page.mouse.move(500 + i * 14, 370 + Math.sin(i / 3) * 25); await sleep(28); }
await page.mouse.up();
await sleep(1200);
const p2 = await page.evaluate(() => {
  const f = [...window.__raf].sort((a, b) => a - b);
  return { fetches: window.__fetch, p95: f.length ? +f[Math.floor(f.length * 0.95)].toFixed(1) : 0, med: f.length ? +f[f.length >> 1].toFixed(1) : 0 };
});
console.log(`PICKER drag2 (warm): fetches=${p2.fetches - p1.fetches} frameMed=${p2.med}ms frameP95=${p2.p95}ms`);

// 2. Spawn radius preload
await page.evaluate(() => SKY_DEV.placeSpawn(-98.5, 38.5, "Kansas"));
await sleep(400);
const fBefore = await page.evaluate(() => window.__fetch);
await page.evaluate(() => document.getElementById("confirmSpawnBtn")?.click());
await page.waitForFunction(() => SKY_DEV.currentState === "FLYING", { timeout: 120000, polling: 500 });
const spawnFetches = await page.evaluate((f0) => window.__fetch - f0, fBefore);
console.log(`SPAWN preload: fetches during preparing->FLYING = ${spawnFetches}`);

// 3. Flight mid ring: 15 s cruise
await sleep(3000);
const fFlight0 = await page.evaluate(() => window.__fetch);
await sleep(15000);
const fl = await page.evaluate((x) => ({ d: window.__fetch - x, speed: Math.round(SKY_DEV.state.speed) }), fFlight0);
console.log(`FLIGHT 15s: imagery fetches=${fl.d} at speed=${fl.speed}`);

const ok = p1.fetches - f0 > 5 && spawnFetches > 50 && fl.d > 10;
console.log(ok ? "  GREEN: all three prefetch paths active" : "  RED: a prefetch path is not fetching");
await browser.close();
process.exit(ok ? 0 : 1);
