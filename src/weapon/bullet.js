import * as THREE from "three";
import * as Cesium from "cesium";
import { movePosition } from "../utils/geo.js";
import { particles } from "../utils/particles.js";
import { soundManager } from "../utils/soundManager.js";

/**
 * Wing-gun laser tracers. Physics adapted from ref-flight's
 * src/weapon/bullet.js; rendering via Cesium collections.
 *
 * ── Set path, never re-aimed ───────────────────────────────────────────────
 * The round captures position + heading + pitch ONCE at fire time and steps
 * a straight great-circle with movePosition() every frame. The plane can
 * turn, roll or boost after the shot — the round keeps its frozen path.
 *
 * ── Why PolylineCollection, not entities ───────────────────────────────────
 * Entity polylines rebuild geometry through PolylinePipeline.generateArc on
 * every position change, which throws "Invalid array length" for fast-moving
 * tracer updates. A PolylineCollection polyline takes direct position
 * updates per frame - cheap, no rebuild - and PointPrimitiveCollection does
 * the same for the hot tip and the impact flash. Both render IN the world:
 * correct perspective at any range, occluded by terrain like everything else.
 *
 * ── Impact ─────────────────────────────────────────────────────────────────
 * Each frame the round's alt is checked against the resident terrain. On
 * contact: a cesium flash point (in-world, correct at any range), a
 * camera-local particle explosion when the hit is close enough for that
 * conversion to be accurate, and a random explosion-1/2/3 sound. Max life
 * covers misses.
 */

const BULLET_LIFE = 3.0;          // s, ref-flight value
const SPEED_BONUS_MPH = 1500;     // fires this much faster than the jet (ref-flight)
const IMPACT_PAD_M = 2;           // meters above terrain that count as a hit
const TRAIL_LEN = 70;             // meters of glowing tracer behind the round
const FLASH_LIFE = 0.5;           // s the impact flash burns

// Wing muzzle offsets in the plane's local frame (meters). The F-15 carries
// the M61 in the right wing root; shots alternate L/R muzzles so stream fire
// looks like both wing stations trading shots.
const MUZZLE_FORWARD = 4.0;       // a bit ahead of the cockpit
const MUZZLE_LATERAL = 3.3;       // wing root offset, half of F-15 span-ish
const MUZZLE_DROP = -0.5;         // slightly under the wing line

export class Bullet {
  /**
   * @param tracers PolylineCollection (owned by Bullets)
   * @param sparks PointPrimitiveCollection (owned by Bullets)
   * @param startPos {lon, lat, alt} world point the shot leaves from
   * @param heading/pitch frozen aim (degrees, from the camera pick ray)
   * @param speedMps initial round speed, meters/second
   */
  constructor(tracers, sparks, viewer, startPos, heading, pitch, speedMps) {
    this.tracers = tracers;
    this.sparks = sparks;
    this.viewer = viewer;

    this.lon = startPos.lon;
    this.lat = startPos.lat;
    this.alt = startPos.alt;
    this.heading = heading;
    this.pitch = pitch;
    this.speed = speedMps;

    this.life = BULLET_LIFE;
    this.active = true;
    this.flash = null;
    this.flashAge = 0;

    const head = Cesium.Cartesian3.fromDegrees(this.lon, this.lat, this.alt);
    // Glowing tracer: from the round back along its frozen path.
    this.polyline = tracers.add({
      positions: [head, head],
      width: 7,
      material: Cesium.Material.fromType("PolylineGlow", {
        color: Cesium.Color.ORANGE,
        glowPower: 0.22,
      }),
    });
    // Hot tip: always visible (same trick as the spawn pin).
    this.tip = sparks.add({
      position: head,
      pixelSize: 6,
      color: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.ORANGE,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
  }

  /** Straight-line step along the frozen path + collision + visuals. */
  update(dt) {
    if (!this.active) return;

    this.life -= dt;
    if (this.life <= 0) {
      this.destroy();
      return;
    }

    const next = movePosition(this.lon, this.lat, this.alt, this.heading, this.pitch, this.speed * dt);
    this.lon = next.lon;
    this.lat = next.lat;
    this.alt = next.alt;

    // Direct per-frame position updates: no geometry rebuild.
    const head = Cesium.Cartesian3.fromDegrees(this.lon, this.lat, this.alt);
    const tailCarto = movePosition(this.lon, this.lat, this.alt, this.heading, this.pitch, -TRAIL_LEN);
    this.polyline.positions = [
      Cesium.Cartesian3.fromDegrees(tailCarto.lon, tailCarto.lat, tailCarto.alt),
      head,
    ];
    this.tip.position = head;

    this._checkTerrainHit();
  }

  _checkTerrainHit() {
    const carto = Cesium.Cartographic.fromDegrees(this.lon, this.lat);
    const terrainHeight = this.viewer.scene.globe.getHeight(carto);
    if (terrainHeight !== undefined && this.alt <= terrainHeight + IMPACT_PAD_M) {
      this._impact();
    }
  }

  /** Little explosion at the impact point. */
  _impact() {
    const world = Cesium.Cartesian3.fromDegrees(this.lon, this.lat, this.alt);

    // Flash point: in-world, correct at any range; fades over FLASH_LIFE.
    this.flash = this.sparks.add({
      position: world,
      pixelSize: 26,
      color: Cesium.Color.ORANGE,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
    this.flashAge = 0;

    // Particle explosion only when the hit is close enough for the camera-
    // space conversion to place it accurately.
    try {
      const camDist = Cesium.Cartesian3.distance(this.viewer.camera.positionWC, world);
      if (camDist < 400) {
        const view = Cesium.Matrix4.multiplyByPoint(
          this.viewer.camera.viewMatrix, world, new Cesium.Cartesian3());
        particles.spawnExplosion(new THREE.Vector3(view.x, view.y, view.z), { big: false });
      }
    } catch (e) { /* visual-only */ }

    try { soundManager.play(`explosion-${1 + Math.floor(Math.random() * 3)}`); } catch (e) { /* */ }

    // The round is spent; the flash lingers in the manager's update loop.
    if (this.polyline) { this.tracers.remove(this.polyline); this.polyline = null; }
    if (this.tip) { this.sparks.remove(this.tip); this.tip = null; }
    this.active = false;
  }

  destroy() {
    if (this.polyline) { this.tracers.remove(this.polyline); this.polyline = null; }
    if (this.tip) { this.sparks.remove(this.tip); this.tip = null; }
    this.active = false;
  }
}

/**
 * Collection + firing. Owns the live list, the collections, the alternating
 * wing muzzle and the aim math; main.js just calls fire()/update()/clear().
 */
export class Bullets {
  constructor() {
    this.list = [];
    this._side = 1; // alternating wing muzzle: 1 = right, -1 = left
  }

  attach(viewer) {
    this.viewer = viewer;
    if (!this.tracers) {
      this.tracers = new Cesium.PolylineCollection();
      viewer.scene.primitives.add(this.tracers);
    }
    if (!this.sparks) {
      this.sparks = new Cesium.PointPrimitiveCollection();
      viewer.scene.primitives.add(this.sparks);
    }
  }

  /**
   * Fire one round from a wing muzzle toward `aimHeading/aimPitch` (degrees,
   * computed by the caller from the click point). player = state at fire time
   * ({lon, lat, alt, heading, pitch, roll, speed} in the game's mph world).
   * mphToMps converts; returned for callers/tests.
   */
  fire(player, aimHeading, aimPitch, mphToMps) {
    if (!this.viewer || !this.tracers) return null;
    this._side *= -1;
    const muzzle = this._wingMuzzle(player, this._side);
    const speedMps = (player.speed + SPEED_BONUS_MPH) * mphToMps;
    const bullet = new Bullet(this.tracers, this.sparks, this.viewer, muzzle, aimHeading, aimPitch, speedMps);
    this.list.push(bullet);
    try { soundManager.play("gunshot"); } catch (e) { /* audio not ready */ }
    return bullet;
  }

  /**
   * Wing-root muzzle in world lon/lat/alt, from the plane's current attitude.
   * Local frame (ref-flight convention, ENU): forward = heading/pitch,
   * right = forward x up, rolled around forward by `roll`.
   */
  _wingMuzzle(player, side) {
    const h = Cesium.Math.toRadians(player.heading);
    const p = Cesium.Math.toRadians(player.pitch);
    const r = Cesium.Math.toRadians(player.roll || 0);

    // ENU components: east, north, up.
    const fwd = {
      e: Math.sin(h) * Math.cos(p),
      n: Math.cos(h) * Math.cos(p),
      u: Math.sin(p),
    };
    const right0 = { e: fwd.n, n: -fwd.e, u: 0 };       // fwd x up
    const up0 = {                                        // right0 x fwd
      e: -fwd.e * fwd.u,
      n: -fwd.n * fwd.u,
      u: fwd.e * fwd.e + fwd.n * fwd.n,
    };
    const cosR = Math.cos(r), sinR = Math.sin(r);
    const right = {
      e: right0.e * cosR + up0.e * sinR,
      n: right0.n * cosR + up0.n * sinR,
      u: right0.u * cosR + up0.u * sinR,
    };
    const up = {
      e: up0.e * cosR - right0.e * sinR,
      n: up0.n * cosR - right0.n * sinR,
      u: up0.u * cosR - right0.u * sinR,
    };

    // meters -> degrees at the plane's latitude
    const f = MUZZLE_FORWARD, lat = MUZZLE_LATERAL * side, d = MUZZLE_DROP;
    const dE = fwd.e * f + right.e * lat + up.e * d;
    const dN = fwd.n * f + right.n * lat + up.n * d;
    const dU = fwd.u * f + right.u * lat + up.u * d;

    return {
      lon: player.lon + (dE / 111320) / Math.cos(Cesium.Math.toRadians(player.lat || 0.0001)),
      lat: player.lat + dN / 111320,
      alt: player.alt + dU,
    };
  }

  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i];
      b.update(dt);
      // Spent rounds linger only while their impact flash burns.
      if (!b.active) {
        if (b.flash) {
          b.flashAge += dt;
          const k = Math.max(0, 1 - b.flashAge / FLASH_LIFE);
          if (k <= 0) {
            this.sparks.remove(b.flash);
            b.flash = null;
            this.list.splice(i, 1);
          } else {
            b.flash.pixelSize = 26 * k;
            b.flash.color = Cesium.Color.ORANGE.withAlpha(k);
          }
        } else {
          this.list.splice(i, 1);
        }
      }
    }
  }

  /** Respawn / back to menu: no stray rounds in the next flight. */
  clear() {
    for (const b of this.list) b.destroy();
    this.list.length = 0;
  }
}
