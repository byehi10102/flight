import {
  Viewer,
  EllipsoidTerrainProvider,
  UrlTemplateImageryProvider,
  Cartographic,
  Cartesian3,
  Color,
  Math as CesiumMath,
  Viewer as CesiumViewer,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { CONFIG } from "./config.js";

/**
 * Build the smallest runnable viewer first: one keyless terrain provider and
 * one keyless imagery provider, no token anywhere. Everything else in the app
 * layers on top of this.
 */
export function createViewer(container) {
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
    // A continuously moving aircraft means continuous frames; request-render
    // mode would fight the sim loop, so we render every frame.
    requestRenderMode: false,
    // 4x MSAA on the default framebuffer keeps building edges from crawling.
    msaaSamples: 4,
    contextOptions: {
      webgl: { preserveDrawingBuffer: true, powerPreference: "high-performance" },
    },
  });

  applyBaseWorld(viewer);
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
  viewer.imageryLayers.addImageryProvider(base, 0);

  const imagery = new UrlTemplateImageryProvider({
    url: CONFIG.imagery.url,
    credit: new URL(CONFIG.imagery.attribution, window.location.href).href,
    maximumLevel: CONFIG.imagery.maximumLevel,
  });
  const layer = viewer.imageryLayers.addImageryProvider(imagery, 1);
  layer.maximumLevel = CONFIG.imagery.maximumLevel;
  try { layer.anisotropy = 16; } catch (e) { /* older Cesium */ }

  // ── Quality: LOD, AA and atmosphere ──────────────────────────────────────
  viewer.scene.globe.maximumScreenSpaceError = 2;
  viewer.scene.globe.skipLevelOfDetail = true;
  viewer.scene.globe.baseScreenSpaceError = 1024;
  viewer.scene.globe.skipScreenSpaceErrorFactor = 16;
  viewer.scene.globe.skipLevels = 1;

  viewer.scene.globe.tileCacheSize = 2048;
  viewer.scene.globe.preloadAncestors = true;
  viewer.scene.globe.preloadSiblings = true;
  viewer.scene.globe.loadingDescendantLimit = 20;

  viewer.scene.globe.showWaterEffect = true;
  viewer.scene.globe.depthTestAgainstTerrain = true;
  viewer.scene.globe.enableLighting = true;
  viewer.scene.globe.atmosphereLightIntensity = 10;
  viewer.scene.globe.baseColor = Color.fromCssColorString("#1a3a5c");

  viewer.scene.highDynamicRange = false;
  viewer.scene.postProcessStages.fxaa.enabled = true;
  viewer.scene.msaaSamples = 4;

  viewer.scene.skyAtmosphere.hueShift = -0.02;
  viewer.scene.skyAtmosphere.saturationShift = -0.08;

  viewer.scene.fog.enabled = true;
  viewer.scene.fog.density = 0.0001;

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

/** Permanent noon at the aircraft: parks the sun just off-overhead so every
 *  part of the globe renders in daylight with relief shading. The old version
 *  only changed brightness — Cesium's light direction stayed fixed, so half
 *  the planet still rendered night. */
export function setSunForTime(viewer, hours, latitude = 45, longitude = 0, date = new Date()) {
  try {
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
