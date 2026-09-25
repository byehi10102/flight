// Does the sun actually shade the buildings? Sample the same building faces
// with the sun high and low and measure how much the rendered luminance moves.
// Unlit massing (flat:true) barely changes; lit massing changes a lot.
import puppeteer from "puppeteer";

const browser = await puppeteer.launch({
  headless: false,
  args: ["--no-sandbox", "--window-size=900,600"],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 600 });
await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction("!!window.SKYWARD", { timeout: 30000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Midtown, low over the rooftops, so buildings fill the frame.
await page.evaluate(() => window.SKYWARD.jumpTo({ lat: 40.7549, lon: -73.984, height: 150 }));
await sleep(30000);

const sample = () =>
  page.evaluate(() => {
    const cv = document.querySelector("#cesiumContainer canvas");
    const gl = cv.getContext("webgl2") || cv.getContext("webgl");
    const w = cv.width, h = cv.height;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let sum = 0, n = 0;
    const hist = new Array(16).fill(0);
    for (let i = 0; i < buf.length; i += 4 * 17) {
      const l = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
      sum += l;
      hist[Math.min(15, l / 16 | 0)]++;
      n++;
    }
    return { meanLuma: +(sum / n).toFixed(2), hist, buildings: window.SKYWARD.buildings.buildingCount };
  });

const setSun = (elev, azim) =>
  page.evaluate(([e, a]) => {
    const C = window.Cesium;
    const S = window.SKYWARD.viewer.scene;
    const h = C.Cartographic.fromDegrees(-73.984, 40.7549);
    const carto = new C.Cartographic(h.longitude, h.latitude, 1000);
    const enu = C.Transforms.eastNorthUpToFixedFrame(
      C.Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height),
    );
    const rot = C.Matrix4.getMatrix3(enu, new C.Matrix3());
    const m = C.Matrix3.fromRotationZ(C.Math.toRadians(a), new C.Matrix3());
    C.Matrix3.multiply(rot, m, rot);
    const pos = C.Matrix4.getTranslation(enu, new C.Cartesian3());
    const dir = C.Matrix3.getColumn(rot, 2, new C.Cartesian3());
    S.light.direction = C.Cartesian3.negate(dir, new C.Cartesian3());
    S.light.position = C.Cartesian3.multiplyByScalar(
      S.light.direction, 100000, new C.Cartesian3(),
    );
    void e; void pos;
  }, [elev, azim]);

console.log("buildings:", (await sample()).buildings);
for (const [name, azim] of [["noon-ish", 20], ["low raking", 115], ["back-lit", 250]]) {
  await setSun(45, azim);
  await sleep(2500);
  const s = await sample();
  const spread = s.hist.filter((v) => v > 0).length;
  console.log(`${name.padEnd(12)} meanLuma=${String(s.meanLuma).padStart(7)}  tonalBands=${spread}/16`);
}
await browser.close();
