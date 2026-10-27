/**
 * Vehicle model smoke: pick each plane in the selector, fly it, and assert
 * the spin nodes were found (CRJ fans, Global Hawk prop) with no page errors.
 */
import puppeteer from "puppeteer-core";
const GAME_URL = "http://127.0.0.1:5173/?devtest=1";
const CHROME = "C:\\Users\\jaxzc.JACKSON\\.config\\openchamber\\chats\\2026-10-25\\session-69771d7f-7232-439f-8b38-9a7884f53c99\\flight-game\\node_modules\\puppeteer-core\\.local-chromium\\placeholder";
const CHROME_REAL = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME_REAL, headless: true, protocolTimeout: 600000,
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

async function flyVehicle(id) {
  await page.goto(GAME_URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.SKY_DEV, { timeout: 60000, polling: 500 });
  await page.waitForFunction(() => {
    const b = document.getElementById("startBtn");
    return window.SKY_DEV?.boot?.pageGone === true && b && !b.disabled;
  }, { timeout: 150000, polling: 500 });
  await page.click("#startBtn");
  await page.waitForSelector("#aircraftSelect:not(.hidden)", { timeout: 30000 });
  await page.evaluate((vid) => {
    [...document.querySelectorAll("#aircraftSelect .fleet-card")]
      .find((c) => c.dataset.id === vid).click();
  }, id);
  await page.click("#fleetGoBtn");
  await page.waitForFunction(() => SKY_DEV.currentState === "PICK_SPAWN", { timeout: 30000, polling: 250 });
  await page.evaluate((vid) => SKY_DEV.placeSpawn(-98.5, 38.5, vid.toUpperCase()), id);
  await sleep(400);
  await page.evaluate(() => document.getElementById("confirmSpawnBtn")?.click());
  await page.waitForFunction(() => SKY_DEV.currentState === "FLYING", { timeout: 120000, polling: 500 });
  await page.keyboard.down("w");
  await sleep(6000);
  return page.evaluate(() => {
    const pm = SKY_DEV.planeModel;
    const spinNodeNames = [];
    pm.model?.traverse((c) => { if (/ROTOR|PROP|FAN/i.test(c.name || "")) spinNodeNames.push(c.name); });
    return {
      vehicle: pm.vehicle?.id,
      scale: +pm.modelScale,
      spin: spinNodeNames,
      speed: Math.round(SKY_DEV.state.speed),
      state: SKY_DEV.currentState,
    };
  });
}

const crj = await flyVehicle("crj900");
check("CRJ-900 loads + flies", crj.state === "FLYING" && crj.speed > 200, JSON.stringify(crj));
check("CRJ-900 has 2 fan nodes", crj.spin.length === 2 && crj.spin.every((n) => n.startsWith("FAN")), crj.spin.join(","));

const hawk = await flyVehicle("hawk");
check("Global Hawk loads + flies", hawk.state === "FLYING" && hawk.speed > 200, JSON.stringify(hawk));
check("Global Hawk has PROP node", hawk.spin.includes("PROP"), hawk.spin.join(","));

check("no page errors across both flights", errors.length === 0, errors.slice(0, 3).join(" | "));
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
