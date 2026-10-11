import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBootProgress, DEFAULT_BOOT_WEIGHTS, MonotonicPercent } from "../src/core/bootProgress.js";

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
});;
