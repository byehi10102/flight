import { test } from "node:test";
import assert from "node:assert/strict";
import { tapeOffsetPx, COMPASS_PX_PER_DEG } from "../src/ui/compass.js";

test("pixels per degree default is 4 (ref-flight tape density)", () => {
  assert.equal(COMPASS_PX_PER_DEG, 4);
});

test("heading 0 centers north under the index of a 400px strip", () => {
  // Ticks are laid out at (deg + 360) * pxPerDeg, so N sits at 1440px.
  // Centering it in a 400px window: translateX = -1440 + 200 = -1240.
  assert.equal(tapeOffsetPx(0, 400), -(0 + 360) * 4 + 200);
  assert.equal(tapeOffsetPx(0, 400), -1240);
});

test("heading 90 centers east", () => {
  assert.equal(tapeOffsetPx(90, 400), -(90 + 360) * 4 + 200);
  assert.equal(tapeOffsetPx(90, 400), -1600);
});

test("heading 350 centers just west of north", () => {
  assert.equal(tapeOffsetPx(350, 400), -(350 + 360) * 4 + 200);
  assert.equal(tapeOffsetPx(350, 400), -2640);
});

test("fractional headings scroll smoothly", () => {
  const a = tapeOffsetPx(10, 400);
  const b = tapeOffsetPx(10.5, 400);
  assert.equal(a - b, 0.5 * 4);
});

test("wider strips shift the offset by half the width delta", () => {
  const w400 = tapeOffsetPx(45, 400);
  const w600 = tapeOffsetPx(45, 600);
  assert.equal(w600 - w400, 100);
});

test("custom pxPerDeg scales the tape", () => {
  assert.equal(tapeOffsetPx(0, 400, 8), -(0 + 360) * 8 + 200);
});
