/**
 * Diagnose: which map taps place a spawn point under mobile emulation,
 * and which DOM element actually receives the pointer at each spot.
 * Temporary probe for the "middle of the map doesn't register taps" bug.
 */
import puppeteer from "puppeteer";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = 4250;
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".glb": "model/gltf-binary", ".mp3": "audio/mpeg", ".png": "image/png", ".wasm": "application/wasm" };
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  let fp = path.join(here, "dist", url === "/" ? "index.html" : decodeURIComponent(url));
  fs.readFile(fp, (e, d) => {
    if (e) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(fp)] || "application/octet-stream" });
    res.end(d);
  });
});
await new Promise((r) => server.listen(PORT, r));

const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 600000,
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage();
await page.emulate({
  viewport: { width: 812, height: 375, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
});
page.on("console", (m) => { if (m.type() === "error") console.log("  [page error]", m.text().slice(0, 160)); });
await page.goto(`http://127.0.0.1:${PORT}/?devtest=1`, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => {
  const b = document.getElementById("startBtn");
  return !!window.SKY_DEV && b && !b.disabled;
}, { timeout: 120000, polling: 500 });

await page.click("#startBtn");
await page.waitForFunction(() =>
  !document.getElementById("spawnInstruction").classList.contains("hidden"),
  { timeout: 90000, polling: 500 });
await new Promise((r) => setTimeout(r, 1000));
const state = await page.evaluate(() => window.SKY_DEV.currentState);
console.log("state after start:", state);

// What intercepts pointer events at each probe spot?
const pts = [
  ["center", 406, 187], ["left-mid", 120, 187], ["right-mid", 690, 187],
  ["top-center", 406, 60], ["mid-center-low", 406, 140], ["low-center", 406, 260],
  ["low-left", 120, 300], ["low-right", 690, 300], ["far-left", 40, 187], ["far-right", 780, 187],
];
const intercept = await page.evaluate((pts) => pts.map(([name, x, y]) => {
  const el = document.elementFromPoint(x, y);
  const path = [];
  let n = el;
  while (n && path.length < 4) { path.push(n.id ? `#${n.id}` : n.className || n.tagName); n = n.parentElement; }
  return `${name} (${x},${y}) -> ${path.join(" < ")}`;
}), pts);
console.log("\nelementFromPoint:\n" + intercept.join("\n"));

// Tap each spot with REAL touch; after a placement the confirm button appears.
// Re-hide it before every tap so each result is per-tap.
console.log("\ntap results:");
for (const [name, x, y] of pts) {
  const st = await page.evaluate(() => window.SKY_DEV.currentState);
  if (st !== "PICK_SPAWN") { console.log(`  SKIP  ${name} (${x},${y})  state=${st}`); continue; }
  await page.evaluate(() => window.SKY_DEV.viewer.camera.cancelFlight()); // settle any flyTo
  await page.evaluate(() => document.getElementById("confirmSpawnBtn").classList.add("hidden"));
  await page.touchscreen.tap(x, y);
  await new Promise((r) => setTimeout(r, 800));
  const placed = await page.evaluate(() => !document.getElementById("confirmSpawnBtn").classList.contains("hidden"));
  const diag = await page.evaluate(({ x, y }) => {
    const v = window.SKY_DEV.viewer;
    const rectOf = (el) => el ? el.getBoundingClientRect() : null;
    const inRect = (r, pad, extraTop = 0, extraBottom = 0) => !!r &&
      x >= r.left - pad && x <= r.right + pad && y >= r.top - pad - extraTop && y <= r.bottom + pad + extraBottom;
    const search = rectOf(document.getElementById("locationSearch"));
    const confirm = rectOf(document.getElementById("confirmSpawnBtn"));
    const zoom = rectOf(document.getElementById("zoom-controls"));
    // Same picking the handler does.
    const pos = { x, y };
    let globeHit = "n/a", entityPicked;
    try {
      const ray = v.camera.getPickRay(pos);
      globeHit = v.scene.globe.pick(ray, v.scene) ? "hit" : "NULL";
    } catch (e) { globeHit = "err " + e.message; }
    try { entityPicked = v.scene.pick(pos) ? "entity" : "none"; } catch (e) { entityPicked = "err"; }
    return {
      exSearch: inRect(search, 20, 40, 100), exConfirm: inRect(confirm, 20), exZoom: inRect(zoom, 12),
      searchRect: search && [search.left, search.top, search.right, search.bottom].map(Math.round),
      zoomRect: zoom && [zoom.left, zoom.top, zoom.right, zoom.bottom].map(Math.round),
      globeHit, entityPicked,
      hitEl: (() => { const e = document.elementFromPoint(x, y); return e ? (e.id ? "#" + e.id : e.className || e.tagName) : "none"; })(),
      state: window.SKY_DEV.currentState,
      spawnHidden: document.getElementById("spawnInstruction").classList.contains("hidden"),
    };
  }, { x, y });
  console.log(`  ${placed ? "OK  " : "FAIL"}  ${name} (${x},${y})  ${JSON.stringify(diag)}`);
}

await browser.close();
server.close();
process.exit(0);
