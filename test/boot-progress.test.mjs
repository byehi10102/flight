import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBootProgress, DEFAULT_BOOT_WEIGHTS } from "../src/core/bootProgress.js";

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
