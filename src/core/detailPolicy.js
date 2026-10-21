/**
 * Detail policy: how much imagery detail the jet can actually be served.
 *
 * A tile is 256 px. At 3000 mph (1341 m/s) the jet crosses Esri tiles at:
 *
 *   level 19 (76 m)    ~17.6 tiles/s per row
 *   level 17 (305 m)    ~4.4 tiles/s per row
 *   level 16 (610 m)    ~2.2 tiles/s per row
 *
 * With ~15 tile rows in view, level 19 at speed asks for ~250 requests per
 * second against a budget of 64. It can never arrive — and what the player
 * sees is exactly that: a coarse tile, then detail popping in late underneath
 * the jet. So detail follows speed: every tile when you are slow enough to
 * look at it, the level the pipe can serve when you are not, and the horizon
 * haze covers the difference in between.
 *
 * `imageryLevelForSpeed` is pure so the curve is unit-testable.
 */

export const DETAIL_POLICY = Object.freeze({
  // Below the "slow" speed: full detail, every tile.
  slowMph: 800,
  fullLevel: 19,
  // At the W ceiling: city-level detail that a 64-request pipe can hold.
  ceilingMph: 3000,
  ceilingLevel: 16,
  // In boost: coarser still — the ground is a blur at 7000 anyway.
  boostMph: 7000,
  boostLevel: 15,
  minLevel: 14, // never coarser than the DEM, or imagery and terrain fight
});

/**
 * @param {number} mph ground speed in mph
 * @param {object} [opts] DETAIL_POLICY overrides
 * @returns {number} the deepest imagery level worth requesting at this speed
 */
export function imageryLevelForSpeed(mph, opts = {}) {
  const p = { ...DETAIL_POLICY, ...opts };
  const v = Number(mph);
  if (!Number.isFinite(v) || v <= p.slowMph) return p.fullLevel;
  if (v >= p.boostMph) return p.boostLevel;
  // Two straight segments through (ceilingMph, ceilingLevel) so the W ceiling
  // lands exactly on a level instead of somewhere between two of them.
  let level;
  if (v <= p.ceilingMph) {
    const t = (v - p.slowMph) / (p.ceilingMph - p.slowMph);
    level = p.fullLevel + (p.ceilingLevel - p.fullLevel) * t;
  } else {
    const t = (v - p.ceilingMph) / (p.boostMph - p.ceilingMph);
    level = p.ceilingLevel + (p.boostLevel - p.ceilingLevel) * t;
  }
  const rounded = Math.floor(level);
  return Math.max(p.minLevel, Math.min(p.fullLevel, rounded));
}
