import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { CONFIG } from "../core/config.js";

const BASE_PLANE_POS = new THREE.Vector3(0, -0.8, -2.75);

/**
 * F-15 aircraft model loaded from a GLB file.
 * The model is centered, scaled, and positioned relative to the camera.
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

          // Center the mesh
          const box = new THREE.Box3().setFromObject(mesh);
          const center = box.getCenter(new THREE.Vector3());
          mesh.position.sub(center);

          this.model.position.copy(BASE_PLANE_POS);
          this.model.scale.set(CONFIG.aircraft.modelScale, CONFIG.aircraft.modelScale, CONFIG.aircraft.modelScale);

          this.ready = true;
          resolve(this.model);
        },
        undefined,
        reject
      );
    });
  }

  update(state, input, dt, isBoosting) {
    if (!this.model) return;

    if (isBoosting && !this.lastIsBoosting) {
      this.boostRollDirection = Math.random() > 0.5 ? 1 : -1;
    }

    let boostZOffset = 0;
    if (isBoosting) {
      const T = state.boostDuration;
      const p = Math.max(0, Math.min(1, 1 - state.boostTimeRemaining / T));
      const totalRotationRad = Math.PI * 2 * state.boostRotations * this.boostRollDirection;

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
        this.boostRoll = easedP * Math.PI * 2 * state.boostRotations * this.boostRollDirection;
      } else {
        const localP = (p - 0.8) / 0.2;
        const easedReturn = localP * localP * (3 - 2 * localP);
        boostZOffset = -1.5 + easedReturn * 0.7;
        this.boostRoll = Math.PI * 2 * state.boostRotations * this.boostRollDirection;
      }
    } else {
      this.boostRoll = 0;
      boostZOffset = 0;
    }
    this.lastIsBoosting = isBoosting;

    const zLerp = isBoosting ? 10.0 * dt : 2.0 * dt;
    this.currentBoostZOffset += (boostZOffset - this.currentBoostZOffset) * zLerp;
    const targetZ = BASE_PLANE_POS.z - this.currentBoostZOffset;

    const time = performance.now() * 0.001;
    const idleX = Math.sin(time * 0.8) * 0.035;
    const idleY = Math.cos(time * 0.6) * 0.025;
    const idleRotX = Math.sin(time * 0.5) * 0.015;
    const idleRotY = Math.cos(time * 0.4) * 0.015;
    const idleRotZ = Math.sin(time * 0.7) * 0.025;

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

    const orbitQ = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(-input.cameraPitch),
        THREE.MathUtils.degToRad(-input.cameraYaw),
        0,
        "YXZ"
      )
    );

    this.model.position.copy(this.visualOffset);

    const flightLagQ = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(this.visualRotation.x, this.visualRotation.y, this.visualRotation.z + this.boostRoll)
    );

    const combinedQ = orbitQ.clone().invert().multiply(flightLagQ);
    this.model.quaternion.copy(combinedQ);
  }

  reset() {
    this.visualOffset.copy(BASE_PLANE_POS);
    this.visualRotation.set(0, 0, 0);
    this.boostRoll = 0;
    this.currentBoostZOffset = 0;
    this.lastIsBoosting = false;
  }
}
