import * as THREE from "three";
import * as Cesium from "cesium";
import { movePosition } from "../utils/geo.js";
import { particles } from "../utils/particles.js";
import { soundManager } from "../utils/soundManager.js";

/**
 * Wing-gun laser bullets. Adapted from ref-flight's src/weapon/bullet.js,
 * trimmed to the parts this game needs (no NPCs / missile lock / flares).
 *
 * ── Set path, never re-aimed ───────────────────────────────────────────────
 * The bullet captures position + heading + pitch ONCE at fire time and steps
 * a straight great-circle with movePosition() every frame. The plane can
 * turn, roll or boost after the shot — the round keeps its frozen path.
 *
 * ── Rendering ──────────────────────────────────────────────────────────────
 * The Three.js overlay camera sits at the origin and the plane model lives
 * in CAMERA space (BASE_PLANE_POS). So the bullet converts its world
 * lon/lat/alt into camera space by multiplying through the Cesium view
 * matrix — exactly like ref-flight. Everything goes on layer 1 (the HUD
 * overlay layer) so it renders with the jet.
 *
 * ── Impact ─────────────────────────────────────────────────────────────────
 * Each frame the bullet's alt is checked against the resident terrain
 * (globe.getHeight). On contact: a small camera-local explosion through the
 * existing particles system plus a random explosion-1/2/3 sound. Max life
 * covers misses (the round self-destructs after 3 s).
 */

const BULLET_LIFE = 3.0;          // s, ref-flight value
const SPEED_BONUS_MPH = 1500;     // fires this much faster than the jet (ref-flight)
const IMPACT_PAD_M = 2;           // meters above terrain that count as a hit

// Wing muzzle offsets in the plane's local frame (meters). The F-15 carries
// the M61 in the right wing root; shots alternate L/R muzzles so stream fire
// looks like both wing stations trading shots.
const MUZZLE_FORWARD = 4.0;       // a bit ahead of the cockpit
const MUZZLE_LATERAL = 3.3;       // wing root offset, half of F-15 span-ish
const MUZZLE_DROP = -0.5;         // slightly under the wing line

export class Bullet {
  /**
   * @param scene THREE scene (camera-space overlay)
   * @param viewer Cesium viewer (viewMatrix + globe for collision)
   * @param startPos {lon, lat, alt} world point the shot leaves from
   * @param heading/pitch frozen aim (degrees, from the camera pick ray)
   * @param speedMps initial round speed, meters/second
   */
  constructor(scene, viewer, startPos, heading, pitch, speedMps) {
    this.viewer = viewer;
    this.scene = scene;

    this.lon = startPos.lon;
    this.lat = startPos.lat;
    this.alt = startPos.alt;
    this.heading = heading;
    this.pitch = pitch;
    this.speed = speedMps;

    this.life = BULLET_LIFE;
    this.active = true;

    this._scratchMatrix = new Cesium.Matrix4();
    this._scratchCartesian = new Cesium.Cartesian3();
    this._scratchThreeMatrix = new THREE.Matrix4();
    this._scratchCameraMatrix = new Cesium.Matrix4();

    this._initMesh();
  }

  _initMesh() {
    // Laser bolt: 3 core planes + 3 glow planes turned 60 deg apart + a hot
    // cone tip, additive blended (ref-flight look).
    const gradientMaterial = (opacity, intensity) => new THREE.ShaderMaterial({
      uniforms: {
        colorStart: { value: new THREE.Color(0xff3300) },
        colorMid: { value: new THREE.Color(0xffcc00) },
        colorEnd: { value: new THREE.Color(0xffffff) },
        opacity: { value: opacity },
        intensity: { value: intensity },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 colorStart;
        uniform vec3 colorMid;
        uniform vec3 colorEnd;
        uniform float opacity;
        uniform float intensity;
        varying vec2 vUv;
        void main() {
          float t = clamp(vUv.y, 0.0, 1.0);
          vec3 a = mix(colorStart, colorMid, smoothstep(0.0, 0.5, t));
          vec3 b = mix(colorMid, colorEnd, smoothstep(0.5, 1.0, t));
          vec3 col = mix(a, b, smoothstep(0.0, 1.0, t));
          float alpha = opacity * pow(t, 0.6) * intensity;
          float edge = 1.0 - smoothstep(0.0, 0.5, abs(vUv.x - 0.5) * 2.0);
          alpha *= edge;
          gl_FragColor = vec4(col, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    const makeStreak = (width, len, opacity, intensity) => {
      const geom = new THREE.PlaneGeometry(width, len, 1, 1);
      geom.translate(0, -len / 2, 0); // +Y points along the shot line
      return new THREE.Mesh(geom, gradientMaterial(opacity, intensity));
    };

    const LEN = 20;
    const group = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const core = makeStreak(0.6, LEN, 1.0, 1.0);
      core.rotateY((i * Math.PI * 2) / 3);
      group.add(core);
    }
    for (let i = 0; i < 3; i++) {
      const glow = makeStreak(1.6, LEN * 1.1, 0.35, 0.65);
      glow.rotateY((i * Math.PI * 2) / 3 + Math.PI / 6);
      group.add(glow);
    }
    const tipGeom = new THREE.ConeGeometry(0.12, 0.8, 12);
    tipGeom.translate(0, -0.4, 0);
    group.add(new THREE.Mesh(tipGeom, new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 1.0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })));

    group.traverse((child) => child.layers.set(1)); // HUD overlay layer
    group.matrixAutoUpdate = false;
    this.scene.add(group);
    this.mesh = group;
  }

  /** Straight-line step along the frozen path + collision. */
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

    this._updateThreeMatrix();
    this._checkTerrainHit();
  }

  _updateThreeMatrix() {
    const viewMatrix = this.viewer.camera.viewMatrix;
    const pos = Cesium.Cartesian3.fromDegrees(this.lon, this.lat, this.alt, undefined, this._scratchCartesian);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(pos, undefined, this._scratchMatrix);

    const hRad = Cesium.Math.toRadians(this.heading);
    const pRad = Cesium.Math.toRadians(this.pitch);

    // Plane-local forward/right/up blown out to ECEF so the streak points
    // exactly along the shot line (yaw then pitch, no roll needed visually).
    const localForward = new Cesium.Cartesian3(
      Math.sin(hRad) * Math.cos(pRad),
      Math.cos(hRad) * Math.cos(pRad),
      Math.sin(pRad)
    );
    const worldForward = Cesium.Matrix4.multiplyByPointAsVector(enu, localForward, new Cesium.Cartesian3());
    Cesium.Cartesian3.normalize(worldForward, worldForward);
    const enuUp = new Cesium.Cartesian3(enu[8], enu[9], enu[10]); // up column

    const worldRight = new Cesium.Cartesian3();
    if (Math.abs(Cesium.Cartesian3.dot(worldForward, enuUp)) > 0.999) {
      const enuNorth = new Cesium.Cartesian3(enu[4], enu[5], enu[6]);
      Cesium.Cartesian3.cross(worldForward, enuNorth, worldRight);
    } else {
      Cesium.Cartesian3.cross(worldForward, enuUp, worldRight);
    }
    Cesium.Cartesian3.normalize(worldRight, worldRight);
    const worldUp = Cesium.Cartesian3.cross(worldRight, worldForward, new Cesium.Cartesian3());

    const m = this._scratchMatrix;
    m[0] = worldRight.x;   m[1] = worldRight.y;   m[2] = worldRight.z;   m[3] = 0;
    m[4] = worldForward.x; m[5] = worldForward.y; m[6] = worldForward.z; m[7] = 0;
    m[8] = worldUp.x;      m[9] = worldUp.y;      m[10] = worldUp.z;     m[11] = 0;
    m[12] = pos.x;         m[13] = pos.y;         m[14] = pos.z;         m[15] = 1;

    const cameraSpace = Cesium.Matrix4.multiply(viewMatrix, m, this._scratchCameraMatrix);
    for (let i = 0; i < 16; i++) {
      this._scratchThreeMatrix.elements[i] = cameraSpace[i];
    }
    this.mesh.matrix.copy(this._scratchThreeMatrix);
    this.mesh.updateMatrixWorld(true);
  }

  _checkTerrainHit() {
    const carto = Cesium.Cartographic.fromDegrees(this.lon, this.lat);
    const terrainHeight = this.viewer.scene.globe.getHeight(carto);
    if (terrainHeight !== undefined && this.alt <= terrainHeight + IMPACT_PAD_M) {
      this._impact();
    }
  }

  /** Little explosion at the impact point, in the overlay's camera space. */
  _impact() {
    try {
      const world = Cesium.Cartesian3.fromDegrees(this.lon, this.lat, this.alt, undefined, new Cesium.Cartesian3());
      const view = Cesium.Matrix4.multiplyByPoint(this.viewer.camera.viewMatrix, world, new Cesium.Cartesian3());
      particles.spawnExplosion(new THREE.Vector3(view.x, view.y, view.z), { big: false });
      const n = 1 + Math.floor(Math.random() * 3);
      soundManager.play(`explosion-${n}`);
    } catch (e) { /* visual-only */ }
    this.destroy();
  }

  destroy() {
    if (!this.active) return;
    this.active = false;
    this.scene.remove(this.mesh);
    this.mesh.traverse((child) => {
      child.geometry?.dispose?.();
      child.material?.dispose?.();
    });
  }
}

/**
 * Collection + firing. Owns the live list, the alternating wing muzzle and
 * the world->aim math; main.js just calls fire() / update() / clear().
 */
export class Bullets {
  constructor() {
    this.list = [];
    this._side = 1; // alternating wing muzzle: 1 = right, -1 = left
  }

  attach(scene, viewer) {
    this.scene = scene;
    this.viewer = viewer;
  }

  /**
   * Fire one round from a wing muzzle toward `aimHeading/aimPitch` (degrees,
   * computed by the caller from the click point). player = state at fire time
   * ({lon, lat, alt, heading, pitch, roll, speed} in the game's mph world).
   * mphToMps converts; returned for callers/tests.
   */
  fire(player, aimHeading, aimPitch, mphToMps) {
    if (!this.scene || !this.viewer) return null;
    this._side *= -1;
    const muzzle = this._wingMuzzle(player, this._side);
    const speedMps = (player.speed + SPEED_BONUS_MPH) * mphToMps;
    const bullet = new Bullet(this.scene, this.viewer, muzzle, aimHeading, aimPitch, speedMps);
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
      if (!b.active) this.list.splice(i, 1);
    }
  }

  /** Respawn / back to menu: no stray rounds in the next flight. */
  clear() {
    for (const b of this.list) b.destroy();
    this.list.length = 0;
  }
}
