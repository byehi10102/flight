/**
 * Frame-budget controller (core/performance.js).
 *
 * The decision rule is pure, and the controller's job is to apply it on a
 * sampled window and push the result onto every render surface. Both are
 * asserted here: the rule (so tuning can't silently invert it) and the class
 * (so a single bad frame never moves the picture).
 *
 * Contract note (deliberate spec change, approved with the smoothness work):
 * the levers are now DETAIL FIRST, PIXELS SECOND — a struggling device is
 * usually tile-bound, so terrain detail (maximumScreenSpaceError) steps down
 * the ladder before resolution does. Recovery runs in reverse. The old
 * single-lever stepResolutionScale rule was replaced by decideFrameBudget.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideFrameBudget, AdaptivePerformance, PERF_DEFAULTS } from "../src/core/performance.js";

const FULL = { scale: 1, sseIndex: 0 };

test("a slow window steps tile DETAIL down first, pixels hold", () => {
  const r = decideFrameBudget(FULL, { medianMs: 40, minMs: 16 });
  assert.equal(r.sseIndex, 1, "detail ladder must move first");
  assert.equal(r.scale, 1, "pixels must hold while detail can still drop");
});

test("a severe overload (2-5 fps) drops detail AND pixels together", () => {
  const r = decideFrameBudget(FULL, { medianMs: 300, minMs: 300 });
  assert.equal(r.sseIndex, 1);
  assert.ok(r.scale < 1, "severe frames must also shed pixels");
});

test("once the detail ladder is exhausted, pixels step down", () => {
  const low = { scale: 1, sseIndex: PERF_DEFAULTS.sseLadder.length - 1 };
  const r = decideFrameBudget(low, { medianMs: 40, minMs: 16 });
  assert.equal(r.sseIndex, low.sseIndex, "ladder clamps at its end");
  assert.ok(r.scale < 1);
});

test("a fast window hands pixels back first, then detail", () => {
  const shed = { scale: 0.6, sseIndex: 1 };
  const r = decideFrameBudget(shed, { medianMs: 8, minMs: 8 });
  assert.ok(r.scale > 0.6, "sharpness returns first");
  assert.equal(r.sseIndex, 1, "detail waits until pixels are back");
  const full = decideFrameBudget({ scale: 1, sseIndex: 1 }, { medianMs: 8, minMs: 8 });
  assert.equal(full.sseIndex, 0, "detail returns once pixels are full");
});

test("a window inside the dead band does not move", () => {
  // 16 ms median with a 16 ms fastest frame: vsync 16, upT ~17.3, downT 24 —
  // right in the dead band.
  const r = decideFrameBudget(FULL, { medianMs: 16, minMs: 16 });
  assert.equal(r.scale, 1);
  assert.equal(r.sseIndex, 0);
  assert.equal(r.reason, "hold");
});

test("the scale never leaves [minScale, maxScale]", () => {
  const low = { scale: PERF_DEFAULTS.minScale, sseIndex: PERF_DEFAULTS.sseLadder.length - 1 };
  const r = decideFrameBudget(low, { medianMs: 500, minMs: 500 });
  assert.equal(r.scale, PERF_DEFAULTS.minScale);
  const high = decideFrameBudget(FULL, { medianMs: 1, minMs: 1 });
  assert.equal(high.scale, PERF_DEFAULTS.maxScale);
});

test("a window with no fast frame still judges by the fallback ceiling", () => {
  // Everything at 40 ms: no vsync evidence, fallback 24 ms ceiling applies.
  const r = decideFrameBudget(FULL, { medianMs: 40, minMs: 40 });
  assert.equal(r.sseIndex, 1, "40 ms against a 24 ms ceiling is still slow");
});

test("non-finite frame times are ignored by the rule", () => {
  const r = decideFrameBudget({ scale: 0.7, sseIndex: 0 }, { medianMs: NaN, minMs: 16 });
  assert.equal(r.scale, 0.7);
  assert.equal(r.reason, "no-data");
});


// ── Regression: the software-compositing dead band (measured on the player's
// machine: 12 straight windows at scale 1.0 / SSE 4-6 while a fresh Chrome
// shed to 0.5). The fastest frame on that path is ~25 ms; the old 20 ms
// vsync clamp pushed the too-slow threshold to 30 ms and nothing ever shed.

test("35 fps on a software path (median 28 / min 25) sheds detail then pixels", () => {
  const opts = { sseLadder: [4, 6, 8] };
  let s = { scale: 1, sseIndex: 0 };
  s = decideFrameBudget(s, { medianMs: 28, minMs: 25 }, opts);
  assert.equal(s.sseIndex, 1, "window 1: detail steps first");
  s = decideFrameBudget(s, { medianMs: 28, minMs: 25 }, opts);
  assert.equal(s.sseIndex, 2, "window 2: ladder exhausts");
  s = decideFrameBudget(s, { medianMs: 28, minMs: 25 }, opts);
  assert.ok(s.scale < 1, "window 3: pixels shed once detail is at the floor");
});

test("the emergency shed acts on a handful of extreme frames (2 fps session)", () => {
  // Default opts: windowMs 1500, minFrames 20. At 2 fps a window closes
  // with ~3 samples - below minFrames, where the old controller abstained
  // forever. The few frames are all extreme (300 ms), so it must go to the
  // floor immediately.
  const perf = new AdaptivePerformance({
    viewer: { resolutionScale: 1, scene: { globe: { maximumScreenSpaceError: 4 } } },
    renderer: { setPixelRatio() {} },
  });
  perf.sample(300, 0);
  perf.sample(300, 800);
  perf.sample(300, 1600); // window closes here with 3 of 20 frames
  assert.equal(perf.scale, PERF_DEFAULTS.minScale, "resolution at the floor");
  assert.equal(perf.report().sse, PERF_DEFAULTS.sseLadder[PERF_DEFAULTS.sseLadder.length - 1], "detail at the floor");
  assert.equal(perf.report().reason, "emergency");
});

function makeSurfaces() {
  const viewer = {
    resolutionScale: 1,
    scene: { globe: { maximumScreenSpaceError: 2, set: [] } },
  };
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

test("one janky frame inside a window does not change anything", () => {
  const { perf, viewer } = makeSurfaces();
  perf.sample(16, 0);
  perf.sample(600, 10);   // a single hitch
  assert.equal(perf.sample(16, 20), 1);
  assert.equal(viewer.resolutionScale, 1);
  assert.equal(viewer.scene.globe.maximumScreenSpaceError, 2);
});

test("a sustained slow window steps detail down on both globes", () => {
  const { perf, viewer } = makeSurfaces();
  // 40 ms median (median ignores the single hitch below).
  perf.sample(40, 0);
  perf.sample(40, 50);
  perf.sample(600, 60);
  perf.sample(40, 150);   // window closes here
  assert.equal(viewer.scene.globe.maximumScreenSpaceError, 4, "detail ladder moved");
  assert.equal(viewer.resolutionScale, 1, "pixels hold while detail can drop");
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

test("report exposes the levers and measured frame rate", () => {
  const { perf } = makeSurfaces();
  perf.sample(20, 0);
  perf.sample(20, 50);
  perf.sample(20, 150);
  const r = perf.report();
  assert.equal(r.avgMs, 20);
  assert.equal(r.fps, 50);
  assert.ok(r.scale <= 1 && r.scale >= PERF_DEFAULTS.minScale);
  assert.equal(r.sse, PERF_DEFAULTS.sseLadder[r.sseIndex]);
});
