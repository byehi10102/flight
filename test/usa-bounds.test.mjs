import { test } from "node:test";
import assert from "node:assert/strict";
import { insideUSA, USA_BOUNDS } from "../src/utils/geo.js";

test("USA_BOUNDS is a sane continental-US box", () => {
  assert.ok(USA_BOUNDS.west < USA_BOUNDS.east);
  assert.ok(USA_BOUNDS.south < USA_BOUNDS.north);
  assert.ok(USA_BOUNDS.west < -60 && USA_BOUNDS.west > -130);
  assert.ok(USA_BOUNDS.east > -75 && USA_BOUNDS.east < -60);
  assert.ok(USA_BOUNDS.south > 20 && USA_BOUNDS.south < 30);
  assert.ok(USA_BOUNDS.north > 45 && USA_BOUNDS.north < 55);
});

test("Anaheim (the default spawn) is inside", () => {
  assert.equal(insideUSA(-117.9143, 33.8366), true);
});

test("US landmarks are inside", () => {
  assert.equal(insideUSA(-77.0365, 38.8977), true); // White House
  assert.equal(insideUSA(-122.4783, 37.8199), true); // Golden Gate
  assert.equal(insideUSA(-112.1129, 36.1069), true); // Grand Canyon
  assert.equal(insideUSA(-103.4591, 43.8791), true); // Mount Rushmore
});

test("foreign landmarks are outside — flying is USA-only", () => {
  assert.equal(insideUSA(2.2945, 48.8584), false); // Eiffel Tower
  assert.equal(insideUSA(151.2153, -33.8568), false); // Sydney Opera
  assert.equal(insideUSA(78.0421, 27.1751), false); // Taj Mahal
  assert.equal(insideUSA(138.7274, 35.3606), false); // Mt Fuji
  assert.equal(insideUSA(-0.1246, 51.5007), false); // Big Ben
});

test("oceans far off the coast are outside", () => {
  assert.equal(insideUSA(-140, 33), false); // far Pacific
  assert.equal(insideUSA(-60, 40), false); // mid-Atlantic
});

test("garbage coordinates are outside, never NaN/throw", () => {
  assert.equal(insideUSA(NaN, 33), false);
  assert.equal(insideUSA(-117, NaN), false);
  assert.equal(insideUSA(null, undefined), false);
});
