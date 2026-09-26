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
  speed: 0,
  throttle: 0,
};

// ── Three.js overlay ─────────────────────────────────────────────────────────
let scene, camera, renderer, threeContainer;
let planeModel;
let physics = new PlanePhysics();
let controller = new PlaneController();
let hud = new Hud();
let clock = new THREE.Clock();
let groundSampler;
let spawnMarker = null;
let initialCameraView = null;
let flightStartTime = 0;
let lastCrashCheck = 0;

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

const loadingStatus = { model: false, cesium: false, globe: false, failed: false };

function updateLoadingUI() {
  if (!loadingIndicator || !loadingText || !startBtn) return;
  if (currentState === States.FLYING || currentState === States.TRANSITIONING) {
    loadingIndicator.classList.add("hidden");
    return;
  }
  const isAllLoaded = loadingStatus.model && loadingStatus.cesium && loadingStatus.globe;
  if (loadingStatus.failed) {
    loadingText.textContent = "Loading Failed. Please Refresh.";
  } else if (!isAllLoaded) {
    if (!loadingStatus.model) loadingText.textContent = "Loading Aircraft Model...";
    else if (!loadingStatus.cesium) loadingText.textContent = "Loading Satellite Imagery...";
    else if (!loadingStatus.globe) loadingText.textContent = "Loading Globe Surface...";
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

// Globe surface loading tracker
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

// ── Camera ───────────────────────────────────────────────────────────────────
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
  if (vignette && useVignette) vignette.style.opacity = "1";
  const delay = useVignette ? 500 : 0;

  setTimeout(() => {
    if (spawnInstruction) spawnInstruction.classList.remove("hidden");
    if (threeContainer) threeContainer.classList.add("hidden");
    if (uiContainer) uiContainer.classList.add("hidden");
    currentState = States.PICK_SPAWN;
    if (confirmSpawnBtn) confirmSpawnBtn.classList.add("hidden");

    const instructionText = document.getElementById("instruction-text");
    if (instructionText) {
      instructionText.style.display = "block";
      instructionText.textContent = "CLICK ANYWHERE ON THE MAP TO CHOOSE SPAWN POINT";
    }

    // Enable camera controls for picking
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

  // Disable camera controls
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

function setupSpawnPicker() {
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  const instructionText = document.getElementById("instruction-text");

  handler.setInputAction((click) => {
    if (currentState !== States.PICK_SPAWN) return;

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

      // Sample terrain for accurate altitude
      groundSampler.seed([[lat, lon]]).then(() => {
        const ground = groundSampler.get(lat, lon, cartographic.height || 0);
        state.alt = ground + 1500;
      }).catch(() => {});

      // Reverse geocode for region name
      fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=5&addressdetails=1`)
        .then((r) => r.json())
        .then((data) => {
          if (data && data.address && currentState === States.PICK_SPAWN) {
            const addr = data.address;
            const region = addr.state || addr.region || addr.province;
            const country = addr.country;
            const name = region && country ? `${region}, ${country}`.toUpperCase() : (country || "").toUpperCase();
            if (name && instructionText) instructionText.textContent = name;
          }
        })
        .catch(() => {});

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

// ── Confirm spawn ────────────────────────────────────────────────────────────
function confirmSpawn() {
  if (vignette) vignette.style.opacity = "1";

  setTimeout(() => {
    if (spawnMarker) {
      viewer.entities.remove(spawnMarker);
      spawnMarker = null;
    }

    // Disable camera controls
    const ctrl = viewer.scene.screenSpaceCameraController;
    ctrl.enableRotate = false;
    ctrl.enableTranslate = false;
    ctrl.enableZoom = false;
    ctrl.enableTilt = false;
    ctrl.enableLook = false;

    state.speed = 100;
    state.pitch = 0;
    state.roll = 0;

    // Use camera heading as spawn heading
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

    // Fly camera to spawn point
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(state.lon, state.lat, state.alt),
      orientation: {
        heading: Cesium.Math.toRadians(state.heading),
        pitch: Cesium.Math.toRadians(state.pitch),
        roll: Cesium.Math.toRadians(state.roll),
      },
      duration: 2.0,
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
      complete: () => {
        flightStartTime = Date.now();
        if (uiContainer) uiContainer.classList.remove("hidden");
        if (threeContainer) threeContainer.classList.remove("hidden");
        currentState = States.FLYING;
        if (vignette) vignette.style.opacity = "0";
      },
    });
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

  // Move the aircraft
  const newPos = movePosition(state.lon, state.lat, state.alt, state.heading, state.pitch, state.speed * dt);
  state.lon = newPos.lon;
  state.lat = newPos.lat;
  state.alt = newPos.alt;

  // Check crash
  checkCrash();

  // Update camera behind the airplane
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

  // Update Three.js plane model
  planeModel.update(
    { boostDuration: physicsResult.boostDuration, boostTimeRemaining: physicsResult.boostTimeRemaining, boostRotations: physicsResult.boostRotations },
    input,
    dt,
    physicsResult.isBoosting
  );
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
    // Sync Three.js camera with Cesium camera
    if (viewer && viewer.camera) {
      const cesiumCamera = viewer.camera;
      const fov = Cesium.Math.toDegrees(cesiumCamera.frustum.fovy);
      camera.fov = fov;
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();

      // Copy position and orientation from Cesium camera
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

    // Update HUD
    if (hud) hud.update(state, now);

    renderer.autoClear = false;
    renderer.clear();

    camera.layers.enable(0);
    camera.layers.enable(1);

    try {
      renderer.render(scene, camera);
    } catch (e) {
      // Render error — keep going
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
attachTerrain(viewer).catch(() => {});
setSunForTime(viewer, 12);

if (uiContainer) uiContainer.classList.add("hidden");
if (threeContainer) threeContainer.classList.add("hidden");

updateLoadingUI();
animate();
