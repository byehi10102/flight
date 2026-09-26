# Skyward

**An open flight simulator on a real 3D Earth.** Real terrain, real 3D
buildings, real runways, anywhere on Earth — **no API keys, no accounts, no
billing**.

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. You spawn on the threshold of a real runway.
Hold **W** to accelerate, rotate, and take off.

## Controls

| | Ground | Air |
|---|---|---|
| **W** | accelerate | accelerate |
| **S** | brakes | — |
| **A** / **D** | steer | bank left / right |
| **←** / **→** | — | bank left / right |
| **↑** / **↓** | — | nose up / down |

All controls are hold-to-act, and they self-centre: release **↑/↓** and the
plane levels off and holds its altitude; release **A/D** and the bank decays to
wings-level. **P** pauses, **C** cleans the view, **H** hides the UI.

Search any address in the location panel to fly there, or jump straight to any
of 10 000+ real airports.

## What makes it real

- **Real 3D buildings** — actual OpenStreetMap footprints at their real
  heights, streamed from OpenFreeMap. 12 000+ buildings over Manhattan.
- **Real terrain** — a global elevation DEM. Everest measures 8 685 m, not
  the −5 931 m the naive API returns.
- **Real surface cover** — satellite imagery, so oceans, forests, farmland and
  cities are genuine, not procedural.
- **Real runways** — 14 000+ from OurAirports, at true positions and bearings,
  draped over the terrain.

**Verified against published data** — `node scripts/worldcheck.mjs`, 17/17:

| | |
|---|---|
| Buildings over Manhattan | **12,380** real footprints, tops to 932 m |
| One World Trade Center | **417 m** vs 417 m published |
| Empire State Building | **444 m** vs 443 m, 1 m from the real footprint |
| 432 Park Avenue | **426 m** vs 426 m |
| JFK runway 13R | **14,511 ft → 4,423 m**, exact |
| Heathrow 09L | **12,799 ft → 3,901 m**, exact |
| Dubai 12R | **14,590 ft → 4,447 m**, exact |

No Google Maps API, no Cesium ion token, no account. Just a network connection.

See [`project.md`](project.md) for the full design record, data sources,
attribution, and the complete change log.

## License

MIT. Data © OpenStreetMap contributors, Re:Earth/Mapterhorn (CC BY 4.0), Esri,
OurAirports (public domain), NASA (public domain).
