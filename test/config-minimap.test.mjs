import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG, computeMinimapZoomAltitude } from "../src/core/config.js";

test("computeMinimapZoomAltitude exists with a default config", () => {
  assert.equal(typeof computeMinimapZoomAltitude, "function");
  assert.ok(CONFIG.minimap);
});

test("zoom tracks altitude: higher up zooms out, near ground zooms in", () => {
  const low = computeMinimapZoomAltitude(300);
  const mid = computeMinimapZoomAltitude(1500);
  const high = computeMinimapZoomAltitude(8000);
  const higher = computeMinimapZoomAltitude(20000);
  assert.ok(low < mid && mid < high && high < higher,
    `not monotonic: ${low} ${mid} ${high} ${higher}`);
});

test("near the ground the map is zoomed in tight (min floor)", () => {
  // On the deck the footprint must be the tightest allowed view.
  assert.equal(computeMinimapZoomAltitude(0), CONFIG.minimap.minZoomAlt);
  assert.equal(computeMinimapZoomAltitude(100), CONFIG.minimap.minZoomAlt);
});

test("very high up the map is fully zoomed out (max ceiling)", () => {
  const ceil = computeMinimapZoomAltitude(60000);
  assert.equal(ceil, CONFIG.minimap.maxZoomAlt);
  // Infinity is treated as garbage (non-finite) -> the safe floor, not a
  // bogus unbounded view.
  assert.equal(computeMinimapZoomAltitude(Infinity), CONFIG.minimap.minZoomAlt);
});

test("spawn altitude gives roughly the old 1K-range view", () => {
  // The old static 1K setting flew the map at ~2500 m; spawning at 1500 m
  // AGL should land in the same ballpark so the spawn view is familiar.
  const z = computeMinimapZoomAltitude(1500);
  assert.ok(z >= 2000 && z <= 3000, `spawn zoom ${z} not in [2000, 3000]`);
});

test("garbage AGL degrades to the floor, never NaN", () => {
  assert.equal(computeMinimapZoomAltitude(NaN), CONFIG.minimap.minZoomAlt);
  assert.equal(computeMinimapZoomAltitude(-500), CONFIG.minimap.minZoomAlt);
  assert.ok(Number.isFinite(computeMinimapZoomAltitude(undefined)));
});
