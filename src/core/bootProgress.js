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

/**
 * A display-side high-water mark. The tile-queue ratios feeding the progress
 * bars are NOT monotonic — Cesium re-requests tiles during LOD refinement, so
 * the queue spikes and the raw ratio retreats, visibly dragging the bar
 * backwards. Wrapping the percent in this clamp keeps the tracking real while
 * making the displayed bar never retreat.
 */
export class MonotonicPercent {
  constructor() {
    this._max = 0;
  }

  /** Forget the high-water mark (e.g. a new preparing-flight phase). */
  reset() {
    this._max = 0;
  }

  /**
   * @param {number} pct raw percent/fraction (any unit)
   * @returns {number} the largest finite value ever passed to update()
   */
  update(pct) {
    const v = Number(pct);
    if (Number.isFinite(v) && v > this._max) this._max = v;
    return this._max;
  }
}

/**
 * Boot display floor — the anti-"dead bar" companion to computeBootProgress.
 *
 * Real sub-progress can legitimately sit still: a tile queue that hasn't
 * grown yet reports 0, a finished-fast stage flips its flag in one jump, and
 * on a stalled network nothing moves at all. The floor creeps the DISPLAY
 * up slowly (reaching `cap` after `reachMs`) so the bar always looks alive;
 * it can never reach 100 on its own — `cap` stops short, and completion
 * still only comes from real stage flags.
 */
export function bootDisplayFloor(elapsedMs, reachMs = 18000, cap = 0.9) {
  const t = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const reach = reachMs > 0 ? reachMs : 1;
  const c = Math.max(0, Math.min(1, cap));
  return Math.min(c, (c * t) / reach);
}

/**
 * "Preparing flight" progress envelope — the progress bar between tapping
 * SPAWN HERE and the camera dive.
 *
 * The REAL work signal is the destination tile queue draining
 * (queueRatio, 0..1). The envelope guarantees four things the raw ratio
 * can't on its own:
 *   - a destination whose tiles are ALREADY resident (the picker camera has
 *     been staring at it; the queue never grows, ratio pinned at 0) still
 *     shows the bar climbing honestly through the minimum window instead of
 *     sitting dead at 0% and then jumping — 100% still arrives exactly when
 *     the minimum window ends,
 *   - an active queue drives the bar directly (its floor is capped below
 *     90%, so a stalled stream can't fake completion),
 *   - the phase always ends: hard cap at maxMs -> 100%,
 *   - and the moment never flashes by: nothing reaches 100 before minMs.
 */
export function preparingFlightProgress(queueRatio, elapsedMs, minMs = 3000, maxMs = 12000, queueEmpty = false) {
  const raw = Math.max(0, Math.min(1, Number(queueRatio) || 0));
  const t = Number.isFinite(elapsedMs) ? elapsedMs : 0;
  if (t >= maxMs) return 1;
  const windowFloor = minMs > 0 ? Math.min(0.9 * (t / minMs), 0.9) : 0;
  if (raw >= 1 || queueEmpty) {
    if (t >= minMs) return 1;
    return windowFloor;
  }
  return Math.max(raw, windowFloor);
}
