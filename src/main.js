import * as THREE from "three";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { CONFIG } from "./core/config.js";
import { createViewer, attachTerrain, setSunForTime } from "./core/viewer.js";
import { GroundSampler } from "./core/ground.js";
import { PlanePhysics } from "./plane/planePhysics.js";
import { PlaneController } from "./plane/planeController.js";
import { PlaneModel } from "./plane/planeModel.js";
import { Hud } from "./ui/hud.js";
import { EngineAudio } from "./flight/engine.js";
import { reverseGeocode, calculateDistance } from "./utils/geo.js";

const States = {
  MENU: "MENU",
  PICK_SPAWN: "PICK_SPAWN",
  TRANSITIONING: "TRANSITIONING",
  FLYING: "FLYING",
  PAUSED: "PAUSED",
};

let currentState = States.MENU;

const state = {
  lon: 106.8272,
  lat: -6.1754,
  alt: 1000,
  heading: 0,
  pitch: 0,
  roll: 0,
  flightPathAngle: 0,
  speed: 0,
  throttle: 0,
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
let initialCameraView = null;
let flightStartTime = 0;
let lastCrashCheck = 0;
let minimapUpdateTimer = 0;
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
function initThree() {
  clock = new THREE.Clock();
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, window.innerWidth / window.innerHeight, CONFIG.camera.near, CONFIG.camera.far);

  renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(0x000000, 0);
  threeContainer = document.getElementById("threeContainer");
  threeContainer.appendChild(renderer.domElement);
  threeContainer.classList.add("hidden");

  const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
  scene.add(ambientLight);
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
  directionalLight.position.set(5, 10, 5);
  scene.add(directionalLight);

  planeModel = new PlaneModel(scene);
  planeModel.load().then(() => {
    loadingStatus.model = true;
    updateLoadingUI();
  }).catch((err) => {
    console.error("Failed to load model:", err);
    loadingStatus.failed = true;
    updateLoadingUI();
  });
}

// ── Position utility ─────────────────────────────────────────────────────────
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

// ── Chase camera: behind and above, NO roll coupling ────────────────────────
function updateChaseCamera(heading, pitch, roll, flightPathAngle, cameraYaw, cameraPitch) {
  const planeCartesian = Cesium.Cartesian3.fromDegrees(state.lon, state.lat, state.alt);

  const speedT = Math.min(1, Math.max(0, (state.speed - 60) / 190));
  const boomDist = CONFIG.camera.boomDistance * (1 + 0.55 * speedT);
  const boomH = CONFIG.camera.boomHeight * (1 + 0.35 * speedT);

  // Camera follows heading and flight path angle only — NO roll.
  // This keeps the horizon level and prevents the "sideways" feeling.
  const camHPR = new Cesium.HeadingPitchRoll(
    Cesium.Math.toRadians(heading),
    Cesium.Math.toRadians(-flightPathAngle * 0.5),
    0
  );
  const camQuat = Cesium.Quaternion.fromHeadingPitchRoll(camHPR);

  const orbitHPR = new Cesium.HeadingPitchRoll(
    Cesium.Math.toRadians(cameraYaw),
    Cesium.Math.toRadians(-cameraPitch),
    0
  );
  const orbitQuat = Cesium.Quaternion.fromHeadingPitchRoll(orbitHPR);

  const finalQuat = Cesium.Quaternion.multiply(camQuat, orbitQuat, new Cesium.Quaternion());

  const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(planeCartesian);
  const offset = new Cesium.Cartesian3(0, -boomDist, boomH);
  const rotatedOffset = Cesium.Matrix4.multiplyByPoint(enuMatrix, offset, new Cesium.Cartesian3());

  const finalHPR = Cesium.HeadingPitchRoll.fromQuaternion(finalQuat);
  const fov = Cesium.Math.toRadians(58 + 14 * speedT);

  viewer.camera.setView({
    destination: rotatedOffset,
    orientation: {
      heading: finalHPR.heading,
      pitch: Cesium.Math.toRadians(-5 - 3 * speedT),
      roll: 0,
    },
  });

  const currentFov = viewer.camera.frustum.fov;
  if (Math.abs(currentFov - fov) > 1e-4) {
    viewer.camera.frustum.fov = fov;
  }

  viewer.scene.requestRender();
}

// ── Spawn picker ─────────────────────────────────────────────────────────────
function enterSpawnPicking(useVignette = true) {
  if (vignette && useVignette) vignette.style.opacity = "1";
  const delay = useVignette ? 500 : 0;

  setTimeout(() => {
    if (spawnInstruction) spawnInstruction.classList.remove("hidden");
    if (threeContainer) threeContainer.classList.add("hidden");
    if (uiContainer) uiContainer.classList.add("hidden");
    currentState = States.PICK_SPAWN;
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

    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(state.lon, state.lat, 15000),
      duration: 2.0,
      complete: () => {
        if (vignette) vignette.style.opacity = "0";
      },
    });
  }, delay);
}

function exitSpawnPicking() {
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

  if (instructionText) instructionText.textContent = name.split(",")[0].toUpperCase();

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

    // Check if click is within the search UI area
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

    const ray = viewer.camera.getPickRay(click.position);
    const cartesian = viewer.scene.globe.pick(ray, viewer.scene);

    if (cartesian) {
      const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
      const lon = Cesium.Math.toDegrees(cartographic.longitude);
      const lat = Cesium.Math.toDegrees(cartographic.latitude);

      state.lon = lon;
      state.lat = lat;
      state.alt = Math.max(0, cartographic.height) + 1500;

      if (instructionText) instructionText.textContent = "FETCHING LOCATION INFO...";

      groundSampler.seed([[lat, lon]]).then(() => {
        const ground = groundSampler.get(lat, lon, cartographic.height || 0);
        state.alt = ground + 1500;
      }).catch(() => {});

      reverseGeocode(lon, lat).then((name) => {
        if (name && instructionText) instructionText.textContent = name;
      }).catch(() => {});

      if (spawnMarker) viewer.entities.remove(spawnMarker);
      spawnMarker = viewer.entities.add({
        position: cartesian,
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
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

// ── Confirm spawn with transition animation ──────────────────────────────────
function confirmSpawn() {
  if (vignette) vignette.style.opacity = "1";

  setTimeout(() => {
    if (spawnMarker) {
      viewer.entities.remove(spawnMarker);
      spawnMarker = null;
    }

    const ctrl = viewer.scene.screenSpaceCameraController;
    ctrl.enableRotate = false;
    ctrl.enableTranslate = false;
    ctrl.enableZoom = false;
    ctrl.enableTilt = false;
    ctrl.enableLook = false;

    state.speed = 100;
    state.pitch = 0;
    state.roll = 0;
    state.flightPathAngle = 0;

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
    planeModel.reset();

    if (spawnInstruction) spawnInstruction.classList.add("hidden");
    if (confirmSpawnBtn) confirmSpawnBtn.classList.add("hidden");
    loadingIndicator.classList.add("hidden");

    currentState = States.TRANSITIONING;

    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(state.lon, state.lat, state.alt + 500),
      orientation: {
        heading: Cesium.Math.toRadians(state.heading),
        pitch: Cesium.Math.toRadians(-30),
        roll: 0,
      },
      duration: 2.0,
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
      complete: () => {
        setTimeout(() => {
          flightStartTime = Date.now();
          if (uiContainer) uiContainer.classList.remove("hidden");
          if (threeContainer) threeContainer.classList.remove("hidden");
          currentState = States.FLYING;
          if (vignette) vignette.style.opacity = "0";
        }, 500);
      },
    });
  }, 500);
}

// ── Flight update ────────────────────────────────────────────────────────────
function update(dt) {
  if (currentState !== States.FLYING) return;

  const input = controller.update();
  const groundHeight = groundSampler.get(state.lat, state.lon, 0);

  const physicsResult = physics.update(input, dt, groundHeight);

  state.speed = physicsResult.speed;
  state.pitch = physicsResult.pitch;
  state.roll = physicsResult.roll;
  state.heading = physicsResult.heading;
  state.flightPathAngle = physicsResult.flightPathAngle;
  state.throttle = input.throttle;

  // Move the aircraft along flight path angle
  const newPos = movePosition(state.lon, state.lat, state.alt, state.heading, state.flightPathAngle, state.speed * dt);
  state.lon = newPos.lon;
  state.lat = newPos.lat;
  state.alt = newPos.alt;

  checkCrash();
  checkGPWS();

  // Update chase camera — pass flightPathAngle, NOT pitch, and NO roll
  updateChaseCamera(state.heading, state.pitch, state.roll, state.flightPathAngle, input.cameraYaw, input.cameraPitch);

  planeModel.update(
    { boostDuration: physicsResult.boostDuration, boostTimeRemaining: physicsResult.boostTimeRemaining, boostRotations: physicsResult.boostRotations },
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

function checkGPWS() {
  if (currentState !== States.FLYING) return;
  const cartographic = Cesium.Cartographic.fromDegrees(state.lon, state.lat);
  const terrainHeight = viewer.scene.globe.getHeight(cartographic);
  if (terrainHeight === undefined) return;

  const agl = state.alt - terrainHeight;
  const gammaRad = Cesium.Math.toRadians(state.flightPathAngle);
  const verticalSpeed = state.speed * Math.sin(gammaRad);

  let showWarning = false;
  if (state.flightPathAngle < -2) {
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
    currentState = States.PAUSED;
    if (uiContainer) uiContainer.classList.add("hidden");
    if (threeContainer) threeContainer.classList.add("hidden");
    if (pauseMenu) pauseMenu.classList.remove("hidden");
  }
}

// ── Render loop ──────────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  const dt = clock ? clock.getDelta() : 0.016;
  const now = performance.now();

  if (currentState === States.FLYING || currentState === States.PAUSED || currentState === States.TRANSITIONING) {
    if (viewer && viewer.camera) {
      const cesiumCamera = viewer.camera;
      const fov = Cesium.Math.toDegrees(cesiumCamera.frustum.fovy);
      camera.fov = fov;
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();

      camera.position.set(
        cesiumCamera.position.x,
        cesiumCamera.position.y,
        cesiumCamera.position.z
      );
      camera.lookAt(
        cesiumCamera.position.x + cesiumCamera.direction.x,
        cesiumCamera.position.y + cesiumCamera.direction.y,
        cesiumCamera.position.z + cesiumCamera.direction.z
      );
    }

    if (currentState === States.FLYING) {
      update(dt);
    }

    if (hud) hud.update(state, now);
    audio.update({ throttle: state.throttle, speed: state.speed });

    minimapUpdateTimer += dt;
    if (minimapUpdateTimer > 0.1) {
      minimapUpdateTimer = 0;
      hud.updateMinimap(state);
    }

    renderer.autoClear = false;
    renderer.clear();

    camera.layers.enable(0);
    camera.layers.enable(1);

    try {
      renderer.render(scene, camera);
    } catch (e) {
      // keep going
    }
  }

  viewer.render();
}

// ── UI events ────────────────────────────────────────────────────────────────
startBtn.addEventListener("click", () => {
  if (mainMenu) mainMenu.classList.add("hidden");
  enterSpawnPicking(false);
});

confirmSpawnBtn.addEventListener("click", confirmSpawn);

document.getElementById("resumeBtn").addEventListener("click", () => {
  if (pauseMenu) pauseMenu.classList.add("hidden");
  if (uiContainer) uiContainer.classList.remove("hidden");
  if (threeContainer) threeContainer.classList.remove("hidden");
  currentState = States.FLYING;
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
preloadTerrain();
setSunForTime(viewer, 12, state.lat, state.lon);

if (uiContainer) uiContainer.classList.add("hidden");
if (threeContainer) threeContainer.classList.add("hidden");

updateLoadingUI();
animate();
