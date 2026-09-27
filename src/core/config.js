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
    // Base map under the satellite layer: fills oceans, poles and any tile
    // the satellite service has no data for, so gaps never read as void.
    fallbackUrl: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
    fallbackAttribution: "Map &copy; OpenStreetMap contributors &copy; CARTO",
    fallbackSubdomains: ["a", "b", "c", "d"],
    fallbackMaximumLevel: 19,
  },

  aircraft: {
    modelUrl: "models/f-15.glb",
    modelAttribution: "F-15 Low Poly",
    modelScale: 0.2,
  },

  // ── Flight model: realistic aerodynamics ─────────────────────────────────
  physics: {
    mass: 38300,               // kg (CRJ-900)
    wingArea: 104.9,           // m²
    maxThrust: 147000,         // N (2 × 73.5 kN)
    maxSpeed: 1000,             // m/s — matches ref-flight PlanePhysics
    minSpeed: 100,              // m/s — matches ref-flight PlanePhysics
    densitySeaLevel: 1.225,    // kg/m³
    temperatureSeaLevel: 288.15, // K
    gravity: 9.80665,
    // Aerodynamic coefficients
    cl0: 0.22,                 // lift at zero alpha
    clAlpha: 4.6,              // lift curve slope
    clMax: 1.55,               // max lift coefficient
    stallAngle: 0.28,          // rad (~16 degrees)
    cd0: 0.025,                // parasitic drag
    inducedDragFactor: 0.045,  // induced drag factor
    // Control rates (rad/s) — matches ref-flight planePhysics
    pitchRate: 1.2,
    rollRate: 2.5,
    yawRate: 0.5,
    maxBank: 0.85,             // rad (~48.7 degrees)
    // Ground handling
    groundFriction: 0.02,
    brakeFriction: 0.15,
    steerRate: 0.3,
    rotationSpeed: 75,         // m/s — liftoff speed
    ceiling: 12500,            // m
    // Altitude hold tuning
    autoLevelRate: 0.9,
    bankLevelRate: 1.4,
    throttleUpRate: 0.55,
    throttleDownRate: 0.35,
    holdGainP: 0.00012,
    holdGainD: 0.022,
    holdGainI: 0.006,
    holdIntegralLimit: 0.25,
    holdPitchLimit: 0.22,
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
    boomDistance: 60,   // behind aircraft
    boomHeight: 20,     // above aircraft
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
