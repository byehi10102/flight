import { test } from "node:test";
import assert from "node:assert/strict";
import { preparingFlightProgress } from "../src/core/bootProgress.js";

test("real in-flight work shows through the envelope", () => {
  assert.equal(preparingFlightProgress(0.4, 1000, 3000, 12000), 0.4);
  assert.equal(preparingFlightProgress(0.75, 2500, 3000, 12000), 0.75);
});

test("work finishing early holds at 95% through the minimum window", () => {
  assert.equal(preparingFlightProgress(1, 1000, 3000, 12000), 0.95);
  assert.equal(preparingFlightProgress(1, 2900, 3000, 12000), 0.95);
});

test("work finishing early completes exactly when the minimum window ends", () => {
  assert.equal(preparingFlightProgress(1, 3000, 3000, 12000), 1);
  assert.equal(preparingFlightProgress(1, 4500, 3000, 12000), 1);
});

test("the hard cap always finishes the phase — never traps the player", () => {
  assert.equal(preparingFlightProgress(0.2, 12000, 3000, 12000), 1);
  assert.equal(preparingFlightProgress(0.05, 20000, 3000, 12000), 1);
});

test("the queue ratio is clamped to [0,1] before use", () => {
  assert.equal(preparingFlightProgress(-0.5, 100, 3000, 12000), 0);
  assert.equal(preparingFlightProgress(2, 100, 3000, 12000), 0.95); // clamps to 1, held below min window
});

test("garbage inputs degrade to the cap/hold paths, never NaN", () => {
  const p = preparingFlightProgress(NaN, NaN, 3000, 12000);
  assert.ok(Number.isFinite(p));
  assert.equal(preparingFlightProgress(undefined, 999999, 3000, 12000), 1);
});

test("monotonic across the phase for a realistic queue drain", () => {
  // queue decays: ratio 0.1 -> 0.55 -> 1.0 while time passes the min window.
  const a = preparingFlightProgress(0.1, 500, 3000, 12000);
  const b = preparingFlightProgress(0.55, 2000, 3000, 12000);
  const c = preparingFlightProgress(1.0, 3500, 3000, 12000);
  assert.ok(a < b && b < c);
});
