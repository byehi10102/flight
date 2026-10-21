/**
 * Which imagery level the jet may ask for at a given speed. The point of the
 * curve is the SHAPE, not the exact digits: full detail at cruise, the W
 * ceiling at 3000, coarser in boost, and never coarser than the DEM.
 * If someone flattens it to a constant, this test fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { imageryLevelForSpeed, DETAIL_POLICY } from "../src/core/detailPolicy.js";

test("slow flight gets the full detail level, including standing still", () => {
  assert.equal(imageryLevelForSpeed(0), DETAIL_POLICY.fullLevel);
  assert.equal(imageryLevelForSpeed(250), DETAIL_POLICY.fullLevel);
  assert.equal(imageryLevelForSpeed(800), DETAIL_POLICY.fullLevel);
});

test("the W ceiling lands exactly on the ceiling level", () => {
  assert.equal(imageryLevelForSpeed(3000), DETAIL_POLICY.ceilingLevel);
});

test("boost gets the boost level, and never coarser than the DEM", () => {
  assert.equal(imageryLevelForSpeed(7000), DETAIL_POLICY.boostLevel);
  assert.equal(imageryLevelForSpeed(99999), DETAIL_POLICY.boostLevel);
  assert.ok(DETAIL_POLICY.boostLevel >= DETAIL_POLICY.minLevel);
});

test("the curve is monotonic: faster never means more detail", () => {
  let prev = imageryLevelForSpeed(0);
  for (let mph = 0; mph <= 8000; mph += 50) {
    const lv = imageryLevelForSpeed(mph);
    assert.ok(lv <= prev, `level rose from ${prev} to ${lv} at ${mph} mph`);
    assert.ok(lv >= DETAIL_POLICY.minLevel && lv <= DETAIL_POLICY.fullLevel,
      `level ${lv} out of range at ${mph} mph`);
    prev = lv;
  }
});

test("it is a real ramp, not a step: the middle of the range is between the ends", () => {
  const mid = imageryLevelForSpeed(1900);
  assert.ok(mid < DETAIL_POLICY.fullLevel && mid > DETAIL_POLICY.ceilingLevel,
    `expected a level between ${DETAIL_POLICY.ceilingLevel} and ${DETAIL_POLICY.fullLevel}, got ${mid}`);
});

test("garbage speed is treated as slow (never a surprise downgrade)", () => {
  assert.equal(imageryLevelForSpeed(NaN), DETAIL_POLICY.fullLevel);
  assert.equal(imageryLevelForSpeed(undefined), DETAIL_POLICY.fullLevel);
  assert.equal(imageryLevelForSpeed(-5), DETAIL_POLICY.fullLevel);
});
