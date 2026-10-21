/**
 * Adaptive performance — the frame budget's thermostat.
 *
 * The game renders the same scene through THREE surfaces every frame: the
 * Cesium globe, the tactical minimap (a second Cesium viewer) and the Three.js
 * overlay. Pixel count is the one lever that scales ALL of them at once, and
 * it is the lever that decides the frame rate on a fill-rate-bound GPU (weak
 * integrated chips, phones, anything with a 2-4 M-pixel framebuffer).
 *
 * So the game measures its own frame time and trades resolution for smoothness
 * when it has to, then hands the pixels back when it can:
 *
 *   - steady 20 ms+ frames  -> resolution scale steps down (never below
 *     `min`, so the picture stays legible),
 *   - frames comfortably under budget -> it steps back up toward full,
 *   - a dead band in between -> no change (no oscillation around the border),
 *   - decisions only after a full sampling window, so one janky frame or one
 *     tile-upload hitch never moves the needle.
 *
 * The tiers in quality.js stay untouched: this is a runtime response to the
 * actual frame, not a second opinion about the device.
 *
 * `stepResolutionScale` is pure so the decision is unit-testable.
 */

export const PERF_DEFAULTS = Object.freeze({
  minScale: 0.6,       // floor: 0.6^2 = 36% of the pixels, still legible
  maxScale: 1,
  stepDown: 0.85,
  stepUp: 1.06,
  highMs: 24,          // slower than this on average -> want more headroom
  lowMs: 13,           // faster than this on average -> can afford detail
  windowMs: 1500,      // how long a verdict must hold before acting
  minFrames: 20,       // ignore windows with almost no frames in them
});

/**
 * One adaptation step. Pure: (current scale, mean frame time) -> next scale.
 *
 * @param {number} current current resolution scale
 * @param {number} avgMs   mean frame time across the window, milliseconds
 * @param {object} [opts]  PERF_DEFAULTS overrides
 * @returns {number} the next scale, clamped to [minScale, maxScale]
 */
export function stepResolutionScale(current, avgMs, opts = {}) {
  const o = { ...PERF_DEFAULTS, ...opts };
  const cur = Number.isFinite(current) && current > 0 ? current : o.maxScale;
  const ms = Number(avgMs);
  let next = cur;
  if (Number.isFinite(ms)) {
    if (ms > o.highMs) next = cur * o.stepDown;
    else if (ms < o.lowMs) next = cur * o.stepUp;
  }
  return Math.max(o.minScale, Math.min(o.maxScale, next));
}

export class AdaptivePerformance {
  /**
   * @param {{viewer: object, renderer: object, getMiniViewer?: () => object|null,
   *          getPixelRatioCap?: () => number, opts?: object}} args
   */
  constructor({ viewer, renderer, getMiniViewer = () => null, getPixelRatioCap = () => Infinity, opts = {} }) {
    this.viewer = viewer;
    this.renderer = renderer;
    this.getMiniViewer = getMiniViewer;
    this.getPixelRatioCap = getPixelRatioCap;
    this.opts = { ...PERF_DEFAULTS, ...opts };

    this.enabled = true;
    this.scale = 1;
    this.lastAvgMs = 0;
    this.samples = [];
    // null, not 0: a legitimate first timestamp of exactly 0 must not read as
    // "no window started yet" (it would restart the window every frame).
    this.sampleStart = null;
  }

  /** While the loading films own the screen the render loop is throttled on
   *  purpose — measuring it there would collapse the resolution for good. */
  setEnabled(on) {
    const next = !!on;
    if (next && !this.enabled) {
      // Re-arm from a clean slate: the frames that were being skipped are not
      // evidence about the GPU.
      this.samples.length = 0;
      this.sampleStart = null;
    }
    this.enabled = next;
  }

  /** Feed one real frame. `frameMs` is wall-clock time between paints. */
  sample(frameMs, nowMs = performance.now()) {
    if (!this.enabled) return this.scale;
    const ms = Number(frameMs);
    if (!Number.isFinite(ms) || ms <= 0 || ms > 1000) return this.scale;
    if (this.sampleStart === null) this.sampleStart = nowMs;
    this.samples.push(ms);
    if (nowMs - this.sampleStart < this.opts.windowMs) return this.scale;

    const n = this.samples.length;
    const avg = n > 0 ? this.samples.reduce((a, b) => a + b, 0) / n : 0;
    this.samples.length = 0;
    this.sampleStart = nowMs;
    this.lastAvgMs = avg;
    if (n < this.opts.minFrames) return this.scale;

    const next = stepResolutionScale(this.scale, avg, this.opts);
    if (Math.abs(next - this.scale) > 0.005) {
      this.scale = next;
      this.apply();
    }
    return this.scale;
  }

  /** Push the current scale onto every surface that renders the world. */
  apply() {
    const s = this.scale;
    try {
      if (this.viewer) this.viewer.resolutionScale = s;
    } catch (e) { /* older Cesium */ }
    try {
      const mv = this.getMiniViewer();
      if (mv) mv.resolutionScale = s;
    } catch (e) { /* minimap is cosmetic */ }
    try {
      // The overlay canvas is full-screen and transparent: the browser pays
      // to composite every pixel of it, so it scales with everything else.
      // `window` is probed rather than assumed so this module also runs (and
      // is tested) outside a browser.
      const deviceDpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
      const dpr = Math.min(deviceDpr, this.getPixelRatioCap());
      this.renderer.setPixelRatio(Math.max(1, dpr * s));
    } catch (e) { /* overlay resize is best-effort */ }
  }

  /** Devtest readout: what the thermostat currently believes. */
  report() {
    return {
      scale: +this.scale.toFixed(3),
      avgMs: +this.lastAvgMs.toFixed(2),
      fps: this.lastAvgMs > 0 ? +(1000 / this.lastAvgMs).toFixed(1) : null,
      enabled: this.enabled,
    };
  }
}
