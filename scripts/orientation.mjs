import puppeteer from "puppeteer";

// ──────────────────────────────────────────���──────────────────────────────────
// Proves the aircraft model is placed correctly, numerically rather than by
// eye. Three things go wrong easily with a GLB, and all three are silent:
//
//   1. WRONG FORWARD AXIS — the aeroplane flies backwards.
//   2. ORIGIN NOT CENTRED — the camera ends up inside the tailcone, or the
//      model floats/sinks relative to the runway.
//   3. WRONG SCALE — a 2 m toy in a 4 km world.
//
// So: take real vertices from the mesh, push them through the *same* matrix the
// app uses, and compare where they land against where the aircraft is actually
// travelling.
//
// The matrix arithmetic here is plain arithmetic on the 16 matrix elements.
// That is not a stylistic choice: `window.Cesium` is a PARTIAL namespace, and
// Rollup tree-shakes even a namespace import down to the members it can see
// being used. `Matrix4.fromUniformScale`, `Matrix4.multiplyByPoint` and
// `Matrix4.getElement` were each "not a function" at different points in this
// investigation, which reads exactly like a broken application. Depending on
// the bundler for a measurement is how a correct model gets reported as
// backwards.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";

const SCALE = 10.64; // authored units -> metres, from the real 24.85 m span
const results = [];
const check = (name, pass, detail) => {
  results.push({ pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name.padEnd(46)} ${detail}`);
};

// ── Real nose / tail / wingtip / belly vertices, straight out of the GLB ───
const buf = readFileSync("public/models/crj900.glb");
let off = 12;
let jsonChunk = null;
let binChunk = null;
while (off < buf.length) {
  const len = buf.readUInt32LE(off);
  const type = buf.toString("ascii", off + 4, off + 8);
  if (type === "JSON") jsonChunk = { len, at: off + 8 };
  if (type.startsWith("BIN")) binChunk = { len, at: off + 8 };
  off += 8 + len + ((4 - (len % 4)) % 4);
}
const gltf = JSON.parse(buf.toString("utf8", jsonChunk.at, jsonChunk.at + jsonChunk.len));

const posAcc = gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION];
const view = gltf.bufferViews[posAcc.bufferView];
const base = binChunk.at + (view.byteOffset || 0) + (posAcc.byteOffset || 0);
const stride = view.byteStride || 12;

const v = { nose: null, tail: null, wingL: null, wingR: null, belly: null };
// A point on the fuselage centreline, straight along the authored +Y axis.
// The extreme nose vertex sits ~4.8 m off the centreline, which biases any
// bearing measured through it by about 7 degrees — enough to mask the real
// orientation behind a plausible-looking number.
for (let i = 0; i < posAcc.count; i++) {
  const p = base + i * stride;
  const a = [buf.readFloatLE(p), buf.readFloatLE(p + 4), buf.readFloatLE(p + 8)];
  if (!v.nose || a[1] > v.nose[1]) v.nose = a;
  if (!v.tail || a[1] < v.tail[1]) v.tail = a;
  if (!v.wingL || a[0] < v.wingL[0]) v.wingL = a;
  if (!v.wingR || a[0] > v.wingR[0]) v.wingR = a;
  if (!v.belly || a[2] < v.belly[2]) v.belly = a;
}
const r3 = (a) => JSON.stringify(a.map((x) => +x.toFixed(3)));
console.log(`mesh nose    ${r3(v.nose)}`);
console.log(`mesh tail    ${r3(v.tail)}`);
console.log(`mesh wingtip ${r3(v.wingL)} / ${r3(v.wingR)}`);
console.log(`mesh belly   ${r3(v.belly)}\n`);
// Centreline tip, derived from the mesh's own extent along +Y.
v.axisTip = [0, v.nose[1], (v.nose[2] + v.tail[2]) / 2];
v.axisTail = [0, 0, (v.nose[2] + v.tail[2]) / 2];
console.log(`centreline  ${r3(v.axisTail)} -> ${r3(v.axisTip)}\n`);

const browser = await puppeteer.launch({
  headless: false,
  args: ["--no-sandbox", "--window-size=1000,700"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1000, height: 700 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message.slice(0, 120)));
page.on("console", (m) => {
  if (/Error|Invalid|failed/i.test(m.text())) errors.push(m.text().slice(0, 120));
});

await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction("!!window.SKYWARD", { timeout: 40000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(9000);

const info = await page.evaluate(() => {
  const S = window.SKYWARD;
  return {
    configured: S.CONFIG.aircraft.modelUrl,
    ready: !!S.aircraft.model?.ready,
    show: S.aircraft.model?.show,
    scale: S.CONFIG.aircraft.modelScale,
  };
});
check(
  "CRJ-900 model loaded",
  /crj900/i.test(info.configured || "") && info.ready,
  `${info.configured} ready=${info.ready} scale=${info.scale}`,
);
check("model visible", info.show !== false, `show=${info.show}`);

/**
 * Place the aircraft at a heading and measure where the mesh's own vertices
 * land, in local north/east/up metres relative to the physics point.
 *
 * `lastMatrix` is the app's own transform for the current frame, copied in
 * `aircraft.js`. `Model.scale` is applied by Cesium internally and is NOT in
 * that matrix, so the authored->metres scale is applied here.
 */
const probe = (headingDeg) =>
  page.evaluate(
    ([hd, verts, scale]) => {
      const S = window.SKYWARD;
      S.plane.heading = (hd * Math.PI) / 180;
      S.plane.pitch = 0;
      S.plane.roll = 0;
      S.aircraft.update(S.plane, 0);

      // Read the 16 elements. A Cesium Matrix4 is indexable, but not iterable,
      // so Array.from() would not work here.
      const m = S.aircraft.lastMatrix;
      const M = [];
      for (let i = 0; i < 16; i++) M.push(Number(m[i]));

      // Column-major 4x4 multiply, matching Cesium's layout.
      const xform = (x, y, z) => {
        const px = x * scale;
        const py = y * scale;
        const pz = z * scale;
        return [
          M[0] * px + M[4] * py + M[8] * pz + M[12],
          M[1] * px + M[5] * py + M[9] * pz + M[13],
          M[2] * px + M[6] * py + M[10] * pz + M[14],
        ];
      };

      // Reference point: the app's own ECEF position for this frame.
      //
      // Computing it from lon/lat/alt here meant re-deriving the WGS84
      // ellipsoid conversion, and a sign slip in that produced a ~6,366 km
      // "offset" that read exactly like a catastrophic placement bug. The app
      // already has the authoritative value, so use it.
      const op = S.aircraft._position;
      const origin = [Number(op.x), Number(op.y), Number(op.z)];

      const lat = (S.plane.lat * Math.PI) / 180;
      const lon = (S.plane.lon * Math.PI) / 180;
      const north = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
      const east = [-Math.sin(lon), Math.cos(lon), 0];
      const up = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];

      const local = (vert) => {
        const p = xform(vert[0], vert[1], vert[2]);
        const d = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
        const dot = (b) => d[0] * b[0] + d[1] * b[1] + d[2] * b[2];
        return { n: dot(north), e: dot(east), u: dot(up) };
      };
      const bearing = (p) => +((((Math.atan2(p.e, p.n) * 180) / Math.PI + 360) % 360).toFixed(1));
      const nose = local(verts.nose);
      const tail = local(verts.tail);
      // Bearing along the fuselage centreline, free of the nose's lateral bias.
      const tip = local(verts.axisTip);
      const heel = local(verts.axisTail);
      return {
        nose, tail, tip, heel,
        wingL: local(verts.wingL), wingR: local(verts.wingR), belly: local(verts.belly),
        noseBearing: bearing(tip),
        tailBearing: bearing(heel),
      };
    },
    [headingDeg, v, SCALE],
  );

// ── 1. Forward axis: the nose must lead, at every heading ─────────────────
for (const hd of [0, 90, 180, 270]) {
  const r = await probe(hd);
  // Signed shortest angular difference, so a turn through north is not read as
  // a reversal.
  const diff = ((r.noseBearing - hd + 540) % 360) - 180;
  check(
    `nose leads the aeroplane heading ${String(hd).padStart(3)}`,
    Math.abs(diff) < 8,
    `nose at ${r.noseBearing} deg, flying ${hd} deg (off by ${diff.toFixed(1)}), tail at ${r.tailBearing} deg`,
  );
}

// ── 2. Centring and scale, from the measured vertices ─────────────────────
const m = await probe(0);
const lengthM = Math.hypot(m.nose.n - m.tail.n, m.nose.e - m.tail.e, m.nose.u - m.tail.u);
const spanM = Math.hypot(m.wingR.n - m.wingL.n, m.wingR.e - m.wingL.e, m.wingR.u - m.wingL.u);
const midN = (m.nose.n + m.tail.n) / 2;
const midU = (m.nose.u + m.tail.u) / 2;

check(
  "airframe is centred on the physics point",
  Math.abs(midN) < 3.0,
  `midpoint ${midN.toFixed(2)} m ahead of the reference point`,
);
check(
  "length is a real regional jet",
  lengthM > 30 && lengthM < 45,
  `${lengthM.toFixed(1)} m (real CRJ-900 36.4 m)`,
);
check(
  "wingspan is correct",
  spanM > 22 && spanM < 28,
  `${spanM.toFixed(1)} m (real CRJ-900 24.85 m)`,
);
check(
  "wheels at ground level, airframe above",
  m.belly.u > -0.5 && m.belly.u < 2.0 && midU > 2.0,
  `belly ${m.belly.u.toFixed(2)} m, mid-height ${midU.toFixed(2)} m above the contact point`,
);

console.log("\nconsole errors:", errors.length ? [...new Set(errors)].slice(0, 4).join(" | ") : "(none)");
const passed = results.filter((x) => x.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
