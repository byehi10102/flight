/**
 * Skyward — application entry.
 *
 * Wiring order matters and is deliberate:
 *   1. Viewer boots on the smooth ellipsoid so there is a globe on screen in
 *      one frame, then the real DEM swaps in when it resolves. Waiting on the
 *      terrain provider before the first paint would mean a blank page.
 *   2. Aircraft physics starts immediately on the runway, so the player can
 *      taxi while terrain, buildings and runways are still streaming in.
 *   3. Physics runs on a fixed 120 Hz accumulator, independent of the render
 *      frame rate. Everything that affects the feel of the controls lives
 *      behind that clock.
 */
import {
  Cartographic,
  Cartesian3,
  Ellipsoid,
  JulianDate,
  Math as CesiumMath,
  Model as CesiumModel,
  Matrix4 as CesiumMatrix4,
  HeadingPitchRoll as CesiumHPR,
  Transforms as CesiumTransforms,
  SceneTransforms as CesiumSceneTransforms,
  Material as CesiumMaterial,
  MaterialAppearance as CesiumMaterialAppearance,
  Primitive as CesiumPrimitive,
  GeometryInstance as CesiumGeometryInstance,
  PolygonGeometry as CesiumPolygonGeometry,
  PolygonHierarchy as CesiumPolygonHierarchy,
  Texture as CesiumTexture,
} from "cesium";
import { CONFIG } from "./core/config.js";
import { createViewer, attachTerrain, setSunForTime } from "./core/viewer.js";
import { GroundSampler } from "./core/ground.js";
import { AirportIndex, spawnOnRunway } from "./core/airports.js";
import { BuildingLayer } from "./world/buildings.js";
import { RunwayLayer } from "./world/runways.js";
import { createAircraft, stepPhysics } from "./flight/physics.js";
import { Controls, updateAxes } from "./flight/controls.js";
import { ChaseCamera } from "./flight/camera.js";
import { AircraftModel } from "./flight/aircraft.js";
import { Hud } from "./ui/hud.js";
import { LocationPanel, PRESETS } from "./ui/location.js";

const app = document.getElementById("app");
const viewer = createViewer("cesiumContainer");

// ── State ──────────────────────────────────────────────────────────────────
const plane = createAircraft({ ...CONFIG.start, alt: 0, heading: CONFIG.start.heading });
let hour = 12;
let placeLabel = "Seattle, WA";
let paused = false;
const axis = { pitch: 0, roll: 0, throttle: 0, brakes: false };
const hold = { armed: false, targetAlt: CONFIG.start.alt, integral: 0 };
// Elevation used when the DEM tile under the aircraft is not yet resident.
// Seeded from the airport record, so it is never a wrong zero.
let groundFallback = CONFIG.start.alt;

// ── World layers ───────────────────────────────────────────────────────────
// Accurate elevation lookup. Everything that must be geometrically correct —
// where the aircraft sits, where a building's base is, when the wheels touch —
// reads from this rather than from the resident-tile approximation.
const groundSampler = new GroundSampler(viewer);
const buildings = new BuildingLayer(viewer);
const runways = new RunwayLayer(viewer);
const chase = new ChaseCamera(viewer);
const aircraft = new AircraftModel(viewer);
const input = new Controls(window);
const hud = new Hud(app);

let airportIndex = null;
runways.index = null;

attachTerrain(viewer).then(() => {
  // Re-seat the aircraft on the terrain now that real elevations exist.
  placeAtCurrentGround(true);
});

aircraft.load().catch((error) => {
  console.error("[aircraft] model failed to load:", error);
  document.getElementById("load-status").textContent =
    "Aircraft model unavailable — flying the instruments only.";
});

// ── Airport data ───────────────────────────────────────────────────────────
async function loadAirports() {
  try {
    const res = await fetch(CONFIG.airports.dataUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    airportIndex = new AirportIndex(data);
    runways.index = airportIndex;
    locationPanel.index = airportIndex;
    return airportIndex;
  } catch (error) {
    console.warn("[airports] index unavailable:", error);
    return null;
  }
}

// ── Placement helpers ──────────────────────────────────────────────────────
/**
 * Terrain elevation under a point.
 *
 * `globe.getHeight()` only answers once the DEM tile covering that point is
 * resident, and returns `undefined` before that. Collapsing that to 0 is what
 * buries the aircraft: Seattle-Tacoma sits at 132 m, so a 0 fallback puts the
 * aeroplane 130 m underground. We therefore fall back to the airport's own
 * published elevation, which comes from the OurAirports CSV and is correct
 * whether or not the DEM has streamed in.
 */
function terrainHeight(lat, lon) {
  return groundSampler.get(lat, lon, groundFallback);
}

function placeAtCurrentGround(resetSpeed = false) {
  const ground = terrainHeight(plane.lat, plane.lon);
  groundFallback = ground;
  plane.alt = ground + 1.2;
  plane.onGround = true;
  plane.verticalSpeed = 0;
  if (resetSpeed) {
    plane.speed = 0;
    plane.throttle = 0;
    axis.throttle = 0;
  }
  chase.initialised = false;
}

function jumpTo({ lat, lon, height, airport, label, spawn }) {
  plane.lat = lat;
  plane.lon = lon;
  placeLabel = label || "Custom position";
  if (airport && spawn && airportIndex) {
    const runway = airportIndex.bestRunway(airport);
    if (runway) {
      // Use the airport's published elevation as the pre-DEM fallback.
      groundFallback = Number(airport.elev) || 0;
      const spot = spawnOnRunway(airport, runway, CONFIG);
      plane.lat = spot.lat;
      plane.lon = spot.lon;
      plane.heading = spot.heading;
      placeLabel = `${airport.name} · RWY ${runway.ident}`;
      placeAtCurrentGround(true);
      // Correct the placement once the real DEM answers, so the wheels sit on
      // the tarmac rather than on a coarse low-zoom interpolation of it.
      groundSampler
        .seed([[plane.lat, plane.lon]])
        .then(() => placeAtCurrentGround(false));
      document.body.classList.remove("flying");
      return;
    }
  }
  // Free flight / in-air reposition.
  //
  // `groundFallback` is deliberately reset here: it holds the *previous*
  // location's airport elevation, and carrying a Seattle 132 m over Manhattan
  // would drop the aircraft onto (or under) the wrong landscape. Until the DEM
  // tile for the new spot is resident, 0 is the honest answer and the DEM
  // takes over as soon as it arrives.
  groundFallback = 0;
  groundSampler.seed([[lat, lon]]).then(() => {
    const g = terrainHeight(lat, lon);
    // Only correct the altitude if the pilot hasn't taken over in the
    // meantime, and never drag a moving aircraft back to the jump point.
    if (Math.abs(plane.lat - lat) < 0.5 && Math.abs(plane.lon - lon) < 0.5) {
      plane.alt = g + (height || 1000);
      hold.armed = true;
  hold.integral = 0;
      hold.targetAlt = plane.alt;
    }
  });
  const ground = terrainHeight(lat, lon);
  plane.alt = ground + (height || 1000);
  plane.onGround = false;
  plane.airborne = true;
  // Start in trimmed equilibrium, not at an arbitrary speed. Lift balances
  // weight at roughly 92 m/s for this airframe at cl 0.25; dropping in at
  // 55 m/s puts the aeroplane below stall, so it sinks into the ground within
  // a few seconds and the free-flight entry point looks broken.
  plane.speed = 95;
  plane.pitch = 0.04;
  plane.verticalSpeed = 0;
  // Arm the altitude hold immediately so the aeroplane flies level from the
  // first frame instead of settling in from a dive.
  hold.armed = true;
  hold.integral = 0;
  hold.targetAlt = plane.alt;
  placeLabel = label || "Free flight";
  chase.initialised = false;
}

// ── UI ─────────────────────────────────────────────────────────────────────
const locationPanel = new LocationPanel(app, viewer, null, jumpTo);
locationPanel.index = null;

const presetBar = document.createElement("div");
presetBar.className = "preset-bar";
for (const preset of PRESETS) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "preset";
  button.textContent = preset.label;
  button.addEventListener("click", () =>
    jumpTo({
      lat: preset.lat,
      lon: preset.lon,
      height: preset.height,
      label: preset.label,
    }),
  );
  presetBar.appendChild(button);
}
app.appendChild(presetBar);

const timeControl = document.createElement("div");
timeControl.className = "time-control";
timeControl.innerHTML = `
  <label for="time-slider">TIME OF DAY</label>
  <input id="time-slider" type="range" min="0" max="24" step="0.25" value="12" />
  <span id="time-readout">12:00</span>
`;
app.appendChild(timeControl);
const timeSlider = timeControl.querySelector("#time-slider");
const timeReadout = timeControl.querySelector("#time-readout");
timeSlider.addEventListener("input", () => {
  hour = Number(timeSlider.value);
  timeReadout.textContent = `${String(Math.floor(hour)).padStart(2, "0")}:${String(
    Math.floor((hour % 1) * 60),
  ).padStart(2, "0")}`;
  setSunForTime(viewer, hour);
});

document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === "KeyP") {
    paused = !paused;
    document.body.classList.toggle("paused", paused);
  }
  if (e.code === "KeyC") {
    document.body.classList.toggle("clean");
  }
  if (e.code === "KeyH") {
    document.body.classList.toggle("hide-ui");
  }
});
setSunForTime(viewer, hour);

// ── Main loop ──────────────────────────────────────────────────────────────
const { fixedStep, maxSubSteps, maxFrameDelta } = CONFIG.sim;
let accumulator = 0;
let last = performance.now();
let streamTimer = 0;
let started = false;

/**
 * Render, with recovery.
 *
 * We drive `viewer.render()` ourselves instead of letting Cesium's default
 * loop do it, because that default calls it from inside a timer with no error
 * boundary: a single frame that throws — for instance a degenerate command
 * left behind by terrain-conforming geometry — permanently stops rendering and
 * the screen freezes on the last good image with no way back.
 *
 * Catching it costs one try/catch and makes a bad frame survivable. On the
 * first failure we reset the camera and drop the terrain-conforming runway
 * layer, which is the only geometry whose bounds depend on resident terrain
 * tiles and therefore the only thing that can go stale. If that is not enough,
 * we shed the streamed building tiles too, and the world rebuilds as the
 * aircraft keeps flying. It is strictly better than a dead screen.
 */
let renderFailures = 0;
function renderSafely() {
  try {
    viewer.render();
    if (renderFailures > 0) {
      console.warn(`[render] recovered after ${renderFailures} failed frame(s)`);
      renderFailures = 0;
    }
  } catch (error) {
    renderFailures++;
    if (renderFailures === 1) {
      console.error("[render] frame failed; recovering", error);
      chase.initialised = false;
      runways.destroy();
      runways.index = airportIndex;
    } else if (renderFailures === 2) {
      console.error("[render] still failing; shedding streamed buildings");
      buildings.destroy();
    } else if (renderFailures > 12) {
      // Hard reset: if it is genuinely unrecoverable, stop hammering the GPU.
      console.error("[render] unrecoverable; pausing rendering");
      viewer.useDefaultRenderLoop = false;
    }
  }
}

function frame(now) {
  const rawDelta = (now - last) / 1000;
  last = now;
  const frameDelta = Math.min(Math.max(rawDelta, 0), maxFrameDelta);

  const ground = terrainHeight(plane.lat, plane.lon);
  const altitudeAgl = plane.alt - ground;

  if (!paused) {
    accumulator += frameDelta;
    let steps = 0;
    while (accumulator >= fixedStep && steps < maxSubSteps) {
      updateAxes(axis, hold, input, plane, fixedStep);
      stepPhysics(plane, axis, ground, fixedStep);
      accumulator -= fixedStep;
      steps++;
    }
    // If we blew the sub-step budget, drop the backlog rather than spiral.
    if (steps >= maxSubSteps) accumulator = 0;
  }

  // Visuals run on the render clock, not the physics clock, but they use the
  // same frame delta so smoothing stays frame-rate independent.
  chase.update(plane, ground, frameDelta);
  aircraft.update(plane, frameDelta);

  // Stream buildings and runways on a coarse cadence — they are expensive to
  // fetch and do not need per-frame evaluation.
  streamTimer += frameDelta;
  if (streamTimer > 0.35) {
    streamTimer = 0;
    // Keep the elevation cache fed ahead of the aircraft, so ground contact and
    // building placement stay exact as we move rather than snapping to whatever
    // coarse tile happens to be resident.
    groundSampler.request(plane.lat, plane.lon);
    {
      const mPerDeg = 111320;
      const ahead = (plane.speed * 3) / mPerDeg; // 3 s of look-ahead
      groundSampler.request(
        plane.lat + Math.cos(plane.heading) * ahead,
        plane.lon + (Math.sin(plane.heading) * ahead) /
          Math.max(0.05, Math.cos((plane.lat * Math.PI) / 180)),
      );
    }
    buildings.update(plane.lat, plane.lon, altitudeAgl);
    runways.update(plane.lat, plane.lon, altitudeAgl);
    locationPanel.updateAirports(plane.lat, plane.lon);
  }

  hud.update(
    plane,
    {
      altitudeAgl,
      hour,
      place: placeLabel,
    },
    now,
  );

  if (!started) {
    started = true;
    document.body.classList.add("ready");
    document.getElementById("load-status").textContent = "";
  }

  // We own the render call so it can be wrapped in an error boundary.
  renderSafely();

  requestAnimationFrame(frame);
}

// Take the render loop away from Cesium so `renderSafely` is the only caller
// of render(). Left running, Cesium's internal timer would also render —
// unprotected and out of step with the physics step.
viewer.useDefaultRenderLoop = false;

requestAnimationFrame(frame);

loadAirports().then((index) => {
  if (index) {
    // Start on the nearest real runway rather than a bare coordinate.
    const near = index.near(CONFIG.start.lat, CONFIG.start.lon, 60000, 1);
    if (near.length) {
      const { airport } = near[0];
      const runway = index.bestRunway(airport);
      if (runway) {
        groundFallback = Number(airport.elev) || 0;
        const spot = spawnOnRunway(airport, runway, CONFIG);
        plane.lat = spot.lat;
        plane.lon = spot.lon;
        plane.heading = spot.heading;
        placeLabel = `${airport.name} · RWY ${runway.ident}`;
        placeAtCurrentGround(true);
        groundSampler
          .seed([[plane.lat, plane.lon]])
          .then(() => placeAtCurrentGround(false));
        console.log(`[start] ${airport.name} runway ${runway.ident}`);
      }
    }
  }
});

// Diagnostics for the browser console — useful and harmless.
// `plane` is the physics state; `aircraft` is the model wrapper. Both are
// exposed so a console poke can inspect either without reaching into modules.
window.SKYWARD = {
  viewer,
  plane,
  aircraft,
  buildings,
  runways,
  groundSampler,
  chase,
  CONFIG,
  jumpTo,
  // A few Cesium classes, named explicitly.
  //
  // `import * as Cesium` cannot be exposed wholesale: Rollup tree-shakes even a
  // namespace import down to the members it can observe being used, so the
  // global comes out partial and every missing member reads like a broken app.
  // Naming them here means they are genuinely retained.
  cesium: {
    Model: CesiumModel,
    Matrix4: CesiumMatrix4,
    HeadingPitchRoll: CesiumHPR,
    Transforms: CesiumTransforms,
    SceneTransforms: CesiumSceneTransforms,
    Material: CesiumMaterial,
    MaterialAppearance: CesiumMaterialAppearance,
    Primitive: CesiumPrimitive,
    GeometryInstance: CesiumGeometryInstance,
    PolygonGeometry: CesiumPolygonGeometry,
    PolygonHierarchy: CesiumPolygonHierarchy,
    Texture: CesiumTexture,
    Cartesian3,
    Ellipsoid,
  },
  get index() {
    return airportIndex;
  },
};

// NOTE: there is deliberately no `window.Cesium` global here.
//
// It looks like a useful debugging affordance and it is a trap. Rollup
// tree-shakes even a namespace import down to the members it can observe being
// used, so a global assembled that way is partial — `Matrix4.getElement`,
// `Matrix3.multiplyByPoint` and `Matrix4.multiplyByPointTranslation` all
// reported "not a function" against it, each of which reads exactly like a
// broken application. Verification harnesses must not depend on it; the ones
// in `scripts/` do their own arithmetic on the values the app exposes.
