import puppeteer from "puppeteer";

// Facades as a player sees them: low, oblique, close. A top-down view from
// 200 m mostly shows roofs, which tells you nothing about whether the walls
// have windows on them.
const browser = await puppeteer.launch({
  headless: false,
  args: ["--no-sandbox", "--window-size=1100,700"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 700 });
await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction("!!window.SKYWARD", { timeout: 40000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(9000);

const spots = [
  { lon: -73.988, lat: 40.7565, alt: 95, name: "Midtown oblique" },
  { lon: -73.9855, lat: 40.7605, alt: 60, name: "Midtown low" },
];

for (const [i, s] of spots.entries()) {
  await page.evaluate((sp) => window.SKYWARD.jumpTo(sp), s);
  await sleep(30000);
  const st = await page.evaluate(() => ({
    buildings: window.SKYWARD.buildings.buildingCount,
    tiles: window.SKYWARD.buildings.primitives.size,
    alt: +window.SKYWARD.plane.alt.toFixed(1),
  }));
  console.log(`${s.name}: ${JSON.stringify(st)}`);
  await page.screenshot({ path: `shots/4${i}-facade-oblique.png` });
}
await browser.close();
