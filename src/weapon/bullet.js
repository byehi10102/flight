import * as THREE from "three";
import * as Cesium from "cesium";
import { movePosition } from "../utils/geo.js";
import { particles } from "../utils/particles.js";
import { soundManager } from "../utils/soundManager.js";

/**
 * Wing-gun tracer rounds - ref-flight's src/weapon/bullet.js projectile.
 *
 * ── Set path, never re-aimed ───────────────────────────────────────────────
 * The round captures position + heading + pitch ONCE at fire time and steps
 * a straight great-circle with movePosition() every frame. The plane can
 * turn, roll or boost after the shot — the round keeps its frozen path.
 *
 * ── The projectile (same mesh as the reference) ────────────────────────────
 * An additive gradient streak: 3 core planes + 3 glow planes turned 60 deg
 * apart + a white-hot cone tip, depthTest:false so the jet's silhouette
 * never rejects it, on the overlay layer like the jet.
 *
 * ── Placing a world object in the plane's exaggerated overlay ──────────────
 * The Three overlay camera renders at a fixed 75 deg FOV while the Cesium
 * camera's vertical FOV is ~30 deg, AND the jet is drawn ~20x closer than it
 * really is (BASE_PLANE_POS vs the camera boom). Raw viewMatrix placement
 * therefore lands world objects off-position and shrinking too fast - the
 * "fires then dissipates" look. Two live ratios fix it every frame:
 *   k = tan(overlayFov/2) / tan(cesiumFov/2)   -> screen alignment
 *   S = planeTrueDistance / |BASE_PLANE_POS.z|  -> the jet's size exaggeration
 * A camera-space point (x, y, z) maps to ((x*k)/S, (y*k)/S, z/S): screen
 * position matches the world, the round lives at the jet's visual scale, and
 * it still shrinks with distance - so a 1 km impact and its explosion read
 * as far away, exactly like the terrain does.
 *
 * ── Impact ─────────────────────────────────────────────────────────────────
 * Per-frame terrain check (globe.getHeight). On contact: the SAME explosion
 * the airplane crash uses (particles.spawnExplosion big, 72 fireballs,
 * 16 smoke) placed with the same transform - distance gives the perspective
 * - plus a random explosion-1/2/3 sound. Max life 3 s covers misses.
 */

const BULLET_LIFE = 3.0;          // s, ref-flight value
const SPEED_BONUS_MPH = 1500;     // fires this much faster than the jet (ref-flight)
const IMPACT_PAD_M = 2;           // meters above terrain that count as a hit

// Ref-flight streak dimensions (the reference projectile, unchanged).
const STREAK_CORE_W = 0.6;
const STREAK_GLOW_W = 1.6;
const STREAK_LEN = 20;

// The overlay camera's fixed vertical FOV (degrees) - must match
// CONFIG.camera.fov, which the Three overlay camera is created with.
const OVERLAY_FOV_DEG = 75;
// The jet's drawn distance in overlay units (BASE_PLANE_POS in planeModel).
const PLANE_DRAWN_DIST = 2.75;

// Wing muzzle offsets in the plane's local frame (meters). The F-15 carries
// the M61 in the right wing root; shots alternate L/R muzzles.
const MUZZLE_FORWARD = 4.0;
const MUZZLE_LATERAL = 3.3;
const MUZZLE_DROP = -0.5;

export class Bullet {
  /**
   * @param scene THREE overlay scene (camera-space)
   * @param viewer Cesium viewer (viewMatrix, frustum, globe)
   * @param startPos {lon, lat, alt} world point the shot leaves from
   * @param heading/pitch frozen aim (degrees)
   * @param speedMps round speed, meters/second
   * @param planePosCarto live {lon, lat, alt} of the jet (for the S ratio)
   */
  constructor(scene, viewer, startPos, heading, pitch, speedMps, planePosCarto) {
    this.scene = scene;
    this.viewer = viewer;

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
    this._updateThreeMatrix(planePosCarto); // place at the muzzle immediately
  }

  _initMesh() {
    // The reference projectile: additive gradient laser streak.
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
      depthTest: false, // the tracer reads over the jet silhouette
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    const makeStreak = (width, len, opacity, intensity) => {
      const geom = new THREE.PlaneGeometry(width, len, 1, 1);
      geom.translate(0, -len / 2, 0); // +Y points along the shot line
      return new THREE.Mesh(geom, gradientMaterial(opacity, intensity));
    };

    const group = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const core = makeStreak(STREAK_CORE_W, STREAK_LEN, 1.0, 1.0);
      core.rotateY((i * Math.PI * 2) / 3);
      group.add(core);
    }
    for (let i = 0; i < 3; i++) {
      const glow = makeStreak(STREAK_GLOW_W, STREAK_LEN * 1.1, 0.35, 0.65);
      glow.rotateY((i * Math.PI * 2) / 3 + Math.PI / 6);
      group.add(glow);
    }
    const tipGeom = new THREE.ConeGeometry(0.12, 0.8, 12);
    tipGeom.translate(0, -0.4, 0);
    group.add(new THREE.Mesh(tipGeom, new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 1.0,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    })));

    group.traverse((child) => child.layers.set(1)); // HUD overlay layer
    group.matrixAutoUpdate = false;
    this.scene.add(group);
    this.mesh = group;
  }

  /** Straight-line step along the frozen path + collision + placement. */
  update(dt, planePosCarto) {
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

    this._updateThreeMatrix(planePosCarto);
    this._checkTerrainHit();
  }

  /** World -> this game's exaggerated overlay camera space (see header). */
  _updateThreeMatrix(planePosCarto) {
    const viewMatrix = this.viewer.camera.viewMatrix;
    const pos = Cesium.Cartesian3.fromDegrees(this.lon, this.lat, this.alt, undefined, this._scratchCartesian);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(pos, undefined, this._scratchMatrix);

    const hRad = Cesium.Math.toRadians(this.heading);
    const pRad = Cesium.Math.toRadians(this.pitch);

    // Round-local axes blown out to ECEF (yaw then pitch; roll is
    // irrelevant for a radially symmetric streak).
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
    const e = this._scratchThreeMatrix.elements;
    for (let i = 0; i < 16; i++) e[i] = cameraSpace[i];

    // k: screen alignment between the ~30 deg Cesium frustum and the 75 deg
    //    overlay frustum (live, so the speed FOV kick stays aligned).
    // S: the jet is drawn at PLANE_DRAWN_DIST while really being much further
    //    out; compressing the round's depth by the same ratio makes it live
    //    at the jet's visual scale - visible travel, honest distance shrink.
    let k = 1, S = 1;
    try {
      const cesFovY = this.viewer.camera.frustum.fovy; // radians, live
      k = Math.tan(Cesium.Math.toRadians(OVERLAY_FOV_DEG) / 2) / Math.tan(cesFovY / 2);
    } catch (err) { /* keep k = 1 */ }
    try {
      const planePos = Cesium.Cartesian3.fromDegrees(planePosCarto.lon, planePosCarto.lat, planePosCarto.alt, undefined, new Cesium.Cartesian3());
      const trueDist = Math.max(1, Cesium.Cartesian3.distance(this.viewer.camera.positionWC, planePos));
      S = Math.min(80, Math.max(1, trueDist / PLANE_DRAWN_DIST));
    } catch (err) { /* keep S = 1 */ }

    // Translation: (x*k)/S, (y*k)/S, z/S. Basis: right/up scaled k/S,
    // forward scaled 1/S so the streak keeps its length relative to the jet.
    e[12] = (e[12] * k) / S;
    e[13] = (e[13] * k) / S;
    e[14] = e[14] / S;
    for (let i = 0; i < 3; i++) {
      e[i] *= k / S;        // right column
      e[4 + i] *= 1 / S;    // forward column
      e[8 + i] *= k / S;    // up column
    }

    this.mesh.matrix.copy(this._scratchThreeMatrix);
    this.mesh.updateMatrixWorld(true);
    this._planePos = planePosCarto; // for _overlayPoint() at impact time
  }

  /** Same world->overlay point transform, for the impact explosion. */
  _overlayPoint(world) {
    const view = Cesium.Matrix4.multiplyByPoint(
      this.viewer.camera.viewMatrix, world, new Cesium.Cartesian3());
    let k = 1, S = 1;
    try {
      const cesFovY = this.viewer.camera.frustum.fovy;
      k = Math.tan(Cesium.Math.toRadians(OVERLAY_FOV_DEG) / 2) / Math.tan(cesFovY / 2);
    } catch (err) { /* defaults */ }
    try {
      const planePos = Cesium.Cartesian3.fromDegrees(this._planePos.lon, this._planePos.lat, this._planePos.alt, undefined, new Cesium.Cartesian3());
      const trueDist = Math.max(1, Cesium.Cartesian3.distance(this.viewer.camera.positionWC, planePos));
      S = Math.min(80, Math.max(1, trueDist / PLANE_DRAWN_DIST));
    } catch (err) { /* defaults */ }
    return new THREE.Vector3((view.x * k) / S, (view.y * k) / S, view.z / S);
  }

  _checkTerrainHit() {
    const carto = Cesium.Cartographic.fromDegrees(this.lon, this.lat);
    const terrainHeight = this.viewer.scene.globe.getHeight(carto);
    if (terrainHeight !== undefined && this.alt <= terrainHeight + IMPACT_PAD_M) {
      this._impact();
    }
  }

  /** The airplane-crash explosion, placed at the impact (distance = size). */
  _impact() {
    try {
      const world = Cesium.Cartesian3.fromDegrees(this.lon, this.lat, this.alt, undefined, new Cesium.Cartesian3());
      particles.spawnExplosion(this._overlayPoint(world), { big: true, count: 72, smokeCount: 16 });
      soundManager.play(`explosion-${1 + Math.floor(Math.random() * 3)}`);
    } catch (e) { /* cosmetic */ }
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
 * the aim math; main.js just calls fire() / update() / clear().
 */
export class Bullets {
  constructor() {
    this.list = [];
    this._side = 1; // alternating wing muzzle: 1 = right, -1 = left
    this.heat = 0;               // 0..1, ref-flight gun heat
    this.isGunOverheated = false;
    this.lastGunFire = 0;        // s, performance.now()*0.001 like ref-flight
  }

  attach(scene, viewer) {
    this.scene = scene;
    this.viewer = viewer;
  }

  fire(player, aimHeading, aimPitch, mphToMps) {
    if (!this.scene || !this.viewer) return null;
    // Ref-flight gun gate: fire rate + heat.
    const now = performance.now() * 0.001;
    if (this.isGunOverheated) return null;
    if (now - this.lastGunFire < GUN_FIRE_RATE) return null;
    this.lastGunFire = now;
    this.heat = Math.min(1, this.heat + GUN_HEAT_PER_SHOT);
    if (this.heat >= 1.0) this.isGunOverheated = true;
    this._side *= -1;
    const muzzle = this._wingMuzzle(player, this._side);
    const speedMps = (player.speed + SPEED_BONUS_MPH) * mphToMps;
    const bullet = new Bullet(this.scene, this.viewer, muzzle, aimHeading, aimPitch, speedMps, {
      lon: player.lon, lat: player.lat, alt: player.alt,
    });
    this.list.push(bullet);
    return bullet;
  }

  update(dt, planeState) {
    // Ref-flight gun cooling: 20%/s, overheat clears below 30%.
    if (this.heat > 0) {
      this.heat = Math.max(0, this.heat - dt * GUN_COOL_RATE);
      if (this.isGunOverheated && this.heat < GUN_RECOVER_HEAT) this.isGunOverheated = false;
    }
    const planePos = planeState || this._lastPlane || null;
    if (planeState) this._lastPlane = planeState;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i];
      b.update(dt, planePos);
      if (!b.active) this.list.splice(i, 1);
    }
  }

  /** Respawn / back to menu: no stray rounds in the next flight. */
  clear() {
    for (const b of this.list) b.destroy();
    this.list.length = 0;
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
}

// Gun mechanics, ref-flight weaponSystem: a 20 Hz stream while the trigger is
// held, heating 2% per round. At 100% the gun jams until it cools below 30%
// (cooling 20%/s). No ammo limit.
const GUN_FIRE_RATE = 0.05;       // s between rounds (ref-flight M61 cadence)
const GUN_HEAT_PER_SHOT = 0.02;
const GUN_COOL_RATE = 0.2;        // heat units per second
const GUN_RECOVER_HEAT = 0.3;     // overheat clears below this