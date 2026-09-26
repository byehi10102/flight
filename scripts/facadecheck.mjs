import puppeteer from "puppeteer";

// Do the facades actually reach the screen?
//
// The building loader catches per-tile failures and reports them with
// `console.warn`. Every error listener in this project filtered on
// /Error|Invalid|failed/, which silently discarded them — so a broken facade
// path looked exactly like a slow one. This listens for warnings too, and
// checks the thing that matters: buildings counted AND primitives built.
const browser = await puppeteer.launch({
  headless: false,
  args: ["--no-sandbox", "--window-size=1000,650"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1000, height: 650 });
const all = [];
page.on("pageerror", (e) => all.push(`pageerror: ${e.message.slice(0, 160)}`));
page.on("console", (m) => {
  const t = m.text();
  if (/buildings|facade|warn|error|fail|invalid|shader/i.test(t)) all.push(`${m.type()}: ${t.slice(0, 4000)}`);
});

await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction("!!window.SKYWARD", { timeout: 40000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(8000);

await page.evaluate(() => {
  window.SKYWARD.jumpTo({ lon: -73.985, lat: 40.748, alt: 380, name: "Midtown Manhattan" });
});
await sleep(34000);

const state = await page.evaluate(() => {
  const S = window.SKYWARD;
  const b = S.buildings;
  return {
    buildingCount: b.buildingCount,
    tiles: b.primitives.size,
    emptyTiles: b.emptyTiles ? b.emptyTiles.size : null,
    trackedTallest: b.tallest.length,
    tallest: b.tallest.length ? b.tallest[0] : null,
    scenePrimitives: S.viewer.scene.primitives.length,
    alt: +S.plane.alt.toFixed(1),
  };
});
console.log("state:", JSON.stringify(state, null, 1));

const ok = state.buildingCount > 2000 && state.tiles > 5;
console.log(`\n${ok ? "PASS" : "FAIL"}  facades built: ${state.buildingCount} buildings across ${state.tiles} tiles`);
console.log("console:");
for (const l of [...new Set(all)].slice(0, 3)) console.log("  " + l);
if (!all.length) console.log("  (clean)");

await page.screenshot({ path: "shots/30-facades.png" });
await browser.close();
process.exit(ok ? 0 : 1);
