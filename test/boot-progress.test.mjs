import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBootProgress, DEFAULT_BOOT_WEIGHTS, MonotonicPercent, PercentRamp } from "../src/core/bootProgress.js";

test("all flags done and no sub-progress reports 100", () => {
  const flags = { cesium: true, model: true, audio: true, globe: true, terrain: true, area: true };
  assert.equal(computeBootProgress(flags), 100);
});

test("no flags and no sub-progress reports 0", () => {
  const flags = { cesium: false, model: false, audio: false, globe: false, terrain: false, area: false };
  assert.equal(computeBootProgress(flags), 0);
});

test("a completed stage releases its full weight", () => {
  const flags = { model: true };
  assert.equal(computeBootProgress(flags), DEFAULT_BOOT_WEIGHTS.model);
});

test("partial sub-progress adds a proportional slice of the stage weight", () => {
  const flags = {};
  const pct = computeBootProgress(flags, { model: 0.5 });
  assert.equal(pct, DEFAULT_BOOT_WEIGHTS.model * 0.5);
});

test("a done flag ignores its sub-progress (no double counting)", () => {
  const flags = { model: true };
  assert.equal(computeBootProgress(flags, { model: 0.7 }), DEFAULT_BOOT_WEIGHTS.model);
});

test("sub-progress is clamped to [0,1]", () => {
  assert.equal(computeBootProgress({}, { model: 2 }), DEFAULT_BOOT_WEIGHTS.model);
  assert.equal(computeBootProgress({}, { model: -1 }), 0);
});

test("stages sum to 100 by default", () => {
  const sum = Object.values(DEFAULT_BOOT_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(sum, 100);
});

test("raw queue-ratio progress retreats when the tile queue spikes (the bug)", () => {
  // The tile queue is not monotonic: it drains (30 -> 5), then LOD refinement
  // re-requests tiles and spikes again (5 -> 18). The raw ratio retreats, so an
  // unclamped bar visibly goes BACKWARDS — this documents the regression the
  // monotonic clamp exists to fix.
  const flags = { cesium: true, model: true, audio: true, terrain: true };
  const pctAtQueue5 = computeBootProgress(flags, { globe: 1 - 5 / 30 });
  const pctAtQueue18 = computeBootProgress(flags, { globe: 1 - 18 / 30 });
  assert.ok(
    pctAtQueue18 < pctAtQueue5,
    `expected the raw bar to retreat on a queue spike, got ${pctAtQueue18} vs ${pctAtQueue5}`,
  );
});

test("MonotonicPercent never returns less than a previous value", () => {
  const bar = new MonotonicPercent();
  assert.equal(bar.update(10), 10);
  assert.equal(bar.update(40), 40);
  assert.equal(bar.update(25), 40); // retreat clamped to the high-water mark
  assert.equal(bar.update(60), 60);
  assert.equal(bar.update(55), 60);
});

test("MonotonicPercent starts at zero and treats non-finite input as no-progress", () => {
  const bar = new MonotonicPercent();
  assert.equal(bar.update(0), 0);
  assert.equal(bar.update(NaN), 0);
  bar.update(30);
  assert.equal(bar.update(undefined), 30);
  assert.equal(bar.update(-5), 30);
});

test("MonotonicPercent resets for a new phase", () => {
  const bar = new MonotonicPercent();
  bar.update(90);
  bar.reset();
  assert.equal(bar.update(5), 5); // a fresh phase may legitimately start lower
});

test("clamped boot progress stays non-decreasing across a spiky tile queue", () => {
  const bar = new MonotonicPercent();
  const flags = { cesium: true, model: true, audio: true, terrain: true };
  const queueOverTime = [30, 5, 18, 2, 9, 0];
  const shown = queueOverTime.map((q) =>
    bar.update(computeBootProgress(flags, { globe: 1 - q / 30 })),
  );
  for (let i = 1; i < shown.length; i++) {
    assert.ok(shown[i] >= shown[i - 1], `bar retreated: ${shown.join(", ")}`);
  }
  // A drained queue releases the stage's full slice, flag or not.
  assert.equal(shown[shown.length - 1], computeBootProgress({ ...flags, globe: true }));
});

// ── Display ramp ────────────────────────────────────────────────────────────
// The complaint this exists for: a bar wired straight to the stage flags jumps
// 60 -> 80 -> 81 with dead stops in between. The ramp spreads each release out
// and keeps a slow stage visibly moving, without ever claiming work that has
// not happened.

test("the ramp starts where it is put and never passes its target", () => {
  const ramp = new PercentRamp();
  assert.equal(ramp.update(55, 0), 0);
  let v = 0;
  for (let t = 0; t <= 5000; t += 100) v = ramp.update(55, t);
  assert.ok(v <= 55 + 1e-9, `ramp overshot its target: ${v}`);
  assert.ok(v > 54.9, `ramp never arrived at its target: ${v}`);
});

test("a stage flag's jump is spread over several ticks, not one", () => {
  const ramp = new PercentRamp();
  ramp.update(100, 0);           // target known immediately
  const afterOneTick = ramp.update(100, 100);
  assert.ok(afterOneTick > 0 && afterOneTick < 100,
    `expected a partial step, got ${afterOneTick}`);
  // The ceiling holds the climb to 20%/s, so a full-width jump takes ~5 s...
  assert.ok(afterOneTick <= 2.0000001, `a 100 ms tick moved ${afterOneTick}`);
  // ...but it is a real climb, not a crawl: past half within 3 s.
  let v = afterOneTick;
  for (let t = 200; t <= 3000; t += 100) v = ramp.update(100, t);
  assert.ok(v > 50, `expected >50% within 3 s, got ${v}`);
});

test("the burst of early stages cannot sprint the bar and strand it", () => {
  // The reported shape: Cesium + model + audio finish inside a second, so the
  // raw target is already 55 while the display is near 0. The display must
  // walk, not teleport — 55 points must take at least ~2.7 s at 20%/s.
  const ramp = new PercentRamp();
  ramp.update(55, 0);
  let at1s = 0;
  for (let t = 100; t <= 1000; t += 100) at1s = ramp.update(55, t);
  assert.ok(at1s < 30, `one second in, the bar should still be under 30, got ${at1s}`);
  let at3s = at1s;
  for (let t = 1100; t <= 3000; t += 100) at3s = ramp.update(55, t);
  assert.ok(at3s > 50, `expected the bar to have arrived by 3 s, got ${at3s}`);
});

test("the ramp never retreats when the target does", () => {
  const ramp = new PercentRamp();
  for (let t = 0; t <= 5000; t += 100) ramp.update(40, t);
  const before = ramp.value;
  const after = ramp.update(12, 5100); // tile queue spiked -> raw target fell
  assert.equal(after, before);
});

test("the ramp keeps a dead-still target visibly moving (floor creep)", () => {
  const ramp = new PercentRamp();
  ramp.update(30, 0);
  for (let t = 0; t <= 2000; t += 100) ramp.update(30, t);
  const settled = ramp.value;
  assert.ok(settled > 29, `expected the ramp to reach its target, got ${settled}`);
  // Target frozen at 30 (a stage reports nothing for 2 s) — 60 stays ahead, so
  // the display is already there; the creep matters when the target sits
  // slightly ahead of the display.
  const ramp2 = new PercentRamp();
  ramp2.value = 20;
  ramp2.update(30, 0);
  const a = ramp2.update(30, 100);
  const b = ramp2.update(30, 200);
  assert.ok(b > a && a > 20, `expected the display to keep walking, got ${a} -> ${b}`);
});

test("a backgrounded tab cannot teleport the ramp", () => {
  const ramp = new PercentRamp();
  ramp.update(100, 0);
  const value = ramp.update(100, 60000); // one giant gap
  assert.ok(value <= 100);
  // dt is clamped to 1 s, so the step is the same as a normal 1 s window.
  const reference = new PercentRamp();
  reference.update(100, 0);
  const stepped = reference.update(100, 1000);
  assert.ok(Math.abs(value - stepped) < 1e-9, `${value} should equal ${stepped}`);
});

test("the ramp resumes on a fresh phase after reset", () => {
  const ramp = new PercentRamp();
  for (let t = 0; t <= 3000; t += 100) ramp.update(90, t);
  assert.ok(ramp.value > 0);
  assert.equal(ramp.reset(0), 0);
  assert.equal(ramp.update(90, 4000), 0); // first tick only re-anchors the clock
  assert.ok(ramp.update(90, 4100) > 0);
});

test("the ramp ignores non-finite targets", () => {
  const ramp = new PercentRamp();
  ramp.update(50, 0);
  assert.equal(ramp.update(NaN, 100), 0);
  assert.equal(ramp.update(undefined, 200), 0);
});;
