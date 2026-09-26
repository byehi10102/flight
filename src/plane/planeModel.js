import * as THREE from "three";
import { CONFIG } from "../core/config.js";

const BASE_PLANE_POS = new THREE.Vector3(0, -0.8, -2.75);

/**
 * Three.js plane model — built from primitives for a clean, recognisable jet shape.
 * The model is positioned relative to the camera and follows the aircraft state.
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
    this.engineGlow = null;
    this.afterburnerLight = null;
  }

  async load() {
    this.model = new THREE.Group();

    // Fuselage — long cylinder
    const fuselageGeo = new THREE.CylinderGeometry(0.35, 0.15, 8, 12);
    const fuselageMat = new THREE.MeshPhongMaterial({ color: 0xcccccc, shininess: 80 });
    const fuselage = new THREE.Mesh(fuselageGeo, fuselageMat);
    fuselage.rotation.x = Math.PI / 2;
    this.model.add(fuselage);

    // Nose cone
    const noseGeo = new THREE.ConeGeometry(0.35, 1.5, 12);
    const nose = new THREE.Mesh(noseGeo, fuselageMat);
    nose.rotation.x = -Math.PI / 2;
    nose.position.z = -4.75;
    this.model.add(nose);

    // Cockpit
    const cockpitGeo = new THREE.SphereGeometry(0.3, 8, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    const cockpitMat = new THREE.MeshPhongMaterial({ color: 0x224488, shininess: 120 });
    const cockpit = new THREE.Mesh(cockpitGeo, cockpitMat);
    cockpit.position.set(0, 0.2, -3.5);
    this.model.add(cockpit);

    // Main wings
    const wingGeo = new THREE.BoxGeometry(12, 0.08, 1.8);
    const wingMat = new THREE.MeshPhongMaterial({ color: 0xaaaaaa, shininess: 60 });
    const wings = new THREE.Mesh(wingGeo, wingMat);
    wings.position.set(0, 0, -0.5);
    this.model.add(wings);

    // Wing tips (missile rails)
    const tipGeo = new THREE.BoxGeometry(0.15, 0.15, 1.2);
    const tipMat = new THREE.MeshPhongMaterial({ color: 0x666666 });
    const leftTip = new THREE.Mesh(tipGeo, tipMat);
    leftTip.position.set(-5.8, 0, -0.5);
    this.model.add(leftTip);
    const rightTip = new THREE.Mesh(tipGeo, tipMat);
    rightTip.position.set(5.8, 0, -0.5);
    this.model.add(rightTip);

    // Horizontal stabilisers
    const hStabGeo = new THREE.BoxGeometry(4, 0.06, 1.2);
    const hStab = new THREE.Mesh(hStabGeo, wingMat);
    hStab.position.set(0, 0, 3.5);
    this.model.add(hStab);

    // Vertical stabiliser (tail)
    const vStabGeo = new THREE.BoxGeometry(0.08, 2, 1.5);
    const vStab = new THREE.Mesh(vStabGeo, wingMat);
    vStab.position.set(0, 1, 3.5);
    this.model.add(vStab);

    // Engine glow (afterburner)
    const glowGeo = new THREE.CylinderGeometry(0.2, 0.3, 1.5, 8);
    const glowMat = new THREE.MeshBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.8 });
    const glowL = new THREE.Mesh(glowGeo, glowMat);
    glowL.rotation.x = Math.PI / 2;
    glowL.position.set(-0.6, 0, 4.5);
    this.model.add(glowL);
    const glowR = new THREE.Mesh(glowGeo, glowMat);
    glowR.rotation.x = Math.PI / 2;
    glowR.position.set(0.6, 0, 4.5);
    this.model.add(glowR);
    this.engineGlow = [glowL, glowR];

    // Afterburner point light
    this.afterburnerLight = new THREE.PointLight(0x4488ff, 0, 20);
    this.afterburnerLight.position.set(0, 0, 5);
    this.model.add(this.afterburnerLight);

    this.model.position.copy(BASE_PLANE_POS);
    this.scene.add(this.model);
    this.ready = true;
  }

  update(state, input, dt, isBoosting) {
    if (!this.model) return;

    // Boost visual effects
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

    // Idle wobble
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

    // Camera orbit from mouse drag
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

    // Afterburner glow
    if (this.engineGlow) {
      const glowIntensity = isBoosting ? 1.0 : 0.3;
      this.engineGlow.forEach((g) => {
        g.material.opacity = glowIntensity;
        g.scale.set(isBoosting ? 1.5 : 1.0, isBoosting ? 1.5 : 1.0, isBoosting ? 2.0 : 1.0);
      });
    }
    if (this.afterburnerLight) {
      this.afterburnerLight.intensity = isBoosting ? 5.0 : 0;
    }
  }

  reset() {
    this.visualOffset.copy(BASE_PLANE_POS);
    this.visualRotation.set(0, 0, 0);
    this.boostRoll = 0;
    this.currentBoostZOffset = 0;
    this.lastIsBoosting = false;
  }
}
