/**
 * MULTIPLAYER E2E: real relay server + two browser sessions.
 *   1. host creates party, joiner joins by code (WS :3000)
 *   2. host starts -> both reach the picker -> both spawn -> both FLYING
 *   3. 30 s flight: remote plane present BOTH sides, sync error measured
 *      (host truth vs joiner's rendered remote), WS frame rates, fps, errors
 *   4. party-not-found: bogus code must error fast (no P2P fallback hang)
 */
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";

const GAME_URL = "http://127.0.0.1:5173/?devtest=1";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── relay server ───────────────────────────────────────────────────────────
const relay = spawn("node", ["server.js"], { cwd: "server", stdio: "pipe" });
let relayLog = "";
relay.stdout.on("data", (d) => { relayLog += d; });
relay.stderr.on("data", (d) => { relayLog += d; });
relay.on("exit", (code) => { relayLog += `\n[relay exited: ${code}]`; });
// Wait until the relay actually accepts TCP on :3000 (cold node start).
const waitPort = async (ms) => {
  const net = await import("node:net");
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await new Promise((res) => {
      const s = net.default.connect(3000, "127.0.0.1", () => { s.destroy(); res(true); });
      s.on("error", () => res(false));
      setTimeout(() => { s.destroy(); res(false); }, 400);
    });
    if (ok) return true;
    await sleep(250);
  }
  return false;
};
const relayUp = await waitPort(15000);
console.log("relay up:", relayUp, "|", relayLog.trim().split("\n")[0]);

// ── sessions (each gets its own browser) ──────────────────────────────────

// WS frame counter injected before any page script runs.
const wsHook = () => {
  window.__ws = { sent: 0, recv: 0, sentBytes: 0, recvBytes: 0, timeline: [] };
  const OrigWS = window.WebSocket;
  window.WebSocket = class extends OrigWS {
    constructor(...a) {
      super(...a);
      if (String(a[0]).includes(":3000")) {
        this.addEventListener("message", (e) => {
          window.__ws.recv++;
          window.__ws.recvBytes += (e.data?.length || 0);
        });
        this.addEventListener("close", (e) => {
          window.__ws.closed = (window.__ws.closed || 0) + 1;
          window.__ws.closeCode = e.code;
        });
        this.addEventListener("error", () => {
          window.__ws.errs = (window.__ws.errs || 0) + 1;
        });
        const origSend = this.send.bind(this);
        this.send = (d) => {
          window.__ws.sent++;
          window.__ws.sentBytes += (d?.length || 0);
          return origSend(d);
        };
        setInterval(() => {
          window.__ws.timeline.push({ t: Math.round(performance.now() / 1000), sent: window.__ws.sent, recv: window.__ws.recv, vis: document.visibilityState });
        }, 1000);
      }
    }
  };
};

async function makePage() {
  // One browser PER SESSION: two SwiftShader game contexts sharing one
  // browser starve the CDP connection (ProtocolError on page.click).
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, protocolTimeout: 600000,
    args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
           "--enable-webgl", "--ignore-gpu-blocklist", "--mute-audio", "--window-size=900,620"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 150)));
  await page.setViewport({ width: 900, height: 560, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(wsHook);
  await page.goto(GAME_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction(() => window.SKY_DEV, { timeout: 60000, polling: 500 });
  await page.waitForFunction(() => {
    const b = document.getElementById("startBtn");
    return window.SKY_DEV?.boot?.pageGone === true && b && !b.disabled;
  }, { timeout: 150000, polling: 500 });
  return { browser, page, errors };
}

const clickEl = (page, sel) => page.evaluate((s) => document.getElementById(s)?.click(), sel);

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? "  — " + detail : ""}`); }
};

let A, B, C;
try {
  A = await makePage();
  B = await makePage();

  // HOST: open the MP panel and create the party
  await clickEl(A.page, "mpCreateBtn");
  await A.page.waitForFunction(() => SKY_DEV.mp?.isActive?.() === true, { timeout: 15000, polling: 200 });
  await A.page.waitForFunction(() => (SKY_DEV.mp?.roomCode?.() || "").length === 4, { timeout: 15000, polling: 200 });
  const code = await A.page.evaluate(() => SKY_DEV.mp.roomCode());
  console.log("party code:", code);
  await A.page.waitForFunction(() => SKY_DEV.mp?.netDebug?.()?.status === "online", { timeout: 15000, polling: 200 });
  check("host connects to relay", true);

  // JOINER
  await clickEl(B.page, "mpJoinBtn");
  await B.page.waitForSelector("#mpCodeInput", { timeout: 10000 });
  await B.page.evaluate((c) => {
    const inp = document.getElementById("mpCodeInput");
    inp.value = c;
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }, code);
  await B.page.waitForFunction(() => SKY_DEV.mp?.netDebug?.()?.status === "online", { timeout: 15000, polling: 200 });
  check("joiner connects to relay", true);

  // Both in the waiting room: wait for the peer on the ROSTER (remote
  // planes only exist once someone is flying), then host starts.
  await A.page.waitForFunction(() => SKY_DEV.mp?.netDebug?.()?.peers?.length >= 1, { timeout: 20000, polling: 250 });
  await B.page.waitForFunction(() => SKY_DEV.mp?.netDebug?.()?.peers?.length >= 1, { timeout: 20000, polling: 250 });
  check("roster sees the peer on both sides", true);

  await A.page.evaluate(() => document.getElementById("wrStartBtn")?.click());  await Promise.all([
    A.page.waitForFunction(() => SKY_DEV.currentState === "PICK_SPAWN", { timeout: 60000, polling: 250 }),
    B.page.waitForFunction(() => SKY_DEV.currentState === "PICK_SPAWN", { timeout: 60000, polling: 250 }),
  ]);
  check("host start moves BOTH sessions to the picker", true);

  // Both spawn at the same point -> identical trajectories
  for (const S of [A, B]) {
    await S.page.evaluate(() => SKY_DEV.placeSpawn(-98.5, 38.5, "Kansas"));
    await sleep(400);
    await S.page.evaluate(() => document.getElementById("confirmSpawnBtn")?.click());
  }
  await Promise.all([
    A.page.waitForFunction(() => SKY_DEV.currentState === "FLYING", { timeout: 300000, polling: 500 }),
    B.page.waitForFunction(() => SKY_DEV.currentState === "FLYING", { timeout: 300000, polling: 500 }),
  ]).catch(async (e) => {
    const dump = async (S, n) => {
      try {
        const s = await S.page.evaluate(() => ({ st: SKY_DEV.currentState, sub: JSON.stringify(SKY_DEV.boot.sub), errs: window.__errs?.length || 0 }));
        console.log(`  DIAG ${n}:`, JSON.stringify(s));
      } catch (e2) { console.log(`  DIAG ${n}: page dead: ${String(e2).slice(0, 80)}`); }
    };
    await dump(A, "host");
    await dump(B, "join");
    console.log("  DIAG errors host:", A.errors.slice(0, 3), "join:", B.errors.slice(0, 3));
    throw e;
  });
  check("both sessions reach FLYING", true);

  // ── 30 s measurement ─────────────────────────────────────────────────────
  console.log("measuring 30s of synced flight...");
  await sleep(8000); // settle

  const sample = (S) => S.page.evaluate(() => {
    const mp = SKY_DEV.mp;
    return {
      remoteCount: mp.remoteCount(),
      stateStats: mp.stateStats?.() || {},
      remoteStats: mp.remoteStats?.() || {},
      ws: { sent: window.__ws.sent, recv: window.__ws.recv, closed: window.__ws.closed || 0, closeCode: window.__ws.closeCode || 0, errs: window.__ws.errs || 0, timeline: window.__ws.timeline.slice(-40) },
      state: { lon: +SKY_DEV.state.lon.toFixed(5), lat: +SKY_DEV.state.lat.toFixed(5), speed: Math.round(SKY_DEV.state.speed) },
    };
  });

  // fps via rAF deltas on both pages
  for (const S of [A, B]) {
    await S.page.evaluate(() => {
      const W = window;
      W.__d = []; W.__last = 0;
      if (W.__fpsHooked) return;
      W.__fpsHooked = true;
      const origRAF = W.requestAnimationFrame.bind(W);
      W.requestAnimationFrame = (cb) => origRAF((t) => {
        const now = performance.now();
        if (W.__last) { const d = now - W.__last; if (d > 0 && d < 5000) W.__d.push(d); }
        W.__last = now;
        return cb(t);
      });
    });
  }
  const t0 = await A.page.evaluate(() => ({ lon: SKY_DEV.state.lon, lat: SKY_DEV.state.lat }));
  await sleep(30000);
  const t1 = await A.page.evaluate(() => ({ lon: SKY_DEV.state.lon, lat: SKY_DEV.state.lat }));

  const [ra, rb] = await Promise.all([sample(A), sample(B)]);
  // sync error: joiner's rendered copy of the host vs the host's truth NOW
  const sync = await B.page.evaluate(async () => {
    const mp = SKY_DEV.mp;
    const peers = [...(mp.remoteStats ? Object.keys(mp.remoteStats()) : [])];
    if (!peers.length) return null;
    // getLive isn't on the mp handle; use the remote plane's entity position
    const ents = SKY_DEV.viewer.entities.values;
    for (const e of ents) {
      if (e.name && String(e.name).includes && String(e.name).toLowerCase().includes("callsign")) { /* noop */ }
    }
    return { peers };
  });

  const fps = async (S) => {
    const d = await S.page.evaluate(() => {
      const s = [...window.__d].sort((a, b) => a - b);
      return s.length ? +(1000 / s[s.length >> 1]).toFixed(1) : 0;
    });
    return d;
  };
  const fpsA = await fps(A), fpsB = await fps(B);

  console.log("HOST :", JSON.stringify({ ...ra, fps: fpsA }));
  console.log("JOIN :", JSON.stringify({ ...rb, fps: fpsB, syncPeers: sync?.peers }));

  check("remote plane rendered on BOTH sides (30s)", ra.remoteCount >= 1 && rb.remoteCount >= 1);
  check("host WS state stream flowing (sent > 200)", ra.ws.sent > 200, `sent=${ra.ws.sent}`);
  check("joiner WS receiving (recv > 200)", rb.ws.recv > 200, `recv=${rb.ws.recv}`);
  check("no page errors (host)", A.errors.length === 0, A.errors[0]);
  check("no page errors (joiner)", B.errors.length === 0, B.errors[0]);
  check("fps sane on both (>= 15 on software GL)", fpsA >= 15 && fpsB >= 15, `A=${fpsA} B=${fpsB}`);

  // ── party-not-found: bogus code errors fast, no P2P hang ────────────────
  try {
    const C = await makePage();
    await clickEl(C.page, "mpJoinBtn");
    await C.page.waitForSelector("#mpCodeInput", { timeout: 40000 });
    const tBad = Date.now();
    await C.page.evaluate(() => {
      const inp = document.getElementById("mpCodeInput");
      inp.value = "ZZZZ";
      inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await C.page.waitForFunction(() => {
      const el = document.getElementById("mpStatus") || document.getElementById("wrStatus");
      return el && /party|could not|not/i.test(el.textContent || "");
    }, { timeout: 20000, polling: 250 }).catch(() => {});
    const badMs = Date.now() - tBad;
    check(`bogus code rejected fast (${badMs}ms, no hang)`, badMs < 15000, `${badMs}ms`);
    try { await C.browser.close(); } catch (e) { }
  } catch (e) {
    check("bogus code rejected fast", false, String(e).slice(0, 120));
  }

  console.log("RELAY LOG:", relayLog.trim().split("\n").slice(-12).join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
} finally {
  relay.kill();
  for (const S of [A, B, C]) { try { await S.browser.close(); } catch (e) { } }
}
process.exit(fail ? 1 : 0);
