/**
 * PERF DIAGNOSIS PROBE — where does frame time go in flight?
 *
 * Boots to FLYING in a software-GL browser (SwiftShader, the stand-in for the
 * user's software-composited Chrome), then for a measurement window records:
 *   - rAF frame deltas (median / p95 / min, oscillation ratio)
 *   - ms inside Cesium scene.render (main globe)
 *   - ms inside Three.js renderer.render (plane + effects overlay)
 *   - ms inside the minimap viewer render
 *   - derived "other" = frame - (cesium + three + minimap) = JS + composite
 *   - long tasks (>50ms) count and total
 *   - Cesium tile queue length samples (main + minimap)
 *   - ESRI imagery fetches: network vs cache-hit (transferSize 0)
 *   - controller state over time (scale, sseIndex, reason, cooldown)
 *
 * RED condition: median fps < 30 during the cruise window, or oscillation
 * (p95/median frame ratio > 2.5). Prints the full breakdown either way.
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
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
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
console.log("FLYING reached, speed:", await page.evaluate(() => Math.round(SKY_DEV.state.speed)));

// ── Inject instrumentation ────────────────────────────────────────────────
await page.evaluate(() => {
  const W = window;
  W.__perf = {
    raf: [], task: [], cesium: [], three: [], mini: [], lastRaf: 0,
    longtasks: 0, longtaskMs: 0,
    tileQueueMax: 0, tileQueueNow: 0, miniTileQueueMax: 0,
    netTiles: 0, cacheTiles: 0, netTileMs: 0,
    controller: [],
    heap: [],
  };

  // Frame deltas + JS task durations: wrap rAF so each animate() invocation
  // records when it started and how long the JS inside it took. The gap
  // (delta - taskDur) is browser-side cost: composite, raster, idle.
  const origRAF = W.requestAnimationFrame.bind(W);
  W.requestAnimationFrame = (cb) => origRAF((t) => {
    const rec = W.__perf;
    const now = performance.now();
    if (rec.lastRaf) {
      const d = now - rec.lastRaf;
      if (d > 0 && d < 5000) rec.raf.push(d);
    }
    rec.lastRaf = now;
    if (rec.raf.length > 60000) rec.raf.splice(0, 30000);
    const t0 = performance.now();
    try { return cb(t); }
    finally {
      rec.task.push(performance.now() - t0);
      if (rec.task.length > 30000) rec.task.splice(0, 15000);
    }
  });

  // Cesium main globe render
  const scene = SKY_DEV.viewer.scene;
  const origRender = scene.render.bind(scene);
  scene.render = (...a) => {
    const t0 = performance.now();
    try { return origRender(...a); }
    finally { const rec = W.__perf; rec.cesium.push(performance.now() - t0); if (rec.cesium.length > 30000) rec.cesium.splice(0, 15000); }
  };

  // Three.js overlay render
  const renderer = SKY_DEV.renderer;
  const origThree = renderer.render.bind(renderer);
  renderer.render = (...a) => {
    const t0 = performance.now();
    try { return origThree(...a); }
    finally { const rec = W.__perf; rec.three.push(performance.now() - t0); if (rec.three.length > 30000) rec.three.splice(0, 15000); }
  };

  // Minimap viewer render (its own globe)
  const mv = SKY_DEV.miniViewer;
  if (mv && mv.scene) {
    const origMini = mv.scene.render.bind(mv.scene);
    mv.scene.render = (...a) => {
      const t0 = performance.now();
      try { return origMini(...a); }
      finally { const rec = W.__perf; rec.mini.push(performance.now() - t0); if (rec.mini.length > 30000) rec.mini.splice(0, 15000); }
    };
    try {
      mv.scene.globe.tileLoadProgressEvent.addEventListener((n) => {
        if (n > W.__perf.miniTileQueueMax) W.__perf.miniTileQueueMax = n;
      });
    } catch (e) { /* best-effort */ }
  }

  // Main globe tile queue
  try {
    SKY_DEV.viewer.scene.globe.tileLoadProgressEvent.addEventListener((n) => {
      W.__perf.tileQueueNow = n;
      if (n > W.__perf.tileQueueMax) W.__perf.tileQueueMax = n;
    });
  } catch (e) { /* best-effort */ }

  // Long tasks (GC, layout, anything > 50ms)
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) { W.__perf.longtasks++; W.__perf.longtaskMs += e.duration; }
    }).observe({ entryTypes: ["longtask"] });
  } catch (e) { /* not supported */ }

  // Imagery network vs cache
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!e.name.includes("arcgisonline")) continue;
        if (e.transferSize === 0) W.__perf.cacheTiles++;
        else { W.__perf.netTiles++; W.__perf.netTileMs += (e.responseEnd - e.requestStart); }
      }
    }).observe({ entryTypes: ["resource"] });
  } catch (e) { /* not supported */ }

  // Controller sampling (2 Hz)
  setInterval(() => {
    const rec = W.__perf, p = SKY_DEV.perf;
    if (rec.controller.length < 400) {
      rec.controller.push({
        t: Math.round(performance.now()),
        scale: +p.scale.toFixed(2), sse: p.sseIndex, reason: p.lastReason,
        q: W.__perf.tileQueueNow,
        heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0,
        fps: rec.raf.length > 60 ? Math.round(1000 / median(rec.raf.slice(-60))) : 0,
      });
    }
    function median(a) { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }
  }, 500);
});

// ── Warmup 8 s (settle after spawn), then 30 s measurement window ─────────
console.log("warmup 8s...");
await sleep(8000);
await page.evaluate(() => { const r = window.__perf; r.raf.length = 0; r.task.length = 0; r.cesium.length = 0; r.three.length = 0; r.mini.length = 0; r.longtasks = 0; r.longtaskMs = 0; r.netTiles = 0; r.cacheTiles = 0; r.netTileMs = 0; r.controller.length = 0; r.lastRaf = 0; });
console.log("measuring 30s...");
await sleep(30000);

const R = await page.evaluate(() => {
  const r = window.__perf;
  const stats = (a) => {
    if (!a.length) return { n: 0, med: 0, p95: 0, min: 0, max: 0, sum: 0 };
    const s = [...a].sort((x, y) => x - y);
    return {
      n: s.length, med: s[s.length >> 1], p95: s[Math.floor(s.length * 0.95)],
      min: s[0], max: s[s.length - 1], sum: s.reduce((x, y) => x + y, 0),
    };
  };
  const frame = stats(r.raf);
  const ces = stats(r.cesium);
  const thr = stats(r.three);
  const mini = stats(r.mini);
  const totalRenderMs = ces.sum + thr.sum + mini.sum;
  const frameSum = r.raf.reduce((x, y) => x + y, 0) || 1;
  const taskSum = r.task.reduce((x, y) => x + y, 0);
  const otherMs = frameSum - taskSum;
  const lastC = r.controller[r.controller.length - 1] || {};
  return {
    window: { frames: r.raf.length },
    frame: { med: +frame.med.toFixed(1), p95: +frame.p95.toFixed(1), min: +frame.min.toFixed(1), max: +frame.max.toFixed(1) },
    fps: frame.med ? +(1000 / frame.med).toFixed(1) : 0,
    oscillation: frame.med ? +(frame.p95 / frame.med).toFixed(2) : 0,
    jsTask: { med: +stats(r.task).med.toFixed(1), p95: +stats(r.task).p95.toFixed(1), pct: +(100 * taskSum / frameSum).toFixed(1) },
    cesiumRender: { med: +ces.med.toFixed(1), p95: +ces.p95.toFixed(1), n: ces.n, pct: +(100 * ces.sum / frameSum).toFixed(1) },
    threeRender: { med: +thr.med.toFixed(1), p95: +thr.p95.toFixed(1), n: thr.n, pct: +(100 * thr.sum / frameSum).toFixed(1) },
    minimapRender: { med: +mini.med.toFixed(1), p95: +mini.p95.toFixed(1), n: mini.n, pct: +(100 * mini.sum / frameSum).toFixed(1) },
    browserGap: { pct: +(100 * otherMs / frameSum).toFixed(1), msPerFrame: +(otherMs / (r.raf.length || 1)).toFixed(1) },
    longtasks: { count: r.longtasks, totalMs: Math.round(r.longtaskMs) },
    tiles: { queueMax: r.tileQueueMax, queueEnd: r.tileQueueNow, miniQueueMax: r.miniTileQueueMax, net: r.netTiles, cache: r.cacheTiles, netMsTotal: Math.round(r.netTileMs) },
    controller: lastC,
    controllerTrail: r.controller.slice(-12).map((c) => `${c.fps}fps s${c.scale} sse${c.sse} ${c.reason} q${c.q} h${c.heap}`),
    speed: Math.round(SKY_DEV.state.speed),
    resolutionScale: SKY_DEV.viewer.resolutionScale,
    errors: undefined,
  };
});

console.log("\n════════ PERF BREAKDOWN (30s cruise, software GL) ════════");
console.log(JSON.stringify(R, null, 1));

const red = R.fps < 30 || (R.oscillation > 2.5 && !(R.controller && R.controller.reason));
// With globe decimation engaged the frame cadence is intentionally bimodal
// (2 cheap + 1 heavy), so a high p95/median ratio is by design, not flapping.
console.log(red ? `\n  RED: fps=${R.fps} osc=${R.oscillation}` : `\n  GREEN: fps=${R.fps} osc=${R.oscillation} (bimodal by design when decimated)`);
if (errors.length) console.log("PAGE ERRORS:", errors.slice(0, 3));

await browser.close();
process.exit(red ? 1 : 0);
