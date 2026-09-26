import * as THREE from "three";
import { CONFIG } from "../core/config.js";

/**
 * Flight physics with proper flight-path-angle model.
 * The aircraft always moves forward along its flight path.
 * Pitch input changes the flight path angle (diagonal climb/descend),
 * not just the nose attitude.
 */
export class PlanePhysics {
  constructor() {
    this.position = { lon: 0, lat: 0, alt: 0 };
    this.speed = 100;
    this.throttle = 0.5;
    this.heading = 0;
    this.pitch = 0;       // nose attitude (degrees)
    this.roll = 0;         // bank angle (degrees)
    this.flightPathAngle = 0; // gamma: actual descent/climb angle (degrees)
    this.verticalSpeed = 0;
    this.stallFactor = 0;
    this.gLoad = 1;
    this.onGround = false;
    this.distanceFlown = 0;

    this.quaternion = new THREE.Quaternion();

    this.isBoosting = false;
    this.boostTimeRemaining = 0;
    this.boostDuration = CONFIG.boost.duration;
    this.boostMultiplier = CONFIG.boost.multiplier;
    this.boostRotations = CONFIG.boost.rotations;
    this.boostPressed = false;

    this.airDensity = CONFIG.physics.densitySeaLevel;
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
    this.flightPathAngle = 0;
    this.speed = 100;
    this.throttle = 0.5;
    this.verticalSpeed = 0;
    this.stallFactor = 0;
    this.gLoad = 1;
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

  computeAirDensity(alt) {
    const T0 = CONFIG.physics.temperatureSeaLevel;
    const L = 0.0065;
    const g = CONFIG.physics.gravity;
    const R = 287.05;
    const rho0 = CONFIG.physics.densitySeaLevel;
    const T = T0 - L * alt;
    if (T <= 0) return 0.01;
    return rho0 * Math.pow(T / T0, g / (R * L));
  }

  update(input, dt, groundHeight) {
    const P = CONFIG.physics;

    // Boost timer
    if (this.boostTimeRemaining > 0) {
      this.boostTimeRemaining -= dt;
      if (this.boostTimeRemaining <= 0) {
        this.isBoosting = false;
        this.boostTimeRemaining = 0;
      }
    }

    if (input.boost) {
      if (!this.boostPressed && !this.isBoosting) {
        this.boost();
      }
      this.boostPressed = true;
    } else {
      this.boostPressed = false;
    }

    this.throttle = input.throttle;

    // Air density
    this.airDensity = this.computeAirDensity(Math.max(0, this.position.alt));
    const q = 0.5 * this.airDensity * this.speed * this.speed;

    // Control effectiveness scales with dynamic pressure
    const controlEffectiveness = Math.min(1, this.speed / 50);

    // ── Attitude update (nose direction) ────────────────────────────────────
    // Pitch input rotates the nose up/down relative to the flight path
    const pitchRateRad = THREE.MathUtils.degToRad(P.pitchRate);
    const rollRateRad = THREE.MathUtils.degToRad(P.rollRate);
    const yawRateRad = THREE.MathUtils.degToRad(P.yawRate);

    const localPitch = input.pitch * pitchRateRad * dt * controlEffectiveness;
    const localRoll = input.roll * rollRateRad * dt * controlEffectiveness;
    const localYaw = input.yaw * yawRateRad * dt * controlEffectiveness;

    const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), localPitch);
    const qRoll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), localRoll);
    const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), localYaw);

    this.quaternion.multiply(qYaw);
    this.quaternion.multiply(qPitch);
    this.quaternion.multiply(qRoll);
    this.quaternion.normalize();

    const euler = new THREE.Euler().setFromQuaternion(this.quaternion, "YXZ");
    this.pitch = THREE.MathUtils.radToDeg(euler.x);
    this.roll = THREE.MathUtils.radToDeg(euler.z);
    this.heading = ((THREE.MathUtils.radToDeg(euler.y) % 360) + 360) % 360;

    // ── Aerodynamic forces ─────────────────────────────────────────────────
    const pitchRad = THREE.MathUtils.degToRad(this.pitch);
    const alpha = pitchRad - THREE.MathUtils.degToRad(this.flightPathAngle);

    let CL = P.cl0 + P.clAlpha * alpha;
    const stallAngle = P.stallAngle;
    if (alpha > stallAngle) {
      const over = (alpha - stallAngle) / 0.12;
      CL = P.cl0 + P.clAlpha * stallAngle - P.clAlpha * over * 0.3;
      this.stallFactor = Math.min(1, over);
    } else {
      this.stallFactor = Math.max(0, this.stallFactor - dt * 1.5);
    }
    CL = Math.max(-0.9, Math.min(P.clMax, CL));

    const CD = P.cd0 + P.inducedDragFactor * CL * CL;
    const flapsDrag = (input.deceleration ? 0.3 : 0) * q * 8;

    const weight = P.mass * P.gravity;
    const lift = Math.min(q * P.wingArea * CL, weight * 3);
    const drag = q * (P.wingArea * CD + flapsDrag);

    let thrust = this.throttle * P.maxThrust;
    thrust *= Math.max(0.25, 1 - 0.55 * (this.position.alt / P.ceiling));
    thrust *= Math.max(0.25, 1 - 0.75 * (this.speed / P.maxSpeed));
    if (this.isBoosting) {
      thrust *= this.boostMultiplier;
    }

    // ── Flight path angle update ────────────────────────────────────────────
    // The flight path angle (gamma) is the actual descent/climb angle.
    // It is determined by the balance of forces perpendicular to the flight path.
    // When the nose is above the flight path (positive alpha), lift pulls the
    // flight path up. When the nose is below, the flight path descends.
    if (!this.onGround) {
      // Specific excess power determines climb/descend
      const excessThrust = thrust - drag;
      const climbRate = (excessThrust * this.speed) / weight; // sinus approximation
      const targetGamma = THREE.MathUtils.radToDeg(Math.asin(Math.max(-1, Math.min(1, climbRate / Math.max(this.speed, 1)))));

      // Gamma is also pulled toward the nose attitude by lift
      const liftFactor = Math.min(1, lift / weight);
      const noseInfluence = (this.pitch - this.flightPathAngle) * 0.15 * liftFactor;
      this.flightPathAngle += (noseInfluence + (targetGamma - this.flightPathAngle) * 0.05) * dt;
      this.flightPathAngle = Math.max(-30, Math.min(30, this.flightPathAngle));

      this.verticalSpeed = this.speed * Math.sin(THREE.MathUtils.degToRad(this.flightPathAngle));

      // Coordinated turn
      const authority = Math.min(1, (q * P.wingArea) / (P.mass * 8));
      const turnRate = (P.gravity * Math.tan(THREE.MathUtils.degToRad(this.roll)))
        / Math.max(this.speed, 20) * (0.55 + 0.45 * authority);
      this.heading = ((this.heading + THREE.MathUtils.radToDeg(turnRate) * dt) % 360 + 360) % 360;

      this.gLoad = lift / weight;
    }

    // ── Position update ───────────────────────────────────────────────────
    const step = this.speed * dt;
    const headingRad = THREE.MathUtils.degToRad(this.heading);
    const gammaRad = THREE.MathUtils.degToRad(this.flightPathAngle);
    const R = 6371000;

    const dLat = (step * Math.cos(headingRad) * Math.cos(gammaRad)) / R;
    const dLon = (step * Math.sin(headingRad) * Math.cos(gammaRad)) / (R * Math.cos(THREE.MathUtils.degToRad(this.position.lat)));
    const dAlt = step * Math.sin(gammaRad);

    this.position.lon += THREE.MathUtils.radToDeg(dLon);
    this.position.lat += THREE.MathUtils.radToDeg(dLat);
    this.position.alt += dAlt;
    this.distanceFlown += step;

    if (this.position.lon > 180) this.position.lon -= 360;
    if (this.position.lon < -180) this.position.lon += 360;

    if (this.position.alt > P.ceiling) {
      this.position.alt = P.ceiling;
      this.flightPathAngle = Math.min(this.flightPathAngle, 0);
    }

    // Ground contact
    if (this.position.alt <= groundHeight + 1) {
      this.position.alt = groundHeight + 1;
      if (!this.onGround) {
        this.flightPathAngle = 0;
        this.verticalSpeed = 0;
        this.pitch *= 0.4;
        this.roll *= 0.5;
      }
      this.onGround = true;
      this.flightPathAngle = 0;
      if (this.speed < 5) this.throttle = Math.max(0, this.throttle - dt * 0.1);
    } else {
      this.onGround = false;
    }

    return {
      speed: this.speed,
      pitch: this.pitch,
      roll: this.roll,
      heading: this.heading,
      flightPathAngle: this.flightPathAngle,
      isBoosting: this.isBoosting,
      boostTimeRemaining: this.boostTimeRemaining,
      boostDuration: this.boostDuration,
      boostRotations: this.boostRotations,
      stallFactor: this.stallFactor,
      gLoad: this.gLoad,
      onGround: this.onGround,
      airDensity: this.airDensity,
    };
  }
}
