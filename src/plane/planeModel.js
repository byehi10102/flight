import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { CONFIG } from "../core/config.js";
import { JetFlame } from "./jetFlame.js";

// The Three.js camera stays at the origin looking down -Z.
// The plane sits at (0, -0.8, -2.75) — in front of the camera, slightly
// below — so the view is a chase cam from directly behind the tail.
// This matches ref-flight (dimartarmizi/web-flight-simulator) exactly.
const BASE_PLANE_POS = new THREE.Vector3(0, -0.8, -2.75);

/**
 * F-15 aircraft model loaded from a GLB file.
 * The model is placed at a local offset from the camera and rotates
 * based on user input (pitch, roll, yaw visual feedback).
 */
export class PlaneModel {
  constructor(scene) {
    this.scene = scene;
    this.model = null;
    this.ready = false;
    this.basePosition = BASE_PLANE_POS.clone();
    this.visualOffset = BASE_PLANE_POS.clone();
    this.visualRotation = new THREE.Euler(0, 0, 0);
    this.boostRoll = 0;
    this.currentBoostZOffset = 0;
    this.boostRollDirection = 1;
    this.lastIsBoosting = false;
    this.jetFlames = [];
    this.prevSpeed = 0;
  }

  async load() {
    const loader = new GLTFLoader();
    return new Promise((resolve, reject) => {
      loader.load(
        CONFIG.aircraft.modelUrl,
        (gltf) => {
          const mesh = gltf.scene;

          this.model = new THREE.Group();
          this.model.add(mesh);
          this.scene.add(this.model);

          // Set the model and all children to layer 1 so they render
          // as an overlay on top of the Cesium globe (layer 0)
          this.model.layers.set(1);
          this.model.traverse((child) => {
            child.layers.set(1);
          });

          // Center the mesh on its bounding box
          const box = new THREE.Box3().setFromObject(mesh);
          const center = box.getCenter(new THREE.Vector3());
          mesh.position.sub(center);

          this.model.position.copy(BASE_PLANE_POS);
          this.model.scale.set(CONFIG.aircraft.modelScale, CONFIG.aircraft.modelScale, CONFIG.aircraft.modelScale);

          // ref-flight plays the model's own animation clip once on load
          // (their 'flight_mode'); our F-15 ships the equivalent gear
          // animation as 'F15 ldg' - the wing/gear motion around the plane.
          try {
            this.mixer = new THREE.AnimationMixer(mesh);
            const clip = THREE.AnimationClip.findByName(gltf.animations, "F15 ldg")
              || (gltf.animations && gltf.animations[0]);
            if (clip) {
              const action = this.mixer.clipAction(clip);
              action.setLoop(THREE.LoopOnce);
              action.clampWhenFinished = true;
              action.play();
            }
          } catch (e) { /* model without clips: fine */ }

          // Jet exhaust flames — same offsets as ref-flight so the flames sit
          // in the tailpipes (+Z is behind the jet when nose points -Z).
          const flameL = new JetFlame();
          const flameR = new JetFlame();
          flameL.group.position.set(-0.4, -0.065, 5);
          flameR.group.position.set(0.4, -0.065, 5);
          this.model.add(flameL.group);
          this.model.add(flameR.group);
          this.jetFlames.push(flameL, flameR);
          this.model.traverse((child) => {
            child.layers.set(1);
          });

          this.ready = true;
          resolve(this.model);
        },
        undefined,
        (error) => {
          console.error("Model load error:", error);
          reject(error);
        }
      );
    });
  }

  update(state, input, dt, isBoosting) {
    if (!this.model) return;

    // Drive the model's own animation (gear/wing clip) like ref-flight's
    // mixer.update in the render loop.
    if (this.mixer && dt > 0) {
      try { this.mixer.update(dt); } catch (e) { /* cosmetic */ }
    }

    // W/throttle must NOT shove the jet around on screen — only the boost
    // gets a forward punch (boostZOffset below). So no accel-inertia slide.
    const speed = state.speed ?? this.prevSpeed;
    this.prevSpeed = speed;
    let targetZ = BASE_PLANE_POS.z;

    // Boost visual effects (copied from ref-flight)
    if (isBoosting && !this.lastIsBoosting) {
      this.boostRollDirection = Math.random() > 0.5 ? 1 : -1;
    }

    let boostZOffset = 0;
    if (isBoosting) {
      const T = state.boostDuration;
      const p = Math.max(0, Math.min(1, 1 - state.boostTimeRemaining / T));

      if (p < 0.2) {
        const localP = p / 0.2;
        boostZOffset = -(localP * localP) * 1.5;
        this.boostRoll = 0;
      } else if (p < 0.8) {
        const localP = (p - 0.2) / 0.6;
        boostZOffset = -1.5;
        const easedP = localP < 0.5
          ? 4 * localP * localP * localP
          : 1 - Math.pow(-2 * localP + 2, 3) / 2;
        this.boostRoll = easedP * (Math.PI * 2 * state.boostRotations) * this.boostRollDirection;
      } else {
        const localP = (p - 0.8) / 0.2;
        const easedReturn = localP * localP * (3 - 2 * localP);
        boostZOffset = -1.5 + easedReturn * 0.7;
        this.boostRoll = (Math.PI * 2 * state.boostRotations) * this.boostRollDirection;
      }
    } else {
      this.boostRoll = 0;
      boostZOffset = 0;
    }
    this.lastIsBoosting = isBoosting;

    const zLerp = isBoosting ? 10.0 * dt : 2.0 * dt;
    this.currentBoostZOffset += (boostZOffset - this.currentBoostZOffset) * zLerp;
    targetZ += this.currentBoostZOffset;

    // Idle wobble (ref-flight magnitudes)
    const time = performance.now() * 0.001;
    const idleX = Math.sin(time * 0.8) * 0.035;
    const idleY = Math.cos(time * 0.6) * 0.025;
    const idleRotX = Math.sin(time * 0.5) * 0.015;
    const idleRotY = Math.cos(time * 0.4) * 0.015;
    const idleRotZ = Math.sin(time * 0.7) * 0.025;

    // Visual offset based on input (ref-flight factors)
    const targetX = input.isDragging
      ? BASE_PLANE_POS.x
      : BASE_PLANE_POS.x - input.roll * 0.6 - input.yaw * 0.12 + idleX;
    const targetY = input.isDragging
      ? BASE_PLANE_POS.y
      : BASE_PLANE_POS.y - input.pitch * 0.1 + idleY;

    let targetRotZ = input.isDragging ? 0 : THREE.MathUtils.degToRad(-input.roll * 15) + idleRotZ;
    const targetRotX = input.isDragging ? 0 : THREE.MathUtils.degToRad(input.pitch * 10) + idleRotX;
    const targetRotY = input.isDragging ? 0 : THREE.MathUtils.degToRad(-input.yaw * 4) + idleRotY;

    const lerpFactor = isBoosting ? 3.0 * dt : 5.0 * dt;
    this.visualOffset.x += (targetX - this.visualOffset.x) * lerpFactor;
    this.visualOffset.y += (targetY - this.visualOffset.y) * lerpFactor;
    this.visualOffset.z += (targetZ - this.visualOffset.z) * lerpFactor;

    this.visualRotation.z += (targetRotZ - this.visualRotation.z) * lerpFactor;
    this.visualRotation.x += (targetRotX - this.visualRotation.x) * lerpFactor;
    this.visualRotation.y += (targetRotY - this.visualRotation.y) * lerpFactor;

    // Camera orbit from mouse drag (look around)
    const orbitQ = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(-input.cameraPitch),
        THREE.MathUtils.degToRad(-input.cameraYaw),
        0,
        "YXZ"
      )
    );

    this.model.position.copy(this.visualOffset);

    // FOV-compensated placement. main.js syncs the overlay camera's FOV to
    // the Cesium frustum (~30 deg vertical) so ref-flight bullets line up
    // with the world; these fixed offsets were tuned for the old 75 deg
    // overlay FOV. Under the narrow cone the raw offset falls OUTSIDE the
    // frustum's bottom edge (invisible jet). Lateral offset and size scale
    // by the live ratio k = tan(fov/2)/tan(75/2) while the DEPTH is kept:
    // (y*k)/z / tan(fov/2) == y/z / tan(37.5 deg), so the jet keeps its
    // exact original on-screen position and size at any synced FOV.
    const k = this.fovScale || 1;
    if (k !== 1) {
      this.model.position.set(this.model.position.x * k, this.model.position.y * k, this.model.position.z);
      const s = CONFIG.aircraft.modelScale * k;
      this.model.scale.set(s, s, s);
    }

    const flightLagQ = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(this.visualRotation.x, this.visualRotation.y, this.visualRotation.z + this.boostRoll)
    );

    const combinedQ = orbitQ.clone().invert().multiply(flightLagQ);
    this.model.quaternion.copy(combinedQ);

    // Afterburner flames follow throttle / boost, as in ref-flight
    if (this.jetFlames.length > 0) {
      const throttle = state.throttle ?? input.throttle ?? 0;
      for (const flame of this.jetFlames) {
        flame.update(throttle, isBoosting, time, dt);
      }
    }
  }

  reset() {
    this.visualOffset.copy(BASE_PLANE_POS);
    this.visualRotation.set(0, 0, 0);
    this.boostRoll = 0;
    this.currentBoostZOffset = 0;
    this.lastIsBoosting = false;
    this.prevSpeed = 0;
    if (this.model) this.model.visible = true;
  }
}
