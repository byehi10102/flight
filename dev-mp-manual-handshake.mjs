/**
 * End-to-end test of the manual (copy/paste) WebRTC handshake, driven in a
 * REAL browser: two pages, an invite code, a reply code, and a data channel.
 * This is the only way to genuinely verify WebRTC — there is no Node
 * implementation of RTCPeerConnection to unit test against.
 */
import puppeteer from "puppeteer";
import { startServer } from "./dev-mp-manual-server.mjs";

const PORT = 4123;
const URL = `http://localhost:${PORT}/`;

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? "  — " + detail : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await startServer(PORT);
const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

console.log("\n=== manual WebRTC handshake test (real browser) ===\n");

try {
  const host = await browser.newPage();
  const joiner = await browser.newPage();
  const errors = [];
  for (const [name, page] of [["host", host], ["joiner", joiner]]) {
    page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
    page.on("console", (m) => {
      // "Failed to load resource" is the browser probing /favicon.ico;
      // its URL is not in the message text, so filter by shape instead.
      const t = m.text();
      if (m.type() === "error" && !/Failed to load resource/i.test(t)) {
        errors.push(`${name} console: ${t}`);
      }
    });
    await page.goto(URL, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => window.api !== undefined);
  }

  // 1. Host makes an invite.
  const invite = await host.evaluate(() => window.api.host("HOST-1"));
  check("host produced an invite code", typeof invite === "string" && invite.length > 100,
    `length ${invite && invite.length}`);
  check("invite has the expected prefix", invite.startsWith("SKW1:"));
  check("invite contains no raw newlines (safe to paste anywhere)", !/[\r\n]/.test(invite));

  // 2. Joiner consumes it and produces a reply.
  const reply = await joiner.evaluate((c) => window.api.reply(c, "JOINER-1"), invite);
  check("joiner produced a reply code", typeof reply === "string" && reply.length > 100,
    `length ${reply && reply.length}`);

  // 3. Host consumes the reply.
  await host.evaluate((r) => window.api.finish(r), reply);

  // 4. Both sides reach "online" (the data channel is open).
  let hostState = null;
  let joinerState = null;
  for (let i = 0; i < 60; i++) {
    hostState = await host.evaluate(() => window.api.status());
    joinerState = await joiner.evaluate(() => window.api.status());
    if (hostState.status === "online" && joinerState.status === "online") break;
    await sleep(250);
  }
  check("host reports online", hostState.status === "online", `${hostState.status} ${hostState.error || ""}`);
  check("joiner reports online", joinerState.status === "online", `${joinerState.status} ${joinerState.error || ""}`);
  check("host sees exactly one peer", hostState.peers === 1, `peers=${hostState.peers}`);
  check("joiner sees exactly one peer", joinerState.peers === 1, `peers=${joinerState.peers}`);

  // 5. Callsigns crossed over.
  const joinerSawHello = joinerState.events.some((e) => e.e === "hello" && e.c === "HOST-1");
  const hostSawHello = hostState.events.some((e) => e.e === "hello" && e.c === "JOINER-1");
  check("joiner learned the host's callsign", joinerSawHello,
    "events: " + JSON.stringify(joinerState.events) + " raw: " + JSON.stringify(joinerState.raw.slice(0, 4)));
  check("host learned the joiner's callsign", hostSawHello, JSON.stringify(hostState.events));

  // 6. Telemetry host → joiner.
  await host.evaluate(() => window.api.sendState({
    lon: -117.9143, lat: 33.8366, alt: 2500, heading: 91.5, pitch: -4.2, roll: 12.5,
    speed: 777, isFlying: true,
  }));
  // 7. And joiner → host (both directions must work).
  await joiner.evaluate(() => window.api.sendState({
    lon: 2.2945, lat: 48.8584, alt: 800, heading: 270, pitch: 3, roll: -8, speed: 500, isFlying: true,
  }));
  await sleep(800);

  joinerState = await joiner.evaluate(() => window.api.status());
  hostState = await host.evaluate(() => window.api.status());

  const hostMsg = joinerState.received.find((m) => m.e === "state");
  const joinerMsg = hostState.received.find((m) => m.e === "state");
  check("joiner received the host's telemetry", !!hostMsg, JSON.stringify(joinerState.received));
  check("telemetry values survive the link",
    hostMsg && hostMsg.d.lon === -117.9143 && hostMsg.d.h === 91.5 && hostMsg.d.v === 777,
    hostMsg ? JSON.stringify(hostMsg.d) : "none");
  check("host received the joiner's telemetry", !!joinerMsg, JSON.stringify(hostState.received));

  // 8. Spawn presence (used by the shared spawn gate).
  await joiner.evaluate(() => window.api.sendSpawn({ placed: 1, lon: 2.2945, lat: 48.8584, camLon: 2.29, camLat: 48.85 }));
  await sleep(500);
  hostState = await host.evaluate(() => window.api.status());
  const spawnMsg = hostState.received.find((m) => m.e === "spawn");
  check("spawn presence crosses the link", !!spawnMsg && spawnMsg.d.placed === 1,
    JSON.stringify(hostState.received));

  // 9. "Go back to picking" signal.
  await host.evaluate(() => window.api.sendBack());
  await sleep(500);
  joinerState = await joiner.evaluate(() => window.api.status());
  check("back-to-picking signal crosses the link", joinerState.received.some((m) => m.e === "back"),
    "raw on joiner: " + JSON.stringify(joinerState.raw));

  // 10. Closing the host must tell the joiner.
  const beforeLeave = joinerState.events.filter((e) => e.e === "leave").length;
  await host.close();
  await sleep(800);
  joinerState = await joiner.evaluate(() => window.api.status());
  const afterLeave = joinerState.events.filter((e) => e.e === "leave").length;
  check("joiner is told when the host goes away", afterLeave > beforeLeave,
    `leave events: ${beforeLeave} → ${afterLeave}`);

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (err) {
  fail++;
  console.log("  FAIL  test threw: " + err.message);
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
