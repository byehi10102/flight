/**
 * Input → ramped control axes.
 *
 * Your spec, exactly:
 *   Ground:  W accelerate · S brakes · A left · D right
 *   Air:     W accelerate · A/← left · D/→ right · ↑ nose up · ↓ nose down
 *   Release: the plane keeps doing what it was doing, then auto-levels.
 *
 * The only thing standing between "keys are booleans" and "controls feel
 * smooth" is this file. A key press does NOT set pitch to +X. It moves a
 * target, and a separate value ramps toward that target at a finite rate. A
 * key release ramps the axis back to zero (or, for pitch, hands over to the
 * altitude-hold controller). That single indirection is the whole trick.
 *
 * Altitude hold: on release of ↑/↓ we latch the current altitude as the
 * target and run a small PD controller that trims pitch to null both the
 * altitude error and the vertical speed. That is why releasing the keys leaves
 * you flying level and parallel to the ground instead of climbing forever.
 */
import { CONFIG, DEG } from "../core/config.js";
import { clamp } from "./physics.js";

const { controls: C, physics: P } = CONFIG;

/** Keys the browser would otherwise scroll or quick-find with. */
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
      // Losing focus with W held would otherwise leave the throttle wide open.
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

  /** Move `current` toward `target` at a rate that depends on direction. */
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
 * Advance the control axes for one fixed step and apply them to the aircraft.
 * Mutates `axis` in place (it is persistent state, not a per-frame value).
 *
 * @param {object} axis  persistent axes: {pitch, roll, throttle, brakes}
 * @param {object} hold  persistent altitude-hold latch: {armed, targetAlt}
 * @param {Controls} input
 * @param {object} plane aircraft state (mutated)
 * @param {number} dt    fixed timestep
 */
export function updateAxes(axis, hold, input, plane, dt) {
  const k = input.held;
  const ControlsClass = Controls;

  // ── Throttle ─────────────────────────────────────────────────────────────
  axis.throttle = ControlsClass.ramp(
    axis.throttle,
    k.forward ? 1 : 0,
    C.throttleUpRate,
    C.throttleDownRate,
    dt,
  );
  plane.throttle = axis.throttle;

  // ── Brakes (ground only; a switch, not an axis) ──────────────────────────
  axis.brakes = plane.onGround && k.back;

  // ── Roll / yaw ───────────────────────────────────────────────────────────
  // Sign convention: POSITIVE roll = bank right = increasing heading.
  // Physics integrates heading as `heading += g·tan(roll)/v · dt`, so a
  // negative roll would turn the aeroplane left. Getting this backwards is
  // the single most obvious control bug possible — D must bank right.
  const turnTarget = (k.right ? 1 : 0) - (k.left ? 1 : 0);
  const maxBank = plane.onGround ? 0 : P.maxBank;
  axis.roll = ControlsClass.ramp(
    axis.roll,
    turnTarget * maxBank,
    C.axisRampUp,
    C.bankLevelRate,
    dt,
  );
  plane.roll = axis.roll;

  // ── Pitch, with altitude hold on release ──────────────────────────────────
  if (k.up || k.down) {
    const target = (k.up ? 1 : 0) - (k.down ? 1 : 0);
    axis.pitch = ControlsClass.ramp(
      axis.pitch,
      target * P.maxPitch,
      C.axisRampUp,
      C.axisRampDown,
      dt,
    );
    plane.pitch = axis.pitch;
    // Any vertical input disarms the hold; releasing re-arms it.
    hold.armed = false;
  } else if (plane.onGround) {
    axis.pitch = 0;
    plane.pitch = 0;
    hold.armed = false;
  } else {
    // Keys released. First ramp the axis back to neutral so the visible
    // control response decays smoothly…
    axis.pitch = ControlsClass.ramp(axis.pitch, 0, C.autoLevelRate, C.autoLevelRate, dt);
    // …then hand over to the altitude hold.
    if (!hold.armed) {
      hold.armed = true;
      hold.targetAlt = plane.alt;
      hold.integral = 0;
    }
    const altError = hold.targetAlt - plane.alt;
    const rateError = -plane.verticalSpeed;
    // The integral term is what actually holds altitude.
    //
    // Proportional and derivative alone cannot do it: holding level at 97 m/s
    // needs roughly 8.6 deg of nose-up, because the wing at that speed only
    // makes about 0.9 of the lift needed. The PD pair settles at an error it
    // can live with — measured 3.8 deg commanded, sinking 3.7 m/s, with full
    // throttle on. An integrator accumulates whatever steady pitch is actually
    // required, so it is self-correcting and needs no density model.
    hold.integral = clamp(
      hold.integral + altError * dt,
      -C.holdIntegralLimit,
      C.holdIntegralLimit,
    );
    const trim =
      altError * C.holdGainP + rateError * C.holdGainD + hold.integral * C.holdGainI;
    plane.pitch = clamp(trim, -C.holdPitchLimit, C.holdPitchLimit);
  }

  return axis;
}

export { SWALLOW };
