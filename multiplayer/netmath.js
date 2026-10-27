/**
 * Shared netcode math — the single pure source of truth for BOTH sides of
 * the connection, so the sender's prediction of what the receiver renders
 * can never drift from what the receiver actually renders.
 *
 * ── Why this module exists ──────────────────────────────────────────────
 * DIS (IEEE 1278, the military flight-sim standard) sender-side threshold
 * sending only works if the owner runs EXACTLY the dead-reckoning the
 * receivers run. Quake-style entity interpolation only smooths if both
 * sides agree on the timeline math. Every function here is pure (no
 * Cesium, no DOM, no timers) so the same code runs in the sender (net.js),
 * the receiver (remotePlanes.js) and the unit tests (mp-netmath.test.mjs).
 *
 * Units: lon/lat in degrees, alt in metres, heading/pitch/roll in degrees,
 * speed (v) in MPH, time in milliseconds. Rates are per-millisecond.
 */

export const MPH_TO_MPS = 0.44704;
const DEG = Math.PI / 180;
const EARTH_R = 6371000;

/** DIS threshold sending (shared by BOTH transports).
 *
 * Sender-side dead reckoning: transmit only when the receiver's
 * extrapolation of the last sent packet would diverge from the truth by more
 * than DR_THRESHOLD_M / DR_THRESHOLD_DEG, with a heartbeat floor so the
 * interpolation window never starves. Pure so it is unit-testable and so the
 * WebSocket and P2P transports send with byte-identical policy.
 *
 * @param {Array<{ts:number, lon:number, lat:number, h:number}>} sentLog last two SENT packets
 * @param {object} state            the true current flight state
 * @param {number} now              performance.now()
 * @param {number} worldSpeedScale  arcade speed lever (sender DR == receiver DR)
 * @param {{m?: number, deg?: number, heartbeatMs?: number}} [opts]
 * @returns {boolean} true = transmit now
 */
export function shouldTransmitState(sentLog, state, now, worldSpeedScale = 1.8, opts = {}) {
  const DR_THRESHOLD_M = opts.m ?? 15;
  const DR_THRESHOLD_DEG = opts.deg ?? 3;
  const STATE_HEARTBEAT_MS = opts.heartbeatMs ?? 150;
  const last = sentLog[sentLog.length - 1];
  if (!last) return true;
  const elapsed = now - last.ts;
  if (elapsed >= STATE_HEARTBEAT_MS) return true; // heartbeat floor
  const prev = sentLog[sentLog.length - 2];
  const predicted = drStep(last, estimateRates(prev || last, last), elapsed, worldSpeedScale);
  const div = divergence(state, predicted);
  return div.m > DR_THRESHOLD_M || div.hDeg > DR_THRESHOLD_DEG;
}

/** Wrap a longitude/heading difference into (-180, 180]. */
export function wrapDeg(d) {
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

/**
 * Advance a flight snapshot by `aheadMs` using full-airframe dead
 * reckoning: position along the (rotating) velocity vector, with the
 * heading/pitch/roll/speed rates from the last two snapshots (DIS DR-3/4
 * style). `fly: 0` snapshots are parked and do not move.
 */
export function drStep(snap, rates, aheadMs, worldSpeedScale = 1.8) {
  const ahead = Math.max(0, aheadMs);
  if (ahead <= 0 || !snap.fly) return { ...snap, t: snap.t + aheadMs };

  const h = snap.h + (rates.hr || 0) * ahead;
  const p = snap.p + (rates.pr || 0) * ahead;
  const r = snap.r + (rates.rr || 0) * ahead;
  const v = Math.max(0, snap.v + (rates.vr || 0) * ahead);

  const mps = v * MPH_TO_MPS * worldSpeedScale;
  const dist = mps * (ahead / 1000);

  const headingRad = h * DEG;
  const pitchRad = p * DEG;
  const dLat = (dist * Math.cos(headingRad) * Math.cos(pitchRad)) / EARTH_R;
  const cosLat = Math.max(0.2, Math.cos(snap.lat * DEG));
  const dLon = (dist * Math.sin(headingRad) * Math.cos(pitchRad)) / (EARTH_R * cosLat);
  const dAlt = dist * Math.sin(pitchRad);

  return {
    t: snap.t + aheadMs,
    lon: snap.lon + dLon / DEG,
    lat: snap.lat + dLat / DEG,
    alt: snap.alt + dAlt,
    h: ((h + 180) % 360 + 360) % 360 - 180,
    p,
    r,
    v,
    fly: snap.fly,
  };
}

/**
 * Derive the per-millisecond dead-reckoning rates (heading/pitch/roll/speed)
 * from two consecutive snapshots. Heading wraps the shortest way.
 */
export function estimateRates(a, b) {
  const span = b.t - a.t;
  if (!(span > 0)) return { hr: 0, pr: 0, rr: 0, vr: 0 };
  return {
    hr: wrapDeg(b.h - a.h) / span,
    pr: (b.p - a.p) / span,
    rr: wrapDeg(b.r - a.r) / span,
    vr: (b.v - a.v) / span,
  };
}

/** Equirectangular distance in metres between two {lon, lat, alt} poses. */
export function posDistanceM(a, b) {
  const dx = (b.lon - a.lon) * DEG * EARTH_R * Math.cos(((a.lat + b.lat) / 2) * DEG);
  const dy = (b.lat - a.lat) * DEG * EARTH_R;
  const dz = (b.alt ?? 0) - (a.alt ?? 0);
  return Math.hypot(dx, dy, dz);
}

/** How far a predicted pose has diverged from the truth: metres + degrees. */
export function divergence(truth, predicted) {
  return {
    m: posDistanceM(truth, predicted),
    hDeg: Math.abs(wrapDeg((truth.h ?? 0) - (predicted.h ?? 0))),
  };
}

/**
 * Smooth correction (DIS "lie gently"): when the freshly sampled pose is
 * only a small step from what is currently displayed, apply it directly —
 * normal interpolation gains no latency. When a stall or burst correction
 * has opened a LARGE gap, converge exponentially at `ratePerS` so the
 * catch-up reads as flight, never a teleport.
 */
export function convergeStep(shown, target, dtMs, { epsM = 30, ratePerS = 6 } = {}) {
  const err = posDistanceM(shown, target);
  if (err <= epsM) return target;
  const f = Math.min(1, Math.max(0, dtMs / 1000) * ratePerS);
  const inv = 1 - f;
  return {
    t: target.t,
    lon: shown.lon * inv + target.lon * f,
    lat: shown.lat * inv + target.lat * f,
    alt: shown.alt * inv + target.alt * f,
    h: shown.h + wrapDeg(target.h - shown.h) * f,
    p: shown.p + (target.p - shown.p) * f,
    r: shown.r + wrapDeg(target.r - shown.r) * f,
    v: shown.v * inv + target.v * f,
    fly: target.fly,
  };
}

/**
 * Adaptive interpolation window (Source-engine cl_interp behaviour): the
 * render delay is two send intervals plus the measured network jitter, so a
 * clean connection sits close to the present while a jittery one deepens
 * the buffer instead of stuttering. Clamped to sane bounds.
 */
export function adaptiveDelay(intervalMs, jitterMs) {
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 33;
  const jitter = Number.isFinite(jitterMs) && jitterMs > 0 ? jitterMs : 0;
  return Math.max(66, Math.min(250, 2 * interval + jitter));
}
