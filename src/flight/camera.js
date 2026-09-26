/**
 * Third-person chase camera.
 *
 * Behind the aircraft and slightly above, in the model's own body frame
 * (+Y is the nose, +Z is up, +X is right, so -Y is behind). The view follows
 * the aeroplane but is NOT locked to it: hold the right mouse button and the
 * gaze yaws and pitches independently, then springs back to looking ahead along
 * the flight path when you let go.
 *
 * Smoothing is 1 - exp(-k·dt), frame-rate independent. Position and aim use
 * different rates so the camera trails slightly in translation but snaps on aim.
 */
import {
  Cartesian3, Cartographic, Ellipsoid, HeadingPitchRoll, Matrix4, Transforms,
} from "cesium";
import { CONFIG } from "../core/config.js";

const { camera: CAM } = CONFIG;
const scratchFrame = new Matrix4();
const scratchIdealPos = new Cartesian3();
const scratchIdealLook = new Cartesian3();
const scratchForward = new Cartesian3();
const scratchRight = new Cartesian3();
const scratchUp = new Cartesian3();
const scratchWorldUp = new Cartesian3();
const scratchCross = new Cartesian3();
const scratchPos = new Cartesian3();

export class ChaseCamera {
  constructor(viewer) {
    this.viewer = viewer;
    this.initialised = false;
    this._pos = new Cartesian3();
    this._look = new Cartesian3();
    this.lookYaw = 0;
    this.lookPitch = 0;
    this._dragging = false;
    // Cesium's default orbit/tilt/look would fight a camera we reposition every
    // frame, so disable them; lookaround is driven by right-drag below.
    const sc = viewer.screenSpaceCameraController ||
      (viewer.scene && viewer.scene.screenSpaceCameraController);
    if (sc) {
      sc.enableRotate = false;
      sc.enableTilt = false;
      sc.enableLook = false;
      sc.enableTranslate = false;
      sc.enableZoom = false;
    }
  }

  aircraftPosition(plane, out = new Cartesian3()) {
    return Cartesian3.fromRadians(
      (plane.lon * Math.PI) / 180,
      (plane.lat * Math.PI) / 180,
      plane.alt,
      Ellipsoid.WGS84,
      out,
    );
  }

  look(dx, dy) {
    this._dragging = true;
    this.lookYaw += dx * 0.003;
    this.lookPitch += dy * 0.003;
    if (this.lookPitch > 1.3) this.lookPitch = 1.3;
    if (this.lookPitch < -1.3) this.lookPitch = -1.3;
  }
  endLook() { this._dragging = false; }

  update(plane, groundHeight, dt) {
    const position = this.aircraftPosition(plane, scratchPos);
    const o = CAM.offset;

    const hpr = new HeadingPitchRoll(plane.heading, -plane.pitch * 0.6, plane.roll);
    Transforms.headingPitchRollToFixedFrame(position, hpr, Ellipsoid.WGS84, undefined, scratchFrame);

    // Behind (+Z up, so -Y back) and above in the model's body frame.
    Matrix4.multiplyByPoint(scratchFrame, new Cartesian3(o.side, -o.back, o.up), scratchIdealPos);
    // Aim point ahead along +Y (nose direction).
    Matrix4.multiplyByPoint(scratchFrame, new Cartesian3(0, CAM.lookAhead, 0), scratchIdealLook);

    // Spring the lookaround back to centre when the player let go.
    if (!this._dragging) {
      const k = 1 - Math.exp(-CAM.lookSpring * dt);
      this.lookYaw *= (1 - k);
      this.lookPitch *= (1 - k);
    }

    if (!this.initialised) {
      Cartesian3.clone(scratchIdealPos, this._pos);
      Cartesian3.clone(scratchIdealLook, this._look);
      this.initialised = true;
    }

    const kp = 1 - Math.exp(-CAM.posSmoothing * dt);
    const kr = 1 - Math.exp(-CAM.rotSmoothing * dt);
    Cartesian3.lerp(this._pos, scratchIdealPos, kp, this._pos);
    Cartesian3.lerp(this._look, scratchIdealLook, kr, this._look);

    // Never clip through the terrain.
    const carto = Cartographic.fromCartesian(this._pos, Ellipsoid.WGS84);
    if (carto) {
      const ground = this._terrainHeight(carto, groundHeight);
      if (carto.height < ground + CAM.minHeightAboveGround) {
        carto.height = ground + CAM.minHeightAboveGround;
        Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height, Ellipsoid.WGS84, this._pos);
      }
    }

    // Forward = look - pos, then apply the player's independent yaw/pitch.
    Cartesian3.subtract(this._look, this._pos, scratchForward);
    Cartesian3.normalize(scratchForward, scratchForward);
    Ellipsoid.WGS84.geodeticSurfaceNormal(this._pos, scratchWorldUp);

    if (Math.abs(this.lookYaw) > 1e-5)
      rotateAboutAxis(scratchForward, scratchWorldUp, this.lookYaw, scratchForward);
    Cartesian3.cross(scratchForward, scratchWorldUp, scratchRight);
    if (Cartesian3.magnitudeSquared(scratchRight) < 1e-12) {
      Cartesian3.cross(scratchForward, Cartesian3.UNIT_Z, scratchRight);
    }
    Cartesian3.normalize(scratchRight, scratchRight);
    if (Math.abs(this.lookPitch) > 1e-5)
      rotateAboutAxis(scratchForward, scratchRight, this.lookPitch, scratchForward);
    Cartesian3.cross(scratchRight, scratchForward, scratchUp);
    Cartesian3.normalize(scratchUp, scratchUp);

    const camera = this.viewer.scene.camera;
    if (!isFiniteVec(this._pos) || !isFiniteVec(scratchForward) ||
        !isFiniteVec(scratchRight) || !isFiniteVec(scratchUp)) {
      camera.setView({ destination: position, orientation: { heading: 0, pitch: -0.2, roll: 0 } });
      this.initialised = false;
      return;
    }
    camera.position = this._pos;
    camera.direction = scratchForward;
    camera.right = scratchRight;
    camera.up = scratchUp;
  }

  _terrainHeight(cartographic, fallback) {
    try {
      const h = this.viewer.scene.globe.getHeight(cartographic);
      if (typeof h === "number" && Number.isFinite(h)) return h;
    } catch {}
    return fallback;
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }
function isFiniteVec(v) {
  return !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z) &&
    Cartesian3.magnitudeSquared(v) > 1e-6;
}
/** Rodrigues rotation of v about a unit axis by angle radians. */
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
