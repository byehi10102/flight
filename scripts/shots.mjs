import puppeteer from "puppeteer";

const browser = await puppeteer.launch({
  headless: false,
  args: ["--no-sandbox", "--window-size=680,460"],
});
const page = await browser.newPage();
await page.setViewport({ width: 680, height: 460 });
await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction("!!window.SKYWARD", { timeout: 30000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(14000);

await page.screenshot({ path: "shot-a-parked.png" });
console.log("parked");

// Roll down the runway and lift off.
await page.keyboard.down("w");
await sleep(16000);
await page.screenshot({ path: "shot-b-liftoff.png" });
console.log("liftoff");
await sleep(9000);
await page.keyboard.up("w");
await sleep(6000);
await page.screenshot({ path: "shot-c-climb.png" });
console.log("climb");

// Over a dense city.
await page.evaluate(() =>
  window.SKYWARD.jumpTo({ lat: 40.7549, lon: -73.984, height: 300, label: "Midtown" }),
);
for (let i = 0; i < 10; i++) {
  await sleep(3000);
  const n = await page.evaluate(() => window.SKYWARD.buildings.primitives.size);
  if (n > 10) break;
}
await page.screenshot({ path: "shot-d-city.png" });
console.log("city");
await browser.close();
