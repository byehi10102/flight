/**
 * Pure math for the aerodynamic effects (wing vapor + wingtip vortices).
 *
 * Every formula here is lifted from the shipped flight.tarmizi.id bundle
 * (`assets/index-Bkmtugvw.js`, module at byte ~936k, class constructed as
 * `new AerodynamicEffects(scene, viewer, planeModel, config, maxSpeed,
 * minSpeed)`), kept pure so it is unit-testable without a WebGL context.
 *
 * Angles are RADIANS here (the reference's rawPitch/rawRoll); the game's
 * state.pitch/state.roll are degrees and are converted at the call site.
 */

/** Reference constants (minified names in parens). */
export const AERO = Object.freeze({
  // condensation gates (Sm)
  PITCH_MIN: 0.18,
  // vortex gates (wm / m1)
  VORTEX_ROLL_MIN: 0.18,
  VORTEX_PITCH_MIN: 0.18,
  // exponential smoothing rates: condensation 8, vortices 7
  CONDENSATION_RATE: 8,
  VORTEX_RATE: 7,
  // base sample count (p1) and its flat/curved multipliers (1.9 / 2.2)
  BASE_SAMPLES: 60,
  FLAT_SAMPLE_MULT: 1.9,
  CURVED_SAMPLE_MULT: 2.2,
  // trail sampling (Br, f1, Tm, Mm, d1, O_)
  TRAIL_MIN_DISTANCE: 1,
  TRAIL_MAX_SPAWN_PER_FRAME: 48,
  TRAIL_SAMPLE_LIFE: 1.5,
  TRAIL_BASE_SIZE: 0.5,
  TRAIL_OPACITY_SCALE: 0.25,
  TRAIL_SMOOTH_STEPS: 4,
  TRAIL_POINT_CAP: 4096,
});

export function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Frame-rate independent approach: lerp(c, t, 1 - e^(-rate*dt)) (Ku). */
export function expLerp(current, target, dt, rate) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/** 0..1 position between min and max speed (getSpeedFactor). */
export function speedFactor(speed, minSpeed, maxSpeed) {
  return clamp01((speed - minSpeed) / Math.max(1, maxSpeed - minSpeed));
}

/** Visible-from factor: even slow flight shows a little vapor (0.18 + f*0.82). */
export function speedVisibility(visibleFactor) {
  return 0.18 + visibleFactor * 0.82;
}

/** Vapor intensity target: high speed AND a hard pull-up / climb. */
export function condensationTarget(visibleFactor, rawPitchRad) {
  const pitch = clamp01((rawPitchRad - AERO.PITCH_MIN) / (1 - AERO.PITCH_MIN));
  return speedVisibility(visibleFactor) * pitch;
}

/** Vortex intensity target: high speed AND (roll OR pitch) above threshold. */
export function vortexTarget(visibleFactor, rawRollRad, rawPitchRad) {
  const roll = clamp01((Math.abs(rawRollRad) - AERO.VORTEX_ROLL_MIN) / (1 - AERO.VORTEX_ROLL_MIN));
  const pitch = clamp01((Math.abs(rawPitchRad) - AERO.VORTEX_PITCH_MIN) / (1 - AERO.VORTEX_PITCH_MIN));
  return speedVisibility(visibleFactor) * Math.max(roll, pitch);
}

/** Point counts for the two cloud shapes: flat wing pad and curved upper pad. */
export function condensationSampleCounts(base = AERO.BASE_SAMPLES) {
  return {
    flat: Math.max(80, Math.floor(base * AERO.FLAT_SAMPLE_MULT)),
    curved: Math.max(96, Math.floor(base * AERO.CURVED_SAMPLE_MULT)),
  };
}

/**
 * Sample grid for one cloud: a jittered span/chord lattice sized to `count`.
 * Column count is derived from the reference's `sqrt(count * 0.7)`.
 */
export function condensationGrid(count) {
  const spanSamples = Math.max(8, Math.round(Math.sqrt(count * 0.7)));
  const chordSamples = Math.max(8, Math.ceil(count / spanSamples));
  return { spanSamples, chordSamples };
}

/** Trail point buffer size needed to draw all samples with smoothing gaps. */
export function trailPointCapacity(leftCount, rightCount, smoothSteps = AERO.TRAIL_SMOOTH_STEPS) {
  return Math.max(1, leftCount) + Math.max(1, rightCount)
    + Math.max(0, leftCount - 1) * smoothSteps
    + Math.max(0, rightCount - 1) * smoothSteps;
}

/** Samples to add between the last spawn and the new tip position (capped). */
export function trailSpawnSteps(distance, minDistance = AERO.TRAIL_MIN_DISTANCE) {
  if (!Number.isFinite(distance) || distance < minDistance) return 0;
  return Math.min(AERO.TRAIL_MAX_SPAWN_PER_FRAME, Math.floor(distance / minDistance));
}

/**
 * Sample spacing for the ribbon: the reference spaces samples 1 unit apart
 * with the jet 25 units in front of its camera. Here that distance is the
 * live camera-to-wingtip distance, so the spacing scales with it and the
 * ribbon keeps the reference's subdivision per visible length.
 */
export function trailSpacing(spawnDistance, referenceSpacing = AERO.TRAIL_MIN_DISTANCE, referenceDistance = 25) {
  if (!Number.isFinite(spawnDistance) || spawnDistance <= 0) return referenceSpacing;
  return Math.min(referenceSpacing, Math.max(0.02, (spawnDistance / referenceDistance) * referenceSpacing));
}

/**
 * How far behind the camera the ribbon is still worth building. The reference
 * keeps 1.5 s of samples because its jet is 25 units ahead of the camera; at
 * this game's camera distance the jet outruns its whole trail inside a single
 * frame, so anything past this window can never be drawn (only uploaded).
 */
export function trailKeepDistance(spawnDistance, multiplier = 1.5) {
  if (!Number.isFinite(spawnDistance) || spawnDistance <= 0) return 3;
  return spawnDistance * multiplier;
}
