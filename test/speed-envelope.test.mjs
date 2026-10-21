/**
 * The flight-speed envelope, pinned:
 *   250 mph hands off the throttle, 3000 mph with W held, 7000 mph in boost —
 *   and boost is the ONLY way past 3000.
 *
 * These numbers are user-facing tuning, and the physics class carries its own
 * defaults (it reads no CONFIG), so the config side and the class side are
 * asserted to agree: a retune of one without the other used to be silent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../src/core/config.js";
import { PlanePhysics } from "../src/plane/planePhysics.js";

const idleInput = { throttle: 0, pitch: 0, roll: 0, yaw: 0, boost: false, cameraYaw: 0, cameraPitch: 0, isDragging: false };
const run = (physics, input, seconds, dt = 1 / 60) => {
  for (let t = 0; t < seconds; t += dt) physics.update(input, dt);
};

test("config: 250 cruise, 3000 on W, and boost reaches 7000", () => {
  assert.equal(CONFIG.physics.minSpeed, 250);
  assert.equal(CONFIG.physics.maxSpeed, 3000);
  assert.ok(Math.abs(CONFIG.physics.maxSpeed * CONFIG.boost.multiplier - 7000) < 1e-6);
});

test("physics class carries the same envelope as CONFIG", () => {
  const p = new PlanePhysics();
  assert.equal(p.minSpeed, CONFIG.physics.minSpeed);
  assert.equal(p.maxSpeed, CONFIG.physics.maxSpeed);
  assert.ok(Math.abs(p.maxSpeed * p.boostMultiplier - 7000) < 1e-6);
});

test("hands off the throttle the jet settles at the 250 mph cruise", () => {
  const p = new PlanePhysics();
  assert.equal(p.speed, 250);
  run(p, idleInput, 10);
  assert.ok(Math.abs(p.speed - 250) < 1, `expected 250 mph cruise, got ${p.speed}`);
});

test("holding W tops out at 3000 mph, never beyond", () => {
  const p = new PlanePhysics();
  run(p, { ...idleInput, throttle: 1 }, 30);
  assert.ok(Math.abs(p.speed - 3000) < 1, `expected 3000 mph ceiling, got ${p.speed}`);
  assert.ok(p.speed <= 3000 + 1e-6, `W must never exceed 3000 mph, got ${p.speed}`);
});

test("boost is the only way past 3000, and it reaches 7000", () => {
  const p = new PlanePhysics();
  run(p, { ...idleInput, throttle: 1 }, 20);
  const cruiseTop = p.speed;
  assert.ok(cruiseTop <= 3001, `precondition: W is capped, got ${cruiseTop}`);

  // One boost press: 3 s of afterburner.
  run(p, { ...idleInput, throttle: 1, boost: true }, 2.5);
  assert.ok(p.speed > 3000, `boost must pass the W ceiling, got ${p.speed}`);
  assert.ok(p.speed <= 7000 + 1e-6, `boost must never exceed 7000 mph, got ${p.speed}`);
  assert.ok(p.speed > 5000, `boost should be well past the ceiling, got ${p.speed}`);
});

test("once the boost burns out the jet falls back under 3000", () => {
  const p = new PlanePhysics();
  run(p, { ...idleInput, throttle: 1, boost: true }, 3);
  assert.ok(p.speed > 3000);
  run(p, { ...idleInput, throttle: 1 }, 15);
  assert.ok(p.speed <= 3000 + 1, `expected the W ceiling again, got ${p.speed}`);
});
