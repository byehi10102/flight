# Skyward multiplayer server (Express + Socket.IO)

A small room server for the flight sim: players create a lobby, share the
5-character code, and see each other fly. The server is a **relay**, not a
simulator — it never integrates physics.

```
server/
├── server.js               Express + Socket.IO: rooms, telemetry, cleanup
├── client.js               Cesium client: entities + 60 fps interpolation
├── index.html              Cesium demo (needs network for the Cesium CDN)
├── demo-2d.html            zero-dependency canvas demo (always works)
├── test-server.mjs         headless test of the room lifecycle
├── test-interpolation.mjs  headless test of the smoothing maths
└── package.json
```

## Run it

```bash
cd server
npm install
npm start                 # PORT env var, default 3000
```

Then open <http://localhost:3000/demo-2d.html>, click **CREATE LOBBY**, copy
the code, and open a second tab (or another device on your network) to
**JOIN** it. Drive with W/A/S/D and watch the other plane glide.

`index.html` is the same thing on a real Cesium globe. It loads Cesium from
a CDN, so it needs network access; the 2D demo has no dependencies at all.

## Test it

```bash
npm test
```

Covers the real Socket.IO path — create, join-by-code, telemetry relay,
late-joiner roster with last-known state, disconnect notification, empty-room
cleanup, and bad-code rejection — plus the interpolation maths
(frame-rate independence, shortest-angle heading).

## Integrating with the game

`client.js` is deliberately shaped for a game that already has a `state`
object with `lon / lat / alt / heading / pitch / roll`:

```js
import * as Cesium from "cesium";
import { createMultiplayerClient } from "./server/client.js";

const mp = createMultiplayerClient(viewer, {
  url: "https://your-server.example.com",     // or location.origin
  callsign: "ACE-1",
  // Where your own plane is, in whatever form you already track it:
  getPosition: () => Cesium.Cartesian3.fromDegrees(state.lon, state.lat, state.alt),
  getHeadingPitchRoll: () => new Cesium.HeadingPitchRoll(
    Cesium.Math.toRadians(state.heading),
    Cesium.Math.toRadians(state.pitch),
    Cesium.Math.toRadians(state.roll),
  ),
});

const code = await mp.createLobby();   // → "KQ7Z"
const res  = await mp.joinLobby(code); // → { code, players: [...] }

mp.on("joined", (p) => console.log(p.callsign, "joined"));
mp.on("left",   (p) => console.log(p.callsign, "left"));
```

The client then does all of this by itself:

- emits telemetry **25×/second** (in the requested 20-30 Hz band)
- `viewer.entities.add(...)` for each player who joins, with a model, a
  nametag, and a distance cull
- updates them from `player-moved`, and removes them on `player-left`
- runs the interpolation loop on `viewer.scene.preRender`

Call `mp.leave()` (or `mp.destroy()`) to clean up.

## The wire protocol

| Direction | Event | Payload |
| --- | --- | --- |
| client → server | `create-lobby` | `{ callsign }` → ack `{ ok, code, selfId, players }` |
| client → server | `join-lobby` | `{ code, callsign }` → ack `{ ok, code, selfId, players }` |
| client → server | `player-moved` | `{ x, y, z, heading, pitch, roll }` |
| client → server | `leave-lobby` | ack `{ ok }` |
| server → room | `player-joined` | `{ id, callsign, state }` |
| server → room | `player-moved` | `{ id, x, y, z, heading, pitch, roll }` |
| server → room | `player-left` | `{ id, callsign, reason }` |

`players` in the join/create ack **excludes you** and includes each player's
last known `state`, so a late joiner sees everyone in their current position
instead of at the origin.

Telemetry is ECEF (`Cesium.Cartesian3`) x/y/z, which is the most direct fit
for Cesium. It is bulkier than `lon/lat/alt` on the wire (~6-7 significant
digits per axis); if bandwidth matters more than convenience, send lon/lat/alt
and rebuild the Cartesian on receipt.

## Interpolation — why it looks smooth

Packets arrive ~25×/second but Cesium renders ~60, so setting
`entity.position` on each packet makes remote planes visibly step. Two
details fix that, and both are verified by `test-interpolation.mjs`:

1. **Frame-rate independent smoothing.** Lerping by a fixed fraction *per
   frame* moves at different speeds on a 60 Hz and a 144 Hz monitor. The
   client uses `alpha = 1 - exp(-dt / tau)`, which closes the same fraction
   of the remaining distance per unit of **time**, so both converge over the
   same wall-clock period. (The test asserts this, and includes a control
   showing the naive per-frame version failing it.)

2. **Heading takes the short way round.** Interpolating 350° → 10° linearly
   flies the long way (350 → 180 → 10) and the plane visibly spins. Heading
   is interpolated along the shortest signed angle; pitch and roll lerp
   normally.

The position itself is `Cesium.Cartesian3.lerp` used incrementally
(`stepToward` in `client.js`), so remote aircraft ease toward each new packet
and stay smooth at any frame rate.

For reference, an alternative that removes interpolation lag entirely is a
small snapshot buffer: keep the last two packets with timestamps and render at
`now - ~100 ms`, interpolating between the pair that brackets that time. It
costs ~100 ms of extra latency but is perfectly smooth even under jitter. The
exponential approach is used here because it is simpler and adds no latency.

## Server behaviour worth knowing

- **Codes** are 5 characters from an unambiguous alphabet (no I/O/0/1) so
  they are easy to read aloud, and are checked for collisions on creation.
- **Cleanup** is automatic: a disconnect removes the player and notifies the
  room; the last player leaving deletes the room code so it can be reused.
- **Untrusted input**: codes are format-checked, callsigns trimmed, and every
  telemetry number must be finite or the packet is dropped.
- **Rate cap**: telemetry over 60 Hz per socket is ignored, so one bad client
  cannot flood a room. (20-30 Hz is the intended range.)
- **Volatile relay**: telemetry is sent `volatile`, so if a client is
  briefly backed up it drops stale packets rather than queuing old positions.
- **Capacity**: 8 players per room (`MAX_PLAYERS_PER_ROOM`).

## Hosting

Any Node host works (Render, Fly.io, Railway, a VPS, Docker). It needs no
database — rooms live in memory, which also means a restart clears active
lobbies. For horizontal scaling you would need sticky sessions (Socket.IO
supports it) or a Redis adapter so rooms span instances.

Unlike the peer-to-peer mode elsewhere in this repo, this one **requires a
hosted server** — that is the trade-off for a simpler, more predictable
connection.
