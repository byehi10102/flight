/**
 * Frame-budget thermostat (core/performance.js).
 *
 * The decision rule is pure, and the controller's job is to apply it on a
 * sampled window and push the result onto all three render surfaces. Both are
 * asserted here: the rule (so tuning can't silently invert it) and the class
 * (so a single bad frame never moves the picture).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stepResolutionScale, AdaptivePerformance, PERF_DEFAULTS } from "../src/core/performance.js";

test("a slow window steps the resolution down", () => {
  assert.ok(stepResolutionScale(1, 40) < 1);
});

test("a fast window steps the resolution back up", () => {
  assert.ok(stepResolutionScale(0.6, 8) > 0.6);
});

test("a window inside the dead band does not move", () => {
  assert.equal(stepResolutionScale(0.8, 16), 0.8);
  assert.equal(stepResolutionScale(1, PERF_DEFAULTS.highMs), 1);
  assert.equal(stepResolutionScale(1, PERF_DEFAULTS.lowMs), 1);
});

test("the scale never leaves [minScale, maxScale]", () => {
  // One step at a time: a slow window takes 1 -> 0.85, it never teleports to
  // the floor (a single visible resolution change is worth a gradual descent).
  assert.equal(stepResolutionScale(1, 500), PERF_DEFAULTS.stepDown);
  assert.ok(stepResolutionScale(1, 500) < 1);
  // At the edge it clamps instead of undershooting.
  assert.equal(stepResolutionScale(0.7, 500), PERF_DEFAULTS.minScale);
  assert.equal(stepResolutionScale(0.6, 500), PERF_DEFAULTS.minScale);
  assert.equal(stepResolutionScale(1, 1), PERF_DEFAULTS.maxScale);
  assert.equal(stepResolutionScale(0.99, 1), PERF_DEFAULTS.maxScale);
});

test("non-finite frame times are ignored by the rule", () => {
  assert.equal(stepResolutionScale(0.7, NaN), 0.7);
  assert.equal(stepResolutionScale(0.7, Infinity), 0.7);
});

function makeSurfaces() {
  const viewer = { resolutionScale: 1 };
  const miniViewer = { resolutionScale: 1 };
  const renderer = { ratios: [], setPixelRatio(v) { this.ratios.push(v); } };
  const perf = new AdaptivePerformance({
    viewer,
    renderer,
    getMiniViewer: () => miniViewer,
    getPixelRatioCap: () => 2,
    // Short, deterministic windows for the test.
    opts: { windowMs: 100, minFrames: 3 },
  });
  return { perf, viewer, miniViewer, renderer };
}

test("one janky frame inside a window does not change the resolution", () => {
  const { perf, viewer } = makeSurfaces();
  perf.sample(16, 0);
  perf.sample(600, 10);   // a single hitch
  assert.equal(perf.sample(16, 20), 1);
  assert.equal(viewer.resolutionScale, 1);
});

test("a sustained slow window reduces BOTH globes and the overlay", () => {
  const { perf, viewer, miniViewer, renderer } = makeSurfaces();
  // 40 fps... no: 40 ms frames = 25 fps, sustained past the window.
  perf.sample(40, 0);
  perf.sample(40, 50);
  perf.sample(40, 150);   // window closes here
  assert.ok(viewer.resolutionScale < 1);
  assert.ok(miniViewer.resolutionScale < 1);
  assert.ok(renderer.ratios.length > 0, "overlay pixel ratio was never applied");
  assert.ok(renderer.ratios[0] <= 2, "overlay ratio must respect the device cap");
});

test("a sustained fast window hands the resolution back", () => {
  const { perf, viewer } = makeSurfaces();
  perf.scale = 0.6;
  perf.apply();
  perf.sample(8, 0);
  perf.sample(8, 50);
  perf.sample(8, 150);
  assert.ok(viewer.resolutionScale > 0.6);
});

test("the thermostat is inert while it is disabled (loading films)", () => {
  const { perf, viewer } = makeSurfaces();
  perf.setEnabled(false);
  perf.sample(200, 0);
  perf.sample(200, 200);
  perf.sample(200, 400);
  assert.equal(viewer.resolutionScale, 1);
  assert.equal(perf.report().enabled, false);
});

test("report exposes the current scale and measured frame rate", () => {
  const { perf } = makeSurfaces();
  perf.sample(20, 0);
  perf.sample(20, 50);
  perf.sample(20, 150);
  const r = perf.report();
  assert.equal(r.avgMs, 20);
  assert.equal(r.fps, 50);
  assert.ok(r.scale <= 1 && r.scale >= PERF_DEFAULTS.minScale);
});
