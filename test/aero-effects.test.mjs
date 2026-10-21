import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AERO,
  clamp01,
  expLerp,
  speedFactor,
  speedVisibility,
  condensationTarget,
  vortexTarget,
  condensationSampleCounts,
  condensationGrid,
  trailPointCapacity,
  trailSpawnSteps,
  trailSpacing,
  trailKeepDistance,
} from "../src/plane/aeroMath.js";

// ── Gating: vapor needs SPEED and a PULL-UP ─────────────────────────────────
// Values mirror the shipped flight.tarmizi.id bundle, so drift here is a
// behaviour regression against the reference effect.

const MAX = 10000;
const MIN = 500;

test("vapor stays off in level flight no matter the speed", () => {
  for (const speed of [MIN, 3000, MAX]) {
    const f = speedFactor(speed, MIN, MAX);
    assert.equal(condensationTarget(f, 0), 0);
  }
});

test("at min speed a hard pull only gets the 0.18 speed floor", () => {
  // speedVisibility has a floor of 0.18 (the reference wants a hint of vapor
  // even in slow flight), so this is small but not zero.
  const slow = condensationTarget(0, 1);
  assert.ok(Math.abs(slow - 0.18) < 1e-9);
  assert.ok(slow < condensationTarget(1, 1));
});

test("vapor ramps in with pitch past the 10 deg threshold", () => {
  const f = speedFactor(8000, MIN, MAX);
  const below = condensationTarget(f, AERO.PITCH_MIN * 0.9);
  const at = condensationTarget(f, AERO.PITCH_MIN + 0.05);
  const high = condensationTarget(f, 1);
  assert.equal(below, 0);
  assert.ok(at > 0 && at < high);
  // Saturates at 1 rad (~57 deg), scaled by the speed-visibility factor.
  assert.equal(high, speedVisibility(f));
});

test("full-speed vertical pull saturates the vapor", () => {
  assert.equal(condensationTarget(1, 2), 1);
});

test("vortices trigger on roll OR pitch, whichever is greater", () => {
  const f = 1;
  assert.equal(vortexTarget(f, 0.1, 0.1), 0);
  const rollLed = vortexTarget(f, 0.8, 0.1);
  const pitchLed = vortexTarget(f, 0.1, 0.8);
  assert.equal(rollLed, pitchLed);
  assert.ok(rollLed > 0);
  // Negative roll is the same as positive roll (magnitude only).
  assert.equal(vortexTarget(f, -0.8, 0), vortexTarget(f, 0.8, 0));
});

// ── Smoothing: frame-rate independent approach ──────────────────────────────

test("expLerp approaches the target and never overshoots", () => {
  let v = 0;
  for (let i = 0; i < 200; i++) v = expLerp(v, 1, 1 / 60, AERO.CONDENSATION_RATE);
  assert.ok(v > 0.99 && v <= 1);
});

test("expLerp at half the dt gives the same result after twice the steps", () => {
  let a = 0;
  let b = 0;
  for (let i = 0; i < 60; i++) a = expLerp(a, 1, 1 / 60, 8);
  for (let i = 0; i < 120; i++) b = expLerp(b, 1, 1 / 120, 8);
  assert.ok(Math.abs(a - b) < 1e-6);
});

test("clamp01 and speedFactor behave at the envelope edges", () => {
  assert.equal(clamp01(-3), 0);
  assert.equal(clamp01(3), 1);
  assert.equal(speedFactor(MIN, MIN, MAX), 0);
  assert.equal(speedFactor(MAX, MIN, MAX), 1);
  assert.equal(speedFactor(MAX * 4, MIN, MAX), 1);
  // A degenerate envelope can never divide by zero.
  assert.equal(speedFactor(10, 10, 10), 0);
});

// ── Geometry budgets ────────────────────────────────────────────────────────

test("cloud sample counts match the reference's flat/curved pair", () => {
  const { flat, curved } = condensationSampleCounts();
  assert.equal(flat, 114); // max(80, 60 * 1.9)
  assert.equal(curved, 132); // max(96, 60 * 2.2)
});

test("each cloud's lattice covers every particle exactly", () => {
  for (const count of Object.values(condensationSampleCounts())) {
    const { spanSamples, chordSamples } = condensationGrid(count);
    assert.ok(spanSamples * chordSamples >= count);
    assert.ok(spanSamples >= 8 && chordSamples >= 8);
  }
});

test("trail capacity grows with smoothing steps, with a floor of one per side", () => {
  assert.equal(trailPointCapacity(0, 0), 2);
  assert.equal(trailPointCapacity(1, 1), 2);
  // n samples with n-1 gaps, each gap filled with TRAIL_SMOOTH_STEPS points.
  assert.equal(trailPointCapacity(3, 1), 3 + 1 + 2 * AERO.TRAIL_SMOOTH_STEPS);
  assert.ok(trailPointCapacity(2000, 2000) < 20000);
});

test("trail spawn walks the gap in whole samples and stops at the frame cap", () => {
  assert.equal(trailSpawnSteps(0.4), 0); // too short to sample
  assert.equal(trailSpawnSteps(3), 3);
  assert.equal(trailSpawnSteps(1e9), AERO.TRAIL_MAX_SPAWN_PER_FRAME);
  assert.equal(trailSpawnSteps(NaN), 0);
});

// ── Ribbon sampling window ──────────────────────────────────────────────────
// The reference spaces samples 1 unit apart with the jet 25 units in front of
// the camera; both numbers have to travel with the camera-to-jet distance or
// the ribbon is either coarse or tens of thousands of invisible points.

test("spacing matches the reference at the reference distance", () => {
  assert.equal(trailSpacing(25), AERO.TRAIL_MIN_DISTANCE);
});

test("spacing tightens with this game's much closer camera", () => {
  const close = trailSpacing(2.5); // in-flight camera-to-wingtip distance
  assert.ok(close < 0.2 && close > 0.02);
  // A whole frame's travel then still fits inside the per-frame sample cap.
  const travel = 5600 / 60;
  assert.ok(travel / close > AERO.TRAIL_MAX_SPAWN_PER_FRAME);
});

test("spacing never degenerates on bad input", () => {
  assert.equal(trailSpacing(0), AERO.TRAIL_MIN_DISTANCE);
  assert.equal(trailSpacing(-5), AERO.TRAIL_MIN_DISTANCE);
  assert.equal(trailSpacing(NaN), AERO.TRAIL_MIN_DISTANCE);
  assert.equal(trailSpacing(1e-6), 0.02);
});

test("kept window is a little longer than the visible ribbon", () => {
  assert.ok(trailKeepDistance(2.5) > 2.5);
  assert.ok(trailKeepDistance(2.5) < 5);
  assert.equal(trailKeepDistance(0), 3);
  assert.equal(trailKeepDistance(NaN), 3);
});
