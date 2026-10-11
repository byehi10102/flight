import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHudScale } from "../src/ui/mobileMode.js";

test("desktop reference viewport gets no scaling (exactly 1)", () => {
  assert.equal(computeHudScale(1440, 900), 1);
  assert.equal(computeHudScale(1920, 1080), 1);
});

test("a phone in landscape scales by the limiting dimension (height)", () => {
  // 844x390: min(844/1280, 390/720) = min(0.659, 0.5417) = 0.5417
  assert.ok(Math.abs(computeHudScale(844, 390) - 390 / 720) < 1e-9);
});

test("a tablet in landscape scales by the limiting dimension (width)", () => {
  // 1024x768: min(0.8, 1.0667) = 0.8
  assert.equal(computeHudScale(1024, 768), 0.8);
});

test("scale never drops below the 0.5 readability floor", () => {
  assert.equal(computeHudScale(640, 360), 0.5);
  assert.equal(computeHudScale(320, 180), 0.5);
});

test("scale never exceeds 1", () => {
  assert.equal(computeHudScale(2560, 1440), 1);
});

test("scale is finite and positive for odd sizes", () => {
  const s = computeHudScale(731, 411);
  assert.ok(Number.isFinite(s) && s > 0 && s <= 1);
});
