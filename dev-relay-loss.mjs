/**
 * RELAY LOSS TEST: two raw ws clients in one room; A floods st frames at
 * 10 Hz for 20 s; count what B receives. No browsers involved.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { WebSocket } = require("./server/node_modules/ws/index.js");
import { spawn } from "node:child_process";
import { once } from "node:events";

const relay = spawn("node", ["server.js"], { cwd: "server", stdio: "pipe" });
await new Promise((r) => setTimeout(r, 1500));

const CODE = "LST2";
let relayLog = "";
relay.stdout.on("data", (d) => { relayLog += d; });
relay.stderr.on("data", (d) => { relayLog += d; });

const wsA = new WebSocket(`ws://127.0.0.1:3000/ws?code=${CODE}&name=A&host=1`);
const aMsgs = [];
wsA.on("message", (raw) => aMsgs.push(JSON.parse(String(raw)).t));
await once(wsA, "open");
const wsB = new WebSocket(`ws://127.0.0.1:3000/ws?code=${CODE}&name=B`);
let sent = 0, recv = 0;
wsB.on("message", (raw) => {
  const f = JSON.parse(String(raw));
  if (f.t === "st") recv++;
});
wsB.on("close", (code, reason) => { relayLog += `\n[B closed: ${code} ${reason}]`; });
wsB.on("error", (e) => { relayLog += `\n[B error: ${e.message}]`; });
await once(wsB, "open");
await new Promise((r) => setTimeout(r, 800)); // welcome + join frames land

const t0 = Date.now();
const timer = setInterval(() => {
  sent++;
  wsA.send(JSON.stringify({ t: "st", d: { ts: performance.now(), lon: -98.5 + sent * 1e-5, lat: 38.5, alt: 1000, h: 90, p: 0, r: 0, v: 250, fly: 1 } }));
}, 100);

await new Promise((r) => setTimeout(r, 20000));
clearInterval(timer);
wsA.close(); wsB.close();
relay.kill();
await new Promise((r) => setTimeout(r, 300));
console.log(JSON.stringify({ sent, recv, lossPct: +(((sent - recv) / sent) * 100).toFixed(1), aMsgs: aMsgs.slice(0, 6), relayLog: relayLog.trim().split("\n") }));
