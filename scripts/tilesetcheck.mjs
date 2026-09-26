/** Verify the Re:Earth 3D Tiles layer loads (or the OSM fallback is active).

 * Launches the built preview, waits for SKYWARD to be ready, and checks whether
 * the 3D Tiles tileset is present in the scene primitives. If the tileset did
 * not load, verifies that the OSM extrusion layer has buildings instead.
 */

import puppeteer from "puppeteer";

const BASE = process.env.FLIGHT_BASE_URL || "http://127.0.0.1:4173";

async function main() {
  const browser = await puppeteer.connect({
    browserURL: process.env.FLIGHT_CDP_URL || `http://127.0.0.1:9222`,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  // Wait for SKYWARD to be ready.
  await page.waitForFunction(
    () => window.SKYWARD && window.SKYWARD.viewer,
    { timeout: 30000 },
  );

  const result = await page.evaluate(() => {
    const sky = window.SKYWARD;
    const b3d = sky.buildings3d;
    const bOsb = sky.buildings;

    // Count primitives in the scene — Cesium primitives collection is not
    // directly iterable from the page either, so enumerate via indices.
    const primitives = sky.viewer.scene.primitives;
    let tileCount = 0;
    try {
      // CesiumPrimitive with a Cesium3DTileset will have a tileset property.
      for (let i = 0; i < primitives.length; i++) {
        const p = primitives.get(i);
        if (p && p.tileset) tileCount++;
      }
    } catch {
      // Fallback: just report what we can.
    }

    return {
      tilesLoaded: !!b3d && b3d.loaded,
      tileError: !!b3d && b3d.error ? b3d.error.message : null,
      tilePrimitives: tileCount,
      osmBuildings: !!(bOsb && bOsb.buildingCount),
      osmEnabled: !!(bOsb && bOsb.enabled),
      errors: errors.filter((e) => !e.includes("favicon")),
    };
  });

  await browser.close();

  console.log(JSON.stringify(result, null, 2));

  if (result.errors.length) {
    console.error("[tilesetcheck] console errors:", result.errors);
  }

  if (result.tilesLoaded) {
    console.log("[tilesetcheck] PASS — Re:Earth 3D Tiles loaded, " +
      result.tilePrimitives + " tile primitive(s) in scene");
    process.exit(0);
  } else if (result.tileError) {
    console.log("[tilesetcheck] FAIL — 3D Tiles error: " + result.tileError);
    process.exit(1);
  } else {
    console.log("[tilesetcheck] FAIL — 3D Tiles did not load, " +
      "and OSM fallback has " + (result.osmBuildings ? result.osmBuildings + " buildings" : "no buildings"));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("[tilesetcheck] failed:", error.message);
  process.exit(1);
});
