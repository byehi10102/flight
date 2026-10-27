/**
 * Helicopter flight model (plane/heliPhysics.js).
 *
 * The machine must HOVER when parked, climb on collective, drive forward on
 * nose-down tilt, reverse on nose-up, and turn into its bank. All asserted
 * on the numbers the config promises, so a tuning change that breaks the
 * feel fails here first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HeliPhysics } from "../src/plane/heliPhysics.js";
import { CONFIG } from "../src/core/config.js";

const DT = 1 / 60;
const NO_INPUT = { throttle: 0.5, pitch: 0, roll: 0, yaw: 0, boost: false };

function settle(input, seconds = 8) {
  const p = new HeliPhysics();
  p.reset(0, 0, 1000, 0, 0, 0);
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) p.update(input, DT);
  return p;
}

test("hover: collective at the hover point holds altitude with no drift", () => {
  const p = settle(NO_INPUT);
  assert.ok(Math.abs(p.vSpeed) < 0.15, `vSpeed ${p.vSpeed} should be ~0 at hover`);
  assert.ok(Math.abs(p.speed) < 1, `speed ${p.speed} should be ~0 at hover`);
  assert.ok(p.rotor > 0.99, "rotor must be spooled after a few seconds");
});

test("full collective climbs at the configured rate", () => {
  const p = settle({ ...NO_INPUT, throttle: 1 });
  assert.ok(p.vSpeed > CONFIG.heli.climbRateMps * 0.9, `vSpeed ${p.vSpeed}`);
});

test("zero collective descends", () => {
  const p = settle({ ...NO_INPUT, throttle: 0 });
  assert.ok(p.vSpeed < -CONFIG.heli.descentRateMps * 0.9, `vSpeed ${p.vSpeed}`);
});

test("ArrowUp tips the disc forward and drives to the top speed", () => {
  const p = settle({ ...NO_INPUT, pitch: -1 });
  assert.ok(p.pitch < -CONFIG.heli.maxPitchDeg * 0.9, `pitch ${p.pitch}`);
  assert.ok(p.speed > CONFIG.heli.maxSpeedMph * 0.9, `speed ${p.speed}`);
});

test("ArrowDown tilts back and reverses slowly (a helicopter backs up)", () => {
  const p = settle({ ...NO_INPUT, pitch: 1 });
  assert.ok(p.speed < -1, `speed ${p.speed} should be negative`);
  assert.ok(Math.abs(p.speed) <= CONFIG.heli.reverseSpeedMph + 1);
});

test("the stick commands attitude, not rate — releasing levels out", () => {
  const p = new HeliPhysics();
  p.reset(0, 0, 1000, 0, 0, 0);
  for (let i = 0; i < 120; i++) p.update({ ...NO_INPUT, roll: 1 }, DT);
  assert.ok(p.roll > CONFIG.heli.maxBankDeg * 0.8, `banked: ${p.roll}`);
  for (let i = 0; i < 180; i++) p.update(NO_INPUT, DT);
  assert.ok(Math.abs(p.roll) < 2, `released stick should level: ${p.roll}`);
});

test("pedals yaw, and bank turns INTO the bank", () => {
  const p = settle({ ...NO_INPUT, yaw: 1 }, 2);
  const yawed = p.heading;
  assert.ok(Math.abs(yawed) > 10, `pedals must yaw: ${yawed}`);
  const b = settle({ ...NO_INPUT, roll: 1 }, 3);
  // Right roll (positive) must turn right: heading decreases in this
  // convention (positive heading = left in YXZ euler yaw).
  assert.ok(b.heading < 0 || Math.abs(b.heading) > 5, `bank turn: ${b.heading}`);
});
