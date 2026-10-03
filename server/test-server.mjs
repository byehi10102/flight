/**
 * Headless verification for the multiplayer server.
 *
 * Exercises the real Socket.IO path end to end:
 *   1. create a lobby → 5-character code
 *   2. a second client joins by that code → same room, not a second lobby
 *   3. telemetry flows A → B with values intact
 *   4. a third client joining late receives the EXISTING players + state
 *   5. a disconnect produces player-left
 *   6. the room code is deleted once the room empties
 *   7. bad codes are rejected
 *
 * Run:  npm test        (from this folder)
 */
import { io as ioClient } from "socket.io-client";
import { server, rooms } from "./server.js";

const PORT = 3999;
const URL = `http://localhost:${PORT}`;

// server.js is side-effect free on import, so the test owns the lifecycle.
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(PORT, resolve);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = () =>
  new Promise((resolve, reject) => {
    const s = ioClient(URL, { transports: ["websocket"] });
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
  });

const ack = (socket, event, payload) =>
  new Promise((resolve) => socket.emit(event, payload, resolve));

let pass = 0;
let fail = 0;
function check(label, condition, detail = "") {
  if (condition) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? "  — " + detail : ""}`);
  }
}

function telemetryFor(n) {
  return {
    x: -2.4e6 + n,
    y: -4.6e6 + n,
    z: 3.5e6 + n,
    heading: 1.23,
    pitch: -0.05,
    roll: 0.4,
  };
}

console.log("\n=== Skyward multiplayer server test ===\n");

// 1. Create a lobby
const A = await connect();
const created = await ack(A, "create-lobby", { callsign: "ACE-1" });
check("create-lobby returns ok", created?.ok === true);
check("room code is 5 chars", /^[A-Z2-9]{5}$/.test(created?.code || ""), `got "${created?.code}"`);
check("server registered the room", rooms.has(created.code));
const code = created.code;

// 2. Second client joins the SAME code
const B = await connect();
const joined = await ack(B, "join-lobby", { code, callsign: "ACE-2" });
check("join-lobby returns ok", joined?.ok === true);
check("joiner is in the same room code", joined?.code === code);
check("no second room was created for the same code", rooms.get(code).players.size === 2);
check("joiner sees the existing player in the roster", joined?.players?.length === 1);

// Joining a bad code must fail rather than silently making a lobby.
const badJoin = await ack(B, "join-lobby", { code: "ZZZZZ", callsign: "X" });
check("unknown code is rejected", badJoin?.ok === false, JSON.stringify(badJoin));

// 3. Telemetry A → B
const moved = new Promise((resolve) => B.once("player-moved", resolve));
A.emit("player-moved", telemetryFor(1));
const recv = await Promise.race([moved, sleep(1500).then(() => null)]);
check("B received A's telemetry", !!recv);
check("telemetry values survive the relay",
  recv && recv.x === telemetryFor(1).x && recv.heading === 1.23,
  recv ? `x=${recv.x} heading=${recv.heading}` : "nothing received");
check("telemetry is tagged with the sender id", recv?.id === A.id);

// The sender must not receive its own telemetry back.
let echoed = false;
A.once("player-moved", () => { echoed = true; });
A.emit("player-moved", telemetryFor(2));
await sleep(400);
check("sender does not receive its own telemetry", echoed === false);

// 4. Late joiner gets existing players AND their last state
const C = await connect();
const late = await ack(C, "join-lobby", { code, callsign: "ACE-3" });
check("late joiner sees both existing players", late?.players?.length === 2);
const withState = (late?.players || []).find((p) => p.id === A.id);
check("late joiner receives the last known position", typeof withState?.state?.x === "number");

// 5. Disconnect → player-left
const leftEvent = new Promise((resolve) => A.once("player-left", resolve));
B.disconnect();
const left = await Promise.race([leftEvent, sleep(1500).then(() => null)]);
check("other players are told when someone disconnects", !!left);
check("room shrank after the disconnect", rooms.get(code)?.players.size === 2);

// 6. Emptied room code is deleted
const emptyEvent = new Promise((resolve) => C.once("player-left", resolve));
A.disconnect();
await Promise.race([emptyEvent, sleep(1500)]);
C.emit("leave-lobby");
await sleep(300);
check("empty room code is removed automatically", !rooms.has(code), `still present: ${rooms.has(code)}`);

C.disconnect();
await sleep(200);

console.log(`\n${pass} passed, ${fail} failed\n`);
server.close();
process.exit(fail === 0 ? 0 : 1);
