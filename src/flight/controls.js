/**
 * Input → ramped control axes.
 *
 * Your spec, exactly:
 *   Ground:  W accelerate · S brake · A left · D right
 *   Air:     W accelerate · A/← left · D/→ right · ↑ nose up · ↓ nose down ·
 *            S flaps (slow down)
 *   Release: auto-level.
 *
 * A key press does NOT set pitch to +X. It moves a target and a separate value
 * ramps toward that target at a finite rate; a release ramps back to zero (or,
 * for pitch in the air, hands off to the altitude hold). That indirection is
 * the whole trick.
 */
import { CONFIG } from "../core/config.js";
import { clamp } from "./physics.js";

const { controls: C, physics: P } = CONFIG;
const SWALLOW = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Space",
]);

export class Controls {
  constructor(target = window) {
    this.keys = Object.create(null);
    this.enabled = true;
    this._onDown = (e) => {
      if (SWALLOW.has(e.code)) e.preventDefault();
      if (!this.enabled) return;
      this.keys[e.code] = true;
    };
    this._onUp = (e) => {
      if (SWALLOW.has(e.code)) e.preventDefault();
      this.keys[e.code] = false;
    };
    this._onBlur = () => {
      for (const k in this.keys) this.keys[k] = false;
    };
    target.addEventListener("keydown", this._onDown, { passive: false });
    target.addEventListener("keyup", this._onUp, { passive: false });
    target.addEventListener("blur", this._onBlur);
    this._target = target;
  }
  destroy() {
    this._target.removeEventListener("keydown", this._onDown);
    this._target.removeEventListener("keyup", this._onUp);
    this._target.removeEventListener("blur", this._onBlur);
  }
  static ramp(current, target, upRate, downRate, dt) {
    const rate = Math.abs(target) > Math.abs(current) ? upRate : downRate;
    const delta = target - current;
    const step = rate * dt;
    return Math.abs(delta) <= step ? target : current + Math.sign(delta) * step;
  }
  get held() {
    const k = this.keys;
    return {
      forward: !!k.KeyW,
      back: !!k.KeyS,
      left: !!(k.KeyA || k.ArrowLeft),
      right: !!(k.KeyD || k.ArrowRight),
      up: !!k.ArrowUp,
      down: !!k.ArrowDown,
    };
  }
}

/**
 * @param {object} axis  persistent {pitch, roll, throttle, brakes, flaps}
 * @param {object} hold  persistent altitude-hold latch
 * @param {Controls} input
 * @param {object} plane aircraft state (mutated)
 * @param {number} dt    fixed timestep
 */
export function updateAxes(axis, hold, input, plane, dt) {
  const k = input.held;

  axis.throttle = Controls.ramp(
    axis.throttle, k.forward ? 1 : P.idleThrustFrac, C.throttleUpRate, C.throttleDownRate, dt,
  );
  plane.throttle = axis.throttle;

  // S brakes on the ground and extends flaps to slow the aircraft in the air.
  axis.brakes = plane.onGround && k.back;
  const flapTarget = (!plane.onGround && k.back) ? 0.30 : 0;
  axis.flaps = Controls.ramp(axis.flaps || 0, flapTarget, C.axisRampUp, C.axisRampDown, dt);
  plane.flaps = axis.flaps;

  const turnTarget = (k.right ? 1 : 0) - (k.left ? 1 : 0);
  const maxBank = plane.onGround ? 0 : P.maxBank;
  axis.roll = Controls.ramp(axis.roll, turnTarget * maxBank, C.axisRampUp, C.bankLevelRate, dt);
  plane.roll = axis.roll;

  // Pitch is driven by ArrowUp / ArrowDown on the ground too, so the pilot can
  // rotate for a manual liftoff by pulling back while rolling.
  const pitchTarget = (k.up ? 1 : 0) - (k.down ? 1 : 0);
  axis.pitch = Controls.ramp(axis.pitch, pitchTarget * P.maxPitch, C.axisRampUp, C.axisRampDown, dt);

  if (k.up || k.down) {
    plane.pitch = clamp(axis.pitch, -P.maxPitch, P.maxPitch);
    hold.armed = false;
  } else if (!plane.onGround) {
    axis.pitch = Controls.ramp(axis.pitch, 0, C.autoLevelRate, C.autoLevelRate, dt);
    if (!hold.armed) { hold.armed = true; hold.targetAlt = plane.alt; hold.integral = 0; }
    const altError = hold.targetAlt - plane.alt;
    const rateError = -plane.verticalSpeed;
    hold.integral = clamp(hold.integral + altError * dt, -C.holdIntegralLimit, C.holdIntegralLimit);
    // Lift-required AoA for level flight at this speed — the trim baseline the
    // jet needs before any altitude correction is applied.
    const dynQ = 0.5 * P.densitySeaLevel * plane.speed * plane.speed;
    const clNeeded = clamp((P.mass * 9.80665) / (dynQ * P.wingArea), 0, P.clMax);
    const baseAoA = Math.max(0, (clNeeded - P.cl0) / P.clAlpha);
    // Cap the derivative kick so a vertical-speed transient doesn't slam the
    // elevator to the stop (which drives the jet into the stall/deck).
    const dTerm = clamp(rateError * C.holdGainD, -0.06, 0.06);
    const trim = baseAoA + altError * C.holdGainP + dTerm + hold.integral * C.holdGainI;
    plane.pitch = clamp(trim, -C.holdPitchLimit, C.holdPitchLimit);
    // Anti-stall safety net: if the hold pinned the nose up into the stall region
    // while descending, bleed pitch back so the wing flies again (breaks a lock).
    // AoA limiter — cap pitch so the wing never exceeds stall-AoA by more than a
    // margin. This lets the hold pitch up to climb (recovering from a dive) while
    // guaranteeing the wing stays flying. Replaces the old nose-down "anti-stall"
    // which killed lift and drove the jet into the deck on climb-back.
    const flightPath = Math.atan2(plane.verticalSpeed, Math.max(plane.speed, 20));
    const stallAngle = (P.clMax - P.cl0) / P.clAlpha;
    const maxSafePitch = Math.min(C.holdPitchLimit, stallAngle - 0.05 + flightPath);
    plane.pitch = Math.min(plane.pitch, maxSafePitch);
  } else {
    axis.pitch = Controls.ramp(axis.pitch, 0, C.autoLevelRate, C.autoLevelRate, dt);
    plane.pitch = clamp(axis.pitch, -0.05, P.maxPitch);
    hold.armed = false;
  }

  return axis;
}

export { SWALLOW };
