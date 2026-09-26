import puppeteer from "puppeteer";

// Captures what the user actually sees, at the three moments that matter:
// sitting on the runway, flying in third person, and a city skyline close up.
const browser = await puppeteer.launch({
  headless: false,
  args: ["--no-sandbox", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message.slice(0, 140)));
page.on("console", (m) => {
  if (/Error|Invalid|failed/i.test(m.text())) errors.push(m.text().slice(0, 140));
});

await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction("!!window.SKYWARD", { timeout: 40000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(11000);

// 1 ─ On the runway, before touching anything.
const spawn = await page.evaluate(() => {
  const S = window.SKYWARD;
  return {
    lon: S.plane.lon, lat: S.plane.lat, alt: S.plane.alt,
    headingDeg: Math.round((S.plane.heading * 180) / Math.PI),
    onGround: S.plane.onGround, speed: +S.plane.speed.toFixed(1),
    runway: S.runways.current?.airport ?? S.runways.current?.icao ?? null,
  };
});
await page.screenshot({ path: "shots/01-runway-start.png" });
console.log("spawn:", JSON.stringify(spawn));

// 2 ─ Full throttle down the runway, then rotate and climb.
await page.keyboard.down("KeyW");
await sleep(22000);
const rolling = await page.evaluate(() => {
  const S = window.SKYWARD;
  return { speed: +S.plane.speed.toFixed(1), onGround: S.plane.onGround, alt: +S.plane.alt.toFixed(1) };
});
await page.screenshot({ path: "shots/02-takeoff-roll.png" });

await page.keyboard.down("ArrowUp");
await sleep(11000);
await page.keyboard.up("ArrowUp");
await sleep(9000);
const climbing = await page.evaluate(() => {
  const S = window.SKYWARD;
  return {
    speed: +S.plane.speed.toFixed(1), alt: +S.plane.alt.toFixed(1),
    vs: +S.plane.verticalSpeed.toFixed(1), onGround: S.plane.onGround,
  };
});
await page.screenshot({ path: "shots/03-third-person-climb.png" });
console.log("rolling:", JSON.stringify(rolling), " climbing:", JSON.stringify(climbing));
await page.keyboard.up("KeyW");

// 3 ─ Over a dense city, close enough to see whether facades have windows.
await page.evaluate(() => {
  window.SKYWARD.jumpTo({ lon: -73.985, lat: 40.748, alt: 320, name: "Midtown Manhattan" });
});
await sleep(26000);
const city = await page.evaluate(() => ({
  buildings: window.SKYWARD.buildings.buildingCount,
  tiles: window.SKYWARD.buildings.primitives.size,
  alt: +window.SKYWARD.plane.alt.toFixed(1),
}));
await page.screenshot({ path: "shots/04-city-facades.png" });
console.log("city:", JSON.stringify(city));

// Closer still, to judge the facade texture at a distance a user would fly.
await page.evaluate(() => {
  window.SKYWARD.jumpTo({ lon: -73.985, lat: 40.758, alt: 120, name: "Midtown low" });
});
await sleep(22000);
await page.screenshot({ path: "shots/05-city-close.png" });

console.log("console errors:", errors.length ? [...new Set(errors)].slice(0, 5).join(" | ") : "(none)");
await browser.close();
