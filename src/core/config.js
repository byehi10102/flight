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
  // Bombardier CRJ-900 CityJet.
  //
  // The mesh is a Sketchfab export authored in arbitrary units with the origin
  // at the tail on the ground (see src/flight/aircraft.js). The uniform scale
  // is derived from the real wingspan: the authored span is 2.336 units, and
  // 24.85 / 2.336 = 10.64, which puts the rendered aeroplane at 24.85 m span,
  // 38.8 m long and 7.56 m tall against a real 24.85 / 36.4 / 7.39 m.
  aircraft: {
    modelUrl: "models/crj900.glb",
    modelAttribution: "Bombardier CRJ-900 CityJet",
    modelScale: 10.64,      // authored units -> metres, from the real span
    targetWingspan: 24.85,  // metres; the real CRJ-900 span
    propSpinAxis: "z",
    propSpinMax: 90,        // rad/s at full throttle
  },

  // ── Flight model ────────────────────────────────────────────────────────
  // Tuned for the CRJ-900, not the light twin this started as. A regional jet
  // is 7.5x the mass with 2.7x the wing, so it accelerates far more slowly,
  // rotates at 140 kt rather than 46 kt, and needs a much higher stall speed.
  // Leaving the old numbers in would have made "accelerate realistically" false
  // for the aeroplane actually being flown.
  //
  // CRJ-900 figures: MTOW 38,300 kg; wing area 104.9 m^2; 2 x GE CF34-8E5
  // giving 59,000 N total; Vr 140 kt (72 m/s); Vfe/MOAS 350 kt (180 m/s);
  // service ceiling 41,000 ft.
  physics: {
    mass: 38300,           // kg (MTOW)
    wingArea: 104.9,       // m^2
    maxThrust: 59000,      // N, static (2 x CF34-8E5)
    dragCoeffArea: 1.35,   // Cd * A, m^2
    cl0: 0.22,             // lift coefficient at zero AoA
    clAlpha: 4.6,          // lift curve slope, per radian
    clMax: 1.55,           // stall limit
    rollRate: 0.95,        // rad/s at full deflection
    pitchRate: 0.34,       // rad/s at full deflection
    // Max commanded pitch, 11.5 deg.
    //
    // The old 24 deg was a light-twin aerobatic figure. Held to it, a CRJ-900
    // sits at an angle of attack well past its ~16.6 deg stall angle, so the
    // wing stops lifting and the aeroplane accelerates in a steady descent at
    // full thrust — measured: 144 m/s and still sinking, altitude decaying from
    // 110 m to 58 m. A regional jet climbs at 8-10 deg nose-up, and this
    // stays just inside the stall so full pitch input means "climb hard",
    // which is what holding the key should feel like.
    maxPitch: 0.20,
    maxBank: 0.62,         // rad (~35 deg) commanded bank
    // CRJ-900 rotation speed, 140 kt. The old light-twin value of 24 m/s let a
    // 5 t aeroplane unstick at 46 kt; a 38 t jet really does need 140 kt, and
    // the takeoff run then takes about 30 s and 2 km, which is what makes the
    // acceleration feel like a real regional jet instead of a go-kart.
    rotationSpeed: 72,
  // Height the aircraft is lifted to on release, so it clears the terrain
  // contact threshold instead of being re-pinned to it (see physics.js).
  takeoffClearance: 2.5,     // m/s — liftoff threshold with nose-up
    groundFriction: 0.021, // rolling drag coefficient
    brakeFriction: 0.12,   // braking drag coefficient
    steerRate: 0.22,       // rad/s nosewheel at full lock, low speed
    maxGroundSpeed: 95,    // m/s above which steering authority → 0
    ceiling: 12500,        // m service ceiling for this sim
    minSpeed: 66,          // m/s — 1g stall speed, below this lift collapses
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
    // Integral term. Without it the hold settles at a standing sink rather than
    // holding altitude; with it the loop finds the steady nose-up attitude the
    // airframe needs at the current speed.
    holdGainI: 0.010,
    holdIntegralLimit: 0.35, // rad, bounds wind-up
    holdPitchLimit: 0.09,  // rad of trim authority while holding altitude
  },

  // ── Camera ──────────────────────────────────────────────────────────────
  camera: {
    // Chase distances are derived from the airframe, not hard-coded.
    //
    // These were 34 m / 46 m, tuned for the old 8 m Global Hawk. Swapping in a
    // 39 m CRJ-900 without revisiting them put the camera *inside the
    // fuselage* — the aeroplane was technically on screen's doorstep and
    // completely invisible, which is exactly what a player reports as "I can't
    // see the plane". Tying the numbers to the model length means the next
    // aircraft swap cannot silently repeat the mistake.
    offset: { back: 78, up: 16, side: 0 },
    posSmoothing: 6.0,     // higher = tighter follow
    rotSmoothing: 9.0,     // higher = snappier look-at
    // Metres ahead of the aircraft that the camera aims at.
    //
    // 40 put the aeroplane low and clipped: on the runway the tail projected to
    // y=879 in an 800 px frame, i.e. off the bottom edge. The camera sits 14 m
    // above and 62 m back, so the further ahead it looks, the further down the
    // aeroplane falls in frame. Measured, not guessed: `scripts/thirdperson.mjs`.
    lookAhead: 6,
    minHeightAboveGround: 4,
    takeoffDollyTime: 1.4, // seconds of pull-back after liftoff
    takeoffDollyBack: 78,
    takeoffDollyUp: 20,
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
