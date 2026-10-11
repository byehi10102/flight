/**
 * Compass tape math — pure and unit-tested.
 *
 * The tape is a long horizontal strip of degree ticks laid out at
 * (deg + 360) * COMPASS_PX_PER_DEG pixels (the +360 keeps negative wrap
 * degrees on the strip; createCompass() in hud.js builds ticks from
 * -360..+720 the same way). To show a given heading under the strip's
 * center index, translate the tape by:
 *
 *   translateX = -(heading + 360) * pxPerDeg + containerWidth / 2
 *
 * No DOM, no Cesium — hud.js owns the elements, this owns the arithmetic.
 */

export const COMPASS_PX_PER_DEG = 4;

/**
 * Horizontal translateX (px) that centers `headingDeg` in a tape viewport
 * `containerWidth` px wide.
 *
 * @param {number} headingDeg current heading in degrees (0..360, fractional ok)
 * @param {number} containerWidth visible tape width in px
 * @param {number} [pxPerDeg] tape density, px per degree
 */
export function tapeOffsetPx(headingDeg, containerWidth, pxPerDeg = COMPASS_PX_PER_DEG) {
  return -(headingDeg + 360) * pxPerDeg + containerWidth / 2;
}
