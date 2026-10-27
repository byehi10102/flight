/**
 * Focused multiplayer-transport probe: two pages over the WS server, watch
 * both peers maps for 40 s across lobby -> picker -> placed -> launch, and
 * log exactly when any side's peer entry changes state.
 */
import puppeteer from "puppeteer-core";
const GAME_URL = "http://127.0.0.1:5173/?devtest=1&mpserver=http://127.0.0.1:3000";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LAUNCH = {
  executablePath: CHROME, headless: true, protocolTimeout: 600000,
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
         "--enable-webgl", "--ignore-gpu-blocklist", "--window-size=640,420"],
};
const browserA = await puppeteer.launch(LAUNCH);
const browserB = await puppeteer.launch(LAUNCH);

async function open(browser) {
  const page = await browser.newPage();
  page.on("console", (m) => { const t = m.text(); if (t.includes("[mp]")) console.log(`   console: ${t.slice(0, 140)}`); });
  page.on("pageerror", (e) => console.log("   pageerror:", String(e).slice(0, 140)));
  await page.goto(GAME_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => window.SKY_DEV, { timeout: 90000, polling: 500 });
  await page.waitForFunction(() => {
    const b = document.getElementById("startBtn");
    return window.SKY_DEV?.boot?.pageGone === true && b && !b.disabled;
  }, { timeout: 150000, polling: 500 });
  await page.waitForSelector("#mpBtn", { visible: true, timeout: 30000 });
  await page.click("#mpBtn");
  await page.waitForSelector("#mpCreateBtn", { visible: true, timeout: 20000 });
  return page;
}

const host = await open(browserA);
const joiner = await open(browserB);

await host.click("#mpCreateBtn");
await host.waitForFunction(() => /^[A-Z2-9]{4}$/.test(document.getElementById("wrCodeEl").textContent.trim()), { timeout: 30000 });
const code = await host.$eval("#wrCodeEl", (el) => el.textContent.trim());
console.log("party code:", code);

await joiner.type("#mpCodeInput", code);
await joiner.click("#mpJoinBtn");
await joiner.waitForFunction(() => !document.getElementById("wrPeer").classList.contains("wr-peer-empty"), { timeout: 30000 });
console.log("BOTH CONNECTED (lobby).");

const dump = (page, label) => page.evaluate((l) => {
  const d = SKY_DEV.mp?.netDebug?.();
  const rs = SKY_DEV.mp?.remoteStats?.();
  const live = SKY_DEV.mp?.remoteLiveSample?.();
  const sent = SKY_DEV.mp?.stateStats?.().sent;
  const first = rs ? Object.values(rs)[0] : null;
  const st = SKY_DEV.state;
  return `${l}: sent=${sent} own=(${(+st.lon).toFixed(4)}, ${(+st.lat).toFixed(4)}, ${Math.round(+st.alt)}m, h=${(+st.heading).toFixed(1)})` +
    (live ? ` live.h=${live.h?.toFixed(1)} lon=${live.lon.toFixed(5)} lat=${live.lat.toFixed(5)} alt=${Math.round(live.alt)}` : " live=null") +
    (first ? ` pkts=${first.packets} delay=${Math.round(first.delayMs)} underrun=${first.underruns}` : " noras");
}, label).catch((e) => `${label}: eval failed ${String(e).slice(0, 80)}`);

for (let t = 0; t < 26; t++) {
  if (t === 6) { await host.click("#wrStartBtn"); console.log("-- host pressed START"); }
  if (t === 10) { await host.evaluate(() => SKY_DEV.placeSpawn(-98.5, 38.5, "H")); await joiner.evaluate(() => SKY_DEV.placeSpawn(-98.6, 38.45, "J")); console.log("-- both placed"); }
  if (t === 14) { try { await host.click("#confirmSpawnBtn"); console.log("-- host clicked SPAWN"); } catch (e) { console.log("-- host SPAWN click refused (gate)"); } }
  if (t === 20) { await joiner.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "d" }))); console.log("-- joiner turns (D)"); }
  if (t === 24) { await joiner.evaluate(() => window.dispatchEvent(new KeyboardEvent("keyup", { key: "d" }))); console.log("-- joiner stops"); }
  console.log(await dump(host, `t${t} HOST  `));
  console.log(await dump(joiner, `t${t} JOINER`));
  console.log("---");
  await sleep(2000);
}
await browserA.close();
await browserB.close();
