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
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
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
  check("speed box still CENTRED (desktop HUD)", Math.abs(r.speedCX - r.vw / 2) < 40,
    `centerX=${r.speedCX} of ${r.vw}`);
  check("alt box still right-of-centre", r.altLeft > r.vw2 / 2, `left=${r.altLeft}`);
  check("minimap still desktop-size (180px), bottom-right",
    r.mmW === 180 && Math.abs(r.mmBottom - (r.vh - 226)) <= 6 && r.mmLeft > r.vw - 220,
    `w=${r.mmW} bottom=${r.mmBottom} vh=${r.vh}`);
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
  check("two joystick zones exist on the page", meta.zones === 2, `${meta.zones}`);
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
        chipRect: vRect(chip),
        inputRect: vRect(input),
        vw: innerWidth, vh: innerHeight,
      };
    });
    check("picker's +/- zoom buttons REMOVED", picker.zoomGone);
    const onScreen = (r) => r && r[0] >= 0 && r[1] >= 0 && r[2] <= picker.vw && r[3] <= picker.vh;
    check("instruction chip fully on-screen", onScreen(picker.chipRect), JSON.stringify(picker));
    check("search input fully on-screen", onScreen(picker.inputRect), JSON.stringify(picker));

    // Search flow: type a city, wait for a result item, tap it -> placement
    // (its own path in selectSpawnPoint) and the SPAWN HERE button arms.
    await page.evaluate(() => {
      const i = document.getElementById("locationSearch");
      i.value = "Berlin";
      i.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const resultShown = await page.waitForFunction(() => {
      const items = document.querySelectorAll("#search-results .search-result-item:not(.search-status)");
      return items.length > 0;
    }, { timeout: 15000, polling: 300 }).then(() => true).catch(() => false);
    check("mobile search returns results (one of 3 keyless providers)", resultShown);
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
  check("spawn placed (devtest placement path — same call the tap makes)", true);
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

  // HUD anchored to the EDGES with sticks in the corners.
  const hud = await page.evaluate(() => {
    const R = (id) => { const r = document.getElementById(id).getBoundingClientRect();
      return { l: r.left, r: r.right, t: r.top, b: r.bottom, cx: r.left + r.width / 2 }; };
    const zones = {
      left: document.querySelector(".stick-zone-left").getBoundingClientRect(),
      right: document.querySelector(".stick-zone-right").getBoundingClientRect(),
      root: document.querySelector(".stick-zone-left")?.closest("#touchControls"),
    };
    return { speed: R("hud-speed-box"), alt: R("hud-alt-box"), mm: R("minimap-container"),
             boost: R("boost-container"), att: R("attitude-panel"),
             vw: innerWidth, vh: innerHeight,
             leftZone: { l: zones.left.left, t: zones.left.top, b: zones.left.bottom },
             rightZone: { r: zones.right.right, t: zones.right.top, b: zones.right.bottom } };
  });
  const onRight = (box) => Math.abs(box.r - hud.vw) <= 30;
  check("speed box on the RIGHT edge", onRight(hud.speed), `right=${hud.speed.r} vw=${hud.vw}`);
  check("altitude box on the RIGHT edge", onRight(hud.alt), `right=${hud.alt.r} vw=${hud.vw}`);
  check("boost bar bottom-CENTRE (under the plane)",
    Math.abs(hud.boost.cx - hud.vw / 2) <= 40 && Math.abs(hud.boost.b - hud.vh) <= 60,
    `cx=${hud.boost.cx} vw=${hud.vw} bottom=${hud.boost.b} vh=${hud.vh}`);
  check("right column does NOT intrude into the bottom-left joystick",
    hud.speed.l > hud.leftZone.l + 40, `speed left ${hud.speed.l} vs left-zone left ${hud.leftZone.l}`);
  check("minimap on the right (shrunk)", onRight(hud.mm) && hud.mm.r - hud.mm.l <= 120,
    `right=${hud.mm.r} width=${hud.mm.r - hud.mm.l}`);
  check("attitude/pitch panel on the right (shrunk)", onRight(hud.att) && hud.att.r - hud.att.l <= 120,
    `right=${hud.att.r} width=${hud.att.r - hud.att.l}`);

  // Double-tap the free area of the screen = boost (spacebar equivalent).
  const tap = (x, y) => page.evaluate(({ x, y }) => {
    const opts = { bubbles: true, clientX: x, clientY: y, pointerType: "touch", isPrimary: true };
    window.dispatchEvent(new PointerEvent("pointerdown", opts));
  }, { x, y });
  const cx = Math.floor(hud.vw / 2), cy = Math.floor(hud.vh * 0.75);
  await tap(cx, cy); await sleep(80); await tap(cx, cy);
  const tapDiag = await page.evaluate(() => ({
    visible: window.SKY_DEV.touchControls._visible,
    boostTap: window.SKY_DEV.controller.boostTap,
  }));
  const boosted = await page.waitForFunction(() =>
    window.SKY_DEV.physics.isBoosting || window.SKY_DEV.controller.input.boost,
    { timeout: 8000, polling: 100 }).then(() => true).catch(() => false);
  check("DOUBLE TAP fired the boost", boosted, JSON.stringify(tapDiag));

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
  check("yaw pushed HEADING right in physics", dh > 0.5 || after.state !== "FLYING",
    JSON.stringify({ before: +before.heading.toFixed(2), after: +after.heading.toFixed(2), state: after.state }));

  // Still airborne (crashing would be fine for this check, but flags routing bugs).
  check("plane in a sane state after stick input", after.state === "FLYING" || after.state === "PAUSED",
    after.state);

  await pa("left", "up"); await pa("right", "up");
  // Recentering is a per-frame lerp — clamp on value, not on elapsed ms.
  const settled = await page.waitForFunction(() => {
    const c = window.SKY_DEV.controller.input;
    return Math.abs(c.pitch) < 0.15 && Math.abs(c.roll) < 0.15 && Math.abs(c.yaw) < 0.15;
  }, { timeout: 8000, polling: 250 }).then(() => true).catch(() => false);
  const released = await page.evaluate(() => ({
    pitch: window.SKY_DEV.controller.input.pitch,
    roll: window.SKY_DEV.controller.input.roll,
    yaw: window.SKY_DEV.controller.input.yaw,
  }));
  check("release recenters axes to neutral in the live game", settled,
    JSON.stringify(released));

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
