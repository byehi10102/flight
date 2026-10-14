/**
 * Drives the REAL GAME in a real browser to verify multiplayer end to end.
 *
 * The lobby IS the manual code exchange now, so this exercises the real flow:
 *   CREATE PARTY → invite code → partner JOINs → reply code → host CONNECTs.
 *
 * It also guards single player, which must be untouched.
 *
 * Requires puppeteer (not installed by default — it is heavy):
 *   npm i -D puppeteer
 *   npm run dev            # in another terminal
 *   node dev-mp-browser-test.mjs
 *
 * Two separate browser PROCESSES are used: a full Cesium scene on software
 * WebGL saturates its main thread, so two scenes in one process starve each
 * other (and Puppeteer's own calls).
 */
import puppeteer from "puppeteer";

const GAME = process.env.GAME_URL || "http://127.0.0.1:5173/?devtest=1";
const HEADLESS = process.env.HEADFUL !== "1";

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? "  — " + detail : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LAUNCH = {
  headless: HEADLESS,
  protocolTimeout: 600000,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    // Small window: software WebGL rasterises on the CPU.
    "--window-size=640,420",
    // Software WebGL so Cesium can build a viewer without a GPU.
    "--enable-unsafe-swiftshader",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
  ],
};

const browserA = await puppeteer.launch(LAUNCH);
const browserB = await puppeteer.launch(LAUNCH);
const errors = [];

async function openGame(browser, name) {
  console.log(`  … opening ${name}`);
  let page = null;
  // A software-WebGL Cesium load can be slow enough to time out navigation
  // once; retry once before giving up.
  for (let attempt = 0; attempt < 2 && !page; attempt++) {
    try {
      page = await browser.newPage();
      page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
      page.on("console", (m) => {
        const t = m.text();
        if (m.type() !== "error") return;
        // Ignore noise that is not ours: missing favicon, and individual
        // public relays being down (Trystero is not used by the lobby any
        // more, but a stale cached module may still reference it).
        if (/Failed to load resource|net::ERR|WebSocket connection to 'wss:\/\//i.test(t)) return;
        errors.push(`${name} console: ${t}`);
      });
      await page.goto(GAME, { waitUntil: "domcontentloaded", timeout: 120000 });
    } catch (e) {
      if (page) { try { await page.close(); } catch (e2) { /* already gone */ } }
      page = null;
      if (attempt === 1) throw e;
      console.log(`  … ${name} navigation timed out, retrying`);
      await sleep(2000);
    }
  }
  // Wait for the mode button: proof the module graph booted far enough for
  // the multiplayer feature (and therefore the lobby UI) to exist.
  await page.waitForSelector("#mpBtn", { timeout: 120000 });
  // The loading spinner overlays the menu until the model/terrain/audio
  // finish (or the 8s fallback fires) — clicks land on the spinner, not the
  // buttons. Wait for it to clear before interacting.
  await page.waitForFunction(
    () => { const b = document.getElementById("startBtn"); return b && !b.disabled; },
    { timeout: 120000, polling: 500 }
  );
  // TEST-ONLY: slow the render loop. A full Cesium scene on software WebGL
  // monopolises the main thread and starves Puppeteer's own calls; the
  // multiplayer handshake is event-driven and does not need 60 fps.
  await page.evaluate(() => {
    const orig = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => setTimeout(() => orig(cb), 150);
  });
  console.log(`  … ${name} ready`);
  return page;
}

/** Is this page in the shared spawn-picking phase? */
async function inSpawnPhase(page) {
  return page.evaluate(() => {
    const el = document.getElementById("spawnInstruction");
    const txt = document.getElementById("instruction-text");
    return !!el && !el.classList.contains("hidden") &&
      /PICK YOUR SPAWN|BOTH PLAYERS READY|WAITING FOR/i.test(txt ? txt.textContent : "");
  });
}

async function badge(page) {
  return page.evaluate(() => {
    const b = document.getElementById("mp-badge");
    if (!b || b.classList.contains("hidden")) return "hidden";
    const s = document.getElementById("mp-badge-status");
    const p = document.getElementById("mp-badge-peers");
    return `${s ? s.textContent : "?"} ${p ? p.textContent : "?"}`;
  });
}

async function waitForBothInSpawn(a, b, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await inSpawnPhase(a) && await inSpawnPhase(b)) return true;
    await sleep(500);
  }
  return false;
}

try {
  // ══ A. PARTY BY CODE: create → code → join → lobby → host START ══════
  console.log("\n=== A. create/join party by 4-char code, lobby, host start (real game) ===\n");
  const host = await openGame(browserA, "host");
  const joiner = await openGame(browserB, "joiner");

  for (const p of [host, joiner]) {
    await p.click("#mpBtn");
    await p.waitForSelector("#mpCreateBtn", { visible: true, timeout: 20000 });
  }
  check("lobby shows CREATE PARTY (name) / JOIN PARTY (code)", true);

  // Host names the party and creates it → a 4-character code appears.
  await host.type("#mpPartyName", "TEST SQUADRON");
  await host.click("#mpCreateBtn");
  await host.waitForFunction(() => {
    const el = document.getElementById("wrCodeEl");
    return el && /^[A-Z2-9]{4}$/.test(el.textContent.trim());
  }, { timeout: 30000 });
  const code = await host.$eval("#wrCodeEl", (el) => el.textContent.trim());
  check("CREATE PARTY produced a 4-character code", /^[A-Z2-9]{4}$/.test(code), code);

  // Joiner types the code on the OTHER DEVICE and joins the same party.
  await joiner.type("#mpCodeInput", code);
  await joiner.click("#mpJoinBtn");
  await joiner.waitForFunction(() => {
    const el = document.getElementById("wrPeer");
    return el && !el.classList.contains("wr-peer-empty");
  }, { timeout: 60000 });
  check("joiner sees PLAYER 2 connected in the list",
    /PLAYER 2/.test(await joiner.$eval("#wrPeer", (el) => el.textContent)));

  // Host sees the joiner too (both know they are connected).
  await host.waitForFunction(() => {
    const el = document.getElementById("wrPeer");
    return el && !el.classList.contains("wr-peer-empty");
  }, { timeout: 30000 });
  check("host sees PLAYER 2 connected in the list",
    /PLAYER 2/.test(await host.$eval("#wrPeer", (el) => el.textContent)));

  // START exists only for the host, and only once a partner is in.
  const jStartHidden = await joiner.$eval("#wrStartBtn", (el) => el.classList.contains("hidden"));
  check("joiner has no START button", jStartHidden);
  await host.waitForFunction(() => {
    const el = document.getElementById("wrStartBtn");
    return el && !el.classList.contains("hidden");
  }, { timeout: 20000 });
  check("host has a START button once the party is full", true);

  // Host presses START → BOTH move into the shared spawn map.
  await host.click("#wrStartBtn");
  const bothInSpawn = await waitForBothInSpawn(host, joiner, 90000);
  check("host START moved BOTH players into the shared spawn phase",
    bothInSpawn, `host=${await badge(host)} joiner=${await badge(joiner)}`);

  // The picker-entry film (enterSpawnPicking(true) now shows the full boot
  // film page) must fade out on BOTH pages before the map is clickable.
  await Promise.all([
    host.waitForFunction(() => document.getElementById("loadingIndicator")?.classList.contains("hidden"), { timeout: 60000, polling: 500 }).then(() => true).catch(() => false),
    joiner.waitForFunction(() => document.getElementById("loadingIndicator")?.classList.contains("hidden"), { timeout: 60000, polling: 500 }).then(() => true).catch(() => false),
  ]);

  // Both place their own spawn point via the game's placement path.
  await host.evaluate(() => window.SKY_DEV.placeSpawn(-117.90, 33.85, "HOST"));
  await joiner.evaluate(() => window.SKY_DEV.placeSpawn(-117.80, 33.80, "JOINER"));
  await sleep(1000);
  const hSpawnReady = await host.$eval("#confirmSpawnBtn", (el) => !el.disabled && !el.classList.contains("hidden"));
  const jSpawnReady = await joiner.$eval("#confirmSpawnBtn", (el) => !el.disabled && !el.classList.contains("hidden"));
  check("SPAWN arms for BOTH players once both placed a point", hSpawnReady && jSpawnReady,
    `host=${hSpawnReady} joiner=${jSpawnReady}`);

  // Both launch: each gets the loading + spawning animation, then flight.
  await host.click("#confirmSpawnBtn");
  await joiner.click("#confirmSpawnBtn");
  const bothFlying = await Promise.all([
    host.waitForFunction(() => window.SKY_DEV?.currentState === "FLYING", { timeout: 120000, polling: 500 }).then(() => true).catch(() => false),
    joiner.waitForFunction(() => window.SKY_DEV?.currentState === "FLYING", { timeout: 120000, polling: 500 }).then(() => true).catch(() => false),
  ]);
  check("both players are flying after the spawn animation", bothFlying.every(Boolean),
    `host=${bothFlying[0]} joiner=${bothFlying[1]}`);

  // Each sees the other's plane in their own 3D world.
  await sleep(4000);
  const hRemote = await host.evaluate(() => window.SKY_DEV.mp.remoteCount());
  const jRemote = await joiner.evaluate(() => window.SKY_DEV.mp.remoteCount());
  check("each player sees the other's airplane rendered", hRemote >= 1 && jRemote >= 1,
    `host sees ${hRemote}, joiner sees ${jRemote}`);

  // Real-time relative motion: the remote plane actually moves in my world.
  const sample1 = await host.evaluate(() => window.SKY_DEV.mp.remoteLiveSample());
  await sleep(3000);
  const sample2 = await host.evaluate(() => window.SKY_DEV.mp.remoteLiveSample());
  const moved = sample1 && sample2 && (
    Math.abs(sample2.lon - sample1.lon) > 1e-5
    || Math.abs(sample2.lat - sample1.lat) > 1e-5
    || Math.abs(sample2.alt - sample1.alt) > 1
  );
  check("the remote airplane moves in real time in my 3D world", !!moved,
    JSON.stringify({ sample1, sample2 }));

  const hBadge = await badge(host);
  const jBadge = await badge(joiner);
  check("host badge reports a live peer", /MP LIVE/.test(hBadge) && /1\/2/.test(hBadge), hBadge);
  check("joiner badge reports a live peer", /MP LIVE/.test(jBadge) && /1\/2/.test(jBadge), jBadge);

  await host.close();
  await joiner.close();

  // ══ B. SINGLE PLAYER — must be untouched by any of this ═══════════════
  console.log("\n=== B. single player (must be untouched) ===\n");
  const sp = await openGame(browserA, "sp");
  // The START button is disabled until the model/terrain/audio finish
  // loading (or the 8s fallback fires), so wait for it to be clickable.
  await sp.waitForFunction(
    () => { const b = document.getElementById("startBtn"); return b && !b.disabled; },
    { timeout: 60000, polling: 500 }
  );
  await sp.click("#startBtn");
  let spOk = false;
  for (let i = 0; i < 40; i++) {
    spOk = await sp.evaluate(() => {
      const el = document.getElementById("spawnInstruction");
      return !!el && !el.classList.contains("hidden");
    });
    if (spOk) break;
    await sleep(500);
  }
  check("single player reaches the spawn picker with no party", spOk);
  const spBadge = await sp.evaluate(() => {
    const b = document.getElementById("mp-badge");
    return !b || b.classList.contains("hidden") ? "hidden" : "visible";
  });
  check("no multiplayer badge in single player", spBadge === "hidden", spBadge);
  await sp.close();

  check("no page errors", errors.length === 0, errors.slice(0, 4).join(" | "));
} catch (err) {
  fail++;
  console.log("  FAIL  test threw: " + err.message);
  if (errors.length) console.log("        page errors: " + errors.slice(0, 4).join(" | "));
} finally {
  await browserA.close();
  await browserB.close();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
