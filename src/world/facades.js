/**
 * Procedural building facades.
 *
 * ── Why ────────────────────────────────────────────────────────────────────
 * Extruded OSM footprints in a single flat colour look like a blockout, not a
 * city. Windows are the single biggest cue that a box is a building, and they
 * are also the thing that survives being looked at from a moving aeroplane.
 *
 * ── Why not a texture ──────────────────────────────────────────────────────
 * The obvious approach is a canvas atlas uploaded as a Cesium `Texture`, and
 * it does not work here. In Cesium 1.145 a `Texture` exposes no public
 * `.texture` getter, so `uniforms.image` ends up `undefined` and material
 * construction throws "Cannot read properties of undefined (reading 'type')".
 * The per-tile error handler in the building loader swallowed that, and the
 * result was 116 buildings counted, zero primitives built, and a skyline of
 * nothing — with no visible error anywhere.
 *
 * So the window grid is computed analytically in the fabric shader instead.
 * That needs no GPU texture, no rendering context, no atlas and no mip
 * handling, and it has a bonus: window size is defined in METRES of wall, so a
 * window is the same real size on a shed and on a skyscraper, and it stays
 * crisp however far away the building is.
 *
 * ── How the coordinates work ───────────────────────────────────────────────
 * Cesium's extruded polygon UVs run in METRES along each wall: u along the
 * wall, v vertically from the base. Dividing by the floor height makes v count
 * floors, and `fract()` of that makes each floor a unit cell. u needs dividing
 * by a window pitch to make window columns. Everything after that is `step()`.
 */

import { Cartesian2, Cartesian3, Color, Material } from "cesium";

/** Real-world floor-to-floor height, metres. */
const FLOOR_HEIGHT = 3.5;

/**
 * Four facade archetypes.
 *
 * `MaterialAppearance` carries exactly one material, so a tile's footprints are
 * grouped by archetype and each group becomes its own primitive. Without the
 * grouping every building in the city gets the same pattern, which is its own
 * kind of blockout.
 */
const FACADES = [
  {
    name: "office",
    wall: [0.60, 0.61, 0.63],
    glass: [0.20, 0.30, 0.40],
    windowPitch: 3.0, // metres between window centres
    windowWidth: 1.9,
    windowHeight: 1.7,
    band: 0.0, // horizontal spandrel band between floors
  },
  {
    name: "residential",
    wall: [0.72, 0.67, 0.60],
    glass: [0.26, 0.30, 0.34],
    windowPitch: 4.2,
    windowWidth: 1.5,
    windowHeight: 1.4,
    band: 0.0,
  },
  {
    name: "brick",
    wall: [0.48, 0.28, 0.23],
    glass: [0.16, 0.18, 0.20],
    windowPitch: 3.4,
    windowWidth: 1.1,
    windowHeight: 1.5,
    band: 0.12, // pronounced masonry banding
  },
  {
    name: "glass",
    wall: [0.42, 0.52, 0.58],
    glass: [0.52, 0.68, 0.76],
    windowPitch: 2.0,
    windowWidth: 1.75,
    windowHeight: 2.6,
    band: 0.0,
  },
];

/** Number of archetypes; the bucket index in buildings.js must match. */
export const FACADE_COUNT = FACADES.length;

/**
 * Pick an archetype for a building.
 *
 * Deterministic from the footprint's own coordinates, so a given building keeps
 * its facade across reloads and neighbouring buildings do not all match. Taller
 * buildings lean towards the office and glass archetypes, which is both a
 * reasonable real-world correlation and visually useful — the skyline gets
 * lighter as it rises.
 *
 * @param {number} seed  Stable per-footprint integer.
 * @param {number} height Extruded height, metres.
 * @returns {number} Index into FACADES.
 */
export function facadeVariant(seed, height) {
  const h = (seed ^ (seed >>> 16)) >>> 0;
  if (height >= 60) return (h & 1) === 0 ? 0 : 3; // office or glass
  if (height >= 25) return (h % 3) === 0 ? 0 : 1; // office or residential
  return (h % 4) === 0 ? 2 : 1; // brick or residential
}

/**
 * The fabric source.
 *
 * One window cell per floor per `uWindowPitch` metres of wall. `uInset` keeps
 * the window off the corner of each cell so the wall between windows reads as
 * masonry, and `uBand` darkens the spandrel strip at each floor line, which is
 * what makes a brick elevation look like courses rather than a checkerboard.
 */
/**
 * The fabric source.
 *
 * Deliberately free of GLSL comments. Cesium's fabric parser tokenises the
 * source string and does not understand `//`, so a comment inside this literal
 * is a syntax error ("`.` : syntax error") that surfaces as "Rendering has
 * stopped" and takes the whole scene down. The explanation lives here, in
 * JavaScript, where it cannot break the shader.
 *
 * Which declarations belong here and which do not:
 *
 *   * `MaterialAppearance`'s fragment header already supplies `czm_material`,
 *     `czm_diffuse`, `czm_specular`, `czm_emission` and the `color` uniform.
 *     Redeclaring any of them fails to compile.
 *   * `czm_materialInput` is the exception: the header does NOT supply it, and
 *     omitting it fails with "materialInput : undeclared identifier".
 *
 * The maths: extruded polygon UVs run in METRES along each wall, u along the
 * wall and v up from the base. Dividing v by the floor height makes it count
 * floors; `fract()` turns each floor into a unit cell. u is divided by the
 * window pitch to make window columns. Everything after that is `step()`.
 *
 * Because the cells are defined in metres of wall, a window is the same real
 * size on a shed and on a skyscraper and stays crisp at any distance — which a
 * fixed-resolution texture atlas cannot do.
 */
const FACADE_SOURCE = `
uniform vec2 uWindowPitch;
uniform vec2 uWindowSize;
uniform float uBand;
uniform vec3 uWall;
uniform vec3 uGlass;

czm_material czm_getMaterial(czm_materialInput mi) {
  float floors = mi.st.y / ${FLOOR_HEIGHT.toFixed(2)};
  float cols = mi.st.x / uWindowPitch.x;
  float fy = fract(floors);
  float fx = fract(cols);
  float wx = step(0.5 - uWindowSize.x * 0.5, fx) * step(fx, 0.5 + uWindowSize.x * 0.5);
  float wy = step(0.5 - uWindowSize.y * 0.5, fy) * step(fy, 0.5 + uWindowSize.y * 0.5);
  float win = wx * wy;
  float edge = min(fy, 1.0 - fy);
  float band = uBand * (1.0 - step(0.18, edge));
  czm_material m;
  m.diffuse = mix(uWall * (1.0 - band), uGlass, win);
  m.alpha = 1.0;
  return m;
}
`;

let materialCache = null;

/**
 * The shared facade materials, built once and reused everywhere.
 *
 * No rendering context is needed, and none is accepted: a `Texture`-based
 * version of this took one and that is precisely what broke.
 */
export function facadeMaterials() {
  if (materialCache) return materialCache;
  materialCache = FACADES.map((f) => {
    const [r, g, b] = f.wall;
    const [gr, gg, gb] = f.glass;
    return new Material({
      fabric: {
        uniforms: {
          uWindowPitch: new Cartesian2(f.windowPitch, 1),
          // Window size as a fraction of its cell.
          uWindowSize: new Cartesian2(f.windowWidth / f.windowPitch, f.windowHeight / FLOOR_HEIGHT),
          uBand: f.band,
          // `vec3` uniforms need Cartesian3 values. Passing Cartesian2 here
          // silently binds a 2-component vector to a 3-component uniform.
          uWall: new Cartesian3(r, g, b),
          uGlass: new Cartesian3(gr, gg, gb),
          color: Color.WHITE,
        },
        source: FACADE_SOURCE,
      },
    });
  });
  return materialCache;
}

/** Free the shared materials when the layer goes away. */
export function destroyFacadeMaterials() {
  if (!materialCache) return;
  for (const m of materialCache) m.destroy();
  materialCache = null;
}
