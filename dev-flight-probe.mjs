/**
 * Flight smoke on the real flow: menu -> picker -> spawn -> FLYING, then the
 * tactical minimap must STAY loaded while the globe streams at speed (the
 * starvation fix), and cruise holds the 250 mph envelope.
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

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? "  — " + detail : ""}`); }
};

await page.goto(GAME_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.SKY_DEV, { timeout: 60000, polling: 500 });
await page.waitForFunction(() => {
  const b = document.getElementById("startBtn");
  return window.SKY_DEV?.boot?.pageGone === true && b && !b.disabled;
}, { timeout: 150000, polling: 500 });

// SINGLE PLAYER opens the picker directly (no vehicle screen)
await page.click("#startBtn");
await page.waitForFunction(() => SKY_DEV.currentState === "PICK_SPAWN", { timeout: 30000, polling: 250 });
check("SINGLE PLAYER opens the spawn picker directly", true);

await page.evaluate(() => SKY_DEV.placeSpawn(-98.5, 38.5, "Kansas"));
await sleep(500);
await page.evaluate(() => document.getElementById("confirmSpawnBtn")?.click());
await page.waitForFunction(() => SKY_DEV.currentState === "FLYING", { timeout: 120000, polling: 500 });
check("reaches FLYING", true);
await sleep(4000);
const plane = await page.evaluate(() => ({
  speed: Math.round(SKY_DEV.state.speed),
  alt: Math.round(SKY_DEV.state.alt),
  agl: Math.round(SKY_DEV.state.agl),
  physics: SKY_DEV.physics?.rotor === undefined ? "PlanePhysics" : "other",
}));
check("F-15 with plane physics", plane.physics === "PlanePhysics");
check("cruise speed settles at 250", plane.speed >= 245 && plane.speed <= 260, String(plane.speed));

// Minimap stays loaded at speed (the starvation fix): full throttle, 60 s.
await page.keyboard.down("w");
await sleep(60000);
const mini = await page.evaluate(() => ({
  tilesLoaded: SKY_DEV.miniViewer?.scene.globe.tilesLoaded,
  sse: SKY_DEV.miniViewer?.scene.globe.maximumScreenSpaceError,
  level: SKY_DEV.miniViewer?.imageryLayers.get(1)?.maximumLevel,
  speed: Math.round(SKY_DEV.state.speed),
  mainLoaded: SKY_DEV.viewer.scene.globe.tilesLoaded,
}));
// At 3000 mph the map view moves ~2.4 km/s: "every tile done" is never true
// for a moving map. The real starvation test is whether imagery is actually
// SHOWING - read the map canvas center pixels: blank (the old bug) reads as
// a flat dark base color; loaded imagery has contrast.
const miniPixels = await page.evaluate(() => {
  const mv = SKY_DEV.miniViewer;
  if (!mv) return { alive: false };
  const gl = mv.canvas.getContext("webgl2") || mv.canvas.getContext("webgl");
  if (!gl) return { alive: true, readback: "no-gl" };
  const w = mv.canvas.width, h = mv.canvas.height;
  const px = new Uint8Array(4 * 64 * 64);
  gl.readPixels((w >> 1) - 32, (h >> 1) - 32, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let mn = 255, mx = 0;
  for (let i = 0; i < px.length; i += 4) {
    const v = (px[i] + px[i + 1] + px[i + 2]) / 3;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  return { alive: true, contrast: mx - mn };
});
check("minimap SHOWS imagery at speed (no starvation)",
  miniPixels.alive === true && miniPixels.contrast > 12,
  JSON.stringify({ ...mini, contrast: miniPixels.contrast }));
console.log("MINIMAP AT SPEED:", JSON.stringify(mini));
await page.keyboard.up("w");

check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
