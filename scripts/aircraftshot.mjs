import puppeteer from "puppeteer";

// Small, clipped screenshots centred on the aeroplane.
//
// `vision_analyze` has repeatedly timed out on full-size frames, and a
// 1280x800 PNG of mostly terrain is both expensive and mostly irrelevant. A
// 460x320 crop around where the aircraft actually is costs a fraction as much
// and puts the subject in every pixel.
const browser = await puppeteer.launch({
  headless: false,
  args: ["--no-sandbox", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction("!!window.SKYWARD", { timeout: 40000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(11000);

const clip = { x: 410, y: 240, width: 460, height: 320 };

await page.screenshot({ path: "shots/c1-on-runway.png", clip });
console.log("on runway captured");

await page.keyboard.down("KeyW");
await sleep(30000);
await page.screenshot({ path: "shots/c2-takeoff-roll.png", clip });
console.log("takeoff roll captured");

await page.keyboard.down("ArrowUp");
await sleep(24000);
await page.keyboard.up("ArrowUp");
await sleep(8000);
await page.screenshot({ path: "shots/c3-airborne.png", clip });
console.log("airborne captured");
await page.keyboard.up("KeyW");

const st = await page.evaluate(() => ({
  alt: +window.SKYWARD.plane.alt.toFixed(1),
  speed: +window.SKYWARD.plane.speed.toFixed(1),
  onGround: window.SKYWARD.plane.onGround,
}));
console.log("state:", JSON.stringify(st));
await browser.close();
