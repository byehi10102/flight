/**
 * Every tunable in one place. Physics values are for a light twin-engine
 * aircraft (mass ~5100 kg, wing area ~39 m^2) and are meant to be tuned by
 * feel — see project.md "Flight model" for the derivation.
 */
export const CONFIG = {
  // ── Data sources (all keyless, all verified reachable) ──────────────────
  terrain: {
    // Re:Earth "mapterhorn" global DEM served as Cesium quantized-mesh.
    // CC BY 4.0. Global, ellipsoidal (no token, no geoid offset needed).
    url: "https://terrain.reearth.land/cesium-mesh/ellipsoid",
    attribution: "Terrain: Re:Earth / Mapterhorn (CC BY 4.0)",
    maxLevel: 14,
  },
  imagery: {
    // Esri World Imagery — public tile service, attribution required.
    url:
      "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
    maximumLevel: 19,
  },
  buildings: {
    // OpenFreeMap — free OpenMapTiles-schema vector tiles, no key, no signup.
    // Carries a `building` layer with real `render_height` per footprint.
    //
    // maxZoom is 14. Verified by surveying the live tile set: z14 city tiles
    // carry 190–1,488 footprints each (Manhattan 1,488, every one with a real
    // height), while every z15 request returns an empty body. Requesting z15
    // is therefore pure waste — it never yields a building.
    tileJson: "https://tiles.openfreemap.org/planet",
    attribution: "Buildings &copy; OpenStreetMap contributors, via OpenFreeMap",
    // Streaming policy
    minAltitude: 120,      // m AGL — below this we stream buildings
    maxAltitude: 6000,     // m AGL — above this we drop them entirely
    radius: 3,             // NxN tile grid around the aircraft
    levels: [14, 14],      // detail level per altitude band (max is 14)
  },
  airports: {
    dataUrl: "data/airports.json",
  },

  // ── Aircraft ────────────────────────────────────────────────────────────
  aircraft: {
    modelUrl: "models/hawk.glb",
    modelAttribution: "NASA Global Hawk — public domain, nasa/NASA-3D-Resources",
    targetWingspan: 20,    // metres; the model is normalised to this on load
    propSpinAxis: "z",
    propSpinMax: 90,       // rad/s at full throttle
  },

  // ── Flight model ────────────────────────────────────────────────────────
  physics: {
    mass: 5100,            // kg
    wingArea: 39,          // m^2
    maxThrust: 52000,      // N, static
    dragCoeffArea: 0.9,    // Cd * A, m^2
    cl0: 0.25,             // lift coefficient at zero AoA
    clAlpha: 4.5,          // lift curve slope, per radian
    clMax: 1.6,            // stall limit
    rollRate: 1.35,        // rad/s at full deflection
    pitchRate: 0.55,       // rad/s at full deflection
    maxPitch: 0.42,        // rad (~24 deg) commanded pitch
    maxBank: 0.62,         // rad (~35 deg) commanded bank
    rotationSpeed: 24,
  // Height the aircraft is lifted to on release, so it clears the terrain
  // contact threshold instead of being re-pinned to it (see physics.js).
  takeoffClearance: 2.5,     // m/s — liftoff threshold with nose-up
    groundFriction: 0.16,  // rolling drag coefficient
    brakeFriction: 0.85,   // braking drag coefficient
    steerRate: 0.55,       // rad/s nosewheel at full lock, low speed
    maxGroundSpeed: 70,    // m/s above which steering authority → 0
    ceiling: 12500,        // m MSL service ceiling
    minSpeed: 18,          // m/s — below this, lift collapses
    densitySeaLevel: 1.225,// kg/m^3
    temperatureSeaLevel: 288.15, // K
    gravity: 9.80665,
  },

  // ── Control feel ────────────────────────────────────────────────────────
  controls: {
    axisRampUp: 2.6,       // units/s toward a held key (~0.38s to full)
    axisRampDown: 3.4,     // units/s toward neutral when released
    autoLevelRate: 1.9,    // rad/s of pitch recentring on release
    bankLevelRate: 2.2,    // rad/s of bank recentring on release
    throttleUpRate: 0.55,  // per second
    throttleDownRate: 0.35,
    holdGainP: 0.00022,    // altitude-hold proportional term
    holdGainD: 0.045,      // altitude-hold derivative term
    holdPitchLimit: 0.09,  // rad of trim authority while holding altitude
  },

  // ── Camera ──────────────────────────────────────────────────────────────
  camera: {
    offset: { back: 34, up: 9, side: 0 },
    posSmoothing: 6.0,     // higher = tighter follow
    rotSmoothing: 9.0,     // higher = snappier look-at
    lookAhead: 40,         // metres ahead of the aircraft
    minHeightAboveGround: 4,
    takeoffDollyTime: 1.4, // seconds of pull-back after liftoff
    takeoffDollyBack: 46,
    takeoffDollyUp: 14,
  },

  // ── Simulation loop ─────────────────────────────────────────────────────
  sim: {
    fixedStep: 1 / 120,
    maxSubSteps: 8,
    maxFrameDelta: 0.25,
    hudHz: 10,
  },

  // ── Start state ─────────────────────────────────────────────────────────
  start: {
    // Seattle-Tacoma (KSEA) — long runways, dramatic terrain nearby.
    lat: 47.4502,
    lon: -122.3088,
    alt: 120,
    heading: 0.35,
  },
};

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const MPS_TO_KNOTS = 1.94384;
export const M_TO_FT = 3.28084;
