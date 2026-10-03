/**
 * Skyward multiplayer server — Express + Socket.IO.
 *
 * Responsibilities:
 *   • create a lobby with a random 5-character room code
 *   • join a lobby by code
 *   • relay aircraft telemetry (x, y, z, heading, pitch, roll) to the other
 *     players in the same room, and only that room
 *   • clean up disconnected players, and delete room codes that go empty
 *
 * Run:  npm install && npm start        (PORT env var, default 3000)
 *
 * Design notes worth knowing:
 *   • The server is a RELAY, not a simulator. It never integrates physics;
 *     it stores the last packet per player so a late joiner gets everyone's
 *     current state immediately, and forwards everything else.
 *   • Telemetry is ECEF (Cesium Cartesian3) x/y/z. That is the most direct
 *     fit for Cesium, at the cost of larger packets than lon/lat/alt — see
 *     the README if you want the compact form instead.
 *   • Every inbound packet is treated as untrusted: numbers are checked for
 *     finiteness, codes are format-checked, and per-socket rates are capped
 *     so one bad client cannot flood a room.
 */

import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import { Server } from "socket.io";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

/** Unambiguous alphabet: no I/O/0/1, so codes are easy to read aloud. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 5;
const MAX_PLAYERS_PER_ROOM = 8;
/** Telemetry is sent at 20-30 Hz; this is a generous ceiling, not a target. */
const MAX_TELEMETRY_HZ = 60;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// Serve the browser test page (and this folder) so the demo is clickable.
app.use(express.static(path.join(__dirname)));

/**
 * rooms: Map<code, Room>
 * Room = {
 *   code: string,
 *   createdAt: number,
 *   players: Map<socketId, Player>
 * }
 * Player = {
 *   id, callsign, joinedAt, lastTelemetryAt,
 *   state: { x, y, z, heading, pitch, roll } | null
 * }
 */
const rooms = new Map();

function randomCode() {
  let code;
  do {
    code = "";
    const bytes = crypto.randomBytes(CODE_LENGTH);
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
  } while (rooms.has(code));
  return code;
}

function normalizeCode(raw) {
  return String(raw || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, CODE_LENGTH);
}

const isValidCode = (code) => new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(code);

function sanitizeCallsign(raw) {
  const s = String(raw || "").trim().slice(0, 16);
  return s || "PILOT";
}

/** Only forward finite numbers; anything else is dropped, not coerced. */
function sanitizeTelemetry(t) {
  if (!t || typeof t !== "object") return null;
  const nums = ["x", "y", "z", "heading", "pitch", "roll"];
  const out = {};
  for (const k of nums) {
    const v = Number(t[k]);
    if (!Number.isFinite(v)) return null;
    out[k] = v;
  }
  return out;
}

function roomRoster(room, excludeId = null) {
  return [...room.players.values()]
    .filter((p) => p.id !== excludeId)
    .map((p) => ({
      id: p.id,
      callsign: p.callsign,
      state: p.state,
    }));
}

/** Remove a socket from whatever room it is in, with cleanup + notification. */
function leaveRoom(socket, reason = "left") {
  const code = socket.data.roomCode;
  if (!code) return;
  socket.data.roomCode = null;

  const room = rooms.get(code);
  if (!room) return;

  const player = room.players.get(socket.id);
  room.players.delete(socket.id);
  socket.leave(code);

  if (player) {
    socket.to(code).emit("player-left", { id: socket.id, callsign: player.callsign, reason });
  }

  // Delete the code as soon as nobody is left, so it can be reused and so
  // we never accumulate dead rooms.
  if (room.players.size === 0) {
    rooms.delete(code);
    console.log(`[room ${code}] empty → removed`);
  } else {
    console.log(`[room ${code}] ${player ? player.callsign : socket.id} ${reason} (${room.players.size} left)`);
  }
}

io.on("connection", (socket) => {
  console.log(`[socket] connected ${socket.id}`);

  // ── Create a lobby ──────────────────────────────────────────────────────
  socket.on("create-lobby", (payload = {}, ack) => {
    try {
      leaveRoom(socket, "switched rooms");

      const code = randomCode();
      const room = { code, createdAt: Date.now(), players: new Map() };
      rooms.set(code, room);

      const player = {
        id: socket.id,
        callsign: sanitizeCallsign(payload.callsign),
        joinedAt: Date.now(),
        lastTelemetryAt: 0,
        state: null,
      };
      room.players.set(socket.id, player);
      socket.join(code);
      socket.data.roomCode = code;

      console.log(`[room ${code}] created by ${player.callsign}`);
      if (typeof ack === "function") {
        ack({ ok: true, code, selfId: socket.id, players: roomRoster(room, socket.id) });
      }
    } catch (err) {
      console.error("create-lobby failed:", err);
      if (typeof ack === "function") ack({ ok: false, error: "Could not create lobby." });
    }
  });

  // ── Join a lobby by code ────────────────────────────────────────────────
  socket.on("join-lobby", (payload = {}, ack) => {
    const reply = (body) => { if (typeof ack === "function") ack(body); };
    try {
      const code = normalizeCode(payload.code);
      if (!isValidCode(code)) {
        return reply({ ok: false, error: "That is not a valid 5-character room code." });
      }

      const room = rooms.get(code);
      if (!room) {
        return reply({ ok: false, error: `No lobby found with code ${code}.` });
      }
      if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
        return reply({ ok: false, error: "That lobby is full." });
      }

      leaveRoom(socket, "switched rooms");

      const player = {
        id: socket.id,
        callsign: sanitizeCallsign(payload.callsign),
        joinedAt: Date.now(),
        lastTelemetryAt: 0,
        state: null,
      };
      room.players.set(socket.id, player);
      socket.join(code);
      socket.data.roomCode = code;

      // The joiner needs the existing roster (with last known state, so the
      // new player sees everyone in their CURRENT position, not at origin).
      // Self is excluded: you do not spawn an entity for your own plane.
      reply({ ok: true, code, selfId: socket.id, players: roomRoster(room, socket.id) });

      // Everyone already in the room learns about the newcomer.
      socket.to(code).emit("player-joined", {
        id: socket.id,
        callsign: player.callsign,
        state: player.state,
      });

      console.log(`[room ${code}] ${player.callsign} joined (${room.players.size} total)`);
    } catch (err) {
      console.error("join-lobby failed:", err);
      reply({ ok: false, error: "Could not join lobby." });
    }
  });

  // ── Telemetry relay ─────────────────────────────────────────────────────
  socket.on("player-moved", (payload = {}) => {
    const code = socket.data.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    const player = room && room.players.get(socket.id);
    if (!player) return;

    // Light rate cap: protects the room from a misbehaving client.
    const now = Date.now();
    if (now - player.lastTelemetryAt < 1000 / MAX_TELEMETRY_HZ) return;

    const state = sanitizeTelemetry(payload);
    if (!state) return;

    player.lastTelemetryAt = now;
    player.state = state;

    // Volatile: if a client is briefly backed up, its OLD position is worth
    // less than the next fresh one, so it is safe to drop.
    socket.volatile.to(code).emit("player-moved", { id: socket.id, ...state });
  });

  // ── Voluntary leave (keeps "player-left" instant instead of waiting for
  //    the socket to time out) ─────────────────────────────────────────────
  socket.on("leave-lobby", (_payload, ack) => {
    leaveRoom(socket, "left");
    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("disconnect", (reason) => {
    console.log(`[socket] disconnected ${socket.id} (${reason})`);
    leaveRoom(socket, "disconnected");
  });
});

/**
 * Only listen when this file is RUN, not when it is imported (the headless
 * test imports it and binds its own port). Standard ESM entry check.
 */
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  server.listen(PORT, () => {
    console.log(`Skyward multiplayer server listening on http://localhost:${PORT}`);
    console.log(`Open http://localhost:${PORT}/ to try it in a browser.`);
  });
}

// Exported for the headless test so it can start/stop the server itself.
export { server, io, rooms };
