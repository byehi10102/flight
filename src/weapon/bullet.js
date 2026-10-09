import * as THREE from "three";
import * as Cesium from "cesium";
import { movePosition } from "../utils/geo.js";

/**
 * Wing-gun tracer rounds. The Bullet class below is ref-flight's
 * src/weapon/bullet.js copied as-is (mesh, placement, physics), with only
 * these local adaptations:
 *   - movePosition comes from utils/geo.js (same function, shared export),
 *   - the NPC hit logic is dropped (this game has none),
 *   - a terrain hit simply spends the round (impact explosions removed by
 *     request; the crash explosion stays reserved for the airplane).
 *
 * Placement is RAW view-matrix: world lon/lat/alt -> Cesium viewMatrix ->
 * the Three overlay's camera space. That lines up with the world because
 * main.js syncs the overlay camera's FOV to the Cesium camera's live fovy
 * every frame - the same sync ref-flight's render loop does.
 *
 * The muzzle (Bullets._gunMuzzle) is ref-flight's calculateWeaponPos
 * adapted: the round spawns at the world point matching the DRAWN jet's
 * wing station, so it visibly erupts from the on-screen wing. The
 * reference's x/y FOV factor is intentionally NOT applied - it exists for
 * an unsynced 75 deg overlay, and ours is synced, so the drawn offset maps
 * 1:1 (applying it pulled the muzzle to the fuselage).
 *
 * Set path, never re-aimed: position + heading + pitch are captured at fire
 * time and stepped straight via movePosition() every frame - moving the
 * plane after the shot never bends the round.
 */

const BULLET_LIFE = 3.0;          // s, ref-flight value
const SPEED_BONUS_MPH = 1500;     // fires this much faster than the jet (ref-flight)
const IMPACT_PAD_M = 2;           // meters above terrain that count as a hit

// Wing muzzle offsets in the plane's local frame (meters). The F-15 carries
// the M61 in the wing root; shots alternate L/R muzzles. FORWARD clears the
// plane: the ref-flight streak is 20 units long and trails BEHIND the round,
// so spawning at the wing (4 m) left the trail emerging from behind the
// airplane - at 24 m the trail reaches back to the wing line, and each shot
// visibly leaves the wing.
const MUZZLE_FORWARD = 24.0;
const MUZZLE_LATERAL = 3.3;       // wing root offset, half of F-15 span-ish
const MUZZLE_DROP = -0.5;         // slightly under the wing line

export class Bullet {
	constructor(scene, viewer, startPos, heading, pitch, speed) {
		this.scene = scene;
		this.viewer = viewer;

		this.lon = startPos.lon;
		this.lat = startPos.lat;
		this.alt = startPos.alt;
		this.heading = heading;
		this.pitch = pitch;
		this.speed = speed;

		this.life = 3;
		this.active = true;

		this._scratchMatrix = new Cesium.Matrix4();
		this._scratchCartesian = new Cesium.Cartesian3();
		this._scratchThreeMatrix = new THREE.Matrix4();
		this._scratchCameraMatrix = new Cesium.Matrix4();

		this.initMesh();
	}

	initMesh() {
		const createGradientMaterial = (width, opacity, intensity) => {
			return new THREE.ShaderMaterial({
				uniforms: {
					colorStart: { value: new THREE.Color(0xff3300) },
					colorMid: { value: new THREE.Color(0xffcc00) },
					colorEnd: { value: new THREE.Color(0xffffff) },
					opacity: { value: opacity },
					intensity: { value: intensity }
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
				side: THREE.DoubleSide
			});
		};

		const mainLen = 20;

		this.mesh = new THREE.Group();

		const createPlaneMesh = (width, len, opacity, intensity) => {
			const geom = new THREE.PlaneGeometry(width, len, 1, 1);
			geom.translate(0, -len / 2, 0);
			const mat = createGradientMaterial(width, opacity, intensity);
			return new THREE.Mesh(geom, mat);
		};

		for (let i = 0; i < 3; i++) {
			const p = createPlaneMesh(0.6, mainLen, 1.0, 1.0);
			p.rotateY((i * Math.PI * 2) / 3);
			this.mesh.add(p);
		}

		for (let i = 0; i < 3; i++) {
			const g = createPlaneMesh(1.6, mainLen * 1.1, 0.35, 0.65);
			g.rotateY((i * Math.PI * 2) / 3 + Math.PI / 6);
			this.mesh.add(g);
		}

		const tipGeom = new THREE.ConeGeometry(0.12, 0.8, 12);
		tipGeom.translate(0, -0.4, 0);
		const tipMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1.0, blending: THREE.AdditiveBlending, depthWrite: false });
		const tip = new THREE.Mesh(tipGeom, tipMat);
		this.mesh.add(tip);

		this.mesh.matrixAutoUpdate = false;
		// Local addition: this game's overlay renders layer 1 only (the HUD
		// overlay layer), like the jet. ref-flight renders layer 0.
		this.mesh.traverse((child) => child.layers.set(1));
		this.scene.add(this.mesh);

		// Local addition: place at the muzzle immediately, so the first frame
		// shows the streak at the wing instead of at the camera origin.
		this.updateThreeMatrix();
	}

	update(dt) {
		if (!this.active) return;

		this.life -= dt;
		if (this.life <= 0) {
			this.destroy();
			return;
		}

		const newPos = movePosition(this.lon, this.lat, this.alt, this.heading, this.pitch, this.speed * dt);
		this.lon = newPos.lon;
		this.lat = newPos.lat;
		this.alt = newPos.alt;

		this.updateThreeMatrix();

		this.checkTerrainCollision();
	}

	updateThreeMatrix() {
		const viewMatrix = this.viewer.camera.viewMatrix;
		const pos = Cesium.Cartesian3.fromDegrees(this.lon, this.lat, this.alt, undefined, this._scratchCartesian);
		const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(pos, undefined, this._scratchMatrix);

		const hRad = Cesium.Math.toRadians(this.heading);
		const pRad = Cesium.Math.toRadians(this.pitch);

		const localForward = new Cesium.Cartesian3(
			Math.sin(hRad) * Math.cos(pRad),
			Math.cos(hRad) * Math.cos(pRad),
			Math.sin(pRad)
		);

		const worldForward = Cesium.Matrix4.multiplyByPointAsVector(enuMatrix, localForward, new Cesium.Cartesian3());
		Cesium.Cartesian3.normalize(worldForward, worldForward);
		const enuUp = new Cesium.Cartesian3(enuMatrix[8], enuMatrix[9], enuMatrix[10]);

		let worldRight = new Cesium.Cartesian3();
		if (Math.abs(Cesium.Cartesian3.dot(worldForward, enuUp)) > 0.999) {
			const enuNorth = new Cesium.Cartesian3(enuMatrix[4], enuMatrix[5], enuMatrix[6]);
			Cesium.Cartesian3.cross(worldForward, enuNorth, worldRight);
		} else {
			Cesium.Cartesian3.cross(worldForward, enuUp, worldRight);
		}
		Cesium.Cartesian3.normalize(worldRight, worldRight);
		const worldUp = Cesium.Cartesian3.cross(worldRight, worldForward, new Cesium.Cartesian3());

		const finalModelMatrix = this._scratchMatrix;
		finalModelMatrix[0] = worldRight.x; finalModelMatrix[1] = worldRight.y; finalModelMatrix[2] = worldRight.z; finalModelMatrix[3] = 0;
		finalModelMatrix[4] = worldForward.x; finalModelMatrix[5] = worldForward.y; finalModelMatrix[6] = worldForward.z; finalModelMatrix[7] = 0;
		finalModelMatrix[8] = worldUp.x; finalModelMatrix[9] = worldUp.y; finalModelMatrix[10] = worldUp.z; finalModelMatrix[11] = 0;
		finalModelMatrix[12] = pos.x; finalModelMatrix[13] = pos.y; finalModelMatrix[14] = pos.z; finalModelMatrix[15] = 1;

		const cameraSpaceMatrix = Cesium.Matrix4.multiply(viewMatrix, finalModelMatrix, this._scratchCameraMatrix);
		for (let i = 0; i < 16; i++) {
			this._scratchThreeMatrix.elements[i] = cameraSpaceMatrix[i];
		}
		this.mesh.matrix.copy(this._scratchThreeMatrix);
		this.mesh.updateMatrixWorld(true);
	}

	/**
	 * Terrain hit: the round is spent. (Impact explosions were removed by
	 * request - the crash explosion stays reserved for the airplane.)
	 */
	checkTerrainCollision() {
		const cartographic = Cesium.Cartographic.fromDegrees(this.lon, this.lat);
		const terrainHeight = this.viewer.scene.globe.getHeight(cartographic);
		if (terrainHeight !== undefined && this.alt <= terrainHeight + IMPACT_PAD_M) {
			this.destroy();
		}
	}

	destroy() {
		this.active = false;
		this.scene.remove(this.mesh);
	}
}

/**
 * Collection + firing. Owns the live list, the alternating wing muzzle, the
 * aim math and the ref-flight gun heat; main.js calls fire()/update()/clear().
 */
export class Bullets {
  constructor() {
    this.list = [];
    this._side = 1; // alternating wing muzzle: 1 = right, -1 = left
    this.heat = 0;               // 0..1, ref-flight gun heat
    this.isGunOverheated = false;
    this.lastGunFire = 0;        // s, performance.now()*0.001 like ref-flight
  }

  attach(scene, viewer, planeModel) {
    this.scene = scene;
    this.viewer = viewer;
    this.planeModel = planeModel || null;
  }

  /**
   * Fire one round from a wing muzzle toward `aimHeading/aimPitch` (degrees).
   * player = state at fire time ({lon, lat, alt, heading, pitch, roll, speed}
   * in the game's mph world); mphToMps converts.
   */
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
    const muzzle = this._gunMuzzle(player, this._side);
    const speedMps = (player.speed + SPEED_BONUS_MPH) * mphToMps;
    const bullet = new Bullet(this.scene, this.viewer, muzzle, aimHeading, aimPitch, speedMps);
    this.list.push(bullet);
    return bullet;
  }

  update(dt) {
    // Ref-flight gun cooling: 20%/s, overheat clears below 30%.
    if (this.heat > 0) {
      this.heat = Math.max(0, this.heat - dt * GUN_COOL_RATE);
      if (this.isGunOverheated && this.heat < GUN_RECOVER_HEAT) this.isGunOverheated = false;
    }
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

  /**
   * ref-flight weaponSystem.calculateWeaponPos, adapted: the muzzle is the
   * DRAWN jet's wing station (the Three overlay model's live position and
   * quaternion), converted to a world point through the Cesium camera basis.
   * This is why the reference's rounds visibly erupt from the on-screen jet:
   * they spawn at the world point matching where the wing APPEARS.
   *
   * The reference scales x/y by tan(worldFov/2)/tan(75/2) because ITS overlay
   * camera stays at 75 deg while the world runs ~30 deg. OUR overlay is FOV-
   * SYNCED to the Cesium frustum, so the drawn offset maps 1:1 - applying the
   * reference factor here double-compensated and pulled the muzzle from the
   * drawn wing (~20% of half-screen) to near the fuselage (~7%), which read
   * as "not firing from the wings". No factor here.
   *
   * Alternates L/R wing stations; falls back to the attitude wing offset
   * until the model is loaded.
   */
  _gunMuzzle(player, side) {
    try {
      const model = this.planeModel && this.planeModel.model;
      const cam = this.viewer && this.viewer.camera;
      if (!model || !cam || !cam.positionWC) return this._wingMuzzle(player, side);

      // ref-flight's exact wing station (their missile offset): 15.0 * side,
      // -15.0, 0.0 in model units, scaled + rotated with the drawn model.
      const offset = new THREE.Vector3(15.0 * side, -15.0, 0.0);
      const scaledOffset = offset.clone().multiplyScalar(model.scale.x);
      scaledOffset.applyQuaternion(model.quaternion);
      scaledOffset.add(model.position);

      // ref-flight's exact fov conversion: drawn (75 deg overlay) units to
      // world meters through the live Cesium fov.
      const planeFov = 75;
      const worldFov = Cesium.Math.toDegrees(cam.frustum.fovy);
      const factor = Math.tan(Cesium.Math.toRadians(worldFov) * 0.5)
        / Math.tan(Cesium.Math.toRadians(planeFov) * 0.5);
      scaledOffset.x *= factor;
      scaledOffset.y *= factor;

      const right = cam.right, up = cam.up, dir = cam.direction;
      const worldOffset = new Cesium.Cartesian3();
      const xVec = Cesium.Cartesian3.multiplyByScalar(right, scaledOffset.x, new Cesium.Cartesian3());
      const yVec = Cesium.Cartesian3.multiplyByScalar(up, scaledOffset.y, new Cesium.Cartesian3());
      const zVec = Cesium.Cartesian3.multiplyByScalar(dir, -scaledOffset.z, new Cesium.Cartesian3());
      Cesium.Cartesian3.add(xVec, yVec, worldOffset);
      Cesium.Cartesian3.add(worldOffset, zVec, worldOffset);

      const finalPos = Cesium.Cartesian3.add(cam.positionWC, worldOffset, new Cesium.Cartesian3());
      const carto = Cesium.Cartographic.fromCartesian(finalPos);
      return {
        lon: Cesium.Math.toDegrees(carto.longitude),
        lat: Cesium.Math.toDegrees(carto.latitude),
        alt: carto.height,
      };
    } catch (e) {
      return this._wingMuzzle(player, side);
    }
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