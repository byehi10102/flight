import {
  Viewer,
  EllipsoidTerrainProvider,
  UrlTemplateImageryProvider,
  Cartographic,
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

  const imagery = new UrlTemplateImageryProvider({
    url: CONFIG.imagery.url,
    credit: new URL(CONFIG.imagery.attribution, window.location.href).href,
    maximumLevel: CONFIG.imagery.maximumLevel,
  });
  const layer = viewer.imageryLayers.addImageryProvider(imagery, 0);
  layer.maximumLevel = CONFIG.imagery.maximumLevel;

  viewer.scene.globe.baseColor = "#0b1622";
  viewer.scene.globe.depthTestAgainstTerrain = true;
  viewer.scene.globe.showWaterEffect = true;
  viewer.scene.globe.enableLighting = true;
  viewer.scene.globe.atmosphereLightIntensity = 14;
  viewer.scene.globe.maximumScreenSpaceError = 1.6;
  viewer.scene.skyAtmosphere.hueShift = -0.02;
  viewer.scene.skyAtmosphere.saturationShift = -0.08;
  viewer.scene.fog.enabled = true;
  viewer.scene.fog.density = 0.00022;
  viewer.scene.highDynamicRange = true;
  viewer.scene.msaaSamples = 4;

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

/** Sun position driven by a single "hour of day" scalar, 0–24. */
export function setSunForTime(viewer, hours) {
  const dayFraction = ((hours % 24) + 24) % 24 / 24;
  // Approximate solar declination for a mid-latitude summer day.
  const declination = 0.409;
  const hourAngle = CesiumMath.toRadians(dayFraction * 2 * Math.PI - Math.PI);
  const latitude = CesiumMath.toRadians(45);
  const altitude = Math.asin(
    Math.sin(declination) * Math.sin(latitude) +
      Math.cos(declination) * Math.cos(latitude) * Math.cos(hourAngle),
  );
  if (altitude <= 0.02) {
    // Below the horizon — dial the sun right down instead of letting it
    // light the terrain from underneath.
    viewer.scene.light.intensity = 0.05;
    return altitude;
  }
  viewer.scene.light.intensity = 0.35 + 2.2 * Math.sin(altitude);
  return altitude;
}

export { Cartographic, CesiumMath, CesiumViewer };
