# Skyward

**An open flight simulator on a real 3D Earth.** Real terrain, real 3D
buildings, real runways, anywhere on the planet — with **no API keys, no
accounts, no sign-up, and nothing to install**.

This document is the project's living design record. It describes what the
game is, what it is built from, how it is put together, what it looks like,
and **every change made to the project**, with the reasoning behind it. It
grows alongside the code.

---

## 1. What this is

You spawn on the threshold of a real runway at a real airport. You hold `W`
and the aircraft accelerates, rotates and lifts off. You climb over the city,
over the mountains, over the ocean. Anywhere on Earth is flyable. The
buildings are the buildings that are actually there, at their real heights.

**The whole point is that nothing is invented.** There is no procedural city
generator, no "randomly plausible" terrain, no asset pack of invented
skyline. Every feature in the world is real-world data, streamed on demand.

### Design pillars

| Pillar | Meaning |
|---|---|
| **Real or absent** | A building is drawn only if OpenStreetMap has a real footprint and height. Where the data is missing, nothing is drawn. Nothing is faked. |
| **Zero credentials** | Not "free tier". No key, no token, no account, no billing. The project works on a clean machine with only a network connection. |
| **Open flight** | No campaign, no gates, no unlocks. Search any place, jump, fly. |
| **Realistic feel** | A fixed-timestep flight model with lift, drag, coordinated turns, a load limit and a stall. Controls that ramp rather than snap. |
| **Streaming, not bundling** | The repository contains no terrain and no city geometry. 3D data is fetched as you fly, so the world is global but the download is small. |

---

## 2. Why keyless, and what that costs

The obvious way to get photoreal 3D cities is Google Photorealistic 3D Tiles.
That requires a Google Maps API key with billing enabled. The brief for this
project was explicitly **no API key of any kind**, so that path is out.

Here is what replaces it, and the honest trade-off:

| Layer | Keyless source | What you get | What you lose vs. Google |
|---|---|---|---|
| **Buildings** | OpenFreeMap vector tiles (`building` layer) | Real OSM footprints, real `render_height`, correct plan shapes | Plain untextured facades. No photogrammetric colour or window detail. |
| **Terrain** | Re:Earth / Mapterhorn quantized-mesh DEM (CC BY 4.0) | Real global elevation, vertex normals, to z14 | 90 m-class resolution, so fine terrain detail is smoothed. |
| **Surface cover** | Esri World Imagery | Real satellite imagery — forests, fields, water, roads are all genuinely there | Imagery only; vegetation and rock are painted, not modelled. |
| **Airports** | OurAirports (public domain) | Real thresholds, true bearings, lengths, widths, surfaces | No terminals, towers or taxiway detail. |
| **Aircraft** | NASA 3D Resources (public domain) | A real Global Hawk model | — |

**Mountains are real height from a real DEM, textured with real satellite
imagery, lit by a real sun position.** That is a genuine 3D landscape. It is
*not* the same as a photogrammetric capture of a rock face, and this document
will not pretend otherwise. What Skyward gets right is the shape, the scale,
the surface cover and the buildings on the ground — which is what actually
makes a world feel real when you fly over it.

---

## 3. Architecture

Vanilla ES modules + Vite + CesiumJS. No framework: the app is one render
loop and a handful of systems, and a component tree would only add indirection
between the keyboard and the physics.

```
skyward/
├── index.html
├── vite.config.js
├── public/
│   ├── data/airports.json        10 334 airports, 14 234 runways (generated)
│   ├── models/hawk.glb            NASA Global Hawk, public domain
│   └── favicon.svg
├── scripts/
│   ├── build-airports.mjs         OurAirports CSV -> compact JSON
│   ├── acceptance.mjs             drives the real keyboard, asserts the controls
│   ├── measure.mjs                counts real buildings/geometry in the scene
│   └── recover.mjs                proves the render loop survives a bad frame
└── src/
    ├── main.js                    wiring, fixed-timestep loop, render boundary
    ├── core/
    │   ├── config.js              every tunable in the project
    │   ├── viewer.js              Cesium viewer, terrain, imagery, sun
    │   ├── ground.js              accurate elevation sampler + cache
    │   └── airports.js            airport index, spatial grid, runway spawn
    ├── world/
    │   ├── buildings.js           OpenFreeMap tiles -> extruded 3D buildings
    │   └── runways.js             OurAirports -> terrain-draped 3D runways
    ├── flight/
    │   ├── physics.js             the flight model
    │   ├── controls.js            keyboard -> ramped axes + altitude hold
    │   ├── camera.js              third-person chase camera
    │   └── aircraft.js            GLB placement and orientation
    └── ui/
        ├── hud.js                 instruments
        ├── location.js            search, airport jump, presets
        └── style.css
```

---

## 4. The world, layer by layer

All four layers live in the same WGS84 coordinate space, so they register with
each other without any glue or offsets.

### 4.1 Terrain — `src/core/viewer.js`

Re:Earth serves standard Cesium quantized-mesh, consumed directly by
`CesiumTerrainProvider`. It is ellipsoidal (EGM2008 blended), so heights need
no geoid correction.

The viewer boots on the smooth ellipsoid and swaps in the real DEM when the
provider resolves. Waiting for terrain before the first paint would mean a
blank page; this way there is a globe in frame immediately.

### 4.2 Accurate elevation — `src/core/ground.js`

`globe.getHeight()` answers *"how high is the terrain of the tile that happens
to be resident"*. Near the ground that is exact. From altitude, Cesium holds
only a coarse z0–z2 tile and `getHeight` returns a bilinear interpolation
between vertices hundreds of kilometres apart — it reported **−5 931 m at the
summit of Everest**, because every loaded vertex nearby was lowland.

So anything that must be geometrically correct reads through
`sampleTerrainMostDetailed` instead, cached on a ~110 m grid. Measured
against the raw API:

| Location | `GroundSampler` | `globe.getHeight` | Published |
|---|---|---|---|
| Everest summit | **8 685 m** | 3 621 m | ~8 885 m |
| Death Valley | **−111 m** | 910 m | ~−86 m |
| Mt Fuji | **3 811 m** | 331 m | ~3 776 m |
| Manhattan | **−11 m** | −44 m | ~45 m |
| Seattle-Tacoma | **97 m** | 12 m | ~132 m (orthometric) |

The residual differences are expected: the DEM is ellipsoidal while the
"published" column is orthometric, and a single sample point is not the exact
summit. The important result is that the sampler is within tens of metres
everywhere, while the resident-tile value is off by kilometres.

This matters for three things: where the aircraft sits, where a building's base
is, and when the wheels touch ground.

### 4.3 Buildings — `src/world/buildings.js`

OpenFreeMap serves OpenMapTiles-schema vector tiles with no key. Its `building`
layer carries a real `render_height` per footprint, derived from OSM `height`
or `building:levels`.

Streaming policy, measured against the live tile set:

- **z14 is the maximum published level.** Every z15 request returns an empty
  body. Survey results: Midtown Manhattan 1 488 footprints (all with heights),
  Lower Manhattan 1 421, Seattle downtown 525, Chicago 259, SF 190.
- A 7×7 grid of z14 city tiles is ~30 MB, so tiles are requested **two at a
  time with a 450 ms gap**. OpenFreeMap is a free public service and returns
  HTTP 429 if pulled harder; a 429 backs off 8 s and doubles the gap, and the
  tile is retried rather than being marked empty.
- Tiles that resolve to *no buildings* are negatively cached, so flying over
  open country costs nothing instead of re-fetching an empty tile forever.

Each footprint becomes one `PolygonGeometry` extruded from `render_min_height`
to `render_height`; all footprints in a tile go into a single `Primitive`, so
Cesium batches them into one draw call. Facade colour uses the OSM `colour`
tag when present, otherwise a plausible tone derived from the building's own
type and height, so a skyline reads as a skyline.

**Measured in the running game:** 12 856 real buildings instantiated over
Lower Manhattan, 14 212 over the Chicago Loop, 15 598 over Sydney CBD.

### 4.4 Runways — `src/world/runways.js`

Every runway rectangle is built from its OurAirports record: the two threshold
coordinates, the true bearing, the length and the width, so a runway is at the
real position, on the real bearing, at the real size.

Runways use **`GroundPolylineGeometry`**, not `PolygonGeometry`. This is the
important decision in the whole file. A `PolygonGeometry` is defined in
*absolute ellipsoid height*; Seattle-Tacoma sits at ~130 m, so a rectangle
placed at height 0.6 is buried 130 m underground — invisible under
`depthTestAgainstTerrain`, with degenerate bounds. `GroundPolylineGeometry` is
*defined* as conforming to the terrain, so a runway follows hills, sits on the
real surface, and needs no elevation lookup at all. A runway is also a thick
polyline down the centreline, plus threshold bars at each end — which is
exactly how it is painted in reality.

Airports within 80 km are drawn and built once; airports that fall out of
range are **evicted**, because `GroundPolylineGeometry` bounds are resolved
against the terrain tiles resident when the primitive was created, and stale
ground primitives outliving their terrain are a real failure mode (§7).

### 4.5 Imagery and atmosphere

Esri World Imagery draped over the DEM, with globe lighting, a sky atmosphere
tuned slightly cool, distance fog, and a time-of-day slider that drives the
sun's altitude and intensity — at night the sun is dimmed to 0.05 rather than
lighting the terrain from underneath.

This is where oceans, forests, plains and farmland come from: they are not
modelled, they are **real surface cover in real satellite imagery**. The ocean
is the globe's own ellipsoid under imagery; forests are actual forest in the
photography.

---

## 5. Controls

Implemented exactly as specified. Every control is **hold-to-act**; a key press
never sets a value, it moves a *target* that a separate axis ramps toward at a
finite rate, and releases ramp back.

| | Ground | Air |
|---|---|---|
| `W` | accelerate (throttle up) | accelerate |
| `S` | brakes | — |
| `A` / `D` | steer | bank left / right |
| `←` / `→` | — | bank left / right |
| `↑` | — | nose up |
| `↓` | — | nose down |

**Auto-level.** Release `↑`/`↓` and the plane flies level and parallel to the
ground. The pitch axis ramps to neutral, then a PD controller latches the
current altitude as a target and trims pitch to null both the altitude error
and the vertical speed (`holdGainP`, `holdGainD`, clamped to ±0.09 rad). Release
`A`/`D` and bank decays to wings-level at `bankLevelRate`.

Other keys: `P` pause · `C` clean view · `H` hide UI.

**Verified end to end** (`scripts/acceptance.mjs`, real GPU, real keystrokes):
16/16 checks pass — spawn on a real runway, `W` accelerates, rotation speed
reached, lift-off, throttle winds down, pitch auto-levels, altitude holds,
`D` banks right and turns right, bank auto-levels, `↑` climbs, `↓` descends,
`←` turns left, `→` turns right.

---

## 6. The flight model — `src/flight/physics.js`

A light twin, 5 100 kg, 39 m² wing. Physics runs on a **fixed 120 Hz
accumulator** independent of frame rate, so controls feel identical at 30, 60
and 144 fps. All tuning lives in `src/core/config.js`.

- **Ground:** thrust minus rolling friction and aerodynamic drag. Lift exceeds
  weight above `rotationSpeed` (24 m/s), which is the liftoff gate.
- **Air:** lift from `CL = CL0 + CLα·α` with a soft stall past `CLmax`; drag
  grows with stall factor; thrust tapers with altitude; the coordinated-turn
  relation `ψ̇ = g·tan(φ)/v` converts bank into heading change, so rolling
  without yawing still turns you.
- **Load limit:** lift is capped at 3 g. Without it a hard pull at 140 m/s
  generates ~15 g (since `CLmax·q·S` scales with v²), which pinned vertical
  speed at its clamp and made the aircraft teleport skyward.
- **Vertical speed** is capped at ±25 m/s (~4 900 ft/min), a rate a jet
  airframe can actually sustain.
- Terrain contact, a 12 500 m service ceiling, and longitude wrap-around so
  long flights do not lose float precision.

---

## 7. Change log

Every change to the project, and why. Newest last.

### Phase 1 — scaffolding and data
1. **Vite + CesiumJS project**, vanilla ES modules, `vite-plugin-cesium` for
   asset paths. No framework.
2. **Verified all data sources are keyless** before writing the renderer:
   Re:Earth terrain, Esri imagery, OpenFreeMap tiles, OurAirports, Photon
   geocoder, NASA 3D models.
3. **Preprocessed OurAirports** into `public/data/airports.json` —
   10 334 airports with real runway geometry, 3.05 MiB, generated by
   `scripts/build-airports.mjs` so the browser never parses 130k lines of CSV.
4. **Wrote `project.md`** and committed to keeping it in step with the code.

### Phase 2 — world rendering, and the bugs that shaped it
5. **`ColorGeometryInstanceAttribute` is mandatory.** Cesium 1.145 no longer
   auto-converts a raw `Color` in `GeometryInstance.attributes.color`; passing
   one throws inside the render loop. Found by bisecting nine variants in the
   browser. Every building and runway instance now wraps its colour.
6. **`baseLayer: false` on the viewer.** Without it Cesium injects its default
   ion base layer, which has no token here, fails to resolve, and leaves a
   broken shader program in the render loop.
7. **`Transforms.headingPitchRollQuaternion` + `Matrix4.fromRotationTranslation`
   produces an all-zero rotation block.** The quaternion is already expressed in
   the fixed frame, so composing it with the translation again wipes the
   rotation out and every body offset collapses onto the position vector. The
   camera's position and look-at point became identical, `normalize(look - pos)`
   evaluated 0/0, `camera.direction` became NaN, and Cesium's command culling
   aborted the entire render with `RangeError: Failed to set the 'length'
   property on 'Array'`. Replaced with `Transforms.headingPitchRollToFixedFrame`
   in both the chase camera and the aircraft model.
8. **`GroundPolylineGeometry.granularity` is radians, not a tile count.**
   Passing `6` was treated as ~6 rad of arc and generated a degenerate,
   uncompilable fragment shader. Set to `0.12` rad.
9. **Runways moved from `PolygonGeometry` to `GroundPolylineGeometry`** — see
   §4.4. The original placement buried every runway under the terrain.
10. **Buildings moved to terrain-relative placement** with a one-per-tile
    `sampleTerrainMostDetailed` call, so towers sit on the ground instead of at
    ellipsoid zero. Added a 6 s timeout, because a DEM provider that never
    settles would otherwise hold one of the four load slots forever.
11. **Tile-grid maths corrected.** The degrees-to-tile conversion multiplied by
    the raw tile count `n` instead of `n/360`, making the grid 360× too wide:
    the streamer requested tiles in northern Canada while the aircraft sat in
    Seattle. Round-trip is now exact to 0.00e+0 across six cities.
12. **`@mapbox/vector-tile` v2 returns `{x, y}` objects, not `[x, y]` arrays.**
    Destructuring them as arrays produced `undefined` coordinates, so every
    footprint failed validation and tiles silently yielded **zero** buildings.
    `pointToXY` now accepts either shape.
13. **`tileToLonLat` rewritten as the exact algebraic inverse** of the
    tile-picking formula. The previous version was dimensionally wrong and
    returned longitudes in the tens of thousands of degrees, which the sanity
    check then rejected — again zero buildings, silently.
14. **Max zoom is 14, not 15.** Surveyed the live tile set: every z15 request
    returns an empty body while z14 city tiles carry 190–1 488 footprints.
    Requesting z15 was pure waste.
15. **Negative tile cache** so empty rural tiles are not re-fetched every
    cadence, and **runway eviction** so the layer does not accumulate
    terrain-conforming primitives forever.
16. **Rate-limit handling** — two tiles in flight, 450 ms apart, 8 s backoff on
    HTTP 429 with the gap doubling. Rate-limited tiles are retried, never marked
    empty.
17. **Degenerate-geometry guards** in both world layers: non-finite and
    out-of-range coordinates, zero-length runways, zero-area building rings. A
    single collapsed footprint in a 1 500-building tile produces a NaN bounding
    radius and takes down every frame on screen.

### Phase 3 — aircraft and world placement
18. **Aircraft placement** on a real runway via `spawnOnRunway`. Fixed an
    operator-precedence bug — `runway.lon + runway.endLon / 2` divided first and
    put the spawn at longitude **−61°**, in the mid-Atlantic.
19. **`GroundSampler`** added (§4.2) and wired into aircraft placement, ground
    contact and the look-ahead feed. Before it, an aircraft at Seattle-Tacoma
    snapped to sea level while the DEM tile was still loading, burying it ~130 m
    underground; and free flight over Manhattan inherited Seattle's elevation as
    its fallback.
20. **Free flight starts in trimmed equilibrium** — 95 m/s with 4 mrad of
    commanded pitch, matching the speed at which lift balances weight for this
    airframe. Entering at an arbitrary 55 m/s put the aircraft below stall, so
    it sank into the ground within seconds and the feature looked broken.
21. **Ground thrust was missing entirely.** The ground branch modelled only
    drag, so the throttle wound all the way to 1.0 while the aircraft never
    moved: `speed=0, throttle=0.64` after nine seconds of held `W`.
22. **Chase camera double-translation removed.**
    `headingPitchRollToFixedFrame` already includes the origin translation, so
    adding `position` again put the camera at *twice Earth's radius* — a
    continental globe view with the aeroplane a speck. Camera now sits 35.2 m
    behind the aircraft, as designed.
23. **Camera basis hardened.** Non-finite position or direction falls back to a
    plain local-level basis, and `Cartographic.fromCartesian` (which returns
    `undefined` at the Earth's centre) is guarded.
24. **Control signs corrected.** `D` banked *left*. The physics integrates
    heading as `heading += g·tan(roll)/v·dt`, so positive roll must mean a right
    turn; the axis target was reversed. The most obvious possible control bug,
    found by the acceptance test.
25. **Removed the speed-scaled vertical fudge factor.** `verticalAccel` was
    multiplied by `max(0.5, speed/40)`, up to 3.5×, turning ordinary inputs into
    a rocket. Now one metre per second squared per newton of excess lift.
26. **Render loop taken under our control with an error boundary.** Cesium's
    default loop calls `render()` from inside a timer with no error boundary, so
    a single bad frame permanently stops rendering and freezes the screen. We
    now set `useDefaultRenderLoop = false` and call `renderSafely()`, which on
    failure resets the camera and sheds the terrain-conforming runway layer,
    then the streamed buildings, and lets the world rebuild. Verified: after the
    failure the canvas checksum keeps changing, buildings keep streaming to
    12 800, and the camera keeps tracking.
27. **Diagnostics + verification harness.** `scripts/acceptance.mjs` (16
    control assertions on the real GPU), `scripts/measure.mjs` (counts real
    geometry rather than judging a screenshot), `scripts/recover.mjs` (proves
    the render loop survives). Favouring measured numbers over screenshots was
    the right call — the vision model misread these frames repeatedly, calling a
    close third-person view a "2D top-down map".
28. **Takeoff clearance added.** The aircraft is parked at exactly
    `groundHeight + 0.8` and the contact test is `<= groundHeight + 0.8`. So
    releasing it without moving it up re-pinned `onGround` on the very same
    physics step; the airborne branch never ran, vertical speed never built,
    and takeoff depended on float rounding winning a race. It now releases with
    a decisive 2.5 m of clearance. Caught by the acceptance test only after the
    test dwells were shortened — a longer test had been passing on timing
    luck.

---

## 8. Running it

```bash
npm install
npm run dev        # http://127.0.0.1:5173
```

```bash
npm run build && npm run preview    # production build
node scripts/acceptance.mjs          # verify the controls
node scripts/measure.mjs             # count real buildings in the scene
```

Requires only a network connection. First load streams a few MB; after that the
world streams as you fly.

---

## 9. Attribution

- **Terrain** — [Re:Earth Terrain](https://terrain.reearth.land/) /
  [Mapterhorn](https://mapterhorn.com/), CC BY 4.0, EGM2008 geoid (NGA).
- **Imagery** — Esri World Imagery, © Esri, Maxar, Earthstar Geographics.
- **Buildings** — © OpenStreetMap contributors, via
  [OpenFreeMap](https://openfreemap.org/).
- **Airports** — [OurAirports](https://ourairports.com/data/), public domain.
- **Aircraft model** — NASA Global Hawk, public domain, via
  [NASA 3D Resources](https://github.com/nasa/NASA-3D-Resources).
- **Geocoding** — [Photon](https://photon.komoot.io/), OpenStreetMap.
- **Engine** — [CesiumJS](https://cesium.com/platform/cesiumjs/), Apache-2.0.

---

## 10. Honest limitations

- Buildings are **untextured massing geometry**. Correct footprints and correct
  heights, plain facades. Photogrammetric detail is not available without a
  paid imagery key, and this project deliberately has none.
- Terrain is ~90 m class at z14. Fine rock and vegetation relief is smoothed.
- No terminals, towers, taxiways, bridges or street furniture.
- One aircraft type.
- OpenFreeMap rate-limits by design; over a fast, long flight some city tiles
  arrive a second or two late rather than not at all.

MIT licensed. `project.md` is updated with every change to the project.
