import puppeteer from "puppeteer";

// ─────────────────────────────────────────────────────────────────────────────
// Verifies the world is genuinely 3D and genuinely real, by checking the
// geometry the app actually builds against published ground truth.
//
//   1. Buildings are extruded solids standing on the terrain, not flat marks.
//   2. Those solids carry real-world heights, checked against Manhattan
//      skyscrapers whose architectural heights are published.
//   3. Airports are drawn at their real positions, sizes and bearings, flown
//      to one at a time, from known AIP runway data.
// ─────────────────────────────────────────────────────────────────────────────

// Published architectural heights, metres.
//
// The figure compared is what OSM's `height` / `render_height` tags are meant
// to carry, which for a spired building is the ROOF, not the tip. 1 WTC is
// universally called 541 m but its roof is 417 m and OSM records 417 m; the
// Chrysler is called 319 m with its spire and its roof is 278 m. Comparing a
// roof-tagged dataset against spire-inclusive figures would be testing the
// wrong number.
//
// Heights are crowd-sourced, so a footprint split into several OSM ways (a
// podium beside a tower) can legitimately yield a lower part near the site.
// That is data, not a rendering fault, so the roof figures are compared and the
// tolerance is 12%.
const KNOWN_TALL = [
  { name: "One WTC (roof)", lat: 40.7127, lon: -74.0132, h: 417 },
  { name: "Empire State Bldg", lat: 40.7484, lon: -73.9857, h: 443 },
  { name: "432 Park Avenue", lat: 40.7616, lon: -73.9717, h: 426 },
  { name: "Chrysler Bldg (roof)", lat: 40.7516, lon: -73.9755, h: 278 },
  { name: "Flatiron Building", lat: 40.7411, lon: -73.9897, h: 87 },
];

// Published runway geometry, metres, with each airport's coordinates so the
// test can be flown to it. All four JFK runways are 200 ft (61 m) wide.
// Airports to fly to. `aipLengthFt` is only given where the published figure is
// well established; where it is absent the test asserts fidelity to the source
// record instead, because that is the part we actually control. Asserting a
// remembered runway width we are not sure of would be testing our memory, not
// the renderer. (OurAirports' own widths are sometimes a revision behind the
// current AIP — Sydney 16R is listed at 148 ft.)
const KNOWN_AIRPORTS = [
  { icao: "KJFK", name: "John F. Kennedy Intl", aipLengthFt: 14511, aipWidthFt: 200, lat: 40.639, lon: -73.779 },
  { icao: "EGLL", name: "Heathrow", aipLengthFt: 12799, aipWidthFt: 164, lat: 51.47, lon: -0.454 },
  { icao: "RJTT", name: "Tokyo Haneda", aipLengthFt: 11024, lat: 35.549, lon: 139.78 },
  { icao: "YSSY", name: "Sydney Kingsford Smith", lat: -33.946, lon: 151.177 },
  { icao: "CYYZ", name: "Toronto Pearson", lat: 43.677, lon: -79.631 },
  { icao: "OMDB", name: "Dubai Intl", aipLengthFt: 14590, lat: 25.253, lon: 55.365 },
];

const M_PER_DEG = 111320;
const distM = (aLat, aLon, bLat, bLon) => {
  const dLat = (aLat - bLat) * M_PER_DEG;
  const dLon = (aLon - bLon) * M_PER_DEG * Math.cos((aLat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
};

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name.padEnd(44)} ${detail}`);
};

const browser = await puppeteer.launch({
  headless: false,
  args: ["--no-sandbox", "--window-size=1000,700"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1000, height: 700 });

const errors = [];
page.on("pageerror", (e) => errors.push(e.message.slice(0, 110)));
page.on("console", (m) => {
  const t = m.text();
  if (/Invalid array length|Uncaught|TypeError|ReferenceError/.test(t))
    errors.push(t.slice(0, 110));
});

await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction("!!window.SKYWARD", { timeout: 40000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(6000);

const go = async (lat, lon, height, dwell) => {
  await page.evaluate(([la, lo, h]) => window.SKYWARD.jumpTo({ lat: la, lon: lo, height: h }), [lat, lon, height]);
  await sleep(dwell);
};

// ── 1. Buildings are extruded 3D solids on the terrain ──────────────────────
console.log("\n-- 1. Buildings are extruded 3D solids -------------------------");
await go(40.7549, -73.984, 120, 36000);

const world = await page.evaluate(() => {
  const S = window.SKYWARD;
  const coll = S.viewer.scene.primitives;
  // `Primitive` does not expose `boundingSphere` publicly, so scene membership
  // is checked by object identity against the layer's own collection. Checking
  // a property that does not exist would report "not in the scene" for
  // primitives that are demonstrably rendering.
  //
  // Each tile holds an ARRAY of primitives — one per facade archetype — so
  // the map values must be flattened before comparing. Comparing the arrays
  // themselves reports 0 in scene for a city that is plainly rendering.
  const layerPrims = [...S.buildings.primitives.values()].flat();
  const inScene = layerPrims.filter((p) => {
    for (let i = 0; i < coll.length; i++) if (coll.get(i) === p) return true;
    return false;
  }).length;
  const ready = layerPrims.filter((p) => p.ready).length;
  let highest = -Infinity;
  let lowest = Infinity;
  for (const t of S.buildings.tallest) {
    if (t.base + t.h > highest) highest = t.base + t.h;
    if (t.base < lowest) lowest = t.base;
  }
  return {
    buildingCount: S.buildings.buildingCount,
    tiles: S.buildings.primitives.size,
    tallest: S.buildings.tallest,
    inScene,
    ready,
    layerPrims: layerPrims.length,
    sceneLength: coll.length,
    highest: +highest.toFixed(1),
    lowest: +lowest.toFixed(1),
  };
});

check("buildings instantiated", world.buildingCount > 5000, `${world.buildingCount} from ${world.tiles} tiles`);
check(
  "building primitives live in the scene graph",
  // Compared against the PRIMITIVE count, not the tile count: each tile now
  // contributes one primitive per facade archetype present in it, so 42 tiles
  // legitimately become ~149 primitives. Comparing against tiles reported a
  // failure for a city that was rendering correctly.
  world.inScene === world.layerPrims && world.layerPrims > 5 && world.ready === world.layerPrims,
  `${world.inScene}/${world.layerPrims} primitives from ${world.tiles} tiles, all ready; scene holds ${world.sceneLength}`,
);
check(
  "geometry rises above the terrain it stands on",
  world.highest > 100 && world.lowest > -60,
  `tops reach ${world.highest} m, bases from ${world.lowest} m`,
);

const hs = world.tallest.map((t) => t.h);
const over100 = hs.filter((h) => h > 100).length;
check(
  "heights are varied and plausible",
  hs.length > 20 && over100 > 5 && Math.max(...hs) > 300,
  `${hs.length} tracked, ${over100} over 100 m, tallest ${Math.max(...hs)} m`,
);

// ── 2. Heights vs. published architectural heights ──────────────────────────
console.log("\n-- 2. Extruded heights vs. published architectural heights ------");
console.log("     (nearest extrusion within 120 m of each site)\n");
for (const k of KNOWN_TALL) {
  const match = world.tallest
    .map((t) => ({ ...t, d: distM(t.lat, t.lon, k.lat, k.lon) }))
    .filter((t) => t.d < 120)
    .sort((a, b) => a.d - b.d)[0];
  if (!match) {
    check(k.name, false, "no extrusion found within 120 m of the site");
    continue;
  }
  const err = ((match.h - k.h) / k.h) * 100;
  check(k.name, Math.abs(err) <= 12, `ours ${match.h} m vs published ${k.h} m (${err >= 0 ? "+" : ""}${err.toFixed(1)}%, ${match.d.toFixed(0)} m away)`);
}

// ── 3. Airports: fly to each and check its real geometry ────────────────────
console.log("\n-- 3. Airports: real geometry, flown to one by one -------------");
for (const a of KNOWN_AIRPORTS) {
  await go(a.lat, a.lon, 700, 9000);
  const mine = await page.evaluate((icao) => {
    const all = window.SKYWARD.runways.builtRunways.filter((r) => r.icao === icao);
    if (!all.length) return null;
    return all.sort((x, y) => y.lengthM - x.lengthM)[0];
  }, a.icao);
  if (!mine) {
    check(`${a.icao} ${a.name}`, false, "no runway built here");
    continue;
  }
  // Fidelity: the drawn metres must be the source feet, converted exactly.
  const wantLen = mine.sourceLengthFt * 0.3048;
  const wantWid = mine.sourceWidthFt * 0.3048;
  const faithful =
    Math.abs(mine.lengthM - wantLen) < 0.5 && Math.abs(mine.widthM - wantWid) < 0.5;
  // Where the AIP figure is known, also check the source itself.
  const aipOk = a.aipLengthFt ? mine.sourceLengthFt === a.aipLengthFt : true;
  const aipWidOk = !a.aipWidthFt || mine.sourceWidthFt === a.aipWidthFt;
  const posOk = distM(mine.midLat, mine.midLon, a.lat, a.lon) < 6000;
  check(
    `${a.icao} ${a.name}`,
    faithful && aipOk && aipWidOk && posOk,
    `rwy ${mine.rwy}: ${mine.sourceLengthFt} ft -> ${mine.lengthM} m, ${mine.sourceWidthFt} ft -> ${mine.widthM} m, hdg ${mine.heading} deg${a.aipLengthFt ? ` [AIP ${a.aipLengthFt} ft ${aipOk ? "match" : "MISMATCH"}]` : ""}`,
  );
}

// ── 4. Unit sanity: feet in, metres out ────────────────────────────────────
console.log("\n-- 4. Source units are feet, drawn units are metres -------------");
const allRwys = await page.evaluate(() => window.SKYWARD.runways.builtRunways);
let unitOk = 0;
const unitBad = [];
for (const r of allRwys) {
  const expectLen = r.sourceLengthFt * 0.3048;
  const expectWid = r.sourceWidthFt * 0.3048;
  if (Math.abs(r.lengthM - expectLen) < 1 && Math.abs(r.widthM - expectWid) < 1) unitOk++;
  else if (unitBad.length < 4) unitBad.push(`${r.icao}/${r.rwy} ${r.sourceWidthFt}ft -> ${r.widthM}m (want ${expectWid.toFixed(1)})`);
}
check("every runway converted ft -> m", unitBad.length === 0, `${unitOk}/${allRwys.length} correct${unitBad.length ? "; bad: " + unitBad.join(" | ") : ""}`);

// ── 5. Sun response: massing must be lit, not flat-coloured ────────────────
console.log("\n-- 5. Buildings respond to the sun -----------------------------");
await go(40.7549, -73.984, 150, 26000);
const setSun = (azim) =>
  page.evaluate((a) => {
    const C = window.Cesium;
    const S = window.SKYWARD.viewer.scene;
    const enu = C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(-73.984, 40.7549, 1000));
    const rot = C.Matrix4.getMatrix3(enu, new C.Matrix3());
    C.Matrix3.multiply(rot, C.Matrix3.fromRotationZ(C.Math.toRadians(a), new C.Matrix3()), rot);
    S.light.direction = C.Cartesian3.negate(C.Matrix3.getColumn(rot, 2, new C.Cartesian3()), new C.Cartesian3());
  }, azim);
const luma = () =>
  page.evaluate(() => {
    const cv = document.querySelector("#cesiumContainer canvas");
    const gl = cv.getContext("webgl2") || cv.getContext("webgl");
    const buf = new Uint8Array(cv.width * cv.height * 4);
    gl.readPixels(0, 0, cv.width, cv.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < buf.length; i += 4 * 29) {
      sum += 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
      n++;
    }
    return +(sum / n).toFixed(2);
  });
const lit = [];
for (const az of [20, 110, 210]) {
  await setSun(az);
  await sleep(2600);
  lit.push(await luma());
}
const spread = Math.max(...lit) - Math.min(...lit);
check("scene luminance tracks the sun", spread > 3, `${lit.join(" / ")} (spread ${spread.toFixed(1)})`);

console.log("\n-- console errors ---------------------------------------------");
const uniq = [...new Set(errors)];
console.log(uniq.length ? uniq.slice(0, 5).join("\n") : "(none)");
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
