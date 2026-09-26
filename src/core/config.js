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
  buildings: {
    tileJson: "https://tiles.openfreemap.org/planet",
    attribution: "Buildings &copy; OpenStreetMap contributors, via OpenFreeMap",
    minAltitude: 120,
    maxAltitude: 6000,
    radius: 3,
    levels: [14, 14],
  },
  airports: { dataUrl: "data/airports.json" },

  aircraft: {
    modelUrl: "models/crj900.glb",
    modelAttribution: "Bombardier CRJ-900 CityJet",
    modelScale: 10.64,
    targetWingspan: 24.85,
    propSpinAxis: "z",
    propSpinMax: 90,
  },

  // ── Flight model: CRJ-900. No rotation-speed gate; liftoff is pilot-led. ──
  physics: {
    mass: 38300,
    wingArea: 104.9,
    maxThrust: 147000,
    idleThrustFrac: 0.076,
    dragCoeffArea: 1.35,
    cl0: 0.22,
    clAlpha: 4.6,
    clMax: 1.55,
    rollRate: 0.95,
    pitchRate: 0.34,
    maxPitch: 0.20, // 11.5 deg; 24 deg stalls the jet into a descent
    maxBank: 0.62,
    groundFriction: 0.021,
    brakeFriction: 0.12,
    steerRate: 0.22,
    maxGroundSpeed: 95,
    ceiling: 12500,
    minSpeed: 66,
    densitySeaLevel: 1.225,
    temperatureSeaLevel: 288.15,
    gravity: 9.80665,
    // Extra drag when the flaps are extended (S held in the air).
    flapsDragCoeffArea: 0.45,
  },

  controls: {
    axisRampUp: 2.6,
    axisRampDown: 3.4,
    autoLevelRate: 1.9,
    bankLevelRate: 2.2,
    throttleUpRate: 0.55,
    throttleDownRate: 0.35,
    holdGainP: 0.00022,
    holdGainD: 0.045,
    // Without the integral the hold settles at a standing sink; it accumulates
    // the steady nose-up attitude the jet needs to hold altitude at speed.
    holdGainI: 0.010,
    holdIntegralLimit: 0.35,
    holdPitchLimit: 0.14,
  },

  // ── Camera: close chase, behind + slightly above, look-around. ──────────
  camera: {
    offset: { back: 18, up: 6, side: 0 },
    posSmoothing: 8.0,
    rotSmoothing: 10.0,
    lookAhead: 6,
    lookSpring: 8.0,        // faster gaze spring-back; dead zone in camera.js kills residual drift
    minHeightAboveGround: 4,
  },

  // ── Start: airborne over a city. ────────────────────────────────────────
  start: {
    city: "Manhattan",
    alt: 1000,
    heading: 0.35,
    speed: 95,
    pitch: 0.12,
  },
  cities: [
    { label: "Manhattan", lat: 40.7589, lon: -73.9851 },
    { label: "London", lat: 51.5074, lon: -0.1278 },
    { label: "Tokyo", lat: 35.6762, lon: 139.6503 },
    { label: "San Francisco", lat: 37.7749, lon: -122.4194 },
    { label: "Dubai", lat: 25.2048, lon: 55.2708 },
    { label: "Paris", lat: 48.8566, lon: 2.3522 },
  ],

  sim: {
    fixedStep: 1 / 120,
    maxSubSteps: 8,
    maxFrameDelta: 0.25,
    hudHz: 10,
  },
};

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const MPS_TO_KNOTS = 1.94384;
export const M_TO_FT = 3.28084;
