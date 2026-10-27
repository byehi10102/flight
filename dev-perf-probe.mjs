/**
 * Headful performance probe — the real GPU, the real browser, the real flow.
 *
 * Drives the actual game (boot -> menu -> picker -> spawn -> flight) in the
 * user's real Chrome and reports what the frame budget actually looks like:
 *   - measured rAF fps + p50/p95 frame time over a sampling window
 *   - the thermostat's own reading (scale it settled at, avg ms)
 *   - canvas drawing-buffer sizes for all three render surfaces
 *   - the tactical minimap: viewer alive? size? tiles loaded?
 *   - WebGL renderer string (catches software-rendering fallback)
 *   - every console error/warning along the way
 *
 * Usage:  node dev-perf-probe.mjs   (needs the dev server on :5173 or
 *         GAME_URL set, and system Chrome where puppeteer-core expects it)
 */
import puppeteer from "puppeteer-core";

const GAME_URL = process.env.GAME_URL || "http://127.0.0.1:5173/?devtest=1";
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUT = process.env.SHOT_DIR || ".";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const logs = [];
const pageErrors = [];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  protocolTimeout: 600000,
  args: [
    "--no-first-run", "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1600,1000",
    "--ignore-gpu-blocklist",
  ],
});
const page = await browser.newPage();
page.on("console", (m) => {
  const t = m.type();
  if (t === "error" || t === "warning") logs.push(`[${t}] ${m.text()}`);
});
page.on("pageerror", (e) => pageErrors.push(String(e?.stack || e)));

console.log("opening", GAME_URL);
await page.goto(GAME_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

// ── boot: wait for the menu (the boot page must be gone) ──────────────────
await page.waitForFunction(() => window.SKY_DEV, { timeout: 60000, polling: 500 });
console.log("SKY_DEV up; waiting for boot page to clear…");
await page.waitForFunction(
  () => {
    const b = document.getElementById("startBtn");
    // Not just laid out — actually clickable: the boot page keeps the button
    // disabled until every stage lands, and a .click() on a disabled button
    // is a silent no-op.
    return window.SKY_DEV?.boot?.pageGone === true && b && !b.disabled;
  },
  { timeout: 150000, polling: 500 },
);
await sleep(1500);
console.log("menu is up. state =", await page.evaluate(() => SKY_DEV.currentState));

// ── quick picker-frame sample (the picker is where map browsing happens) ───
await page.evaluate(() => document.getElementById("startBtn").click());
await page.waitForFunction(() => SKY_DEV.currentState === "PICK_SPAWN", { timeout: 30000, polling: 250 });
await sleep(6000); // let the fly-in finish and tiles start streaming
const pickerPerf = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const deltas = [];
      let last = performance.now();
      const t0 = last;
      function tick(t) {
        deltas.push(t - last);
        last = t;
        if (t - t0 < 5000) requestAnimationFrame(tick);
        else {
          deltas.sort((a, b) => a - b);
          resolve({
            n: deltas.length,
            fps: +(deltas.length / 5).toFixed(1),
            p50: +deltas[Math.floor(deltas.length / 2)].toFixed(1),
            p95: +deltas[Math.floor(deltas.length * 0.95)].toFixed(1),
          });
        }
      }
      requestAnimationFrame(tick);
    }),
);
console.log("PICKER 5s:", JSON.stringify(pickerPerf));

// ── place a spawn and launch ────────────────────────────────────────────────
await page.evaluate(() => SKY_DEV.placeSpawn(-117.9143, 33.8366, "Anaheim"));
await sleep(600);
await page.evaluate(() => document.getElementById("confirmSpawnBtn")?.click());
console.log("spawn clicked; waiting for flight…");
await page.waitForFunction(() => SKY_DEV.currentState === "FLYING", { timeout: 120000, polling: 500 });
console.log("FLYING. sampling 15s…");

// Let the dive settle + the first tiles land before judging the frame budget.
await sleep(5000);
await page.screenshot({ path: `${OUT}/shot-flight-early.png` });

const flight = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const deltas = [];
      let last = performance.now();
      const t0 = last;
      function tick(t) {
        deltas.push(t - last);
        last = t;
        if (t - t0 < 15000) requestAnimationFrame(tick);
        else {
          deltas.sort((a, b) => a - b);
          const sum = deltas.reduce((a, b) => a + b, 0);
          resolve({
            n: deltas.length,
            fps: +(deltas.length / 15).toFixed(1),
            meanMs: +(sum / deltas.length).toFixed(1),
            p50: +deltas[Math.floor(deltas.length / 2)].toFixed(1),
            p95: +deltas[Math.floor(deltas.length * 0.95)].toFixed(1),
          });
        }
      }
      requestAnimationFrame(tick);
    }),
);

const diag = await page.evaluate(() => {
  const glProbe = document.createElement("canvas");
  const gl = glProbe.getContext("webgl2") || glProbe.getContext("webgl");
  let renderer = "";
  try {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  } catch (e) { renderer = "unavailable"; }

  const v = SKY_DEV.viewer;
  const mv = SKY_DEV.miniViewer;
  const three = SKY_DEV.renderer;
  const ces = v?.scene?.canvas;
  const mini = mv?.canvas;
  const tc = three?.domElement;
  const fmt = (c) => (c ? `${c.clientWidth}x${c.clientHeight} css / ${c.width}x${c.height} buf` : "none");

  return {
    dpr: window.devicePixelRatio,
    screen: `${screen.width}x${screen.height}`,
    webglRenderer: renderer,
    cesium: fmt(ces),
    minimapCanvas: fmt(mini),
    three: fmt(tc),
    perf: SKY_DEV.perf?.report?.(),
    hudFps: document.getElementById("fps")?.textContent,
    speedMph: SKY_DEV.state?.speed,
    agl: SKY_DEV.state?.agl,
    minimap: mv
      ? {
          alive: true,
          tilesLoaded: mv.scene.globe.tilesLoaded,
          layers: mv.imageryLayers.length,
          sse: mv.scene.globe.maximumScreenSpaceError,
          parentVisible: document.getElementById("minimapCesium")?.offsetParent !== null,
          cssSize: (() => { const el = document.getElementById("minimapCesium"); return el ? `${el.clientWidth}x${el.clientHeight}` : "gone"; })(),
        }
      : { alive: false },
    mainGlobe: {
      sse: v.scene.globe.maximumScreenSpaceError,
      msaa: v.scene.msaaSamples,
      resScale: v.resolutionScale,
      tilesLoaded: v.scene.globe.tilesLoaded,
    },
    imageryLevel: SKY_DEV.imageryLevel,
  };
});

await page.screenshot({ path: `${OUT}/shot-flight-late.png` });
await page.screenshot({ path: `${OUT}/shot-minimap.png`, clip: { x: 0, y: 700, width: 320, height: 320 } });

console.log("FLIGHT 15s:", JSON.stringify(flight));
console.log("DIAG:", JSON.stringify(diag, null, 2));
console.log("CONSOLE ISSUES (first 25):");
for (const l of logs.slice(0, 25)) console.log("  " + l.slice(0, 220));
if (pageErrors.length) {
  console.log("PAGE ERRORS (first 5):");
  for (const e of pageErrors.slice(0, 5)) console.log("  " + e.slice(0, 300));
}

await browser.close();
