/** Real 3D buildings from Re:Earth's open 3D Tiles layer.

 * ── Why ────────────────────────────────────────────────────────────────────
 * The OpenFreeMap extrusion layer (buildings.js) produces real *heights* and
 * real *footprints* but the buildings are still extruded boxes with procedural
 * window shaders — shapes, not buildings. The user's complaint is exactly this:
 * "it isn't real buildings, it's just shapes coming out of the ground."
 *
 * Re:Earth serves a global 3D Tiles 1.1 tileset derived from Overture Maps
 * building data. It provides real 3D building geometry — actual roof shapes,
 * varying heights, structural detail — streamed on demand with Cesium's native
 * LOD and frustum culling. It is free, keyless, account-free, billing-free.
 *
 * ── Fallback ────────────────────────────────────────────────────────────────
 * If the tileset fails to load (network error, CORS, service outage) the project
 * falls back to the OSM extrusion layer so buildings are always shown somewhere.
 * The 3D Tiles load asynchronously at startup; when they resolve the OSM layer
 * is disabled and its primitives cleared.
 *
 * ── Honest assessment ───────────────────────────────────────────────────────
 * Re:Earth Buildings are real 3D geometry, but they are NOT photogrammetric
 * captures. They are derived from map data, not aerial photography. Roof shapes
 * and structural detail are real (from OSM), but surface texture is procedural.
 * This is the best keyless global option; anything photogrammetric (Google
 * Photorealistic 3D Tiles, Cesium ion) requires an API key with billing.
 */

import { Cesium3DTileset } from "cesium";

const TILESET_URL = "https://buildings.reearth.land/tileset.json";

export class Buildings3DTiles {
  constructor(viewer) {
    this.viewer = viewer;
    this.tileset = null;
    this.loaded = false;
    this.error = null;
    this.credit = document.createElement("a");
    this.credit.href = "https://buildings.reearth.land/";
    this.credit.target = "_blank";
    this.credit.rel = "noopener";
    this.credit.textContent = "3D Buildings: Re:Earth / Overture Maps (ODbL)";
  }

  /** Load the tileset and add it to the scene. Returns the tileset or null. */
  async load() {
    try {
      this.tileset = await Cesium3DTileset.fromUrl(TILESET_URL, {
        skipLevelOfDetail: true,
        cullWithChildrenBounds: true,
        dynamicScreenSpaceError: true,
        dynamicScreenSpaceErrorDensity: 0.0025,
        dynamicScreenSpaceErrorFactor: 4.0,
        maximumScreenSpaceError: 1.0,
      });
      this.viewer.scene.primitives.add(this.tileset);
      this.viewer.creditContainer?.appendChild(this.credit);
      this.loaded = true;
      return this.tileset;
    } catch (error) {
      this.error = error;
      console.warn(
        "[buildings-3dtiles] Re:Earth 3D Tiles unavailable:",
        error.message,
      );
      return null;
    }
  }

  /** Remove the tileset from the scene and the credit from the container. */
  destroy() {
    if (this.tileset) {
      this.viewer.scene.primitives.remove(this.tileset);
      this.tileset = null;
    }
    this.credit.remove();
    this.loaded = false;
  }
}
