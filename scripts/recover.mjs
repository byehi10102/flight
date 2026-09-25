import puppeteer from "puppeteer";

// Prove the render loop survives: after the failure the scene must keep
// updating (pixel content changes, building count still grows, camera tracks).
const browser = await puppeteer.launch({
  headless: false,
  args: ["--no-sandbox", "--window-size=900,600"],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 600 });
const log = [];
page.on("console", (m) => {
  const t = m.text();
  if (/\[render\]|Invalid array length|recovered/i.test(t)) log.push(t.slice(0, 120));
});
await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction("!!window.SKYWARD", { timeout: 30000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(8000);

const sample = () =>
  page.evaluate(() => {
    const cv = document.querySelector("#cesiumContainer canvas");
    const gl = cv.getContext("webgl2") || cv.getContext("webgl");
    const w = cv.width, h = cv.height;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let sum = 0, n = 0;
    const seen = new Set();
    for (let i = 0; i < buf.length; i += 4 * 53) {
      sum += buf[i] + buf[i + 1] + buf[i + 2];
      seen.add((buf[i] >> 4) * 256 + (buf[i + 1] >> 4) * 16 + (buf[i + 2] >> 4));
      n++;
    }
    const S = window.SKYWARD;
    return {
      checksum: sum,
      colors: seen.size,
      buildings: S.buildings.buildingCount,
      camH: +S.viewer.scene.camera.positionCartographic.height.toFixed(0),
      planeAlt: +S.plane.alt.toFixed(0),
    };
  });

console.log("Seattle      :", JSON.stringify(await sample()));
await page.evaluate(() => window.SKYWARD.jumpTo({ lat: 40.7549, lon: -73.984, height: 280 }));
for (const t of [8, 16, 24, 34, 46]) {
  await sleep(t === 8 ? 8000 : 10000);
  console.log(`  t=${t}s      :`, JSON.stringify(await sample()));
}
console.log("\nrender log:");
console.log(log.length ? [...new Set(log)].slice(0, 6).join("\n") : "(none)");
await browser.close();
