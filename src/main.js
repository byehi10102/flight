import * as THREE from "three";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { CONFIG } from "./core/config.js";
import { createViewer, attachTerrain, setSunForTime, initMiniViewer, getMiniViewer, setMinimapCamera, setStreetsVisible } from "./core/viewer.js";
import { GroundSampler } from "./core/ground.js";
import { PlanePhysics } from "./plane/planePhysics.js";
import { PlaneController } from "./plane/planeController.js";
import { PlaneModel } from "./plane/planeModel.js";
import { Hud } from "./ui/hud.js";
import { EngineAudio } from "./flight/engine.js";
import { particles } from "./utils/particles.js";
import { reverseGeocode, reverseGeocodeDetailed, calculateDistance } from "./utils/geo.js";

const States = {
  MENU: "MENU",
  PICK_SPAWN: "PICK_SPAWN",
  TRANSITIONING: "TRANSITIONING",
  FLYING: "FLYING",
  PAUSED: "PAUSED",
};

let currentState = States.MENU;

// Flight speeds are MPH throughout (100 slow cruise, 1000 max on W, 2000 on
// boost); world movement needs m/s.
const MPH_TO_MPS = 0.44704;

const state = {
  lon: -117.9143,
  lat: 33.8366,
  alt: 1000,
  agl: 1000,
  heading: 0,
  pitch: 0,
  roll: 0,
  speed: 0,
  throttle: 0,
  stallFactor: 0,
  onGround: false,
  spawnName: null,
  spawnLon: null,
  spawnLat: null,
};

// ── Three.js overlay ─────────────────────────────────────────────────────────
let scene, camera, renderer, threeContainer;
let planeModel;
let physics = new PlanePhysics();
let controller = new PlaneController();
let hud = new Hud();
let audio = new EngineAudio();
let clock = new THREE.Clock();
let groundSampler;
let spawnMarker = null;
let spawnIndicator = null;
let pendingSpawnName = null;
let initialCameraView = null;
let flightStartTime = 0;
let lastCrashCheck = 0;
let minimapUpdateTimer = 0;
let sunUpdateTimer = 0;
let geocodeTimer = 0;
let lastGeocodePos = { lon: 0, lat: 0 };
let currentRegionName = null;
let terrainReady = false;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const mainMenu = document.getElementById("mainMenu");
const pauseMenu = document.getElementById("pauseMenu");
const uiContainer = document.getElementById("uiContainer");
const spawnInstruction = document.getElementById("spawnInstruction");
const confirmSpawnBtn = document.getElementById("confirmSpawnBtn");
const startBtn = document.getElementById("startBtn");
const loadingIndicator = document.getElementById("loadingIndicator");
const loadingText = document.getElementById("loadingText");
const vignette = document.getElementById("transition-vignette");
const locationSearch = document.getElementById("locationSearch");
const searchResults = document.getElementById("search-results");
const instructionText = document.getElementById("instruction-text");

const loadingStatus = { model: false, cesium: false, globe: false, terrain: false, failed: false };

function updateLoadingUI() {
  if (!loadingIndicator || !loadingText || !startBtn) return;
  if (currentState === States.FLYING || currentState === States.TRANSITIONING) {
    loadingIndicator.classList.add("hidden");
    return;
  }
  const isAllLoaded = loadingStatus.model && loadingStatus.cesium && loadingStatus.globe && loadingStatus.terrain;
  if (loadingStatus.failed) {
    loadingText.textContent = "Loading Failed. Please Refresh.";
  } else if (!isAllLoaded) {
    if (!loadingStatus.model) loadingText.textContent = "Loading Aircraft Model...";
    else if (!loadingStatus.cesium) loadingText.textContent = "Loading Satellite Imagery...";
    else if (!loadingStatus.globe) loadingText.textContent = "Loading Globe Surface...";
    else if (!loadingStatus.terrain) loadingText.textContent = "Loading Terrain Data...";
  }
  if (!isAllLoaded || loadingStatus.failed) {
    loadingText.textContent = loadingText.textContent || "Loading...";
    startBtn.disabled = true;
    startBtn.style.pointerEvents = "none";
    loadingIndicator.classList.remove("hidden");
  } else {
    loadingIndicator.classList.add("hidden");
    startBtn.disabled = false;
    startBtn.style.pointerEvents = "auto";
  }
}

// ── Initialisation ───────────────────────────────────────────────────────────
const viewer = createViewer("cesiumContainer");
loadingStatus.cesium = true;
updateLoadingUI();

groundSampler = new GroundSampler(viewer);

let globeLoadingStarted = false;
const unregisterGlobeTracker = viewer.scene.postRender.addEventListener(() => {
  const tilesLoaded = viewer.scene.globe.tilesLoaded;
  if (!tilesLoaded) globeLoadingStarted = true;
  if (tilesLoaded) {
    const surface = viewer.scene.globe._surface;
    const hasTiles = surface && surface._tilesToRender && surface._tilesToRender.length > 0;
    if (hasTiles) {
      loadingStatus.globe = true;
      updateLoadingUI();
      unregisterGlobeTracker();
    }
  }
});

viewer.scene.globe.tileLoadProgressEvent.addEventListener((queueLength) => {
  if (loadingIndicator && loadingText && currentState === States.PICK_SPAWN) {
    if (queueLength > 0) {
      loadingText.textContent = "Loading Terrain...";
      loadingIndicator.classList.remove("hidden");
    } else {
      loadingIndicator.classList.add("hidden");
    }
  }
});

// Fallback: after 8 seconds, enable the start button even if terrain hasn't fully loaded.
// The Re:Earth provider can be slow or unavailable in some environments; the game should
// still be playable with the ellipsoid as a fallback.
setTimeout(() => {
  if (!loadingStatus.globe) {
    loadingStatus.globe = true;
    loadingStatus.terrain = true;
    updateLoadingUI();
  }
}, 8000);

// ── Preload terrain ─────────────────────────────────────────────────────────
async function preloadTerrain() {
  try {
    const provider = await attachTerrain(viewer);
    if (provider) {
      terrainReady = true;
      loadingStatus.terrain = true;
      updateLoadingUI();
      await groundSampler.seed([[state.lat, state.lon]]);
    }
  } catch (error) {
    console.warn("[terrain] Preload failed, will retry on spawn:", error);
  }
}

// ── Three.js setup ───────────────────────────────────────────────────────────
// The Three.js camera stays at the origin. The plane model is placed at a
// local offset (BASE_PLANE_POS) and rotates around the origin. The Cesium
// camera handles the world-space tracking. This layer-based compositing
// keeps the plane visible over the globe.
function initThree() {
  clock = new THREE.Clock();
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, window.innerWidth / window.innerHeight, CONFIG.camera.near, CONFIG.camera.far);
  camera.position.set(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, premultipliedAlpha: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;
  threeContainer = document.getElementById("threeContainer");
  threeContainer.appendChild(renderer.domElement);
  threeContainer.classList.add("hidden");

  const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
  ambientLight.layers.enable(1);
  scene.add(ambientLight);
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
  directionalLight.position.set(5, 10, 5);
  directionalLight.layers.enable(1);
  scene.add(directionalLight);

  planeModel = new PlaneModel(scene);
  particles.init(scene);
  planeModel.load().then(() => {
    loadingStatus.model = true;
    updateLoadingUI();
  }).catch((err) => {
    console.error("Failed to load model:", err);
    loadingStatus.failed = true;
    updateLoadingUI();
  });
}

// ── Cesium camera: positioned at the plane, looking forward ────────────────
function setCameraToPlane(lon, lat, alt, heading, pitch, roll) {
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
    orientation: {
      heading: Cesium.Math.toRadians(heading),
      pitch: Cesium.Math.toRadians(pitch),
      roll: Cesium.Math.toRadians(roll),
    },
  });
  viewer.scene.requestRender();
}

// ── Spawn picker ─────────────────────────────────────────────────────────────
function enterSpawnPicking(useVignette = true) {
  if (vignette && useVignette) {
    vignette.classList.add("solid");
    vignette.style.opacity = "1";
  }
  const delay = useVignette ? 500 : 0;

  setTimeout(() => {
    if (spawnInstruction) spawnInstruction.classList.remove("hidden");
    if (threeContainer) threeContainer.classList.add("hidden");
    if (uiContainer) uiContainer.classList.add("hidden");
    currentState = States.PICK_SPAWN;
    setStreetsVisible(true);
    showNotablePlaces();
    if (confirmSpawnBtn) confirmSpawnBtn.classList.add("hidden");
    if (searchResults) searchResults.style.display = "none";
    if (locationSearch) locationSearch.value = "";

    if (instructionText) {
      instructionText.style.display = "block";
      instructionText.textContent = "CLICK ANYWHERE ON THE MAP OR SEARCH FOR A LOCATION";
    }

    const ctrl = viewer.scene.screenSpaceCameraController;
    ctrl.enableRotate = true;
    ctrl.enableTranslate = true;
    ctrl.enableZoom = true;
    ctrl.enableTilt = true;
    ctrl.enableLook = true;

    if (spawnMarker) {
      viewer.entities.remove(spawnMarker);
      spawnMarker = null;
    }
    if (spawnIndicator) {
      viewer.entities.remove(spawnIndicator);
      spawnIndicator = null;
    }
    pendingSpawnName = null;

    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(state.lon, state.lat, 15000),
      duration: 2.0,
      complete: () => {
        if (vignette) {
          vignette.style.opacity = "0";
          vignette.classList.remove("solid");
        }
      },
    });
  }, delay);
}

function exitSpawnPicking() {
  setStreetsVisible(false);
  clearNotablePlaces();
  if (spawnInstruction) spawnInstruction.classList.add("hidden");
  if (confirmSpawnBtn) confirmSpawnBtn.classList.add("hidden");
  if (mainMenu) mainMenu.classList.remove("hidden");
  currentState = States.MENU;
  loadingIndicator.classList.add("hidden");

  const ctrl = viewer.scene.screenSpaceCameraController;
  ctrl.enableRotate = false;
  ctrl.enableTranslate = false;
  ctrl.enableZoom = false;
  ctrl.enableTilt = false;
  ctrl.enableLook = false;

  if (spawnMarker) {
    viewer.entities.remove(spawnMarker);
    spawnMarker = null;
  }

  viewer.camera.flyTo({
    ...initialCameraView,
    duration: 2.5,
  });
}

// ── Search ───────────────────────────────────────────────────────────────────
let searchDebounce = null;

function setupSearch() {
  if (!locationSearch) return;

  locationSearch.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    const query = locationSearch.value.trim();
    if (query.length < 3) {
      searchResults.style.display = "none";
      return;
    }
    searchDebounce = setTimeout(() => performSearch(query), 500);
  });

  locationSearch.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      const query = locationSearch.value.trim();
      if (query.length >= 3) performSearch(query);
    }
  });

  document.addEventListener("click", (e) => {
    if (!locationSearch.contains(e.target) && !searchResults.contains(e.target)) {
      searchResults.style.display = "none";
    }
  });
}

async function performSearch(query) {
  try {
    searchResults.style.display = "block";
    searchResults.innerHTML = '<div class="search-result-item">Searching...</div>';

    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`
    );
    const data = await response.json();

    searchResults.innerHTML = "";
    if (data.length === 0) {
      searchResults.innerHTML = '<div class="search-result-item">No results found</div>';
      return;
    }

    data.forEach((item) => {
      const div = document.createElement("div");
      div.className = "search-result-item";
      div.textContent = item.display_name;
      div.addEventListener("click", () => selectSearchResult(parseFloat(item.lon), parseFloat(item.lat), item.display_name));
      searchResults.appendChild(div);
    });
  } catch (error) {
    console.error("Search error:", error);
    searchResults.innerHTML = '<div class="search-result-item">Search unavailable</div>';
  }
}

function selectSearchResult(lon, lat, name) {
  state.lon = lon;
  state.lat = lat;
  state.alt = 1500;
  // Nominatim display_name is already hierarchical: place, city, county,
  // state, postcode, country — show the meaningful slice of it.
  const nameParts = name.split(",").map((s) => s.trim()).filter(Boolean);
  const detailed = nameParts.slice(0, 4).join(", ").toUpperCase();
  pendingSpawnName = nameParts.slice(0, 2).join(", ").toUpperCase();

  if (instructionText) instructionText.textContent = detailed;

  groundSampler.seed([[lat, lon]]).then(() => {
    const ground = groundSampler.get(lat, lon, 0);
    state.alt = ground + 1500;
  }).catch(() => {});

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, 5000),
    duration: 1.5,
  });

  if (spawnMarker) viewer.entities.remove(spawnMarker);
  spawnMarker = viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(lon, lat),
    point: {
      pixelSize: 15,
      color: Cesium.Color.RED,
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });

  if (confirmSpawnBtn) confirmSpawnBtn.classList.remove("hidden");
  if (searchResults) searchResults.style.display = "none";
  if (locationSearch) locationSearch.value = name;
}

function setupSpawnPicker() {
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

  handler.setInputAction((click) => {
    if (currentState !== States.PICK_SPAWN) return;

    const clickX = click.position.x;
    const clickY = click.position.y;
    const searchRect = locationSearch ? locationSearch.getBoundingClientRect() : null;
    if (searchRect) {
      const pad = 20;
      if (
        clickX >= searchRect.left - pad &&
        clickX <= searchRect.right + pad &&
        clickY >= searchRect.top - pad - 40 &&
        clickY <= searchRect.bottom + pad + 100
      ) {
        return;
      }
    }
    const confirmRect = confirmSpawnBtn ? confirmSpawnBtn.getBoundingClientRect() : null;
    if (confirmRect) {
      const pad = 20;
      if (
        clickX >= confirmRect.left - pad &&
        clickX <= confirmRect.right + pad &&
        clickY >= confirmRect.top - pad &&
        clickY <= confirmRect.bottom + pad
      ) {
        return;
      }
    }

    const zoomRect = document.getElementById("zoom-controls")?.getBoundingClientRect();
    if (zoomRect) {
      const pad = 12;
      if (
        clickX >= zoomRect.left - pad &&
        clickX <= zoomRect.right + pad &&
        clickY >= zoomRect.top - pad &&
        clickY <= zoomRect.bottom + pad
      ) {
        return;
      }
    }

    // Landmarks first: tapping a named pin spawns right there.
    try {
      const picked = viewer.scene.pick(click.position);
      const notable = picked?.id?.notable;
      if (notable) {
        selectSpawnPoint(notable.lon, notable.lat, 0, notable.name, notable.name);
        return;
      }
    } catch (e) { /* fall through to globe picking */ }

    const ray = viewer.camera.getPickRay(click.position);
    const cartesian = viewer.scene.globe.pick(ray, viewer.scene);

    if (cartesian) {
      const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
      const lon = Cesium.Math.toDegrees(cartographic.longitude);
      const lat = Cesium.Math.toDegrees(cartographic.latitude);

      selectSpawnPoint(lon, lat, cartographic.height || 0, null, null, cartesian);
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // Guaranteed zoom (wheel/pinch can be finicky across browsers): +/- buttons.
  const zoomStep = (dir) => {
    try {
      if (currentState !== States.PICK_SPAWN) return;
      const h = viewer.camera.positionCartographic?.height || 10000;
      const amt = Math.max(100, h * 0.35);
      if (dir > 0) viewer.camera.zoomOut(amt);
      else viewer.camera.zoomIn(amt);
    } catch (e) { /* cosmetic */ }
  };
  document.getElementById("zoomInBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    zoomStep(-1);
  });
  document.getElementById("zoomOutBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    zoomStep(1);
  });
}

// ── Spawn selection shared by map clicks, landmark pins and search ──────────
function selectSpawnPoint(lon, lat, baseHeight, label, shortName, cartesian) {
  state.lon = lon;
  state.lat = lat;
  state.alt = Math.max(0, baseHeight) + 1500;

  if (instructionText) instructionText.textContent = label || "FETCHING LOCATION INFO...";
  if (shortName) pendingSpawnName = shortName;

  groundSampler.seed([[lat, lon]]).then(() => {
    const ground = groundSampler.get(lat, lon, baseHeight);
    state.alt = ground + 1500;
  }).catch(() => {});

  if (!label) {
    reverseGeocodeDetailed(lon, lat).then((place) => {
      pendingSpawnName = place.short;
      if (instructionText) instructionText.textContent = place.label;
    }).catch(() => {});
  }

  if (spawnMarker) viewer.entities.remove(spawnMarker);
  spawnMarker = viewer.entities.add({
    position: cartesian || Cesium.Cartesian3.fromDegrees(lon, lat, Math.max(0, baseHeight)),
    point: {
      pixelSize: 15,
      color: Cesium.Color.RED,
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });

  if (confirmSpawnBtn) confirmSpawnBtn.classList.remove("hidden");
}

// ── Notable landmarks: minimal readable labels on the spawn map ─────────────
const NOTABLE_PLACES = [
  { name: "WHITE HOUSE", lat: 38.8977, lon: -77.0365 },
  { name: "STATUE OF LIBERTY", lat: 40.6892, lon: -74.0445 },
  { name: "HOLLYWOOD SIGN", lat: 34.1341, lon: -118.3215 },
  { name: "DISNEYLAND", lat: 33.8121, lon: -117.919 },
  { name: "KNOTT'S BERRY FARM", lat: 33.8441, lon: -118.0002 },
  { name: "GOLDEN GATE BRIDGE", lat: 37.8199, lon: -122.4783 },
  { name: "SPACE NEEDLE", lat: 47.6205, lon: -122.3493 },
  { name: "GRAND CANYON", lat: 36.1069, lon: -112.1129 },
  { name: "MOUNT RUSHMORE", lat: 43.8791, lon: -103.4591 },
  { name: "EIFFEL TOWER", lat: 48.8584, lon: 2.2945 },
  { name: "BIG BEN", lat: 51.5007, lon: -0.1246 },
  { name: "COLOSSEUM", lat: 41.8902, lon: 12.4922 },
  { name: "TAJ MAHAL", lat: 27.1751, lon: 78.0421 },
  { name: "SYDNEY OPERA HOUSE", lat: -33.8568, lon: 151.2153 },
  { name: "GREAT WALL", lat: 40.4319, lon: 116.5704 },
  { name: "MOUNT FUJI", lat: 35.3606, lon: 138.7274 },
];
let notableEntities = [];

function showNotablePlaces() {
  clearNotablePlaces();
  try {
    for (const p of NOTABLE_PLACES) {
      const ent = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 300),
        point: {
          pixelSize: 9,
          color: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.RED,
          outlineWidth: 2,
        },
        label: {
          text: p.name,
          font: "11pt sans-serif",
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          outlineWidth: 2,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -20),
        },
      });
      ent.notable = p;
      notableEntities.push(ent);
    }
  } catch (e) { /* landmarks are cosmetic */ }
}

function clearNotablePlaces() {
  try {
    for (const ent of notableEntities) viewer.entities.remove(ent);
  } catch (e) { /* cosmetic */ }
  notableEntities = [];
}

// ── Floating 3D spawn pin ────────────────────────────────────────────────────
// A map-pin sprite drawn once on a canvas (no asset file needed), shown as a
// billboard floating in the sky over the launch point. Always faces the
// camera; distance-culled when you are really far away.
let spawnPinImage = null;
let customPinReady = false;
// If you drop the exact pin artwork at public/spawn-pin.png it is used
// verbatim in the 3D world; otherwise the procedural glossy pin below stands
// in. Preloaded at boot so it is ready before the first spawn.
try {
  const probe = new Image();
  probe.onload = () => {
    try {
      const pc = document.createElement("canvas");
      pc.width = probe.naturalWidth;
      pc.height = probe.naturalHeight;
      pc.getContext("2d").drawImage(probe, 0, 0);
      spawnPinImage = pc.toDataURL("image/png");
      customPinReady = true;
    } catch (e) { /* keep procedural fallback */ }
  };
  probe.src = "spawn-pin.png";
} catch (e) { /* keep procedural fallback */ }
function getSpawnPinImage() {
  if (spawnPinImage) return spawnPinImage;
  // Glossy 3D map pin fallback on a transparent background (256x340).
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 340;
  const g = c.getContext("2d");
  const cx = 128;
  const cy = 122;
  const r = 98;
  // Teardrop body.
  g.beginPath();
  g.arc(cx, cy, r, Math.PI * 0.75, Math.PI * 0.25, true);
  g.lineTo(cx, 326);
  g.closePath();
  const body = g.createRadialGradient(cx - 48, cy - 58, 10, cx, cy + 32, 210);
  body.addColorStop(0, "#ff7b7b");
  body.addColorStop(0.45, "#e01515");
  body.addColorStop(1, "#8a0000");
  g.fillStyle = body;
  g.fill();
  g.strokeStyle = "#6e0000";
  g.lineWidth = 6;
  g.stroke();
  // Punched see-through hole with a metallic ring.
  g.globalCompositeOperation = "destination-out";
  g.beginPath();
  g.arc(cx, cy, 44, 0, Math.PI * 2);
  g.fill();
  g.globalCompositeOperation = "source-over";
  const ring = g.createLinearGradient(cx - 54, cy - 54, cx + 54, cy + 54);
  ring.addColorStop(0, "#f4f4f4");
  ring.addColorStop(0.5, "#9a9a9a");
  ring.addColorStop(1, "#e0e0e0");
  g.strokeStyle = ring;
  g.lineWidth = 14;
  g.beginPath();
  g.arc(cx, cy, 51, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = "rgba(0,0,0,0.45)";
  g.lineWidth = 3;
  g.beginPath();
  g.arc(cx, cy, 44, 0, Math.PI * 2);
  g.stroke();
  // Specular highlight for the glossy 3D read.
  g.save();
  g.translate(cx - 56, cy - 56);
  g.rotate(-0.5);
  const spec = g.createRadialGradient(0, 0, 2, 0, 0, 50);
  spec.addColorStop(0, "rgba(255,255,255,0.75)");
  spec.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = spec;
  g.beginPath();
  g.ellipse(0, 0, 28, 50, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
  spawnPinImage = c.toDataURL("image/png");
  return spawnPinImage;
}

// ── Confirm spawn with transition animation ──────────────────────────────────
function confirmSpawn() {
  // Radial (see-through center) fade, NOT solid black — the spawn flight
  // itself must stay visible while the camera dives onto the city.
  setStreetsVisible(false);
  clearNotablePlaces();
  if (vignette) {
    vignette.classList.remove("solid");
    vignette.style.opacity = "1";
  }

  setTimeout(() => {
    if (spawnMarker) {
      viewer.entities.remove(spawnMarker);
      spawnMarker = null;
    }
    if (spawnIndicator) {
      viewer.entities.remove(spawnIndicator);
      spawnIndicator = null;
    }

    // Spawn heading comes from the picker camera — read it BEFORE placing
    // anything so the pin and the forward offset agree.
    try {
      const cam = viewer.camera;
      if (cam && typeof cam.heading === "number") {
        state.heading = Cesium.Math.toDegrees(cam.heading);
      }
    } catch (e) {
      state.heading = 0;
    }

    // Spawn-origin indicator: a BIG glossy 3D map pin floating over the
    // launch point (ground level), plus label. Faces the camera from any
    // angle; culled past ~150 km.
    state.spawnName =
      pendingSpawnName ||
      `SPAWN ${Math.abs(state.lat).toFixed(2)}°${state.lat >= 0 ? "N" : "S"} ` +
        `${Math.abs(state.lon).toFixed(2)}°${state.lon >= 0 ? "E" : "W"}`;
    state.spawnLon = state.lon;
    state.spawnLat = state.lat;
    try {
      const carto = Cesium.Cartographic.fromDegrees(state.lon, state.lat);
      const groundH = viewer.scene.globe.getHeight(carto);
      spawnIndicator = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(
          state.lon, state.lat, groundH === undefined ? 0 : groundH
        ),
        billboard: {
          image: getSpawnPinImage(),
          sizeInMeters: true,
          width: 550,
          height: 730,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 150000),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: `SPAWN · ${state.spawnName}`,
          font: "12pt monospace",
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          outlineWidth: 2,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -380),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 150000),
        },
      });
    } catch (e) { /* indicator is cosmetic */ }

    // Spawn the plane ~1 km AHEAD of the pin along the spawn heading, so the
    // big indicator can never cover the screen on arrival.
    try {
      const hRad = Cesium.Math.toRadians(state.heading || 0);
      const R = 6371000;
      const latR = Cesium.Math.toRadians(state.lat);
      state.lat += Cesium.Math.toDegrees((1000 * Math.cos(hRad)) / R);
      state.lon += Cesium.Math.toDegrees((1000 * Math.sin(hRad)) / (R * Math.cos(latR)));
    } catch (e) { /* offset is cosmetic */ }

    const ctrl = viewer.scene.screenSpaceCameraController;
    ctrl.enableRotate = false;
    ctrl.enableTranslate = false;
    ctrl.enableZoom = false;
    ctrl.enableTilt = false;
    ctrl.enableLook = false;

    state.speed = CONFIG.physics.minSpeed;
    state.pitch = 0;
    state.roll = 0;
    state.stallFactor = 0;

    try {
      const cam = viewer.camera;
      if (cam && typeof cam.heading === "number") {
        state.heading = Cesium.Math.toDegrees(cam.heading);
      }
    } catch (e) {
      state.heading = 0;
    }

    controller.reset();
    physics = new PlanePhysics();
    physics.reset(state.lon, state.lat, state.alt, state.heading, state.pitch, state.roll);
    particles.clear();
    planeModel.reset();

    if (spawnInstruction) spawnInstruction.classList.add("hidden");
    if (confirmSpawnBtn) confirmSpawnBtn.classList.add("hidden");
    loadingIndicator.classList.add("hidden");

    currentState = States.TRANSITIONING;

    // Spawn flight (ref-flight style, two phases): pull up high first so
    // confirming always plays the dive-down-onto-the-spawn swoop, then drop
    // onto the spawn point in the plane's own attitude.
    const diveToSpawn = () => {
      // The airplane fades in as the dive begins so it appears mid-flight.
      if (threeContainer) threeContainer.classList.remove("hidden");
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(state.lon, state.lat, state.alt),
        orientation: {
          heading: Cesium.Math.toRadians(state.heading),
          pitch: Cesium.Math.toRadians(state.pitch),
          roll: Cesium.Math.toRadians(state.roll),
        },
        duration: 2.4,
        easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
        complete: () => {
          setTimeout(() => {
            flightStartTime = Date.now();
            if (uiContainer) uiContainer.classList.remove("hidden");
            if (threeContainer) threeContainer.classList.remove("hidden");
            currentState = States.FLYING;
            hud.resetTime();
            hud.resetScore();
            if (state.spawnName) hud.showRegion(`SPAWN · ${state.spawnName}`);
          try {
            getMiniViewer()?.resize();
            // Snap the real-map minimap onto the spawn immediately so the
            // first frame already matches the 3D world.
            setMinimapCamera(state.lon, state.lat, 1500 + state.speed * 2, state.heading);
          } catch (e) { /* minimap is cosmetic */ }
            if (vignette) {
              vignette.style.opacity = "0";
              vignette.classList.remove("solid");
            }
          }, 300);
        },
      });
    };
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        state.lon, state.lat, Math.max(viewer.camera.positionCartographic?.height || 0, state.alt + 6000)
      ),
      duration: 1.0,
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
      complete: () => {
        if (currentState === States.TRANSITIONING) diveToSpawn();
      },
    });

    // Safety net: a camera flight's complete callback can be skipped if the
    // animation is interrupted, which would leave the player stranded behind
    // the transition vignette. Force FLYING after the two-phase flight.
    setTimeout(() => {
      if (currentState !== States.TRANSITIONING) return;
      flightStartTime = Date.now();
      if (uiContainer) uiContainer.classList.remove("hidden");
      if (threeContainer) threeContainer.classList.remove("hidden");
      currentState = States.FLYING;
      hud.resetTime();
      hud.resetScore();
      try {
        getMiniViewer()?.resize();
      } catch (e) { /* minimap is cosmetic */ }
      if (vignette) {
        vignette.style.opacity = "0";
        vignette.classList.remove("solid");
      }
    }, 6500);
  }, 500);
}

// ── Flight update ────────────────────────────────────────────────────────────
function update(dt) {
  if (currentState !== States.FLYING) return;

  const input = controller.update();
  const physicsResult = physics.update(input, dt);

  state.speed = physicsResult.speed;
  state.pitch = physicsResult.pitch;
  state.roll = physicsResult.roll;
  state.heading = physicsResult.heading;
  state.throttle = input.throttle;
  state.yaw = input.yaw;
  state.isBoosting = physicsResult.isBoosting;
  state.stallFactor = 0;
  state.onGround = false;

  // An interrupted camera flight can leave a non-finite attitude behind;
  // sending that to the camera drops the globe out of the frame entirely.
  if (!Number.isFinite(state.heading)) state.heading = 0;
  if (!Number.isFinite(state.pitch)) state.pitch = 0;
  if (!Number.isFinite(state.roll)) state.roll = 0;
  if (!Number.isFinite(state.speed)) state.speed = CONFIG.physics.minSpeed;

  // The aircraft travels wherever the nose points. The horizontal component is
  // scaled by cos(pitch), so it always moves forward as well as up or down.
  const newPos = movePosition(state.lon, state.lat, state.alt, state.heading, state.pitch, state.speed * MPH_TO_MPS * dt);
  state.lon = newPos.lon;
  state.lat = newPos.lat;
  state.alt = newPos.alt;

  // Realistic altitude: height above the terrain below (AGL), not sea
  // level, so skimming the ground reads near zero instead of ~900 ft.
  try {
    const cartoNow = Cesium.Cartographic.fromDegrees(state.lon, state.lat);
    const terrainH = viewer.scene.globe.getHeight(cartoNow);
    state.agl = terrainH === undefined ? state.alt : Math.max(0, state.alt - terrainH);
  } catch (e) {
    state.agl = state.alt;
  }

  checkCrash();
  checkGPWS();

  // Camera: the plane's attitude with the mouse orbit applied on top. The
  // orbit is what makes look-around rotate the world around a stationary
  // aircraft instead of spinning the model off to one side.
  const planeHPR = new Cesium.HeadingPitchRoll(
    Cesium.Math.toRadians(state.heading),
    Cesium.Math.toRadians(state.pitch),
    Cesium.Math.toRadians(state.roll)
  );
  const planeQuat = Cesium.Quaternion.fromHeadingPitchRoll(planeHPR);

  const orbitHPR = new Cesium.HeadingPitchRoll(
    Cesium.Math.toRadians(input.cameraYaw),
    Cesium.Math.toRadians(-input.cameraPitch),
    0
  );
  const orbitQuat = Cesium.Quaternion.fromHeadingPitchRoll(orbitHPR);

  const finalQuat = Cesium.Quaternion.multiply(planeQuat, orbitQuat, new Cesium.Quaternion());
  const finalHPR = Cesium.HeadingPitchRoll.fromQuaternion(finalQuat);

  setCameraToPlane(
    state.lon, state.lat, state.alt,
    Cesium.Math.toDegrees(finalHPR.heading),
    Cesium.Math.toDegrees(finalHPR.pitch),
    Cesium.Math.toDegrees(finalHPR.roll)
  );

  // Update Three.js plane model (rotates around origin)
  // Pass speed + throttle so the model can do ref-flight acceleration
  // inertia and jet-flame scaling.
  planeModel.update(
    {
      boostDuration: physicsResult.boostDuration,
      boostTimeRemaining: physicsResult.boostTimeRemaining,
      boostRotations: physicsResult.boostRotations,
      speed: physicsResult.speed,
      throttle: input.throttle,
    },
    input,
    dt,
    physicsResult.isBoosting
  );

  const now = Date.now();
  const distFromLast = calculateDistance(state.lon, state.lat, lastGeocodePos.lon, lastGeocodePos.lat);
  if (now - geocodeTimer > 10000 || distFromLast > 1000) {
    geocodeTimer = now;
    lastGeocodePos = { lon: state.lon, lat: state.lat };
    reverseGeocode(state.lon, state.lat).then((name) => {
      if (name && name !== currentRegionName) {
        currentRegionName = name;
        hud.showRegion(name);
      }
    });
  }
}

function movePosition(lon, lat, alt, heading, pitch, distance) {
  const headingRad = Cesium.Math.toRadians(heading);
  const pitchRad = Cesium.Math.toRadians(pitch);
  const R = 6371000;
  const dLat = (distance * Math.cos(headingRad) * Math.cos(pitchRad)) / R;
  const dLon = (distance * Math.sin(headingRad) * Math.cos(pitchRad)) / (R * Math.cos(Cesium.Math.toRadians(lat)));
  const dAlt = distance * Math.sin(pitchRad);
  return {
    lon: lon + Cesium.Math.toDegrees(dLon),
    lat: lat + Cesium.Math.toDegrees(dLat),
    alt: alt + dAlt,
  };
}

function checkGPWS() {
  if (currentState !== States.FLYING) return;
  const cartographic = Cesium.Cartographic.fromDegrees(state.lon, state.lat);
  const terrainHeight = viewer.scene.globe.getHeight(cartographic);
  if (terrainHeight === undefined) return;

  const agl = state.alt - terrainHeight;
  const pitchRad = Cesium.Math.toRadians(state.pitch);
  const verticalSpeed = state.speed * MPH_TO_MPS * Math.sin(pitchRad);

  let showWarning = false;
  if (state.pitch < -2) {
    if (agl < 450) {
      if (agl < 150) showWarning = true;
      if (verticalSpeed < -20) showWarning = true;
    }
  }
  hud.setPullUpWarning(showWarning);
}

function checkCrash() {
  if (currentState !== States.FLYING) return;
  const now = Date.now();
  if (now - lastCrashCheck < 100) return;
  lastCrashCheck = now;
  if (now - flightStartTime < 3000) return;

  const cartographic = Cesium.Cartographic.fromDegrees(state.lon, state.lat);
  const terrainHeight = viewer.scene.globe.getHeight(cartographic);
  if (terrainHeight !== undefined && state.alt <= terrainHeight + 5) {
    // Crash: detonate at the plane's on-screen position (ref-flight style
    // explosion), hide the wreck, and hold the fireball on screen briefly
    // before dropping to the pause menu.
    currentState = States.PAUSED;
    try {
      // Only detonate once per wreck (resume-after-crash re-triggers this
      // check while still inside the terrain).
      if (!planeModel?.model || planeModel.model.visible !== false) {
        const at = planeModel?.model?.position?.clone?.() ?? null;
        particles.spawnExplosion(at, { big: true, count: 48, smokeCount: 10 });
        if (planeModel?.model) planeModel.model.visible = false;
      }
    } catch (e) { /* explosion is cosmetic; never break the crash flow */ }
    setTimeout(() => {
      if (uiContainer) uiContainer.classList.add("hidden");
      if (threeContainer) threeContainer.classList.add("hidden");
      if (pauseMenu) pauseMenu.classList.remove("hidden");
    }, 1600);
  }
}

// ── Render loop ──────────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  // Clamp dt so a backgrounded tab doesn't teleport the aircraft kilometres
  // in a single frame when it regains focus.
  const dt = Math.min(clock ? clock.getDelta() : 0.016, 0.05);
  const now = performance.now();

  if (currentState === States.FLYING || currentState === States.PAUSED || currentState === States.TRANSITIONING) {
    if (currentState === States.FLYING) {
      update(dt);
    }

    state.isFlying = currentState === States.FLYING;
    if (hud) hud.update(state, now);
    audio.update({ throttle: state.throttle, speed: state.speed });

    minimapUpdateTimer += dt;
    if (minimapUpdateTimer > 0.1) {
      minimapUpdateTimer = 0;
      // Real-map minimap tracks the jet (range widens slightly with speed).
      try {
        const zoomAlt = 1500 + state.speed * 2;
        setMinimapCamera(state.lon, state.lat, zoomAlt, state.heading);
      } catch (e) { /* minimap is cosmetic */ }
      hud.updateMinimap(state);
    }

    // Permanent daytime: re-pin the sun high at the aircraft's position
    // twice a second so flying across the globe never leaves you in the dark.
    sunUpdateTimer += dt;
    if (sunUpdateTimer > 0.5) {
      sunUpdateTimer = 0;
      try {
        setSunForTime(viewer, 12, state.lat, state.lon);
      } catch (e) { /* sun is cosmetic; never break the frame */ }
    }

    // Crash-explosion particles keep animating even while paused so the
    // fireball plays out behind the delayed pause menu.
    try {
      if (particles.list.length > 0) particles.update(dt);
    } catch (e) { /* cosmetic */ }

    // Render the plane overlay. The Three.js camera stays at the origin with
    // a fixed FOV; the Cesium camera does the world-space tracking.
    renderer.autoClear = false;
    renderer.clear();
    camera.layers.set(1);
    renderer.render(scene, camera);
    renderer.clearDepth();
  }

  // Cesium's own loop can stall under a throttled/batched frame scheduler
  // (headless CI, backgrounded tabs). Driving it explicitly guarantees the
  // globe always composites under the Three.js overlay.
  viewer.render();
}

// ── UI events ────────────────────────────────────────────────────────────────
startBtn.addEventListener("click", () => {
  if (mainMenu) mainMenu.classList.add("hidden");
  enterSpawnPicking(false);
});

confirmSpawnBtn.addEventListener("click", confirmSpawn);

document.getElementById("resumeBtn").addEventListener("click", async () => {
  // RESPAWN at the original spawn point (not resume-in-place).
  if (pauseMenu) pauseMenu.classList.add("hidden");
  if (state.spawnLon != null && state.spawnLat != null) {
    state.lon = state.spawnLon;
    state.lat = state.spawnLat;
    pendingSpawnName = state.spawnName;
    try {
      await groundSampler.seed([[state.lat, state.lon]]);
      state.alt = groundSampler.get(state.lat, state.lon, 0) + 1500;
    } catch (e) {
      state.alt = Math.max(state.alt, 1500);
    }
  }
  confirmSpawn();
});

document.getElementById("restartBtn").addEventListener("click", () => {
  if (pauseMenu) pauseMenu.classList.add("hidden");
  enterSpawnPicking(true);
});

let audioStarted = false;
function startAudioOnce() {
  if (!audioStarted) {
    audioStarted = true;
    audio.start();
  }
}
window.addEventListener("keydown", startAudioOnce, { once: true });
window.addEventListener("mousedown", startAudioOnce, { once: true });

window.addEventListener("keydown", (e) => {
  const key = e.key.toLowerCase();
  if (key === "escape" || key === "p") {
    if (currentState === States.FLYING) {
      currentState = States.PAUSED;
      if (uiContainer) uiContainer.classList.add("hidden");
      if (threeContainer) threeContainer.classList.add("hidden");
      if (pauseMenu) pauseMenu.classList.remove("hidden");
    } else if (currentState === States.PAUSED) {
      currentState = States.FLYING;
      if (pauseMenu) pauseMenu.classList.add("hidden");
      if (uiContainer) uiContainer.classList.remove("hidden");
      if (threeContainer) threeContainer.classList.remove("hidden");
    } else if (currentState === States.PICK_SPAWN && key === "escape") {
      exitSpawnPicking();
    }
  }
  if (key === "m" && currentState === States.FLYING) {
    audio.toggle();
  }
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  viewer.resize();
  try {
    getMiniViewer()?.resize();
  } catch (e) { /* minimap is cosmetic */ }
});

window.addEventListener("contextmenu", (e) => e.preventDefault());

// ── Boot ─────────────────────────────────────────────────────────────────────
initialCameraView = {
  destination: viewer.camera.position.clone(),
  orientation: {
    heading: viewer.camera.heading,
    pitch: viewer.camera.pitch,
    roll: viewer.camera.roll,
  },
};

initThree();
setupSpawnPicker();
setupSearch();
initMiniViewer("minimapCesium");
preloadTerrain();
setSunForTime(viewer, 12, state.lat, state.lon);

if (uiContainer) uiContainer.classList.add("hidden");
if (threeContainer) threeContainer.classList.add("hidden");

updateLoadingUI();
animate();
