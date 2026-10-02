import * as Cesium from "cesium";

/**
 * Remote aircraft rendering in the 3D world.
 *
 * At 10,000 mph a jet covers ~650 m between 12 Hz packets, so raw positions
 * would visibly teleport. Instead every remote plane is dead-reckoned
 * forward each frame using the same movement math the local sim uses
 * (heading/pitch/speed), and each arriving packet only gently corrects the
 * accumulated drift over ~300 ms. Heading/pitch/roll are exact from the
 * packet, so a head-on pass reads as a head-on pass on both screens; only
 * along-track position can differ by a few hundred metres mid-pass.
 *
 * Orientation: Cesium's HeadingPitchRoll frame uses +Y as forward in its
 * internal Z-up space, and a glTF model whose nose is -Z becomes +Y after
 * Cesium's Y-up -> Z-up conversion — which is exactly this game's F-15, so
 * no yaw correction is needed (verified numerically before implementation).
 */

const MPH_TO_MPS = 0.44704;
const WORLD_SPEED_SCALE = 1.8;
/** Drift correction time constant: a packet's error is ~63% gone in this. */
const CORRECTION_TAU = 0.3;
const MODEL_URI = "models/f-15.glb";
const LABEL_NEAR_M = 3000;
const LABEL_FAR_M = 20000000;
const FADE_OUT_S = 3;

function movePosition(lon, lat, alt, heading, pitch, distance) {
  const headingRad = Cesium.Math.toRadians(heading);
  const pitchRad = Cesium.Math.toRadians(pitch);
  const R = 6371000;
  const dLat = (distance * Math.cos(headingRad) * Math.cos(pitchRad)) / R;
  const dLon =
    (distance * Math.sin(headingRad) * Math.cos(pitchRad)) /
    (R * Math.cos(Cesium.Math.toRadians(lat)));
  const dAlt = distance * Math.sin(pitchRad);
  return {
    lon: lon + Cesium.Math.toDegrees(dLon),
    lat: lat + Cesium.Math.toDegrees(dLat),
    alt: alt + dAlt,
  };
}

/** Shortest signed angular difference a -> b, in degrees. */
function shortestAngle(a, b) {
  let d = b - a;
  while (d < -180) d += 360;
  while (d > 180) d -= 360;
  return d;
}

export class RemotePlanes {
  constructor(viewer) {
    this.viewer = viewer;
    /** peerId -> plane record */
    this.planes = new Map();
    this._palette = [
      Cesium.Color.fromCssColorString("#ff6a3d"),
      Cesium.Color.fromCssColorString("#3da5ff"),
      Cesium.Color.fromCssColorString("#ffd23d"),
      Cesium.Color.fromCssColorString("#9b6aff"),
      Cesium.Color.fromCssColorString("#3dffa5"),
      Cesium.Color.fromCssColorString("#ff3d9b"),
    ];
    this._colourIndex = 0;
  }

  _nextColour() {
    const c = this._palette[this._colourIndex % this._palette.length];
    this._colourIndex++;
    return c;
  }

  /** Is this peer currently rendered? */
  has(peerId) {
    return this.planes.has(peerId);
  }

  /** World position of a peer (for minimap / distance readouts). */
  getLive(peerId) {
    const p = this.planes.get(peerId);
    if (!p) return null;
    return { lon: p.live.lon, lat: p.live.lat, alt: p.live.alt, heading: p.live.h, v: p.live.v };
  }

  /** Create (or revive) the entity for a peer. */
  ensure(peerId, callsign) {
    let plane = this.planes.get(peerId);
    if (plane) {
      plane.leaving = false;
      plane.fadeT = 0;
      if (callsign) plane.callsign = callsign;
      return plane;
    }

    const colour = this._nextColour();
    plane = {
      callsign: callsign || "PILOT",
      colour,
      live: null,
      target: null,
      leaving: false,
      fadeT: 0,
      entity: null,
      labelEntity: null,
      visible: false,
    };

    try {
      plane.entity = this.viewer.entities.add({
        show: false,
        model: {
          uri: MODEL_URI,
          color: colour,
          minimumPixelSize: 48,
          maximumScale: 40000,
          silhouetteColor: Cesium.Color.BLACK,
          silhouetteSize: 1.0,
        },
      });
      plane.labelEntity = this.viewer.entities.add({
        show: false,
        label: {
          text: plane.callsign,
          font: "600 13px Consolas, monospace",
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          fillColor: colour,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -28),
          // Name tags only read as useful at range: hidden up close where
          // the aircraft itself is clearly visible.
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(LABEL_NEAR_M, LABEL_FAR_M),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    } catch (e) {
      plane.entity = null;
      plane.labelEntity = null;
    }

    this.planes.set(peerId, plane);
    return plane;
  }

  setCallsign(peerId, callsign) {
    const plane = this.planes.get(peerId);
    if (!plane || !callsign) return;
    plane.callsign = callsign;
    try {
      if (plane.labelEntity) plane.labelEntity.label.text = new Cesium.ConstantProperty(callsign);
    } catch (e) { /* label is cosmetic */ }
  }

  /** Fold an authoritative packet in as the correction target. */
  setState(peerId, data) {
    const plane = this.ensure(peerId);
    const target = {
      lon: data.lon,
      lat: data.lat,
      alt: data.alt,
      h: data.h,
      p: data.p,
      r: data.r,
      v: data.v,
      fly: !!data.fly,
    };
    plane.target = target;
    // First packet: snap (nothing to interpolate from).
    if (!plane.live) {
      plane.live = { ...target };
      plane.visible = true;
      try {
        if (plane.entity) plane.entity.show = true;
        if (plane.labelEntity) plane.labelEntity.show = true;
      } catch (e) { /* cosmetic */ }
    }
  }

  /** Begin the leave animation (plane fades, then is removed). */
  remove(peerId) {
    const plane = this.planes.get(peerId);
    if (!plane) return;
    plane.leaving = true;
    plane.fadeT = FADE_OUT_S;
  }

  /** Hard-remove every peer (leaving multiplayer, respawn, new location). */
  clear() {
    for (const peerId of [...this.planes.keys()]) this._dispose(peerId);
    this.planes.clear();
  }

  _dispose(peerId) {
    const plane = this.planes.get(peerId);
    if (!plane) return;
    try {
      if (plane.entity) this.viewer.entities.remove(plane.entity);
      if (plane.labelEntity) this.viewer.entities.remove(plane.labelEntity);
    } catch (e) { /* already gone */ }
    plane.entity = null;
    plane.labelEntity = null;
    this.planes.delete(peerId);
  }

  /**
   * Advance every remote plane. Called once per rendered frame (not per
   * sim substep) — remote motion is presentation, not simulation.
   */
  update(dt) {
    if (!this.planes.size) return;

    for (const [peerId, plane] of [...this.planes.entries()]) {
      if (plane.leaving) {
        plane.fadeT -= dt;
        if (plane.fadeT <= 0) {
          this._dispose(peerId);
          continue;
        }
      }

      const live = plane.live;
      const target = plane.target;
      if (!live || !target) continue;

      // 1. Dead-reckon forward along the last known vector.
      if (live.fly !== false) {
        const mps = live.v * MPH_TO_MPS * WORLD_SPEED_SCALE;
        if (mps > 0.01) {
          const next = movePosition(live.lon, live.lat, live.alt, live.h, live.p, mps * dt);
          live.lon = next.lon;
          live.lat = next.lat;
          live.alt = next.alt;
        }
      }

      // 2. Ease toward the authoritative packet (exponential, framerate
      //    independent) instead of snapping.
      const k = 1 - Math.exp(-dt / CORRECTION_TAU);
      let dLon = shortestAngle(live.lon, target.lon);
      live.lon += dLon * k;
      while (live.lon > 180) live.lon -= 360;
      while (live.lon < -180) live.lon += 360;
      live.lat += (target.lat - live.lat) * k;
      live.alt += (target.alt - live.alt) * k;
      live.h += shortestAngle(live.h, target.h) * k;
      live.p += (target.p - live.p) * k;
      live.r += (target.r - live.r) * k;
      live.v += (target.v - live.v) * k;
      live.fly = target.fly;

      // 3. Push to the Cesium entity.
      try {
        if (plane.entity) {
          const position = Cesium.Cartesian3.fromDegrees(live.lon, live.lat, live.alt);
          const hpr = new Cesium.HeadingPitchRoll(
            Cesium.Math.toRadians(live.h),
            Cesium.Math.toRadians(live.p),
            Cesium.Math.toRadians(live.r)
          );
          plane.entity.position = position;
          plane.entity.orientation = Cesium.Transforms.headingPitchRollQuaternion(position, hpr);
          if (plane.leaving) {
            plane.entity.model.color = plane.colour.withAlpha(Math.max(0, plane.fadeT / FADE_OUT_S));
          }
        }
        if (plane.labelEntity) {
          plane.labelEntity.position = Cesium.Cartesian3.fromDegrees(live.lon, live.lat, live.alt);
          if (plane.leaving) {
            plane.labelEntity.label.fillColor = plane.colour.withAlpha(
              Math.max(0, plane.fadeT / FADE_OUT_S)
            );
          }
        }
      } catch (e) { /* a bad frame must not break flight */ }
    }
  }
}
