// Does rAF go dormant after a long headless settle? Sample rotY immediately,
// then wait 25 s and sample again.
import puppeteer from "puppeteer";

const GAME = process.env.GAME_URL || "http://127.0.0.1:4173/?devtest=1";
const LAUNCH = {
  headless: true,
  protocolTimeout: 600000,
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"],
};
const browser = await puppeteer.launch(LAUNCH);
const page = await browser.newPage();
await page.goto(GAME, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => window.SKY_DEV?.menuEarth, { timeout: 60000, polling: 300 });

const sample = (tag) => page.evaluate((t) => ({ t, ...window.SKY_DEV.menuEarth() }), tag);
console.log(JSON.stringify(await sample("t0")));
await new Promise((r) => setTimeout(r, 5000));
console.log(JSON.stringify(await sample("t+5s")));
await new Promise((r) => setTimeout(r, 25000));
console.log(JSON.stringify(await sample("t+30s")));
await new Promise((r) => setTimeout(r, 1500));
console.log(JSON.stringify(await sample("t+31.5s")));
// Is rAF itself firing? Install a counter and watch it.
const c = await page.evaluate(() => {
  window.__rafCount = 0;
  const bump = () => { window.__rafCount++; requestAnimationFrame(bump); };
  requestAnimationFrame(bump);
  return window.__rafCount;
});
await new Promise((r) => setTimeout(r, 2000));
const c2 = await page.evaluate(() => window.__rafCount);
console.log(`rAF frames in 2s at end: ${c2 - c}`);
await browser.close();
