/**
 * Third-person chase camera.
 *
 * Outside the aircraft, above and behind, banking with it.
 *
 * ── Why it doesn't feel jerky ──────────────────────────────────────────────
 * Smoothing is `1 - exp(-k·dt)`, not `lerp(a, b, 0.1)`. The exponential form
 * is frame-rate independent — identical response at 30, 60 and 144 fps —
 * whereas a fixed lerp factor makes the camera twice as fast on a 144 Hz
 * monitor, which reads as jitter. Position and look-at use different rates so
 * the camera trails slightly in translation but snaps in aim, which is how a
 * real chase camera behaves.
 *
 * ── Orientation maths ──────────────────────────────────────────────────────
 * We build the camera basis directly from vectors (right / up / forward)
 * rather than going through a heading-pitch-roll quaternion. For a *camera*,
 * HPR is awkward: Cesium's camera looks down its own -Z, so aiming it
 * horizontally north needs a 90° roll that collides with the bank we want to
 * apply. Constructing the basis from vectors sidesteps that and lets the bank
 * feed straight into the up vector.
 *
 * ── Takeoff framing ────────────────────────────────────────────────────────
 * On the liftoff edge we dolly out and up, so the runway stays in frame as the
 * aircraft climbs away from it. Without this the camera is glued to the plane
 * and the runway vanishes at the exact moment you want to watch it leave the
 * ground.
 */
import {
  Cartesian3,
  Cartographic,
  Ellipsoid,
  HeadingPitchRoll,
  Matrix4,
  Transforms,
} from "cesium";
import { CONFIG } from "../core/config.js";

const { camera: CAM } = CONFIG;

const scratchForward = new Cartesian3();
const scratchRight = new Cartesian3();
const scratchUp = new Cartesian3();
const scratchWorldUp = new Cartesian3();
const scratchCross = new Cartesian3();
const scratchFrame = new Matrix4();

export class ChaseCamera {
  constructor(viewer) {
    this.viewer = viewer;
    this.initialised = false;
    this.dolly = 0;
    this._prevOnGround = true;
    this._pos = new Cartesian3();
    this._look = new Cartesian3();
    this._targetPos = new Cartesian3();
    this._targetLook = new Cartesian3();
    this._position = new Cartesian3();
  }

  /** ECEF position of the aircraft. */
  aircraftPosition(plane, out = new Cartesian3()) {
    return Cartesian3.fromRadians(
      (plane.lon * Math.PI) / 180,
      (plane.lat * Math.PI) / 180,
      plane.alt,
      Ellipsoid.WGS84,
      out,
    );
  }

  update(plane, groundHeight, dt) {
    const position = this.aircraftPosition(plane, this._position);

    // Dolly out when airborne, in when back on the ground.
    if (plane.onGround !== this._prevOnGround) this.dolly = 1;
    this._prevOnGround = plane.onGround;
    const targetDolly = plane.onGround ? 0 : 1;
    this.dolly += (targetDolly - this.dolly) * (1 - Math.exp(-dt / 0.45));

    const back = lerp(CAM.offset.back, CAM.takeoffDollyBack, this.dolly);
    const up = lerp(CAM.offset.up, CAM.takeoffDollyUp, this.dolly);
    const side = CAM.offset.side;

    // The aircraft's own ENU basis at its position, tilted by heading, pitch
    // and bank. Offsetting inside this basis is what makes the camera bank
    // with the aeroplane.
    const hpr = new HeadingPitchRoll(
      plane.heading,
      -plane.pitch * 0.6, // partial pitch: a chase cam doesn't tilt fully
      plane.roll,
    );
    // Build the ENU fixed-frame matrix directly.
    //
    // Do NOT compose `Transforms.headingPitchRollQuaternion` with
    // `Matrix4.fromRotationTranslation`. That quaternion is already expressed
    // in the fixed frame; re-applying the translation produces an all-zero
    // rotation block, so every body offset collapses onto the position vector.
    // Then the camera's target and look-at point become identical,
    // `normalize(look - pos)` evaluates 0/0, `camera.direction` becomes NaN,
    // and Cesium's command culling aborts the whole render with
    // "RangeError: Failed to set the 'length' property on 'Array'".
    //
    // Signature: (origin, headingPitchRoll, ellipsoid, fixedFrameTransform,
    // result). We want the WGS84 ellipsoid, which is the default, so we pass
    // it explicitly in third position and receive the matrix in fifth.
    Transforms.headingPitchRollToFixedFrame(
      position,
      hpr,
      Ellipsoid.WGS84,
      undefined,
      scratchFrame,
    );

    // Offset inside the aircraft's own body frame.
    //
    // The frame's axes are fixed by the MODEL, not by a convenient convention.
    // This GLB is a Y-up Sketchfab export whose nose runs along +Y, and
    // `aircraft.js` carries a yaw offset so that +Y is the flight direction —
    // which puts +Z along world up.
    //
    // The old code assumed the classic Cesium body frame (-Z forward, +Y up,
    // +X right) and offset `(side, up, back)`. Against this model that means
    // "up" is applied along the direction of flight and "back" along an axis
    // pointing sideways, so the camera parks beside the aeroplane looking the
    // wrong way and the aircraft never appears on screen.
    //
    // So: -Y is behind, +Z is up, +X is to the right.
    //
    // NOTE: `headingPitchRollToFixedFrame` already maps local ENU coordinates
    // to ECEF *including* the origin translation, so this transform's output
    // IS the world-space point. Adding `position` again puts the camera at
    // twice Earth's radius — which renders as a continental globe view with
    // the aeroplane a speck, and no amount of offset tuning will fix it.
    Matrix4.multiplyByPoint(
      scratchFrame,
      new Cartesian3(side, -back, up),
      this._targetPos,
    );

    // Aim ahead along the flight path. Same reasoning: no extra translation.
    //
    // Ahead is +Y in this frame, matching the model. The old `-Z` was correct
    // for the previous body-frame convention, and against this model it put
    // the look-at point 40 m *below* the aeroplane, so the camera stared at
    // the ground and the aircraft sat 28 deg outside the field of view —
    // present in the world, invisible to the player.
    Matrix4.multiplyByPoint(
      scratchFrame,
      new Cartesian3(0, CAM.lookAhead * (1 - this.dolly * 0.4), 0),
      this._targetLook,
    );

    if (!this.initialised) {
      Cartesian3.clone(this._targetPos, this._pos);
      Cartesian3.clone(this._targetLook, this._look);
      this.initialised = true;
    }

    // Frame-rate-independent exponential smoothing.
    const kPos = 1 - Math.exp(-CAM.posSmoothing * dt);
    const kRot = 1 - Math.exp(-CAM.rotSmoothing * dt);
    Cartesian3.lerp(this._pos, this._targetPos, kPos, this._pos);
    Cartesian3.lerp(this._look, this._targetLook, kRot, this._look);

    // Never let the camera clip through the terrain.
    //
    // `Cartographic.fromCartesian` returns `undefined` — not a zeroed object —
    // for a point at or near the Earth's centre, which happens for a frame
    // during a long teleport. Dereferencing it unguarded throws.
    const camCarto = Cartographic.fromCartesian(this._pos, Ellipsoid.WGS84);
    if (camCarto) {
      const ground = this._terrainHeight(camCarto, groundHeight);
      if (camCarto.height < ground + CAM.minHeightAboveGround) {
        camCarto.height = ground + CAM.minHeightAboveGround;
        Cartesian3.fromRadians(
          camCarto.longitude,
          camCarto.latitude,
          camCarto.height,
          Ellipsoid.WGS84,
          this._pos,
        );
      }
    }

    // Orientation from vectors.
    const camera = this.viewer.scene.camera;
    Cartesian3.subtract(this._look, this._pos, scratchForward);
    Cartesian3.normalize(scratchForward, scratchForward);

    // World up at the camera, rolled about the view axis by the bank angle.
    Ellipsoid.WGS84.geodeticSurfaceNormal(this._pos, scratchWorldUp);
    rotateAboutAxis(scratchWorldUp, scratchForward, -plane.roll, scratchWorldUp);

    // right = forward × up
    Cartesian3.cross(scratchForward, scratchWorldUp, scratchRight);
    if (Cartesian3.magnitudeSquared(scratchRight) < 1e-12) {
      Cartesian3.cross(scratchForward, Cartesian3.UNIT_Z, scratchRight);
    }
    Cartesian3.normalize(scratchRight, scratchRight);
    // up = right × forward
    Cartesian3.cross(scratchRight, scratchForward, scratchUp);
    Cartesian3.normalize(scratchUp, scratchUp);

    // Last line of defence. A non-finite basis vector propagates straight into
    // Cesium's frustum, and the render loop dies with
    // "RangeError: Failed to set the 'length' property on 'Array'" — the whole
    // screen freezes. This can happen for a frame during a long teleport, when
    // the look-at point momentarily coincides with the camera. Rather than
    // hoping the arithmetic stays finite, fall back to a plain local-level
    // basis, which is always well defined. One bad frame is recoverable; a
    // dead render loop is not.
    if (!isFiniteVec(this._pos) || !isFiniteVec(scratchForward)) {
      camera.setView({
        destination: position,
        orientation: { heading: 0, pitch: -0.2, roll: 0 },
      });
      this.initialised = false;
      return;
    }
    if (
      !isFiniteVec(scratchRight) ||
      !isFiniteVec(scratchUp) ||
      !isFiniteVec(scratchForward)
    ) {
      Ellipsoid.WGS84.geodeticSurfaceNormal(position, scratchUp);
      Ellipsoid.WGS84.geodeticSurfaceNormalEastNorthWest(position, scratchRight);
      Cartesian3.normalize(scratchUp, scratchUp);
      Cartesian3.normalize(scratchRight, scratchRight);
      Cartesian3.negate(scratchUp, scratchUp);
    }

    // Cesium derives the orientation quaternion from these three, which
    // guarantees a consistent handedness with no roll sign flip.
    camera.position = this._pos;
    camera.direction = scratchForward;
    camera.right = scratchRight;
    camera.up = scratchUp;
  }

  _terrainHeight(cartographic, fallback) {
    try {
      const h = this.viewer.scene.globe.getHeight(cartographic);
      if (typeof h === "number" && Number.isFinite(h)) return h;
    } catch {
      /* globe not ready — fall back to the aircraft's own ground height */
    }
    return fallback;
  }
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** True when every component is a real number. */
function isFiniteVec(v) {
  return (
    !!v &&
    Number.isFinite(v.x) &&
    Number.isFinite(v.y) &&
    Number.isFinite(v.z) &&
    Cartesian3.magnitudeSquared(v) > 1e-6
  );
}

/** Rodrigues rotation of `v` about unit `axis` by `angle` radians. */
function rotateAboutAxis(v, axis, angle, out) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dot = Cartesian3.dot(axis, v);
  Cartesian3.cross(axis, v, scratchCross);
  out.x = v.x * c + scratchCross.x * s + axis.x * dot * (1 - c);
  out.y = v.y * c + scratchCross.y * s + axis.y * dot * (1 - c);
  out.z = v.z * c + scratchCross.z * s + axis.z * dot * (1 - c);
  return Cartesian3.normalize(out, out);
}

export { rotateAboutAxis, lerp };
