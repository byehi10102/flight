import { test } from "node:test";
import assert from "node:assert/strict";
import { preparingFlightProgress, bootDisplayFloor } from "../src/core/bootProgress.js";

test("real in-flight work shows through the envelope", () => {
  assert.equal(preparingFlightProgress(0.4, 1000, 3000, 12000), 0.4);
  assert.equal(preparingFlightProgress(0.75, 2500, 3000, 12000), 0.75);
});

test("a finished load CLIMBS visibly through the minimum window, then completes exactly at its end", () => {
  // The old contract held a dead 0%/95%; the bar must instead visibly move.
  assert.equal(preparingFlightProgress(1, 500, 3000, 12000), 0.15);
  assert.equal(preparingFlightProgress(1, 1500, 3000, 12000), 0.45);
  assert.equal(preparingFlightProgress(1, 2500, 3000, 12000), 0.75);
  assert.equal(preparingFlightProgress(1, 3000, 3000, 12000), 1);
  assert.equal(preparingFlightProgress(1, 4500, 3000, 12000), 1);
});

test("an already-resident destination (queue never grew) still shows the bar moving", () => {
  // The picker camera stared at the point: the queue is empty from the
  // first tick. The bar must climb honestly and complete with the window.
  assert.equal(preparingFlightProgress(0, 1000, 3000, 12000, true), 0.3);
  assert.equal(preparingFlightProgress(0, 2000, 3000, 12000, true), 0.6);
  assert.equal(preparingFlightProgress(0, 2999, 3000, 12000, true) < 1, true);
  assert.equal(preparingFlightProgress(0, 3000, 3000, 12000, true), 1);
});

test("the floor alone never reaches completion before the minimum window", () => {
  assert.ok(preparingFlightProgress(0.05, 2999, 3000, 12000) < 1);
  assert.ok(preparingFlightProgress(0, 2999, 3000, 12000, true) < 1);
});

test("a slow stream still shows motion: floor creeps while the ratio crawls", () => {
  assert.equal(preparingFlightProgress(0.05, 2000, 3000, 12000), 0.6);
  assert.equal(preparingFlightProgress(0.05, 100, 3000, 12000), 0.05); // raw already above the floor
  assert.equal(preparingFlightProgress(0.01, 100, 3000, 12000), 0.03); // floor lifts a crawling ratio
});

test("the hard cap always finishes the phase — never traps the player", () => {
  assert.equal(preparingFlightProgress(0.2, 12000, 3000, 12000), 1);
  assert.equal(preparingFlightProgress(0.05, 20000, 3000, 12000), 1);
  assert.equal(preparingFlightProgress(0, 20000, 3000, 12000, true), 1);
});

test("the queue ratio is clamped to [0,1] before use", () => {
  assert.equal(preparingFlightProgress(-0.5, 100, 3000, 12000), 0.03); // floor at t=100ms
  assert.equal(preparingFlightProgress(2, 100, 3000, 12000), 0.03); // clamps to 1 -> window path
});

test("garbage inputs degrade to the cap/window paths, never NaN", () => {
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

test("boot display floor creeps linearly and stops at its cap, never 100%", () => {
  assert.equal(bootDisplayFloor(0), 0);
  assert.equal(bootDisplayFloor(9000), 0.45);
  assert.equal(bootDisplayFloor(18000), 0.9);
  assert.equal(bootDisplayFloor(60000), 0.9);
  assert.ok(bootDisplayFloor(10 ** 9) < 1);
  // custom reach/cap
  assert.equal(bootDisplayFloor(5000, 10000, 0.8), 0.4);
});
