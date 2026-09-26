# Skyward — change plan

## Current problem the player sees

> "the airplane is sideways and it only shows the front half"

That is a framing problem, and it has three causes, all now fixed in the code on
disk:

1. **The aircraft was never drawn in the first place.** `Model.fromGltfAsync` was
   given `minimumPixelSize`, `maximumScale` and `distanceDisplayCondition`, and
   the combination suppressed the model completely — it was `ready`, visible and
   in the scene, and changed not one pixel. `scripts/pixdiff.mjs` proves it
   (freeze the loop, diff shown-vs-hidden: 0 → 18,240 px airborne).
2. **The camera assumed the wrong forward axis.** The CRJ-900 is a Y-up model
   whose nose runs along +Y; the old chase camera offset along the classic
   Cesium frame (-Z forward), so it parked *beside* the aeroplane and looked 28°
   off, leaving only the front half in frame. Now offsets are expressed in the
   model's own axes (+Y forward, +Z up).
3. **The camera was closer than the aeroplane was long.** 34 m back for a 39 m
   jet put it inside the fuselage. Now well behind it.

The orientation is verified, not eyeballed: `scripts/orientation.mjs` pushes the
mesh's own nose/tail/wingtip vertices through the app's transform and checks they
land where the aeroplane is flying — **10/10**.

## Changes in this batch

### 1. Third-person view — behind, above, movable, not locked

- Camera moves in behind the aircraft and slightly above, in the model's own
  body frame (`+Y` forward, `+Z` up, so "behind" is `-Y`, "above" is `+Z`).
- **Look-around, spring-loaded**: right-drag yaws and pitches the gaze
  independently of the aircraft position; release and it springs back to looking
  at a point ahead on the flight path. The camera keeps following the aircraft,
  but the view is no longer glued to it.
- Frame-rate-independent exponential smoothing on both position and aim.

### 2. Flight model — no auto-takeoff; choose a city and spawn over it

- **Removed the auto-takeoff sequence.** There is no rotation-speed gate and no
  forced liftoff anymore; the aircraft leaves the ground only when the pilot
  commands enough pitch for the wing to carry it.
- **Start over a city.** The game no longer drops you on a runway. On launch you
  spawn airborne over a chosen city (default: Manhattan) at ~1000 m, trimmed and
  holding altitude, and the altitude hold is armed immediately so it flies level
  from frame one.
- **Controls, exactly as requested:**
  - `W` — accelerate (throttle up), air or ground.
  - `A` / `D` — roll / steer (air), nose-wheel steer (ground).
  - `←` / `→` — same as A / D.
  - `↑` / `↓` — pitch nose up / down.
  - `S` — hold to extend flaps and slow down in the air; hold on the ground to
    brake.
  - Release `↑` / `↓` → auto-level pitch (altitude hold). Release `A` / `D` / `←`
    / `→` → auto-level roll.
- Hold-to-act throughout: keys are ramped axes, not step inputs.

### 3. Real 3D everywhere — buildings, mountains, oceans

- **Buildings:** streamed from OpenFreeMap (OpenStreetMap schema) vector tiles,
  extruded from real `render_height` values, with procedural window facades
  generated in the shader. No flat single-colour blocks.
- **Terrain:** Re:Earth quantized-mesh DEM (CC BY 4.0) — real elevation from
  sea floor to mountain tops.
- **Oceans / water:** Cesium's water effect over the globe; real coastlines and
  bathymetry underneath.
- **Imagery:** Esri World Imagery, keyless.
- Roof-exclusion fix for facades so windows don't stamp onto flat roofs.

## Verification

| Script | Proves | Target |
|---|---|---|
| `orientation.mjs` | model facing is correct (nose leads) | 10/10 |
| `pixdiff.mjs` | the model draws pixels | PASS |
| `thirdperson.mjs` | view is behind the aircraft, whole frame in view | 7/7 |
| `acceptance.mjs` | W / A / D / S / arrows / auto-level over the city | 16/16 |
| `worldcheck.mjs` | buildings match real heights | 17/17 |

## Notes / known gaps

- Sustained climb rate is below the real CRJ-900's (~3 m/s vs ~12 m/s). See
  project.md §11.
- The exact screenshot could not be parsed by the vision tool (404 on the
  backend), so the "high-detail 3D mountain" reference is taken on trust: the
  terrain provider is already a real DEM and will resolve the detail available.
