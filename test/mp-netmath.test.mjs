import { test } from "node:test";
import assert from "node:assert/strict";
import {
  wrapDeg,
  drStep,
  estimateRates,
  divergence,
  convergeStep,
  adaptiveDelay,
  posDistanceM,
  shouldTransmitState,
} from "../multiplayer/netmath.js";

test("wrapDeg wraps into (-180, 180]", () => {
  assert.equal(wrapDeg(190), -170);
  assert.equal(wrapDeg(-190), 170);
  assert.equal(wrapDeg(360), 0);
  assert.equal(wrapDeg(15), 15);
});

test("drStep advances position along heading at speed (straight flight)", () => {
  const snap = { t: 0, lon: 0, lat: 0, alt: 1000, h: 0, p: 0, r: 0, v: 500, fly: 1 };
  const rates = { hr: 0, pr: 0, rr: 0, vr: 0 };
  const out = drStep(snap, rates, 1000, 1.8); // 1 s ahead
  // 500 mph * 0.44704 * 1.8 m/s due north for 1 s
  const meters = 500 * 0.44704 * 1.8;
  assert.ok(out.lat > 0, "moved north");
  assert.ok(Math.abs(out.lat * 111320 - meters) < 5, `lat meters ${out.lat * 111320} ~ ${meters}`);
  assert.equal(out.lon, 0);
  assert.equal(out.alt, 1000);
  assert.equal(out.t, 1000);
});

test("drStep rotates heading by the rate during a coast (turn-aware)", () => {
  const snap = { t: 0, lon: 0, lat: 0, alt: 1000, h: 0, p: 0, r: 30, v: 500, fly: 1 };
  const rates = { hr: 0.01, pr: 0, rr: 0, vr: 0 }; // 10 deg/s
  const out = drStep(snap, rates, 1000, 1.8);
  assert.ok(Math.abs(out.h - 10) < 0.001, `heading advanced to ${out.h}`);
  assert.equal(out.r, 30);
  assert.ok(out.lon > 0, "turning right (east) moved longitude");
});

test("drStep extrapolates roll and speed rates (full-airframe dead reckoning)", () => {
  const snap = { t: 0, lon: 0, lat: 0, alt: 1000, h: 0, p: 0, r: 0, v: 400, fly: 1 };
  const rates = { hr: 0, pr: 0, rr: 0.02, vr: 0.1 }; // 20 deg/s roll, 100 mph/s
  const out = drStep(snap, rates, 500, 1.8);
  assert.equal(out.r, 10);
  assert.equal(out.v, 450);
});

test("drStep respects fly=0 (parked peers do not coast)", () => {
  const snap = { t: 0, lon: 5, lat: 5, alt: 10, h: 0, p: 0, r: 0, v: 500, fly: 0 };
  const out = drStep(snap, { hr: 0, pr: 0, rr: 0, vr: 0 }, 1000, 1.8);
  assert.equal(out.lon, 5);
  assert.equal(out.lat, 5);
});

test("estimateRates derives per-ms rates from two snapshots", () => {
  const a = { t: 0, h: 10, p: 0, r: 0, v: 400 };
  const b = { t: 100, h: 20, p: 2, r: 5, v: 450 };
  const rates = estimateRates(a, b);
  assert.ok(Math.abs(rates.hr - 0.1) < 1e-9); // 10 deg / 100 ms
  assert.ok(Math.abs(rates.pr - 0.02) < 1e-9);
  assert.ok(Math.abs(rates.rr - 0.05) < 1e-9);
  assert.ok(Math.abs(rates.vr - 0.5) < 1e-9); // 50 mph / 100 ms
});

test("estimateRates wraps the shortest way across north", () => {
  const a = { t: 0, h: 350, p: 0, r: 0, v: 400 };
  const b = { t: 1000, h: 10, p: 0, r: 0, v: 400 };
  const rates = estimateRates(a, b);
  assert.ok(Math.abs(rates.hr - 0.02) < 1e-9, `rate ${rates.hr}`); // +20deg shortest way
});

test("divergence measures position metres and heading degrees", () => {
  const truth = { lon: 0, lat: 0, alt: 1000, h: 10 };
  const predicted = { lon: 0.001, lat: 0, alt: 1000, h: 10 }; // ~111 m east
  const d = divergence(truth, predicted);
  assert.ok(Math.abs(d.m - 111) < 15, `m ${d.m}`);
  assert.equal(d.hDeg, 0);
  const d2 = divergence({ lon: 0, lat: 0, alt: 0, h: 0 }, { lon: 0, lat: 0, alt: 0, h: 4 });
  assert.equal(d2.m, 0);
  assert.equal(d2.hDeg, 4);
});

test("convergeStep: small errors apply instantly (no added latency)", () => {
  const shown = { lon: 0, lat: 0, alt: 100, h: 10, p: 0, r: 0, v: 400 };
  const target = { lon: 0.00001, lat: 0, alt: 100.5, h: 10.1, p: 0, r: 0, v: 400 };
  const out = convergeStep(shown, target, 16, { epsM: 30, ratePerS: 6 });
  assert.equal(out, target); // identical reference — no smoothing engaged
});

test("convergeStep: a post-stall jump converges smoothly, never snaps", () => {
  const shown = { lon: 0, lat: 0, alt: 100, h: 0, p: 0, r: 0, v: 400 };
  const target = { lon: 0.005, lat: 0, alt: 100, h: 45, p: 0, r: 0, v: 400 }; // ~555 m away
  const half = convergeStep(shown, target, 100, { epsM: 30, ratePerS: 6 });
  const moved = posDistanceM(shown, half);
  assert.ok(moved > 1 && moved < posDistanceM(shown, target),
    `moved ${moved}m of ${posDistanceM(shown, target)}`);
  assert.ok(Math.abs(half.h - 0) > 0 && Math.abs(half.h - 45) < 45, "heading also blends");
});

test("adaptiveDelay sizes the buffer from interval and jitter, clamped", () => {
  assert.equal(adaptiveDelay(33, 0), 66); // 2x send interval floor
  assert.equal(adaptiveDelay(33, 20), 86);
  assert.equal(adaptiveDelay(150, 300), 250); // clamped high
  assert.equal(adaptiveDelay(33, 0), 66);
});

// ── shouldTransmitState: the DIS sender rule both transports share ──────────

const FLY = (lon = 0) => ({ lon, lat: 0, alt: 1000, h: 0, p: 0, r: 0, v: 250, fly: 1 });

test("shouldTransmitState: first packet always transmits", () => {
  assert.equal(shouldTransmitState([], FLY(), 1000), true);
});

test("shouldTransmitState: steady flight inside the heartbeat window skips", () => {
  // The packet shape matches the real wire payload (net.js broadcastState).
  const sent = [{ ts: 0, lon: 0, lat: 0, alt: 1000, h: 0, p: 0, r: 0, v: 250, fly: 1 }];
  // The TRUE state 100 ms into the cruise: the jet has flown north at
  // 250 mph * 1.8 arcade = ~201 m/s, exactly what the receiver's dead
  // reckoning predicts — so nothing needs to be sent.
  const meters = 250 * 0.44704 * 1.8 * 0.1;
  const truth = { ...FLY(), lat: meters / 111320 };
  assert.equal(shouldTransmitState(sent, truth, 100), false);
});

test("shouldTransmitState: the heartbeat floor forces a send", () => {
  const sent = [{ ts: 0, lon: 0, lat: 0, alt: 1000, h: 0, p: 0, r: 0, v: 250, fly: 1 }];
  assert.equal(shouldTransmitState(sent, FLY(0), 1000), true);
});

test("shouldTransmitState: maneuvering past the threshold transmits early", () => {
  const sent = [
    { ts: 0, lon: 0, lat: 0, alt: 1000, h: 0, p: 0, r: 0, v: 250, fly: 1 },
    { ts: 50, lon: 0.0005, lat: 0, alt: 1000, h: 0, p: 0, r: 0, v: 250, fly: 1 },
  ];
  // A hard heading change the receiver cannot predict: divergence > 3 deg.
  assert.equal(shouldTransmitState(sent, { ...FLY(), h: 20 }, 100), true);
});
