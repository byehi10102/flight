/**
 * Stress repro at the USER'S real condition: 1280x740 CSS @ dpr 1.5
 * (= 1920x1110 physical, matching their maximised window), dense city,
 * full throttle to 3000 mph, then boost.
 *
 * STRESS_FLAGS=softcomp  -> add --disable-gpu-compositing (the flag the
 * user's own Chrome renderer processes carry).
 */
import puppeteer from "puppeteer-core";

const GAME_URL = "http://127.0.0.1:5173/?devtest=1";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SOFTCOMP = process.env.STRESS_FLAGS === "softcomp";
const OUT = process.env.SHOT_DIR || ".";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = [
  "--no-first-run", "--no-default-browser-check",
  "--autoplay-policy=no-user-gesture-required",
  "--window-size=1930,1130",
  "--ignore-gpu-blocklist",
];
if (SOFTCOMP) args.push("--disable-gpu-compositing");

const browser = await puppeteer.launch({ executablePath: CHROME, headless: false, protocolTimeout: 600000, args });
const page = await browser.newPage();
// The user's real viewport: 1280x740 CSS at 150% scaling.
await page.setViewport({ width: 1280, height: 740, deviceScaleFactor: 1.5 });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });

await page.goto(GAME_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.SKY_DEV, { timeout: 60000, polling: 500 });
await page.waitForFunction(() => {
  const b = document.getElementById("startBtn");
  return window.SKY_DEV?.boot?.pageGone === true && b && !b.disabled;
}, { timeout: 150000, polling: 500 });
console.log("menu up");

await page.evaluate(() => document.getElementById("startBtn").click());
await page.waitForFunction(() => SKY_DEV.currentState === "PICK_SPAWN", { timeout: 30000, polling: 250 });
await sleep(7000);
const picker = await page.evaluate(() => new Promise((resolve) => {
  const d = []; let last = performance.now(); const t0 = last;
  (function tick(t) { d.push(t - last); last = t;
    if (t - t0 < 6000) requestAnimationFrame(tick);
    else { d.sort((a,b)=>a-b); resolve({ n: d.length, fps: +(d.length/6).toFixed(1), p50: +d[d.length>>1].toFixed(1), p95: +d[Math.floor(d.length*0.95)].toFixed(1) }); }
  })(performance.now());
}));
console.log(`${SOFTCOMP ? "[SOFTCOMP] " : ""}PICKER 6s:`, JSON.stringify(picker));

// Dense city spawn: downtown LA
await page.evaluate(() => SKY_DEV.placeSpawn(-118.2437, 34.0522, "Los Angeles"));
await sleep(600);
await page.evaluate(() => document.getElementById("confirmSpawnBtn")?.click());
await page.waitForFunction(() => SKY_DEV.currentState === "FLYING", { timeout: 120000, polling: 500 });
console.log("FLYING — full throttle for 40 s…");
await page.keyboard.down("w");
await sleep(40000);
const speedNow = await page.evaluate(() => SKY_DEV.state.speed);

const sample = (label) => page.evaluate((lbl) => new Promise((resolve) => {
  const d = []; let last = performance.now(); const t0 = last;
  (function tick(t) { d.push(t - last); last = t;
    if (t - t0 < 10000) requestAnimationFrame(tick);
    else { d.sort((a,b)=>a-b); resolve({ label: lbl, n: d.length, fps: +(d.length/10).toFixed(1), p50: +d[d.length>>1].toFixed(1), p95: +d[Math.floor(d.length*0.95)].toFixed(1), meanMs: +(d.reduce((a,b)=>a+b,0)/d.length).toFixed(1) }); }
  })(performance.now());
}), label);

const atSpeed = await sample("3000mph");
await page.screenshot({ path: `${OUT}/stress-flight.png` });

// Boost: 7000 mph
await page.keyboard.down(" ");
await sleep(1000);
await page.keyboard.up(" ");
await sleep(6000);
const atBoost = await sample("boost");
const speedBoost = await page.evaluate(() => SKY_DEV.state.speed);

const diag = await page.evaluate(() => ({
  dpr: window.devicePixelRatio,
  cesBuf: (() => { const c = SKY_DEV.viewer?.scene?.canvas; return c ? `${c.clientWidth}x${c.clientHeight} css / ${c.width}x${c.height} buf` : "none"; })(),
  miniBuf: (() => { const c = SKY_DEV.miniViewer?.canvas; return c ? `${c.width}x${c.height}` : "none"; })(),
  miniTilesLoaded: SKY_DEV.miniViewer ? SKY_DEV.miniViewer.scene.globe.tilesLoaded : null,
  mainQueue: SKY_DEV.viewer?.scene?.globe?._surface?._tileLoadQueueHigh?.length ?? "n/a",
  tilesLoaded: SKY_DEV.viewer?.scene?.globe?.tilesLoaded,
  perf: SKY_DEV.perf?.report?.(),
  imageryLevel: SKY_DEV.imageryLevel,
}));
console.log(`${SOFTCOMP ? "[SOFTCOMP] " : ""}speed=${Math.round(speedNow)}mph  AT-SPEED 10s:`, JSON.stringify(atSpeed));
console.log(`${SOFTCOMP ? "[SOFTCOMP] " : ""}speed=${Math.round(speedBoost)}mph  BOOST 10s:  `, JSON.stringify(atBoost));
console.log(`${SOFTCOMP ? "[SOFTCOMP] " : ""}DIAG:`, JSON.stringify(diag));

// Minimap canvas pixel check: is it actually drawing tiles?
const miniPixels = await page.evaluate(() => {
  const mv = SKY_DEV.miniViewer;
  if (!mv) return { alive: false };
  const gl = mv.canvas.getContext("webgl") || mv.canvas.getContext("webgl2");
  if (!gl) return { alive: true, readback: "no-gl" };
  const px = new Uint8Array(4 * 400);
  gl.readPixels((mv.canvas.width >> 1) - 10, (mv.canvas.height >> 1) - 10, 20, 20, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let nonzero = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 0) nonzero++;
  return { alive: true, buf: `${mv.canvas.width}x${mv.canvas.height}`, centerAlphaNonzero: `${nonzero}/400` };
});
console.log(`${SOFTCOMP ? "[SOFTCOMP] " : ""}MINIMAP:`, JSON.stringify(miniPixels));
console.log("errors:", errors.length ? errors.slice(0, 6) : "none");

await browser.close();
