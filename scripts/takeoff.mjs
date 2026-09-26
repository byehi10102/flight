import puppeteer from "puppeteer";

// Traces the takeoff so the rotation behaviour is measured, not assumed.
//
// A regional jet at MTOW genuinely needs ~1,700 m of runway, so a long roll is
// correct — but "long" and "never rotates" look identical from the outside.
const browser = await puppeteer.launch({
  headless: false,
  args: ["--no-sandbox", "--window-size=900,600"],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 600 });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message.slice(0, 120)));
await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction("!!window.SKYWARD", { timeout: 40000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(11000);

const snap = () =>
  page.evaluate(() => {
    const S = window.SKYWARD;
    return {
      t: +(performance.now() / 1000).toFixed(1),
      v: +S.plane.speed.toFixed(1),
      alt: +S.plane.alt.toFixed(1),
      vs: +S.plane.verticalSpeed.toFixed(2),
      pitch: +((S.plane.pitch * 180) / Math.PI).toFixed(1),
      thr: +S.plane.throttle.toFixed(2),
      g: S.plane.onGround ? "GND" : "AIR",
      dist: +S.plane.distanceFlown.toFixed(0),
    };
  });

// Rotate at the real point instead of mashing ArrowUp from a standstill: hold
// W until the rotation speed, then rotate.
await page.keyboard.down("KeyW");
let last = null;
let rotated = false;
for (let i = 0; i < 40; i++) {
  await sleep(3000);
  const s = await snap();
  if (i % 3 === 0 || s.g === "AIR") console.log(JSON.stringify(s));
  if (!rotated && s.v > 74) {
    await page.keyboard.down("ArrowUp");
    rotated = true;
    console.log("  >>> rotation input applied");
  }
  if (s.g === "AIR" && s.alt > 250) {
    last = s;
    break;
  }
  last = s;
}
await page.keyboard.up("ArrowUp");
await page.keyboard.up("KeyW");
console.log("final:", JSON.stringify(last));
console.log("errors:", errs.length ? [...new Set(errs)].slice(0, 3).join(" | ") : "(none)");
await browser.close();
