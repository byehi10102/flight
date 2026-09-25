/**
 * Accurate ground elevation.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * `globe.getHeight()` answers "how high is the terrain *of the tile that
 * happens to be resident*". Near the ground that is exact. Looking down from
 * altitude, Cesium has only a coarse z0–z2 tile loaded, and getHeight then
 * returns a bilinear interpolation between vertices that can be hundreds of
 * kilometres apart — it reported −5 931 m at the summit of Everest, because
 * every loaded vertex nearby was a lowland one.
 *
 * Using that number to place an aircraft, to offset building bases, or to
 * decide when the wheels touch ground buries or levitates the world. So
 * anything that must be *correct* goes through `sampleTerrainMostDetailed`,
 * which fetches the finest tiles the provider has and caches the answer.
 *
 * The cache is keyed on a ~110 m grid, which is far finer than the DEM's own
 * resolution at flying altitudes and keeps a flyover to a handful of fetches.
 */
import { Cartographic, sampleTerrainMostDetailed, Cartesian3 } from "cesium";

/** ~110 m cells. Finer than the 90 m / 30 m DEM postings, coarse enough to cache. */
const CELL_DEG = 0.001;

export class GroundSampler {
  constructor(viewer) {
    this.viewer = viewer;
    this.cache = new Map();
    this.inFlight = new Set();
  }

  _key(lat, lon) {
    return `${Math.round(lat / CELL_DEG)}:${Math.round(lon / CELL_DEG)}`;
  }

  /**
   * Best known height right now. Prefers an accurate cached sample, falls
   * back to the resident-tile approximation, and finally to `fallback`.
   */
  get(lat, lon, fallback = 0) {
    const hit = this.cache.get(this._key(lat, lon));
    if (typeof hit === "number" && Number.isFinite(hit)) return hit;

    try {
      const h = this.viewer.scene.globe.getHeight(
        Cartographic.fromDegrees(lon, lat),
      );
      if (typeof h === "number" && Number.isFinite(h)) return h;
    } catch {
      /* no resident tile */
    }
    return fallback;
  }

  /**
   * Queue an accurate sample. Safe to call every frame: duplicate and
   * in-flight cells are ignored, and the result lands in the cache for
   * `get()` to pick up on a later frame.
   */
  request(lat, lon) {
    const key = this._key(lat, lon);
    if (this.cache.has(key) || this.inFlight.has(key)) return;
    this.inFlight.add(key);

    sampleTerrainMostDetailed(this.viewer.terrainProvider, [
      Cartographic.fromDegrees(lon, lat),
    ])
      .then((result) => {
        const h = result?.[0]?.height;
        if (typeof h === "number" && Number.isFinite(h)) this.cache.set(key, h);
      })
      .catch(() => {
        /* provider unavailable — the fallback path covers it */
      })
      .finally(() => this.inFlight.delete(key));
  }

  /** Prime the cache for a whole set of points in one round trip. */
  async seed(points) {
    const cells = [];
    const seen = new Set();
    for (const [lat, lon] of points) {
      const key = this._key(lat, lon);
      if (this.cache.has(key) || seen.has(key)) continue;
      seen.add(key);
      cells.push({ key, carto: Cartographic.fromDegrees(lon, lat) });
    }
    if (!cells.length) return;
    try {
      const results = await sampleTerrainMostDetailed(
        this.viewer.terrainProvider,
        cells.map((c) => c.carto),
      );
      results.forEach((r, i) => {
        const h = r?.height;
        if (typeof h === "number" && Number.isFinite(h))
          this.cache.set(cells[i].key, h);
      });
    } catch {
      /* fallbacks cover the gap */
    }
  }

  clear() {
    this.cache.clear();
  }
}

export { Cartesian3 };
