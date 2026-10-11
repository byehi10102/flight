import { test } from "node:test";
import assert from "node:assert/strict";
import { stationWorldPoint, rotateByQuaternion } from "../src/weapon/muzzle.js";

/**
 * Regression pin for "projectiles fire from the wings, not from behind the
 * airplane" (pure module — no browser, no Cesium; per project test policy).
 *
 * _gunMuzzle maps the DRAWN jet's wing station (overlay camera space) 1:1
 * through the Cesium camera basis into the world point where the round
 * spawns. The reference project (dimartarmizi/web-flight-simulator) applies
 * an extra x/y factor tan(worldFov/2)/tan(75/2) because ITS overlay camera
 * is fixed at 75 deg. Our overlay is FOV-synced and planeModel bakes that
 * live ratio into model.scale/position — re-applying the factor collapsed
 * the wing offset to ~35% and dragged the muzzle to the fuselage ("firing
 * from behind the airplane"). These tests pin the 1:1 mapping: any
 * rescale/factor re-introduced into the station math fails them.
 */

const IDENTITY_BASIS = {
  right: { x: 1, y: 0, z: 0 },
  up: { x: 0, y: 1, z: 0 },
  direction: { x: 0, y: 0, z: -1 },
};

// Typical drawn-model pose (fov-synced live values: modelScale*k, and
// camera-space offsets tuned for the original 75 deg overlay).
const MODEL = {
  scale: { x: 0.07, y: 0.07, z: 0.07 },
  quaternion: { x: 0, y: 0, z: 0, w: 1 },
  position: { x: 0, y: -0.4, z: -45 },
};

test("right-wing station lands exactly at the drawn wing point (1:1, no fov rescale)", () => {
  const p = stationWorldPoint({ x: 5.2, y: -0.4, z: -1.2 }, MODEL, IDENTITY_BASIS);
  // scale + identity quat: (0.364, -0.028, -0.084); + model position;
  // basis (right=+X, up=+Y, dir=-Z) with dir component = -pz:
  assert.ok(Math.abs(p.x - 0.364) < 1e-12, `x=${p.x} must equal 5.2*scale (wing lateral)`);
  assert.ok(Math.abs(p.y - -0.428) < 1e-12, `y=${p.y}`);
  assert.ok(Math.abs(p.z - -45.084) < 1e-12, `z=${p.z}`);
});

test("the regression signature: any x/y rescale toward the fuselage fails the pin", () => {
  const p = stationWorldPoint({ x: 5.2, y: -0.4, z: -1.2 }, MODEL, IDENTITY_BASIS);
  // The reference's factor (tan(15)/tan(37.5) ~= 0.351) would put x at ~0.128.
  const collapsed = 0.364 * Math.tan((15 * Math.PI) / 180) / Math.tan((37.5 * Math.PI) / 180);
  assert.ok(Math.abs(p.x - collapsed) > 0.2, "x sits at the wing, far from the collapsed fuselage value");
});

test("left-wing station mirrors the right one exactly", () => {
  const r = stationWorldPoint({ x: 5.2, y: -0.4, z: -1.2 }, MODEL, IDENTITY_BASIS);
  const l = stationWorldPoint({ x: -5.2, y: -0.4, z: -1.2 }, MODEL, IDENTITY_BASIS);
  assert.ok(Math.abs(r.x + l.x) < 1e-12, "stations mirror across the centerline");
  assert.ok(Math.abs(r.x) > 0.01, "right station is off the centerline — on the wing, not the fuselage");
});

test("quaternion rotation is the standard three.js/OpenGL convention", () => {
  // 90 deg yaw: +X -> -Z, +Z -> +X
  const q = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
  const v = rotateByQuaternion({ x: 1, y: 0, z: 0 }, q);
  assert.ok(Math.abs(v.x) < 1e-12 && Math.abs(v.y) < 1e-12 && Math.abs(v.z + 1) < 1e-12, `got (${v.x},${v.y},${v.z})`);
});

test("camera basis maps the overlay point with the direction term negated (forward = -Z)", () => {
  // Rolled camera: right=+Y, up=-X, dir=-Z. Overlay point (px,py,pz):
  const basis = { right: { x: 0, y: 1, z: 0 }, up: { x: -1, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } };
  const p = stationWorldPoint({ x: 2, y: 0, z: 0 }, MODEL, basis);
  // scaled.x = 0.14 -> right -> (0, 0.14, 0); position -> (0.14? no: scaled+pos = (0.14, -0.4, -45))
  // x' = right.x*px + up.x*py + dir.x*(-pz) = 0 + (-1)(-0.4) + 0 = 0.4
  // y' = right.y*px + up.y*py + dir.y*(-pz) = 0.14 + 0 + 0 = 0.14
  // z' = right.z*px + up.z*py + dir.z*(-pz) = 0 + 0 + (-1)*(45) = -45
  assert.ok(Math.abs(p.x - 0.4) < 1e-12, `x=${p.x}`);
  assert.ok(Math.abs(p.y - 0.14) < 1e-12, `y=${p.y}`);
  assert.ok(Math.abs(p.z - -45) < 1e-12, `z=${p.z} (point ahead of a -Z camera sits at negative world z)`);
});
