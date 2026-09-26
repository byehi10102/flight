/**
 * Every tunable in one place.
 */
export const CONFIG = {
  terrain: {
    url: "https://terrain.reearth.land/cesium-mesh/ellipsoid",
    attribution: "Terrain: Re:Earth / Mapterhorn (CC BY 4.0)",
    maxLevel: 14,
  },
  imagery: {
    url:
      "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
    maximumLevel: 19,
  },

  aircraft: {
    modelUrl: "models/crj900.glb",
    modelAttribution: "Bombardier CRJ-900 CityJet",
    modelScale: 0.2,
  },

  // ── Flight model: reference-style arcade physics ──────────────────────────
  physics: {
    speed: 100,
    maxSpeed: 1000,
    minSpeed: 100,
    throttle: 0.5,
    enginePower: 1.2,
    drag: 0.005,
    liftFactor: 0.002,
    gravity: 9.8,
    pitchRate: 1.2,
    rollRate: 2.5,
    yawRate: 0.5,
  },

  // ── Boost (afterburner) ───────────────────────────────────────────────────
  boost: {
    duration: 2.5,
    multiplier: 1.5,
    rotations: 2,
  },

  // ── Camera ────────────────────────────────────────────────────────────────
  camera: {
    mouseSensitivity: 0.2,
    fov: 75,
    near: 0.1,
    far: 100000,
  },

  sim: {
    fixedStep: 1 / 60,
    maxSubSteps: 4,
  },
};

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const MPS_TO_KNOTS = 1.94384;
export const M_TO_FT = 3.28084;
