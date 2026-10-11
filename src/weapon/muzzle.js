/**
 * Pure wing-station geometry for the gun muzzle.
 *
 * No imports on purpose: the project's test policy keeps the browser/Cesium
 * stack out of `node --test`, so the spawn-point math lives here as plain
 * arithmetic and is pinned by test/muzzle-origin.test.mjs. bullet.js only
 * wraps the result in Cesium's Cartographic conversion.
 *
 * The mapping is 1:1 from overlay camera space to world — deliberately
 * WITHOUT the reference project's tan(worldFov/2)/tan(75/2) x/y factor:
 * ref-flight's overlay camera is fixed at 75 deg, while ours is FOV-synced
 * to the Cesium frustum and planeModel already bakes that live ratio into
 * model.scale/position. Re-applying the factor double-compensates and drags
 * the muzzle from the wing to the fuselage ("firing from behind the
 * airplane") — the tests pin this contract.
 */

/** Standard quaternion rotation (three.js/OpenGL convention: v + 2w(q×v) + 2(q×(q×v))). */
export function rotateByQuaternion(v, q) {
  const { x, y, z } = v;
  const { x: qx, y: qy, z: qz, w: qw } = q;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return {
    x: x + qw * tx + (qy * tz - qz * ty),
    y: y + qw * ty + (qz * tx - qx * tz),
    z: z + qw * tz + (qx * ty - qy * tx),
  };
}

/**
 * The DRAWN model's local station (scaled by the model's live uniform scale,
 * rotated by its live quaternion, translated by its camera-space position)
 * mapped through the camera basis into a camera-relative world point.
 *
 * @param {{x:number,y:number,z:number}} station local station (model units)
 * @param {{scale:{x:number}, quaternion:{x:number,y:number,z:number,w:number},
 *          position:{x:number,y:number,z:number}}} model live overlay model
 * @param {{right:{x,y,z}, up:{x,y,z}, direction:{x,y,z}}} basis Cesium camera
 * @returns {{x:number,y:number,z:number}} world point (add cam.positionWC)
 */
export function stationWorldPoint(station, model, basis) {
  const s = model.scale.x;
  const scaled = rotateByQuaternion(
    { x: station.x * s, y: station.y * s, z: station.z * s },
    model.quaternion,
  );
  // Full overlay-camera-space point:
  const px = scaled.x + model.position.x;
  const py = scaled.y + model.position.y;
  const pz = scaled.z + model.position.z;
  // Camera basis with the forward term negated (camera looks down -Z):
  return {
    x: basis.right.x * px + basis.up.x * py + basis.direction.x * -pz,
    y: basis.right.y * px + basis.up.y * py + basis.direction.y * -pz,
    z: basis.right.z * px + basis.up.z * py + basis.direction.z * -pz,
  };
}
