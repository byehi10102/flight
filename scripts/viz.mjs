import puppeteer from "puppeteer";

const target = { lat: 40.7549, lon: -73.984, height: 260, label: "Midtown Manhattan" };
const name = process.argv[2] || "viz";

const browser = await puppeteer.launch({
  headless: false,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=760,520"],
});
const page = await browser.newPage();
await page.setViewport({ width: 760, height: 520 });
await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction("!!window.SKYWARD", { timeout: 30000 });
await new Promise((r) => setTimeout(r, 4000));
await page.evaluate((t) => window.SKYWARD.jumpTo(t), target);

// Let the streamer fill in.
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 4000));
  const n = await page.evaluate(() => window.SKYWARD.buildings.primitives.size);
  if (i % 3 === 0) console.log(`  t=${(i + 1) * 4}s buildingTiles=${n}`);
  if (n > 12) break;
}
await page.screenshot({ path: `shot-${name}.png` });
console.log("wrote shot-" + name + ".png");
await browser.close();
