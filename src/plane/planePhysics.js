import * as THREE from "three";
import { CONFIG } from "../core/config.js";

/**
 * Flight model.
 *
 * Speed is driven by throttle: idle -> minSpeed, full -> maxSpeed, and boost
 * overrides both. The attitude is a single quaternion that the controls
 * rotate directly, and the aircraft travels wherever the nose points.
 *
 * Because movement uses the pitch angle itself, a pitch input always produces
 * motion in that same direction — the controls match the movement. The
 * horizontal component is scaled by cos(pitch), so the aircraft always moves
 * forward as well as up or down: never purely vertical.
 */
export class PlanePhysics {
  constructor() {
    this.position = { lon: 0, lat: 0, alt: 0 };
    this.speed = 0;
    this.throttle = 0;
    this.heading = 0;
    this.pitch = 0;
    this.roll = 0;

    this.quaternion = new THREE.Quaternion();

    this.isBoosting = false;
    this.boostTimeRemaining = 0;
    this.boostDuration = CONFIG.boost.duration;
    this.boostMultiplier = CONFIG.boost.multiplier;
    this.boostRotations = CONFIG.boost.rotations;
    this.boostPressed = false;

    this.onGround = false;
    this.distanceFlown = 0;
  }

  boost() {
    if (this.boostTimeRemaining <= 0) {
      this.isBoosting = true;
      this.boostTimeRemaining = this.boostDuration;
    }
  }

  reset(lon, lat, alt, heading, pitch, roll) {
    this.position.lon = lon;
    this.position.lat = lat;
    this.position.alt = alt;
    this.heading = heading || 0;
    this.pitch = pitch || 0;
    this.roll = roll || 0;
    this.speed = CONFIG.physics.minSpeed;
    this.throttle = 0;
    this.onGround = false;
    this.distanceFlown = 0;
    this.isBoosting = false;
    this.boostTimeRemaining = 0;

    const euler = new THREE.Euler(
      THREE.MathUtils.degToRad(this.pitch),
      THREE.MathUtils.degToRad(this.heading),
      THREE.MathUtils.degToRad(this.roll),
      "YXZ"
    );
    this.quaternion.setFromEuler(euler);
  }

  update(input, dt) {
    const P = CONFIG.physics;

    // ── Boost timer ─────────────────────────────────────────────────────────
    if (this.boostTimeRemaining > 0) {
      this.boostTimeRemaining -= dt;
      if (this.boostTimeRemaining <= 0) {
        this.isBoosting = false;
        this.boostTimeRemaining = 0;
      }
    }

    if (input.boost) {
      if (!this.boostPressed && !this.isBoosting) this.boost();
      this.boostPressed = true;
    } else {
      this.boostPressed = false;
    }

    this.throttle = input.throttle;

    // ── Speed ───────────────────────────────────────────────────────────────
    // The throttle sets a target airspeed and the aircraft eases toward it.
    // Without this the speed never changes and the world appears frozen
    // relative to the controls.
    let targetSpeed = P.minSpeed + this.throttle * (P.maxSpeed - P.minSpeed);
    if (this.isBoosting) targetSpeed = P.maxSpeed * this.boostMultiplier;
    this.speed += (targetSpeed - this.speed) * dt * (this.isBoosting ? 4 : 2);

    // ── Attitude ────────────────────────────────────────────────────────────
    // Control authority scales with airspeed: sluggish on the approach,
    // responsive at cruise.
    const controlEffectiveness = this.speed > P.minSpeed ? 1 : this.speed / P.minSpeed;

    const localPitch = input.pitch * P.pitchRate * dt * controlEffectiveness;
    const localRoll = input.roll * P.rollRate * dt * controlEffectiveness;
    const localYaw = input.yaw * P.yawRate * dt * controlEffectiveness;

    const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), localPitch);
    const qRoll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), localRoll);
    const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), localYaw);

    this.quaternion.multiply(qYaw);
    this.quaternion.multiply(qPitch);
    this.quaternion.multiply(qRoll);
    this.quaternion.normalize();

    // YXZ keeps heading as the primary rotation, pitch/roll relative to it.
    const euler = new THREE.Euler().setFromQuaternion(this.quaternion, "YXZ");
    this.heading = THREE.MathUtils.radToDeg(euler.y);
    this.pitch = THREE.MathUtils.radToDeg(euler.x);
    this.roll = THREE.MathUtils.radToDeg(euler.z);

    this.distanceFlown += this.speed * dt;

    return {
      speed: this.speed,
      pitch: this.pitch,
      roll: this.roll,
      heading: this.heading,
      isBoosting: this.isBoosting,
      boostTimeRemaining: this.boostTimeRemaining,
      boostDuration: this.boostDuration,
      boostRotations: this.boostRotations,
      onGround: this.onGround,
    };
  }
}
