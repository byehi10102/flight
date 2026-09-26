# Skyward

**An open flight simulator on a real 3D Earth.** Real 3D terrain, realistic satellite imagery, anywhere on the planet — with **no API keys, no accounts, no sign-up**.

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Click **START FLIGHT**, pick a spawn point on the map, and fly.

## Controls

| Key | Action |
| --- | --- |
| **W** / **S** | Throttle up / down |
| **Arrow Up** / **Arrow Down** | Pitch up / down |
| **Arrow Left** / **Arrow Right** | Roll left / right |
| **A** / **D** | Yaw (rudder) |
| **Space** | Afterburner (boost) |
| **Mouse drag** | Look around |
| **Esc** / **P** | Pause |

## What makes it real

- **Real 3D terrain** — a global elevation DEM from Re:Earth/Mapterhorn (CC BY 4.0).
- **Real satellite imagery** — Esri World Imagery, so oceans, forests, farmland and cities are genuine surface cover, not procedural.
- **No API keys** — no Google Maps API, no Cesium ion token, no account. Just a network connection.

## Architecture

Vanilla ES modules + Vite + CesiumJS + Three.js.

```
src/
├── main.js                    state machine, spawn picker, game loop
├── core/
│   ├── config.js              all tunables
│   ├── viewer.js              Cesium viewer, terrain, imagery, sun
│   └── ground.js              accurate elevation sampler + cache
├── plane/
│   ├── planePhysics.js        arcade flight model (THREE.Quaternion)
│   ├── planeController.js     keyboard + mouse input
│   └── planeModel.js          Three.js aircraft model overlay
└── ui/
    ├── hud.js                 speed, altitude, heading, throttle
    └── style.css
```

## Attribution

- **Terrain** — Re:Earth / Mapterhorn, CC BY 4.0
- **Imagery** — Esri World Imagery, (c) Esri, Maxar, Earthstar Geographics
- **Geocoding** — Nominatim / OpenStreetMap
- **Engine** — CesiumJS (Apache-2.0), Three.js (MIT)

MIT licensed.
