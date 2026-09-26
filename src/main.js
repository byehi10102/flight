import {
  Cartographic, Cartesian3, Ellipsoid, JulianDate, Math as CesiumMath, Model as CesiumModel,
  Matrix4 as CesiumMatrix4, HeadingPitchRoll as CesiumHPR, Transforms as CesiumTransforms,
  SceneTransforms as CesiumSceneTransforms, Material as CesiumMaterial,
  MaterialAppearance as CesiumMaterialAppearance, Primitive as CesiumPrimitive,
  GeometryInstance as CesiumGeometryInstance, PolygonGeometry as CesiumPolygonGeometry,
  PolygonHierarchy as CesiumPolygonHierarchy, Texture as CesiumTexture,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { CONFIG } from "./core/config.js";
import { createViewer, attachTerrain, setSunForTime } from "./core/viewer.js";
import { GroundSampler } from "./core/ground.js";
import { AirportIndex } from "./core/airports.js";
import { BuildingLayer } from "./world/buildings.js";
import { RunwayLayer } from "./world/runways.js";
import { createAircraft, stepPhysics, clamp } from "./flight/physics.js";
import { Controls, updateAxes } from "./flight/controls.js";
import { ChaseCamera } from "./flight/camera.js";
import { AircraftModel } from "./flight/aircraft.js";
import { Hud } from "./ui/hud.js";
import { LocationPanel, PRESETS } from "./ui/location.js";

const app = document.getElementById("app");
const viewer = createViewer("cesiumContainer");

// ── Aircraft ───────────────────────────────────────────────────────────────
// Spawn airborne over the chosen city — no runway, no takeoff sequence.
const startCity = CONFIG.cities.find((c) => c.label === CONFIG.start.city) || CONFIG.cities[0];
const plane = createAircraft({
  lat: startCity.lat,
  lon: startCity.lon,
  alt: CONFIG.start.alt,
  heading: CONFIG.start.heading,
  speed: CONFIG.start.speed,
  pitch: CONFIG.start.pitch,
});
plane.onGround = false;
plane.airborne = true;
plane.verticalSpeed = 0;
plane.throttle = CONFIG.physics.idleThrustFrac;

let hour = 12;
let placeLabel = startCity.label;
let paused = false;
const axis = { pitch: 0, roll: 0, throttle: 0, brakes: false, flaps: false };
const hold = { armed: true, targetAlt: plane.alt, integral: 0 };
let groundFallback = CONFIG.start.alt;

// ── World ──────────────────────────────────────────────────────────────────
const groundSampler = new GroundSampler(viewer);
const buildings = new BuildingLayer(viewer);
const runways = new RunwayLayer(viewer);
const chase = new ChaseCamera(viewer);
const aircraft = new AircraftModel(viewer);
const input = new Controls(window);
const hud = new Hud(app);

let airportIndex = null;
runways.index = null;

attachTerrain(viewer).then(() => spawnOverCity(CONFIG.start.city).catch(() => {}));

aircraft.load().catch((error) => {
  console.error("[aircraft] model failed to load:", error);
  document.getElementById("load-status").textContent =
    "Aircraft model unavailable — flying the instruments only.";
});

// ── Placement helpers ─────────────────────────────────────────────────────
function terrainHeight(lat, lon) {
  return groundSampler.get(lat, lon, groundFallback);
}

/** Drop in over a city, trimmed and holding altitude (airborne, no runway). */
async function spawnOverCity(label) {
  const c = CONFIG.cities.find((x) => x.label === label) || CONFIG.cities[0];
  return spawnAirborne(c.lat, c.lon, c.label);
}

/** Place the aircraft airborne at cruise speed over (lat, lon). */
async function spawnAirborne(lat, lon, label, altitude = CONFIG.start.alt) {
  placeLabel = label;
  plane.lat = lat;
  plane.lon = lon;
  await groundSampler.seed([[lat, lon]]).catch(() => {});
  const ground = terrainHeight(lat, lon);
  plane.alt = ground + altitude;
  plane.onGround = false;
  plane.airborne = true;
  plane.speed = CONFIG.start.speed;
  plane.pitch = CONFIG.start.pitch;
  plane.heading = CONFIG.start.heading;
  plane.throttle = CONFIG.physics.idleThrustFrac;
  plane.verticalSpeed = 0;
  hold.armed = true;
  hold.integral = 0;
  hold.targetAlt = plane.alt;
  document.body.classList.remove("flying");
  chase.initialised = false;
  return groundSampler.seed([[lat, lon]]).catch(() => {});
}

/** Jump anywhere, always airborne (city / airport / free point). */
function jumpTo(opts) {
  if (opts.city) { spawnOverCity(opts.city); return; }
  if (opts.airport && airportIndex) {
    spawnAirborne(opts.airport.lat, opts.airport.lon, opts.label || opts.airport.name, opts.height);
    return;
  }
  spawnAirborne(opts.lat, opts.lon, opts.label || "Free flight", opts.height);
}

// ── Airport index for the location panel (no runway start) ─────────────────
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

// ── UI ─────────────────────────────────────────────────────────────────────
const locationPanel = new LocationPanel(app, viewer, null, jumpTo);

const cityBar = document.createElement("div");
cityBar.className = "preset-bar";
cityBar.insertAdjacentHTML("beforeend", "<div class='preset-title'>START OVER</div>");
for (const c of CONFIG.cities) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "preset";
  button.textContent = c.label;
  button.addEventListener("click", () => jumpTo({ city: c.label }));
  cityBar.appendChild(button);
}
app.appendChild(cityBar);

const presetBar = document.createElement("div");
presetBar.className = "preset-bar";
presetBar.insertAdjacentHTML("beforeend", "<div class='preset-title'>GO TO</div>");
for (const preset of PRESETS) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "preset";
  button.textContent = preset.label;
  button.addEventListener("click", () =>
    jumpTo({ lat: preset.lat, lon: preset.lon, height: preset.height, label: preset.label }),
  );
  presetBar.appendChild(button);
}
app.appendChild(presetBar);

const timeControl = document.createElement("div");
timeControl.className = "time-control";
timeControl.innerHTML = `<label for="time-slider">TIME OF DAY</label>
  <input id="time-slider" type="range" min="0" max="24" step="0.25" value="12" />
  <span id="time-readout">12:00</span>`;
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
  if (e.code === "KeyP") { paused = !paused; document.body.classList.toggle("paused", paused); }
  if (e.code === "KeyC") { document.body.classList.toggle("clean"); }
  if (e.code === "KeyH") { document.body.classList.toggle("hide-ui"); }
});
setSunForTime(viewer, hour);

// ── Look-around: right-drag yaws/pitches the gaze; springs back on release ──
const canvas = viewer.scene.canvas;
let lookActive = false;
canvas.style.cursor = "grab";
canvas.addEventListener("pointerdown", (e) => {
  if (e.button === 2) { e.preventDefault(); lookActive = true; canvas.style.cursor = "grabbing"; }
});
canvas.addEventListener("pointermove", (e) => {
  if (lookActive) chase.look(e.movementX || 0, e.movementY || 0);
});
const releaseLook = () => {
  if (lookActive) { lookActive = false; chase.endLook(); canvas.style.cursor = "grab"; }
};
canvas.addEventListener("pointerup", releaseLook);
canvas.addEventListener("pointerleave", releaseLook);
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// ── Main loop ──────────────────────────────────────────────────────────────
const { fixedStep, maxSubSteps, maxFrameDelta } = CONFIG.sim;
let accumulator = 0;
let last = performance.now();
let streamTimer = 0;
let started = false;
let renderFailures = 0;

function renderSafely() {
  try {
    viewer.render();
    if (renderFailures > 0) { console.warn(`[render] recovered after ${renderFailures} failed frame(s)`); renderFailures = 0; }
  } catch (error) {
    renderFailures++;
    if (renderFailures === 1) { console.error("[render] frame failed; recovering", error); chase.initialised = false; }
    else if (renderFailures === 2) { console.error("[render] still failing; shedding streamed buildings"); buildings.destroy(); }
    else if (renderFailures > 12) { console.error("[render] unrecoverable; pausing rendering"); viewer.useDefaultRenderLoop = false; }
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
    if (steps >= maxSubSteps) accumulator = 0;
  }

  chase.update(plane, ground, frameDelta);
  aircraft.update(plane, frameDelta);

  streamTimer += frameDelta;
  if (streamTimer > 0.35) {
    streamTimer = 0;
    groundSampler.request(plane.lat, plane.lon);
    {
      const mPerDeg = 111320;
      const ahead = (plane.speed * 3) / mPerDeg;
      groundSampler.request(
        plane.lat + (Math.cos(plane.heading) * ahead),
        plane.lon + (Math.sin(plane.heading) * ahead) / Math.max(0.05, Math.cos((plane.lat * Math.PI) / 180)),
      );
    }
    buildings.update(plane.lat, plane.lon, altitudeAgl);
    runways.update(plane.lat, plane.lon, altitudeAgl);
    locationPanel.updateAirports(plane.lat, plane.lon);
  }

  hud.update(plane, { altitudeAgl, hour, place: placeLabel }, now);

  if (!started) {
    started = true;
    document.body.classList.add("ready");
    document.getElementById("load-status").textContent = "";
  }

  renderSafely();
  requestAnimationFrame(frame);
}

viewer.useDefaultRenderLoop = false;
requestAnimationFrame(frame);

loadAirports().catch(() => {});
setSunForTime(viewer, hour);

window.SKYWARD = {
  plane, viewer, chase, input, controls: new Controls(window), aircraft, buildings,
  runways, groundSampler, hold,
  cesium: {
    Cartographic, Cartesian3, Ellipsoid, JulianDate, CesiumMath, CesiumModel,
    CesiumMatrix4, CesiumHPR, CesiumTransforms, CesiumSceneTransforms,
    CesiumMaterial, CesiumMaterialAppearance, CesiumPrimitive,
    CesiumGeometryInstance, CesiumPolygonGeometry, CesiumPolygonHierarchy, CesiumTexture,
  },
};
