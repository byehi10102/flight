import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveQualityProfile, QUALITY_TIERS } from "../src/core/quality.js";

// ── High tier: byte-for-byte today's viewer settings ────────────────────────
// The realism guard: a beefy machine must get EXACTLY the values the game
// ships with today (msaa 4, 2048-tile cache, 48 descendants, no dpr cap,
// full explosion). Any drift here is a visual regression.

test("beefy discrete-GPU desktop gets today's exact settings", () => {
  const p = deriveQualityProfile({
    gpuRenderer: "NVIDIA GeForce RTX 3070",
    deviceMemoryGB: 16,
    isMobile: false,
    devicePixelRatio: 1,
  });
  assert.equal(p.tier, QUALITY_TIERS.HIGH);
  assert.equal(p.msaaSamples, 4);
  assert.equal(p.tileCacheSize, 2048);
  assert.equal(p.loadingDescendantLimit, 48);
  assert.equal(p.pixelRatioCap, Infinity);
  assert.equal(p.explosionScale, 1);
});

test("unknown inputs default to high tier (never punish the unknown)", () => {
  const p = deriveQualityProfile({});
  assert.equal(p.tier, QUALITY_TIERS.HIGH);
});

// ── Low tier: only visually-invisible trade-offs ────────────────────────────

test("integrated GPU lands on low tier with invisible-only reductions", () => {
  const p = deriveQualityProfile({
    gpuRenderer: "Intel(R) UHD Graphics 620",
    deviceMemoryGB: 8,
    isMobile: false,
    devicePixelRatio: 1,
  });
  assert.equal(p.tier, QUALITY_TIERS.LOW);
  assert.equal(p.msaaSamples, 2);
  assert.equal(p.tileCacheSize, 600);
  assert.equal(p.loadingDescendantLimit, 24);
  assert.equal(p.pixelRatioCap, 1.75);
  assert.equal(p.explosionScale, 0.7);
});

test("low deviceMemory forces low tier even on a named GPU", () => {
  const p = deriveQualityProfile({
    gpuRenderer: "NVIDIA GeForce RTX 3070",
    deviceMemoryGB: 2,
    isMobile: false,
    devicePixelRatio: 1,
  });
  assert.equal(p.tier, QUALITY_TIERS.LOW);
});

test("mobile devices land on low tier", () => {
  const p = deriveQualityProfile({
    gpuRenderer: "Adreno (TM) 730",
    deviceMemoryGB: 6,
    isMobile: true,
    devicePixelRatio: 2.6,
  });
  assert.equal(p.tier, QUALITY_TIERS.LOW);
});

test("Apple GPUs (no renderer string) on desktop stay high with ample memory", () => {
  const p = deriveQualityProfile({
    gpuRenderer: "",
    deviceMemoryGB: 16,
    isMobile: false,
    devicePixelRatio: 2,
  });
  assert.equal(p.tier, QUALITY_TIERS.HIGH);
});

// ── Realism invariants on EVERY tier ─────────────────────────────────────────

test("no tier ever reduces render resolution or tile detail", () => {
  const low = deriveQualityProfile({ gpuRenderer: "Intel UHD", deviceMemoryGB: 2, isMobile: false });
  const high = deriveQualityProfile({ gpuRenderer: "RTX", deviceMemoryGB: 16, isMobile: false });
  for (const p of [low, high]) {
    assert.equal(p.resolutionScale, 1); // full res everywhere
    assert.equal(p.maximumScreenSpaceError, 2); // full tile detail everywhere
  }
});

test("profiles are frozen objects (no mid-flight mutation)", () => {
  const p = deriveQualityProfile({ gpuRenderer: "Intel UHD", deviceMemoryGB: 2, isMobile: false });
  assert.throws(() => { p.msaaSamples = 8; });
});
