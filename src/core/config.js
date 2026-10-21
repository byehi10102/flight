/**
 * Every tunable in one place.
 */
export const CONFIG = {
  minimap: {
    // Dynamic map zoom: the minimap's camera altitude (view height) scales
    // with height above ground — near the deck the map is zoomed in tight
    // (detail), high up it is zoomed out (overview). Clamped so the map
    // never becomes a street map or a whole country.
    zoomPerAgl: 1.6,
    minZoomAlt: 1800,
    maxZoomAlt: 40000,
    // Per-second lerp rate toward the target zoom (smooth, no snapping).
    zoomSmooth: 3,
  },

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
    // Esri World Street Map — keyless like the satellite layer, so the game
    // stays no-API-key. (CARTO's keyless endpoint was retired; it served
    // "api key required" placeholder tiles over the whole map.)
    fallbackUrl: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    fallbackAttribution: "Map: Esri, HERE, Garmin, © OpenStreetMap contributors",
    fallbackSubdomains: [],
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
    maxSpeed: 3000,             // mph — holding W tops out here
    minSpeed: 250,              // mph — hands-off cruise, never stagnant
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
    duration: 3.0,
    // Top speed with boost = physics.maxSpeed * this = 7000 mph. The only way
    // above the 3000 mph that holding W gives you.
    multiplier: 7 / 3,
    rotations: 2,
  },

  // ── Aerodynamic effects: wing vapor + wingtip vortices ────────────────────
  // Ported from ref-flight's per-aircraft `aerodynamicEffects` block. Vapor
  // tears off the outer wing at speed + a hard pull-up (climb or high-G turn);
  // wingtip vortices ribbon out on roll or pitch. Coordinates are in the F-15
  // model's OWN local space — the same space the engine flames use — so they
  // ride the model group's scale and FOV compensation automatically.
  // The wing here spans 11.1 units (tips at +/-5.55), root leading edge at
  // z=1.25, tip chord z=2.0..3.4: measured off the loaded GLB, not guessed.
  aeroEffects: {
    enabled: true,
    condensation: {
      size: 9.4, // puff size in model units (ref-flight F-15 value)
      pos: { x: 3.0, y: 0.13, z: 2.0 }, // outer-wing root (flat pad)
      tip: { x: 5.3, y: 0.14, z: 3.0 }, // wingtip
      spread: { x: 1.2, y: 0.05, z: 3.0 }, // chord/wind spread of the trail
    },
    vortex: { pos: { x: 5.3, y: 0.14, z: 2.6 } }, // wingtip vortex origin
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

/**
 * The minimap's dynamic view altitude for a given height above ground.
 * Close to the ground -> zoomed in (the floor is the tightest view);
 * high up -> zoomed out (the ceiling is the widest overview). Pure so
 * the mapping is unit-testable; consumers smooth toward the target.
 */
export function computeMinimapZoomAltitude(agl, cfg = CONFIG.minimap) {
  const c = cfg || CONFIG.minimap;
  const a = Number(agl);
  const v = Number.isFinite(a) && a > 0 ? a * (c.zoomPerAgl || 1.6) : 0;
  return Math.max(c.minZoomAlt || 1800, Math.min(c.maxZoomAlt || 40000, v));
}
