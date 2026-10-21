import {
  Viewer,
  EllipsoidTerrainProvider,
  UrlTemplateImageryProvider,
  Cartographic,
  Cartesian3,
  JulianDate,
  Color,
  Math as CesiumMath,
  Viewer as CesiumViewer,
  RequestScheduler,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { CONFIG } from "./config.js";
import { getQualityProfile } from "./quality.js";

/**
 * Build the smallest runnable viewer first: one keyless terrain provider and
 * one keyless imagery provider, no token anywhere. Everything else in the app
 * layers on top of this.
 */
let mainViewer = null;

export function getViewer() {
  return mainViewer;
}

/**
 * Open-ocean tile gaps (failed tiles at high zoom, seen over parts of the
 * Atlantic): re-request a failed tile from the same zoom/row over the
 * mid-Pacific instead of rendering a gap. Donor failures rethrow so
 * Cesium's normal parent-tile fallback still applies.
 */
export function withOceanDonor(provider) {
  try {
    const origRequest = provider.requestImage.bind(provider);
    provider.requestImage = (x, y, level) =>
      Promise.resolve()
        .then(() => origRequest(x, y, level))
        .catch((firstErr) => {
          const n = Math.pow(2, level);
          const donorX = Math.floor(n / 12) % n;
          if (donorX === x) throw firstErr;
          // A donor failure must never mask the original error.
          return origRequest(donorX, y, level).catch(() => { throw firstErr; });
        });
  } catch (e) { /* fallback stays as-is */ }
  return provider;
}

export function createViewer(container) {
  const profile = getQualityProfile();
  const viewer = new Viewer(container, {
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    vrButton: false,
    infoBox: false,
    selectionIndicator: false,
    // We manage imagery ourselves. Without this Cesium injects its default
    // ion base layer, which has no token here, fails to resolve, and leaves a
    // broken shader program in the render loop.
    baseLayer: false,
    // render is driven MANUALLY from the app's own rAF (animate() calls
    // viewer.render()). Leaving the internal loop on rendered the globe a
    // second time every frame - pure duplicated GPU work.
    useDefaultRenderLoop: false,
    // MSAA from the auto quality tier (fxaa stays on at every tier).
    msaaSamples: profile.msaaSamples,
    contextOptions: {
      webgl: { powerPreference: "high-performance" },
    },
  });

  // Wider tile-request pipe for our HTTP/2 hosts: Cesium's default
  // per-server cap (18 in 1.132) is the bottleneck when the jet outruns the
  // tile stream at high speed; both services handle more in flight.
  try {
    // 40 per server / 96 globally. The old 28/64 was tuned when the LOD asked
    // for levels a 3000 mph jet cannot be served anyway; with the speed-driven
    // level cap in place the demand is smaller and legitimate, so the pipe is
    // what should be wider. Both hosts are HTTP/2, so this is Cesium's own
    // scheduler limit, not the browser's connection count.
    const imageryHost = new URL(CONFIG.imagery.url).host + ":443";
    RequestScheduler.requestsByServer[imageryHost] = 40;
    const terrainHost = new URL(CONFIG.terrain.url).host + ":443";
    RequestScheduler.requestsByServer[terrainHost] = 40;
    RequestScheduler.maximumRequests = 96;
  } catch (e) { /* defaults still work */ }

  applyBaseWorld(viewer);
  // Freeze the simulation clock: we pin the time ourselves for permanent
  // daylight, so a ticking clock must never drag the sun into night.
  viewer.clock.shouldAnimate = false;
  mainViewer = viewer;
  return viewer;
}

/**
 * Terrain + imagery. Both are free, keyless, global services:
 *   - Re:Earth quantized-mesh DEM (CC BY 4.0)
 *   - Esri World Imagery tile service
 */
export function applyBaseWorld(viewer) {
  const terrainProvider = new EllipsoidTerrainProvider();
  viewer.terrainProvider = terrainProvider;
  viewer.cesiumTerrainProvider = createTerrainProvider();

  const base = new UrlTemplateImageryProvider({
    url: CONFIG.imagery.fallbackUrl,
    subdomains: CONFIG.imagery.fallbackSubdomains,
    credit: CONFIG.imagery.fallbackAttribution,
    maximumLevel: CONFIG.imagery.fallbackMaximumLevel,
  });
  baseImageryLayer = viewer.imageryLayers.addImageryProvider(base, 0);

  const imagery = withOceanDonor(new UrlTemplateImageryProvider({
    url: CONFIG.imagery.url,
    credit: new URL(CONFIG.imagery.attribution, window.location.href).href,
    maximumLevel: CONFIG.imagery.maximumLevel,
  }));
  const layer = viewer.imageryLayers.addImageryProvider(imagery, 1);
  satelliteImageryLayer = layer;
  layer.maximumLevel = CONFIG.imagery.maximumLevel;
  try { layer.anisotropy = 16; } catch (e) { /* older Cesium */ }

  // Reference overlay (boundaries + place labels, transparent): hidden while
  // flying, shown in the spawn picker over the SATELLITE view so cities and
  // landmarks stay readable like a real map app.
  const reference = new UrlTemplateImageryProvider({
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    maximumLevel: 19,
  });
  referenceLayer = viewer.imageryLayers.addImageryProvider(reference, 2);
  referenceLayer.show = false;

  // ── Quality: LOD, AA and atmosphere ──────────────────────────────────────
  // Tier-scaled values (auto quality): MSAA/cache/upload-pacing differ per
  // device tier; tile DETAIL never does - maximumScreenSpaceError 2 is the
  // realism floor on every device.
  const profile = getQualityProfile();
  viewer.scene.globe.maximumScreenSpaceError = profile.maximumScreenSpaceError;
  // ── Skip-LOD streaming profile (ref-flight's tile-tuning block) ──────────
  // These four numbers are the ones flight.tarmizi.id ships (their `ls`
  // object in the deployed bundle): coarse ancestors are drawn immediately
  // and refined in place, instead of an area staying empty until the detail
  // tiles land. baseScreenSpaceError 2048 + skipScreenSpaceErrorFactor 32
  // (double Cesium's default) lets the skip pass reach much coarser tiles,
  // and skipLevels 2 covers two levels of descent at once.
  viewer.scene.globe.skipLevelOfDetail = true;
  viewer.scene.globe.baseScreenSpaceError = 2048;
  viewer.scene.globe.skipScreenSpaceErrorFactor = 32;
  viewer.scene.globe.skipLevels = 2;

  viewer.scene.globe.tileCacheSize = profile.tileCacheSize;
  // Ancestors STAY on: with skip-LOD they are what draws something at every
  // level immediately, which is the whole coarse-first strategy.
  viewer.scene.globe.preloadAncestors = true;
  // Siblings OFF: it fetches the neighbours of every visible tile — roughly
  // doubling requests — and skip-LOD already guarantees a coarse parent is on
  // screen while a tile's detail arrives, which is what siblings were buying.
  // Measured context: terrain alone is ~63% of this app's tile requests, so
  // halving the per-tile fan-out matters more here than the seam smoothness.
  viewer.scene.globe.preloadSiblings = false;
  // Raised concurrent tile-fetch budget: at 1.8x arcade speed (up to
  // ~8 km/s in boost) the camera outruns the default fetch queue, so more
  // descendants load per frame instead of arriving soft behind the jet.
  viewer.scene.globe.loadingDescendantLimit = profile.loadingDescendantLimit;

  // Water effect stays OFF: with it on, ocean areas whose tiles lack data
  // render as flat grey patches instead of matching the surrounding water.
  // Oceans read consistently from the imagery + base color instead.
  viewer.scene.globe.showWaterEffect = false;
  viewer.scene.globe.depthTestAgainstTerrain = true;
  viewer.scene.globe.enableLighting = true;
  viewer.scene.globe.atmosphereLightIntensity = 10;
  viewer.scene.globe.baseColor = Color.fromCssColorString("#1a3a5c");

  viewer.scene.highDynamicRange = false;
  viewer.scene.postProcessStages.fxaa.enabled = true;
  viewer.scene.msaaSamples = profile.msaaSamples;

  viewer.scene.skyAtmosphere.hueShift = -0.02;
  viewer.scene.skyAtmosphere.saturationShift = -0.08;

  // Aerial haze, at the density flight.tarmizi.id ships (0.001, with the fog
  // colour pinned bright). Cesium scales the density down with camera height
  // (Fog.update: density * heightScalar * (h/maxHeight)^-heightFalloff), so
  // this is ~1.7x Cesium's own default in practice - not a white-out - and it
  // is what swallows the horizon, where freshly streamed tile levels would
  // otherwise pop in over the crisp distance.
  viewer.scene.fog.enabled = true;
  viewer.scene.fog.density = 0.001;
  viewer.scene.fog.minimumBrightness = 1;
  viewer.scene.fog.screenSpaceErrorFactor = 2;

  // A visible sun keeps the aircraft lit and gives terrain real shading.
  // Intensity is driven per-frame-of-day by setSunForTime().
  viewer.scene.light.intensity = 2.1;

  return { imagery: layer, terrain: terrainProvider };
}

/**
 * Re:Earth serves standard Cesium quantized-mesh, which `CesiumTerrainProvider`
 * can consume directly. We deliberately do NOT use `CesiumTerrainProvider.fromUrl`
 * at module scope — it is async and would block first paint.
 */
let terrainProviderPromise = null;
export function createTerrainProvider() {
  if (!terrainProviderPromise) {
    terrainProviderPromise = import("cesium").then(
      async ({ CesiumTerrainProvider }) => {
        const provider = await CesiumTerrainProvider.fromUrl(
          CONFIG.terrain.url,
          {
            requestVertexNormals: true,
            requestWaterMask: false,
          },
        );
        // `credit` on a terrain provider is getter-only in Cesium 1.145, so we
        // leave the provider untouched and rely on the credit container +
        // project.md attribution instead.
        return provider;
      },
    );
  }
  return terrainProviderPromise;
}

/** Install the real DEM once it resolves; the ellipsoid stands in until then. */
export async function attachTerrain(viewer) {
  try {
    const provider = await createTerrainProvider();
    viewer.terrainProvider = provider;
    viewer.cesiumTerrainProvider = provider;
    return provider;
  } catch (error) {
    console.warn(
      "[terrain] Re:Earth DEM unavailable, staying on the smooth ellipsoid:",
      error,
    );
    return null;
  }
}

/** Permanent noon at the aircraft, guaranteed two ways.
 *
 *  Night had two independent causes and the old code fixed neither:
 *  1. Cesium's sky + globe night side follow the simulation CLOCK, not the
 *     light object — so the clock is pinned to solar noon at the aircraft's
 *     longitude on an equinox (daylight on the whole planet at once).
 *  2. Directional shading follows scene.light — parked just off-overhead so
 *     models, buildings and terrain stay lit with relief shading.
 */
export function setSunForTime(viewer, hours, latitude = 45, longitude = 0, date = new Date()) {
  try {
    // Solar noon at this longitude, on the September equinox (sun over the
    // equator: everywhere except the poles is in daylight simultaneously).
    const utcNoon = ((12 - longitude / 15) % 24 + 24) % 24;
    const hh = Math.floor(utcNoon);
    const mm = Math.floor((utcNoon - hh) * 60);
    viewer.clock.currentTime = JulianDate.fromDate(
      new Date(Date.UTC(2026, 8, 22, hh, mm, 0))
    );
    viewer.clock.shouldAnimate = false;

    const surfacePoint = Cartesian3.fromDegrees(longitude, latitude, 0);
    const normal = Cartesian3.normalize(surfacePoint, new Cartesian3());
    // East for the tilt that keeps terrain relief readable.
    const east = Cartesian3.normalize(
      Cartesian3.cross(Cartesian3.UNIT_Z, normal, new Cartesian3()),
      new Cartesian3()
    );
    // Toward-sun vector: mostly overhead, tipped ~25° east.
    const toSun = Cartesian3.normalize(
      Cartesian3.add(
        Cartesian3.multiplyByScalar(normal, 1.0, new Cartesian3()),
        Cartesian3.multiplyByScalar(east, 0.45, new Cartesian3()),
        new Cartesian3()
      ),
      new Cartesian3()
    );
    viewer.scene.light.direction = Cartesian3.negate(toSun, new Cartesian3());
    viewer.scene.light.intensity = 2.2;
    return 0.5;
  } catch (e) {
    viewer.scene.light.intensity = 2.1;
    return 0;
  }
}

export { Cartographic, CesiumMath, CesiumViewer };

// ── Tactical minimap: a second lightweight Cesium viewer ────────────────────
// Same real satellite imagery as the main globe, top-down over the jet. The
// 2D canvas overlay (player wedge, spawn pin, compass labels) draws on top.
let miniViewer = null;
let streetsLayer = null;
let referenceLayer = null;
// The two global imagery layers, kept for the speed-driven detail cap.
let baseImageryLayer = null;
let satelliteImageryLayer = null;

/**
 * Cap how deep the imagery layers may refine. Called by the flight loop with
 * `imageryLevelForSpeed(mph)`: at speed the deep levels cannot arrive in time
 * anyway (see core/detailPolicy.js), so asking for them is what produces
 * detail visibly popping in under the jet. Only assigned when the level
 * actually changes — each assignment makes Cesium re-evaluate the whole LOD.
 */
export function setImageryLevelCap(level) {
  try {
    if (satelliteImageryLayer) satelliteImageryLayer.maximumLevel = level;
    // The street-map base underneath follows: it fills gaps the satellite
    // layer has no data for, so leaving it deeper only costs requests.
    if (baseImageryLayer) baseImageryLayer.maximumLevel = level;
  } catch (e) { /* imagery LOD is best-effort */ }
}

/** Reference-labels overlay for the spawn picker (satellite stays visible). */
export function setStreetsVisible(show) {
  try {
    if (referenceLayer) referenceLayer.show = !!show;
  } catch (e) { /* cosmetic */ }
}
/** The minimap never refines past this level: cheap tiles that always arrive. */
const MINIMAP_MAX_LEVEL = 15;

export function initMiniViewer(containerId) {
  if (miniViewer) return miniViewer;
  try {
    miniViewer = new Viewer(containerId, {
      terrainProvider: new EllipsoidTerrainProvider(),
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      vrButton: false,
      infoBox: false,
      selectionIndicator: false,
      baseLayer: false,
      // A map, not a 3D scene: MSAA on a thumbnail is pure waste (it costs a
      // full multi-sample resolve per frame for edges nobody studies).
      msaaSamples: 0,
      // Rendered MANUALLY from setMinimapCamera (called every frame while
      // flying). With the internal loop on, this hidden-during-boot viewer
      // burned a full render every frame from page load.
      useDefaultRenderLoop: false,
      skyBox: false,
      contextOptions: {
        webgl: { powerPreference: "low-power" },
      },
    });
    miniViewer.scene.skyAtmosphere.show = false;
    miniViewer.scene.fog.enabled = false;
    miniViewer.scene.globe.enableLighting = false;
    miniViewer.scene.highDynamicRange = false;
    // REALISTIC DETAIL on the small canvas: screen-space error shrinks with
    // viewport height, so a 200px map needs a finer SSE than the main globe
    // (SSE 2) to resolve comparable imagery detail - SSE 1 doubles the
    // effective tile detail, and native-DPR rendering kills the blur on
    // HiDPI phones. A handful of tiles at this size, so the cost is tiny.
    miniViewer.scene.globe.maximumScreenSpaceError = 1;
    miniViewer.scene.globe.tileCacheSize = 400;
    try {
      // Full device-pixel rendering (no browser-recommended downscale) —
      // this alone un-blurs the map on HiDPI phones.
      miniViewer.useBrowserRecommendedResolution = false;
    } catch (e) { /* older Cesium */ }
    try {
      miniViewer.scene.postProcessStages.fxaa.enabled = false;
    } catch (e) { /* older Cesium */ }

    const base = new UrlTemplateImageryProvider({
      url: CONFIG.imagery.fallbackUrl,
      subdomains: CONFIG.imagery.fallbackSubdomains,
      credit: CONFIG.imagery.fallbackAttribution,
      maximumLevel: CONFIG.imagery.fallbackMaximumLevel,
    });
    const miniBase = miniViewer.imageryLayers.addImageryProvider(base, 0);
    const imagery = withOceanDonor(new UrlTemplateImageryProvider({
      url: CONFIG.imagery.url,
      maximumLevel: CONFIG.imagery.maximumLevel,
    }));
    const miniSat = miniViewer.imageryLayers.addImageryProvider(imagery, 1);
    // A thumbnail asks only for cheap levels. The minimap's tiles are the
    // lowest-priority requests in the app (they share the imagery host with
    // the main globe, and the main globe is what the player is looking at), so
    // at level 19 the map could sit empty waiting for a fetch the jet had
    // already outrun. Level 15 is 610 m tiles: soft at the tightest zoom,
    // always there.
    try {
      miniBase.maximumLevel = MINIMAP_MAX_LEVEL;
      miniSat.maximumLevel = MINIMAP_MAX_LEVEL;
    } catch (e) { /* imagery LOD is best-effort */ }

    const ctrl = miniViewer.scene.screenSpaceCameraController;
    ctrl.enableRotate = false;
    ctrl.enableTranslate = false;
    ctrl.enableZoom = false;
    ctrl.enableTilt = false;
    ctrl.enableLook = false;
    try {
      miniViewer.cesiumWidget.creditContainer.style.display = "none";
    } catch (e) { /* credit DOM varies by version */ }
  } catch (e) {
    console.warn("[minimap] Mini viewer unavailable, overlay still works:", e);
    miniViewer = null;
  }
  return miniViewer;
}

export function getMiniViewer() {
  return miniViewer;
}

// A second full globe render every frame was the most expensive thing in the
// HUD: same scene graph, same tile pyramid, same fill as the main view, spent
// on a map 150 px wide. A map does not need 60 Hz — the cap keeps it fluid
// while cutting that cost to a fraction, and tile streaming is unaffected.
const MINIMAP_MIN_RENDER_MS = 100; // 10 Hz
let minimapLastRender = 0;

/** Top-down minimap camera tracking the aircraft. Renders the mini viewer
 *  manually — only called from the flying states, so the minimap costs
 *  nothing while the boot page, menu, or picker are up. */
export function setMinimapCamera(lon, lat, altitude, heading, force = false) {
  if (!miniViewer) return;
  try {
    // clientWidth (layout size) is 0 whenever the HUD is display:none -
    // boot, menu, picker, crash menu - so the render is skipped exactly
    // when the minimap can't be seen.
    if (miniViewer.canvas.clientWidth === 0 || miniViewer.canvas.clientHeight === 0) return;
    const now = performance.now();
    if (!force && now - minimapLastRender < MINIMAP_MIN_RENDER_MS) return;
    minimapLastRender = now;
    miniViewer.camera.setView({
      destination: Cartesian3.fromDegrees(lon, lat, altitude),
      orientation: {
        heading: CesiumMath.toRadians(heading || 0),
        pitch: CesiumMath.toRadians(-90),
        roll: 0,
      },
    });
    miniViewer.render();
  } catch (e) { /* minimap is cosmetic */ }
}
