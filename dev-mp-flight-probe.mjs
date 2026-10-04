/**
 * Multiplayer FLIGHT probe — the scenario the user reports.
 *
 * Two browsers connect through the real lobby, both place a spawn, both
 * launch, and then we measure on BOTH pages:
 *   - the sim advancing (HUD coords changing),
 *   - the peer marker on the minimap (red pixels — does it move?),
 *   - the frame rate.
 *
 * If the peer marker never moves while both sims advance, the state stream
 * is not flowing during flight — the remote plane would be frozen, which is
 * the "hovering" symptom.
 */
import puppeteer from "puppeteer";

const GAME = "http://127.0.0.1:5173/";
const LAUNCH = {
  headless: true,
  protocolTimeout: 600000,
  args: [
    "--no-sandbox", "--disable-setuid-sandbox", "--window-size=640,420",
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--enable-webgl", "--ignore-gpu-blocklist",
  ],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browserA = await puppeteer.launch(LAUNCH);
const browserB = await puppeteer.launch(LAUNCH);

async function open(name) {
  const browser = name === "host" ? browserA : browserB;
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log(`${name} PAGEERROR: ${e.message}`));
  await page.goto(GAME, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector("#mpBtn", { timeout: 120000 });
  await page.waitForFunction(
    () => { const b = document.getElementById("startBtn"); return b && !b.disabled; },
    { timeout: 120000, polling: 500 }
  );
  await page.click("#mpBtn");
  await page.waitForSelector("#mpCreateBtn", { visible: true, timeout: 20000 });
  console.log(`  … ${name} in the lobby`);
  return page;
}

/** Read the red peer marker off the minimap canvas (dot when close, rim arrow when far). */
async function peerMarker(page) {
  return page.evaluate(() => {
    const c = document.getElementById("minimap");
    if (!c) return null;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    const img = ctx.getImageData(0, 0, c.width, c.height);
    let n = 0, sx = 0, sy = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      if (r > 180 && g < 90 && b < 90) { n++; sx += (i / 4) % c.width; sy += Math.floor(i / 4 / c.width); }
    }
    if (!n) return { found: false };
    return { found: true, x: sx / n, y: sy / n, pixels: n };
  });
}

try {
  const host = await open("host");
  const joiner = await open("joiner");

  // Handshake through the real lobby.
  await host.click("#mpCreateBtn");
  await host.waitForFunction(() => {
    const el = document.getElementById("wrInviteOut");
    return el && el.value.startsWith("SKW1:");
  }, { timeout: 30000 });
  const invite = await host.$eval("#wrInviteOut", (el) => el.value);

  await joiner.$eval("#mpCodeInput", (el, v) => { el.value = v; }, invite);
  await joiner.click("#mpJoinBtn");
  await joiner.waitForFunction(() => {
    const el = document.getElementById("wrReplyOut");
    return el && el.value.startsWith("SKW1:");
  }, { timeout: 30000 });
  const reply = await joiner.$eval("#wrReplyOut", (el) => el.value);

  await host.$eval("#wrReplyIn", (el, v) => { el.value = v; }, reply);
  await host.click("#wrConnectBtn");

  // Both reach the shared spawn phase.
  for (const p of [host, joiner]) {
    await p.waitForFunction(() => {
      const el = document.getElementById("spawnInstruction");
      return el && !el.classList.contains("hidden");
    }, { timeout: 60000 });
  }
  console.log("  … both in the spawn phase");

  // Both place a spawn and confirm.
  for (const [name, p] of [["host", host], ["joiner", joiner]]) {
    const canvas = await p.$("#cesiumContainer canvas");
    const box = await canvas.boundingBox();
    let placed = false;
    for (let i = 0; i < 20 && !placed; i++) {
      await p.mouse.click(box.x + box.width * (name === "host" ? 0.5 : 0.62), box.y + box.height * 0.6);
      try {
        await p.waitForFunction(() => {
          // In multiplayer the button is SHOWN once you place, but stays
          // disabled until BOTH players have placed.
          const b = document.getElementById("confirmSpawnBtn");
          return b && !b.classList.contains("hidden");
        }, { timeout: 1500, polling: 250 });
        placed = true;
      } catch (e) { /* globe not loaded under that pixel yet */ }
    }
    if (!placed) throw new Error(`${name} could not place a spawn`);
    console.log(`  … ${name} placed a spawn`);
  }

  // Diagnostics: what does each page think about the gate and the link?
  for (const [name, p] of [["host", host], ["joiner", joiner]]) {
    const d = await p.evaluate(() => ({
      btnClass: document.getElementById("confirmSpawnBtn")?.className || null,
      btnDisabled: document.getElementById("confirmSpawnBtn")?.disabled ?? null,
      diag: (document.getElementById("wrDiag") || {}).textContent || "",
      status: (document.getElementById("wrStatus") || {}).textContent || "",
    }));
    console.log(`  ${name}:`, JSON.stringify(d));
  }

  // The gate enables on BOTH once both players have placed.
  for (const [name, p] of [["host", host], ["joiner", joiner]]) {
    await p.waitForFunction(() => {
      const b = document.getElementById("confirmSpawnBtn");
      return b && !b.classList.contains("hidden") && !b.disabled;
    }, { timeout: 90000, polling: 500 });
    await p.click("#confirmSpawnBtn");
    console.log(`  … ${name} launched`);
  }

  // Wait until BOTH sims are advancing (the dive is a camera flight during
  // which the sim is legitimately paused).
  async function simMoving(p) {
    let prev = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 150000) {
      const c = await p.evaluate(() => (document.getElementById("coords") || {}).textContent || "");
      if (prev && c && c !== prev) return true;
      prev = c;
      await sleep(1000);
    }
    return false;
  }
  const hMoving = await simMoving(host);
  const jMoving = await simMoving(joiner);
  console.log(`\nsim advancing: host=${hMoving} joiner=${jMoving}`);
  if (!hMoving || !jMoving) {
    console.log("A SIM NEVER STARTED MOVING — flight never began for one player");
    await browserA.close(); await browserB.close();
    process.exit(1);
  }

  // Sample both minimaps: the peer marker must exist and move.
  console.log("\npeer marker on the minimap (samples ~2 s apart):");
  let moved = false;
  let first = null;
  for (let i = 0; i < 8; i++) {
    const hm = await peerMarker(host);
    const jm = await peerMarker(joiner);
    console.log(`  host sees: ${JSON.stringify(hm)}   joiner sees: ${JSON.stringify(jm)}`);
    if (hm?.found) {
      if (!first) first = hm;
      else if (Math.hypot(hm.x - first.x, hm.y - first.y) > 1.5) moved = true;
    }
    await sleep(2000);
  }
  console.log(`\npeer marker present and moving on the minimap: ${moved}`);

  const hud = await host.evaluate(() => ({
    coords: (document.getElementById("coords") || {}).textContent || "",
    speed: (document.getElementById("speed") || {}).textContent || "",
    fps: (document.getElementById("fps") || {}).textContent || "",
  }));
  console.log("host HUD:", JSON.stringify(hud));

  await browserA.close();
  await browserB.close();
  console.log(`\nRESULT: ${hMoving && jMoving ? "both flying" : "stuck"}; peer marker moving=${moved}`);
} catch (err) {
  console.log("PROBE FAILED: " + err.message);
  await browserA.close();
  await browserB.close();
  process.exit(1);
}
