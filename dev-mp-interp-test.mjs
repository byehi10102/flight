/**
 * Regression test for remote-plane reconstruction (snapshot interpolation).
 *
 * Drives the REAL multiplayer/remotePlanes.js under Node with a fake Cesium,
 * replaying a peer that flies the game's own movement math and broadcasts on
 * a realistic, jittery schedule. It checks the three things that make remote
 * motion feel right:
 *
 *   1. smooth   — the rendered plane advances at the true speed every frame,
 *                 with low frame-to-frame variance and no stalls.
 *   2. closing  — when the peer is coming at you, it MOVES (rendered ground
 *                 speed matches reality), it does not hang.
 *   3. resilient— through a packet gap it keeps moving briefly, then holds
 *                 without snapping backward.
 *
 * No Cesium/WebGL is required, so this runs anywhere Node runs.
 */
import "./dev-mp-interp-fakes.mjs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { createRemotePlanes } = await import(
  pathToFileURL(path.join(here, "multiplayer", "remotePlanes.js")).href
);

const MPH_TO_MPS = 0.44704;
const WORLD_SPEED_SCALE = 1.8;
const DEG = Math.PI / 180;

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? "  — " + detail : ""}`); }
};

function movePosition(lon, lat, alt, heading, pitch, distance) {
  const h = heading * DEG;
  const p = pitch * DEG;
  const R = 6371000;
  const dLat = (distance * Math.cos(h) * Math.cos(p)) / R;
  const dLon = (distance * Math.sin(h) * Math.cos(p)) / (R * Math.cos(lat * DEG));
  const dAlt = distance * Math.sin(p);
  return { lon: lon + dLon / DEG, lat: lat + dLat / DEG, alt: alt + dAlt };
}

/**
 * @param sendMs   stop sending after this long (Infinity = always send)
 * @param lossRate fraction of packets dropped
 * @returns { steps, backward, movedAfterGap, movedLongAfterGap, meanSpeedRatio }
 */
function simulate({ speedMph, hz, latencyMs = 0, jitterMs = 0, seconds = 4, frameMs = 1000 / 60, sendMs = Infinity, lossRate = 0 }) {
  const planes = createRemotePlanes({
    Cesium: globalThis.__fakeCesium,
    viewer: globalThis.__fakeViewer,
    worldSpeedScale: WORLD_SPEED_SCALE,
  });

  const intervalMs = 1000 / hz;
  const truth = { lon: -117.9, lat: 33.8, alt: 30000, heading: 90, pitch: 0, v: speedMph };
  const expected = speedMph * MPH_TO_MPS * WORLD_SPEED_SCALE * (frameMs / 1000);
  const inFlight = [];
  const steps = [];
  let prev = null;
  let tAtGap = null;
  let posAtGap = null;
  let posAfterGap = null;
  let posLongAfterGap = null;

  const frames = Math.round((seconds * 1000) / frameMs);
  for (let f = 0; f < frames; f++) {
    const t = f * frameMs;

    const mps = truth.v * MPH_TO_MPS * WORLD_SPEED_SCALE;
    const np = movePosition(truth.lon, truth.lat, truth.alt, truth.heading, truth.pitch, mps * (frameMs / 1000));
    truth.lon = np.lon; truth.lat = np.lat; truth.alt = np.alt;

    if (t <= sendMs && Math.floor(t / intervalMs) > Math.floor((t - frameMs) / intervalMs)) {
      if (Math.random() >= lossRate) {
        inFlight.push({
          arriveMs: t + latencyMs + (Math.random() - 0.5) * 2 * jitterMs,
          data: {
            ts: t,
            lon: +truth.lon.toFixed(5), lat: +truth.lat.toFixed(5), alt: Math.round(truth.alt),
            h: +truth.heading.toFixed(1), p: +truth.pitch.toFixed(1), r: 0,
            v: Math.round(truth.v), fly: 1,
          },
        });
      }
    }

    for (let i = inFlight.length - 1; i >= 0; i--) {
      if (inFlight[i].arriveMs <= t) { planes.setState("peer", inFlight[i].data, inFlight[i].arriveMs); inFlight.splice(i, 1); }
    }

    planes.update(frameMs / 1000, t);
    const live = planes.getLive("peer");
    if (live && prev) {
      const dLat = (live.lat - prev.lat) * 111320;
      const dLon = (live.lon - prev.lon) * 111320 * Math.cos(live.lat * DEG);
      steps.push(Math.hypot(dLat, dLon, live.alt - prev.alt));
    }
    if (live) prev = live;

    if (tAtGap == null && t >= sendMs) { tAtGap = t; posAtGap = live && { ...live }; }
    if (tAtGap != null && t >= tAtGap + 400 && !posAfterGap) posAfterGap = live && { ...live };
    if (tAtGap != null && t >= tAtGap + 1000) posLongAfterGap = live && { ...live };
  }

  const tail = steps.slice(12);
  const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
  const stdev = Math.sqrt(tail.reduce((a, b) => a + (b - mean) ** 2, 0) / tail.length);
  let backward = 0;
  for (let i = 1; i < tail.length; i++) if (tail[i] < tail[i - 1] * 0.4) backward++;

  const dist = (a, b) => (a && b ? Math.hypot((b.lat - a.lat) * 111320, (b.lon - a.lon) * 111320 * Math.cos(a.lat * DEG)) : 0);
  return {
    expected,
    mean, stdev, backward, frames: tail.length,
    movedAfterGap: dist(posAtGap, posAfterGap),
    movedLongAfterGap: dist(posAfterGap, posLongAfterGap),
  };
}

console.log("\n=== remote-plane interpolation ===\n");

for (const speed of [500, 5000, 10000]) {
  for (const hz of [30, 20, 4, 1]) {
    const r = simulate({ speedMph: speed, hz, latencyMs: 60, jitterMs: 25 });
    const speedErr = Math.abs(r.mean - r.expected) / r.expected;
    check(
      `${speed} mph @ ${hz} Hz — advances at the true speed (${r.mean.toFixed(1)} vs ${r.expected.toFixed(1)} m/frame)`,
      speedErr < 0.06, `${(speedErr * 100).toFixed(1)}% off`
    );
    check(
      `${speed} mph @ ${hz} Hz — smooth (stdev ${((r.stdev / r.mean) * 100).toFixed(1)}% of mean, ${r.backward}/${r.frames} stalls)`,
      r.stdev / r.mean < 0.2 && r.backward <= 2
    );
  }
  console.log("");
}

const lossy = simulate({ speedMph: 5000, hz: 20, latencyMs: 80, jitterMs: 40, lossRate: 0.3 });
check("30% packet loss still advances at the true speed", Math.abs(lossy.mean - lossy.expected) / lossy.expected < 0.08,
  `${lossy.mean.toFixed(1)} vs ${lossy.expected.toFixed(1)}`);

const gap = simulate({ speedMph: 5000, hz: 20, seconds: 3, sendMs: 1500 });
check("keeps flying through a packet gap (no freeze, no hover)", gap.movedAfterGap > 50,
  `${gap.movedAfterGap.toFixed(1)} m over 400 ms`);
check("still moving (never snaps backward) after the gap", gap.movedLongAfterGap > 0,
  `${gap.movedLongAfterGap.toFixed(1)} m over the next 600 ms`);

// Closing check: rendered ground speed equals the real one, so a plane
// flying toward you closes the distance instead of appearing to hang.
const closing = simulate({ speedMph: 5000, hz: 20, latencyMs: 60, jitterMs: 20 });
const ratio = closing.mean / closing.expected;
check("peer flying toward you moves at full rate (closing is real)", ratio > 0.95 && ratio < 1.05,
  `rendered/true = ${ratio.toFixed(3)}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
