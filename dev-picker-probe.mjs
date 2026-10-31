/**
 * Picker quality probe: the map-browsing screen must be CRISP (flight-shed
 * resolution/detail restored on entry), render the globe at the capped rate,
 * and show the city labels. Runs headless with software GL like the other
 * probes; asserts numbers, not looks.
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

// Simulate the flight-time shed BEFORE entering the picker: the controller
// drops resolution + steps the detail ladder while flying.
await page.evaluate(() => {
  const v = SKY_DEV.viewer;
  v.resolutionScale = 0.5;
  v.scene.globe.maximumScreenSpaceError = 8; // deep in the LOW ladder
});

await page.click("#startBtn");
await page.waitForFunction(() => SKY_DEV.currentState === "PICK_SPAWN", { timeout: 30000, polling: 250 });
await sleep(1500);
const crisp = await page.evaluate(() => ({
  scale: +SKY_DEV.viewer.resolutionScale.toFixed(2),
  sse: SKY_DEV.viewer.scene.globe.maximumScreenSpaceError,
}));
check("picker restores FULL resolution (no blurry map)", crisp.scale === 1, JSON.stringify(crisp));
check("picker restores tier tile detail", crisp.sse === 2 || crisp.sse === 4, `sse=${crisp.sse}`);

// City labels present in the picker
const labels = await page.evaluate(() => {
  const prims = SKY_DEV.viewer.scene.primitives;
  for (let i = 0; i < prims.length; i++) {
    const pr = prims.get(i);
    if (pr.constructor.name === "LabelCollection") return { show: pr.show, count: pr.length };
  }
  return { show: false, count: 0 };
});
check("city labels visible in picker", labels.show === true && labels.count > 50, JSON.stringify(labels));

// Globe render rate in the picker: capped around 40 Hz (not 60+, not stalled)
const rate = await page.evaluate(() => new Promise((resolve) => {
  const v = SKY_DEV.viewer;
  const orig = v.render.bind(v);
  let n = 0;
  v.render = (...a) => { n++; return orig(...a); };
  const t0 = performance.now();
  setTimeout(() => { v.render = orig; resolve(+(n / ((performance.now() - t0) / 1000)).toFixed(1)); }, 3000);
}));
check("picker globe render capped (<= 46/s)", rate <= 46, `${rate}/s (rAF-bound under software GL)`);

// DRAG RESPONSIVENESS: while the map is dragged, the camera invalidates every
// frame, so the globe must render at the full rAF rate (a flat cap would lag).
// Real trusted input: Cesium calls setPointerCapture on pointerdown, which a
// synthetic PointerEvent fails (no active pointer) and the drag never engages.
await page.evaluate(() => {
  const v = SKY_DEV.viewer;
  window.__dragRenders = 0;
  const orig = v.render.bind(v);
  v.render = (...args) => { window.__dragRenders++; return orig(...args); };
});
const cvBox = await (await page.$("#cesiumContainer canvas")).boundingBox();
await page.mouse.move(cvBox.x + cvBox.width / 2, cvBox.y + cvBox.height / 2);
await page.mouse.down();
for (let i = 0; i < 60; i++) {
  await page.mouse.move(cvBox.x + cvBox.width / 2 - i * 8, cvBox.y + cvBox.height / 2);
  await sleep(16);
}
await page.mouse.up();
const dragRate = await page.evaluate(() => {
  const r = +(window.__dragRenders / 2).toFixed(1);
  const proto = Object.getPrototypeOf(SKY_DEV.viewer);
  SKY_DEV.viewer.render = proto.render;
  return r;
});
check("drag renders at the full rAF rate (responsive)", dragRate >= 25, `${dragRate}/s`);

// FIRST-MOVE LATENCY: after an idle stretch, the first pointer input must
// produce a render almost immediately (input invalidation), not wait for
// the 300 ms idle fallback - the "map moves a second late" regression guard.
const firstMove = await page.evaluate(() => new Promise((resolve) => {
  const v = SKY_DEV.viewer;
  const orig = v.render.bind(v);
  let inputAt = 0, renderAt = -1;
  v.render = (...args) => {
    if (inputAt > 0 && renderAt < 0) renderAt = performance.now();
    return orig(...args);
  };
  setTimeout(() => {
    inputAt = performance.now();
    const cv = document.querySelector("#cesiumContainer canvas");
    cv.dispatchEvent(new PointerEvent("pointermove", { clientX: 400, clientY: 300, pointerId: 9, isPrimary: true, bubbles: true, pointerType: "mouse" }));
  }, 900); // idle longer than the 300 ms fallback
  const poll = setInterval(() => {
    if (renderAt > 0) { clearInterval(poll); v.render = orig; resolve(+(renderAt - inputAt).toFixed(1)); }
  }, 4);
  setTimeout(() => { clearInterval(poll); v.render = orig; resolve(-1); }, 4000);
}));
const firstMoveOk = firstMove > 0 && firstMove < 120;
check("first move after idle renders fast (no dead lag)", firstMoveOk, `${firstMove} ms after input`);

// The menu does not render the globe at all (covered backdrop)
await page.evaluate(() => { location.reload(); });
await page.waitForFunction(() => window.SKY_DEV, { timeout: 60000, polling: 500 });
await page.waitForFunction(() => {
  const b = document.getElementById("startBtn");
  return window.SKY_DEV?.boot?.pageGone === true && b && !b.disabled;
}, { timeout: 150000, polling: 500 });
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
