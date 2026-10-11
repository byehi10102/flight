/**
 * Boot progress — a single place that turns "what has actually finished
 * loading" into the progress-bar percent.
 *
 * Each boot stage carries a slice of the bar (the weights below sum to 100).
 * A stage's flag releases its whole slice the moment it completes; before
 * that, its optional sub-progress (0..1) releases a proportional part, so
 * the bar tracks REAL work — bytes decoded, tiles streamed — never a timer.
 *
 * Kept pure (no DOM, no Cesium) so the arithmetic is unit-testable.
 */

export const DEFAULT_BOOT_WEIGHTS = {
  cesium: 15,
  model: 15,
  audio: 10,
  globe: 15,
  terrain: 20,
  area: 25,
};

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * @param {Record<string, boolean>} flags   stage done-flags (e.g. loadingStatus)
 * @param {Record<string, number>} [sub]    per-stage partial progress, 0..1
 * @param {Record<string, number>} [weights] per-stage bar weights (sum 100)
 * @returns {number} percent, 0..100
 */
export function computeBootProgress(flags, sub = {}, weights = DEFAULT_BOOT_WEIGHTS) {
  let pct = 0;
  for (const key of Object.keys(weights)) {
    if (flags && flags[key]) {
      pct += weights[key];
    } else {
      const frac = clamp01(sub ? sub[key] : 0);
      if (frac > 0) pct += weights[key] * frac;
    }
  }
  return pct;
}
