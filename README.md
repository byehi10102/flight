# Skyward

**An open flight simulator on a real 3D Earth.** Real 3D terrain, real satellite
imagery, an F-15 you fly from a chase camera — anywhere on the planet, with
**no API keys, no accounts, no sign-up**.

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm run build      # production bundle in dist/
```

## How to play

1. Click **START FLIGHT**. (Optional: set **MINIMAP RANGE** 1K / 5K / 10K first —
   it persists between sessions.)
2. The spawn map opens over **Anaheim, California**. Pan/zoom the globe, use
   the search box, or tap one of the 16 labeled landmark pins (Disneyland,
   White House, Eiffel Tower…) to spawn there. Clicking a point shows its
   full address: city, county, state, country.
3. Click **SPAWN HERE** — the camera pulls up, dives onto the spawn point, and
   the jet fades in mid-dive.
4. Fly. A red 3D map pin marks your launch point so you can navigate back to
   it (also shown on the minimap, with a rim arrow when it is off-screen).
5. Hit terrain and you crash: fireball, then the pause menu. **RESPAWN AT
   START** re-flies the spawn dive onto your pin; **NEW LOCATION** returns to
   the map picker. `Esc`/`P` pauses in place.

## Controls

| Key | Action |
| --- | ------ |
| **W** / **S** | Throttle up / down |
| **Arrow Up** / **Arrow Down** | Pitch down (descend) / up (climb) |
| **Arrow Left** / **Arrow Right** | Roll left / right |
| **A** / **D** | Yaw (rudder) |
| **Space** | Afterburner (needs a full boost meter) |
| **Mouse drag** | Look around (springs back on release) |
| **M** | Mute / unmute |
| **Esc** / **P** | Pause / resume in place |

## Speed model

Speeds are **MPH**, shown raw on the HUD:

- Idle throttle: **500 mph** cruise — always visibly moving, never stagnant.
- Full `W`: **5000 mph**.
- `Space` boost: slams to **10000 mph** with an FOV kick, screen shake, edge
  vignette, afterburner flames and a barrel-roll flourish.

Physics runs in fixed 1/60 s substeps of real elapsed time, so the jet covers
true distance at any frame rate (verified identical ground track at 60 fps and
10 fps). The boost meter drains across one 5 s burn, cuts at zero, recharges
to full in ~3 s, and only fires on a full meter.

## HUD

Compass tape with cardinal readout, mission timer, score, FPS, local date,
speed (mph), altitude **AGL** (height above the terrain below you — skimming
reads near zero, touchdown reads zero), coordinates, flight status, boost
meter, pitch ladder in a bottom-right attitude panel with a reference line,
PULL UP warning (visual + voice), and a live satellite minimap with player
wedge, spawn marker, range rings and radar sweep.

## Sound

Sample-based suite (engine and wind loops track speed, throttle blips, boost
roar, pitch/roll strain, PULL UP voice, spawn/zoom/crash stingers, UI
hover/clicks). Browsers start audio suspended — everything fades in after your
first click or keypress.

## What makes it real

- **Real 3D terrain** — global elevation DEM from Re:Earth/Mapterhorn (CC BY 4.0).
- **Real satellite imagery** — Esri World Imagery; an Esri street-map base
  layer fills oceans, poles and any tile the satellite service lacks.
- **Permanent daylight** — the sim clock is pinned to solar noon at the jet
  and the sun parked just off-overhead, so night never falls anywhere.
- **Accurate elevation** — a `sampleTerrainMostDetailed` sampler with cache
  backs altitude, crash detection and spawn height (resident tiles alone can
  be kilometers off from altitude).
- **No API keys** — no Google Maps API, no Cesium ion token, no CARTO key, no
  account. Just a network connection.

## Architecture

Vanilla ES modules + Vite + CesiumJS (planetary globe, terrain streaming,
spawn map, minimap) + Three.js (camera-locked F-15 overlay, flames, crash
particles).

```
src/
├── main.js                    state machine, spawn picker, game loop
├── core/
│   ├── config.js              all tunables
│   ├── viewer.js              viewers, terrain, imagery, sun, minimap camera
│   ├── ground.js              accurate elevation sampler + cache
│   └── airports.js            airport data helpers
├── plane/
│   ├── planePhysics.js        arcade flight model (THREE.Quaternion, MPH)
│   ├── planeController.js     keyboard + mouse input
│   ├── planeModel.js          Three.js overlay model + boost visuals
│   └── jetFlame.js            afterburner flame shader
├── ui/
│   ├── hud.js                 all flight instruments + minimap overlay
│   ├── location.js            search helpers
│   └── style.css
└── utils/
    ├── geo.js                 Nominatim geocoding + fallbacks
    ├── particles.js           crash-explosion particles
    └── soundManager.js        sample playback engine
public/
├── models/f-15.glb            flyable F-15 (oriented for chase view)
└── sounds/*.mp3               28 samples (see Attribution)
```

To use your own artwork for the 3D spawn pin, drop it at
`public/spawn-pin.png` — the game uses it verbatim, otherwise a procedural
glossy pin stands in.

## Change log

Every change from the ref-flight alignment pass onward, newest last. (A later
revert removed the roads overlay, pinch/trackpad zoom buttons and the
40-landmark set again — see bottom.)

- **Oriented F-15 + chase view** — replaced the model file with the variant
  whose root rotations point the nose down −Z, ported ref's visual-update
  math (accel inertia, boost easing, flame mounts); fixed an inverted boost-Z
  sign and a broken ease-out cubic.
- **Physics/controls parity** — copied ref's `planePhysics`/`planeController`
  exactly (since diverged where requested: MPH band, boost ×2, meter gate).
- **Ref-style HUD** — horizon + pitch ladder, compass tape, smoothed
  attitude, UI tilt/shake/boost vignette, tactical minimap.
- **Spawn reliability** — yaw/boost state propagation, NaN guards, camera
  flight safety nets.
- **Permanent daylight** — sun re-aimed at the jet twice a second, then clock
  pinned to solar noon (clock, not just light brightness, drives night).
- **Boost blackout fix** — spawn fade split into solid-black (transitions)
  and see-through radial (boost tunnel effect).
- **Water/coastline** — ocean water effect on, base color ocean blue.
- **Crash explosion** — ref-style flash/fire/sparks/smoke adapted to the
  overlay camera (ref positions particles via the Cesium camera, which this
  architecture doesn't share).
- **Corner attitude panel** — pitch ladder moved out of the center view with
  a fixed reference line; minimap shifted above it.
- **True AGL altitude** — readout is height above sampled terrain (near zero
  skimming, zero at touchdown); crash snaps onto the ground elevation.
- **Coverage fallbacks** — street-map base under satellite gaps, coordinate
  fallback labels where geocoding has no address.
- **Spawn pin** — red pin → big glossy 3D billboard (distance-culled past
  ~150 km), plane spawns ~1 km ahead so it never covers the screen; exact
  artwork supported via `public/spawn-pin.png`.
- **Default spawn: Anaheim, CA** (33.8366°N, 117.9143°W) after GPS/IP lookup
  proved unreliable in this environment.
- **Satellite minimap** — second Cesium viewer, top-down tracking, spawn dot
  + off-screen rim arrow; **1K/5K/10K range setting** on the home page.
- **Landmark picker** — 16 labeled pins (tap to spawn), Esri places-label
  overlay, full city/county/state/country addresses, ± zoom buttons.
- **MPH speed band** — 500 cruise / 5000 max / 10000 boost with MPH→m/s world
  mapping, boost FOV kick, snappier spool.
- **Fixed-substep loop** — sim time tracks wall-clock at any frame rate.
- **Minimap accuracy pass** — meter-true grid, one shared smoothed heading
  for map + overlay, per-frame map tracking, ref zoom model, live-FOV wedge.
- **Boost meter** — drains across the burn, cuts at zero, recharges in
  ~3 s, fires only when full. (Ref itself has no boost widget; built fresh
  in its visual language and verified by sim.)
- **Sound suite** — all 28 ref samples wired (engine/wind/throttle/boost/
  strain loops, PULL UP, spawn/zoom/crash stingers, UI clicks, pause/mute);
  procedural engine removed.
- **Spawn flight** — two-phase pull-up + dive with stale-timer generation
  guards, live plane through the dive, crash→respawn replays it.
- **Reverted again**: roads overlay, picker pinch/trackpad zoom buttons and
  the expanded 40-landmark set (landed, then removed per request); CARTO
  tiles replaced earlier with keyless Esri street map after CARTO retired
  keyless access.

## Attribution

- **Terrain** — Re:Earth / Mapterhorn, CC BY 4.0
- **Imagery** — Esri World Imagery, © Esri, Maxar, Earthstar Geographics;
  street base + picker labels: Esri/HERE/Garmin, © OpenStreetMap contributors
- **Aircraft model** — "Low poly F-15" by SIpriv (via
  dimartarmizi/web-flight-simulator)
- **Sounds + flight/HUD design** — dimartarmizi/web-flight-simulator
  (dual-licensed non-commercial — replace samples before any commercial use)
- **Geocoding** — Nominatim / OpenStreetMap
- **Engine** — CesiumJS (Apache-2.0), Three.js (MIT)

## Honest limitations

- Cities are flat satellite paint — no 3D buildings; altitude and crash
  detection measure to street level and you can fly through where towers
  should be.
- Altitude is ellipsoidal AGL, not MSL/barometric.
- Terrain is ~90 m class; fine relief is smoothed. Polar imagery has gaps
  (street-map base shows instead).
- The live minimap doubles tile streaming; first seconds after spawn can look
  soft until its cache catches up.
- Audio needs one click/keypress before it starts (browser policy).

MIT licensed (see note above about ref sound samples for commercial use).
