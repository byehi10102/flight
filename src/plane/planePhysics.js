import * as THREE from "three";
import { CONFIG } from "../core/config.js";

/**
 * Realistic flight physics with lift, drag, stall, and coordinated turns.
 * Uses quaternion-based orientation for smooth, gimbal-lock-free rotation.
 */
export class PlanePhysics {
  constructor() {
    // State
    this.position = { lon: 0, lat: 0, alt: 0 };
    this.speed = 100;
    this.throttle = 0.5;
    this.heading = 0;
    this.pitch = 0;
    this.roll = 0;
    this.verticalSpeed = 0;
    this.stallFactor = 0;
    this.gLoad = 1;
    this.onGround = false;
    this.distanceFlown = 0;

    // Orientation quaternion
    this.quaternion = new THREE.Quaternion();

    // Boost
    this.isBoosting = false;
    this.boostTimeRemaining = 0;
    this.boostDuration = CONFIG.boost.duration;
    this.boostMultiplier = CONFIG.boost.multiplier;
    this.boostRotations = CONFIG.boost.rotations;
    this.boostPressed = false;

    // Air density at altitude (ISA model)
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

  /**
   * ISA air density at altitude
   */
  computeAirDensity(alt) {
    const T0 = CONFIG.physics.temperatureSeaLevel;
    const L = 0.0065; // temperature lapse rate
    const g = CONFIG.physics.gravity;
    const R = 287.05; // specific gas constant
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

    // Throttle from input
    this.throttle = input.throttle;

    // Air density at current altitude
    this.airDensity = this.computeAirDensity(Math.max(0, this.position.alt));

    // Dynamic pressure
    const q = 0.5 * this.airDensity * this.speed * this.speed;

    // Control effectiveness scales with airspeed
    const controlEffectiveness = Math.min(1, this.speed / 50);

    // Apply control inputs as rotation rates (radians/sec)
    const localPitch = input.pitch * P.pitchRate * dt * controlEffectiveness;
    const localRoll = input.roll * P.rollRate * dt * controlEffectiveness;
    const localYaw = input.yaw * P.yawRate * dt * controlEffectiveness;

    // Build incremental rotation quaternions
    const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), localPitch);
    const qRoll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), localRoll);
    const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), localYaw);

    // Apply rotations in local frame
    this.quaternion.multiply(qYaw);
    this.quaternion.multiply(qPitch);
    this.quaternion.multiply(qRoll);
    this.quaternion.normalize();

    // Extract heading, pitch, roll from quaternion
    const euler = new THREE.Euler().setFromQuaternion(this.quaternion, "YXZ");
    this.heading = THREE.MathUtils.radToDeg(euler.y);
    this.pitch = THREE.MathUtils.radToDeg(euler.x);
    this.roll = THREE.MathUtils.radToDeg(euler.z);

    // Normalize heading
    this.heading = ((this.heading % 360) + 360) % 360;

    // ── Aerodynamic forces ────────────────────────────────────────────────

    // Angle of attack
    const flightPathAngle = Math.atan2(this.verticalSpeed, Math.max(this.speed, 1));
    const alpha = THREE.MathUtils.degToRad(this.pitch) - flightPathAngle;

    // Lift coefficient with stall
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

    // Drag coefficient (parabolic drag polar)
    const CD = P.cd0 + P.inducedDragFactor * CL * CL;
    const flapsDrag = (input.deceleration ? 0.3 : 0) * q * 8;

    // Forces
    const weight = P.mass * P.gravity;
    const lift = Math.min(q * P.wingArea * CL, weight * 3); // load limit 3g
    const drag = q * (P.wingArea * CD + flapsDrag);

    // Thrust
    let thrust = this.throttle * P.maxThrust;
    // Thrust tapers with altitude
    thrust *= Math.max(0.25, 1 - 0.55 * (this.position.alt / P.ceiling));
    // Speed-dependent thrust falloff
    thrust *= Math.max(0.25, 1 - 0.75 * (this.speed / P.maxSpeed));
    // Boost
    if (this.isBoosting) {
      thrust *= this.boostMultiplier;
    }

    // ── Ground handling ───────────────────────────────────────────────────
    if (this.onGround) {
      // Rolling friction and braking
      const rollingFriction = P.groundFriction * weight;
      const braking = input.deceleration ? P.brakeFriction * weight : 0;

      // Ground acceleration
      const accel = (thrust - drag - rollingFriction - braking) / P.mass;
      this.speed = Math.max(0, this.speed + accel * dt);

      // Steering on ground (only when moving)
      if (this.speed > 1) {
        const steerAuthority = Math.min(1, this.speed / 20);
        this.heading = ((this.heading + input.roll * P.steerRate * steerAuthority * dt) % 360 + 360) % 360;
      }

      // Keep on ground
      this.position.alt = groundHeight + 2;
      this.verticalSpeed = 0;
      this.roll *= 0.9; // decay roll on ground

      // Natural liftoff: if lift exceeds weight, become airborne
      if (lift > weight * 1.05 && this.speed > P.rotationSpeed) {
        this.onGround = false;
        this.position.alt = groundHeight + 3;
        this.verticalSpeed = 2;
      }
    } else {
      // ── Airborne ─────────────────────────────────────────────────────────

      // Net perpendicular force (lift - weight component)
      const netPerp = lift - weight * Math.cos(THREE.MathUtils.degToRad(this.pitch));
      const verticalAccel = netPerp / P.mass;

      // Update vertical speed
      this.verticalSpeed += verticalAccel * dt;
      this.verticalSpeed = Math.max(-40, Math.min(40, this.verticalSpeed));

      // Forward acceleration
      const accel = (thrust - drag) / P.mass;
      this.speed = Math.max(P.minSpeed * 0.5, this.speed + accel * dt);

      // Coordinated turn: bank causes heading change
      const turnRate = (P.gravity * Math.tan(THREE.MathUtils.degToRad(this.roll))) / Math.max(this.speed, 20);
      this.heading = ((this.heading + THREE.MathUtils.radToDeg(turnRate) * dt) % 360 + 360) % 360;

      // G-load
      this.gLoad = lift / weight;

      // Pitch damping (pitch tends to follow flight path slowly)
      const targetPitch = THREE.MathUtils.radToDeg(flightPathAngle);
      this.pitch += (targetPitch - this.pitch) * 0.1 * dt;
    }

    // ── Position update ───────────────────────────────────────────────────
    const step = this.speed * dt;
    const headingRad = THREE.MathUtils.degToRad(this.heading);
    const pitchRad = THREE.MathUtils.degToRad(this.pitch);
    const R = 6371000;

    const dLat = (step * Math.cos(headingRad) * Math.cos(pitchRad)) / R;
    const dLon = (step * Math.sin(headingRad) * Math.cos(pitchRad)) / (R * Math.cos(THREE.MathUtils.degToRad(this.position.lat)));
    const dAlt = step * Math.sin(pitchRad);

    this.position.lon += THREE.MathUtils.radToDeg(dLon);
    this.position.lat += THREE.MathUtils.radToDeg(dLat);
    this.position.alt += dAlt;
    this.distanceFlown += step;

    // Wrap longitude
    if (this.position.lon > 180) this.position.lon -= 360;
    if (this.position.lon < -180) this.position.lon += 360;

    // Ceiling
    if (this.position.alt > P.ceiling) {
      this.position.alt = P.ceiling;
      this.verticalSpeed = Math.min(this.verticalSpeed, 0);
    }

    // Ground contact
    if (this.position.alt <= groundHeight + 1) {
      this.position.alt = groundHeight + 1;
      if (!this.onGround) {
        this.verticalSpeed = 0;
        this.pitch *= 0.4;
        this.roll *= 0.5;
      }
      this.onGround = true;
      if (this.speed < 5) this.throttle = Math.max(0, this.throttle - dt * 0.1);
    } else {
      this.onGround = false;
    }

    return {
      speed: this.speed,
      pitch: this.pitch,
      roll: this.roll,
      heading: this.heading,
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
