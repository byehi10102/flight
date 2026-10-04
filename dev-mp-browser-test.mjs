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

const GAME = process.env.GAME_URL || "http://127.0.0.1:5173/";
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
  // ══ A. LOBBY = MANUAL CREATE/JOIN (the only no-server path) ════════════
  console.log("\n=== A. create/join by code, in the lobby (real game) ===\n");
  const host = await openGame(browserA, "host");
  const joiner = await openGame(browserB, "joiner");

  for (const p of [host, joiner]) {
    await p.click("#mpBtn");
    await p.waitForSelector("#mpCreateBtn", { visible: true, timeout: 20000 });
  }
  check("lobby shows CREATE PARTY / JOIN directly (no separate manual screen)", true);

  // Host creates a party → the waiting room shows the invite.
  await host.click("#mpCreateBtn");
  await host.waitForFunction(() => {
    const el = document.getElementById("wrInviteOut");
    return el && el.value.startsWith("SKW1:");
  }, { timeout: 30000 });
  const invite = await host.$eval("#wrInviteOut", (el) => el.value);
  check("CREATE PARTY produced an invite code in the waiting room",
    invite.startsWith("SKW1:") && invite.length > 100, `len ${invite.length}`);
  check("host sees the share-invite step",
    await host.$eval("#wrHostBlock", (el) => !el.classList.contains("hidden")));
  check("host does not see the joiner step",
    await host.$eval("#wrJoinBlock", (el) => el.classList.contains("hidden")));

  // Joiner pastes the invite and joins → the waiting room shows the reply.
  await joiner.$eval("#mpCodeInput", (el, v) => { el.value = v; }, invite);
  await joiner.click("#mpJoinBtn");
  await joiner.waitForFunction(() => {
    const el = document.getElementById("wrReplyOut");
    return el && el.value.startsWith("SKW1:");
  }, { timeout: 30000 });
  const reply = await joiner.$eval("#wrReplyOut", (el) => el.value);
  check("JOIN accepted the code and produced a reply",
    reply.startsWith("SKW1:") && reply.length > 100, `len ${reply.length}`);
  check("joiner sees the send-reply step",
    await joiner.$eval("#wrJoinBlock", (el) => !el.classList.contains("hidden")));

  // Host pastes the reply → the direct link establishes.
  await host.$eval("#wrReplyIn", (el, v) => { el.value = v; }, reply);
  await host.click("#wrConnectBtn");

  const bothInSpawn = await waitForBothInSpawn(host, joiner, 60000);
  check("both players reached the shared spawn phase (party merged, not two lobbies)",
    bothInSpawn, `host=${await badge(host)} joiner=${await badge(joiner)}`);

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
