/**
 * Real 3D buildings, streamed from OpenFreeMap.
 *
 * ── Why this source ────────────────────────────────────────────────────────
 * The OpenMapTiles `building` layer carries a real `render_height` per
 * footprint (metres, derived from OSM `height` / `building:levels`). A single
 * z14 tile over Midtown Manhattan returns 1,488 buildings and every one has a
 * height. It is free, needs no key and no signup. That last point is what
 * makes the whole project work without credentials.
 *
 * ── Geometry ───────────────────────────────────────────────────────────────
 * One footprint becomes one `GeometryInstance`; all footprints in a tile are
 * handed to a single `Primitive`, so Cesium batches them into one draw call.
 * Each building is a `PolygonGeometry` extruded from its `render_min_height`
 * to its `render_height` — real OSM values, not guesses, where they exist.
 *
 * ── Terrain-relative placement ──────────────────────────────────────────────
 * Building heights are *relative to the ground*, but `PolygonGeometry` works
 * in absolute ellipsoid height. Sampling terrain for every footprint centroid
 * before building the geometry is what stops towers from being buried on a
 * hillside or floating over a valley.
 */
import {
  Cartographic,
  Color,
  ColorGeometryInstanceAttribute,
  GeometryInstance,
  HeightReference,
  MaterialAppearance,
  PolygonGeometry,
  PolygonHierarchy,
  Primitive,
  Cartesian3,
  sampleTerrainMostDetailed,
} from "cesium";
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import { CONFIG } from "../core/config.js";
import { facadeMaterials, facadeVariant, destroyFacadeMaterials } from "./facades.js";

const TILE_EXTENT_FALLBACK = 4096;

/** Resolve the current tile template so a future tile-set re-cut can't break us. */
let tileTemplatePromise = null;
function tileTemplate() {
  if (!tileTemplatePromise) {
    tileTemplatePromise = fetch(CONFIG.buildings.tileJson)
      .then((r) => r.json())
      .then((j) => {
        const t = j.tiles?.[0];
        if (!t) throw new Error("OpenFreeMap TileJSON has no tiles[] entry");
        return t;
      })
      .catch((error) => {
        tileTemplatePromise = null;
        throw error;
      });
  }
  return tileTemplatePromise;
}

const wrapX = (x, n) => ((x % n) + n) % n;

/**
 * Tile-local integer coords → lon/lat.
 *
 * This is the exact inverse of the tile-picking maths in `update()`, which
 * uses the standard Web Mercator form:
 *
 *   x = ((lon + 180) / 360) * n
 *   y = ((1 - asinh(tan(lat)) / π) / 2) * n
 *
 * so the inverse must be the algebraic inverse of those, not a
 * metres-per-pixel scaling. Getting this wrong is silent and total: the
 * previous version returned longitudes in the tens of thousands of degrees,
 * every footprint then failed the |lon| <= 181 sanity check, and the tile
 * quietly produced zero buildings.
 */
function tileToLonLat(px, py, extent, tx, ty, n) {
  const lon = ((tx + px / extent) / n) * 360 - 180;
  const mercY = Math.PI * (1 - (2 * (ty + py / extent)) / n);
  const lat = (Math.atan(Math.sinh(mercY)) * 180) / Math.PI;
  return [lon, lat];
}

/**
 * Palette: the OSM `colour` tag when the mapper supplied one, otherwise a
 * plausible facade tone derived from the building's own height, so a skyline
 * reads as a skyline (low blocks warm and solid, towers cool and glassy).
 */
function colorFor(props, height) {
  const named = props.colour;
  if (typeof named === "string" && named.length) {
    const c = Color.fromCssColorString(named);
    if (c) return c;
  }
  const t = props.building;
  if (t === "church" || t === "cathedral" || t === "chapel")
    return Color.fromCssColorString("#b9ad96");
  if (t === "industrial" || t === "warehouse" || t === "factory")
    return Color.fromCssColorString("#8d8f8a");
  if (t === "retail" || t === "commercial")
    return Color.fromCssColorString("#a8998b");
  if (height > 70) return Color.fromCssColorString("#8fa3b4");
  if (height > 24) return Color.fromCssColorString("#a3aab2");
  return Color.fromCssColorString("#b5aa9b");
}

function resolveHeight(props) {
  const h = Number(props.render_height);
  if (Number.isFinite(h) && h > 0) return h;
  const levels = Number(props["building:levels"] || props.levels);
  if (Number.isFinite(levels) && levels > 0) return levels * 3.1;
  const t = props.building;
  if (t === "church" || t === "cathedral") return 20;
  if (t === "industrial" || t === "warehouse") return 12;
  if (t === "commercial" || t === "office") return 18;
  if (t === "retail") return 9;
  if (t === "apartments") return 16;
  if (t === "house" || t === "residential" || t === "detached") return 7;
  return 9;
}

function resolveMinHeight(props) {
  const m = Number(props.render_min_height);
  return Number.isFinite(m) && m > 0 ? m : 0;
}

/** Shoelace area of a lon/lat ring, in square degrees. Zero means degenerate. */
function ringArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

/**
 * Normalise a vector-tile point to `[x, y]`.
 *
 * `@mapbox/vector-tile` v2's `loadGeometry()` returns points as plain objects,
 * `{ x, y }` — not `[x, y]` arrays. Destructuring them as arrays yields
 * `undefined` for both components, every derived lon/lat becomes NaN, and the
 * range check below then rejects every footprint, so the tile silently yields
 * zero buildings. Accept either shape so the decoder survives either version.
 */
function pointToXY(p) {
  if (Array.isArray(p)) return p;
  if (p && typeof p.x === "number" && typeof p.y === "number") return [p.x, p.y];
  return null;
}

/** Keep exterior rings and drop interior holes. */
function exteriorRings(geom) {
  const out = [];
  for (const ring of geom) {
    let area = 0;
    let valid = true;
    for (let i = 0; i < ring.length; i++) {
      const a = pointToXY(ring[i]);
      const b = pointToXY(ring[(i + 1) % ring.length]);
      if (!a || !b) {
        valid = false;
        break;
      }
      area += a[0] * b[1] - b[0] * a[1];
    }
    if (!valid) continue;
    // MVT ring winding: the exterior ring is the one with the opposite sign
    // to its holes. In tile space (y grows downward) that is a positive
    // shoelace sum; interiors come out negative and are dropped.
    if (area > 0) out.push(ring.map(pointToXY).filter(Boolean));
  }
  return out;
}

export class BuildingLayer {
  constructor(viewer) {
    this.viewer = viewer;
    this.primitives = new Map();
    this.pending = new Set();
    // Tiles we have already resolved to "no buildings here". Without this the
    // streaming loop re-fetches an empty rural tile every cadence forever,
    // which is pure waste. This is what makes a flight over open country cheap.
    this.emptyTiles = new Set();
    // Total footprints actually turned into geometry. Exposed so the claim
    // "real 3D buildings" is a number we can measure, not just assert.
    this.buildingCount = 0;
    this.inFlight = 0;
    // OpenFreeMap is a free public service and it rate-limits (HTTP 429) if you
    // pull too hard. Two tiles in flight plus a minimum gap between requests
    // keeps a flyover well inside that budget; a 429 backs off and retries.
    this.maxInFlight = 2;
    this.lastRequestAt = 0;
    // 350 ms between tile requests. A z14 city tile is ~700 KB, so pulling
    // more than ~3/s is both rude to a free public service and enough to trip
    // its 429 limiter. The gap costs nothing: the streamer runs continuously.
    this.minRequestGapMs = 450;
    this.backoffUntil = 0;
    // Tallest extrusions so far, so correctness can be checked against
    // published building heights rather than assumed.
    this.tallest = [];
    this.credit = document.createElement("a");
    this.credit.href = "https://openfreemap.org/";
    this.credit.textContent = "Buildings © OpenStreetMap contributors (OpenFreeMap)";
    this.credit.target = "_blank";
    this.credit.rel = "noopener";
    viewer.creditContainer?.appendChild(this.credit);
  }

  _band(altitudeAgl) {
    const b = CONFIG.buildings;
    if (altitudeAgl > b.maxAltitude) return null;
    // Close to the ground we want the most detail; higher up, coarser tiles.
    const zoom = altitudeAgl < 1400 ? b.levels[0] : b.levels[1];
    return { zoom, radius: b.radius };
  }

  update(lat, lon, altitudeAgl) {
    const band = this._band(altitudeAgl);
    if (!band) {
      if (this.primitives.size) this._clear();
      return;
    }
    const n = 2 ** band.zoom;
    const latRad = (lat * Math.PI) / 180;
    const x = ((lon + 180) / 360) * n;
    const y = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n;
    // How many tiles cover `radius` metres, at this latitude and zoom.
    //
    // One tile spans 360/n degrees. So:
    //   tiles = (metres / metresPerDegree) * (n / 360)
    // Dividing by 360 matters: multiplying degrees by the raw tile count n
    // instead of n/360 makes the grid 360× too wide, which streams tiles
    // thousands of kilometres away and never loads the ones under the
    // aircraft.
    const mPerDegLon = 111320 * Math.max(0.2, Math.cos(latRad));
    const tileSpan = 360 / n; // degrees per tile
    // dX/dY are tiles per `band.radius` ring-step (600 m), multiplied by the
    // radius again below to size the grid.
    const dX = Math.ceil(600 / mPerDegLon / tileSpan);
    const dY = Math.ceil(600 / 111320 / tileSpan);
    const x0 = Math.floor(x - dX * band.radius);
    const x1 = Math.floor(x + dX * band.radius);
    const y0 = Math.floor(y - dY * band.radius);
    const y1 = Math.floor(y + dY * band.radius);

    const wanted = new Set();
    for (let tx = x0; tx <= x1; tx++)
      for (let ty = y0; ty <= y1; ty++)
        wanted.add(`${band.zoom}/${tx}/${ty}`);

    for (const [key, primitive] of this.primitives) {
      const [z, tx, ty] = key.split("/").map(Number);
      if (z !== band.zoom || tx < x0 || tx > x1 || ty < y0 || ty > y1) {
        this.viewer.scene.primitives.remove(primitive);
        this.primitives.delete(key);
      }
    }
    for (const key of wanted) {
      if (this.primitives.has(key) || this.pending.has(key)) continue;
      if (this.emptyTiles.has(key)) continue;
      if (this.inFlight >= this.maxInFlight) continue;
      const [z, tx, ty] = key.split("/").map(Number);
      this._load(key, z, tx, ty);
    }
  }

  async _load(key, z, tx, ty) {
    // Respect the request gap and any active 429 backoff before touching the
    // network. Skipping (rather than waiting) keeps the frame loop free.
    const now = performance.now();
    if (now < this.backoffUntil || now - this.lastRequestAt < this.minRequestGapMs) return;
    this.lastRequestAt = now;

    this.pending.add(key);
    this.inFlight++;
    try {
      const template = await tileTemplate();
      const url = template
        .replace("{z}", String(z))
        .replace("{x}", String(wrapX(tx, 2 ** z)))
        .replace("{y}", String(ty));
      const res = await fetch(url);
      if (res.status === 429) {
        // Rate limited. Don't mark the tile empty — it does have buildings,
        // we just asked too fast. Stop the stream and retry later.
        this.backoffUntil = performance.now() + 8000;
        this.minRequestGapMs = Math.min(this.minRequestGapMs * 2, 2000);
        console.warn("[buildings] rate limited (429); backing off 8s");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      const tile = new VectorTile(new Pbf(buf));
      const layer = tile.layers.building;
      if (!layer || !layer.length) {
        this.emptyTiles.add(key);
        return;
      }
      // One primitive per facade variant present in this tile.
      const built = await this._buildPrimitive(layer, z, tx, ty);
      if (built && built.length) {
        for (const primitive of built) this.viewer.scene.primitives.add(primitive);
        this.primitives.set(key, built);
      } else {
        this.emptyTiles.add(key);
      }
    } catch (error) {
      // One bad tile must never break the sim.
      console.warn(`[buildings] ${key}: ${error.message}`);
      if (!window.__facadeTraced) {
        window.__facadeTraced = true;
        console.error(`[buildings] first failure stack for ${key}:`, error && error.stack);
      }
    } finally {
      this.pending.delete(key);
      this.inFlight--;
    }
  }

  async _buildPrimitive(layer, z, tx, ty) {
    const extent = layer.extent || TILE_EXTENT_FALLBACK;
    const n = 2 ** z;
    const candidates = [];
    const centroids = [];

    for (let i = 0; i < layer.length; i++) {
      let feature;
      try {
        feature = layer.feature(i);
      } catch {
        continue;
      }
      const rings = exteriorRings(feature.loadGeometry());
      if (!rings.length) continue;
      const outer = rings[0];
      if (outer.length < 3) continue;

      const props = feature.properties || {};
      const height = resolveHeight(props);
      if (height < 1.5) continue; // skip map-only outlines

      const lonlats = outer.map(([px, py]) => tileToLonLat(px, py, extent, tx, ty, n));
      // Reject rings whose vertices are wildly out of range — a decoding
      // glitch here would otherwise produce geometry spanning the planet.
      if (!lonlats.every(([lo, la]) => Math.abs(lo) <= 181 && Math.abs(la) <= 85))
        continue;
      // Reject degenerate rings. A ring whose points are collinear or
      // coincident encloses no area, so the extruded volume has no extent and
      // Cesium derives a bounding sphere with a NaN radius — which propagates
      // into the command list and aborts the render loop. One collapsed
      // footprint in a 1 500-building tile is enough to take the screen down.
      if (Math.abs(ringArea(lonlats)) < 1e-9) continue;

      candidates.push({ lonlats, height, minHeight: resolveMinHeight(props), color: colorFor(props, height) });
      const mid = lonlats[Math.floor(lonlats.length / 2)];
      centroids.push(Cartographic.fromDegrees(mid[0], mid[1]));
      // Centroid, for verification against known buildings.
      candidates[candidates.length - 1].lon = mid[0];
      candidates[candidates.length - 1].lat = mid[1];
    }
    if (!candidates.length) return null;

    // One terrain sample for the whole tile, so buildings sit on the ground
    // rather than at ellipsoid zero. Two safety nets: a timeout, because a
    // DEM provider that never settles would otherwise hold a load slot
    // forever (there are only a few), and a zero fallback, which matches
    // Cesium's own behaviour of drawing on the globe when no DEM is present.
    let ground = 0;
    try {
      const sampled = await Promise.race([
        sampleTerrainMostDetailed(
          this.viewer.terrainProvider,
          centroids.slice(0, 120),
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("terrain sample timeout")), 6000),
        ),
      ]);
      const heights = sampled
        .map((s) => s.height)
        .filter((h) => Number.isFinite(h));
      if (heights.length) {
        ground = heights.reduce((a, b) => a + b, 0) / heights.length;
      }
    } catch {
      ground = 0;
    }

    // Group the tile's footprints by facade variant.
    //
    // A `MaterialAppearance` carries exactly one material, so the four
    // variants (office / residential / brick / glass) have to be separate
    // primitives. Without this every building in the city gets the same
    // pattern, and with a single flat colour per building — which is what it
    // used to do — the whole skyline reads as solid colour blocks.
    const buckets = [[], [], [], []];
    for (const c of candidates) {
      const positions = c.lonlats.map(([lo, la]) => Cartesian3.fromDegrees(lo, la, 0));
      try {
        const geometry = new PolygonGeometry({
          polygonHierarchy: new PolygonHierarchy(positions),
          height: ground + c.minHeight,
          extrudedHeight: ground + c.height,
          // POSITION_ONLY. `MaterialAppearance` derives its own lighting
          // from the material and the face normal, and it needs the ST
          // texture coordinates to place the facade. It rejects anything
          // else here.
          vertexFormat: MaterialAppearance.VERTEX_FORMAT,
          granularity: Math.PI / 180,
        });
        const variant = facadeVariant(
          (c.lon * 733 + c.lat * 977) | 0,
          c.height,
        );
        buckets[variant].push(
          new GeometryInstance({
            geometry,
            // Per-building tint still rides along on the instance and is
            // multiplied over the facade, so OSM `colour` tags still tint
            // their building without erasing the window detail.
            attributes: { color: ColorGeometryInstanceAttribute.fromColor(c.color) },
          }),
        );
      } catch {
        // Self-intersecting ring — skip this building, keep the tile.
      }
    }

    const instances = buckets.flat();
    if (!instances.length) return null;

    this.buildingCount += instances.length;

    // Record what was actually extruded, so correctness can be checked against
    // published building heights rather than assumed. Capped: this is a
    // verification aid, not a cache.
    for (const c of candidates) {
      if (c.height < 20) continue;
      this.tallest.push({
        lon: +c.lon.toFixed(6),
        lat: +c.lat.toFixed(6),
        h: +c.height.toFixed(1),
        base: +(ground + c.minHeight).toFixed(1),
        ground: +ground.toFixed(1),
      });
    }
    this.tallest.sort((a, b) => b.h - a.h);
    this.tallest.length = Math.min(this.tallest.length, 3000);

    // One primitive per non-empty variant.
    const materials = facadeMaterials();
    const out = [];
    for (let v = 0; v < buckets.length; v++) {
      if (!buckets[v].length) continue;
      out.push(
        new Primitive({
          geometryInstances: buckets[v],
          appearance: new MaterialAppearance({
            material: materials[v],
            // Lit by the sun, so massing reads as solid geometry.
            flat: false,
            translucent: false,
            closed: false,
          }),
          // Built on the main thread: these are cheap relative to the terrain
          // and imagery, and synchronous construction keeps the primitive's
          // bounding volume valid from the frame it is added.
          asynchronous: false,
          allowPicking: false,
          compressVertices: true,
          releaseGeometryInstances: true,
        }),
      );
    }
    return out;
  }

  _clear() {
    for (const list of this.primitives.values()) {
      for (const primitive of list) this.viewer.scene.primitives.remove(primitive);
    }
    this.primitives.clear();
  }

  destroy() {
    this._clear();
    this.credit.remove();
    // The facade texture is shared by every building primitive, so it outlives
    // any individual tile. Only tear it down when the layer itself goes.
    destroyFacadeMaterials();
  }
}

export { VectorTile, Pbf, tileToLonLat, resolveHeight, colorFor };
