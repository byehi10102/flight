import * as THREE from "three";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { CONFIG, computeMinimapZoomAltitude } from "./core/config.js";
import { computeBootProgress, preparingFlightProgress, bootDisplayFloor, MonotonicPercent } from "./core/bootProgress.js";
import { getQualityProfile } from "./core/quality.js";
import { createViewer, attachTerrain, setSunForTime, initMiniViewer, getMiniViewer, setMinimapCamera, setStreetsVisible } from "./core/viewer.js";
import { GroundSampler } from "./core/ground.js";
import { PlanePhysics } from "./plane/planePhysics.js";
import { PlaneController } from "./plane/planeController.js";
import { PlaneModel } from "./plane/planeModel.js";
import { Hud } from "./ui/hud.js";
import { MobileMode } from "./ui/mobileMode.js";
import { TouchControls } from "./ui/touchControls.js";
import { Bullets } from "./weapon/bullet.js";
import { particles } from "./utils/particles.js";
import { soundManager } from "./utils/soundManager.js";
import { reverseGeocode, reverseGeocodeDetailed, calculateDistance, movePosition } from "./utils/geo.js";

const States = {
  MENU: "MENU",
  PICK_SPAWN: "PICK_SPAWN",
  TRANSITIONING: "TRANSITIONING",
  FLYING: "FLYING",
  PAUSED: "PAUSED",
};

let currentState = States.MENU;

// Flight speeds are MPH throughout (500 cruise, 5000 max on W, 10000 on
// boost); world movement needs m/s. WORLD_SPEED_SCALE is the arcade lever:
// HUD still shows true MPH, but the jet covers tiles 1.8x faster so 5k/10k
// feel like they should.
const MPH_TO_MPS = 0.44704;
const WORLD_SPEED_SCALE = 1.8;
// Spawn pin reveal distance: the pin drops in once the jet is this far
// from the spawn point (100 ft), so it never covers the screen on arrival.
const PIN_REVEAL_M = 30.48;

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
  // Dynamic minimap zoom: the map's view altitude, smoothed toward
  // computeMinimapZoomAltitude(AGL) every frame — no manual range setting.
  // 2400 m ≈ the view at a 1500 m spawn AGL.
  minimapZoom: 2400,
  // Single smoothed heading feeding BOTH the real-map camera and the canvas
  // overlay, so the two can never disagree mid-turn (ref-flight parity).
  minimapHeading: 0,
};

// ── Three.js overlay ─────────────────────────────────────────────────────────
let scene, camera, renderer, threeContainer;
let planeModel;
// Multiplayer handle (set by the dynamic import above; null = single player).
let mp = null;
let physics = new PlanePhysics();
let controller = new PlaneController();
let hud = new Hud();
const bullets = new Bullets();
let gunOverheatWarned = false;

// Mobile front-end: on a phone/tablet this adds the rotate overlay and the
// two virtual joysticks; on a desktop the MobileMode constructor returns
// before touching the DOM, so nothing about the desktop game changes.
const mobileMode = new MobileMode();
const touchControls = mobileMode.enabled
  ? new TouchControls({
      onAxis: (side, x, y) => controller.setStickInput(side, x, y),
    })
  : null;
if (mobileMode.enabled) {
  // Menu shows the stick scheme instead of the keyboard cheat-sheet.
  const kb = document.querySelector(".controls-help:not(.touch-help)");
  const th = document.querySelector(".controls-help.touch-help");
  if (kb) kb.classList.add("hidden");
  if (th) th.classList.remove("hidden");
}
let clock = new THREE.Clock();
let groundSampler;
// Sound state (ref-flight suite: engine/wind loops, warnings, UI).
let lastThrottleLevel = 0;
let lastBoostSound = false;
let lastGPWSWarningTime = 0;
let gpwsActive = false;
let soundMuted = false;
const GPWS_COOLDOWN = 1800;
let spawnMarker = null;
let spawnIndicator = null;
let pendingSpawnName = null;
let initialCameraView = null;
let flightStartTime = 0;
let lastCrashPos = null;
// True while the 4 s pre-spawn loading sign owns the loading indicator, so
// the tile-progress handler doesn't overwrite or hide it mid-wait.
let spawnPending = false;

// Fixed-step sim: physics/movement advance in 1/60s slices of REAL elapsed
// time (up to 5 per frame), so the jet covers true MPH distance even when
// the frame rate sags. The old clamped single-step ran the whole sim in
// slow motion on slow machines.
const SIM_STEP = 1 / 60;
const SIM_MAX_STEPS = 8;
let simAcc = 0;
let geocodeTimer = 0;
let preloadTimer = 0;
let minimapUpdateTimer = 0;
let sunUpdateTimer = 0;
let transitionGen = 0;

/**
 * Camera smoothing. The sim advances in fixed 1/60 s steps, but the camera is
 * rendered with an interpolation between the previous and current step, so the
 * world scrolls continuously instead of jumping a whole step at a time (a step
 * is ~134 m at boost, which reads as a stutter). Sim behavior is unchanged.
 */
let camPosePrev = null;
let camPoseCur = null;
function resetCameraSmoothing() { camPosePrev = null; camPoseCur = null; }
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
const loadingBarFill = document.getElementById("loading-bar-fill");
const loadingPercent = document.getElementById("loadingPercent");
const preparingFlight = document.getElementById("preparingFlight");
const preparingFlightVideo = document.getElementById("preparingFlightVideo");
const preparingBarFill = document.getElementById("preparing-bar-fill");
const preparingPercent = document.getElementById("preparingPercent");
const vignette = document.getElementById("transition-vignette");
const locationSearch = document.getElementById("locationSearch");
const searchResults = document.getElementById("search-results");
const instructionText = document.getElementById("instruction-text");

const loadingStatus = { model: false, cesium: false, globe: false, terrain: false, audio: false, area: false, failed: false };

// Real sub-progress (0..1) for stages that can report it: model bytes from
// the GLTFLoader, globe/area tiles from Cesium's tile-queue decay. The bar
// reads these through computeBootProgress — never a timer.
const loadingSub = { model: 0, globe: 0, area: 0 };
// Display-side high-water marks: the queue ratios above are NOT monotonic
// (Cesium re-requests tiles during LOD refinement, so the queue spikes and
// the raw ratio retreats). These clamps make the shown bars never retreat.
const bootBarShown = new MonotonicPercent();
const preparingBarShown = new MonotonicPercent();
let maxGlobeQueue = 0; // largest tile queue seen during the globe stage

// Boot loading page: fade to the menu instead of cutting. Idempotent.
let loadingPageHidden = false;
let lastThrottledRender = 0;

// ── Preparing-flight phase (between SPAWN HERE and the camera dive) ─────────
let preparingActive = false;
let preparingQueuePeak = 0;
let lastPreparingQueue = 0;
let preparingTimer = null;
// Mobile browsers (iOS Safari especially) honor the muted attribute
// inconsistently and silently refuse autoplay; force the properties and
// retry play() so the 3D fly-through actually shows on phones.
(() => {
  const v = document.querySelector(".loading-bg-video");
  if (!v) return;
  v.muted = true;
  v.setAttribute("muted", "");
  v.setAttribute("playsinline", "");
  v.setAttribute("webkit-playsinline", "");
  const kick = () => { try { v.play().catch(() => {}); } catch (e) { /* pending */ } };
  v.addEventListener("canplay", kick);
  v.addEventListener("loadeddata", kick);
  kick();
})();

// ── Boot film: JS owns the loop ────────────────────────────────────────────
// The boot film is [seamless 6 s loop][2 s zoom-off tail]: the F-15 cruises
// over the cloud deck while the loop repeats AS LONG AS the load takes; at
// 100% the outro is queued, and at the loop's NEXT natural boundary the film
// simply continues (no seek) into the tail — burners flare, the jet zooms
// off into the distance, and the page fades into the menu. Continuing from
// the boundary is what makes loop -> outro feel like one continuous shot.
// Both loading films are [seamless loop][zoom-off tail]: the plane cruises
// while the loop repeats AS LONG as the load takes; at 100% the outro is
// QUEUED, and at the loop's NEXT natural boundary the film simply continues
// (no seek) into the tail — burners flare, the jet zooms off into the
// distance, and the page fades. Continuing from the boundary is what
// makes loop -> outro feel like one continuous shot. Loop/tail lengths are
// per-film (the boot film is 6 s + 2 s; the restored original fly-through is
// a 2 s loop).

/**
 * JS-owned film loop + zoom-off outro for one <video>. tick() runs from the
 * render loop every frame: it wraps the video at the loop boundary while
 * shouldWrap() says so, and when an outro is queued it instead lets the
 * film play straight into the tail (the literal next frame — no seek, no
 * cut) and calls onOutro(played) once, at the boundary. onOutro(false)
 * also fires from the safety net if the film stalls and never reaches the
 * boundary, so a flow can never hang on the film.
 */
function makeFilmController(video, { loopS, tailS, shouldWrap, onOutro }) {
  let tailActive = false;
  let pending = false;
  const LOOP_S = loopS;
  const hasTail = () => {
    try {
      return !!video && Number.isFinite(video.duration)
        && video.duration >= LOOP_S + tailS - 0.05;
    } catch (e) { return false; }
  };
  const isPlaying = () => {
    try { return !!video && !video.paused; } catch (e) { return false; }
  };
  return {
    queueOutro() {
      if (tailActive || pending) return;
      pending = true;
      setTimeout(() => {
        if (pending) { pending = false; onOutro(false); }
      }, 8000);
    },
    isPending: () => pending,
    isActive: () => tailActive,
    /** Hard-cancel (flow abandoned, e.g. leaving the picker mid-phase). */
    cancel() {
      pending = false;
      tailActive = false;
      try { video?.pause(); } catch (e) { /* cosmetic */ }
    },
    tick() {
      if (!video || tailActive) return;
      if (video.currentTime < LOOP_S) return;
      if (pending) {
        pending = false;
        tailActive = true;
        let played = false;
        if (isPlaying() && hasTail()) {
          played = true;
          try {
            const p = video.play();
            if (p && p.catch) p.catch(() => {});
          } catch (e) { played = false; }
        }
        onOutro(played);
        return;
      }
      if (shouldWrap()) {
        try { video.currentTime -= LOOP_S; } catch (e) { /* seeking */ }
      }
    },
  };
}

// Boot film: [6 s loop][2 s tail]. Wraps until the page is done; outro
// fades into the menu.
const bootFilm = document.querySelector("#loadingIndicator .loading-bg-video");
const bootFilmCtl = makeFilmController(bootFilm, {
  loopS: 6.0,
  tailS: 2.0,
  shouldWrap: () => !loadingPageHidden,
  onOutro: (played) => {
    // Let the zoom read for ~0.9 s of the tail, then fade over ~1.1 s.
    setTimeout(() => loadingIndicator?.classList.add("fading"), played ? 900 : 0);
    setTimeout(() => {
      if (loadingIndicator) {
        loadingIndicator.classList.add("hidden");
        loadingIndicator.classList.remove("fading", "picker");
      }
      try { bootFilm?.pause(); } catch (e) { /* cosmetic */ }
    }, played ? 2000 : 1100);
  },
});

// Spawn-dive film: the ORIGINAL diagonal fly-through (2 s seamless loop,
// restored from git) with a zoom-away tail joined on — [2 s loop][~1.7 s
// tail]. Wraps while the preparing video plays; its outro fades the
// preparing screen and then runs the phase's bound completion (restore
// picker view -> dive). runPreparingFlight binds preparingFinish each run.
let preparingFinish = null;
const diveFilm = document.getElementById("preparingFlightVideo");
const diveFilmCtl = makeFilmController(diveFilm, {
  loopS: 2.0,
  tailS: 1.6,
  shouldWrap: () => true,
  onOutro: (played) => {
    setTimeout(() => preparingFlight?.classList.add("fading"), played ? 500 : 0);
    setTimeout(() => {
      try { diveFilm?.pause(); } catch (e) { /* cosmetic */ }
      const fn = preparingFinish;
      preparingFinish = null;
      if (fn) fn();
    }, played ? 1400 : 200);
  },
});

// Boot safety net (s): a hung provider must never trap the player forever.
// This is NOT a load timer — the reveal waits for real completion however
// long that takes (the film loops as long as necessary); the cap only
// force-finishes stages if something has truly hung.
const MAX_BOOT_SECONDS = 45;
const bootStart = performance.now();

function hideLoadingPage() {
  if (!loadingIndicator || loadingPageHidden) return;
  // The bar is at 100 and everything has REALLY loaded: queue the outro.
  // The film finishes its current lap, and at the loop's next natural
  // boundary the render loop hands over to the outro - the tail
  // plays as the literal next frame of the loop, one continuous shot.
  // (Not on a timer: the loop repeats as long as the load took.)
  loadingPageHidden = true;
  bootFilmCtl.queueOutro();
}

function updateLoadingUI() {
  if (!loadingIndicator || !loadingText || !startBtn) return;
  if (currentState === States.FLYING || currentState === States.TRANSITIONING) {
    loadingIndicator.classList.add("hidden");
    return;
  }
  const isAllLoaded = loadingStatus.model && loadingStatus.audio && loadingStatus.cesium && loadingStatus.globe && loadingStatus.terrain && loadingStatus.area;
  if (loadingStatus.failed) {
    loadingText.textContent = "Loading Failed. Please Refresh.";
  } else if (!isAllLoaded) {
    if (!loadingStatus.model) loadingText.textContent = "Loading Aircraft Model...";
    else if (!loadingStatus.audio) loadingText.textContent = "Loading Audio...";
    else if (!loadingStatus.cesium) loadingText.textContent = "Loading Satellite Imagery...";
    else if (!loadingStatus.globe) loadingText.textContent = "Loading Globe Surface...";
    else if (!loadingStatus.terrain) loadingText.textContent = "Loading Terrain Data...";
    else if (!loadingStatus.area) loadingText.textContent = "Preloading Spawn Region...";
  }
  if (!isAllLoaded || loadingStatus.failed) {
    loadingText.textContent = loadingText.textContent || "Loading...";
    startBtn.disabled = true;
    startBtn.style.pointerEvents = "none";
    loadingIndicator.classList.remove("hidden");
  } else {
    // Boot done: fade the loading page out (0.7 s) so the menu - single
    // player / multiplayer - takes over smoothly, then hide it for real.
    hideLoadingPage();
    startBtn.disabled = false;
    startBtn.style.pointerEvents = "auto";
  }
  // Progress bar: REAL progress — done flags release their slice, partial
  // sub-progress (model bytes, tile-queue decay) releases proportional
  // slices. Nothing here increments on a timer.
  if (loadingBarFill) {
    // Failed is a deliberate reset (bar to 0); otherwise the shown bar only
    // ever moves forward. Two honest layers: real stage flags + sub-progress
    // (computeBootProgress), lifted by a slow display floor that keeps the
    // bar visibly alive when a stage reports nothing (queue that hasn't
    // grown, stalled network). The floor stops at 90% — completion still
    // only comes from real work.
    const raw = computeBootProgress(loadingStatus, loadingSub);
    const floor = 100 * bootDisplayFloor(performance.now() - bootStart);
    const pct = loadingStatus.failed
      ? 0
      : bootBarShown.update(Math.round(Math.max(raw, floor)));
    loadingBarFill.style.width = `${pct}%`;
    if (loadingPercent) loadingPercent.textContent = `${pct}%`;
  }
  // During spawn picking the same element is reused as the small
  // "Loading Terrain..." chip - never as the full-screen page.
  loadingIndicator.classList.toggle("picker", currentState === States.PICK_SPAWN);
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
  // Preparing-flight phase: the destination tile queue draining IS the
  // progress bar between SPAWN HERE and the dive (the picker camera is
  // looking straight at the tapped point).
  if (preparingActive) {
    lastPreparingQueue = queueLength;
    if (queueLength > preparingQueuePeak) preparingQueuePeak = queueLength;
  }
  // Boot phase: the queue draining IS the real progress for the globe stage.
  // (The area stage reports REAL sub-steps from preloadSpawnRegion's camera
  // passes + DEM grid instead — a queue-decay estimate reads 0-or-jump and
  // left the bar looking dead.)
  if (!loadingPageHidden && !loadingStatus.failed) {
    if (!loadingStatus.globe) {
      if (queueLength > maxGlobeQueue) maxGlobeQueue = queueLength;
      loadingSub.globe = maxGlobeQueue > 0 ? 1 - queueLength / maxGlobeQueue : 0;
    }
    if (currentState === States.MENU) updateLoadingUI();
  }
  if (loadingIndicator && loadingText && currentState === States.PICK_SPAWN && !spawnPending) {
    if (queueLength > 0) {
      loadingText.textContent = "Loading Terrain...";
      // Compact chip over the map, never the full-screen boot page.
      loadingIndicator.classList.add("picker");
      loadingIndicator.classList.remove("hidden");
    } else {
      loadingIndicator.classList.add("hidden");
    }
  }
});

// Fallback: after 7 seconds, enable the start button even if terrain hasn't fully loaded
// (matches the boot window). The Re:Earth provider can be slow or unavailable in some
// environments; the game should still be playable with the ellipsoid as a fallback.
setTimeout(() => {
  if (!loadingStatus.globe) {
    loadingStatus.globe = true;
    loadingStatus.terrain = true;
    updateLoadingUI();
  }
}, 7000);

// Hard cap (MAX_BOOT_SECONDS): whatever is still unfinished gets force-done so
// the loading page always ends — a stalled provider can never trap the player.
setTimeout(() => {
  let changed = false;
  for (const key of ["cesium", "model", "audio", "globe", "terrain", "area"]) {
    if (!loadingStatus[key]) { loadingStatus[key] = true; changed = true; }
  }
  if (changed) updateLoadingUI();
}, MAX_BOOT_SECONDS * 1000);

// ── Preload terrain ─────────────────────────────────────────────────────────
async function preloadTerrain() {
  // Terrain provider first, then the spawn-picker preload: a hidden wide
  // camera pass warms imagery tiles for a ~300 km area around the default
  // region while the loading page is up, and sampleTerrainMostDetailed
  // refines 3D terrain across a grid of it - so the picker opens with real
  // elevation instead of streaming mid-choice. Bounded, so boot can never
  // hang on a slow or offline provider.
  try {
    const provider = await attachTerrain(viewer);
    if (provider) terrainReady = true;
  } catch (error) {
    console.warn("[terrain] Preload failed, will retry on spawn:", error);
  } finally {
    loadingStatus.terrain = true;
    updateLoadingUI();
  }
  try {
    // Not a timer cut: generous bound so the big Anaheim preload (passes +
    // DEM grid + queue drain) genuinely completes on slow connections. The
    // boot film loops as long as this takes.
    await withTimeout(preloadSpawnRegion(), 35000);
  } catch (e) { /* bounded above */ }
  loadingStatus.area = true;
  updateLoadingUI();
}

async function preloadSpawnRegion() {
  const saved = {
    destination: viewer.camera.position.clone(),
    orientation: {
      heading: viewer.camera.heading,
      pitch: viewer.camera.pitch,
      roll: viewer.camera.roll,
    },
  };
  try {
    // Pass 1: wide 160 km top-down look warms imagery tiles for a ~300 km
    // area around the default region. Each step releases a real fifth of
    // the area slice on the boot bar.
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(state.lon, state.lat, 160000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
    });
    await waitForGlobeTiles(3000);
    loadingSub.area = 0.2; updateLoadingUI();
    // Pass 2: closer 35 km pass - city-level detail imagery + terrain the
    // picker's first zoom would otherwise stream on demand.
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(state.lon, state.lat, 35000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
    });
    await waitForGlobeTiles(3000);
    loadingSub.area = 0.4; updateLoadingUI();
    // Pass 3: low 8 km pass - street-level imagery around the default spawn
    // point, so the picker's opening view is already sharp.
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(state.lon, state.lat, 8000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
    });
    await waitForGlobeTiles(2500);
    loadingSub.area = 0.6; updateLoadingUI();
    // Pass 4: 3 km pass - the sharpest imagery the picker's closest zoom
    // uses, so even a deep zoom-in over Anaheim starts warm.
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(state.lon, state.lat, 3000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
    });
    await waitForGlobeTiles(2500);
    loadingSub.area = 0.8; updateLoadingUI();
  } catch (e) { /* best effort */ }
  // 3D terrain across the region: ~ +/-3.5 deg lon x +/-2.0 deg lat grid
  // (a LOT of Anaheim: ~700 x 440 km of DEM refinement) so the picker opens
  // with real elevation everywhere you can pan.
  const pts = [];
  for (let i = 0; i < 15; i++) {
    for (let j = 0; j < 11; j++) {
      pts.push([
        state.lat + (j / 10 - 0.5) * 4.0,
        state.lon + (i / 14 - 0.5) * 7.0,
      ]);
    }
  }
  try { await groundSampler.seed(pts); } catch (e) { /* best effort */ }
  // "Area done" = the big load actually STREAMED, not just requested: wait
  // for the globe's tile queue to drain (bounded) before completing the
  // stage — the outro never plays while tiles are still visibly loading.
  await waitForGlobeTiles(8000);
  loadingSub.area = 1; updateLoadingUI();
  viewer.camera.setView(saved);
}

function waitForGlobeTiles(timeoutMs) {
  return new Promise((resolve) => {
    const started = performance.now();
    const check = () => {
      if (viewer.scene.globe.tilesLoaded || performance.now() - started > timeoutMs) { resolve(); return; }
      setTimeout(check, 250);
    };
    check();
  });
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((r) => setTimeout(r, ms))]);
}

// ── Spawn-picker terrain warm-up ────────────────────────────────────────────
// While browsing the spawn map, every finished pan/tilt samples 3D terrain in
// a small grid around wherever the map is looking, so the chosen point's
// elevation is already refined before SPAWN HERE. The imagery tiles warm
// themselves just by being on screen; this covers the terrain half.
let pickerWarmTimer = 0;
viewer.camera.moveEnd.addEventListener(() => {
  if (currentState !== States.PICK_SPAWN) return;
  const now = performance.now();
  if (now - pickerWarmTimer < 1000) return;
  pickerWarmTimer = now;
  try {
    const carto = viewer.camera.positionCartographic;
    if (!carto) return;
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const lon = Cesium.Math.toDegrees(carto.longitude);
    const pts = [];
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        pts.push([lat + i * 0.12, lon + j * 0.15]);
      }
    }
    groundSampler.seed(pts).catch(() => {});
  } catch (e) { /* warm-up is best-effort */ }
});

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
  // Tier cap (HiDPI only): a 3x-DPI phone renders 9x the pixels for an
  // overlay that is mostly the small jet sprite; 1.75x is visually
  // indistinguishable in motion and keeps weak GPUs alive.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, getQualityProfile().pixelRatioCap));
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
  bullets.attach(scene, viewer, planeModel);

  // ── MULTIPLAYER WIRING ──────────────────────────────────────────────────
  // The whole feature lives in multiplayer/ (project root) and loads
  // dynamically: delete that folder and this import 404s silently, every
  // mp?. call becomes a no-op, and the game is pure single player again.
  // Variable + @vite-ignore keeps the bundler from resolving it statically,
  // so a missing folder never breaks the build either.
  const MP_URL = "/multiplayer/index.js";
  import(/* @vite-ignore */ MP_URL)
    .then((mod) => {
      try {
        mp = mod.initMp({
          Cesium,
          viewer,
          state,
          CONFIG,
          renderer,
          getMiniViewer,
          calculateDistance,
          worldSpeedScale: WORLD_SPEED_SCALE,
          dom: {
            mainMenu,
            loadingIndicator,
            loadingText,
            spawnInstruction,
            instructionText,
            confirmSpawnBtn,
            pauseMenu,
            uiContainer,
            threeContainer,
            vignette,
            minimapCanvas: document.getElementById("minimap"),
          },
          enterSpawnPicking: (useVignette) => enterSpawnPicking(useVignette),
          isPickSpawn: () => currentState === States.PICK_SPAWN,
        });
      } catch (e) {
        console.error("[mp] initMp failed:", e);
        mp = null;
      }
    })
    .catch((e) => { console.error("[mp] module load failed:", e); mp = null; });
  initSounds().catch((err) => console.error("Failed to init sounds:", err));
  planeModel.load((progress) => {
    // Real model progress: the GLTFLoader reports bytes when the server
    // sends a length; without one the stage stays at 0 until done.
    try {
      if (progress && progress.lengthComputable && progress.total > 0) {
        loadingSub.model = progress.loaded / progress.total;
        updateLoadingUI();
      }
    } catch (e) { /* cosmetic */ }
  }).then(() => {
    loadingStatus.model = true;
    updateLoadingUI();
  }).catch((err) => {
    console.error("Failed to load model:", err);
    loadingStatus.failed = true;
    updateLoadingUI();
  });
}

// ── Sound suite (ref-flight samples, /sounds/*.mp3) ──────────────────────────
async function initSounds() {
  soundManager.init(camera);
  await Promise.all([
    soundManager.loadSound("boost", "/sounds/boost.mp3", false, 0.35),
    soundManager.loadSound("throttle", "/sounds/throttle.mp3", false, 0.4),
    soundManager.loadSound("explode", "/sounds/explode.mp3", false, 0.75),
    soundManager.loadSound("explosion-1", "/sounds/explosion-1.mp3", false, 0.8),
    soundManager.loadSound("explosion-2", "/sounds/explosion-2.mp3", false, 0.8),
    soundManager.loadSound("explosion-3", "/sounds/explosion-3.mp3", false, 0.8),
    soundManager.loadSound("gunshot", "/sounds/m61-firing.mp3", true, 0.5),
    soundManager.loadSound("ambient-crash", "/sounds/ambient.mp3", true, 0.5),
    soundManager.loadSound("jet-engine", "/sounds/jet-engine.mp3", true, 0.5),
    soundManager.loadSound("spawn", "/sounds/spawn.mp3", false, 0.5),
    soundManager.loadSound("roll", "/sounds/roll.mp3", true, 0.75),
    soundManager.loadSound("pitch", "/sounds/pitch.mp3", true, 0.75),
    soundManager.loadSound("button-click", "/sounds/button-click.mp3", false, 1.0),
    soundManager.loadSound("button-hover", "/sounds/button-hover.mp3", false, 0.25),
    soundManager.loadSound("zoom-in", "/sounds/zoom-in.mp3", false, 0.5),
    soundManager.loadSound("wind", "/sounds/wind.mp3", true, 0.25),
    soundManager.loadSound("terrain-pull-up", "/sounds/terrain-pull-up.mp3", false, 0.9),
    soundManager.loadSound("warning", "/sounds/warning.mp3", false, 0.6),
    soundManager.loadSound("glitch-1", "/sounds/glitch-transition-1.mp3", false, 0.25),
    soundManager.loadSound("glitch-2", "/sounds/glitch-transition-2.mp3", false, 0.25),
  ]);
  loadingStatus.audio = true;
  updateLoadingUI();
  setupButtonSounds();
}

function stopAllFlyingSounds(fadeOut = 0.5) {
  soundManager.stopAll(fadeOut);
}

function setupButtonSounds() {
  document.addEventListener("mouseover", (e) => {
    const target = e.target.closest("button, .menu-btn");
    if (target && !target._hovered) {
      soundManager.play("button-hover");
      target._hovered = true;
      target.addEventListener("mouseleave", () => { target._hovered = false; }, { once: true });
    }
  }, true);
  document.addEventListener("click", (e) => {
    const target = e.target.closest("button, .menu-btn");
    if (target) soundManager.play("button-click");
  }, true);
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

/**
 * Apply the camera for this rendered frame from the stored sim-step poses,
 * interpolated by `alpha` (how far the render time sits between the previous
 * step and the current one). Falls back to the current pose before the second
 * step exists.
 */
function applySmoothedCamera(alpha) {
  const b = camPoseCur;
  if (!b) return;
  const a = camPosePrev;
  if (!a) {
    setCameraToPlane(b.lon, b.lat, b.alt, b.h, b.p, b.r);
    return;
  }
  const f = Math.max(0, Math.min(1, alpha));
  let dLon = b.lon - a.lon;
  while (dLon > 180) dLon -= 360;
  while (dLon < -180) dLon += 360;
  let dH = b.h - a.h;
  while (dH > 180) dH -= 360;
  while (dH < -180) dH += 360;
  setCameraToPlane(
    a.lon + dLon * f,
    a.lat + (b.lat - a.lat) * f,
    a.alt + (b.alt - a.alt) * f,
    a.h + dH * f,
    a.p + (b.p - a.p) * f,
    a.r + (b.r - a.r) * f
  );
}

// ── Spawn picker ─────────────────────────────────────────────────────────────
function enterSpawnPicking(useVignette = true) {
  transitionGen++;
  spawnPending = false;
  const gen = transitionGen;
  // Synchronous with the user's START tap, so user-activation still applies:
  // best-effort landscape lock here. Refused on browsers that disallow it,
  // where the rotate overlay takes over instead.
  mobileMode.lockLandscape();
  stopAllFlyingSounds(0.3);
  bullets.clear();
  soundManager.play("zoom-in");
  soundManager.play("wind", 1.0);
  try {
    viewer.camera.cancelFlight();
  } catch (e) { /* no flight in progress */ }
  if (vignette && useVignette) {
    vignette.classList.add("solid");
    vignette.style.opacity = "1";
  }
  const delay = useVignette ? 500 : 0;

  setTimeout(() => {
    if (gen !== transitionGen) return;
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
    ctrl.enableTranslate = true;   // pan only
    ctrl.enableZoom = false;       // no wheel / pinch / dbl-click zoom while picking
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

    // The picker opens with a clear, focused search field.
    if (locationSearch) locationSearch.value = "";
    if (searchResults) searchResults.style.display = "none";
    if (instructionText) instructionText.style.display = "block";

    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(state.lon, state.lat, 15000),
      duration: 2.0,
      complete: () => {
        if (gen !== transitionGen) return;
        if (vignette) {
          vignette.style.opacity = "0";
          vignette.classList.remove("solid");
        }
      },
    });
  }, delay);
}

function exitSpawnPicking() {
  transitionGen++;
  // Leaving the game releases the orientation hold.
  mobileMode.unlock();
  // Leaving the picker from a multiplayer room tears the party down.
  mp?.leaveParty();
  // If a preparing-flight phase is mid-warm-up or mid-outro (its interval
  // parks the main camera at the spawn pose behind the opaque screen), stop
  // it now and put the picker view back so this exit path stays clean.
  if (preparingActive || diveFilmCtl.isPending() || diveFilmCtl.isActive()) {
    clearInterval(preparingTimer);
    preparingTimer = null;
    preparingActive = false;
    preparingFinish = null;
    diveFilmCtl.cancel();
    endDetailLod();
    try {
      if (preparingSavedView) viewer.camera.setView(preparingSavedView);
    } catch (e) { /* best-effort */ }
    preparingSavedView = null;
    if (preparingFlight) {
      preparingFlight.classList.add("hidden");
      preparingFlight.classList.remove("fading");
    }
    try { diveFilm?.pause(); } catch (e) { /* cosmetic */ }
  }
  stopAllFlyingSounds(0.3);
  try {
    viewer.camera.cancelFlight();
  } catch (e) { /* no flight in progress */ }
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

  // Search pill: an always-open round search field with the magnifier icon
  // inside, centered under the instruction text. The icon swaps to a spinner
  // while a query is in flight (set in performSearch).
  const searchPillIcon = document.getElementById("search-pill-icon");
  const originalSearchIcon = searchPillIcon ? searchPillIcon.innerHTML : "";
  window.__setSearchBusy = (busy) => {
    if (!searchPillIcon) return;
    searchPillIcon.innerHTML = busy
      ? '<div class="loader-spinner"></div>'
      : originalSearchIcon;
  };

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

let searchSeq = 0;

async function fetchJsonOk(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function photonToItems(data) {
  const feats = data?.features || [];
  return feats.slice(0, 5).map((f) => {
    const p = f.properties || {};
    const coords = f.geometry?.coordinates || [0, 0];
    const bits = [p.name, p.city || p.town || p.village, p.state, p.country].filter(Boolean);
    return {
      display_name: bits.join(", ") || "Unknown place",
      lon: String(coords[0]),
      lat: String(coords[1]),
    };
  });
}

function openMeteoToItems(data) {
  const results = data?.results || [];
  return results.slice(0, 5).map((r) => {
    const bits = [r.name, r.admin1, r.country].filter(Boolean);
    return {
      display_name: bits.join(", ") || "Unknown place",
      lon: String(r.longitude),
      lat: String(r.latitude),
    };
  });
}

async function performSearch(query) {
  const seq = ++searchSeq;
  const stillCurrent = () => seq === searchSeq && currentState === States.PICK_SPAWN;
  const showStatus = (text) => {
    if (!stillCurrent()) return;
    searchResults.style.display = "block";
    searchResults.innerHTML = `<div class="search-result-item search-status">${text}</div>`;
  };
  const renderItems = (items) => {
    if (!stillCurrent()) return;
    searchResults.innerHTML = "";
    if (!items.length) {
      searchResults.innerHTML = '<div class="search-result-item search-status">No results found — try a bigger nearby city</div>';
      return;
    }
    items.forEach((item) => {
      const div = document.createElement("div");
      div.className = "search-result-item";
      div.textContent = item.display_name;
      div.addEventListener("click", () => selectSearchResult(parseFloat(item.lon), parseFloat(item.lat), item.display_name));
      searchResults.appendChild(div);
    });
    searchResults.style.display = "block";
  };

  // Three keyless geocoders: Nominatim FIRST (ref-flight's backend, no API
  // key), then Photon, then Open-Meteo as silent fallbacks for when Nominatim
  // rate-limits or denies a browser origin. ANY failure cascades to the
  // next, so one throttled or blocked host can never take search down.
  try {
    showStatus("Searching…");
    try { window.__setSearchBusy?.(true); } catch (e) { /* cosmetic */ }
    const q = encodeURIComponent(query);
    let anySuccess = false;
    try {
      const data = await fetchJsonOk(
        `https://nominatim.openstreetmap.org/search?format=json&q=${q}&limit=5`, 5000
      );
      anySuccess = true;
      if (Array.isArray(data) && data.length) {
        renderItems(data);
        return;
      }
    } catch (err) { console.warn("Search: nominatim failed, trying backup:", err?.status || err); }
    if (!stillCurrent()) return;
    showStatus("Trying backup map server…");
    try {
      const photon = await fetchJsonOk(`https://photon.komoot.io/api/?q=${q}&limit=5`, 5000);
      anySuccess = true;
      const items = photonToItems(photon);
      if (items.length) {
        renderItems(items);
        return;
      }
    } catch (err) { console.warn("Search: photon failed, trying backup:", err?.status || err); }
    if (!stillCurrent()) return;
    try {
      const geo = await fetchJsonOk(
        `https://geocoding-api.open-meteo.com/v1/search?name=${q}&count=5&language=en&format=json`, 5000
      );
      anySuccess = true;
      const items = openMeteoToItems(geo);
      if (items.length) {
        renderItems(items);
        return;
      }
    } catch (err) { console.warn("Search: open-meteo failed:", err?.status || err); }
    if (!stillCurrent()) return;
    if (!anySuccess) {
      // All three hosts unreachable from this network — keep any good
      // results already on screen instead of wiping them.
      const hasPlaces = searchResults.querySelector(".search-result-item:not(.search-status)");
      if (!hasPlaces) {
        searchResults.style.display = "block";
        searchResults.innerHTML = '<div class="search-result-item search-status">Search is offline right now — check connection and retry</div>';
      }
    } else {
      renderItems([]);
    }
  } catch (error) {
    console.error("Search error:", error);
    if (!stillCurrent()) return;
    const hasPlaces = searchResults.querySelector(".search-result-item:not(.search-status)");
    if (!hasPlaces) {
      searchResults.style.display = "block";
      searchResults.innerHTML = '<div class="search-result-item search-status">Search is offline right now — check connection and retry</div>';
    }
  } finally {
    try { window.__setSearchBusy?.(false); } catch (e) { /* cosmetic */ }
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
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, 15000),
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

  // Search is its own placement path (it does not go through
  // selectSpawnPoint) — arm the shared multiplayer gate here too.
  mp?.noteSpawnPlaced();
}

function setupSpawnPicker() {
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

  handler.setInputAction((click) => {
    if (currentState !== States.PICK_SPAWN) return;

    // Reject only taps that actually LAND on picker UI (search field, results
    // list, zoom buttons, confirm button). elementFromPoint respects
    // pointer-events:none and visibility, so every other pixel of the map -
    // including directly under the transient loading spinner - places a
    // point. (The old padded-rect guard around the search box blanked a
    // ~440x230 px band across the middle of a phone screen.)
    const el = document.elementFromPoint(click.position.x, click.position.y);
    if (el && el.closest &&
        el.closest(".spawn-hud-top, #confirmSpawnBtn")) {
      return;
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

  // No double-click zoom: the picker is pan-only by design.
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
      // Null = every provider failed: fall back to coordinates rather than
      // sticking on "FETCHING LOCATION INFO...".
      if (!place) {
        if (instructionText) {
          const la = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"}`;
          const lo = `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
          instructionText.textContent = `${la} ${lo}`;
        }
        return;
      }
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

  // Multiplayer: committing a point re-arms the shared gate.
  mp?.noteSpawnPlaced();
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
  // Glossy 3D map pin fallback on a transparent background (280x360),
  // drawn to match the reference artwork: chubby round head, short blunt
  // tail, big hole with a thick beveled ring, warm highlight upper-left.
  const c = document.createElement("canvas");
  c.width = 280;
  c.height = 360;
  const g = c.getContext("2d");
  const cx = 140;
  const cy = 128;
  const r = 104;
  // Teardrop body path (reused for fill + shading clip).
  // NOTE: clockwise (anticlockwise=false) so the arc sweeps OVER THE TOP;
  // the other direction draws only a bottom cap + tail (down arrow, no bulb).
  const bodyPath = () => {
    g.beginPath();
    g.arc(cx, cy, r, Math.PI * 0.75, Math.PI * 0.25, false);
    g.lineTo(cx, 344);
    g.closePath();
  };
  bodyPath();
  const body = g.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
  body.addColorStop(0, "#ff6a6a");
  body.addColorStop(0.45, "#e01414");
  body.addColorStop(1, "#7d0000");
  g.fillStyle = body;
  g.fill();
  // Shading clipped to the body: deep right edge, warm left light.
  g.save();
  bodyPath();
  g.clip();
  const shade = g.createLinearGradient(cx - r, 0, cx + r, 0);
  shade.addColorStop(0, "rgba(255,180,120,0.35)");
  shade.addColorStop(0.5, "rgba(255,255,255,0)");
  shade.addColorStop(1, "rgba(90,0,0,0.55)");
  g.fillStyle = shade;
  g.fillRect(0, 0, 280, 360);
  const tailShade = g.createLinearGradient(0, cy, 0, 360);
  tailShade.addColorStop(0, "rgba(0,0,0,0)");
  tailShade.addColorStop(1, "rgba(60,0,0,0.5)");
  g.fillStyle = tailShade;
  g.fillRect(0, 0, 280, 360);
  g.restore();
  g.strokeStyle = "#6e0000";
  g.lineWidth = 6;
  bodyPath();
  g.stroke();
  // Punched see-through hole with a thick beveled ring.
  g.globalCompositeOperation = "destination-out";
  g.beginPath();
  g.arc(cx, cy, 46, 0, Math.PI * 2);
  g.fill();
  g.globalCompositeOperation = "source-over";
  const ring = g.createLinearGradient(cx - 60, cy - 60, cx + 60, cy + 60);
  ring.addColorStop(0, "#f6f6f6");
  ring.addColorStop(0.5, "#8f8f8f");
  ring.addColorStop(1, "#e2e2e2");
  g.strokeStyle = ring;
  g.lineWidth = 16;
  g.beginPath();
  g.arc(cx, cy, 54, 0, Math.PI * 2);
  g.stroke();
  // Inner bevel: light top, shadow bottom.
  g.lineWidth = 5;
  g.strokeStyle = "rgba(255,255,255,0.7)";
  g.beginPath();
  g.arc(cx, cy, 46, Math.PI * 1.05, Math.PI * 1.95);
  g.stroke();
  g.strokeStyle = "rgba(0,0,0,0.4)";
  g.beginPath();
  g.arc(cx, cy, 46, Math.PI * 0.05, Math.PI * 0.95);
  g.stroke();
  // Speculars: long left highlight + small hot dot.
  g.save();
  g.translate(cx - 62, cy - 58);
  g.rotate(-0.45);
  const spec = g.createRadialGradient(0, 0, 2, 0, 0, 56);
  spec.addColorStop(0, "rgba(255,255,255,0.8)");
  spec.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = spec;
  g.beginPath();
  g.ellipse(0, 0, 30, 56, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
  g.fillStyle = "rgba(255,255,255,0.85)";
  g.beginPath();
  g.arc(cx - 58, cy - 66, 9, 0, Math.PI * 2);
  g.fill();
  spawnPinImage = c.toDataURL("image/png");
  return spawnPinImage;
}

// ── Preparing-flight phase ─────────────────────────────────────────────────────
// The Blender fly-through plays full-screen (opaque) while the SPAWN VIEW is
// actually loaded: the main camera is parked at the destination's final pose
// so the globe streams exactly the tiles the spawned view needs (the DEM grid
// seeded in confirmSpawn never shows up in the globe's queue on its own), and
// the minimap is created and warmed at the destination so it is fully
// rendered by spawn. The bar tracks that real queue; "done" requires the
// queue to STAY empty for ~1.2s (LOD refinement idles between passes — a
// single empty tick let the dive start with tiles still incoming). Min ~3s
// so the moment never flashes by; hard cap so a stalled network can never
// trap the player; then the picker view is restored and the unchanged
// camera-dive transition flies in.
const PREPARING_MIN_MS = 3000;
const PREPARING_MAX_MS = 25000;
const PREPARING_DRAIN_MS = 1200;   // queue must stay empty this long
const PREPARING_GRACE_MS = 1500;   // requests need time to even register

let preparingSavedView = null;
let preparingSavedLod = null;
let preparingDrainedAt = 0;

/** Full-detail warm-up: the flight-tuned LOD skipping (baseScreenSpaceError
 *  1024 + skipLevelOfDetail) loads COARSE tiles fast and refines lazily —
 *  which is exactly the "green first, detail appears later" look at spawn.
 *  During the preparing window the globe loads the TRUE detail pyramid
 *  instead (every visible level, no skipping); the flight values come back
 *  when the phase ends. */
function beginDetailLod() {
  try {
    const g = viewer.scene.globe;
    preparingSavedLod = {
      baseScreenSpaceError: g.baseScreenSpaceError,
      skipLevelOfDetail: g.skipLevelOfDetail,
    };
    g.baseScreenSpaceError = 1;
    g.skipLevelOfDetail = false;
  } catch (e) { /* best-effort; defaults still load */ }
}

function endDetailLod() {
  try {
    if (preparingSavedLod) {
      const g = viewer.scene.globe;
      g.baseScreenSpaceError = preparingSavedLod.baseScreenSpaceError;
      g.skipLevelOfDetail = preparingSavedLod.skipLevelOfDetail;
    }
  } catch (e) { /* best-effort */ }
  preparingSavedLod = null;
}

function runPreparingFlight(onReady) {
  const start = performance.now();
  preparingQueuePeak = 0;
  lastPreparingQueue = 0;
  preparingActive = true;
  preparingBarShown.reset();
  preparingDrainedAt = 0;
  diveFilmCtl.cancel(); // fresh film state for this phase

  // Warm exactly what the spawned view needs, behind the opaque screen:
  // park the MAIN camera at the destination's final pose. The dive flies
  // from the picker view, so save it and restore it at the end.
  try {
    preparingSavedView = {
      destination: viewer.camera.position.clone(),
      orientation: {
        heading: viewer.camera.heading,
        pitch: viewer.camera.pitch,
        roll: viewer.camera.roll,
      },
    };
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(state.lon, state.lat, state.alt),
      orientation: {
        heading: Cesium.Math.toRadians(state.heading || 0),
        pitch: Cesium.Math.toRadians(state.pitch || 0),
        roll: 0,
      },
    });
    viewer.scene.requestRender();
  } catch (e) { /* warming is best-effort */ }
  // Full-detail LOD for the warm-up (see beginDetailLod): the queue below
  // then tracks the ENTIRE refinement pyramid, not just coarse tiles.
  beginDetailLod();

  // The minimap viewer exists EARLY and renders at the destination each
  // tick, so its own tile stream (separate viewer = separate cache) is
  // finished by spawn — the map is already the place you're flying over.
  if (!getMiniViewer()) {
    try { initMiniViewer("minimapCesium"); } catch (e) { /* cosmetic */ }
  }

  if (preparingFlight) preparingFlight.classList.remove("hidden");
  try { preparingFlightVideo?.play?.().catch?.(() => {}); } catch (e) { /* cosmetic */ }
  if (preparingBarFill) preparingBarFill.style.width = "0%";
  if (preparingPercent) preparingPercent.textContent = "0%";

  clearInterval(preparingTimer);
  preparingTimer = setInterval(() => {
    const elapsed = performance.now() - start;
    const ratio = preparingQueuePeak > 0 ? 1 - lastPreparingQueue / preparingQueuePeak : 0;
    // Warm the minimap at the pose the flight loop will use (same dynamic
    // zoom target: AGL-driven). Renders here even though the HUD is hidden —
    // its tiles only stream when it renders.
    try {
      const mv = getMiniViewer();
      if (mv) {
        const ground = groundSampler.get(state.lat, state.lon, 0);
        const agl = Math.max(0, state.alt - (Number.isFinite(ground) ? ground : 0));
        const zoomAlt = computeMinimapZoomAltitude(agl, CONFIG.minimap);
        state.minimapZoom = zoomAlt; // spawn with the map already at target
        mv.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(state.lon, state.lat, zoomAlt),
          orientation: {
            heading: Cesium.Math.toRadians(0),
            pitch: Cesium.Math.toRadians(-90),
            roll: 0,
          },
        });
        mv.render();
      }
    } catch (e) { /* the minimap is cosmetic */ }
    // Sustained drain: an empty queue only counts once it has STAYED empty
    // (refinement idles the queue between LOD passes) and after the grace
    // window (requests need a moment to register in the queue at all).
    const queueIdle = lastPreparingQueue === 0
      && elapsed > PREPARING_GRACE_MS
      && !!viewer.scene.globe.tilesLoaded;
    if (queueIdle) {
      if (!preparingDrainedAt) preparingDrainedAt = performance.now();
    } else {
      preparingDrainedAt = 0;
    }
    const drained = preparingDrainedAt !== 0
      && performance.now() - preparingDrainedAt >= PREPARING_DRAIN_MS;
    const queueEmpty = drained;
    const pct = Math.round(
      100 * preparingBarShown.update(
        preparingFlightProgress(ratio, elapsed, PREPARING_MIN_MS, PREPARING_MAX_MS, queueEmpty),
      ),
    );
    if (preparingBarFill) preparingBarFill.style.width = `${pct}%`;
    if (preparingPercent) preparingPercent.textContent = `${pct}%`;
    if (pct >= 100) {
      // 100%: the bar stops here and the film takes over — it finishes its
      // current lap, then (at the loop boundary) plays the zoom-off tail
      // while the screen fades; the bound completion then restores the
      // picker view and starts the dive. The parked camera keeps warming
      // tiles through the whole outro.
      clearInterval(preparingTimer);
      preparingTimer = null;
      preparingFinish = () => {
        preparingActive = false;
        endDetailLod();
        // Restore the picker view so the dive flies from it, exactly as
        // before (the whole warm-up happened behind the opaque screen).
        try {
          if (preparingSavedView) viewer.camera.setView(preparingSavedView);
        } catch (e) { /* best-effort */ }
        preparingSavedView = null;
        if (preparingFlight) {
          preparingFlight.classList.add("hidden");
          preparingFlight.classList.remove("fading");
        }
        try { diveFilm?.pause(); } catch (e) { /* cosmetic */ }
        onReady();
      };
      diveFilmCtl.queueOutro();
    }
  }, 100);
}

// ── Confirm spawn with transition animation ──────────────────────────────────
function confirmSpawn() {
  // Radial (see-through center) fade, NOT solid black — the spawn flight
  // itself must stay visible while the camera dives onto the city.
  transitionGen++;
  const gen = transitionGen;
  soundManager.resumeAll();
  stopAllFlyingSounds(0.3);
  try {
    viewer.camera.cancelFlight();
  } catch (e) { /* no flight in progress */ }
  setStreetsVisible(false);
  clearNotablePlaces();
  soundManager.play("spawn");
  if (vignette) {
    vignette.classList.remove("solid");
    vignette.style.opacity = "1";
  }

  // Pre-spawn beat: the preparing screen owns this moment (no second loading
  // chip over it - just the one bar). Seeds a HUGE DEM area around the chosen
  // point - +/-0.25 deg (~28 km) grid + the forward flight path - so the dive
  // window streams a real neighborhood and the spawn arrives without visible
  // tile loading around the jet.
  try {
    const pre = [];
    for (let dy = -16; dy <= 16; dy++) {
      for (let dx = -16; dx <= 16; dx++) {
        pre.push([state.lat + dy * 0.015625, state.lon + dx * 0.015625]);
      }
    }
    groundSampler.seed(pre).catch(() => {});
    viewer.scene.requestRender();
  } catch (e) { /* warm-up is best-effort */ }
  // Own the wait: no double-clicks, and the tile-progress handler
  // leaves the picker chip alone until the flight setup takes over.
  spawnPending = true;
  if (confirmSpawnBtn) confirmSpawnBtn.classList.add("hidden");

  runPreparingFlight(() => {
    spawnPending = false;
    if (gen !== transitionGen) return;
    if (spawnMarker) {
      viewer.entities.remove(spawnMarker);
      spawnMarker = null;
    }
    if (spawnIndicator) {
      viewer.entities.remove(spawnIndicator);
      spawnIndicator = null;
    }

    // Spawn heading comes from the picker camera — read it BEFORE placing
    // anything so the pin and the dive agree.
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
    // Location chip truth: a respawn must never show the previous flight's
    // region. Clear the stale reverse-geocode name so the chip reads the
    // new spawn label immediately, and arm the geocode tracker so the first
    // update() re-resolves the real region at the new spot.
    state.region = null;
    currentRegionName = null;
    geocodeTimer = 0;
    lastGeocodePos = { lon: state.lon, lat: state.lat };
    try {
      const carto = Cesium.Cartographic.fromDegrees(state.lon, state.lat);
      const groundH = viewer.scene.globe.getHeight(carto);
      spawnIndicator = viewer.entities.add({
        // Hidden until the jet is 500 ft out (revealed in update): the jet
        // spawns exactly on the chosen point, so a visible pin would fill
        // the screen on arrival.
        show: false,
        position: Cesium.Cartesian3.fromDegrees(
          state.lon, state.lat, groundH === undefined ? 0 : groundH
        ),
        billboard: {
          image: getSpawnPinImage(),
          sizeInMeters: true,
          width: 550,
          height: 707,
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

    // The jet spawns exactly on the chosen point — no forward offset — and
    // the dive animation lands dead on it. The hidden pin drops in at
    // 500 ft (see update) to mark where you launched.
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
    state.minimapHeading = state.heading;
    lastCrashPos = null;
    physics = new PlanePhysics();
    physics.reset(state.lon, state.lat, state.alt, state.heading, state.pitch, state.roll);
    particles.clear();
    bullets.clear();
    planeModel.reset();

    if (spawnInstruction) spawnInstruction.classList.add("hidden");
    if (confirmSpawnBtn) confirmSpawnBtn.classList.add("hidden");
    loadingIndicator.classList.add("hidden");

    currentState = States.TRANSITIONING;

    // Minimap viewer is built lazily HERE - inside the hidden spawn beat -
    // instead of at page load: until the first flight the app runs on one
    // Cesium context (a second one burned VRAM + a render loop all through
    // boot and the menus for nothing). Null-safe everywhere else, so a
    // failed init degrades to the canvas-less HUD gracefully.
    if (!getMiniViewer()) {
      try { initMiniViewer("minimapCesium"); } catch (e) { /* cosmetic */ }
    }

    // Tile warm-up: at 1.8x arcade speed the jet outruns fresh tiles, so
    // prime the terrain cache in a ~12 km box around the spawn plus the
    // flight-path ahead while the pull-up plays. High-detail imagery then
    // streams during the flight instead of after arrival.
    try {
      const pts = [];
      for (let dy = -5; dy <= 5; dy++) {
        for (let dx = -5; dx <= 5; dx++) {
          pts.push([state.lat + dy * 0.01, state.lon + dx * 0.01]);
        }
      }
      // Flight-path lead: points along the spawn heading out to ~12 km so
      // the first seconds of flight already have sampled elevation ahead.
      try {
        const hRad = Cesium.Math.toRadians(state.heading || 0);
        const R = 6371000;
        const latR = Cesium.Math.toRadians(state.lat);
        const cosLat = Math.max(0.2, Math.cos(latR));
        for (const dist of [3000, 6000, 9000, 12000]) {
          pts.push([
            state.lat + Cesium.Math.toDegrees((dist * Math.cos(hRad)) / R),
            state.lon + Cesium.Math.toDegrees((dist * Math.sin(hRad)) / (R * cosLat)),
          ]);
        }
      } catch (e) { /* box alone still helps */ }
      groundSampler.seed(pts).catch(() => {});
      viewer.scene.requestRender();
    } catch (e) { /* warm-up is best-effort */ }

    // Spawn flight: ref-flight's EXACT animation - one eased flight from
    // the picker view straight onto the plane's flight position (the old
    // two-phase perch-and-dive is replaced by their single flyTo).
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
        if (gen !== transitionGen) return;
        // The airplane fades in as the flight begins so it appears mid-air.
        if (threeContainer) threeContainer.classList.remove("hidden");
        flightStartTime = Date.now();
        if (uiContainer) uiContainer.classList.remove("hidden");
        currentState = States.FLYING;
        resetCameraSmoothing();
        hud.resetTime();
        hud.resetScore();
        soundManager.play("jet-engine", 1.0);
        soundManager.play("wind", 1.0);
        // Multiplayer: flight phase begins - presence markers hand off
        // to live remote planes, and the performance diet turns on.
        mp?.onFlightStart();
        try {
          getMiniViewer()?.resize();
        } catch (e) { /* minimap is cosmetic */ }
        if (vignette) {
          vignette.style.opacity = "0";
          vignette.classList.remove("solid");
        }
      },
    });

    // Safety net: a camera flight's complete callback can be skipped if the
    // animation is interrupted. Silent backstop only - sized just past the
    // 2 s flight, so it never visibly cuts a healthy transition.
    setTimeout(() => {
      if (gen !== transitionGen) return;
      if (currentState !== States.TRANSITIONING) return;
      flightStartTime = Date.now();
      if (uiContainer) uiContainer.classList.remove("hidden");
      if (threeContainer) threeContainer.classList.remove("hidden");
      currentState = States.FLYING;
      resetCameraSmoothing();
      hud.resetTime();
      hud.resetScore();
      mp?.onFlightStart();
      try {
        getMiniViewer()?.resize();
      } catch (e) { /* minimap is cosmetic */ }
      if (vignette) {
        vignette.style.opacity = "0";
        vignette.classList.remove("solid");
      }
    }, 5000);
  });
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
  state.boostCharge = physicsResult.boostCharge;

  // ── Flight sounds (ref-flight behavior) ──
  if (soundManager.isPlaying("jet-engine")) {
    const speedFactor = Math.max(0, Math.min(1, (state.speed - 500) / 9500));
    soundManager.setVolume("jet-engine", 0.5 + speedFactor * 0.1);
    soundManager.setVolume("wind", 0.1 + speedFactor * 0.35);
  }
  if (state.isBoosting && !lastBoostSound) soundManager.play("boost");
  lastBoostSound = state.isBoosting;
  if (state.throttle > lastThrottleLevel + 0.01 && !soundManager.isPlaying("throttle")) {
    soundManager.play("throttle");
  }
  lastThrottleLevel = state.throttle;
  if (Math.abs(input.pitch) > 0.5) {
    if (!soundManager.isPlaying("pitch")) soundManager.play("pitch", 0.1);
  } else if (soundManager.isPlaying("pitch")) {
    soundManager.stop("pitch", 0.1);
  }
  if (Math.abs(input.roll) > 0.5 || Math.abs(input.yaw) > 0.5) {
    if (!soundManager.isPlaying("roll")) soundManager.play("roll", 0.1);
  } else if (soundManager.isPlaying("roll")) {
    soundManager.stop("roll", 0.1);
  }
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
  const newPos = movePosition(state.lon, state.lat, state.alt, state.heading, state.pitch, state.speed * MPH_TO_MPS * WORLD_SPEED_SCALE * dt);
  state.lon = newPos.lon;
  state.lat = newPos.lat;
  state.alt = newPos.alt;

  // Realistic altitude: height above the terrain below (AGL), not sea
  // level, so skimming the ground reads near zero instead of ~900 ft.
  // Uses the accurate sampler (cached fine-DEM samples warms via request(),
  // resident tiles near the ground) — raw globe.getHeight() from altitude
  // interpolates coarse tiles and can be off by kilometers.
  try {
    groundSampler.request(state.lat, state.lon);
    const cartoNow = Cesium.Cartographic.fromDegrees(state.lon, state.lat);
    const terrainH = viewer.scene.globe.getHeight(cartoNow);
    const ground =
      groundSampler.get(state.lat, state.lon, terrainH === undefined ? state.alt : terrainH);
    state.agl = Math.max(0, state.alt - ground);
  } catch (e) {
    state.agl = state.alt;
  }

  // Forward tile preload: twice a second, prime the terrain cache in a fan
  // ahead of the nose. The lead scales with TRUE ground speed (~2.5 s of
  // flight, 3–20 km), so cruise doesn't waste fetches far away while boost
  // still has sampled elevation waiting. Imagery ahead streams on its own —
  // the forward-looking camera drives it every frame via setCameraToPlane
  // below; this covers the elevation side.
  try {
    preloadTimer += dt;
    if (preloadTimer > 0.5) {
      preloadTimer = 0;
      const hRad = Cesium.Math.toRadians(state.heading || 0);
      const R = 6371000;
      const latR = Cesium.Math.toRadians(state.lat);
      const cosLat = Math.max(0.2, Math.cos(latR));
      const groundSpeed = (state.speed || 500) * MPH_TO_MPS * WORLD_SPEED_SCALE;
      const lead = Math.min(20000, Math.max(3000, groundSpeed * 2.5));
      const pts = [];
      for (const frac of [0.25, 0.5, 0.75, 1.0]) {
        const dist = lead * frac;
        for (const side of [-2000, 0, 2000]) {
          const fwd = dist;
          const dLat = (fwd * Math.cos(hRad) - side * Math.sin(hRad)) / R;
          const dLon = (fwd * Math.sin(hRad) + side * Math.cos(hRad)) / (R * cosLat);
          pts.push([
            state.lat + Cesium.Math.toDegrees(dLat),
            state.lon + Cesium.Math.toDegrees(dLon),
          ]);
        }
      }
      groundSampler.seed(pts).catch(() => {});
    }
  } catch (e) { /* preload is best-effort */ }

  // Pin drop: the spawn pin stays hidden through the dive and pops in once
  // the jet is 100 ft out, marking the exact launch point behind you.
  try {
    if (spawnIndicator && spawnIndicator.show === false && state.spawnLon !== null) {
      const distFromSpawn = calculateDistance(state.lon, state.lat, state.spawnLon, state.spawnLat);
      if (distFromSpawn > PIN_REVEAL_M) spawnIndicator.show = true;
    }
  } catch (e) { /* indicator is cosmetic */ }

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

  // Store this sim step's camera pose; the render loop applies it with
  // sub-step interpolation so world motion is not quantized to 1/60 s steps
  // (see applySmoothedCamera).
  camPosePrev = camPoseCur;
  camPoseCur = {
    lon: state.lon,
    lat: state.lat,
    alt: state.alt,
    h: Cesium.Math.toDegrees(finalHPR.heading),
    p: Cesium.Math.toDegrees(finalHPR.pitch),
    r: Cesium.Math.toDegrees(finalHPR.roll),
  };

  // Speed-visible camera: FOV widens continuously with TRUE speed so 5000
  // mph already rushes and 10000 mph screams — boost adds an extra kick.
  // World motion itself is untouched: movePosition() below converts MPH to
  // m/s linearly every substep, so the ground track is already real.
  try {
    const frustum = viewer.camera.frustum;
    if (frustum && typeof frustum.fovy === "number") {
      const baseFov = CONFIG.camera.fov * Math.PI / 180;
      const speedFactor = Math.max(0, Math.min(1, (state.speed - 500) / 9500));
      const targetFov = baseFov * (1 + speedFactor * 0.18 + (physicsResult.isBoosting ? 0.14 : 0));
      const cur = frustum.fovy;
      frustum.fovy = cur + (targetFov - cur) * Math.min(1, dt * 5);
    }
  } catch (e) { /* FOV kick is cosmetic */ }

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

  // Live rounds keep flying their frozen paths.
  bullets.update(dt);

  // ── Gun trigger, ref-flight style ────────────────────────────────────────
  // Hold F/Enter (desktop) or the green FIRE stick (mobile) for a 20 Hz
  // stream straight off the nose; the gun heats and jams as in the
  // reference. Each round freezes its path at its own fire moment, so
  // moving the plane never bends an in-flight round. Desktop quick clicks
  // still fire an AIMED round via fireBulletAtScreen.
  const triggerHeld = currentState === States.FLYING && (
    !!controller.keys["f"] || !!controller.keys["enter"] || !!(touchControls && touchControls.isFiringHeld && touchControls.isFiringHeld())
  );
  if (triggerHeld) {
    bullets.fire(state, state.heading, state.pitch, MPH_TO_MPS * WORLD_SPEED_SCALE);
  }
  // Blue boost stick: while held, request the boost every frame - the physics
  // re-fires whenever the charge refills, exactly like holding space.
  if (currentState === States.FLYING && touchControls && touchControls.isBoostHeld && touchControls.isBoostHeld()) {
    controller.requestBoost();
  }
  // M61 loop while the trigger is down (stopped by overheat), like ref-flight.
  try {
    if (triggerHeld && !bullets.isGunOverheated) {
      if (!soundManager.isPlaying("gunshot")) soundManager.play("gunshot", 0.05);
    } else if (soundManager.isPlaying("gunshot")) {
      soundManager.stop("gunshot", 0.05);
    }
    if (bullets.isGunOverheated && !gunOverheatWarned) {
      soundManager.play("warning");
      gunOverheatWarned = true;
    } else if (!bullets.isGunOverheated) {
      gunOverheatWarned = false;
    }
  } catch (e) { /* audio not ready */ }
  state.gunHeat = bullets.heat;
  state.gunOverheated = bullets.isGunOverheated;

  const now = Date.now();
  const distFromLast = calculateDistance(state.lon, state.lat, lastGeocodePos.lon, lastGeocodePos.lat);
  if (now - geocodeTimer > 10000 || distFromLast > 1000) {
    geocodeTimer = now;
    lastGeocodePos = { lon: state.lon, lat: state.lat };
    reverseGeocode(state.lon, state.lat).then((name) => {
      if (name && name !== currentRegionName) {
        currentRegionName = name;
        state.region = name;
      }
    });
  }
}

// ── Wing-gun fire (click / tap / held trigger) ──────────────────────────────
// A click fires a laser bullet on a FIXED path: the aim heading/pitch come
// from the camera pick ray through the click point, sampled once. The bullet
// never reads the plane again - turning after the shot does not bend it.
function fireBulletAtScreen(x, y) {
  if (currentState !== States.FLYING) return;
  try {
    const ray = viewer.camera.getPickRay(new Cesium.Cartesian2(x, y));
    if (!ray || !ray.direction) return;

    // Click ray direction (ECEF) into ENU at the plane, then to heading/pitch.
    const planePos = Cesium.Cartesian3.fromDegrees(state.lon, state.lat, state.alt);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(planePos);
    const d = ray.direction;
    const dE = d.x * enu[0] + d.y * enu[1] + d.z * enu[2];        // east column
    const dN = d.x * enu[4] + d.y * enu[5] + d.z * enu[6];        // north column
    const dU = d.x * enu[8] + d.y * enu[9] + d.z * enu[10];       // up column
    const aimHeading = Cesium.Math.toDegrees(Math.atan2(dE, dN));
    const aimPitch = Cesium.Math.toDegrees(Math.asin(Math.max(-1, Math.min(1, dU))));

    bullets.fire(state, aimHeading, aimPitch, MPH_TO_MPS * WORLD_SPEED_SCALE);
  } catch (e) { /* gunfire must never break the frame */ }
}

// Desktop: quick click fires; dragging (camera look) does not. Mobile taps go
// through TouchControls instead, so this path is desktop-only.
if (!mobileMode.enabled) {
  let pendingShot = null;
  window.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse" || currentState !== States.FLYING) return;
    if (e.target && e.target.closest && e.target.closest("button, input, .overlay, a")) return;
    pendingShot = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };
  });
  window.addEventListener("pointermove", (e) => {
    if (pendingShot) pendingShot.moved = Math.max(pendingShot.moved, Math.hypot(e.clientX - pendingShot.x, e.clientY - pendingShot.y));
  });
  window.addEventListener("pointerup", (e) => {
    if (!pendingShot) return;
    const shot = pendingShot;
    pendingShot = null;
    if (performance.now() - shot.t < 350 && shot.moved < 6) {
      fireBulletAtScreen(shot.x, shot.y);
    }
  });
}

function checkGPWS() {
  if (currentState !== States.FLYING) return;
  const cartographic = Cesium.Cartographic.fromDegrees(state.lon, state.lat);
  const resident = viewer.scene.globe.getHeight(cartographic);
  if (resident === undefined) return;
  // Sampled elevation like the AGL readout — the coarse resident tile alone
  // can be kilometers off over ridges and would mute the warning.
  const agl = state.alt - groundSampler.get(state.lat, state.lon, resident);
  const pitchRad = Cesium.Math.toRadians(state.pitch);
  const verticalSpeed = state.speed * MPH_TO_MPS * WORLD_SPEED_SCALE * Math.sin(pitchRad);

  let showWarning = false;
  if (state.pitch < -2) {
    if (agl < 450) {
      if (agl < 150) showWarning = true;
      if (verticalSpeed < -20) showWarning = true;
    }
  }
  hud.setPullUpWarning(showWarning);

  // Audible "PULL UP" with cooldown (ref-flight GPWS behavior).
  if (showWarning) {
    const now = Date.now();
    if (!gpwsActive || (now - lastGPWSWarningTime > GPWS_COOLDOWN && !soundManager.isPlaying("terrain-pull-up"))) {
      soundManager.play("terrain-pull-up");
      lastGPWSWarningTime = now;
    }
    gpwsActive = true;
  } else if (gpwsActive) {
    soundManager.stop("terrain-pull-up", 0.1);
    gpwsActive = false;
  }
}

function checkCrash() {
  if (currentState !== States.FLYING) return;
  const now = Date.now();
  // Run every frame, not on a 50 ms cadence: at speed the jet covers 100 m+
  // between throttled checks, so it visibly sank into terrain before the hit
  // registered. The per-frame segmented sweep below keeps the cost bounded.

  // Path anchor updates every check (even inside takeoff grace) so the
  // first real sweep never drags a segment across the map.
  const cur = { lon: state.lon, lat: state.lat };
  const prev = lastCrashPos && Number.isFinite(lastCrashPos.lon) ? lastCrashPos : cur;
  lastCrashPos = cur;
  if (now - flightStartTime < 1500) return;

  // Segmented sweep: at boost speeds one sample per check (~400 m apart)
  // can tunnel straight through narrow ridges, so test up to 8 sub-samples
  // back along the path (~200 m apart) and crash on the first hit.
  const segDist = calculateDistance(prev.lon, prev.lat, cur.lon, cur.lat);
  const segs = Math.min(8, Math.max(1, Math.ceil(segDist / 200)));
  let hitGround = null;
  for (let i = 0; i <= segs; i++) {
    const f = i / segs;
    const lon = prev.lon + (cur.lon - prev.lon) * f;
    const lat = prev.lat + (cur.lat - prev.lat) * f;
    let ground;
    try {
      const cartographic = Cesium.Cartographic.fromDegrees(lon, lat);
      const terrainHeight = viewer.scene.globe.getHeight(cartographic);
      ground = groundSampler.get(lat, lon, terrainHeight ?? state.alt);
    } catch (e) { continue; }
    if (state.alt <= ground + 5) { hitGround = ground; break; }
  }
  if (hitGround === null) return;
  {
    // Crash: snap onto the ground so the readout is true zero (or the
    // mountain's height in hill ranges) instead of a stale few feet.
    state.alt = hitGround;
    state.agl = 0;
    // Crash: detonate at the plane's on-screen position (ref-flight style
    // explosion), hide the wreck, and hold the fireball on screen briefly
    // before dropping to the pause menu. Detonation is synchronous with
    // impact — no delays before the flash or the sound.
    currentState = States.PAUSED;
    const gen = transitionGen;
    stopAllFlyingSounds(0.1);
    soundManager.play("explode");
    soundManager.play("ambient-crash");
    try {
      // Only detonate once per wreck (resume-after-crash re-triggers this
      // check while still inside the terrain).
      if (!planeModel?.model || planeModel.model.visible !== false) {
        const at = planeModel?.model?.position?.clone?.() ?? null;
        particles.spawnExplosion(at, { big: true, count: 72, smokeCount: 16 });
        if (planeModel?.model) planeModel.model.visible = false;
      }
    } catch (e) { /* explosion is cosmetic; never break the crash flow */ }
    setTimeout(() => {
      // Stale guard: a respawn/restart started after this crash must not be
      // yanked back to the menu by the old timer.
      if (gen !== transitionGen) return;
      if (currentState !== States.PAUSED) return;
      if (uiContainer) uiContainer.classList.add("hidden");
      if (threeContainer) threeContainer.classList.add("hidden");
      if (pauseMenu) pauseMenu.classList.remove("hidden");
    }, 1000);
  }
}

// ── Render loop ──────────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  // Wall-clock frame time (cosmetic systems use this directly). Flight
  // physics below consumes it in fixed slices instead, so motion never
  // dilates — a backgrounded tab just drops the backlog past 0.25s.
  let dt = clock ? clock.getDelta() : 0.016;
  if (!Number.isFinite(dt) || dt < 0) dt = 0.016;
  dt = Math.min(dt, 0.25);
  const now = performance.now();

  // Both loading films: JS owns the loop (per-frame tick; timeupdate alone
  // overshoots the boundary by up to 250 ms). When an outro is queued the
  // boundary is NOT wrapped — the film plays straight into its zoom-off
  // tail as the literal next frame, one continuous shot.
  bootFilmCtl.tick();
  diveFilmCtl?.tick();

  if (currentState === States.FLYING || currentState === States.PAUSED || currentState === States.TRANSITIONING) {
    if (currentState === States.FLYING) {
      simAcc += dt;
      let steps = 0;
      while (simAcc >= SIM_STEP && steps < SIM_MAX_STEPS) {
        update(SIM_STEP);
        simAcc -= SIM_STEP;
        steps++;
      }
      if (steps === SIM_MAX_STEPS) simAcc = 0;
      // Render between the previous and current sim step so the world moves
      // continuously rather than in whole-step jumps.
      applySmoothedCamera(simAcc / SIM_STEP);
    } else if (currentState === States.TRANSITIONING && planeModel?.model) {
      // Keep the jet breathing (idle wobble, flames) through the spawn dive
      // so it never freezes a frame before flight starts.
      try {
        planeModel.update(
          {
            boostDuration: CONFIG.boost.duration,
            boostTimeRemaining: 0,
            boostRotations: CONFIG.boost.rotations,
            speed: 0,
            throttle: 0,
          },
          {
            pitch: 0, roll: 0, yaw: 0, throttle: 0,
            cameraYaw: 0, cameraPitch: 0, isDragging: false,
          },
          dt,
          false
        );
      } catch (e) { /* cosmetic */ }
    }

    state.isFlying = currentState === States.FLYING;

    // Joysticks only while the plane is controllable and the phone is held
    // sideways; hiding force-releases any held thumb so a state change can't
    // pin an axis.
    if (touchControls) {
      touchControls.setVisible(currentState === States.FLYING && !mobileMode.isPortrait);
    }
    if (hud) hud.update(state, now);

    minimapUpdateTimer += dt;
    if (minimapUpdateTimer > 0.05) {
      minimapUpdateTimer = 0;
      hud.updateMinimap(state);
      // Multiplayer peer markers draw on top of the base overlay.
      mp?.drawMinimap();
    }

    // Minimap truth (ref-flight parity): smooth one shared heading, derive
    // one shared zoom, and re-aim the real-map camera EVERY frame so the map
    // never lags the world in turns. The canvas overlay reads the same two
    // values from state.
    {
      let diff = state.heading - state.minimapHeading;
      while (diff < -180) diff += 360;
      while (diff > 180) diff -= 360;
      state.minimapHeading += diff * Math.min(1, dt * 8);
      while (state.minimapHeading <= -180) state.minimapHeading += 360;
      while (state.minimapHeading > 180) state.minimapHeading -= 360;
      // Dynamic zoom: the map view altitude tracks height above ground —
      // zoomed in near the deck, zoomed out high up — smoothed so climbing
      // and diving never snaps the map. Same target the preparing warm-up
      // uses, so the map is already at the right zoom at spawn.
      const zoomTarget = computeMinimapZoomAltitude(state.agl, CONFIG.minimap);
      state.minimapZoom += (zoomTarget - state.minimapZoom) * Math.min(1, dt * CONFIG.minimap.zoomSmooth);
      try {
        setMinimapCamera(state.lon, state.lat, state.minimapZoom, state.minimapHeading);
      } catch (e) { /* minimap is cosmetic */ }
    }

    // Multiplayer per-frame work: remote-plane presentation, adaptive
    // quality, badge, flight-state broadcast. All inside the module.
    mp?.tick(dt);

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

    // Render the plane overlay. The Three.js camera stays at the origin;
    // the Cesium camera does the world-space tracking. FOV SYNC (ref-flight):
    // the overlay camera must render at the Cesium camera's LIVE vertical FOV,
    // or world-space objects placed through the view matrix (bullets) land at
    // the wrong screen position/scale - this is what makes ref-flight's
    // projectiles line up with the world.
    renderer.autoClear = false;
    renderer.clear();
    try {
      if (viewer && viewer.camera && viewer.camera.frustum.fovy) {
        const targetFov = Cesium.Math.toDegrees(viewer.camera.frustum.fovy);
        camera.fov = targetFov;
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        // The jet is drawn at fixed camera-space offsets tuned for the
        // overlay's original 75 deg FOV. Under the synced (~30 deg) FOV the
        // narrow frustum cone pushed the jet outside its bottom edge (the
        // "can't see the airplane" regression). PlaneModel.update applies
        // the live ratio to the jet's lateral offset and size each frame;
        // at k=1 (fov 75) everything is a no-op, so the original look is
        // restored exactly.
        const planeScale = Math.tan(Cesium.Math.toRadians(camera.fov) / 2)
          / Math.tan(Cesium.Math.toRadians(CONFIG.camera.fov) / 2);
        if (planeModel) planeModel.fovScale = planeScale;
      }
    } catch (e) { /* fov sync is cosmetic-critical but must never break the frame */ }
    camera.layers.set(1);
    renderer.render(scene, camera);
    renderer.clearDepth();
  }

  // Cesium render is driven from HERE (its internal loop is disabled - it
  // duplicated every frame). While the boot page is up the globe is hidden
  // behind the video, so throttle to ~10 renders/s: tile streaming happens
  // inside render() and needs only a few passes a second, while the video
  // and the progress bar are pure DOM and stay smooth. Full-rate rendering
  // resumes with the menu.
  if (loadingPageHidden || now - lastThrottledRender > 100) {
    if (!loadingPageHidden) lastThrottledRender = now;
    try { viewer.render(); } catch (e) { /* one bad frame never kills the loop */ }
  }
}

// ── UI events ────────────────────────────────────────────────────────────────

startBtn.addEventListener("click", () => {
  if (mainMenu) mainMenu.classList.add("hidden");
  enterSpawnPicking(false);
});

confirmSpawnBtn.addEventListener("click", () => {
  // Multiplayer gate: a greyed button must not launch early.
  if (mp?.isActive() && !mp.bothSpawnPlaced()) return;
  confirmSpawn();
});

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
  // Multiplayer: NEW LOCATION keeps the party and pulls BOTH players back
  // to the shared spawn gate.
  if (mp?.isActive()) {
    mp.goBackToPicking();
    return;
  }
  enterSpawnPicking(true);
});

// Web Audio starts suspended until a user gesture — resume on first input.
const resumeAudio = () => {
  try {
    if (soundManager.listener.context.state === "suspended") {
      soundManager.listener.context.resume();
    }
  } catch (e) { /* audio not ready */ }
};
window.addEventListener("mousedown", resumeAudio);
window.addEventListener("keydown", resumeAudio);

window.addEventListener("keydown", (e) => {
  const key = e.key.toLowerCase();
  if (key === "escape" || key === "p") {
    if (currentState === States.FLYING) {
      currentState = States.PAUSED;
      soundManager.pauseAll();
      if (uiContainer) uiContainer.classList.add("hidden");
      if (threeContainer) threeContainer.classList.add("hidden");
      if (pauseMenu) pauseMenu.classList.remove("hidden");
    } else if (currentState === States.PAUSED) {
      // Wrecked jets can't resume in place — that re-triggers the crash
      // instantly inside the terrain and loops the menu. Pick a menu option.
      if (planeModel?.model && planeModel.model.visible === false) return;
      currentState = States.FLYING;
      // Fresh takeoff grace so resuming low over a ridge doesn't insta-crash.
      flightStartTime = Date.now();
      soundManager.resumeAll();
      if (pauseMenu) pauseMenu.classList.add("hidden");
      if (uiContainer) uiContainer.classList.remove("hidden");
      if (threeContainer) threeContainer.classList.remove("hidden");
    } else if (currentState === States.PICK_SPAWN && key === "escape") {
      exitSpawnPicking();
    }
  }
  if (key === "m" && currentState === States.FLYING) {
    soundMuted = !soundMuted;
    try {
      soundManager.listener.setMasterVolume(soundMuted ? 0.0 : 1.0);
    } catch (e) { /* audio not ready */ }
  }
  // Picker is pan-only: no zoom shortcuts either.
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
// (Minimap viewer init moved to the spawn beat - see the confirmSpawn
// callback. One Cesium context at boot instead of two.)
preloadTerrain();
setSunForTime(viewer, 12, state.lat, state.lon);

if (uiContainer) uiContainer.classList.add("hidden");
if (threeContainer) threeContainer.classList.add("hidden");

updateLoadingUI();

// ── Test hook (dev-mobile-test.mjs) ─────────────────────────────────────────
// Behind ?devtest=1 so production never exports it; the probe asserts raw
// control state through here instead of screenshots.
if (new URLSearchParams(location.search).has("devtest")) {
  window.SKY_DEV = {
    controller,
    physics,
    state,
    get currentState() { return currentState; },
    mobileMode,
    touchControls,
    bullets,
    viewer,
    renderer,
    planeModel,
    get threeCamera() { return camera; },
    get threeScene() { return scene; },
    // Fire + aim exactly like a real click at the given screen point.
    fireBulletAtScreen,
    // Deterministic spawn placement for integration tests — the game's own
    // placement path, skipping the raster-tap that headless WebGL can't hit.
    placeSpawn: (lon, lat, name) => selectSpawnPoint(lon, lat, 0, name, name, null),
  };
}

animate();
