/**
 * Remote bullet tracers — networked rounds in the RECEIVER's 3D world.
 *
 * ── How it works (standard event-driven projectile netcode) ────────────────
 * The shooter broadcasts ONE small event per round at fire time: the frozen
 * path (world muzzle position + heading + pitch + speed). Nothing about the
 * round is simulated on the network afterwards — every receiving client
 * simulates the identical deterministic path locally (movePosition along
 * the frozen heading/pitch at the frozen speed, exactly like the local
 * Bullets class), so the tracer flies through the receiver's real terrain,
 * lands when it hits the receiver's terrain, and costs ~60 bytes per shot.
 *
 * Rendered as thin elongated boxes (tracer streaks) in the main Cesium
 * viewer — world-space, so they read against terrain, occlude correctly and
 * scale with distance like everything else in the world.
 *
 * This file loads RAW (outside the app bundler): Cesium and tunables arrive
 * through createRemoteBullets(ctx), same pattern as remotePlanes.js.
 */

let Cesium = null;

/** Same life as the local rounds (bullet.js BULLET_LIFE). */
const TRACER_LIFE_S = 3.0;
/** Metres above the receiver's terrain that count as an impact. */
const IMPACT_PAD_M = 2;
/** Streak length in metres — a readable tracer at dogfight distances. */
const STREAK_M = 70;
/** Hard cap on live tracers (defensive: a stuck sender must not paint). */
const MAX_TRACERS = 80;

/** Wrap a longitude difference into (-180, 180]. */
function wrapDeg(d) {
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

/** Spherical step, identical in shape to utils/geo.js movePosition. */
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

export function createRemoteBullets(ctx) {
  Cesium = ctx.Cesium;
  return new RemoteBullets(ctx.viewer);
}

export class RemoteBullets {
  constructor(viewer) {
    this.viewer = viewer;
    /** live tracers: {entity, lon, lat, alt, h, p, v, life} */
    this.list = [];
  }

  get count() {
    return this.list.length;
  }

  /**
   * Spawn a round from a networked fire event. The payload is the shooter's
   * frozen path exactly as their local Bullet was created:
   * {lon, lat, alt, h, p, v} with v in metres/second.
   */
  spawn(data) {
    if (!this.viewer || !data) return;
    const lon = Number(data.lon);
    const lat = Number(data.lat);
    const alt = Number(data.alt);
    const h = Number(data.h);
    const p = Number(data.p);
    const v = Number(data.v);
    if (![lon, lat, alt, h, p, v].every(Number.isFinite)) return;

    if (this.list.length >= MAX_TRACERS) this._dispose(0);

    let entity = null;
    try {
      const position = Cesium.Cartesian3.fromDegrees(lon, lat, alt);
      const hpr = new Cesium.HeadingPitchRoll(
        Cesium.Math.toRadians(h),
        Cesium.Math.toRadians(p),
        0,
      );
      entity = this.viewer.entities.add({
        position,
        orientation: new Cesium.ConstantProperty(
          Cesium.Transforms.headingPitchRollQuaternion(position, hpr)
        ),
        box: {
          // Long axis is +Y in the HPR frame (forward), thin otherwise.
          dimensions: new Cesium.Cartesian3(1.2, STREAK_M, 1.2),
          material: Cesium.Color.fromCssColorString("#7df"),
          outline: false,
        },
      });
    } catch (e) {
      return; // never let a tracer break the frame
    }
    this.list.push({ entity, lon, lat, alt, h, p, v, life: TRACER_LIFE_S });
  }

  /** Per-frame local simulation of every live tracer. */
  update(dt) {
    if (!this.list.length) return;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i];
      b.life -= dt;
      let spent = b.life <= 0;

      if (!spent) {
        const step = movePosition(b.lon, b.lat, b.alt, b.h, b.p, b.v * dt);
        b.lon = step.lon;
        b.lat = step.lat;
        b.alt = step.alt;
        // Terrain hit on the RECEIVER's world — the round lands here too.
        try {
          const ground = this.viewer.scene.globe.getHeight(
            Cesium.Cartographic.fromDegrees(b.lon, b.lat)
          );
          if (typeof ground === "number" && Number.isFinite(ground)
              && b.alt <= ground + IMPACT_PAD_M) {
            spent = true;
          }
        } catch (e) { /* keep flying on a sampling error */ }
      }

      if (spent) {
        this._dispose(i);
        continue;
      }
      try {
        b.entity.position = Cesium.Cartesian3.fromDegrees(b.lon, b.lat, b.alt);
      } catch (e) { /* cosmetic */ }
    }
  }

  _dispose(i) {
    const b = this.list[i];
    if (!b) return;
    try { this.viewer.entities.remove(b.entity); } catch (e) { /* gone */ }
    this.list.splice(i, 1);
  }

  clear() {
    while (this.list.length) this._dispose(0);
  }
}
