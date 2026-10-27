import * as THREE from 'three';
import { CONFIG } from '../core/config.js';

/**
 * Helicopter flight model — the same result shape as PlanePhysics, so
 * main.js branches ONCE on vehicle type and everything downstream (HUD,
 * camera, crash checks, minimap, multiplayer broadcast) is unchanged.
 *
 * Real rotorcraft behaviour, arcade-tuned (the model worldflightsimulator.com
 * flies, adapted to this game's lon/lat/alt + heading/pitch/roll state):
 *
 *   - The stick commands ATTITUDE, not rate. Cyclic tips the disc (capped at
 *     ±maxPitch / ±maxBank) and the TIP is what moves you; releasing the stick
 *     targets level, so there is no separate auto-level.
 *   - W/S is the COLLECTIVE, mapped around the hover point: 50% holds
 *     altitude, above it climbs, below it descends — a climb RATE you can fly.
 *   - A/D are the pedals (yaw in place); bank also turns the machine, so a
 *     turn can be flown on the cyclic alone.
 *   - Speed is tilt-driven and includes reverse: full nose-up backs up slowly.
 *     There is no stall — a helicopter has full authority at zero airspeed.
 *
 * Movement still happens in main.js via movePosition() exactly like the
 * plane; this class only decides speed / pitch / roll / heading and the
 * vertical velocity (returned as `vSpeed`, which main.js adds to altitude).
 */
export class HeliPhysics {
	constructor() {
		const c = CONFIG.heli;
		this.config = c;

		this.speed = 0;              // horizontal ground speed, MPH
		this.maxSpeed = c.maxSpeedMph;
		this.minSpeed = 0;
		this.throttle = c.hoverCollective; // collective 0..1 (W/S lever)
		this.vSpeed = 0;             // vertical velocity, m/s

		this.pitch = 0;
		this.roll = 0;
		this.heading = 0;

		// Pitch/roll are commanded attitudes in degrees (signed): negative
		// pitch = nose-down (forward), matching the plane's convention where
		// ArrowUp gives input.pitch = -1.
		this.rateP = 0;
		this.rateR = 0;
		this.rateY = 0;

		// Rotor spool for the visual spin + thrust authority (governed RPM:
		// spools to 1 and stays there, like a real governor).
		this.rotor = 0;

		// Boost = rotor overspeed dash; same meter contract as the plane so
		// the HUD boost bar just works.
		this.isBoosting = false;
		this.boostTimeRemaining = 0;
		this.boostDuration = 3.0;
		this.boostMultiplier = 2.0;
		this.boostRotations = 0;
		this.boostPressed = false;
		this.boostCharge = 1;

		this.quaternion = new THREE.Quaternion();
	}

	boost() {
		if (this.boostTimeRemaining <= 0 && this.boostCharge >= 0.999) {
			this.isBoosting = true;
			this.boostTimeRemaining = this.boostDuration;
		}
	}

	reset(lon, lat, alt, heading, pitch, roll) {
		this.heading = heading || 0;
		this.pitch = 0;
		this.roll = 0;
		this.speed = 0;
		this.vSpeed = 0;
		this.throttle = this.config.hoverCollective;
		this.rotor = 0;
		this.isBoosting = false;
		this.boostTimeRemaining = 0;
		this.boostCharge = 1;
	}

	update(input, dt) {
		const c = this.config;

		// ── boost (rotor overspeed dash) ────────────────────────────────────
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
		if (this.isBoosting) {
			this.boostCharge = Math.max(0, this.boostCharge - dt / this.boostDuration);
		} else {
			this.boostCharge = Math.min(1, this.boostCharge + dt / 3.0);
		}

		// ── rotor: governed RPM ─────────────────────────────────────────────
		this.rotor += (1 - this.rotor) * Math.min(1, dt / c.rotorSpinRate);

		// ── collective: W/S around the hover point ──────────────────────────
		// input.throttle is the controller's latching 0..1 lever (W raises it,
		// S lowers it, release holds). Spawn sets it to the hover point.
		const collective = Math.max(0, Math.min(1, input.throttle));

		// Climb/descent RATE from the lever: hover = hold, full up = climb.
		const rateSpan = collective >= c.hoverCollective
			? (collective - c.hoverCollective) / (1 - c.hoverCollective)
			: (c.hoverCollective - collective) / c.hoverCollective;
		const vTarget = collective >= c.hoverCollective
			? rateSpan * c.climbRateMps
			: -rateSpan * c.descentRateMps;
		// Rotor RPM scales vertical authority until the blades are up to speed.
		this.vSpeed += (vTarget * (0.25 + 0.75 * this.rotor) - this.vSpeed) * Math.min(1, dt * 3);

		// ── attitude command (cyclic) ────────────────────────────────────────
		// This game's controller convention (PlaneController): ArrowUp = -1,
		// ArrowDown = +1, ArrowRight/D = +1, A = -1. For the rotorcraft the
		// stick means DIRECTION OF TRAVEL, so ArrowUp tips the disc FORWARD
		// (nose down = negative pitch in the YXZ euler the camera shares)
		// and ArrowDown tips it back — that also gives reverse on full back
		// tilt. Right input banks right (positive euler.z), matching §24's
		// "positive roll = right".
		const maxP = THREE.MathUtils.degToRad(c.maxPitchDeg);
		const maxB = THREE.MathUtils.degToRad(c.maxBankDeg);
		const tgtPitch = THREE.MathUtils.clamp(input.pitch, -1, 1) * maxP;
		const tgtRoll = THREE.MathUtils.clamp(input.roll, -1, 1) * maxB;
		const k = 1 - Math.exp(-dt * c.attitudeRate);

		// Euler YXZ so yaw stays independent of the tilt.
		const e = new THREE.Euler().setFromQuaternion(this.quaternion, 'YXZ');
		e.x += (tgtPitch - e.x) * k;
		e.z += (tgtRoll - e.z) * k;
		e.x = THREE.MathUtils.clamp(e.x, -maxP, maxP);
		e.z = THREE.MathUtils.clamp(e.z, -maxB, maxB);

		// ── yaw: pedals + bank-coupled turn ─────────────────────────────────
		// Pedals: A (-1) must turn LEFT, i.e. e.y DECREASES (decreasing
		// heading is counterclockwise; movePosition maps +heading clockwise).
		this.rateY += ((input.yaw * c.tailYawRate) - this.rateY) * (1 - Math.exp(-dt * 4.5));
		e.y += this.rateY * dt;
		// Bank-driven turn: a right bank (e.z > 0) must turn right, so e.y
		// grows with the sine of the bank — fly a turn on the cyclic alone.
		e.y += Math.sin(e.z) * c.bankTurnRate * dt;

		this.quaternion.setFromEuler(e);
		const out = new THREE.Euler().setFromQuaternion(this.quaternion, 'YXZ');
		this.pitch = THREE.MathUtils.radToDeg(out.x);
		this.roll = THREE.MathUtils.radToDeg(out.z);
		this.heading = THREE.MathUtils.radToDeg(out.y);

		// ── speed from tilt ──────────────────────────────────────────────────
		// Nose-down (-pitch) = forward. Tilt fraction × the speed the disc can
		// pull, with a top-speed dash while boosting.
		const top = this.isBoosting ? c.maxSpeedMph * this.boostMultiplier : c.maxSpeedMph;
		const fwd = THREE.MathUtils.clamp(-out.x / maxP, -1, 1);
		const target = fwd >= 0 ? fwd * top : fwd * c.reverseSpeedMph;
		const spool = 0.2 + 0.8 * this.rotor; // no sideways flight at rotor start
		this.speed += ((target * spool) - this.speed) * Math.min(1, dt * 1.6);

		return {
			speed: this.speed,
			pitch: this.pitch,
			roll: this.roll,
			heading: this.heading,
			vSpeed: this.vSpeed,
			isBoosting: this.isBoosting,
			boostTimeRemaining: this.boostTimeRemaining,
			boostDuration: this.boostDuration,
			boostRotations: this.boostRotations,
			boostCharge: this.boostCharge,
			rotor: this.rotor,
		};
	}
}
