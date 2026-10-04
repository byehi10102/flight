/**
 * Drives the REAL GAME in a real browser to verify multiplayer end to end.
 *
 * Two modes are exercised through the actual UI:
 *   A. manual (copy/paste) — the no-server path
 *   B. relay (room code)   — the existing path, to prove it still works
 *
 * Asserts that both players reach the shared spawn phase and the MP badge
 * reports a live peer, i.e. the party actually merged instead of sitting in
 * two separate lobbies.
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

async function openGame(browser, name, errors) {
  console.log(`  … opening ${name}`);
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() !== "error") return;
    // Ignore noise that is not ours: missing favicon, and individual public
    // relays being down (Trystero fails over to the others and the join
    // still succeeds — that is expected behaviour, not a bug).
    if (/Failed to load resource|net::ERR|WebSocket connection to 'wss:\/\/|Trystero: relay failure/i.test(t)) return;
    errors.push(`${name} console: ${t}`);
  });
  await page.goto(GAME, { waitUntil: "domcontentloaded", timeout: 120000 });
  // Wait for the mode button: proof the module graph booted far enough for
  // the multiplayer feature (and therefore the lobby UI) to exist.
  await page.waitForSelector("#mpBtn", { timeout: 120000 });
  // TEST-ONLY: slow the render loop. Two full Cesium scenes on software
  // WebGL monopolise the main thread and starve Puppeteer's own calls; the
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

// TWO browser processes, not two tabs: a full Cesium scene on software WebGL
// saturates its main thread, so two scenes in one process starve each other
// (and Puppeteer's own calls). Separate processes get separate cores.
const browserA = await puppeteer.launch(LAUNCH);
const browserB = await puppeteer.launch(LAUNCH);
const errors = [];

try {
  // ══ A. MANUAL (no server) ═════════════════════════════════════════════
  console.log("\n=== A. manual copy/paste connect (real game) ===\n");
  const host = await openGame(browserA, "host", errors);
  const joiner = await openGame(browserB, "joiner", errors);

  // Both go to the manual panel through the real UI.
  for (const p of [host, joiner]) {
    await p.click("#mpBtn");
    await p.waitForSelector("#mpManualBtn", { visible: true, timeout: 20000 });
    await p.click("#mpManualBtn");
    await p.waitForSelector("#mnCreateBtn", { visible: true, timeout: 20000 });
  }
  check("manual panel opens from the lobby", true);

  // Host creates an invite.
  await host.click("#mnCreateBtn");
  await host.waitForFunction(() => {
    const el = document.getElementById("mnInviteOut");
    return el && el.value && el.value.startsWith("SKW1:");
  }, { timeout: 30000 });
  const invite = await host.$eval("#mnInviteOut", (el) => el.value);
  check("host produced an invite code", invite.startsWith("SKW1:") && invite.length > 100,
    `len ${invite.length}`);

  // Joiner pastes it and generates a reply.
  await joiner.$eval("#mnInviteIn", (el, v) => { el.value = v; }, invite);
  await joiner.click("#mnReplyBtn");
  await joiner.waitForFunction(() => {
    const el = document.getElementById("mnReplyOut");
    return el && el.value && el.value.startsWith("SKW1:");
  }, { timeout: 30000 });
  const reply = await joiner.$eval("#mnReplyOut", (el) => el.value);
  check("joiner produced a reply code", reply.startsWith("SKW1:") && reply.length > 100,
    `len ${reply.length}`);

  // Host pastes the reply → the link should establish.
  await host.$eval("#mnReplyIn", (el, v) => { el.value = v; }, reply);
  await host.click("#mnFinishBtn");

  const bothInSpawn = await waitForBothInSpawn(host, joiner, 60000);
  check("both players reached the shared spawn phase (party merged, not two lobbies)",
    bothInSpawn,
    `host=${await badge(host)} joiner=${await badge(joiner)}`);

  const hBadge = await badge(host);
  const jBadge = await badge(joiner);
  check("host badge reports a live peer", /MP LIVE/.test(hBadge) && /1\/2/.test(hBadge), hBadge);
  check("joiner badge reports a live peer", /MP LIVE/.test(jBadge) && /1\/2/.test(jBadge), jBadge);

  await host.close();
  await joiner.close();

  // ══ B. RELAY (room code) — the existing path must still work ══════════
  console.log("\n=== B. relay room code (regression check) ===\n");
  const a = await openGame(browserA, "relayA", errors);
  const b = await openGame(browserB, "relayB", errors);

  for (const p of [a, b]) {
    await p.click("#mpBtn");
    await p.waitForSelector("#mpCreateBtn", { visible: true, timeout: 20000 });
  }
  await a.click("#mpCreateBtn");
  await a.waitForFunction(() => {
    const el = document.getElementById("wrCode");
    return el && /^[A-Z2-9]{5}$/.test(el.textContent.trim());
  }, { timeout: 60000 });
  const roomCode = (await a.$eval("#wrCode", (el) => el.textContent)).trim();
  check("relay lobby created a 5-char code", /^[A-Z2-9]{5}$/.test(roomCode), roomCode);

  await b.$eval("#mpCodeInput", (el, v) => { el.value = v; }, roomCode);
  await b.click("#mpJoinBtn");

  const relayMerged = await waitForBothInSpawn(a, b, 60000);
  check("relay join merged into the same party (no regression)", relayMerged,
    `a=${await badge(a)} b=${await badge(b)}`);

  await a.close();
  await b.close();

  // ══ C. SINGLE PLAYER — must be untouched by any of this ═══════════════
  console.log("\n=== C. single player (must be untouched) ===\n");
  const sp = await openGame(browserA, "sp", errors);
  // The START button is disabled until the model/terrain/audio finish
  // loading (or the 8s fallback fires), so wait for it to be clickable.
  await sp.waitForFunction(
    () => {
      const b = document.getElementById("startBtn");
      return b && !b.disabled;
    },
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
