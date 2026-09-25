/**
 * The aircraft model.
 *
 * NASA Global Hawk — public domain, from nasa/NASA-3D-Resources. We load it
 * with Cesium's `Model` primitive and drive its `modelMatrix` every frame.
 *
 * Two transform decisions live here:
 *
 *  • A MODEL IS NOT A CAMERA. Cesium's `Model` has no `orientation` property;
 *    the only supported route is a complete 4×4 `modelMatrix`. So we build the
 *    matrix ourselves from the aircraft's ENU frame (position + heading +
 *    pitch + bank) instead of poking at Cesium internals. Because
 *    `depthTestAgainstTerrain` is on and the model has no shadow, the aircraft
 *    never clips into a building or a ridge.
 *
 *  • The engine model is authored nose-along-+X in the source file, while
 *    Cesium's body frame has -Z forward. `yawOffset` rotates it into place.
 *    Without this the aircraft flies backwards, which is a spectacularly
 *    annoying bug to spot from the outside.
 */
import {
  Cartesian3,
  Ellipsoid,
  HeadingPitchRoll,
  Matrix4,
  Transforms,
  Model,
  defined,
} from "cesium";
import { CONFIG } from "../core/config.js";

/**
 * The Global Hawk GLB is modelled nose-toward +X with wings along ±Z. Cesium's
 * ENU body frame is -Z forward, +X right, +Y up, so we rotate the model +90°
 * about Y to bring the nose onto -Z. Verified against the source mesh.
 */
const MODEL_YAW_OFFSET = Math.PI / 2;

/** Scratch matrix reused every frame to avoid per-frame allocation. */
const CesiumMatrix4 = new Matrix4();

export class AircraftModel {
  constructor(viewer) {
    this.viewer = viewer;
    this.model = null;
    this.ready = false;
    this.propAngle = 0;
    this._position = new Cartesian3();
    this._hpr = new HeadingPitchRoll();
  }

  async load() {
    const model = await Model.fromGltfAsync({
      url: CONFIG.aircraft.modelUrl,
      scale: 1,
      // Keep the aircraft legible when it is far away — that is exactly when
      // the player most needs to find it against the terrain.
      minimumPixelSize: 64,
      maximumScale: 800,
      distanceDisplayCondition: [0, 8_000_000],
      // The model is a real capture with baked lighting; let it shade itself.
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
    // The model's axis correction is folded into the heading rather than
    // post-multiplied as a matrix: rotating about the local up axis IS a yaw,
    // so adding the offset here is exact and avoids Matrix4.fromRotationY,
    // which does not exist in Cesium's API.
    HeadingPitchRoll.clone(
      new HeadingPitchRoll(
        plane.heading - Math.PI / 2 + MODEL_YAW_OFFSET,
        -plane.pitch,
        plane.roll,
      ),
      this._hpr,
    );

    // Build the ENU fixed-frame matrix directly.
    //
    // Do NOT use `Transforms.headingPitchRollQuaternion` +
    // `Matrix4.fromRotationTranslation` here. In Cesium 1.145 that pairing
    // yields an all-zero rotation block — the quaternion is already expressed
    // in the fixed frame, so composing it with the translation again wipes
    // the rotation out and every body offset collapses onto the position
    // vector. The symptom is a camera whose position and look-at point are
    // identical, so `normalize(look - pos)` is 0/0 = NaN, the camera basis goes
    // NaN, and Cesium's command culling dies with
    // "RangeError: Failed to set the 'length' property on 'Array'".
    //
    // `headingPitchRollToFixedFrame` returns the correct 4×4 in one step.
    // Signature: (origin, headingPitchRoll, ellipsoid, fixedFrameTransform,
    // result) — the matrix lands in the FIFTH argument.
    Transforms.headingPitchRollToFixedFrame(
      this._position,
      this._hpr,
      Ellipsoid.WGS84,
      undefined,
      CesiumMatrix4,
    );
    this.model.modelMatrix = CesiumMatrix4;
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

export { MODEL_YAW_OFFSET };
