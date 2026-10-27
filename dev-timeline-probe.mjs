/**
 * Timeline repro: where in the flow does the frame rate actually die?
 * 5-second buckets from SPAWN click through the dive and the first 60 s of
 * full-throttle flight, plus a picker-pan sample. User's viewport (dpr 1.5).
 */
import puppeteer from "puppeteer-core";
const GAME_URL = "http://127.0.0.1:5173/?devtest=1";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: false, protocolTimeout: 600000,
  args: ["--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required", "--window-size=1930,1130", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 740, deviceScaleFactor: 1.5 });
await page.goto(GAME_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.SKY_DEV, { timeout: 60000, polling: 500 });
await page.waitForFunction(() => {
  const b = document.getElementById("startBtn");
  return window.SKY_DEV?.boot?.pageGone === true && b && !b.disabled;
}, { timeout: 150000, polling: 500 });

// Picker pan: hold a drag across the map while sampling.
await page.evaluate(() => document.getElementById("startBtn").click());
await page.waitForFunction(() => SKY_DEV.currentState === "PICK_SPAWN", { timeout: 30000, polling: 250 });
await sleep(5000);
const panSample = page.evaluate(() => new Promise((resolve) => {
  const d = []; let last = performance.now(); const t0 = last;
  // synthetic drag: pointer events on the canvas
  const cv = document.getElementById("cesiumContainer")?.querySelector("canvas");
  const fire = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, isPrimary: true, bubbles: true, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1 }));
  let x = 300, y = 300;
  fire("pointerdown", x, y);
  const iv = setInterval(() => { x -= 12; fire("pointermove", x, y); }, 16);
  (function tick(t) { d.push(t - last); last = t;
    if (t - t0 < 6000) requestAnimationFrame(tick);
    else { clearInterval(iv); fire("pointerup", x, y); d.sort((a,b)=>a-b);
      resolve({ n: d.length, fps: +(d.length/6).toFixed(1), p50: +d[d.length>>1].toFixed(1), p95: +d[Math.floor(d.length*0.95)].toFixed(1) }); }
  })(performance.now());
}));
console.log("PICKER PAN 6s:", JSON.stringify(await panSample));

// back to centre-ish spawn and launch; timeline buckets from click
await page.evaluate(() => SKY_DEV.placeSpawn(-118.2437, 34.0522, "Los Angeles"));
await sleep(400);
const t0 = Date.now();
await page.evaluate(() => document.getElementById("confirmSpawnBtn")?.click());
await page.keyboard.down("w");
// Sample 5s buckets for 75 s regardless of state, tagging state.
for (let i = 0; i < 15; i++) {
  await sleep(5000);
  const b = await page.evaluate((el) => new Promise((resolve) => {
    const d = []; let last = performance.now(); const t0 = last;
    (function tick(t) { d.push(t - last); last = t;
      if (t - t0 < 5000) requestAnimationFrame(tick);
      else { d.sort((a,b)=>a-b); resolve({ st: SKY_DEV.currentState, n: d.length, fps: +(d.length/5).toFixed(1), p95: +d[Math.floor(d.length*0.95)].toFixed(1), scale: SKY_DEV.perf?.report?.().scale, mini: SKY_DEV.miniViewer ? SKY_DEV.miniViewer.scene.globe.tilesLoaded : null }); }
    })(performance.now());
  }), i);
  console.log(`t+${Math.round((Date.now()-t0)/1000)}s`, JSON.stringify(b));
}
await browser.close();
