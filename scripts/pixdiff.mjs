import puppeteer from "puppeteer";

// Does the aircraft actually RENDER, or not?
//
// A screenshot and an opinion about it is weak evidence, especially since
// `vision_analyze` has timed out repeatedly here and confidently described a
// "boat" in a runway frame. This is objective: capture the same frame twice,
// once with the model visible and once with `show = false`, and diff the
// pixels. Any difference is the aircraft, and its size and location are
// measured rather than guessed.
const browser = await puppeteer.launch({
  headless: false,
  args: ["--no-sandbox", "--window-size=1000,700"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1000, height: 700 });
await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction("!!window.SKYWARD", { timeout: 40000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(10000);

// Put the aircraft in clear air over a city, well above the terrain and any
// buildings. If it is invisible on the runway but visible here, the aeroplane
// is being buried inside the terrain mesh rather than failing to draw.
const where = process.argv[2] || "ground";
if (where === "air") {
  await page.evaluate(() => {
    window.SKYWARD.jumpTo({ lon: -73.985, lat: 40.748, alt: 600, name: "Midtown" });
  });
  await sleep(26000);
}
const alt = await page.evaluate(() => ({
  alt: +window.SKYWARD.plane.alt.toFixed(1),
  onGround: window.SKYWARD.plane.onGround,
  buildings: window.SKYWARD.buildings.buildingCount,
  tiles: window.SKYWARD.buildings.primitives.size,
}));
console.log("state:", JSON.stringify(alt));

/** Raw pixels of the central region, as a compact base64 PNG. */
const grab = () =>
  page.evaluate(async () => {
    const scene = window.SKYWARD.viewer.scene;
    scene.render();
    const gl = scene.context._gl;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    // The WHOLE drawing buffer, not the middle.
    //
    // Sampling only the centre reported "the model does not draw" while the
    // real situation was that it draws somewhere else entirely — exactly the
    // bug this test is meant to find. Measuring where the aircraft actually
    // lands is the entire point.
    const rw = w;
    const rh = h;
    const rx = 0;
    const ry = 0;
    const buf = new Uint8Array(rw * rh * 4);
    gl.readPixels(rx, ry, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    // Pack to a binary string the caller can hash cheaply.
    let s = "";
    const CH = 0x8000;
    for (let i = 0; i < buf.length; i += CH) {
      s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
    }
    return { data: btoa(s), w: rw, h: rh, fullW: w, fullH: h };
  });

const shot = async (label) => {
  const g = await grab();
  console.log(`${label}: ${g.w}x${g.h} full frame (buffer ${g.fullW}x${g.fullH})`);
  return g;
};

// Freeze the app's animation loop first.
//
// Two grabs taken seconds apart differ across ~60% of the frame purely because
// terrain tiles keep streaming and the camera keeps moving. That noise is
// larger than the aircraft and completely swamps it, which is how a 417,681
// pixel "difference" came back for a model that draws nothing. Stop the loop,
// then drive `render()` by hand so the scene is identical except for the
// model.
await page.evaluate(() => {
  window.__raf = window.requestAnimationFrame;
  window.requestAnimationFrame = () => 0;
});
await sleep(900);

const withModel = await shot("model shown ");

// Hide the model and render one frame without it.
await page.evaluate(() => {
  window.SKYWARD.aircraft.model.show = false;
  window.SKYWARD.viewer.scene.render();
});
await sleep(300);
const withoutModel = await shot("model hidden");

// Restore, and prove the freeze worked by sampling twice with the model shown.
await page.evaluate(() => {
  window.SKYWARD.aircraft.model.show = true;
  window.SKYWARD.viewer.scene.render();
});
await sleep(300);
const withModelAgain = await shot("model shown again ");

// Count differing pixels.
const total = withModel.w * withModel.h;
let diff = 0;
let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
const a = Buffer.from(withModel.data, "base64");
const b = Buffer.from(withoutModel.data, "base64");
if (a.length === b.length) {
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (d > 12) {
      diff++;
      const px = (i / 4) % withModel.w;
      const py = Math.floor(i / 4 / withModel.w);
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  }
}
// Control: two frames with the model VISIBLE must be identical under the
// freeze. If they are not, the scene is still moving and every number below is
// noise.
const a2 = Buffer.from(withModelAgain.data, "base64");
let control = 0;
if (a.length === a2.length) {
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.abs(a[i] - a2[i]) + Math.abs(a[i + 1] - a2[i + 1]) + Math.abs(a[i + 2] - a2[i + 2]);
    if (d > 12) control++;
  }
}
console.log(`\ncontrol (model shown twice): ${control} differing pixels`);
if (control > total * 0.001) {
  console.log("=> the scene is NOT static; the comparison below is meaningless");
}
// A real CRJ-900 at chase range covers thousands of pixels. Anything under a
// few hundred means it is not being drawn, however healthy the model object
// looks.
const MIN_PIXELS = 2000;
const drawn = diff >= MIN_PIXELS && control <= total * 0.001;
console.log(`\ndiffering pixels: ${diff} of ${total} (${((diff / total) * 100).toFixed(2)}%)`);
if (!drawn) {
  console.log(`=> NOT DRAWN (or scene not static). Model options that suppress it:`);
  console.log(`   minimumPixelSize / maximumScale / distanceDisplayCondition on Model.fromGltfAsync.`);
} else {
  console.log(`bounding box in full frame: x ${minX}..${maxX}, y ${minY}..${maxY}`);
  console.log(`frame centre is x ${withModel.w / 2}, y ${withModel.h / 2}`);
  console.log(`=> ${maxX - minX + 1} x ${maxY - minY + 1} px`);
  await page.screenshot({ path: "shots/20-model-drawing.png" });
  console.log("=> the model IS drawing.");
}
console.log(`\n${drawn ? "PASS" : "FAIL"}  model draws pixels`);
await browser.close();
process.exit(drawn ? 0 : 1);
