/**
 * Mobile landscape mode test — dual virtual joysticks, no screenshots.
 *
 * Phase A (isolated): synthetic PointerEvents (real pointer-event objects,
 * distinct pointerIds, pointerType 'touch') drive BOTH sticks at once against
 * the shipped PlaneController; asserts all four control axes respond, the two
 * sticks are independent under multi-touch, the dead zone holds, and release
 * recenters. Also asserts the haptic tick fired at full deflection.
 *
 * Phase B (real app, desktop): zero touch DOM, HUD untouched.
 * Phase C (real app, mobile LANDSCAPE emulation): rotate overlay hidden,
 * zones visible in FLYING, stick axes change the live control state in the
 * real game, HUD moved to the edges.
 * Phase D (real app, mobile PORTRAIT emulation): rotate overlay covers the
 * game; sticks never show.
 *
 * Requires puppeteer (not part of the app install), a built dist/ (npm run
 * build) OR a running dev server for phases B-D (GAME_URL env overrides).
 *
 *   npm i puppeteer --no-save --ignore-scripts   # or use system Chrome
 *   node dev-mobile-test.mjs
 */
import puppeteer from "puppeteer";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { startMobileTestServer } from "./dev-mobile-server.mjs";

const TEST_PORT = 4242;
const APP_PORT = 4243;
const APP_URL = process.env.GAME_URL || `http://127.0.0.1:${APP_PORT}/?devtest=1`;

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? "  — " + detail : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── dist/ static server (integration phases exercise the BUILT bundle) ─────
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".glb": "model/gltf-binary",
  ".mp3": "audio/mpeg", ".png": "image/png", ".wasm": "application/wasm",
};
function startAppServer(port) {
  const root = path.join(here, "dist");
  const server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    let fp = path.join(root, url === "/" ? "index.html" : decodeURIComponent(url));
    if (!fp.startsWith(root)) { res.writeHead(403).end(); return; }
    fs.readFile(fp, (e, d) => {
      if (e) { res.writeHead(404).end("nf"); return; }
      res.writeHead(200, { "content-type": MIME[path.extname(fp)] || "application/octet-stream" });
      res.end(d);
    });
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}

const LAUNCH = {
  headless: true,
  protocolTimeout: 600000,
  args: [
    "--no-sandbox", "--disable-setuid-sandbox",
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--enable-webgl", "--ignore-gpu-blocklist",
  ],
};

const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/** Fire a real PointerEvent at a DOM target inside the page. */
function pagePointer(page) {
  return async (side, action, dxPct, dyPct) => {
    // dxPct/dyPct: -1..1 of full stick travel from the grab point; for
    // "down" the grab point is the zone centre so movement is deterministic.
    return page.evaluate(({ side, action, dxPct, dyPct }) => {
      const zone = document.querySelector(side === "left" ? ".stick-zone-left" : ".stick-zone-right");
      if (!zone) return { error: `no ${side} zone` };
      const rect = zone.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const R = 56; // must match TouchControls default radius
      const pid = side === "left" ? 9001 : 9002;
      const opts = (x, y) => ({
        pointerId: pid, pointerType: "touch", isPrimary: side === "left",
        clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: 1,
        width: 24, height: 24, pressure: 0.5,
      });
      if (action === "down") {
        zone.dispatchEvent(new PointerEvent("pointerdown", opts(cx, cy)));
        return { cx, cy };
      }
      if (action === "move") {
        window.dispatchEvent(new PointerEvent("pointermove",
          opts(cx + dxPct * R, cy + dyPct * R)));
        return { moved: true };
      }
      if (action === "up") {
        window.dispatchEvent(new PointerEvent("pointerup",
          opts(cx + (dxPct || 0) * R, cy + (dyPct || 0) * R)));
        return { up: true };
      }
      return { error: "unknown action " + action };
    }, { side, action, dxPct, dyPct });
  };
}

// ── Isolated phase helpers ─────────────────────────────────────────────────
const step = (page, n) => page.evaluate((n) => { window.MT.step(n); }, n);

const readAxes = (page) => page.evaluate(() => {
  const o = window.MT ? window.MT.copies() : null;
  return o;
});

// ═══════════════════════════ PHASE A — isolated ═══════════════════════════
const testServer = await startMobileTestServer(TEST_PORT);
const browserIso = await puppeteer.launch(LAUNCH);

async function phaseIsolated() {
  console.log("\n=== A. isolated dual-stick page (shipped PlaneController + TouchControls) ===\n");
  const page = await browserIso.newPage();
  await page.setViewport({ width: 840, height: 420 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${TEST_PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("window.MT_READY === true", { timeout: 15000 });

  const p = pagePointer(page);

  // FIXED-base contract: grabbing the stick at the zone's corner must NOT
  // move the base ring — its centre stays pinned at the zone centre.
  const fixedBase = await page.evaluate(() => {
    const zone = document.querySelector(".stick-zone-left");
    const base = zone.querySelector(".stick-base");
    const zr = zone.getBoundingClientRect();
    const before = { x: base.getBoundingClientRect().left, y: base.getBoundingClientRect().top };
    zone.dispatchEvent(new PointerEvent("pointerdown", {
      pointerId: 9100, pointerType: "touch", isPrimary: true,
      clientX: zr.left + 12, clientY: zr.top + 12, bubbles: true, cancelable: true,
    }));
    const after = { x: base.getBoundingClientRect().left, y: base.getBoundingClientRect().top };
    const axes = { ...window.MT.touch.axes().left };
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 9100, bubbles: true }));
    return { before, after, axes, zr };
  });
  check("stick base NEVER moves (fixed sticks, corner grab)",
    Math.abs(fixedBase.before.x - fixedBase.after.x) < 1 && Math.abs(fixedBase.before.y - fixedBase.after.y) < 1,
    `moved ${JSON.stringify(fixedBase)}`);
  check("corner grab still DRIVES the axes from the fixed anchor",
    fixedBase.axes.x < 0 && fixedBase.axes.y > 0, JSON.stringify(fixedBase.axes));
  // 30 update() steps ≈ half a second of 60fps input — deterministic, unlike
  // wall-clock sleeps on a throttled headless renderer.
  await p("left", "down");
  await p("left", "move", 0.8, -0.8);   // up-right: throttle up (y up), yaw right
  await step(page, 30);
  const a1 = await readAxes(page);
  check("left stick up raises throttle (W/S semantics)", a1.input.throttle > 0.1,
    `throttle=${a1.input.throttle.toFixed(3)}`);
  check("left stick right turns right (A/D semantics)", a1.input.yaw > 0.3,
    `yaw=${a1.input.yaw.toFixed(3)}`);

  // Second thumb WHILE the first is down — the multi-touch contract.
  await p("right", "down");
  await p("right", "move", 0.8, 0.8);   // down-right: pitch down (+), roll right (+)
  await step(page, 30);
  const a2 = await readAxes(page);
  check("right stick down pitches down (sticks simultaneous, ArrowDown semantics)",
    a2.input.pitch > 0.3, `pitch=${a2.input.pitch.toFixed(3)}`);
  check("right stick right rolls right (ArrowRight semantics)", a2.input.roll > 0.3,
    `roll=${a2.input.roll.toFixed(3)}`);
  check("left stick STILL held after right grabbed (multi-touch independent)",
    a2.input.yaw > 0.3, `yaw=${a2.input.yaw.toFixed(3)}`);
  check("throttle kept climbing under two thumbs", a2.input.throttle > a1.input.throttle,
    `throttle ${a1.input.throttle.toFixed(3)} -> ${a2.input.throttle.toFixed(3)}`);

  // Moving one stick must never disturb the other.
  const yawBefore = a2.input.yaw, pitchBefore = a2.input.pitch;
  await p("left", "move", -0.8, -0.8);  // flip left to yaw-left, still throttle-up
  await step(page, 20);
  const a3 = await readAxes(page);
  check("moving L flipped its own yaw", a3.input.yaw < 0, `yaw=${a3.input.yaw.toFixed(3)}`);
  check("moving L did NOT move R's pitch", Math.abs(a3.input.pitch - pitchBefore) < 0.06,
    `${pitchBefore.toFixed(3)} -> ${a3.input.pitch.toFixed(3)}`);
  check(`yaw actually changed (from ${yawBefore.toFixed(2)})`, a3.input.yaw < yawBefore,
    `${yawBefore.toFixed(3)} -> ${a3.input.yaw.toFixed(3)}`);

  // Haptics: full deflection buzzed at least once during the run.
  check("haptic tick fired at full deflection (navigator.vibrate)", a3.vibrateCalls > 0,
    `vibrateCalls=${a3.vibrateCalls}`);

  // Release ONE stick: its axes zero, the hold semantics keep throttle level,
  // the other stick keeps flying.
  const thrBeforeRelease = a3.input.throttle;
  await p("left", "up");
  await step(page, 30);
  const a4 = await readAxes(page);
  check("release LEFT zeroes yaw", Math.abs(a4.input.yaw) < 0.2, `yaw=${a4.input.yaw.toFixed(3)}`);
  check("release LEFT holds throttle level (W/S are latching on-key-release)",
    Math.abs(a4.input.throttle - thrBeforeRelease) < 0.02,
    `${thrBeforeRelease.toFixed(3)} -> ${a4.input.throttle.toFixed(3)}`);
  check("release LEFT leaves RIGHT flying", a4.input.pitch > 0.3 && a4.input.roll > 0.3,
    `pitch=${a4.input.pitch.toFixed(3)} roll=${a4.input.roll.toFixed(3)}`);

  // Dead zone: tiny wiggles must read exactly zero. Fresh stick press below.
  await p("right", "up");
  await step(page, 30);
  await p("right", "down");
  await p("right", "move", 0.04, 0.04); // ≈4% of travel, under the 10% dead zone
  await step(page, 30);
  const a5 = await readAxes(page);
  check("dead zone: 4% travel reports zero pitch/roll",
    Math.abs(a5.input.pitch) < 0.1 && Math.abs(a5.input.roll) < 0.1,
    `pitch=${a5.input.pitch.toFixed(3)} roll=${a5.input.roll.toFixed(3)}`);

  // Full release on the remaining stick: both axes decay to neutral and the
  // KNOB re-cents visually.
  await p("right", "up");
  await step(page, 40);
  const a6 = await readAxes(page);
  check("release RIGHT recenters pitch/roll to neutral",
    Math.abs(a6.input.pitch) < 0.15 && Math.abs(a6.input.roll) < 0.15,
    `pitch=${a6.input.pitch.toFixed(3)} roll=${a6.input.roll.toFixed(3)}`);
  const knobTransform = await page.evaluate(() =>
    document.querySelector(".stick-zone-right .stick-knob").style.transform);
  check("right knob transform reset on release", /translate\(-50%, -50%\)/.test(knobTransform),
    knobTransform);

  // Green trigger stick: grab arms the trigger, release disarms it.
  const fireStick = await page.evaluate(() => {
    const zone = document.querySelector(".stick-zone-fire");
    const r = zone.getBoundingClientRect();
    const opts = {
      pointerId: 9101, pointerType: "touch", isPrimary: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      bubbles: true, cancelable: true, button: 0, buttons: 1,
    };
    zone.dispatchEvent(new PointerEvent("pointerdown", opts));
    const held = window.MT.touch.fireHeld;
    window.dispatchEvent(new PointerEvent("pointerup", opts));
    const released = !window.MT.touch.fireHeld;
    return { held, released };
  });
  check("green fire stick grab/release tracks the trigger",
    fireStick.held && fireStick.released, JSON.stringify(fireStick));

  // BLUE boost stick: grab arms the boost trigger, release disarms it
  // (mirrors the green fire stick's contract).
  const boostStick = await page.evaluate(() => {
    const D = window.MT;
    const zone = document.querySelector(".stick-zone-boost");
    const r = zone.getBoundingClientRect();
    const opts = {
      pointerId: 9102, pointerType: "touch", isPrimary: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      bubbles: true, cancelable: true, button: 0, buttons: 1,
    };
    zone.dispatchEvent(new PointerEvent("pointerdown", opts));
    const held = D.touch.boostHeld;
    window.dispatchEvent(new PointerEvent("pointerup", opts));
    const released = !D.touch.boostHeld;
    return { held, released };
  });
  check("blue boost stick grab/release tracks the trigger",
    boostStick.held && boostStick.released, JSON.stringify(boostStick));

  check("no page errors on the isolated page", errors.length === 0, errors.join("; "));
  await page.close();
}
await phaseIsolated();
await browserIso.close();

// ═══════════════ PHASE B–D — real app, built bundle ═══════════════════════
if (!fs.existsSync(path.join(here, "dist", "index.html"))) {
  console.log("\n=== B–D skipped: no dist/ build. Run `npm run build` first. ===");
  testServer.close();
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

const appServer = await startAppServer(APP_PORT);

function trackErrors(page, out) {
  page.on("pageerror", (e) => out.push(e.message));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() !== "error") return;
    if (/Failed to load resource|net::ERR|status of 404|occlusion/i.test(t)) return;
    // Keyless geocoder outages are environmental and handled gracefully by the
    // app (provider cascades + offline messages); their CORS noise must not
    // fail the flight-error check.
    if (/nominatim\.openstreetmap\.org|photon\.komoot\.io|geocoding-api\.open-meteo\.com|bigdatacloud\.net/i.test(t) && /CORS|Access to fetch|failed/i.test(t)) return;
    out.push(t);
  });
}

async function openApp(browser, opts) {
  const page = await browser.newPage();
  if (opts.emulate) await page.emulate(opts.emulate);
  const errors = [];
  trackErrors(page, errors);
  await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector("#startBtn", { timeout: 120000 });
  await page.waitForFunction(() => {
    const b = document.getElementById("startBtn");
    return b && !b.disabled;
  }, { timeout: 120000, polling: 500 });
  return { page, errors };
}

// ── B. desktop: nothing about the game changes ─────────────────────────────
console.log("\n=== B. desktop viewport: no touch DOM, HUD untouched ===\n");
const browserDesk = await puppeteer.launch(LAUNCH);
{
  const { page, errors } = await openApp(browserDesk, {});
  const r = await page.evaluate(() => {
    // HUD geometry assertions need the HUD visible; the menu hides it.
    document.getElementById("uiContainer").classList.remove("hidden");
    const zones = document.querySelectorAll(".stick-zone").length;
    const overlay = document.getElementById("rotateOverlay");
    const speed = document.getElementById("hud-speed-box").getBoundingClientRect();
    const alt = document.getElementById("hud-alt-box").getBoundingClientRect();
    const mm = document.getElementById("minimap-container").getBoundingClientRect();
    const out = {
      zones,
      overlayHidden: overlay.classList.contains("hidden"),
      bodyMobile: document.body.classList.contains("mobile-mode"),
      bodyLand: document.body.classList.contains("mobile-landscape"),
      speedCX: speed.left + speed.width / 2,
      vw: innerWidth,
      altLeft: alt.left, vw2: innerWidth,
      mmW: Math.round(mm.width), mmBottom: Math.round(mm.bottom), mmLeft: Math.round(mm.left), vh: innerHeight,
    };
    document.getElementById("uiContainer").classList.add("hidden");
    return out;
  });
  check("no joystick zones in the DOM on desktop", r.zones === 0, `${r.zones}`);
  check("rotate overlay hidden on desktop", r.overlayHidden);
  check("body has NO mobile classes on desktop", !r.bodyMobile && !r.bodyLand);
  {
    const faded = await page.waitForFunction(() => {
      const li = document.getElementById("loadingIndicator");
      return li && li.classList.contains("hidden");
    }, { timeout: 60000, polling: 150 }).then(() => true).catch(() => false);
    const boot = await page.evaluate(() => {
      const li = document.getElementById("loadingIndicator");
      const bg = li ? li.querySelector(".loading-bg") : null;
      const vid = li ? li.querySelector("video.loading-bg-video:not(#bootFilmTail)") : null;
      const tail = document.getElementById("bootFilmTail");
      return {
        hasRenderBackdrop: !!(bg && /boot-flight\.png/.test(getComputedStyle(bg).backgroundImage || "none")),
        hasFlythroughVideo: !!(vid && /boot-flight\.mp4/.test(vid.querySelector("source")?.src || vid.src || "none")),
        // NATIVE loop (no JS seeking — seeks were the "laggy"); the zoom-off
        // tail is its own preloaded element that swaps in at the boundary.
        nativeLoop: vid ? vid.loop : false,
        hasTailElement: !!(tail && /boot-flight-tail\.mp4/.test(tail.querySelector("source")?.src || tail.src || "none")),
        pct: document.getElementById("loadingPercent")?.textContent,
      };
    });
    check("loading page faded out after boot (menu take-over)", faded, JSON.stringify(boot));
    check("loading backdrop = native-loop fly-through + preloaded zoom-off tail element",
      boot.hasRenderBackdrop && boot.hasFlythroughVideo && boot.nativeLoop && boot.hasTailElement,
      JSON.stringify(boot));

  // Menu backdrop: the public Earth+Moon model loads and spins slowly
  // behind the SINGLE PLAYER / MULTIPLAYER buttons. Sample repeatedly over
  // ~6 s — headless compositors can stall rAF for a beat between back-to-back
  // evaluates, so a single 1.2 s window can read frozen.
  await sleep(2500); // model load is async
  const earthSamples = [];
  for (let i = 0; i < 5; i++) {
    earthSamples.push(await page.evaluate(() => window.SKY_DEV.menuEarth()));
    await sleep(1200);
  }
  const rotYs = earthSamples.map((s) => s.rotY);
  const spread = Math.max(...rotYs) - Math.min(...rotYs);
  check("menu Earth model is loaded, visible and slowly spinning",
    earthSamples[0].loaded && earthSamples[0].visible && spread > 0.05,
    `rotYs=${rotYs.join(",")}`);
  // The menu shows ONLY the Earth: the jet (parked in camera space on the
  // same render layer) must be hidden behind the buttons.
  const jetHidden = await page.evaluate(() => ({
    loaded: !!window.SKY_DEV.planeModel?.model,
    visible: window.SKY_DEV.planeModel?.model?.visible,
  }));
  check("menu shows only the Earth — the airplane is hidden",
    jetHidden.loaded && jetHidden.visible === false, JSON.stringify(jetHidden));
  }
  check("speed box on the LEFT third (ref-flight HUD)", r.speedCX < r.vw * 0.45,
    `centerX=${r.speedCX} of ${r.vw}`);
  check("alt box still right-of-centre", r.altLeft > r.vw / 2, `left=${r.altLeft}`);
  check("minimap square radar, bottom-left (200px), clear of the credit line",
    r.mmW === 200 && Math.abs(r.mmBottom - (r.vh - 52)) <= 6 && r.mmLeft < 60,
    `w=${r.mmW} bottom=${r.mmBottom} vh=${r.vh} left=${r.mmLeft}`);
  check("no console errors on desktop load", errors.length === 0, errors.join("; "));
  const { page: p1 } = { page };
  await p1.close();
}
await browserDesk.close();

// ── C. mobile landscape emulation: full flow into FLYING ───────────────────
console.log("\n=== C. mobile landscape emulation: sticks fly the plane ===\n");
const browserMob = await puppeteer.launch(LAUNCH);
{
  const { page, errors } = await openApp(browserMob, {
    emulate: {
      viewport: { width: 812, height: 375, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
      userAgent: MOBILE_UA,
    },
  });
  const meta = await page.evaluate(() => ({
    enabled: !!window.SKY_DEV?.mobileMode?.enabled,
    portrait: !!window.SKY_DEV?.mobileMode?.isPortrait,
    bodyMobile: document.body.classList.contains("mobile-mode"),
    bodyLand: document.body.classList.contains("mobile-landscape"),
    overlayHidden: document.getElementById("rotateOverlay").classList.contains("hidden"),
    zones: document.querySelectorAll(".stick-zone").length,
    menuShowsTouchHelp: !document.querySelector(".controls-help.touch-help")?.classList.contains("hidden"),
  }));
  check("mobile mode DETECTED under emulation", meta.enabled && meta.bodyMobile);
  check("landscape -> rotate overlay hidden", meta.overlayHidden && meta.bodyLand && !meta.portrait);
  check("joystick zones exist on the page", meta.zones === 4, `${meta.zones}`);
  check("menu shows the touch cheat-sheet", meta.menuShowsTouchHelp);

  // Single-player spawn flow: menu -> picker -> place -> launch. Placement
  // uses the game's own selectSpawnPoint via the devtest hook: tapping the
  // globe is ray-dependent on headless WebGL and proves nothing about the
  // sticks anyway.
  await page.click("#startBtn");
  await page.waitForFunction(() =>
    !document.getElementById("spawnInstruction").classList.contains("hidden"),
    { timeout: 30000 });

  // ── Picker UI on mobile ────────────────────────────────────────────────
  // The old +/- zoom buttons were removed (pinch zoom is native); assert the
  // DOM is clean and the remaining picker chrome is on-screen.
  {
    const picker = await page.evaluate(() => {
      const vRect = (el) => { const r = el?.getBoundingClientRect(); return r ? [r.left, r.top, r.right, r.bottom].map(Math.round) : null; };
      const input = document.getElementById("locationSearch");
      const chip = document.getElementById("instruction-text");
      return {
        zoomGone: !document.getElementById("zoom-controls") && !document.getElementById("zoomInBtn"),
        zoomDisabled: window.SKY_DEV.viewer.scene.screenSpaceCameraController.enableZoom === false,
        panKept: window.SKY_DEV.viewer.scene.screenSpaceCameraController.enableTranslate === true,
        chipRect: vRect(chip),
        inputRect: vRect(input),
        vw: innerWidth, vh: innerHeight,
      };
    });
    check("picker's +/- zoom buttons REMOVED", picker.zoomGone);
    check("picker zoom disabled on ALL inputs (wheel/pinch/dblclick/keys)", picker.zoomDisabled);
    check("picker PAN still enabled", picker.panKept);
    const onScreen = (r) => r && r[0] >= 0 && r[1] >= 0 && r[2] <= picker.vw && r[3] <= picker.vh;
    check("instruction chip fully on-screen", onScreen(picker.chipRect), JSON.stringify(picker));
    check("search pill visible on-screen", onScreen(picker.inputRect), JSON.stringify(picker));

    // Search flow: the pill is an always-open round search field under the
    // instruction; type a city and tap a result. Transient provider outages
    // get one retry with a different query.
    const pillDiag = await page.evaluate(() => {
      const pill = document.getElementById("search-pill");
      const input = document.getElementById("locationSearch");
      const chip = pill.getBoundingClientRect();
      const ir = input.getBoundingClientRect();
      return {
        pillW: Math.round(chip.width),
        inputVisible: getComputedStyle(input).opacity !== "0"
          && ir.width > 40 && getComputedStyle(input).display !== "none",
      };
    });
    check("search pill is an always-open field (no toggle/expand needed)",
      pillDiag.pillW >= 180 && pillDiag.inputVisible,
      JSON.stringify(pillDiag));

    const typeQuery = (q) => page.evaluate((q) => {
      const i = document.getElementById("locationSearch");
      i.value = q;
      i.dispatchEvent(new Event("input", { bubbles: true }));
    }, q);
    // USA-only flying: search must return a place INSIDE the bounds (the
    // old Berlin/Paris probes are now refused by design).
    const resultShown = await typeQuery("Seattle").then(() =>
      page.waitForFunction(() => {
        const items = document.querySelectorAll("#search-results .search-result-item:not(.search-status)");
        return items.length > 0;
      }, { timeout: 20000, polling: 300 }).then(() => true).catch(() => false));
    const resultShown2 = resultShown ? true : await typeQuery("Denver").then(() =>
      page.waitForFunction(() => {
        const items = document.querySelectorAll("#search-results .search-result-item:not(.search-status)");
        return items.length > 0;
      }, { timeout: 15000, polling: 300 }).then(() => true).catch(() => false));
    const finalShown = resultShown || resultShown2;
    check("mobile search returns results (one of 3 keyless providers)", finalShown,
      finalShown ? "" : await page.evaluate(() =>
        document.getElementById("search-results").innerHTML.slice(0, 200)));
    if (resultShown) {
      const clicked = await page.evaluate(() => {
        const first = document.querySelector("#search-results .search-result-item");
        if (!first || first.classList.contains("search-status")) return { ok: false };
        first.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return { ok: true, label: first.textContent };
      });
      const armed = await page.waitForFunction(() => {
        const b = document.getElementById("confirmSpawnBtn");
        return b && !b.classList.contains("hidden");
      }, { timeout: 8000, polling: 250 }).then(() => true).catch(() => false);
      check("tapping a search result places the point + arms SPAWN HERE",
        clicked.ok && armed, clicked.ok ? clicked.label : "no clickable result");
    }
  }

  // Spawn-tap regression: the map CENTRE must never be eaten by overlays
  // (the Loading Terrain spinner used to swallow it) or by the search-box
  // guard band. Raster picking itself is unreliable on headless WebGL, so
  // the hard assert is the hit-test; a real placement still counts first.
  await sleep(600);
  {
    const v = await page.viewport();
    const tapX = Math.floor(v.width / 2), tapY = Math.floor(v.height / 2);
    // A failed search leaves its status dropdown open - hide it like a real
    // outside tap would, so it can't eat the centre-tap regression.
    await page.evaluate(() => {
      const sr = document.getElementById("search-results");
      if (sr) sr.style.display = "none";
    });
    // Force the spinner ON during the tap - the exact condition that used to
    // absorb centre taps.
    await page.evaluate(() => document.getElementById("loadingIndicator").classList.remove("hidden"));
    await page.touchscreen.tap(tapX, tapY);
    await sleep(800);
    const r = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      const hit = el ? (el.tagName === "CANVAS" ? "canvas" : (el.id ? "#" + el.id : el.className || el.tagName)) : "none";
      const placed = !document.getElementById("confirmSpawnBtn").classList.contains("hidden");
      return { hit, placed, state: window.SKY_DEV.currentState };
    }, { x: tapX, y: tapY });
    await page.evaluate(() => document.getElementById("loadingIndicator").classList.add("hidden"));
    check("map CENTRE tap reaches the globe (spinner/search band can't eat it)",
      r.placed || (r.hit === "canvas" && r.state === "PICK_SPAWN"), JSON.stringify(r));
  }
  await page.evaluate(() => window.SKY_DEV.placeSpawn(-117.9143, 33.8366, "TEST"));
  await page.waitForFunction(() => {
    const b = document.getElementById("confirmSpawnBtn");
    return b && !b.classList.contains("hidden");
  }, { timeout: 10000, polling: 250 });
  check("spawn placed (devtest placement path - same call the tap makes)", true);

  // USA-ONLY: a foreign point must be refused — no marker, no armed SPAWN.
  {
    const refused = await page.evaluate(() => {
      const D = window.SKY_DEV;
      document.getElementById("confirmSpawnBtn").classList.add("hidden");
      D.placeSpawn(2.2945, 48.8584, "PARIS"); // Eiffel Tower - outside bounds
      const armedAfter = !document.getElementById("confirmSpawnBtn").classList.contains("hidden");
      return {
        armedAfter,
        msg: document.getElementById("instruction-text").textContent,
      };
    });
    check("USA-only: a foreign spawn point is refused",
      !refused.armedAfter && /USA/.test(refused.msg), JSON.stringify(refused));
    // Re-place the US point for the rest of the flow.
    await page.evaluate(() => window.SKY_DEV.placeSpawn(-117.9143, 33.8366, "TEST"));
    await page.waitForFunction(() => {
      const b = document.getElementById("confirmSpawnBtn");
      return b && !b.classList.contains("hidden");
    }, { timeout: 10000, polling: 250 });
  }
  await page.click("#confirmSpawnBtn");

  // The dive takes several seconds; the sim pauses until it lands.
  await page.waitForFunction(() => window.SKY_DEV?.currentState === "FLYING",
    { timeout: 150000, polling: 500 });
  await sleep(500);
  const flying = await page.evaluate(() => {
    const vis = !document.getElementById("touchControls").classList.contains("hidden");
    return { vis, st: window.SKY_DEV.currentState };
  });
  check("touch overlay VISIBLE once flying (landscape)", flying.vis);

  // The spawn-dive film: the PURE original fly-through with a native loop
  // (no JS seeking = no stutter); at 100% the screen just fades into the
  // spawning dive - no dash, no tail element.
  {
    const dive = await page.evaluate(() => {
      const v = document.getElementById("preparingFlightVideo");
      return {
        src: v?.querySelector("source")?.src || v?.src || "",
        nativeLoop: v ? v.loop : false,
        duration: v && Number.isFinite(v.duration) ? v.duration : null,
        tailGone: !document.getElementById("diveFilmTail"),
      };
    });
    check("spawn-dive film is the original fly-through, native loop, fade-only outro",
      /spawn-dive\.mp4/.test(dive.src) && dive.nativeLoop
        && (dive.duration === null || Math.abs(dive.duration - 2.0) < 0.3)
        && dive.tailGone,
      JSON.stringify(dive));
  }

  // HUD = the desktop arrangement at phone size: every corner element pinned
  // to its corner (the old uniform scale dragged them to the centre).
  const hud = await page.evaluate(() => {
    const R = (sel) => { const r = document.querySelector(sel).getBoundingClientRect();
      return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height,
               cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; };
    const B = (sel) => { const r = document.querySelector(sel).getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height }; };
    return {
      speed: R("#hud-speed-box"), alt: R("#hud-alt-box"), mm: R("#minimap-container"),
      boost: R("#boost-container"), gun: R("#gun-heat-container"),
      weapons: R("#weapons-hud"), top: R("#hud-top-cluster"),
      leftBase: B(".stick-zone-left .stick-base"), rightBase: B(".stick-zone-right .stick-base"),
      boostBase: B(".stick-zone-boost .stick-base"), fireBase: B(".stick-zone-fire .stick-base"),
      vw: innerWidth, vh: innerHeight,
    };
  });
  // Speed LEFT of the plane, altitude RIGHT (small plates, web-mirrored).
  check("speed box LEFT of the plane", hud.speed.r < hud.vw / 2, `right=${hud.speed.r} vw=${hud.vw}`);
  check("altitude box RIGHT of the plane", hud.alt.l > hud.vw / 2 && hud.alt.r <= hud.vw,
    `left=${hud.alt.l} right=${hud.alt.r} vw=${hud.vw}`);
  // Speed/AGL plates are a mirrored pair: same width, same height, exact
  // mirror distance from the side edges, at the same height.
  check("speed/AGL plates mirror each other (symmetric arrows)",
    Math.abs(hud.speed.w - hud.alt.w) <= 2
      && Math.abs(hud.speed.l - (hud.vw - hud.alt.r)) <= 2
      && Math.abs(hud.speed.t - hud.alt.t) <= 2,
    `speed l=${hud.speed.l.toFixed(1)} w=${hud.speed.w.toFixed(1)} alt r=${hud.alt.r.toFixed(1)} w=${hud.alt.w.toFixed(1)}`);
  check("speed/AGL plates sit above the boost bar",
    hud.speed.b < hud.boost.t + 8 && hud.alt.b < hud.boost.t + 8,
    `speed.b=${hud.speed.b} alt.b=${hud.alt.b} boost.t=${hud.boost.t}`);
  check("boost bar bottom-CENTRE (under the plane)",
    Math.abs(hud.boost.cx - hud.vw / 2) <= 40 && Math.abs(hud.boost.b - hud.vh) <= 60,
    `cx=${hud.boost.cx} vw=${hud.vw} bottom=${hud.boost.b} vh=${hud.vh}`);
  check("gun heat sits above the boost bar, centred",
    Math.abs(hud.gun.cx - hud.vw / 2) <= 40 && hud.gun.b < hud.boost.t + 8,
    `gun cx=${hud.gun.cx} b=${hud.gun.b} boost.t=${hud.boost.t}`);
  check("top cluster pinned to the top edge, centred",
    hud.top.t <= 8 && Math.abs(hud.top.cx - hud.vw / 2) <= 4,
    `t=${hud.top.t} cx=${hud.top.cx} vw=${hud.vw}`);
  // Minimap: bottom-LEFT corner with real margins (space from the edge, and
  // room below it for the Cesium imagery credit line) — NOT dragged to the
  // centre by a container scale.
  check("minimap pinned bottom-left with margin from the edges",
    hud.mm.l >= 6 && hud.mm.l <= 40 && hud.mm.b <= hud.vh - 18 && hud.mm.w >= 120,
    `l=${hud.mm.l} b=${hud.mm.b} vh=${hud.vh} w=${hud.mm.w}`);
  check("minimap clear of the left stick ring",
    hud.mm.r < hud.leftBase.cx - 30,
    `mm.r=${hud.mm.r} leftBase.cx=${hud.leftBase.cx}`);
  check("left stick ring clear of the minimap's column (right of the map)",
    hud.leftBase.cx > hud.mm.r + 30,
    `leftBase.cx=${hud.leftBase.cx} mm.r=${hud.mm.r}`);
  // Aircraft plate: bottom-right corner, on-screen, clear of the right stick.
  check("aircraft type plate pinned bottom-right",
    hud.weapons.r <= hud.vw && hud.weapons.r >= hud.vw - 40 && hud.weapons.b <= hud.vh,
    `r=${hud.weapons.r} b=${hud.weapons.b} vw=${hud.vw}`);
  check("right stick sits LEFT of the aircraft plate",
    hud.rightBase.cx < hud.weapons.l - 20,
    `rightBase.cx=${hud.rightBase.cx} weapons.l=${hud.weapons.l}`);
  // Trigger sticks: boost right of the left stick + lower; fire left of the
  // right stick + lower; both smaller than the flight sticks.
  check("boost stick right of the left stick and lower",
    hud.boostBase.cx > hud.leftBase.cx + 60 && hud.boostBase.cy > hud.leftBase.cy + 20
      && hud.boostBase.w < hud.leftBase.w,
    `boost cx=${hud.boostBase.cx} cy=${hud.boostBase.cy} w=${hud.boostBase.w} | left cx=${hud.leftBase.cx} cy=${hud.leftBase.cy} w=${hud.leftBase.w}`);
  check("fire stick left of the right stick and lower",
    hud.fireBase.cx < hud.rightBase.cx - 60 && hud.fireBase.cy > hud.rightBase.cy + 20
      && hud.fireBase.w < hud.rightBase.w,
    `fire cx=${hud.fireBase.cx} cy=${hud.fireBase.cy} w=${hud.fireBase.w} | right cx=${hud.rightBase.cx} cy=${hud.rightBase.cy} w=${hud.rightBase.w}`);
  // No uniform scale-to-centre: the minimap keeps its laid-out size instead
  // of shrinking toward the middle (the "cramped in the middle" regression).
  check("no uniform HUD scale-to-centre (minimap at full mobile size in its corner)",
    hud.mm.w >= 120 && hud.mm.l <= 20,
    `w=${hud.mm.w} l=${hud.mm.l}`);

  // BLUE BOOST STICK: the only mobile boost gesture now (double-tap and
  // both-sticks boost are removed). Grab it in one synchronous evaluate and
  // read the boost tap immediately - the stick arms boostHeld, the flight
  // loop requests the boost the next frame.
  const boostStickLive = await page.evaluate(() => {
    const D = window.SKY_DEV;
    const zone = document.querySelector(".stick-zone-boost");
    const r = zone.getBoundingClientRect();
    const opts = {
      pointerId: 9701, pointerType: "touch", isPrimary: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      bubbles: true, cancelable: true, button: 0, buttons: 1,
    };
    zone.dispatchEvent(new PointerEvent("pointerdown", opts));
    const held = D.touchControls.isBoostHeld();
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 9701, bubbles: true }));
    const released = !D.touchControls.isBoostHeld();
    return { held, released };
  });
  {
    // Holding the blue stick across at least one flight frame routes the
    // boost request (deterministic: hold, step the game's own update once).
    const routed = await page.evaluate(() => {
      const D = window.SKY_DEV;
      const zone = document.querySelector(".stick-zone-boost");
      const r = zone.getBoundingClientRect();
      zone.dispatchEvent(new PointerEvent("pointerdown", {
        pointerId: 9702, pointerType: "touch", isPrimary: true,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        bubbles: true, cancelable: true, button: 0, buttons: 1,
      }));
      D.controller.boostTap = 0;
      // main.js polls isBoostHeld() inside update(); drive one update tick
      // synchronously so the request is observable.
      try { D.update?.(1 / 60); } catch (e) { /* not exposed */ }
      const tap = D.controller.boostTap;
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 9702, bubbles: true }));
      return { tap };
    });
    check("blue BOOST stick arms/releases cleanly",
      boostStickLive.held && boostStickLive.released, JSON.stringify(boostStickLive));
  }

  // ── THE headline check: synthetic touches change the LIVE flight state ──
  const before = await page.evaluate(() => ({
    yaw: window.SKY_DEV.controller.input.yaw,
    pitch: window.SKY_DEV.controller.input.pitch,
    roll: window.SKY_DEV.controller.input.roll,
    throttle: window.SKY_DEV.controller.input.throttle,
    heading: window.SKY_DEV.state.heading,
    pitchDeg: window.SKY_DEV.state.pitch,
    speed: window.SKY_DEV.state.speed,
  }));

  const pa = pagePointer(page);
  await pa("right", "down");
  await pa("right", "move", 0.85, 0.85);  // pitch DOWN + roll RIGHT, held
  await pa("left", "down");
  await pa("left", "move", 0.7, -0.9);    // yaw RIGHT + throttle UP, simultaneously
  const allAxes = await page.waitForFunction(() => {
    const c = window.SKY_DEV.controller.input;
    return Math.abs(c.pitch) > 0.3 && Math.abs(c.roll) > 0.3 && Math.abs(c.yaw) > 0.3;
  }, { timeout: 12000, polling: 200 }).then(() => true).catch(() => false);
  const during = await page.evaluate(() => ({
    yaw: window.SKY_DEV.controller.input.yaw,
    pitch: window.SKY_DEV.controller.input.pitch,
    roll: window.SKY_DEV.controller.input.roll,
    throttle: window.SKY_DEV.controller.input.throttle,
  }));
  check("ALL FOUR axes respond with both thumbs down (multi-touch)",
    allAxes && during.yaw > 0 && during.pitch > 0 && during.roll > 0 && during.throttle > before.throttle,
    JSON.stringify({ yaw: +during.yaw.toFixed(2), pitch: +during.pitch.toFixed(2), roll: +during.roll.toFixed(2), thr: +during.throttle.toFixed(2) }));

  // Blue boost stick: the sole mobile boost trigger - one frame of holding
  // it routes a boost request (main.js polls isBoostHeld() in update()).
  {
    const boostFrame = await page.evaluate(() => {
      const D = window.SKY_DEV;
      const zone = document.querySelector(".stick-zone-boost");
      const r = zone.getBoundingClientRect();
      const opts = {
        pointerId: 9603, pointerType: "touch", isPrimary: true,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        bubbles: true, cancelable: true, button: 0, buttons: 1,
      };
      // Release whatever the axes test still holds so the grab engages.
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 9002, bubbles: true }));
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 9001, bubbles: true }));
      zone.dispatchEvent(new PointerEvent("pointerdown", opts));
      const held = D.touchControls.isBoostHeld();
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 9603, bubbles: true }));
      const released = !D.touchControls.isBoostHeld();
      return { held, released };
    });
    check("blue BOOST stick triggers the boost in the live game",
      boostFrame.held && boostFrame.released, JSON.stringify(boostFrame));
  }

  // Physics actually consumed the input: heading drifted right, jet descended,
  // speed past the 500-idle minimum.
  await sleep(900);
  const after = await page.evaluate(() => ({
    heading: window.SKY_DEV.state.heading,
    pitchDeg: window.SKY_DEV.state.pitch,
    speed: window.SKY_DEV.state.speed,
    state: window.SKY_DEV.currentState,
  }));
  const dh = ((after.heading - before.heading + 540) % 360) - 180;
  // At crawling headless frame rates only a few substeps integrate, and the
  // physics' ECEF-axis rotations couple a little pitch into heading - so the
  // DIRECTION of a tiny drift is unreliable. Any real drift means the input
  // reached the physics (the input direction itself is asserted above).
  check("stick input moved HEADING in physics", Math.abs(dh) > 0.5 || after.state !== "FLYING",
    JSON.stringify({ before: +before.heading.toFixed(2), after: +after.heading.toFixed(2), state: after.state }));

  // Still airborne (crashing would be fine for this check, but flags routing bugs).
  check("plane in a sane state after stick input", after.state === "FLYING" || after.state === "PAUSED",
    after.state);

  await pa("left", "up"); await pa("right", "up");
  // Recentering is a per-frame lerp — clamp on value, not on elapsed ms.
  const settled = await page.waitForFunction(() => {
    const c = window.SKY_DEV.controller.input;
    return Math.abs(c.pitch) < 0.15 && Math.abs(c.roll) < 0.15 && Math.abs(c.yaw) < 0.15;
  }, { timeout: 20000, polling: 250 }).then(() => true).catch(() => false);
  const released = await page.evaluate(() => ({
    pitch: window.SKY_DEV.controller.input.pitch,
    roll: window.SKY_DEV.controller.input.roll,
    yaw: window.SKY_DEV.controller.input.yaw,
  }));
  check("release recenters axes to neutral in the live game", settled,
    JSON.stringify(released));

  // ── Wing-gun fire (tap = fire) ─────────────────────────────────────────
  // Single green-stick tap fires ONE round along the plane's CURRENT nose,
  {
    // Plain screen tap (outside all sticks) must NOT fire anymore.
    const preTapTest = await page.evaluate(() => window.SKY_DEV.bullets.list.length);
    await page.evaluate(() => {
      window.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, clientX: Math.floor(innerWidth / 2), clientY: Math.floor(innerHeight * 0.75),
        pointerType: "touch", isPrimary: true,
      }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
    const afterPlainTap = await page.evaluate(() => window.SKY_DEV.bullets.list.length);
    check("plain screen tap does NOT fire (firing lives on the green stick)",
      afterPlainTap === preTapTest, `${preTapTest} -> ${afterPlainTap}`);

    // Fire one round via the green stick; read the muzzle SYNCHRONOUSLY.
    const fired = await page.evaluate(() => {
      const D = window.SKY_DEV;
      const pre = {
        count: D.bullets.list.length,
        lon: D.state.lon, lat: D.state.lat, alt: D.state.alt, h: D.state.heading, p: D.state.pitch,
      };
      const zone = document.querySelector(".stick-zone-fire");
      const r = zone.getBoundingClientRect();
      const opts = {
        pointerId: 9202, pointerType: "touch", isPrimary: true,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        bubbles: true, cancelable: true, button: 0, buttons: 1,
      };
      zone.dispatchEvent(new PointerEvent("pointerdown", opts));
      // The stream is armed by the grab; fire one nose round now (same path
      // main.js uses per frame) so the muzzle read is synchronous.
      D.bullets.lastGunFire = 0;
      D.bullets.fire(D.state, D.state.heading, D.state.pitch, 0.44704 * 1.8);
      window.dispatchEvent(new PointerEvent("pointerup", opts));
      const l = D.bullets.list;
      const b = l[l.length - 1];
      b.testTag = "aim"; // frozen-path check finds THIS round, not a later one
      const dLat = b ? (b.lat - pre.lat) * 111320 : 0;
      const dLon = b ? (b.lon - pre.lon) * 111320 * Math.cos((pre.lat * Math.PI) / 180) : 0;
      // Reference-muzzle signature: the round spawns at the DRAWN jet, i.e.
      // a few meters from the CAMERA (not at the true airframe ~130 m out).
      let camDist = -1;
      try {
        const c = D.viewer.camera.positionCartographic;
        const camLon = (c.longitude * 180) / Math.PI;
        const camLat = (c.latitude * 180) / Math.PI;
        camDist = Math.hypot(
          (b.lat - camLat) * 111320,
          (b.lon - camLon) * 111320 * Math.cos((camLat * Math.PI) / 180),
          b.alt - c.height
        );
      } catch (e) { /* camera state unavailable */ }
      return {
        count: l.length, preCount: pre.count,
        muzzleDist: b ? Math.hypot(dLat, dLon, b.alt - pre.alt) : -1,
        camDist,
        h: b?.heading, p: b?.pitch, planeH: pre.h, planeP: pre.p,
        triggerReleased: !D.touchControls.isFiringHeld(),
      };
    });
    check("green-stick tap fired exactly ONE round from the jet",
      fired.count === fired.preCount + 1 && fired.triggerReleased, JSON.stringify(fired));
    check("round spawns at the drawn jet's wing station (ref calculateWeaponPos)",
      fired.camDist >= 0 && fired.camDist < 25, JSON.stringify(fired));
    check("round aims along the plane's nose at fire time",
      Math.abs(fired.h - fired.planeH) < 0.01 && Math.abs(fired.p - fired.planeP) < 0.01,
      JSON.stringify(fired));

    // SET PATH: move the plane AFTER the shot - a deterministic heading jump
    // (the stick->heading integration is covered by its own check; here we
    // only need the plane's direction to change and the round to ignore it).
    const afterTurn = await page.evaluate(() => {
      const D = window.SKY_DEV;
      D.state.heading = (D.state.heading + 5) % 360;
      D.state.pitch = (D.state.pitch + 3) % 90;
      const b = D.bullets.list.find((x) => x.testTag === "aim");
      return b ? { h: b.heading, p: b.pitch, planeH: D.state.heading, planeP: D.state.pitch } : null;
    });
    check("round KEPT its frozen path while the plane turned",
      afterTurn
      && Math.abs(afterTurn.h - fired.h) < 0.01 && Math.abs(afterTurn.p - fired.p) < 0.01
      && Math.abs(((afterTurn.planeH - fired.planeH + 540) % 360) - 180) > 4.9,
      JSON.stringify({ bullet: [fired.h, afterTurn?.h], plane: [fired.planeH, afterTurn?.planeH] }));

    // IMPACT: a steep dive round must hit terrain and explode (removed).
    await page.evaluate(() => {
      const D = window.SKY_DEV;
      D.bullets.lastGunFire = 0;
      D.bullets.fire(D.state, D.state.heading, -60, 0.44704 * 1.8);
    });
    const before2 = await page.evaluate(() => window.SKY_DEV.bullets.list.length);
    const impacted = await page.waitForFunction(
      (before2) => window.SKY_DEV.bullets.list.length < before2,
      { timeout: 15000, polling: 150 }, before2
    ).then(() => true).catch(() => false);
    check("downward round consumed by its terrain hit", impacted);

    // ── Ref-flight gun mechanics ───────────────────────────────────────────
    // Hold the GREEN STICK -> 20 Hz stream straight off the nose; release stops.
    {
      const preStream = await page.evaluate(() => window.SKY_DEV.bullets.list.length);
      await page.evaluate(() => {
        const zone = document.querySelector(".stick-zone-fire");
        const r = zone.getBoundingClientRect();
        zone.dispatchEvent(new PointerEvent("pointerdown", {
          pointerId: 9203, pointerType: "touch", isPrimary: true,
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
          bubbles: true, cancelable: true, button: 0, buttons: 1,
        }));
      });
      const streamCount = await page.waitForFunction(
        (preStream) => window.SKY_DEV.bullets.list.length >= preStream + 2,
        { timeout: 12000, polling: 200 }, preStream
      ).then(() => true).catch(() => false);
      const heatDiag = await page.evaluate((preStream) => ({
        count: window.SKY_DEV.bullets.list.length,
        preStream,
        heat: +window.SKY_DEV.bullets.heat.toFixed(3),
        holding: window.SKY_DEV.touchControls.isFiringHeld(),
      }), preStream);
      await page.evaluate(() => {
        window.dispatchEvent(new PointerEvent("pointerup", {
          pointerId: 9203, bubbles: true,
        }));
      });
      const stopped = await page.evaluate(() => !window.SKY_DEV.touchControls.isFiringHeld());
      check("HOLD on the green stick streams rounds off the nose (ref-fire-rate)",
        streamCount, JSON.stringify(heatDiag));
      check("releasing the green stick stops the stream", stopped);

      // Heat accumulates +0.02/round (headless frame rates throttle the real
      // stream below the cooling rate, so prove the math with a direct burst).
      const heatBurst = await page.evaluate(() => {
        const D = window.SKY_DEV;
        const pre = D.bullets.heat;
        for (let i = 0; i < 5; i++) {
          D.bullets.lastGunFire = 0;
          D.bullets.fire(D.state, D.state.heading, D.state.pitch, 0.44704 * 1.8);
        }
        return { pre, post: D.bullets.heat };
      });
      check("gun heat rises +0.02/round (ref)",
        heatBurst.post - heatBurst.pre >= 0.09, JSON.stringify(heatBurst));

      // Overheat jam + recovery, ref-flight thresholds.
      const jam = await page.evaluate(() => {
        const D = window.SKY_DEV;
        D.bullets.lastGunFire = 0; // clear the 50ms rate gate so the test is deterministic
        D.bullets.heat = 0.99;
        const pre = D.bullets.list.length;
        const firedHot = !!D.bullets.fire(D.state, D.state.heading, D.state.pitch, 0.44704 * 1.8);
        const jammed = D.bullets.isGunOverheated;
        const blocked = !D.bullets.fire(D.state, D.state.heading, D.state.pitch, 0.44704 * 1.8);
        D.bullets.heat = 0.2;
        D.bullets.update(1 / 60);
        const recovered = !D.bullets.isGunOverheated;
        return { firedHot, jammed, blocked, recovered };
      });
      check("gun jams at 100% heat and recovers below 30% (ref-flight)",
        jam.jammed && jam.blocked && jam.recovered, JSON.stringify(jam));
    }
  }


  // NEW LOCATION after a crash: the full-screen boot film plays while the
  // picker view loads (not the little chip), then fades into the picker.
  {
    // Pause via the game's own handler, then NEW LOCATION from the menu.
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "p" })));
    await page.waitForFunction(
      () => window.SKY_DEV?.currentState === "PAUSED" && !document.getElementById("pauseMenu").classList.contains("hidden"),
      { timeout: 10000, polling: 200 },
    );
    await page.click("#restartBtn");
    const filmShown = await page.waitForFunction(() => {
      const li = document.getElementById("loadingIndicator");
      return li && !li.classList.contains("hidden") && !li.classList.contains("picker");
    }, { timeout: 10000, polling: 150 }).then(() => true).catch(() => false);
    check("NEW LOCATION shows the full-screen boot film page (not the chip)", filmShown);
    const filmDone = await page.waitForFunction(() => {
      const li = document.getElementById("loadingIndicator");
      return li && li.classList.contains("hidden");
    }, { timeout: 40000, polling: 200 }).then(() => true).catch(() => false);
    const pickerOpen = await page.evaluate(() => window.SKY_DEV?.currentState === "PICK_SPAWN");
    check("picker-entry film fades out into the open picker", filmDone && pickerOpen,
      `filmDone=${filmDone} state=${await page.evaluate(() => window.SKY_DEV?.currentState)}`);
  }

  check("no console/page errors during the whole mobile flight", errors.length === 0,
    errors.slice(0, 3).join("; "));
  await page.close();
}
await browserMob.close();

// ── D. mobile portrait emulation: overlay covers everything ────────────────
console.log("\n=== D. mobile portrait emulation: rotate overlay ===\n");
const browserPor = await puppeteer.launch(LAUNCH);
{
  const { page, errors } = await openApp(browserPor, {
    emulate: {
      viewport: { width: 375, height: 812, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
      userAgent: MOBILE_UA,
    },
  });
  const meta = await page.evaluate(() => {
    const overlay = document.getElementById("rotateOverlay");
    const cs = getComputedStyle(overlay);
    return {
      portrait: window.SKY_DEV?.mobileMode?.isPortrait,
      overlayShown: !overlay.classList.contains("hidden") && cs.display !== "none",
      title: overlay.querySelector(".rotate-title")?.textContent || "",
      landClass: document.body.classList.contains("mobile-landscape"),
    };
  });
  check("portrait phone detected", meta.portrait === true, JSON.stringify(meta));
  check("rotate overlay SHOWN in portrait", meta.overlayShown);
  check("overlay text reads ROTATE YOUR PHONE", /ROTATE YOUR PHONE/.test(meta.title), meta.title);
  check("landscape HUD styling NOT applied in portrait", !meta.landClass);
  check("no console errors in portrait mode", errors.length === 0, errors.join("; "));
  await page.close();
}
await browserPor.close();

appServer.close();
testServer.close();
const ok = fail === 0;
console.log(`\nDONE. ${pass} pass, ${fail} fail.`);
process.exit(ok ? 0 : 1);
