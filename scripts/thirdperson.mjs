import puppeteer from "puppeteer";

// ────────────────────────────────────────────���────────────────────────────────
// Is the aeroplane actually shown in a third-person view FROM BEHIND?
//
// "Is it on screen" and "is it behind us" are different questions, and only
// the first is easy. A chase camera parked abeam the aircraft shows a
// perfectly legible aeroplane that is useless as a third-person view.
//
// So project the airframe's own key points — nose, tail, both wingtips — into
// screen pixels with Cesium's own `worldToWindowCoordinates`, and check the
// geometry of the result:
//
//   * from directly behind, the two wingtips straddle the centreline
//     symmetrically, because the wings run across the view;
//   * from abeam, one wingtip is near and one far, and the nose sits to one
//     side;
//   * the nose must be FARTHER from the camera than the tail, or we are looking
//     at the aircraft's face.
// ─────────────────────────────────────────────────────────────────────────────

const results = [];
const check = (name, pass, detail) => {
  results.push({ pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name.padEnd(44)} ${detail}`);
};

const browser = await puppeteer.launch({
  headless: false,
  args: ["--no-sandbox", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message.slice(0, 120)));
await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction("!!window.SKYWARD", { timeout: 40000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(12000);

/** Screen position of a point given in the airframe's local frame. */
const frame = () =>
  page.evaluate(() => {
    const S = window.SKYWARD;
    const { SceneTransforms, Matrix4, Cartesian3 } = S.cesium;
    const scene = S.viewer.scene;
    const m = S.aircraft.lastMatrix;
    const M = [];
    for (let i = 0; i < 16; i++) M.push(Number(m[i]));
    const scale = S.CONFIG.aircraft.modelScale;

    const toWorld = (c) =>
      new Cartesian3(
        M[0] * c[0] * scale + M[4] * c[1] * scale + M[8] * c[2] * scale + M[12],
        M[1] * c[0] * scale + M[5] * c[1] * scale + M[9] * c[2] * scale + M[13],
        M[2] * c[0] * scale + M[6] * c[1] * scale + M[10] * c[2] * scale + M[14],
      );
    const win = (c) => {
      const p = SceneTransforms.worldToWindowCoordinates(scene, toWorld(c));
      return p ? { x: Math.round(p.x), y: Math.round(p.y) } : null;
    };
    const dist = (c) => {
      const w = toWorld(c);
      const cam = scene.camera.position;
      return Math.hypot(w.x - cam.x, w.y - cam.y, w.z - cam.z);
    };

    // Local frame: +Y nose, +X right wing, +Z up, origin at the physics point.
    //
    // These are AUTHORED units, because `toWorld` multiplies by the model
    // scale. Writing metres here and scaling again put the wingtips 132 m out
    // and projected them to x = -2692 and x = +3972, which looked like a
    // spectacular framing failure and was really a units mistake in the test.
    // The airframe is already centred, hence the +/- 1.825 rather than 0..3.652.
    const P = {
      nose: [0, 1.825, 0],
      tail: [0, -1.825, 0],
      wingL: [-1.168, 0, 0],
      wingR: [1.168, 0, 0],
    };
    const out = { screen: {}, dist: {} };
    for (const k of Object.keys(P)) {
      out.screen[k] = win(P[k]);
      out.dist[k] = +dist(P[k]).toFixed(1);
    }
    out.width = scene.drawingBufferWidth;
    out.height = scene.drawingBufferHeight;
    out.camHeading = +(((scene.camera.heading * 180) / Math.PI + 360) % 360).toFixed(1);
    out.planeHeading = +(((S.plane.heading * 180) / Math.PI + 360) % 360).toFixed(1);
    out.alt = +S.plane.alt.toFixed(1);
    out.onGround = S.plane.onGround;
    return out;
  });

const report = (label, f) => {
  const s = f.screen;
  const cx = s.wingL && s.wingR ? (s.wingL.x + s.wingR.x) / 2 : null;
  const allIn = Object.values(s).every((p) => p && p.x >= 0 && p.x <= f.width && p.y >= 0 && p.y <= f.height);
  const sym = s.wingL && s.wingR ? Math.abs(s.wingL.x + s.wingR.x - 2 * (f.width / 2)) : null;
  return {
    label,
    allIn,
    cx,
    sym,
    behind: f.dist.nose > f.dist.tail,
    spread: s.wingL && s.wingR ? Math.abs(s.wingL.x - s.wingR.x) : null,
    f,
  };
};

const r0 = report("on the runway", await frame());
console.log(
  `  on runway: nose ${JSON.stringify(r0.f.screen.nose)} tail ${JSON.stringify(r0.f.screen.tail)}\n` +
  `             wingL ${JSON.stringify(r0.f.screen.wingL)} wingR ${JSON.stringify(r0.f.screen.wingR)}\n` +
  `             dist nose ${r0.f.dist.nose} m / tail ${r0.f.dist.tail} m, frame ${r0.f.width}x${r0.f.height}`,
);

check("whole aeroplane inside the viewport", r0.allIn, `frame ${r0.f.width}x${r0.f.height}`);
check(
  "viewed from BEHIND, not the front",
  r0.behind,
  `nose ${r0.f.dist.nose} m from camera vs tail ${r0.f.dist.tail} m`,
);
check(
  "wings read across the view (symmetric)",
  r0.sym !== null && r0.sym < 90,
  `wingtips at x ${r0.f.screen.wingL?.x} and ${r0.f.screen.wingR?.x}, ${r0.sym?.toFixed(0)} px off centre, span ${r0.spread} px`,
);
check(
  "camera heading matches the aeroplane",
  Math.abs(((r0.f.camHeading - r0.f.planeHeading + 540) % 360) - 180) < 12,
  `camera ${r0.f.camHeading} deg, aircraft ${r0.f.planeHeading} deg`,
);

// Airborne, where banking makes the geometry hardest.
// Rotate the way it is actually flown: full throttle to the rotation speed,
// then nose up. Mashing ArrowUp from a standstill pitches the aeroplane past
// its stall angle while it is still at taxi speed, and it never rotates —
// which reads as a camera bug when it is a technique one.
const vRot = await page.evaluate(() => window.SKYWARD.CONFIG.physics.rotationSpeed);
await page.keyboard.down("KeyW");
let spd = 0;
for (let i = 0; i < 24 && spd < vRot; i++) {
  await sleep(2500);
  spd = await page.evaluate(() => window.SKYWARD.plane.speed);
}
await page.keyboard.down("ArrowUp");
await sleep(8000);
await page.keyboard.up("ArrowUp");
await sleep(8000);
const air0 = await page.evaluate(() => ({
  onGround: window.SKYWARD.plane.onGround,
  alt: window.SKYWARD.plane.alt,
}));
for (let i = 0; i < 8 && air0.onGround; i++) {
  await sleep(1500);
  air0.onGround = await page.evaluate(() => window.SKYWARD.plane.onGround);
  air0.alt = await page.evaluate(() => window.SKYWARD.plane.alt);
}
const r1 = report("airborne", await frame());
console.log(
  `\n  airborne: nose ${JSON.stringify(r1.f.screen.nose)} tail ${JSON.stringify(r1.f.screen.tail)}\n` +
  `             wingL ${JSON.stringify(r1.f.screen.wingL)} wingR ${JSON.stringify(r1.f.screen.wingR)}\n` +
  `             dist nose ${r1.f.dist.nose} m / tail ${r1.f.dist.tail} m, alt ${r1.f.alt} m`,
);
check("still fully in frame while airborne", r1.allIn, `alt ${r1.f.alt} m`);
check("still viewed from behind", r1.behind, `nose ${r1.f.dist.nose} m vs tail ${r1.f.dist.tail} m`);
check(
  "airborne: is actually off the ground",
  !r1.f.onGround && r1.f.alt > 60,
  `alt ${r1.f.alt} m, onGround=${r1.f.onGround}`,
);
await page.keyboard.up("KeyW");

console.log("\nconsole errors:", errors.length ? [...new Set(errors)].slice(0, 4).join(" | ") : "(none)");
const passed = results.filter((x) => x.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
