import puppeteer from "puppeteer";

// Measure what is actually in the scene, rather than judging a screenshot.
const CITIES = [
  ["Seattle (runway)", null, null],
  ["Midtown Manhattan", 40.7549, -73.984],
  ["Sydney CBD", -33.8688, 151.2093],
];

const browser = await puppeteer.launch({
  headless: false,
  args: ["--no-sandbox", "--window-size=900,600"],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 600 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message.slice(0, 120)));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon"))
    errors.push(m.text().slice(0, 120));
});
await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction("!!window.SKYWARD", { timeout: 30000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(10000);

for (const [name, lat, lon] of CITIES) {
  const before = await page.evaluate(() => window.SKYWARD.buildings.buildingCount);
  if (lat !== null) {
    await page.evaluate(
      ([la, lo]) => window.SKYWARD.jumpTo({ lat: la, lon: lo, height: 280 }),
      [lat, lon],
    );
  }
  // Give the streamer time; poll until it stops growing.
  let last = -1;
  for (let i = 0; i < 8; i++) {
    await sleep(2000);
    const now = await page.evaluate(() => window.SKYWARD.buildings.buildingCount);
    if (now === last && i > 3) break;
    last = now;
  }
  const s = await page.evaluate(() => {
    const S = window.SKYWARD;
    const C = window.Cesium;
    const cam = S.viewer.scene.camera;
    const pl = S.plane;
    const planePos = C.Cartesian3.fromDegrees(pl.lon, pl.lat, pl.alt);
    const model = S.aircraft.model;
    return {
      buildings: S.buildings.buildingCount,
      tiles: S.buildings.primitives.size,
      camToPlane: +C.Cartesian3.distance(cam.position, planePos).toFixed(1),
      camHeight: +cam.positionCartographic.height.toFixed(0),
      planeAlt: +pl.alt.toFixed(0),
      modelReady: S.aircraft.ready,
      modelVisible: model ? model.show : false,
      terrainCache: S.groundSampler.cache.size,
    };
  });
  console.log(
    name.padEnd(22),
    `buildings=${String(s.buildings).padStart(6)}`,
    `tiles=${String(s.tiles).padStart(3)}`,
    `camDist=${String(s.camToPlane).padStart(7)}m`,
    `camH=${String(s.camHeight).padStart(6)}m`,
    `planeAlt=${String(s.planeAlt).padStart(5)}m`,
    `model=${s.modelReady ? "ready" : "pending"}/${s.modelVisible ? "shown" : "hidden"}`,
  );
}
console.log("\nerrors:", errors.length);
if (errors.length) console.log([...new Set(errors)].slice(0, 3).join("\n"));
await browser.close();
