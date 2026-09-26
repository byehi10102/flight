import puppeteer from "puppeteer";

// End-to-end acceptance test of the control scheme the user specified.
// Runs on the real GPU, drives the actual keyboard, and asserts that holding
// a key does the thing and releasing it stops the thing.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = (s) => sleep(s * 1000);

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
await sleep(7800);

const st = () =>
  page.evaluate(() => {
    const p = window.SKYWARD.plane;
    const r = (v, n = 2) => +Number(v).toFixed(n);
    return {
      lat: r(p.lat, 5), lon: r(p.lon, 5), alt: r(p.alt, 1), agl: r(p.alt, 1),
      speed: r(p.speed, 1), vs: r(p.verticalSpeed, 2),
      pitch: r(p.pitch, 4), roll: r(p.roll, 4),
      hdg: r((p.heading * 180) / Math.PI, 1),
      thr: r(p.throttle, 3), onGround: p.onGround,
    };
  });

const results = [];
// Heading is stored normalised to (-180, 180], so turning right past north
// wraps 180 -> -160. Compare the signed shortest angular difference instead of
// raw numbers, or every wraparound reads as a reversal.
const turned = (from, to) => ((to - from + 540) % 360) - 180;

const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name.padEnd(34)} ${detail}`);
};

const s0 = await st();
console.log("start:", JSON.stringify(s0));
check("spawns on a real runway", s0.onGround === true, `onGround=${s0.onGround} alt=${s0.alt}`);

// ── W: throttle up, speed builds ──────────────────────────────────────────
//
// The aircraft is a 38 t CRJ-900, so the takeoff roll is long: about 1.5 km and
// some 50 s to reach 140 kt. The previous version of this test waited a fixed
// 17 s and asserted a hard-coded 24 m/s rotation speed left over from the old
// 5 t light twin. It "passed" for a while and then reported 4/16, not because
// the controls broke but because every airborne check was being performed
// while the aeroplane was still on the ground with the roll at 12 m/s.
//
// So: read the rotation speed from the app's own config, and hold the throttle
// until it is actually reached rather than guessing a dwell time.
const vRot = await page.evaluate(() => window.SKYWARD.CONFIG.physics.rotationSpeed);
console.log(`rotation speed from config: ${vRot} m/s`);

await page.keyboard.down("w");
await sleep(4550);
const s1 = await st();
// 38 t and 59 kN is 1.54 m/s^2, less what rolling friction takes, so about
// 4.5 m/s in the first 4.5 s. The old assertion of >12 m/s in the same window
// was a light-twin number and this aeroplane will never satisfy it — correctly.
check("W accelerates", s1.speed > 2 && s1.thr > 0.2, `speed=${s1.speed} thr=${s1.thr}`);

let s2 = s1;
for (let i = 0; i < 24 && s2.speed < vRot; i++) {
  await sleep(2500);
  s2 = await st();
}
check("reaches rotation speed", s2.speed >= vRot, `speed=${s2.speed} m/s (V_rot=${vRot})`);

// Rotate at the real point, the way it is actually flown, then climb out.
await page.keyboard.down("ArrowUp");
await sleep(6000);
await page.keyboard.up("ArrowUp");
let s3 = await st();
for (let i = 0; i < 8 && s3.onGround; i++) {
  await sleep(1500);
  s3 = await st();
}
check("takes off (lift-off)", s3.onGround === false, `onGround=${s3.onGround} alt=${s3.alt} vs=${s3.vs}`);

// Let the climb establish before measuring anything.
//
// Immediately after rotation the aeroplane is barely above stall speed and is
// trading speed for climb, so vertical speed is still in its transient and
// samples anywhere from 0 to 3 m/s run to run. Sampling a transient measures
// the transient. Eight seconds at full throttle gets it into a steady climb.
await sleep(8000);
const settled = await st();
console.log(`settled in climb: alt=${settled.alt} vs=${settled.vs} speed=${settled.speed}`);

// W stays DOWN from here on.
//
// In the air, W is throttle, and a CRJ-900 at idle thrust sinks back onto the
// runway within a few seconds — the previous version released W right after
// liftoff, so the aircraft was on the ground again before the first airborne
// check and every arrow test failed against a parked aeroplane. The throttle
// release is checked at the end instead, where releasing it is deliberate.

// ── D: bank right, heading increases ──────────────────────────────────────
const turn0 = await st();
await page.keyboard.down("d");
await sleep(2600);
const turn1 = await st();
check("D rolls into a bank (right)", turn1.roll > 0.08, `roll=${turn1.roll}`);
await sleep(3250);
await page.keyboard.up("d");
const turn2 = await st();
check(
  "D changes heading (right)",
  turned(turn0.hdg, turn2.hdg) > 1,
  `hdg ${turn0.hdg} -> ${turn2.hdg} (${turned(turn0.hdg, turn2.hdg).toFixed(1)} deg)`,
);
await sleep(3250);
const turn3 = await st();
check(
  "bank auto-levels on release",
  Math.abs(turn3.roll) < Math.abs(turn1.roll),
  `roll ${turn1.roll} -> ${turn3.roll}`,
);

// ── ArrowUp: nose up, climb ───────────────────────────────────────────────
const up0 = await st();
await page.keyboard.down("ArrowUp");
// Held longer than the down-arrow dwell. Vertical speed takes a moment to
// build from a rotation, and sampling at 3.25 s catches the transient rather
// than the established climb.
await sleep(6000);
const up1 = await st();
await page.keyboard.up("ArrowUp");
check("ArrowUp pitches nose up", up1.pitch > up0.pitch + 0.05, `pitch ${up0.pitch} -> ${up1.pitch}`);
check("ArrowUp gains altitude", up1.vs > 0.5, `vs=${up1.vs} m/s`);

// ── ArrowDown: nose down, descend ─────────────────────────────────────────
await sleep(2600);
const dn0 = await st();
await page.keyboard.down("ArrowDown");
await sleep(3250);
const dn1 = await st();
await page.keyboard.up("ArrowDown");
check("ArrowDown pitches nose down", dn1.pitch < dn0.pitch - 0.05, `pitch ${dn0.pitch} -> ${dn1.pitch}`);
check("ArrowDown descends", dn1.vs < -1, `vs=${dn1.vs} m/s`);

// ── ArrowLeft / ArrowRight steer like A / D ────────────────────────────────
const lr0 = await st();
await page.keyboard.down("ArrowLeft");
await sleep(3900);
const lr1 = await st();
await page.keyboard.up("ArrowLeft");
check(
  "ArrowLeft turns left",
  turned(lr0.hdg, lr1.hdg) < -1,
  `hdg ${lr0.hdg} -> ${lr1.hdg} (${turned(lr0.hdg, lr1.hdg).toFixed(1)} deg)`,
);

const lr2 = await st();
await page.keyboard.down("ArrowRight");
await sleep(3900);
const lr3 = await st();
await page.keyboard.up("ArrowRight");
check(
  "ArrowRight turns right",
  turned(lr2.hdg, lr3.hdg) > 1,
  `hdg ${lr2.hdg} -> ${lr3.hdg} (${turned(lr2.hdg, lr3.hdg).toFixed(1)} deg)`,
);

// ── W release: throttle winds down, and the aeroplane settles level ───────
await page.keyboard.up("w");
await sleep(2500);
const s4 = await st();
check("W release winds throttle down", s4.thr < s3.thr, `thr ${s3.thr} -> ${s4.thr}`);

const lvl0 = await st();
await sleep(6500);
const lvl1 = await st();
check(
  "auto-levels pitch on release",
  Math.abs(lvl1.pitch) < 0.14,
  `pitch ${lvl0.pitch} -> ${lvl1.pitch}`,
);
check(
  "altitude holds (|vs| small)",
  Math.abs(lvl1.vs) < 4,
  `vs=${lvl1.vs} m/s, alt ${lvl0.alt} -> ${lvl1.alt}`,
);

const fin = await st();
console.log("\nfinal:", JSON.stringify(fin));

const world = await page.evaluate(() => {
  const S = window.SKYWARD;
  return {
    buildingTiles: S.buildings.primitives.size,
    runways: S.runways.primitives.length,
    terrainCache: S.groundSampler.cache.size,
  };
});
console.log("world:", JSON.stringify(world));

await page.screenshot({ path: "shot-acceptance.png" });
console.log("wrote shot-acceptance.png");

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (errors.length) {
  console.log("ERRORS:", errors.length);
  console.log([...new Set(errors)].slice(0, 4).join("\n").slice(0, 600));
}
await browser.close();
process.exit(failed.length ? 1 : 0);
