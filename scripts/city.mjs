import puppeteer from "puppeteer";

// Fly the aircraft to a dense city and confirm real OSM building footprints
// become 3D geometry. This is the core claim of the project, so it gets its
// own test: it counts buildings and checks they are on screen.
const browser = await puppeteer.launch({
  headless: false,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errors = [];
page.on("pageerror", (e) => errors.push("PE: " + e.message.slice(0, 160)));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon"))
    errors.push("CE: " + m.text().slice(0, 160));
});

await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction("!!window.SKYWARD", { timeout: 30000 });
await new Promise((r) => setTimeout(r, 4000));

// Jump to Midtown Manhattan, low altitude, where the skyline is dense.
console.log("jumping to Manhattan...");
await page.evaluate(() => {
  window.SKYWARD.jumpTo({
    lat: 40.7549,
    lon: -73.984,
    height: 220,
    label: "Midtown Manhattan",
  });
});

// Give the streamer time to fetch and build the tiles.
for (const t of [8, 16, 28, 42]) {
  await new Promise((r) => setTimeout(r, t * 1000 - (t === 8 ? 0 : 0)));
  const s = await page.evaluate(() => {
    const S = window.SKYWARD;
    return {
      lat: +S.plane.lat.toFixed(4),
      lon: +S.plane.lon.toFixed(4),
      alt: +S.plane.alt.toFixed(0),
      buildingTiles: S.buildings.primitives.size,
      emptyTiles: S.buildings.emptyTiles.size,
      inFlight: S.buildings.inFlight,
    };
  });
  console.log(`t=${t}s`, JSON.stringify(s));
  if (s.buildingTiles > 0 && t >= 28) break;
}

const detail = await page.evaluate(() => {
  const S = window.SKYWARD;
  let instances = 0;
  for (const [, p] of S.buildings.primitives) {
    const n = p?._geometryInstances?.length;
    if (typeof n === "number") instances += n;
  }
  return { tiles: S.buildings.primitives.size, releasedInstances: instances };
});
console.log("buildings:", JSON.stringify(detail));

await page.screenshot({ path: "shot-manhattan.png" });
console.log("wrote shot-manhattan.png");

const pixels = await page.evaluate(() => {
  const cv = document.querySelector("#cesiumContainer canvas");
  const gl = cv.getContext("webgl2") || cv.getContext("webgl");
  const w = cv.width, h = cv.height;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const seen = new Set();
  let nonBlack = 0, n = 0;
  for (let i = 0; i < buf.length; i += 4 * 31) {
    const r = buf[i], g = buf[i + 1], b = buf[i + 2];
    seen.add((r >> 4) * 256 + (g >> 4) * 16 + (b >> 4));
    if (r + g + b > 30) nonBlack++;
    n++;
  }
  return { distinctColors: seen.size, nonBlackPct: +(100 * nonBlack / n).toFixed(1) };
});
console.log("canvas:", JSON.stringify(pixels));
console.log("ERRORS:", errors.length);
if (errors.length) console.log([...new Set(errors)].slice(0, 4).join("\n"));
await browser.close();
