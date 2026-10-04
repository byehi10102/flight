/**
 * Remote aircraft rendering in the 3D world.
 *
 * ── How remote motion is reconstructed ────────────────────────────────────
 * Packets arrive on an irregular schedule (network jitter, frame timing), so
 * applying each one directly makes a plane stutter, and correcting toward the
 * newest packet makes it rubber-band. Instead this file keeps a short history
 * of snapshots per peer and renders each plane a fixed 120 ms in the PAST,
 * interpolating between the two snapshots that bracket that instant.
 *
 * Why the fixed delay: to interpolate you must have a snapshot on both sides
 * of the render time. Rendering slightly behind the newest packet guarantees
 * that, and absorbs jitter up to the delay. The result is continuous motion
 * with no jitter, no rubber-banding and no corrective lag — a plane flying
 * toward you closes the distance at the true rate instead of appearing to
 * hang, and two planes flying the same heading hold formation smoothly.
 *
 * If packets stall, the plane keeps moving by extrapolating the last known
 * velocity for a short while (so a brief gap does not look like a freeze),
 * then holds until data resumes. It never snaps.
 *
 * Orientation: Cesium's HeadingPitchRoll frame uses +Y as forward in its
 * internal Z-up space, and a glTF model whose nose is -Z becomes +Y after
 * Cesium's Y-up -> Z-up conversion — which is exactly this game's F-15, so
 * no yaw correction is needed (verified numerically before implementation).
 *
 * This file loads RAW (outside the app bundler), so Cesium and tunables
 * arrive through createRemotePlanes(ctx) instead of bare imports.
 */

const MPH_TO_MPS = 0.44704;
/** Render remote planes this far behind the newest packet. */
const INTERP_DELAY_MS = 120;
/** Keep pushing along the last velocity through a gap this long, then hold. */
const MAX_EXTRAP_MS = 400;
/** Snapshots older than this (relative to the newest) are dropped. */
const SNAPSHOT_TTL_MS = 1200;
const MODEL_URI = "models/f-15.glb";
const LABEL_NEAR_M = 3000;
const LABEL_FAR_M = 20000000;
const FADE_OUT_S = 3;

let Cesium = null;

/** Wire up the host app's Cesium namespace and return a new instance. */
export function createRemotePlanes(ctx) {
  Cesium = ctx.Cesium;
  return new RemotePlanes(ctx.viewer, ctx.worldSpeedScale);
}

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Wrap a longitude difference into (-180, 180]. */
function wrapDeg(d) {
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

const lerp = (a, b, f) => a + (b - a) * f;
const lerpAngle = (a, b, f) => a + wrapDeg(b - a) * f;

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

export class RemotePlanes {
  constructor(viewer, worldSpeedScale) {
    this.viewer = viewer;
    this.worldSpeedScale = worldSpeedScale;
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

  /** Last rendered (interpolated) position, for the minimap / distance readouts. */
  getLive(peerId) {
    const p = this.planes.get(peerId);
    if (!p || !p.live) return null;
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
      snaps: [],
      live: null,
      /** localTime - senderTime for this peer (clock skew + min latency). */
      offset: null,
      clocked: false,
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

  /**
   * Append an authoritative packet to the peer's history.
   *
   * The snapshot is keyed by the SENDER's clock (`data.ts`), not the arrival
   * time. Arrival time carries network jitter, and interpolating along a
   * jittery timeline re-introduces exactly the stutter we are removing. The
   * sender's clock is regular, so we estimate the offset between the two
   * clocks (skew + minimum latency) and interpolate along the sender's
   * timeline instead.
   *
   * `recvMs` defaults to the local clock; the harness passes a simulated time.
   */
  setState(peerId, data, recvMs = nowMs()) {
    const plane = this.ensure(peerId);
    const hasTs = typeof data.ts === "number" && Number.isFinite(data.ts);
    if (hasTs) {
      // Track the minimum observed offset: latency only ever adds, so the
      // minimum is the closest estimate of the true clock difference. Let it
      // creep upward slowly so slow drift is followed.
      const inst = recvMs - data.ts;
      plane.offset = plane.offset == null ? inst : (inst < plane.offset ? inst : plane.offset + 0.5);
      plane.clocked = true;
    }
    const t = hasTs ? data.ts : recvMs;
    const snap = {
      t,
      lon: data.lon,
      lat: data.lat,
      alt: data.alt,
      h: data.h,
      p: data.p,
      r: data.r,
      v: data.v,
      fly: data.fly ? 1 : 0,
    };
    plane.snaps.push(snap);

    // Keep the history bounded: everything we might still render, plus the
    // newest packet as the extrapolation seed.
    const oldest = snap.t - SNAPSHOT_TTL_MS;
    while (plane.snaps.length > 2 && plane.snaps[0].t < oldest) plane.snaps.shift();
    if (plane.snaps.length > 240) plane.snaps.splice(0, plane.snaps.length - 240);

    if (!plane.live) {
      plane.live = snap;
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
   * Sample a peer's path at time `t`. Interpolates between the bracketing
   * snapshots, extrapolates short gaps from the newest one, otherwise holds.
   */
  _sample(plane, t) {
    const s = plane.snaps;
    if (!s.length) return plane.live;
    if (s.length === 1 || t <= s[0].t) return s[0];

    const last = s[s.length - 1];
    if (t >= last.t) {
      const ahead = Math.min(t - last.t, MAX_EXTRAP_MS);
      if (ahead <= 0 || !last.fly) return last;
      const mps = last.v * MPH_TO_MPS * this.worldSpeedScale;
      const np = movePosition(last.lon, last.lat, last.alt, last.h, last.p, mps * (ahead / 1000));
      return { t, lon: np.lon, lat: np.lat, alt: np.alt, h: last.h, p: last.p, r: last.r, v: last.v, fly: last.fly };
    }

    for (let i = s.length - 2; i >= 0; i--) {
      if (s[i].t <= t) {
        const a = s[i];
        const b = s[i + 1];
        const span = b.t - a.t;
        const f = span > 0 ? Math.max(0, Math.min(1, (t - a.t) / span)) : 0;
        return {
          t,
          lon: wrapDeg(a.lon + wrapDeg(b.lon - a.lon) * f),
          lat: lerp(a.lat, b.lat, f),
          alt: lerp(a.alt, b.alt, f),
          h: lerpAngle(a.h, b.h, f),
          p: lerp(a.p, b.p, f),
          r: lerp(a.r, b.r, f),
          v: lerp(a.v, b.v, f),
          fly: b.fly,
        };
      }
    }
    return s[0];
  }

  /**
   * Advance every remote plane. Called once per rendered frame — remote motion
   * is presentation, not simulation, so it uses wall-clock time.
   */
  update(dt, atMs = nowMs()) {
    if (!this.planes.size) return;

    for (const [peerId, plane] of [...this.planes.entries()]) {
      if (plane.leaving) {
        plane.fadeT -= dt;
        if (plane.fadeT <= 0) {
          this._dispose(peerId);
          continue;
        }
      }

      if (!plane.snaps.length) continue;
      // Render a fixed delay behind the newest data. Clocked peers are on the
      // sender's timeline (so network jitter cannot distort the path); peers
      // without a timestamp fall back to the local arrival timeline.
      const base = plane.clocked && plane.offset != null ? atMs - plane.offset : atMs;
      const pose = this._sample(plane, base - INTERP_DELAY_MS);
      if (!pose) continue;
      plane.live = pose;

      try {
        if (plane.entity) {
          const position = Cesium.Cartesian3.fromDegrees(pose.lon, pose.lat, pose.alt);
          const hpr = new Cesium.HeadingPitchRoll(
            Cesium.Math.toRadians(pose.h),
            Cesium.Math.toRadians(pose.p),
            Cesium.Math.toRadians(pose.r)
          );
          plane.entity.position = position;
          plane.entity.orientation = Cesium.Transforms.headingPitchRollQuaternion(position, hpr);
          if (plane.leaving) {
            plane.entity.model.color = plane.colour.withAlpha(Math.max(0, plane.fadeT / FADE_OUT_S));
          }
        }
        if (plane.labelEntity) {
          plane.labelEntity.position = Cesium.Cartesian3.fromDegrees(pose.lon, pose.lat, pose.alt);
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
