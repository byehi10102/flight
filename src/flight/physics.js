/**
 * Aircraft state and the flight model.
 *
 * This is the part of the game that has to feel right. Three decisions do
 * most of that work, and they are all here:
 *
 *  1. FIXED TIMESTEP. Physics runs at exactly CONFIG.sim.fixedStep (120 Hz)
 *     regardless of the render frame rate, so the aircraft behaves identically
 *     at 30, 60 and 144 fps. Variable-dt physics is the #1 cause of
 *     "feels different on my monitor" and of control jitter.
 *
 *  2. RAMPED CONTROL AXES. Keyboard keys are booleans, but control deflection
 *     is a rate-limited value (see controls.js). Nothing in the aircraft ever
 *     sees a step input.
 *
 *  3. SEPARATE WORLD/VISUAL FRAMES. `heading`/`pitch` are physical; the visual
 *     group applies them independently so the model banks without the
 *     simulation's coordinate maths having to reason about combined rotations.
 */
import { CONFIG } from "../core/config.js";
import { airDensity } from "../core/airports.js";

const { physics, sim } = CONFIG;

export function createAircraft(start) {
  return {
    lat: start.lat,
    lon: start.lon,
    alt: start.alt,
    heading: start.heading, // radians, 0 = north, clockwise positive
    pitch: 0,
    roll: 0,
    speed: 0, // m/s true airspeed
    verticalSpeed: 0, // m/s, + climbing
    throttle: 0, // 0..1
    onGround: true,
    brakes: false,
    stallFactor: 0,
    gLoad: 1,
    distanceFlown: 0, // metres
    airborne: false,
  };
}

/** Meters per degree at a given latitude, for lat/lon integration. */
function metresPerDegree(lat) {
  const mPerDegLat = M_PER_DEG_LAT;
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  return { mPerDegLat, mPerDegLon };
}
const M_PER_DEG_LAT = 111320;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * One fixed physics step.
 * @param plane mutable aircraft state
 * @param axis  {pitch, roll, throttle, brakes} ramped control axes
 * @param groundHeight terrain elevation (m MSL) at the aircraft position
 * @param dt    fixed timestep (s)
 */
export function stepPhysics(plane, axis, groundHeight, dt) {
  const rho = airDensity(Math.max(0, plane.alt), physics);
  const v = plane.speed;

  // ── Ground handling ──────────────────────────────────────────────────────
  if (plane.onGround) {
    plane.brakes = axis.brakes;

    // Thrust. Without this the ground branch only ever applies drag, so the
    // throttle can wind all the way up while the aircraft never moves.
    const thrust = axis.throttle * physics.maxThrust;
    const accelFromThrust = thrust / physics.mass;

    // Rolling + braking friction, plus a little aero drag.
    const friction =
      (axis.brakes ? physics.brakeFriction : physics.groundFriction) * physics.gravity;
    const aeroDrag = 0.5 * rho * v * v * physics.dragCoeffArea;
    const decel = friction + aeroDrag / physics.mass;
    plane.speed = Math.max(0, v + (accelFromThrust - decel) * dt);

    // Steering authority falls off with speed (a jetliner at 70 m/s barely
    // responds to nosewheel steering).
    const authority = clamp(1 - plane.speed / physics.maxGroundSpeed, 0, 1);
    plane.heading += axis.roll * physics.steerRate * authority * dt;
    plane.heading = normaliseHeading(plane.heading);
    plane.pitch = 0;
    plane.roll = 0;
    plane.verticalSpeed = 0;
    plane.stallFactor = 0;

    // Lift beats weight → the wheels leave the ground. Rotation speed is the
    // gate: you must be rolling fast before the wing can carry you.
    const lift = 0.5 * rho * plane.speed * plane.speed * physics.wingArea * physics.clMax;
    if (lift > physics.mass * physics.gravity * 1.02 && plane.speed > physics.rotationSpeed) {
      plane.onGround = false;
      plane.airborne = true;
      plane.pitch = Math.max(plane.pitch, 0.05);
      // Lift clear of the contact threshold, decisively.
      //
      // The aircraft sits at exactly `groundHeight + 0.8` while parked, and the
      // contact test at the end of the step is `<= groundHeight + 0.8`. Releasing
      // without moving it up means that test re-pins `onGround` on the very same
      // step, the airborne branch never runs, vertical speed never builds, and
      // the aircraft can never actually leave the ground. A 2.5 m clearance
      // clears the threshold with room to spare.
      plane.alt = Math.max(plane.alt, groundHeight + physics.takeoffClearance);
    }
  } else {
    // ── Aerodynamics ───────────────────────────────────────────────────────
    plane.brakes = false;

    // Angle of attack: the angle between the nose and the flight path. On a
    // coordinated turn the flight path follows the velocity vector, so AoA is
    // driven by commanded pitch plus the turn's sink.
    const alpha = plane.pitch - Math.atan2(plane.verticalSpeed, Math.max(v, 1));

    let cl = physics.cl0 + physics.clAlpha * alpha;
    // Soft stall: lift falls off past clMax instead of clipping hard.
    const stallAngle = (physics.clMax - physics.cl0) / physics.clAlpha;
    if (alpha > stallAngle) {
      const over = (alpha - stallAngle) / 0.12;
      cl = physics.clMax * (1 - clamp(over, 0, 0.75));
      plane.stallFactor = clamp(over, 0, 1);
    } else {
      plane.stallFactor = Math.max(0, plane.stallFactor - dt * 1.5);
    }
    cl = clamp(cl, -0.9, physics.clMax);

    const q = 0.5 * rho * v * v;
    // Structural load limit. Without it, a hard pull at 140 m/s generates
    // ~15 g (cl is capped at clMax, but clMax·q·S scales with v²), which pinned
    // vertical speed at its clamp and made the aircraft teleport skyward. Real
    // airframes are g-limited; 3 g is a reasonable light-aeroplane figure.
    const weight = physics.mass * physics.gravity;
    const lift = Math.min(q * physics.wingArea * cl, weight * 3);
    const drag = q * physics.dragCoeffArea * (1 + 1.6 * plane.stallFactor);

    const thrust = plane.throttle * physics.maxThrust * (1 - 0.55 * (plane.alt / physics.ceiling));

    // Along the flight path.
    const accel = (thrust - drag) / physics.mass;
    plane.speed = Math.max(0, v + accel * dt);

    // Perpendicular: lift vs weight, resolved onto the flight path.
    const netPerp = lift - weight * Math.cos(plane.pitch);
    // No speed-dependent fudge factor here: it scaled the acceleration by up
    // to 3.5× and turned ordinary control inputs into a rocket. One metre per
    // second squared per newton of excess lift is the honest conversion.
    const verticalAccel = netPerp / physics.mass;
    plane.verticalSpeed += verticalAccel * dt;
    // Gravity always pulls down along the world vertical.
    plane.verticalSpeed -= physics.gravity * Math.sin(plane.pitch) * dt * 0.55;
    // ~4 900 ft/min. A hard pull is powerful, but no jet airframe sustains
    // 7 800 ft/min, and letting it try made every climb a rocket.
    plane.verticalSpeed = clamp(plane.verticalSpeed, -25, 25);

    // Bank → turn rate. This is the coordinated-turn relation, and it is why
    // rolling without yawing still changes your heading.
    const turnRate =
      (physics.gravity * Math.tan(clamp(plane.roll, -1.2, 1.2))) /
      Math.max(plane.speed, 20);
    plane.heading = normaliseHeading(plane.heading + turnRate * dt);

    plane.gLoad = lift / weight;
  }

  // ── Integrate position ───────────────────────────────────────────────────
  const step = plane.speed * dt;
  const { mPerDegLat, mPerDegLon } = metresPerDegree(plane.lat);
  plane.lat += (step * Math.cos(plane.heading)) / mPerDegLat;
  plane.lon += (step * Math.sin(plane.heading)) / mPerDegLon;
  plane.alt += plane.verticalSpeed * dt;
  plane.distanceFlown += step;

  // Wrap longitude so long flights don't lose float precision.
  if (plane.lon > 180) plane.lon -= 360;
  if (plane.lon < -180) plane.lon += 360;
  if (plane.alt > physics.ceiling) {
    plane.alt = physics.ceiling;
    plane.verticalSpeed = Math.min(plane.verticalSpeed, 0);
  }

  // ── Terrain contact ──────────────────────────────────────────────────────
  if (plane.alt <= groundHeight + 0.8) {
    plane.alt = groundHeight + 0.8;
    if (!plane.onGround) {
      // Touchdown: bleed vertical speed, settle the attitude.
      plane.verticalSpeed = 0;
      plane.pitch *= 0.4;
      plane.roll *= 0.5;
    }
    plane.onGround = true;
    if (plane.speed < 12) plane.airborne = false;
  }
}

function normaliseHeading(h) {
  let x = h % (Math.PI * 2);
  if (x > Math.PI) x -= Math.PI * 2;
  if (x < -Math.PI) x += Math.PI * 2;
  return x;
}

export { normaliseHeading, clamp };
