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
  check("lobby shows CREATE PARTY / JOIN PARTY (one code, no name field)", true);

  // Host creates the party → a 4-character code appears immediately.
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
  // Flat Kansas: the flight checks cruise for a minute at arcade speed, and
  // the Anaheim default's northern heading runs into the San Gabriels — a
  // legitimate terrain crash froze broadcasts mid-check (measured twice).
  await host.evaluate(() => window.SKY_DEV.placeSpawn(-98.50, 38.50, "HOST"));
  await joiner.evaluate(() => window.SKY_DEV.placeSpawn(-98.60, 38.45, "JOINER"));
  await sleep(1000);
  const hSpawnReady = await host.$eval("#confirmSpawnBtn", (el) => !el.disabled && !el.classList.contains("hidden"));
  const jSpawnReady = await joiner.$eval("#confirmSpawnBtn", (el) => !el.disabled && !el.classList.contains("hidden"));
  check("SPAWN arms for BOTH players once both placed a point", hSpawnReady && jSpawnReady,
    `host=${hSpawnReady} joiner=${jSpawnReady}`);

  // LAUNCH IS SYNCHRONIZED: only the HOST clicks SPAWN — the joiner must
  // follow into the loading screen + spawning animation automatically.
  await host.click("#confirmSpawnBtn");
  const bothFlying = await Promise.all([
    host.waitForFunction(() => window.SKY_DEV?.currentState === "FLYING", { timeout: 120000, polling: 500 }).then(() => true).catch(() => false),
    joiner.waitForFunction(() => window.SKY_DEV?.currentState === "FLYING", { timeout: 120000, polling: 500 }).then(() => true).catch(() => false),
  ]);
  check("ONE SPAWN click launches BOTH players together", bothFlying.every(Boolean),
    `host=${bothFlying[0]} joiner=${bothFlying[1]}`);

  // Each sees the other's plane in their own 3D world. The FIRST state
  // packet takes a moment after launch (both pages run the spawn warm-up
  // block behind the loading film), so WAIT for it rather than sleeping a
  // fixed 4 s — the P2P path's 30 s handshake made that sleep accidentally
  // generous; the real-time server connects so fast the old sleep sampled
  // mid-warm-up (measured in the e2e).
  const hRemoteOk = await host.waitForFunction(
    () => window.SKY_DEV.mp.remoteCount() >= 1, { timeout: 60000, polling: 500 },
  ).then(() => true).catch(() => false);
  const jRemoteOk = await joiner.waitForFunction(
    () => window.SKY_DEV.mp.remoteCount() >= 1, { timeout: 60000, polling: 500 },
  ).then(() => true).catch(() => false);
  check("each player sees the other's airplane rendered", hRemoteOk && jRemoteOk,
    `host sees ${await host.evaluate(() => window.SKY_DEV.mp.remoteCount())}, joiner sees ${await joiner.evaluate(() => window.SKY_DEV.mp.remoteCount())}`);

  // NETWORKED GUNFIRE: the host fires through the REAL trigger path (hold
  // F); the joiner sees the tracer streaks appear in THEIR 3D world.
  await host.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f" })));
  const jTracers = await joiner.waitForFunction(
    () => window.SKY_DEV?.mp?.remoteBulletCount?.() > 0,
    { timeout: 60000, polling: 250 },
  ).then(() => true).catch(() => false);
  await host.evaluate(() => window.dispatchEvent(new KeyboardEvent("keyup", { key: "f" })));
  check("host's bullets appear in the joiner's 3D world in real time", jTracers,
    `joiner tracers: ${await joiner.evaluate(() => window.SKY_DEV.mp.remoteBulletCount())}`);

  // MANEUVER RESPONSE (run FIRST — the joiner is 500 mph over terrain, and a
  // crash into the San Gabriels would legitimately freeze its state). This
  // flight model turns via YAW (A/D): ArrowRight rolls visually but the
  // heading only moves with the yaw keys — press D, the game's real turn
  // input, and the remote heading on the host's side visibly changes.
  // Angular distance is wrap-aware (spawns sit near due north).
  {
    // WAIT until the joiner's states are actually flowing on the host (live
    // sample present): the spawn launch blocks each page's main thread for
    // seconds, and a turn pressed during that block reaches the host late.
    await host.waitForFunction(() => window.SKY_DEV.mp.remoteLiveSample() != null,
      { timeout: 60000, polling: 500 }).catch(() => {});
    // AND still flowing now: the live pose must CHANGE within a short window
    // (a crashed/parked peer freezes its broadcast; turning measurement on a
    // frozen view proves nothing about the transport).
    const flowing = await host.waitForFunction(() => {
      const w = window.__turnFlowProbe ||= { last: null, changedAt: 0 };
      const s = window.SKY_DEV.mp.remoteLiveSample();
      if (s && w.last && (Math.abs(s.lat - w.last.lat) > 1e-6 || Math.abs(s.lon - w.last.lon) > 1e-6)) {
        w.changedAt = Date.now();
      }
      if (s) w.last = s;
      return Date.now() - w.changedAt < 2000 && w.changedAt > 0;
    }, { timeout: 60000, polling: 250 }).then(() => true).catch(() => false);
    if (!flowing) console.log("  (warn) remote states not observed flowing before the turn");
    await sleep(1000);
    const jState = await joiner.evaluate(() => window.SKY_DEV.currentState);
    const jH0 = await joiner.evaluate(() => window.SKY_DEV.state.heading);
    const h0 = (await host.evaluate(() => window.SKY_DEV.mp.remoteLiveSample()))?.h ?? 0;
    await joiner.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "d" })));
    let dH = 0;
    let crashed = jState !== "FLYING";
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      await sleep(500);
      const st = await joiner.evaluate(() => window.SKY_DEV.currentState);
      if (st !== "FLYING") { crashed = true; break; }
      const h = (await host.evaluate(() => window.SKY_DEV.mp.remoteLiveSample()))?.h ?? 0;
      let dh = h - h0;
      while (dh > 180) dh -= 360;
      while (dh < -180) dh += 360;
      dH = Math.abs(dh);
      if (dH >= 2.5) break;
    }
    await joiner.evaluate(() => window.dispatchEvent(new KeyboardEvent("keyup", { key: "d" })));
    const jH1 = await joiner.evaluate(() => window.SKY_DEV.state.heading);
    let jDH = jH1 - jH0;
    while (jDH > 180) jDH -= 360;
    while (jDH < -180) jDH += 360;
    check("a turn on one device shows up as a heading change on the other",
      dH >= 2.5,
      `remoteDH=${dH.toFixed(1)}deg, localDH=${jDH.toFixed(1)}deg over ${((Date.now() - t0) / 1000).toFixed(1)}s${crashed ? " — JOINER CRASHED (terrain, not netcode)" : ""}`);
  }

  // SMOOTHNESS METRIC (cadence-aware): this harness throttles rAF to 150ms
  // to survive software WebGL, so raw 100ms deltas are 0,0,60... by design
  // of the TEST, not the game. The honest metric is dead-reckoning
  // FIDELITY: between consecutive samples, the rendered pose must sit close
  // to where the last pose + velocity + heading say it should be — a
  // stall-then-jump that FAKES motion deviates hugely from this. Also
  // asserts no multi-second freeze (max gap between changed samples).
  const smooth = await host.evaluate(async () => {
    const samples = [];
    for (let i = 0; i < 60; i++) {
      const s = window.SKY_DEV.mp.remoteLiveSample();
      if (s) samples.push({ t: performance.now(), ...s });
      await new Promise((r) => setTimeout(r, 100));
    }
    const v = window.SKY_DEV.mp.remoteLiveSample()?.v ?? 500;
    const mps = v * 0.44704 * 1.8;
    const errs = [];
    let maxGapMs = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i];
      const dt = (b.t - a.t) / 1000;
      const expDx = Math.sin(a.h * Math.PI / 180) * mps * dt;
      const expDy = Math.cos(a.h * Math.PI / 180) * mps * dt;
      const mdx = (b.lon - a.lon) * 111320 * Math.cos(a.lat * Math.PI / 180);
      const mdy = (b.lat - a.lat) * 111320;
      const moved = Math.hypot(mdx, mdy);
      if (moved < 1) continue; // same rendered frame (harness rAF cadence)
      maxGapMs = Math.max(maxGapMs, b.t - a.t);
      errs.push(Math.hypot(mdx - expDx, mdy - expDy));
    }
    errs.sort((a, b) => a - b);
    return {
      n: samples.length,
      changes: errs.length,
      medianErr: errs[Math.floor(errs.length / 2)] ?? 0,
      maxErr: errs[errs.length - 1] ?? 0,
      maxGapMs,
    };
  });
  const jStillFlying = await joiner.evaluate(() => window.SKY_DEV.currentState === "FLYING");
  // Thresholds absorb the headless environment's cadence (rAF throttled to
  // ~150 ms and the spawn-launch main-thread block delay packets in bursts):
  // a FAKED stall-then-jump still stands out at this scale because a frozen
  // render deviates by full seconds of flight (~400 m/s), not fractions.
  const smoothOk = jStillFlying && smooth.changes >= 8
    && smooth.medianErr < 500 && smooth.maxErr < 1000 && smooth.maxGapMs < 2500;
  check("remote motion tracks its dead-reckoned path (no stall-then-jump faking)",
    smoothOk, JSON.stringify(smooth) + (jStillFlying ? "" : " — joiner crashed"));

  // Real-time relative motion: the remote plane actually moves in my world.
  // Sampled from the JOINER's view of the HOST deliberately: the host flies
  // straight out over the flat basin, while the joiner has been steered into
  // the San Gabriels by the turn check and a terrain crash legitimately
  // freezes its broadcast (fly: 0 parks the dead reckoning).
  const sample1 = await joiner.evaluate(() => window.SKY_DEV.mp.remoteLiveSample());
  await sleep(3000);
  const sample2 = await joiner.evaluate(() => window.SKY_DEV.mp.remoteLiveSample());
  const moved = sample1 && sample2 && (
    Math.abs(sample2.lon - sample1.lon) > 1e-5
    || Math.abs(sample2.lat - sample1.lat) > 1e-5
    || Math.abs(sample2.alt - sample1.alt) > 1
  );
  check("the remote airplane moves in real time in my 3D world", !!moved,
    JSON.stringify({
      sample1, sample2,
      hostState: await host.evaluate(() => window.SKY_DEV.currentState),
      hostSpeed: Math.round(await host.evaluate(() => window.SKY_DEV.state.speed)),
      joinerState: await joiner.evaluate(() => window.SKY_DEV.currentState),
      hostSent: (await host.evaluate(() => window.SKY_DEV.mp.stateStats())).sent,
    }));

  // SENDER-SIDE THRESHOLD SENDING works: in level flight the sender skips
  // beats (DR is accurate) — proof the DIS mirror matches the receiver.
  const jStats = await joiner.evaluate(() => ({
    ...window.SKY_DEV.mp.stateStats(),
    remote: window.SKY_DEV.mp.remoteStats(),
  }));
  const skipped = jStats.skipped || 0;
  check("DIS threshold sending skips redundant beats in level flight", skipped > 10,
    `sent=${jStats.sent} skipped=${skipped} forced=${jStats.forcedByThreshold}`);

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
  // Single player must reach the picker with no party anywhere.
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
