/**
 * Real 3D runways, draped on the terrain.
 *
 * ── Where the geometry comes from ──────────────────────────────────────────
 * Every runway rectangle is built from the OurAirports record: the two
 * threshold coordinates, the true bearing, the length and the width. The
 * rectangle's long axis runs threshold→threshold, so the runway you see is at
 * the real position, on the real bearing, with the real dimensions.
 *
 * ── Why we use GroundPolylineGeometry and not PolygonGeometry ──────────────
 * A `PolygonGeometry` is defined in absolute ellipsoid height. A runway at
 * Seattle sits at ~130 m elevation; a polygon placed at height 0.6 is buried
 * 130 m underground, which with `depthTestAgainstTerrain` is invisible and
 * produces degenerate bounds. `GroundPolylineGeometry` is *defined* as
 * conforming to the terrain, so the runway follows hills, sits on the real
 * surface, and needs no elevation lookup at all. That is the correct primitive
 * for a runway, and it is why the aircraft can be placed on it.
 *
 * A runway is a thick polyline down the centreline, plus threshold bars at
 * each end and a centreline stripe — exactly how it is painted in reality.
 */
import {
  Cartographic,
  Color,
  ColorGeometryInstanceAttribute,
  GroundPolylineGeometry,
  GeometryInstance,
  PerInstanceColorAppearance,
  Primitive,
  Cartographic as Carto,
} from "cesium";

const M_PER_DEG = 111320;
const FT = 0.3048;

/** A coordinate we are willing to build geometry from. */
function validCoord(v) {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 180;
}

function destination(lat, lon, bearingRad, distanceM) {
  const dLat = (Math.cos(bearingRad) * distanceM) / M_PER_DEG;
  const dLon =
    (Math.sin(bearingRad) * distanceM) /
    (M_PER_DEG * Math.cos((lat * Math.PI) / 180));
  return [lat + dLat, lon + dLon];
}

/** Runway endpoints in metres, plus its true bearing. */
function runwayEnds(runway) {
  const bearing = (runway.heading * Math.PI) / 180;
  return {
    from: [runway.lat, runway.lon],
    to: [runway.endLat, runway.endLon],
    bearing,
    lengthM: runway.length * FT,
    widthM: runway.width * FT,
  };
}

const SURFACE_COLORS = {
  ASPH: "#3a3d42",
  "ASPH-G": "#3a3d42",
  "ASPH-F": "#3a3d42",
  "ASPH-P": "#3a3d42",
  CONC: "#6a6c6e",
  "CONC-G": "#6a6c6e",
  GRASS: "#556b3f",
  "GRASS-P": "#556b3f",
  TURF: "#4e6338",
  GRAVEL: "#7a7264",
  SAND: "#b0a184",
  WATER: "#22485c",
  EARTH: "#6b604d",
  UNK: "#45484d",
};

export class RunwayLayer {
  constructor(viewer) {
    this.viewer = viewer;
    this.primitives = [];
    this.built = new Set();
    this.index = null;
  }

  update(lat, lon, altitudeAgl) {
    if (!this.index) return;
    // Runways are cheap to draw and useful at any altitude; cap the radius so
    // we never attempt to draw a continent.
    const radius = altitudeAgl > 15000 ? 150000 : 80000;
    const near = this.index.near(lat, lon, radius, 8);
    for (const { airport } of near) {
      this._build(airport);
    }

    // Evict what we have flown away from.
    //
    // This is not just a memory concern. A `GroundPolylineGeometry` primitive
    // is *terrain-conforming*: its bounds are resolved against the terrain
    // tiles resident when it was created. Accumulate those primitives across a
    // long flight and the terrain tiles they were fitted to get released,
    // leaving stale ground primitives whose bounds no longer resolve — which
    // surfaces as a NaN command and kills Cesium's render loop with
    // "RangeError: Failed to set the 'length' property on 'Array'".
    const keep = new Set(near.map((n) => n.airport.id));
    for (let i = this.primitives.length - 1; i >= 0; i--) {
      const entry = this.primitives[i];
      if (keep.has(entry.airport.id)) continue;
      this.viewer.scene.primitives.remove(entry.primitive);
      this.primitives.splice(i, 1);
      this.built.delete(entry.airport.id);
    }
  }

  _build(airport) {
    if (this.built.has(airport.id)) return;
    this.built.add(airport.id);
    const instances = [];

    for (const runway of airport.runways) {
      // Reject anything with a non-finite or out-of-range coordinate before it
      // reaches the geometry pipeline. A single NaN here produces a degenerate
      // bounding sphere, and Cesium's command culling then aborts the entire
      // render loop with "RangeError: Failed to set the 'length' property on
      // 'Array'" — one bad record taking down every frame on screen.
      if (!validCoord(runway.lat) || !validCoord(runway.lon)) continue;
      if (!validCoord(runway.endLat) || !validCoord(runway.endLon)) continue;
      if (!Number.isFinite(runway.length) || runway.length < 30) continue;
      if (!Number.isFinite(runway.width) || runway.width <= 0) continue;
      if (!Number.isFinite(runway.heading)) continue;

      // A polyline whose endpoints coincide has no extent, so Cesium computes a
      // degenerate bounding sphere for it. That NaN propagates into the command
      // list and kills the render loop, so reject coincident thresholds here.
      const dLatDeg = runway.endLat - runway.lat;
      const dLonDeg = runway.endLon - runway.lon;
      const spanM =
        Math.hypot(
          dLatDeg * 111320,
          dLonDeg * 111320 * Math.cos((runway.lat * Math.PI) / 180),
        ) || 0;
      if (spanM < 5) continue;

      const ends = runwayEnds(runway);
      if (ends.lengthM < 30) continue; // helipads, ignore
      const surface = (runway.surface || "UNK").toUpperCase();
      const surfaceColor = Color.fromCssColorString(
        SURFACE_COLORS[surface] || SURFACE_COLORS.UNK,
      );

      // The runway surface: a polyline as wide as the strip, from threshold
      // to threshold, draping over whatever terrain is underneath.
      instances.push(
        this._strip(
          [ends.from, ends.to],
          Math.max(12, ends.widthM),
          surfaceColor,
        ),
      );

      // Painted centreline: a narrow white stripe down the middle.
      const inner = insetEndpoints(ends, 60);
      instances.push(this._strip([inner.from, inner.to], 2.2, Color.fromCssColorString("#e8e4d8")));

      // Threshold bars at each end, perpendicular to the centreline.
      for (const [end, sign] of [
        [ends.from, 1],
        [ends.to, -1],
      ]) {
        const back = destination(end[0], end[1], ends.bearing + Math.PI, 25);
        const perp = ends.bearing + (Math.PI / 2) * sign;
        const left = destination(back[0], back[1], perp, ends.widthM * 0.4);
        const right = destination(back[0], back[1], perp + Math.PI, ends.widthM * 0.4);
        instances.push(
          this._strip([left, right], 4, Color.fromCssColorString("#e8e4d8"), 1.2),
        );
      }
    }

    if (!instances.length) return;
    const primitive = new Primitive({
      geometryInstances: instances,
      appearance: new PerInstanceColorAppearance({
        flat: true,
        translucent: true,
        closed: false,
      }),
      asynchronous: true,
      allowPicking: false,
      releaseGeometryInstances: true,
    });
    this.viewer.scene.primitives.add(primitive);
    this.primitives.push({ airport, primitive });
  }

  _strip(coords, width, color, offset = 0) {
    const positions = coords.map(([lat, lon]) =>
      Cartographic.fromDegrees(lon, lat),
    );
    const geometry = new GroundPolylineGeometry({
      positions,
      width: width + offset,
      // Granularity is an ANGLE IN RADIANS, not a tile count. Cesium defaults
      // to 0.25 rad; passing 6 is treated as ~6 rad of arc and generates a
      // degenerate, uncompilable shader. 0.12 rad ≈ 7 km of arc per segment,
      // smooth enough for a runway without flooding the vertex count.
      granularity: 0.12,
      offset,
    });
    return new GeometryInstance({
      geometry,
      attributes: { color: ColorGeometryInstanceAttribute.fromColor(color) },
    });
  }

  destroy() {
    for (const { primitive } of this.primitives) {
      this.viewer.scene.primitives.remove(primitive);
    }
    this.primitives = [];
    this.built.clear();
  }
}

/** Pull both endpoints in by `metres` along the runway axis. */
function insetEndpoints(ends, metres) {
  const from = destination(ends.from[0], ends.from[1], ends.bearing, metres);
  const to = destination(ends.to[0], ends.to[1], ends.bearing + Math.PI, metres);
  return { from, to };
}

export { M_PER_DEG, destination, runwayEnds, insetEndpoints };
