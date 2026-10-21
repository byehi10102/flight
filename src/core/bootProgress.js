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
 * Display ramp: walks the shown percent toward the real percent instead of
 * jumping straight there.
 *
 * Stage completion is CHUNKY by nature — a boot stage releases its whole
 * 15-25 point slice the instant it finishes — so a bar wired straight to
 * computeBootProgress reads "60 ... 80 ... 81" with long dead stops in
 * between. This ramp spreads each jump over the following moments:
 *
 *   - a bounded MINIMUM rate keeps the bar visibly moving even while the
 *     target sits still (a slow stage still reads as progress, not a freeze),
 *   - a proportional catch-up means a target far ahead is closed quickly,
 *     so the bar never lags a fast machine by much,
 *   - a bounded MAXIMUM rate stops a burst of finished stages (the first
 *     second releases Cesium + model + audio at once) from sprinting the
 *     bar to 60 and leaving it there,
 *   - it NEVER passes the target and never retreats, so the displayed value
 *     is always a true, honest lower bound of real work done,
 *   - per-step elapsed time is clamped so a backgrounded tab does not
 *     teleport the bar on the next paint.
 *
 * Pure and clock-free (the caller passes `now`); unit-tested.
 */
export class PercentRamp {
  /**
   * @param {{minRatePerMs?: number, maxRatePerMs?: number, gainPerMs?: number}} [opts]
   *   minRatePerMs: floor creep, percent per millisecond (0.005 = 5%/s)
   *   maxRatePerMs: ceiling on the climb, percent per millisecond (0.02 = 20%/s)
   *   gainPerMs: fraction of the remaining gap closed per millisecond
   */
  constructor({ minRatePerMs = 0.005, maxRatePerMs = 0.02, gainPerMs = 0.0045 } = {}) {
    this.minRatePerMs = minRatePerMs;
    this.maxRatePerMs = maxRatePerMs;
    this.gainPerMs = gainPerMs;
    this.value = 0;
    this._last = null;
  }

  /** Forget the ramp (new phase, or a deliberate reset like a failure). */
  reset(value = 0) {
    this.value = Number.isFinite(value) ? value : 0;
    this._last = null;
    return this.value;
  }

  /**
   * @param {number} target the highest percent real work justifies (>= shown)
   * @param {number} nowMs  now, e.g. performance.now()
   * @returns {number} the value to display
   */
  update(target, nowMs) {
    const goal = Number(target);
    if (!Number.isFinite(goal)) return this.value;
    if (this._last === null) {
      this._last = nowMs;
      return this.value;
    }
    const dtRaw = nowMs - this._last;
    this._last = nowMs;
    if (!(dtRaw > 0)) return this.value;
    const dt = Math.min(dtRaw, 1000);
    if (goal <= this.value) return this.value; // monotonic: never retreat
    // Proportional catch-up, but never faster than the ceiling: the early
    // stages land together (Cesium + model + audio = 40 points in under a
    // second), and without a ceiling the bar would sprint 12 -> 58 and then
    // crawl — the "super fast and then stop" shape this exists to remove.
    const step = Math.min(
      this.maxRatePerMs * dt,
      Math.max(this.minRatePerMs * dt, (goal - this.value) * this.gainPerMs * dt),
    );
    this.value = Math.min(goal, this.value + step);
    return this.value;
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
