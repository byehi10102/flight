/**
 * Adaptive performance — the frame budget's controller.
 *
 * The game renders the same scene through THREE surfaces every frame: the
 * Cesium globe, the tactical minimap (a second Cesium viewer) and the Three.js
 * overlay. Two levers scale them:
 *
 *   1. tile DETAIL (the globe's maximumScreenSpaceError) — fewer/coarser
 *      tiles means less geometry, fewer fetches and less decode work. This is
 *      sacrificed FIRST: a struggling device is usually tile-bound, and coarse
 *      terrain beats a slideshow (the ordering worldflightsimulator.com ships:
 *      scenery first, then pixels).
 *   2. RESOLUTION (resolutionScale + the overlay's pixel ratio) — the lever
 *      that decides the frame rate on a fill-rate-bound GPU. Given back FIRST
 *      on recovery: sharpness returns before terrain detail does.
 *
 * How the decision is made (the parts that keep it honest):
 *
 *   - MEDIAN frame time per window, not the mean. Tile decode and terrain
 *     uploads land as occasional main-thread spikes; a mean is dragged up by
 *     them for the whole window and the controller sheds pixels for a problem
 *     the GPU never had.
 *   - Thresholds are RELATIVE TO THE DISPLAY. rAF is floored by vsync: on a
 *     60 Hz panel everything renders at ~16.7 ms even at 90% idle, so fixed
 *     millisecond thresholds ratchet one way. The fastest frame in the window
 *     estimates the vsync interval; "pinned at vsync" is the only honest
 *     headroom signal.
 *   - A severe overload (median > 2.5x vsync — think 2-5 fps) drops BOTH
 *     levers in the same window: at 300 ms frames a 0.85x shuffle per 1.5 s
 *     takes half a minute to matter.
 *   - A dead band between the thresholds means no oscillation, and decisions
 *     only land after a full sampling window.
 *
 * `decideFrameBudget` is pure so the rule is unit-testable.
 */

export const PERF_DEFAULTS = Object.freeze({
  minScale: 0.25,      // floor: 0.25x the pixels - deeper than before; at 2 fps
                       // a 0.6 floor was still too many pixels for the GPU
  maxScale: 1,
  stepDown: 0.8,
  stepUp: 1.1,
  highMs: 24,          // fallback ceiling when no vsync can be estimated
  lowMs: 13,           // fallback floor for "comfortably fast"
  windowMs: 1500,      // how long a verdict must hold before acting
  minFrames: 20,       // ignore windows with almost no frames in them
  // Terrain-detail sacrifice ladder (maximumScreenSpaceError). Index 0 must
  // equal the quality tier's shipped value; main.js passes the tier's ladder.
  sseLadder: [2, 4, 6],
});

/**
 * One adaptation decision. Pure: (current levers, window stats) -> next levers.
 *
 * @param {{scale: number, sseIndex: number}} current
 * @param {{medianMs: number, minMs: number}} stats   median + fastest frame of the window
 * @param {object} [opts]  PERF_DEFAULTS overrides
 * @returns {{scale: number, sseIndex: number, reason: string}}
 */
export function decideFrameBudget(current, stats, opts = {}) {
  const o = { ...PERF_DEFAULTS, ...opts };
  const scale = Number(current?.scale);
  const cur = Number.isFinite(scale) && scale > 0 ? scale : o.maxScale;
  const maxIdx = (o.sseLadder?.length || 1) - 1;
  let sseIndex = Math.max(0, Math.min(maxIdx, Number(current?.sseIndex) || 0));

  const median = Number(stats?.medianMs);
  const min = Number(stats?.minMs);
  if (!Number.isFinite(median) || median <= 0) return { scale: cur, sseIndex, reason: "no-data" };

  // Estimated vsync interval: the fastest frame we actually saw, clamped to a
  // sane 50-150 Hz band. Falls back to the fixed ceiling when nothing fast
  // was seen this window (a fully saturated device never produces one).
  const vsync = Number.isFinite(min) && min > 0 ? Math.max(6.5, Math.min(16.7, min)) : o.highMs;
  const downT = vsync * 1.5;                       // clearly missing the budget
  const upT = Math.max(o.lowMs, vsync * 1.08);     // pinned at vsync = headroom
  const severe = median > vsync * 2.5;             // 2-5 fps territory

  if (median > downT) {
    // Slow: detail first, then pixels. A severe window spends both at once.
    if (sseIndex < maxIdx) {
      sseIndex++;
      return severe
        ? { scale: Math.max(o.minScale, cur * o.stepDown), sseIndex, reason: "severe:detail+pixels" }
        : { scale: cur, sseIndex, reason: "detail" };
    }
    return { scale: Math.max(o.minScale, cur * o.stepDown), sseIndex, reason: "pixels" };
  }

  if (median < upT) {
    // Fast: recover in reverse — sharpness back before scenery does.
    if (cur < o.maxScale) {
      return { scale: Math.min(o.maxScale, cur * o.stepUp), sseIndex, reason: "sharpness" };
    }
    if (sseIndex > 0) return { scale: cur, sseIndex: sseIndex - 1, reason: "detail-back" };
  }

  return { scale: cur, sseIndex, reason: "hold" };
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
    // Where we are on the terrain-detail ladder (index into opts.sseLadder).
    this.sseIndex = 0;
    this.lastAvgMs = 0;
    this.lastReason = "start";
    this.samples = [];
    // Globe decimation level: 0 = render every rAF frame; N = render the
    // globe 1-in-(N+1) frames (its canvas holds the last frame in between).
    // Engaged when a window of globe-rendering frames has a median > 40 ms
    // (software-GL territory where no pixel/detail cut can buy the frame
    // back), released when fully-sharp settings hold an effective cadence
    // budget. While engaged the controller hill-climbs on the EFFECTIVE
    // frame cost, so capable machines settle sharp instead of blurry.
    this.globeSkip = 0;
    this._skipDwell = 0;
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
    const sorted = [...this.samples].sort((a, b) => a - b);
    this.samples.length = 0;
    this.sampleStart = nowMs;
    if (n < this.opts.minFrames) {
      // EMERGENCY SHED: at 1-5 fps a window holds only a handful of frames -
      // below minFrames, which made the controller fully inert on exactly the
      // machines that need shedding most (measured: 2 fps locked at scale 1.0
      // / SSE 4 forever). If the few frames we DID see are all extreme, act
      // on them immediately: straight to the floor. Recovery is normal -
      // fast windows step the quality back up.
      const med = sorted.length ? sorted[sorted.length >> 1] : 0;
      if (med > 150) {
        this.scale = this.opts.minScale;
        const ladder = this.opts.sseLadder || PERF_DEFAULTS.sseLadder;
        this.sseIndex = ladder.length - 1;
        this.lastReason = "emergency";
        this._shedCooldown = 10;
        this.globeSkip = 2;
        this.apply();
      }
      return this.scale;
    }

    const stats = {
      medianMs: sorted[n >> 1],
      minMs: sorted[0],
    };
    this.lastAvgMs = stats.medianMs;
    // Catastrophic window: engage globe decimation immediately (a shed is
    // always allowed, even mid-cooldown). Threshold sits ABOVE a healthy
    // vsync frame (~17 ms) and BELOW the decimated steady state (~78 ms
    // heavy frames at the floor), so once engaged it holds. Released further
    // down, only once the coast is clear.
    if (stats.medianMs > 40 && this.globeSkip !== 2) {
      this.globeSkip = 2;
      this._skipDwell = 10; // no release for 10 s: kills engage/release flapping
      this.lastReason = "globe-skip";
    }
    // Hysteresis: after shedding, block recovery for a dwell period so the
    // fps stabilises before quality is handed back. Without it the
    // controller oscillates: shed -> recover too fast -> overshoot -> shed.
    if (this._shedCooldown > 0) {
      this._shedCooldown -= this.opts.windowMs / 1000;
      // During cooldown: only shed further, never recover.
      if (stats.medianMs > 20) {
        const next2 = decideFrameBudget(
          { scale: this.scale, sseIndex: this.sseIndex },
          stats, this.opts,
        );
        if (next2.scale < this.scale || next2.sseIndex > this.sseIndex) {
          this.scale = next2.scale;
          this.sseIndex = next2.sseIndex;
          this.lastReason = next2.reason;
          this.apply();
        }
      }
      return this.scale;
    }
    // While decimated, the player feels the AVERAGE cadence, not the heavy
    // frame - so shed/climb on the effective frame cost and hill-climb toward
    // the SHARPEST settings the machine affords. The plain ladder gets stuck
    // here: its recovery needs a fast heavy-frame median, which never happens
    // on a shed machine, leaving players at the blurry floor forever even
    // when decimation left throughput to spare. Skipped frames cost ~8 ms
    // (overlay-only). Release requires FULL quality: at scale 1.0 with the
    // base SSE, handing the globe back is safe - if it was premature, the
    // engage rule (>40 ms) picks decimation back up after the dwell.
    if (this.globeSkip > 0) {
      if (this._skipDwell > 0) this._skipDwell -= this.opts.windowMs / 1000;
      const effective = (stats.medianMs + this.globeSkip * 8) / (this.globeSkip + 1);
      const maxIdx = (this.opts.sseLadder || PERF_DEFAULTS.sseLadder).length - 1;
      if (effective > 30) {
        // Too slow even decimated: shed one step, detail first.
        if (this.sseIndex < maxIdx) this.sseIndex++;
        else this.scale = Math.max(this.opts.minScale, this.scale * this.opts.stepDown);
        this.lastReason = "decimated-shed";
        this._shedCooldown = 5;
        this.apply();
      } else if (effective < 25) {
        // Headroom: climb one step toward sharpness (pixels first, then detail).
        if (this.scale < this.opts.maxScale - 0.005) {
          this.scale = Math.min(this.opts.maxScale, this.scale * this.opts.stepUp);
          this.lastReason = "decimated-climb";
          this.apply();
        } else if (this.sseIndex > 0) {
          this.sseIndex--;
          this.lastReason = "decimated-climb-detail";
          this.apply();
        } else if (this._skipDwell <= 0) {
          // Fully sharp and still cheap: hand the globe back to full rate.
          this.globeSkip = 0;
          this.lastReason = "globe-restore";
        }
      }
      return this.scale;
    }
    // Release globe decimation only on a genuinely healthy window (median
    // < 20 ms). While decimated, the median sits near ~33 ms on a software-GL
    // machine, so this cannot flap.
    if (stats.medianMs < 20 && this.globeSkip !== 0) {
      this.globeSkip = 0;
      this.lastReason = "globe-restore";
    }
    const next = decideFrameBudget(
      { scale: this.scale, sseIndex: this.sseIndex },
      stats,
      this.opts,
    );
    this.lastReason = next.reason;
    if (Math.abs(next.scale - this.scale) > 0.005 || next.sseIndex !== this.sseIndex) {
      if (next.scale < this.scale || next.sseIndex > this.sseIndex) {
        this._shedCooldown = 5; // dwell: no recovery for 5 s after a shed
      }
      this.scale = next.scale;
      this.sseIndex = next.sseIndex;
      this.apply();
    }
    return this.scale;
  }

  /** Push the current levers onto every surface that renders the world. */
  apply() {
    const s = this.scale;
    try {
      if (this.viewer) this.viewer.resolutionScale = s;
    } catch (e) { /* older Cesium */ }
    try {
      const ladder = this.opts.sseLadder || PERF_DEFAULTS.sseLadder;
      const sse = ladder[Math.min(this.sseIndex, ladder.length - 1)];
      const globe = this.viewer?.scene?.globe;
      // Only assign on change: each assignment makes Cesium re-evaluate LOD.
      if (globe && globe.maximumScreenSpaceError !== sse) globe.maximumScreenSpaceError = sse;
    } catch (e) { /* detail ladder is best-effort */ }
    try {
      const mv = this.getMiniViewer();
      // minimap stays sharp: 200 px, controller shedding does not apply
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

  /** Back to the tier's full quality: called when the player leaves flight
   *  for the menu or the spawn picker. The map-browsing screens must be CRISP
   *  (the shed resolution/detail is a flight-time trade — a picker browsed at
   *  0.5x resolution reads as "blurry" and coarse tiles read as unfinished),
   *  and the controller re-sheds within seconds of flight if it has to. */
  restoreFull() {
    this.scale = this.opts.maxScale ?? 1;
    this.sseIndex = 0;
    this.samples.length = 0;
    this.sampleStart = null;
    this.apply();
    return this.scale;
  }

  /** Devtest readout: what the controller currently believes. */
  report() {
    const ladder = this.opts.sseLadder || PERF_DEFAULTS.sseLadder;
    return {
      scale: +this.scale.toFixed(3),
      sse: ladder[Math.min(this.sseIndex, ladder.length - 1)],
      sseIndex: this.sseIndex,
      reason: this.lastReason,
      avgMs: +this.lastAvgMs.toFixed(2),
      fps: this.lastAvgMs > 0 ? +(1000 / this.lastAvgMs).toFixed(1) : null,
      enabled: this.enabled,
    };
  }
}
