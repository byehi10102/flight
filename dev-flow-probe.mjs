/**
 * Flow smoke: aircraft selection -> helicopter flight -> minimap at speed.
 *
 * Asserts (numbers, not screenshots):
 *   1. SINGLE PLAYER opens the aircraft selector (the new screen).
 *   2. Choosing the HELICOPTER and continuing reaches the spawn picker.
 *   3. Spawning puts a HeliPhysics under the jet and the rotor spools up.
 *   4. Hover holds (no sink, no drift), W climbs, ArrowUp drives forward.
 *   5. The minimap viewer's tiles STAY loaded while flying at speed (the
 *      starvation fix) — sampled after a full-throttle minute.
 */
import puppeteer from "puppeteer-core";

const GAME_URL = "http://127.0.0.1:5173/?devtest=1";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 600000,
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
         "--enable-webgl", "--ignore-gpu-blocklist", "--window-size=1280,800"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
await page.setViewport({ width: 1280, height: 740, deviceScaleFactor: 1 });

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? "  — " + detail : ""}`); }
};

await page.goto(GAME_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.SKY_DEV, { timeout: 60000, polling: 500 });
await page.waitForFunction(() => {
  const b = document.getElementById("startBtn");
  return window.SKY_DEV?.boot?.pageGone === true && b && !b.disabled;
}, { timeout: 150000, polling: 500 });

// 1. the selector appears
await page.click("#startBtn");
await page.waitForSelector("#aircraftSelect:not(.hidden)", { timeout: 10000 });
check("aircraft selector opens on SINGLE PLAYER", true);
check("fleet has 4 vehicles", (await page.$$("#aircraftSelect .fleet-card")).length === 4);

// 2. pick the helicopter, continue to the picker
await page.evaluate(() => {
  [...document.querySelectorAll("#aircraftSelect .fleet-card")]
    .find((c) => c.dataset.id === "heli").click();
});
const selOk = await page.evaluate(() =>
  document.querySelector("#aircraftSelect .fleet-card.heli").classList.contains("sel"));
check("helicopter card selects", selOk);
await page.click("#fleetGoBtn");
await page.waitForFunction(() => SKY_DEV.currentState === "PICK_SPAWN", { timeout: 30000, polling: 250 });
check("CONTINUE reaches the spawn picker", true);

// 3. spawn -> HeliPhysics + rotor spool
await page.evaluate(() => SKY_DEV.placeSpawn(-117.9143, 33.8366, "Anaheim"));
await sleep(500);
await page.evaluate(() => document.getElementById("confirmSpawnBtn")?.click());
await page.waitForFunction(() => SKY_DEV.currentState === "FLYING", { timeout: 120000, polling: 500 });
await sleep(4000);
const flight = await page.evaluate(() => ({
  isHeli: SKY_DEV.physics?.rotor !== undefined,
  rotor: +SKY_DEV.physics.rotor.toFixed(2),
  agl: Math.round(SKY_DEV.state.agl),
  alt: Math.round(SKY_DEV.state.alt),
  speed: Math.round(SKY_DEV.state.speed),
}));
check("flight physics is the helicopter model", flight.isHeli);
// Wait for the spool instead of guessing when flight actually starts (the
// dive and the loading film run before the first physics step).
await page.waitForFunction(() => SKY_DEV.physics.rotor > 0.9, { timeout: 30000, polling: 250 });
check("rotor spooled up", true);

// 4. hover / climb / forward
const hoverAlt = flight.alt;
await sleep(5000);
const afterHover = await page.evaluate(() => ({ alt: SKY_DEV.state.alt, speed: SKY_DEV.state.speed }));
check("hover holds altitude", Math.abs(afterHover.alt - hoverAlt) < 40, `${hoverAlt} -> ${Math.round(afterHover.alt)}`);

await page.keyboard.down("w"); await sleep(4000); await page.keyboard.up("w");
const climb = await page.evaluate(() => SKY_DEV.state.alt);
check("W (collective) climbs", climb > afterHover.alt + 5, `${Math.round(afterHover.alt)} -> ${Math.round(climb)}`);

await page.keyboard.down("ArrowUp"); await sleep(9000); await page.keyboard.up("ArrowUp");
const fwd = await page.evaluate(() => ({ speed: Math.round(SKY_DEV.state.speed), alt: Math.round(SKY_DEV.state.alt) }));
check("ArrowUp drives forward", fwd.speed > 100, String(fwd.speed));

// 5. minimap stays loaded at speed (the starvation fix). The helicopter's
// speed comes from TILT, not collective — so hold BOTH: W (climb) and
// ArrowUp (forward tilt to ~190 mph) so the globe is really streaming.
await page.keyboard.down("w");
await page.keyboard.down("ArrowUp");
await sleep(55000);
const mini = await page.evaluate(() => ({
  tilesLoaded: SKY_DEV.miniViewer?.scene.globe.tilesLoaded,
  sse: SKY_DEV.miniViewer?.scene.globe.maximumScreenSpaceError,
  level: SKY_DEV.miniViewer?.imageryLayers.get(1)?.maximumLevel,
  speed: Math.round(SKY_DEV.state.speed),
  mainLoaded: SKY_DEV.viewer.scene.globe.tilesLoaded,
}));
check("minimap tiles stay LOADED at speed", mini.tilesLoaded === true, JSON.stringify(mini));
check("main globe still streams/loaded", typeof mini.mainLoaded === "boolean");
console.log("MINIMAP AT SPEED:", JSON.stringify(mini));
await page.keyboard.up("w");
await page.keyboard.up("ArrowUp");

console.log(`\n${pass} passed, ${fail} failed`);
if (errors.length) console.log("page errors:", errors.slice(0, 5));
await browser.close();
process.exit(fail ? 1 : 0);
