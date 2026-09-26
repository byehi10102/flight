import puppeteer from "puppeteer";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: false,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,800"],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PE:", e.message.split("\n")[0]));
page.on("console", (m) => console.log("CON:", m.text().slice(0, 120)));

// Dispatch key events directly on window (where Controls listens) — deterministic,
// avoids puppeteer keyboard-state desync.
const down = async (code) =>
  page.evaluate((c) => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: c, bubbles: true, cancelable: true }));
  }, code);
const up = async (code) =>
  page.evaluate((c) => {
    window.dispatchEvent(new KeyboardEvent("keyup", { code: c, bubbles: true, cancelable: true }));
  }, code);

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (detail ? " — " + detail : ""));
  cond ? pass++ : fail++;
};

const st = async () =>
  page.evaluate(() => {
    const s = window.SKYWARD, p = s?.plane, h = s?.hold, cm = s?.cesium, c = s?.viewer?.camera;
    if (!p) return { none: true };
    const n = (x) => (typeof x === "number" && isFinite(x) ? x : 0);
    const carto = c && cm ? cm.Cartographic.fromCartesian(c.position) : null;
    const camH = carto ? +carto.height.toFixed(0) : null;
    let plH = null;
    if (cm && s.aircraft && s.aircraft.lastMatrix) {
      const M = s.aircraft.lastMatrix;
      const pos = new cm.Cartesian3(M[12], M[13], M[14]);
      const c2 = cm.Cartographic.fromCartesian(pos);
      plH = c2 ? +c2.height.toFixed(0) : null;
    }
    // behind: dot(noseDir, camOffset) < 0; nose = model +Y axis
    let behind = false, above = false, d = 0, m = 0, my = null, dbg = {};
    if (c && cm && s.aircraft && s.aircraft.lastMatrix) {
      const M = s.aircraft.lastMatrix;
      const origin = new cm.Cartesian3(M[12], M[13], M[14]);
      my = new cm.Cartesian3(M[4], M[5], M[6]); // model +Y axis (column 1 of column-major Matrix4)
      const noseDir = cm.Cartesian3.normalize(my, new cm.Cartesian3());
      const toCam = cm.Cartesian3.subtract(c.position, origin, new cm.Cartesian3());
      m = cm.Cartesian3.magnitude(toCam);
      d = cm.Cartesian3.dot(noseDir, toCam);
      behind = d < 0 && m > 8 && m < 500;
      above = camH != null && plH != null && camH > plH - 3;
      dbg = { d:+n(d).toFixed(2), m:+n(m).toFixed(1), nose:[+n(my.x).toFixed(2),+n(my.y).toFixed(2),+n(my.z).toFixed(2)], cam:[+n(c.position.x).toFixed(1),+n(c.position.y).toFixed(1),+n(c.position.z).toFixed(1)], origin:[+n(M[12]).toFixed(1),+n(M[13]).toFixed(1),+n(M[14]).toFixed(1)], pp:[+n(p.heading).toFixed(2),+n(p.pitch).toFixed(2),+n(p.roll).toFixed(2)] };
    }
    return {
      spd: +n(p.speed).toFixed(1), vs: +n(p.verticalSpeed).toFixed(1),
      pitch: +n(p.pitch).toFixed(3), roll: +n(p.roll).toFixed(3),
      thr: +n(p.throttle).toFixed(3), alt: +n(p.alt).toFixed(0),
      hdg: +n(p.heading).toFixed(2), onG: !!p.onGround, flaps: +n(p.flaps).toFixed(2),
      behind, above, camH, plH, targetAlt: h?.targetAlt != null ? +h.targetAlt.toFixed(0) : null,
      dbg,
    };
  });

const log = async (t) => console.log(t, JSON.stringify(await st()));

await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction("!!window.SKYWARD", { timeout: 35000 });
await sleep(1000);
// Let the free-look chase camera settle into its behind-and-above rest pose.
for (let i = 0; i < 12 && !(await st()).behind; i++) await sleep(500);

const s0 = await st();
check("spawns airborne", !s0.onG && s0.alt > 700, "alt=" + s0.alt + " thr=" + s0.thr);
check("throttle idles (no W)", s0.thr < 0.15, "thr=" + s0.thr);
check("trimmed start speed", s0.spd > 85 && s0.spd < 120, "spd=" + s0.spd);
check("camera behind aircraft", s0.behind, JSON.stringify({ behind: s0.behind, dot: true }));
check("camera above aircraft", s0.above, JSON.stringify({ above: s0.above, camH: s0.camH, plH: s0.plH }));

// W accelerate (tap and hold briefly), then RELEASE before maneuvers.
await down("KeyW");
const aW = await st();
await sleep(3000);
const bW = await st();
check("W accelerates", bW.spd > aW.spd + 2 && bW.thr > 0.8, "spd " + aW.spd + "->" + bW.spd + " thr=" + bW.thr);
await up("KeyW");
for (let i = 0; i < 2; i++) { await sleep(1000); await log("settle"); }

// Climb
const cU = await st();
await down("ArrowUp");
await sleep(4000);
const sU = await st();
check("ArrowUp nose up", sU.pitch > 0.12, "pitch=" + sU.pitch);
check("ArrowUp gains altitude", sU.vs > 1, "vs=" + sU.vs + " spd=" + sU.spd);
await up("ArrowUp");
for (let i = 0; i < 5; i++) { await sleep(1000); await log("climb-recover"); }
const pU = await st();
check("auto-levels altitude after climb", Math.abs(pU.vs) < 6, "vs=" + pU.vs + " pitch=" + pU.pitch + " spd=" + pU.spd);

// Descend
await down("ArrowDown");
await sleep(3000);
const sD = await st();
check("ArrowDown nose down", sD.pitch < -0.12, "pitch=" + sD.pitch);
check("ArrowDown descends", sD.vs < -1, "vs=" + sD.vs);
await up("ArrowDown");
for (let i = 0; i < 6; i++) { await sleep(1000); await log("desc-recover"); }

// Turns
await down("KeyW"); await sleep(1500); await up("KeyW");
const hdg0 = (await st()).hdg;
await down("KeyD");
await sleep(3000);
const sR = await st();
const d = (sR.hdg - hdg0 + Math.PI) % (2 * Math.PI) - Math.PI;
check("D banks right", sR.roll > 0.08, "roll=" + sR.roll);
check("D steers right", Math.abs(d) > 0.08, "hdg " + hdg0.toFixed(2) + "->" + sR.hdg);
await up("KeyD");
for (let i = 0; i < 4; i++) { await sleep(1000); await log("roll-recover"); }
check("auto-levels wings", Math.abs((await st()).roll) < 0.08, "roll=" + (await st()).roll);

const hdg1 = (await st()).hdg;
await down("ArrowRight");
await sleep(3000);
const sAR = await st();
const d2 = (sAR.hdg - hdg1 + Math.PI) % (Math.PI * 2) - Math.PI;
check("ArrowRight steers right", Math.abs(d2) > 0.05, "hdg " + hdg1.toFixed(2) + "->" + sAR.hdg);
await up("ArrowRight");
for (let i = 0; i < 4; i++) { await sleep(1000); await log("yaw-recover"); }
const yL = await st();
check("yaw auto-levels pitch", Math.abs(yL.pitch) < 0.12, "pitch=" + yL.pitch);
check("yaw auto-levels roll", Math.abs(yL.roll) < 0.08, "roll=" + yL.roll);

// Idle auto-level
const idle0 = await st();
for (let i = 0; i < 3; i++) { await sleep(1000); await log("idle"); }
const idleN = await st();
check("idle auto-levels altitude", Math.abs(idleN.vs) < 6, "vs=" + idleN.vs + " pitch=" + idleN.pitch);
check("idle auto-levels pitch", Math.abs(idleN.pitch) < 0.16, "pitch=" + idleN.pitch);

// Flaps
await down("KeyS");
await sleep(4000);
const idleS = await st();
await up("KeyS");
check("S deploys flaps", idleS.flaps > 0.05, "flaps=" + idleS.flaps);
check("S slows airspeed", idleS.spd < idle0.spd - 0.3, "spd " + idle0.spd + "->" + idleS.spd);
for (let i = 0; i < 3; i++) { await sleep(1000); await log("final"); }
check("still airborne", (await st()).alt > 500, "alt=" + (await st()).alt);

console.log("\n" + pass + "/" + (pass + fail) + " passed");
await browser.close();
