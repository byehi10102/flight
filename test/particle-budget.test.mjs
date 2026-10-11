import { test } from "node:test";
import assert from "node:assert/strict";
import { explosionCounts } from "../src/utils/particles.js";
import { deriveQualityProfile } from "../src/core/quality.js";

const HIGH = deriveQualityProfile({ gpuRenderer: "NVIDIA GeForce RTX 3070", deviceMemoryGB: 16, isMobile: false });
const LOW = deriveQualityProfile({ gpuRenderer: "Intel UHD", deviceMemoryGB: 2, isMobile: false });

test("high tier keeps the exact current crash burst (72 fire, 22 sparks, 16 smoke)", () => {
  const n = explosionCounts(HIGH, { big: true, count: 72, smokeCount: 16 });
  assert.deepEqual(n, { fire: 72, sparks: 22, smoke: 16 });
});

test("low tier scales every category by the profile budget", () => {
  const n = explosionCounts(LOW, { big: true, count: 72, smokeCount: 16 });
  assert.deepEqual(n, { fire: 50, sparks: 15, smoke: 11 }); // round(0.7 * x)
});

test("defaults are preserved when the caller passes no counts", () => {
  assert.deepEqual(explosionCounts(HIGH, { big: true }), { fire: 40, sparks: 22, smoke: 8 });
  assert.deepEqual(explosionCounts(HIGH, { big: false }), { fire: 22, sparks: 12, smoke: 4 });
  assert.deepEqual(explosionCounts(LOW, { big: true }), { fire: 28, sparks: 15, smoke: 6 });
});

test("a profile without an explosion scale behaves like the high tier", () => {
  const n = explosionCounts({}, { big: true, count: 72, smokeCount: 16 });
  assert.deepEqual(n, { fire: 72, sparks: 22, smoke: 16 });
});

test("no category ever drops below one puff", () => {
  const n = explosionCounts({ explosionScale: 0.01 }, { big: true });
  assert.ok(n.fire >= 1 && n.sparks >= 1 && n.smoke >= 1);
});

test("scaling floors tiny bursts to at least one, not zero", () => {
  const n = explosionCounts(LOW, { big: false });
  assert.ok(n.fire >= 1 && n.sparks >= 1 && n.smoke >= 1);
});
