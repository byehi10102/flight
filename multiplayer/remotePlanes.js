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
/** Keep pushing along the last known velocity through a gap this long, then
 *  hold. Generous on purpose: a throttled or backgrounded tab can drop to
 *  ~1 packet per second, and a short window would leave the other plane
 *  hovering between packets instead of flying. With a steady velocity the
 *  extrapolation and the next interpolation agree, so extending it costs no
 *  rubber-banding — it only means a crashed peer coasts a moment longer
 *  before the presence sweep removes it.
 */
const MAX_EXTRAP_MS = 2000;
/** Snapshots older than this (relative to the newest) are dropped. */
const SNAPSHOT_TTL_MS = 1200;
const MODEL_URI = "models/f-15.glb";
const LABEL_NEAR_M = 3000;
const LABEL_FAR_M = 20000000;
const FADE_OUT_S = 3;
/**
 * Smooth-correction engagement (DIS "lie gently"): sampled poses within
 * SMOOTH_EPS_M of what is already displayed apply instantly (normal
 * interpolation gains ZERO added latency); a larger discontinuity — a
 * post-stall catch-up or a threshold-triggered burst correction — converges
 * at SMOOTH_RATE_PER_S so the fix reads as flight, never a teleport.
 */
const SMOOTH_EPS_M = 30;
const SMOOTH_RATE_PER_S = 6;

import {
  drStep,
  estimateRates,
  convergeStep,
  adaptiveDelay,
  wrapDeg as netmathWrapDeg,
} from "./netmath.js";

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

  /** Diagnostics (?devtest): per-peer netcode counters. */
  stats() {
    const out = {};
    for (const [peerId, p] of this.planes.entries()) {
      out[peerId] = { ...p.stats };
    }
    return out;
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
      shown: null,
      /** localTime - senderTime for this peer (clock skew + min latency). */
      offset: null,
      clocked: false,
      /** Adaptive interp window inputs: EWMA packet interval + jitter. */
      intervalEwma: null,
      jitterEwma: null,
      interpDelayMs: 100,
      /** Diagnostics (?devtest): what the netcode is actually doing. */
      stats: { packets: 0, underruns: 0, lastCorrectionM: 0, jitterMs: 0, delayMs: 100 },
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
          minimumPixelSize: 64,
          maximumScale: 40000,
          silhouetteColor: Cesium.Color.BLACK,
          silhouetteSize: 1.5,
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
      // minimum is the closest estimate of the true clock difference. Real
      // clock drift is well under 1 ms/min, so the upward creep is tiny —
      // the old +0.5/packet added ~0.9 s of phantom skew PER MINUTE and
      // slowly pushed the render point seconds into the past ("the other
      // plane is not really moving").
      const inst = recvMs - data.ts;
      plane.offset = plane.offset == null ? inst : (inst < plane.offset ? inst : plane.offset + 0.005);
      plane.clocked = true;

      // Adaptive interpolation window (Source cl_interp behaviour): size
      // the render delay from the sender's actual packet interval plus the
      // measured network jitter, so a maneuver burst tightens the buffer
      // while a jittery link deepens it instead of stuttering.
      const prevSnap = plane.snaps[plane.snaps.length - 1];
      if (prevSnap) {
        const interval = data.ts - prevSnap.t;
        if (interval > 0 && interval < 5000) {
          plane.intervalEwma = plane.intervalEwma == null
            ? interval
            : plane.intervalEwma * 0.8 + interval * 0.2;
        }
        const jitter = Math.max(0, inst - plane.offset);
        plane.jitterEwma = plane.jitterEwma == null
          ? jitter
          : plane.jitterEwma * 0.8 + jitter * 0.2;
        plane.interpDelayMs = adaptiveDelay(plane.intervalEwma, plane.jitterEwma);
      }
      plane.stats.packets++;
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
   * Coast along a snapshot's last known velocity AND turn rates — the
   * shared netmath drStep (full airframe: heading, pitch, roll and speed
   * rates), so a banking plane extrapolates along its curved path and a
   * rolling/diving one keeps accelerating between packets. Used when the
   * render time has run past the newest sample — INCLUDING the very first
   * one, which is what keeps a plane moving from the moment it appears.
   */
  _coast(snap, aheadMs, plane) {
    const ahead = Math.min(aheadMs, MAX_EXTRAP_MS);
    if (ahead <= 0 || !snap.fly) return snap;
    let rates = { hr: 0, pr: 0, rr: 0, vr: 0 };
    if (plane && plane.snaps.length >= 2) {
      const s = plane.snaps;
      rates = estimateRates(s[s.length - 2], s[s.length - 1]);
    }
    return drStep(snap, rates, ahead, this.worldSpeedScale);
  }

  /**
   * Sample a peer's path at time `t`. Interpolates between the bracketing
   * snapshots, coasts forward from the newest one when the render time has
   * run past it, otherwise holds.
   */
  _sample(plane, t) {
    const s = plane.snaps;
    if (!s.length) return plane.live;
    // Render time before our first sample: hold there (the peer has not
    // started moving yet on our timeline).
    if (t <= s[0].t) return s[0];

    const last = s[s.length - 1];
    if (t >= last.t) return this._coast(last, t - last.t, plane);

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
      // Render the ADAPTIVE delay behind the newest data (sized from the
      // sender's packet interval + measured jitter). Clocked peers are on
      // the sender's timeline (so network jitter cannot distort the path);
      // peers without a timestamp fall back to the local arrival timeline.
      const base = plane.clocked && plane.offset != null ? atMs - plane.offset : atMs;
      const sampleT = base - (plane.interpDelayMs || 100);
      const lastSnap = plane.snaps[plane.snaps.length - 1];
      if (sampleT >= lastSnap.t) plane.stats.underruns++; // coasting past the data
      const pose = this._sample(plane, sampleT);
      if (!pose) continue;
      // Smooth corrections (DIS "lie gently"): tiny per-frame steps apply
      // instantly; a post-stall discontinuity converges over ~0.5 s so the
      // catch-up reads as flight, never a teleport.
      const shown = plane.shown || pose;
      const displayed = convergeStep(shown, pose, dt * 1000, {
        epsM: SMOOTH_EPS_M,
        ratePerS: SMOOTH_RATE_PER_S,
      });
      const corrM = displayed === pose
        ? 0
        : Math.hypot(
            (displayed.lon - pose.lon) * 111320 * Math.cos(pose.lat * Math.PI / 180),
            (displayed.lat - pose.lat) * 111320,
            (displayed.alt ?? 0) - (pose.alt ?? 0),
          );
      if (corrM > plane.stats.lastCorrectionM) plane.stats.lastCorrectionM = corrM;
      plane.shown = displayed;
      plane.live = displayed;
      plane.stats.jitterMs = plane.jitterEwma ?? 0;
      plane.stats.delayMs = plane.interpDelayMs ?? 100;

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
          // Live distance readout: proves the other plane is moving even
          // when both are at cruise (zero relative velocity reads as frozen).
          try {
            const cam = this.viewer.camera.positionCartographic;
            if (cam) {
              const dc = Math.hypot(
                (pose.lon - Cesium.Math.toDegrees(cam.longitude)) * 111320 * Math.cos(cam.latitude),
                (pose.lat - Cesium.Math.toDegrees(cam.latitude)) * 111320
              );
              plane.labelEntity.label.text = plane.callsign + (dc > 1000 ? " · " + (dc / 1000).toFixed(1) + " km" : " · " + dc.toFixed(0) + " m");
            }
          } catch (e) { /* cosmetic */ }
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
