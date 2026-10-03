/**
 * Verifies the two things that make remote planes look smooth rather than
 * jittery or spinning:
 *
 *   1. frame-rate independence — the same wall-clock convergence at 60 Hz
 *      and at 144 Hz (a naive "lerp 10% per frame" fails this)
 *   2. heading takes the SHORT way round — 350° → 10° is +20°, not −340°
 *
 * Run:  node test-interpolation.mjs
 */
import * as Cesium from "cesium";
import { shortestAngle, stepToward } from "./client.js";

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? "  — " + detail : ""}`); }
};

const TAU = 0.12;
const DEG = 180 / Math.PI;

console.log("\n=== interpolation test ===\n");

// ── 1. Frame-rate independence ─────────────────────────────────────────────
function convergeSeconds(hz) {
  const dt = 1 / hz;
  const current = new Cesium.Cartesian3(0, 0, 0);
  const target = new Cesium.Cartesian3(1000, 500, -250);
  const hpr = { heading: 0, pitch: 0, roll: 0 };
  const targetHPR = { heading: 0, pitch: 0, roll: 0 };

  let t = 0;
  const start = Cesium.Cartesian3.clone(current);
  const total = Cesium.Cartesian3.distance(start, target);
  // Time until 99% of the distance is closed.
  while (t < 5) {
    stepToward(current, target, hpr, targetHPR, dt, TAU);
    t += dt;
    if (Cesium.Cartesian3.distance(current, target) < total * 0.01) break;
  }
  return t;
}

const at60 = convergeSeconds(60);
const at144 = convergeSeconds(144);
check("converges at 60 Hz", at60 < 1.5, `${at60.toFixed(3)}s`);
check("converges at 144 Hz", at144 < 1.5, `${at144.toFixed(3)}s`);
check(
  "60 Hz and 144 Hz converge over the same wall-clock time (frame-rate independent)",
  Math.abs(at60 - at144) < 0.05,
  `60Hz=${at60.toFixed(3)}s 144Hz=${at144.toFixed(3)}s`
);

// A naive fixed-fraction lerp would differ sharply; show the contrast.
function naiveConverge(hz) {
  const dt = 1 / hz;
  const current = new Cesium.Cartesian3(0, 0, 0);
  const target = new Cesium.Cartesian3(1000, 0, 0);
  const hpr = { heading: 0, pitch: 0, roll: 0 };
  const thpr = { heading: 0, pitch: 0, roll: 0 };
  let t = 0;
  while (t < 5) {
    // 10% of the remaining distance per FRAME (the classic mistake)
    Cesium.Cartesian3.lerp(current, target, 0.1, current);
    t += dt;
    if (Cesium.Cartesian3.distance(current, target) < 10) break;
  }
  return t;
}
const naive60 = naiveConverge(60);
const naive144 = naiveConverge(144);
check(
  "control: a fixed per-frame lerp is NOT frame-rate independent",
  Math.abs(naive60 - naive144) > 0.05,
  `60Hz=${naive60.toFixed(3)}s 144Hz=${naive144.toFixed(3)}s`
);

// ── 2. Heading wrap ────────────────────────────────────────────────────────
check("shortestAngle 350°→10° is +20°",
  Math.abs(shortestAngle(350 / DEG, 10 / DEG) * DEG - 20) < 0.001,
  `${(shortestAngle(350 / DEG, 10 / DEG) * DEG).toFixed(2)}°`);
check("shortestAngle 10°→350° is −20°",
  Math.abs(shortestAngle(10 / DEG, 350 / DEG) * DEG + 20) < 0.001);
check("shortestAngle 0°→180° stays ±180°",
  Math.abs(Math.abs(shortestAngle(0, Math.PI)) * DEG - 180) < 0.001);

// A full turn must never be taken the long way.
function headingAfterTurn(fromDeg, toDeg, frames = 600) {
  const current = new Cesium.Cartesian3(0, 0, 0);
  const target = new Cesium.Cartesian3(0, 0, 0);
  const hpr = { heading: fromDeg / DEG, pitch: 0, roll: 0 };
  const thpr = { heading: toDeg / DEG, pitch: 0, roll: 0 };
  let maxDelta = 0;
  let prev = hpr.heading;
  for (let i = 0; i < frames; i++) {
    stepToward(current, target, hpr, thpr, 1 / 60, TAU);
    maxDelta = Math.max(maxDelta, Math.abs(hpr.heading - prev));
    prev = hpr.heading;
  }
  return { final: hpr.heading * DEG, maxStepDeg: maxDelta * DEG };
}

/** Angles are equal if their shortest difference is ~zero (370° === 10°). */
const angleClose = (aDeg, bDeg, tol = 0.5) =>
  Math.abs(shortestAngle(aDeg / DEG, bDeg / DEG) * DEG) < tol;

const turn = headingAfterTurn(350, 10);
check("350°→10° ends at 10° (370° is the same angle)",
  angleClose(turn.final, 10), `${turn.final.toFixed(2)}°`);
check(
  "350°→10° never sweeps the long way (no step exceeds 5°/frame)",
  turn.maxStepDeg < 5,
  `max step ${turn.maxStepDeg.toFixed(2)}°`
);

const reverse = headingAfterTurn(10, 350);
check("10°→350° ends at 350° (or −10°)",
  angleClose(reverse.final, 350), `${reverse.final.toFixed(2)}°`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
