/**
 * Load instrumentation: the tile-URL classifier (pure) and the stage/request
 * recorder. The classifier is what makes a request split trustworthy — if it
 * mis-reads a URL as a tile, or misses one, the "where does the time go"
 * answer is wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTileUrl, createLoadTrace } from "../src/core/loadTrace.js";

test("an Esri imagery URL reports its host and level", () => {
  const info = classifyTileUrl(
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/16/27652/11405",
  );
  assert.equal(info.level, 16);
  assert.equal(info.host, "services.arcgisonline.com");
});

test("a Re:Earth terrain URL reports its level through the extension and query", () => {
  const info = classifyTileUrl(
    "https://terrain.reearth.land/cesium-mesh/ellipsoid/14/2776/6592.terrain?v=1.0.0",
  );
  assert.equal(info.level, 14);
  assert.equal(info.host, "terrain.reearth.land");
});

test("non-tile URLs are not counted as tiles", () => {
  assert.equal(classifyTileUrl("https://example.com/tileset.json"), null);
  assert.equal(classifyTileUrl("https://example.com/sounds/boost.mp3"), null);
  assert.equal(classifyTileUrl("https://example.com/api/2026/10/21/data"), null);
  assert.equal(classifyTileUrl(""), null);
  assert.equal(classifyTileUrl(undefined), null);
});

test("marks record the first time a stage is reached, in ms from the start", () => {
  let t = 1000;
  const trace = createLoadTrace(() => t);
  t = 1500;
  assert.equal(trace.mark("model"), 500);
  t = 2000;
  assert.equal(trace.mark("audio"), 1000);
  // Re-reaching a stage is not a new stage (a retry must not rewrite history).
  t = 9000;
  assert.equal(trace.mark("model"), 500);
});

test("request counts accumulate per host and per level", () => {
  const trace = createLoadTrace(() => 0);
  trace.countTile("services.arcgisonline.com", 16);
  trace.countTile("services.arcgisonline.com", 16);
  trace.countTile("services.arcgisonline.com", 19);
  trace.countTile("terrain.reearth.land", 12);
  const r = trace.report();
  assert.equal(r.tiles, 4);
  assert.equal(r.hosts["services.arcgisonline.com"], 3);
  assert.equal(r.hosts["terrain.reearth.land"], 1);
  assert.equal(r.levels["16"], 2);
  assert.equal(r.levels["19"], 1);
  assert.equal(r.levels["12"], 1);
});
