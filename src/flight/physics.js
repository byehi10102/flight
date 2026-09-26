/**
 * Aircraft state and the flight model.
 *
 * Fixed 120 Hz timestep; ramped control axes; the visual group applies
 * attitude independently of the coordinate maths.
 */
import { CONFIG } from "../core/config.js";
import { airDensity } from "../core/airports.js";

const { physics, sim } = CONFIG;

export function createAircraft(start) {
  return {
    lat: start.lat, lon: start.lon, alt: start.alt, heading: start.heading,
    pitch: start.pitch || 0, speed: start.speed || 0,
    verticalSpeed: 0, throttle: 0, onGround: true, brakes: false,
    stallFactor: 0, gLoad: 1, distanceFlown: 0, airborne: false, flaps: false,
  };
}

function metresPerDegree(lat) {
  const mPerDegLat = M_PER_DEG_LAT;
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  return { mPerDegLat, mPerDegLon };
}
const M_PER_DEG_LAT = 111320;
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export function stepPhysics(plane, axis, groundHeight, dt) {
  const rho = airDensity(Math.max(0, plane.alt), physics);
  const v = plane.speed;

  if (plane.onGround) {
    plane.brakes = axis.brakes;
    const thrust = axis.throttle * physics.maxThrust;
    const accelFromThrust = thrust / physics.mass;
    const friction = (axis.brakes ? physics.brakeFriction : physics.groundFriction) * physics.gravity;
    const q = 0.5 * rho * v * v;
    const aeroDrag = q * physics.dragCoeffArea;
    const decel = friction + aeroDrag / physics.mass;
    plane.speed = Math.max(0, v + (accelFromThrust - decel) * dt);
    const authority = clamp(1 - v / physics.maxGroundSpeed, 0, 1);
    plane.heading += axis.roll * physics.steerRate * authority * dt;
    plane.heading = normaliseHeading(plane.heading);
    // Keep the wheels tracking, but let the pilot rotate the nose — pulling
    // back builds AoA and AoA builds lift, which is what leaves the ground.
    plane.roll = 0;
    plane.verticalSpeed = 0;
    plane.stallFactor = 0;

    // Natural liftoff: at the current speed/nose-up attitude, if the wing makes
    // more than ~1.03x the weight in lift, the aeroplane is flying. No speed
    // gate — the pilot pulling back is what rotates.
    const alpha = clamp(plane.pitch, 0, physics.maxPitch);
    let cl = physics.cl0 + physics.clAlpha * alpha;
    const stallAngle = (physics.clMax - physics.cl0) / physics.clAlpha;
    if (alpha > stallAngle) {
      const over = (alpha - stallAngle) / 0.16;
      cl = physics.clMax * (1 - clamp(over, 0, 0.75));
    }
    cl = clamp(cl, -0.9, physics.clMax);
    const lift = q * physics.wingArea * cl;
    if (lift > physics.mass * physics.gravity * 1.03) {
      plane.onGround = false;
      plane.airborne = true;
      plane.alt = groundHeight + 2.0;
      plane.verticalSpeed = 3;
    }
  } else {
    plane.brakes = false;
    const alpha = plane.pitch - Math.atan2(plane.verticalSpeed, Math.max(v, 1));
    let cl = physics.cl0 + physics.clAlpha * alpha;
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
    const weight = physics.mass * physics.gravity;
    const lift = Math.min(q * physics.wingArea * cl, weight * 3);
    const flapsDrag = plane.flaps * q * physics.flapsDragCoeffArea * 8;
    const drag = q * physics.dragCoeffArea * (1 + 1.6 * plane.stallFactor) + flapsDrag;
    const thrust = plane.throttle * physics.maxThrust * (1 - 0.55 * (plane.alt / physics.ceiling)) * Math.max(0.25, 1 - 0.75 * (v / 250));
    const accel = (thrust - drag) / physics.mass;
    plane.speed = Math.max(0, v + accel * dt);
    const netPerp = lift - weight * Math.cos(plane.pitch);
    const verticalAccel = netPerp / physics.mass;
    plane.verticalSpeed += verticalAccel * dt;
    plane.verticalSpeed = clamp(plane.verticalSpeed, -25, 25);
    const turnRate = (physics.gravity * Math.tan(clamp(plane.roll, -1.2, 1.2))) / Math.max(v, 20);
    plane.heading = normaliseHeading(plane.heading + turnRate * dt);
    plane.gLoad = lift / weight;
  }

  const step = plane.speed * dt;
  const { mPerDegLat, mPerDegLon } = metresPerDegree(plane.lat);
  plane.lat += (step * Math.cos(plane.heading)) / mPerDegLat;
  plane.lon += (step * Math.sin(plane.heading)) / mPerDegLon;
  plane.alt += plane.verticalSpeed * dt;
  plane.distanceFlown += step;
  if (plane.lon > 180) plane.lon -= 360;
  if (plane.lon < -180) plane.lon += 360;
  if (plane.alt > physics.ceiling) { plane.alt = physics.ceiling; plane.verticalSpeed = Math.min(plane.verticalSpeed, 0); }

  if (plane.alt <= groundHeight + 0.8) {
    plane.alt = groundHeight + 0.8;
    if (!plane.onGround) { plane.verticalSpeed = 0; plane.pitch *= 0.4; plane.roll *= 0.5; }
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
