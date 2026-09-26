/**
 * The aircraft model — Bombardier CRJ-900 CityJet.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Why this file is fussier than it looks
 * ───────────────────────────────────────────────────────────────────────────
 * A `Model` is not a camera. Cesium's `Model` has no `orientation` property;
 * the only supported route is a complete 4×4 `modelMatrix`, so the aircraft's
 * orientation has to be built from position + heading + pitch + bank by hand.
 * Two mistakes here are silent and very visible from outside:
 *
 *  1. WRONG FORWARD AXIS. This GLB is a Y-up Sketchfab export whose fuselage
 *     runs along **+Y**, with the wings on X and the belly on -Z. Cesium's body
 *     frame is X east, Y north, Z up, so the model's +Y nose already points
 *     where the aircraft is flying and the yaw correction is **zero**. (The
 *     previous NASA Global Hawk was authored nose-along-+X and needed +90°.)
 *     Getting this wrong makes the aeroplane fly backwards.
 *
 *  2. THE ORIGIN IS NOT THE CENTRE. The authored bounding box is
 *     X [-1.168, 1.168] (symmetric) but Y [0.002, 3.652] — so the origin sits
 *     at the **tail** — and Z [0.001, 0.711] — so the origin sits on the
 *     **ground**. The model must be translated by half its length along its own
 *     +Y to centre the airframe on the physics reference point, and left at zero
 *     height so the wheels rest on the runway rather than sinking into it.
 *
 * `scripts/orientation.mjs` verifies both numerically: it takes a real nose
 * vertex from the mesh, pushes it through the same matrix, and checks it lands
 * where the aircraft is actually travelling.
 */
import {
  Cartesian3,
  Ellipsoid,
  HeadingPitchRoll,
  Matrix4,
  Transforms,
  Model,
} from "cesium";
import { CONFIG } from "../core/config.js";

/**
 * Yaw correction about the model's own up axis.
 *
 * Zero for this asset: its nose is +Y, which is already the frame's forward
 * axis at heading 0. Kept as a documented constant rather than deleted,
 * because the next model swapped in will need it and the reason is not
 * guessable from the number.
 */
const MODEL_YAW_OFFSET = Math.PI / 2;

/**
 * Authored mesh bounds, from `scripts/inspect-glb.mjs`:
 *   min [-1.168, 0.002, 0.001]   max [1.168, 3.652, 0.711]
 * Half the fuselage length, so the airframe can be centred on the physics
 * point. The origin is at the tail, so this is subtracted along local +Y.
 */
/**
 * How far forward of the reference point the model's origin sits, IN METRES.
 *
 * Cesium applies `Model.scale` inside the model's pipeline, not in
 * `modelMatrix`, so a translation written into the matrix is in world metres
 * while the mesh's own coordinates are in authored units. Offsetting by the
 * authored half-length (1.827) instead of the scaled one leaves the airframe
 * 17.6 m ahead of the point the flight model and chase camera track — enough to
 * put the camera well behind the tail. Measured, not guessed: see
 * `scripts/orientation.mjs`.
 */
const MODEL_CENTRE_OFFSET_Y =
  ((0.002 + 3.652) / 2) * CONFIG.aircraft.modelScale;

/** Scratch objects, reused every frame to keep the main loop allocation-free. */
const scratchMatrix = new Matrix4();
const scratchTranslate = new Matrix4();

export class AircraftModel {
  constructor(viewer) {
    this.viewer = viewer;
    this.model = null;
    this.ready = false;
    this.propAngle = 0;
    this._position = new Cartesian3();
    this._hpr = new HeadingPitchRoll();
    this._scale = CONFIG.aircraft.modelScale;
    // The matrix used for the current frame, kept for verification.
    this.lastMatrix = new Matrix4();
  }

  async load() {
    const model = await Model.fromGltfAsync({
      url: CONFIG.aircraft.modelUrl,
      scale: this._scale,
      // No `minimumPixelSize` / `maximumScale` / `distanceDisplayCondition`.
      //
      // These are all reasonable-looking additions and together they suppress
      // the model completely: ready, show, in the scene, draw commands issued,
      // and not one pixel on screen. Being removed one at a time.
      // Let the model's own baked texture and lighting show through.
      lightColor: undefined,
    });
    this.viewer.scene.primitives.add(model);
    this.model = model;
    model.readyEvent.addEventListener(() => {
      this.ready = true;
    });
    return model;
  }

  update(plane, dt) {
    if (!this.model) return;
    this.propAngle += plane.throttle * CONFIG.aircraft.propSpinMax * dt;

    this._position = Cartesian3.fromRadians(
      (plane.lon * Math.PI) / 180,
      (plane.lat * Math.PI) / 180,
      plane.alt,
      Ellipsoid.WGS84,
      this._position,
    );

    // Heading in the physics is 0 = north, clockwise. Cesium's HPR heading is
    // measured from east, so shift by -90°. Pitch sign is inverted: Cesium's
    // +pitch is nose-down, ours is nose-up. Roll is the same sense.
    //
    // The model's yaw correction is folded into the heading rather than
    // post-multiplied: rotating about the local up axis IS a yaw, so adding the
    // offset here is exact and avoids Matrix4.fromRotationY, which does not
    // exist in Cesium's API.
    this._hpr.heading = plane.heading - Math.PI / 2 + MODEL_YAW_OFFSET;
    this._hpr.pitch = -plane.pitch;
    this._hpr.roll = plane.roll;

    // Build the ENU fixed-frame matrix directly.
    //
    // Do NOT use `Transforms.headingPitchRollQuaternion` +
    // `Matrix4.fromRotationTranslation` here. In Cesium 1.145 that pairing
    // yields an all-zero rotation block — the quaternion is already expressed
    // in the fixed frame, so composing it with the translation again wipes the
    // rotation out and every body offset collapses onto the position vector.
    // The symptom is a camera whose position and look-at point are identical,
    // so `normalize(look - pos)` is 0/0 = NaN, the camera basis goes NaN, and
    // Cesium's command culling dies with "RangeError: Failed to set the
    // 'length' property on 'Array'".
    //
    // `headingPitchRollToFixedFrame` returns the correct 4×4 in one step.
    // Signature: (origin, headingPitchRoll, ellipsoid, fixedFrameTransform,
    // result) — the matrix lands in the FIFTH argument.
    Transforms.headingPitchRollToFixedFrame(
      this._position,
      this._hpr,
      Ellipsoid.WGS84,
      undefined,
      scratchMatrix,
    );

    // Centre the airframe on the physics reference point.
    //
    // The model origin is at the tail, on the ground. Without this the whole
    // aeroplane trails ~19 m behind and ~3.8 m below the point the flight
    // model and the chase camera are tracking — which puts the camera inside
    // the tailcone. Applied in the model's OWN frame, so it rotates with the
    // aeroplane as it turns.
    Matrix4.fromTranslation(
      new Cartesian3(0, -MODEL_CENTRE_OFFSET_Y, 0),
      scratchTranslate,
    );
    // Right-multiply: local offset first, then the aircraft's placement.
    Matrix4.multiply(scratchMatrix, scratchTranslate, scratchMatrix);

    this.model.modelMatrix = scratchMatrix;
    // Keep a copy of the matrix actually used this frame.
    //
    // `scratchMatrix` is a module-level singleton reused every frame, so
    // reading `model.modelMatrix` back does not reliably tell you what this
    // frame computed — and a verification harness that cannot observe the real
    // value will happily report a correct model as broken. A copy costs one
    // small allocation per frame and makes the transform checkable.
    Matrix4.clone(scratchMatrix, this.lastMatrix);
  }

  setVisible(visible) {
    if (this.model) this.model.show = visible;
  }

  destroy() {
    if (this.model) {
      this.viewer.scene.primitives.remove(this.model);
      this.model = null;
    }
  }
}

export { MODEL_YAW_OFFSET, MODEL_CENTRE_OFFSET_Y };
