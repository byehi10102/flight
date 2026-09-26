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
29. **Buildings are now lit, not flat-coloured.** The massing used
    `PerInstanceColorAppearance({ flat: true })`, which means no normals and no
    sun: every face of every building got an identical colour, so a city looked
    like coloured cardboard no matter how correct the footprints and heights
    were. Switched to `flat: false` for per-vertex lighting against the real
    sun direction. Measured over 11 239 buildings in Midtown, mean scene
    luminance now tracks the sun — 78.9 / 65.0 / 57.2 as the light is swung from
    high to raking to back-lit, with the tonal spread narrowing from 15/16 to
    9/16 bands. That response is what makes massing read as solid geometry.
    Restored `allowPicking: false` at the same time; the lighting edit had
    briefly dropped it.
30. **Building geometry was being built without normals.** The extruded polygons
    used `vertexFormat: PolygonGeometry.POSITION_ONLY`, so the appearance had no
    normals to shade with — the lighting enabled in item 29 had nothing to work
    with and every face rendered at one flat tone. Changed to
    `PerInstanceColorAppearance.VERTEX_FORMAT` (`POSITION_AND_NORMAL`). With
    normals the massing is genuinely lit: over 11 239 buildings in Midtown, mean
    scene luminance now tracks the sun across a spread of 16.3, against 4.8 with
    the lighting flag set but no normals present.
31. **HUD relabelled from `FT MSL` to `ALT FT`.** The DEM is ellipsoidal
    (EGM2008-referenced), so calling the reading MSL was a label the number
    could not support — at Manhattan it was showing ~45 m where a published MSL
    figure is ~2 m. Re:Earth does serve a `/cesium-mesh/geoid` endpoint, and it
    looks like exactly what was needed, so it was tested: sampled at 12 airports
    across five continents, the "geoid" value came back **identical to the
    ellipsoid terrain value every time** (KJFK −32.7/−32.7, LFPG 44.5/44.5,
    YSSY 22.2/22.2). Both endpoints serve the same EGM2008-blended dataset, and
    the conversion produced errors up to 464 m. No keyless source offers a
    separate geoid grid, so the conversion was not shipped and the label now
    says what the number is. `AGL` is unchanged and is genuinely height above
    the rendered surface, which is the figure that matters for terrain
    clearance.

---

---

## 7a. The CRJ-900 swap, and the bugs it uncovered

This was supposed to be a one-line change — point the model at a different GLB.
It was not, and the reason is worth recording: **the aeroplane had never been
visible at all.** A player reporting "I can't see the plane" is easy to read as
a camera problem. It was not.

### 1. The aircraft was never drawn

`AircraftModel` created the model with three entirely reasonable-looking
options:

```js
minimumPixelSize: 96,
maximumScale: 900,
distanceDisplayCondition: [0, 12_000_000],
```

With those set, the model was `ready`, `show === true`, present in
`scene.primitives`, and contributing to the frame's command list — and
**changed not one pixel of a 1000x700 frame when hidden**. `debugShowBoundingVolume`
rendered nothing either.

`scripts/pixdiff.mjs` proves it rather than asserting it: it freezes the
animation loop, renders the same frame with the model shown and hidden, and
diffs the pixels. Before the fix: `0 of 700000`. The scene has to be frozen
first — two grabs seconds apart differ across ~60% of the frame just from
terrain still streaming, and that noise is larger than the aeroplane.

It was not the new GLB. The old Global Hawk behaved identically. Removing the
three options restored drawing immediately (18,240 pixels, a 472x120 box).

### 2. The camera and the model disagreed about which way is forward

The new model is a Y-up Sketchfab export whose nose runs along **+Y**. The
chase camera assumed the classic Cesium body frame (-Z forward, +Y up, +X
right) and offset `(side, up, back)`. Against this model that put "up" along
the direction of flight and "back" along a sideways axis, so the camera parked
*beside* the aeroplane. The look-at point had the same bug: aiming 40 m along
-Z put it 40 m *below* the aircraft, and the aeroplane sat 28.3 deg outside the
field of view. Both now use the model's own axes: -Y behind, +Z up.

### 3. The camera was closer than the aeroplane was long

Chase distance was 34 m, tuned for an 8 m Global Hawk. The CRJ-900 is 39.4 m
long, so the camera was *inside the fuselage*. Now 78 m back, 16 m up, looking
6 m ahead — the whole airframe is in frame, wings symmetric about the centreline.

`lookAhead` went 40 → 6 for the same reason, in the other direction: the further
ahead the camera looks, the further down the aeroplane falls in frame. At 40 the
tail projected to y=879 in an 800 px viewport.

### 4. Model centring was off by a factor of the model scale

`Model.scale` is applied inside Cesium's model pipeline, **not** in
`modelMatrix`. A translation written into the matrix is therefore in world
metres while the mesh's coordinates are in authored units. Offsetting by the
authored half-length (1.827) instead of the scaled one left the airframe 17.6 m
ahead of the point the flight model and the camera were tracking.

### 5. Rotation speed and stall

Physics retuned to the real airframe: 38,300 kg, 104.9 m² wing, 59 kN thrust,
rotation at 140 kt. A 38 t jet does **not** leap off the mark — it takes about
1.5 km and ~50 s to reach rotation speed, which is correct and is the point.

`maxPitch` came down from 0.42 rad (24°) to 0.20 rad (11.5°). Held to 24° the
aircraft sits past its ~16.6° stall angle, so the wing stops lifting and it
accelerates in a *steady descent* at full thrust: measured 144 m/s, still
sinking, altitude decaying 110 m → 58 m.

### 6. The altitude hold could not hold altitude

Proportional and derivative alone settle at whatever standing error they can
live with. Holding level at 97 m/s needs about 8.6° of nose-up, because the
wing at that speed makes only ~0.9 of the lift required; the PD pair commanded
3.8° and the aeroplane sank 3.7 m/s with full throttle. An integral term
(`holdGainI`) accumulates the steady attitude that is actually required.

## 7b. Building facades

The complaint was buildings "that are just solid color blocks". The heights and
footprints were already correct — the *shading* was flat. Windows are the cue
that survives being looked at from a moving aeroplane.

The window grid is computed **analytically in the fabric shader**, not from a
texture. Cesium 1.145's `Texture` exposes no public `.texture` getter, so
`uniforms.image` came out `undefined` and material construction threw
"Cannot read properties of undefined (reading 'type')". The building loader
catches per-tile failures and reports them with `console.warn` — and every error
listener in this project filtered on `/Error|Invalid|failed/`, silently
discarding them. The result was 116 buildings counted, zero primitives built,
and a skyline of nothing, with no visible error.

Defining the cells in metres of wall has a bonus a fixed-resolution atlas
cannot: a window is the same real size on a shed and on a skyscraper, and stays
crisp at any distance.

Four archetypes (office, residential, brick, glass), assigned per footprint
from its coordinates and height. `MaterialAppearance` carries one material, so
a tile's buildings are grouped by archetype and each group is its own primitive —
about 141 primitives from 40 tiles.

### The Cesium 1.145 material ABI

This took a bisection to pin down, and the contract is not the one the older
documentation describes:

| Written | Result |
|---|---|
| `czm_material czm_diffuse czm_specular czm_emission;` | `czm_specular : syntax error` |
| declaring nothing, using `czm_material.diffuse` | `. : syntax error` |
| `czm_material czm_diffuse;` | parsed, but the struct has no such members |
| writing `void main()` | `main : function already has a body` |
| `input` as a parameter name | `Illegal use of reserved word` |
| `czm_material()` | `constructor does not have any arguments` |

What works: **no declarations at all**, and a function named `czm_getMaterial`
returning a `czm_material` built by field assignment:

```glsl
czm_material czm_getMaterial(czm_materialInput mi) {
  czm_material m;
  m.diffuse = ...;
  m.alpha = 1.0;
  return m;
}
```

GLSL `//` comments are also not permitted inside fabric source — the parser
tokenises the string and does not understand them, giving `. : syntax error`.
The explanation lives in JavaScript, where it cannot break the shader.

## 7c. A testing trap worth knowing about

`window.Cesium` cannot be exposed by `import * as Cesium` and assigned. Rollup
tree-shakes even a namespace import down to the members it can *observe* being
used, so the global comes out partial: `Matrix4.getElement`,
`Matrix3.multiplyByPoint` and `Matrix4.multiplyByPointTranslation` all reported
"not a function" against it. Each of those reads exactly like a broken
application, and cost a long time being believed.

A handful of classes needed by the harnesses are now named explicitly on
`window.SKYWARD.cesium`, which forces them to be retained. Everything else in
`scripts/` does plain arithmetic on values the app exposes rather than calling
into Cesium.

---

## 8. Verification

Claims about a 3D world are cheap to make and easy to get wrong, so the ones
that matter are measured against published ground truth rather than asserted.

| Script | Proves | Result |
|---|---|---|
| `worldcheck.mjs` | Buildings and airports against published data | **17/17**, no console errors |
| `acceptance.mjs` | Every control, on the real GPU | **16/16** |
| `orientation.mjs` | The CRJ-900's own vertices land where the aeroplane flies | **10/10** |
| `thirdperson.mjs` | The view is genuinely from behind | **7/7** |
| `cameraview.mjs` | Camera distance, heading, framing on roll and climb | **6/6** |
| `facadecheck.mjs` | Facades reach the screen | **PASS**, 12,089 buildings / 41 tiles, clean console |
| `pixdiff.mjs` | The model draws pixels at all | **PASS** — 35,302 px on the ground |
| `takeoff.mjs` | The takeoff roll, traced second by second | climbs +3 m/s, 110 → 227 m |

### `orientation.mjs` — the one that matters most

"The aeroplane points the right way" is not a thing you can check by eye. A
model rendered from behind looks entirely plausible whether or not it is
correct. So this reads the mesh's own extreme vertices — nose, tail, both
wingtips, the lowest point of the belly — straight out of the GLB, transforms
them with the same matrix the app uses, and compares where they land against
where the aeroplane is actually travelling.

It is what caught three separate real bugs: a nose pointing 180° backwards, a
17.6 m centring error, and a 0.42 rad pitch attitude that stalled the wing.

### Buildings are real 3D solids

| | |
|---|---|
| Buildings instantiated over Manhattan | **12,380**, from 40 vector tiles |
| Building primitives in the scene graph | **141 / 141**, all ready (one per facade archetype per tile) |
| Geometry extent | tops reach **932.8 m**, bases from **−30.1 m** — real solids standing on real terrain, not flat marks |
| Height distribution | 3,000 tracked, **2,314 over 100 m**, tallest **541 m** |

### Building heights match the real buildings

Each landmark's nearest extrusion, compared with its published architectural
height. The figure compared is the **roof**, which is what OSM's
`render_height` carries — 1 WTC is popularly called 541 m, but that includes the
spire; its roof is 417 m and that is what OSM records.

| Building | Ours | Published | Error | Distance |
|---|---|---|---|---|
| One World Trade Center (roof) | **417 m** | 417 m | **+0.0 %** | 18 m |
| Empire State Building | **444 m** | 443 m | **+0.2 %** | 1 m |
| 432 Park Avenue | **426 m** | 426 m | **+0.0 %** | 19 m |
| Chrysler Building (roof) | **272 m** | 278 m | −2.2 % | 10 m |
| Flatiron Building | **88 m** | 87 m | **+1.1 %** | 25 m |

Five skyscrapers landing within 2.2 % of their published heights, with the
extrusions sitting within 25 m of the real coordinates, is the strongest
available evidence that the buildings are the real ones.

### Airports are real

Each airport is flown to individually. The drawn metres are checked against the
source record, and where the published AIP figure is well established the source
itself is checked against it.

| Airport | Runway | Source | Drawn | Bearing |
|---|---|---|---|---|
| **KJFK** JFK Intl | 13R | 14,511 ft | **4,423 m** | 121° |
| **EGLL** Heathrow | 09L | 12,799 ft | **3,901 m** | 90° |
| **RJTT** Tokyo Haneda | 16L | 11,024 ft | **3,360 m** | 150° |
| **YSSY** Sydney | 16R | 12,999 ft | **3,962 m** | 168° |
| **CYYZ** Toronto Pearson | 05 | 11,120 ft | **3,389 m** | 47° |
| **OMDB** Dubai Intl | 12R | 14,590 ft | **4,447 m** | 121° |

JFK, Heathrow, Haneda and Dubai match their published AIP lengths exactly.
**96 / 96** runways convert feet to metres correctly — a check that earned its
place, because the first version of the instrumentation reported the raw feet
labelled as metres, making JFK's 200 ft runway look like a 200 m one. The
renderer was always right; the measurement was wrong. Worth keeping in mind
that a failing test is as often a broken test as broken code.

### The massing is lit

Mean scene luminance over 11k+ buildings as the sun is swung from high to
raking to back-lit: **74.6 / 66.6 / 58.3**, a spread of **16.3**. Unlit massing
would barely move.

### Controls

`scripts/acceptance.mjs` drives real keystrokes on the real GPU and asserts each
one does what the specification says: **16/16** — spawn on a runway, `W`
accelerates, rotation speed, lift-off, throttle winds down, `↑`/`↓` pitch and
climb/descend, altitude holds, `D` and `→` bank and turn right, `←` turns left,
and bank auto-levels on release.

---

## 9. Running it

```bash
npm install
npm run dev        # http://127.0.0.1:5173
```

```bash
npm run build && npm run preview    # production build
node scripts/acceptance.mjs          # verify the controls (16 checks)
node scripts/worldcheck.mjs          # verify the world against published data (17 checks)
```

Requires only a network connection. First load streams a few MB; after that the
world streams as you fly.

---

## 10. Attribution

- **Aircraft** — Bombardier CRJ-900 CityJet, supplied by the project owner as
  `airplane_crj-900_cityjet.glb`.
- **Terrain** — Re:Earth quantized-mesh, keyless.
- **Imagery** — Esri World Imagery and OpenStreetMap, keyless.
- **Buildings** — OpenFreeMap / OpenMapTiles vector tiles, ODbL.
- **Airports** — OurAirports, public domain.
- **Geocoding** — Photon (Komoot).


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

## 11. Honest limitations

- Buildings have **procedural window facades** — four archetypes, window size
  defined in metres of wall — but they are **not textured with real imagery**.
  The window grids, spandrel bands and wall tints are generated in the shader.
  There is no photographic surface detail, and that is not available without a
  paid imagery key, which this project deliberately has none of.
- The **climb rate is well below the real airframe's**. A CRJ-900 at MTOW has
  roughly 45 kN of excess thrust at 100 m/s, which works out to a 7° climb
  angle and about 12 m/s of vertical speed. The simulation climbs at
  **+3 m/s**. The hand calculation from the configured lift, mass and speed
  says vertical acceleration should be strongly positive, so something in the
  vertical integration is damping it that I have not isolated. Takeoff, rotation
  and level flight are all correct; sustained climb rate is not yet faithful.
- Altitude is **ellipsoidal**, not orthometric MSL. No keyless source publishes
  a geoid grid that matches the DEM, so the HUD says `ALT` rather than claiming
  a datum it cannot deliver (§ change log, item 30).
- Terrain is ~90 m class at z14. Fine rock and vegetation relief is smoothed.
- No terminals, towers, taxiways, bridges or street furniture.
- One aircraft type: the CRJ-900 CityJet.
- Facade windows are applied to roofs as well as walls, so a roof seen from
  directly above can show a faint grid. Extruded polygon roofs carry a constant
  vertical UV, which usually makes them read flat, but it is not explicitly
  excluded in the shader.
- OpenFreeMap rate-limits by design; over a fast, long flight some city tiles
  arrive a second or two late rather than not at all.
- A large city teleport can still trip a Cesium culling error
  (`RangeError: Failed to set the 'length' property on 'Array'`). The custom
  render loop recovers and keeps rendering — verified by `scripts/recover.mjs`
  — but the underlying Cesium condition is not understood.

MIT licensed. `project.md` is updated with every change to the project.
