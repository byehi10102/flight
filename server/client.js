/**
 * Skyward multiplayer client — CesiumJS side of the room server.
 *
 * What this handles for you:
 *   • createLobby() / joinLobby(code) against the Socket.IO server
 *   • a telemetry loop that emits your position + orientation 20-30x/second
 *   • spawning a Cesium entity for each player who joins
 *   • removing it when they leave
 *   • smooth 60 FPS movement by interpolating between the ~25 Hz packets
 *
 * ── Why interpolation needs care ───────────────────────────────────────────
 * Packets arrive ~25 times a second but Cesium renders ~60, so naively
 * setting entity.position on each packet makes remote planes visibly step.
 * Two details make it smooth:
 *
 *   1. FRAME-RATE INDEPENDENT smoothing. Lerping by a fixed fraction per
 *      frame moves at different speeds on a 60 Hz and a 144 Hz monitor. We
 *      use alpha = 1 - exp(-dt / tau), which converges over the same wall
 *      clock time on any machine.
 *
 *   2. HEADING MUST WRAP. Interpolating 350° → 10° linearly flies the long
 *      way round (350 → 180 → 10) and the plane spins. Heading is therefore
 *      interpolated along the SHORTEST angle; pitch and roll lerp normally.
 *
 * Usage (matches the game's existing state object):
 *
 *   import { createMultiplayerClient } from "./client.js";
 *   const mp = createMultiplayerClient(viewer, {
 *     url: "http://localhost:3000",
 *     callsign: "ACE-1",
 *     getPosition: () => Cesium.Cartesian3.fromDegrees(state.lon, state.lat, state.alt),
 *     getHeadingPitchRoll: () => new Cesium.HeadingPitchRoll(
 *       Cesium.Math.toRadians(state.heading),
 *       Cesium.Math.toRadians(state.pitch),
 *       Cesium.Math.toRadians(state.roll)
 *     ),
 *   });
 *   await mp.createLobby();       // or: await mp.joinLobby("KQ7Z")
 */

import * as Cesium from "cesium";

const DEFAULTS = {
  url: "http://localhost:3000",
  callsign: "PILOT",
  /** 25 Hz sits in the requested 20-30 band. */
  telemetryHz: 25,
  /** Time constant for smoothing a remote plane onto its newest packet. */
  interpolationTau: 0.12,
  modelUri: "models/f-15.glb",
  /** Hide a remote plane beyond this distance (metres) to save frames. */
  cullDistance: 400000,
};

/** Shortest signed angular difference a→b, in radians. */
export function shortestAngle(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * One interpolation step toward the latest server state.
 *
 * Exported (and free of any viewer dependency) so the smoothing can be unit
 * tested directly — it is the part most easily got wrong.
 *
 * alpha = 1 - exp(-dt / tau) is an exponential approach: it closes the same
 * FRACTION of the remaining distance per unit of TIME rather than per frame,
 * so a 60 Hz and a 144 Hz client converge over the same wall-clock time.
 */
export function stepToward(current, target, currentHPR, targetHPR, dt, tau) {
  const alpha = 1 - Math.exp(-dt / tau);
  Cesium.Cartesian3.lerp(current, target, alpha, current);
  currentHPR.heading += shortestAngle(currentHPR.heading, targetHPR.heading) * alpha;
  currentHPR.pitch += (targetHPR.pitch - currentHPR.pitch) * alpha;
  currentHPR.roll += (targetHPR.roll - currentHPR.roll) * alpha;
  return alpha;
}

export function createMultiplayerClient(viewer, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  /** id -> remote player record */
  const players = new Map();
  const listeners = { joined: [], left: [], moved: [], error: [], status: [] };

  const scratchTarget = new Cesium.Cartesian3();
  const scratchHPR = new Cesium.HeadingPitchRoll();
  const scratchQuat = new Cesium.Quaternion();

  let socket = null;
  let telemetryTimer = null;
  const self = { code: null, selfId: null, connected: false };

  const emit = (event, payload) => {
    for (const fn of listeners[event] || []) {
      try { fn(payload); } catch (e) { /* a bad listener must not break the net */ }
    }
  };

  // ── Remote player records ────────────────────────────────────────────────
  function ensurePlayer(id, callsign, initialState = null) {
    let p = players.get(id);
    if (p) {
      if (callsign) p.callsign = callsign;
      if (initialState) applyTarget(p, initialState, true);
      return p;
    }

    p = {
      id,
      callsign: callsign || "PILOT",
      // Rendered state (what Cesium draws this frame).
      current: new Cesium.Cartesian3(),
      currentHPR: { heading: 0, pitch: 0, roll: 0 },
      // Latest state received from the server.
      target: new Cesium.Cartesian3(),
      targetHPR: { heading: 0, pitch: 0, roll: 0 },
      hasTarget: false,
      entity: null,
    };

    // The entity reads the live objects through CallbackProperty, so we
    // mutate those in place each frame and Cesium picks them up — no per
    // frame property churn.
    p.entity = viewer.entities.add({
      id: `mp-${id}`,
      position: new Cesium.CallbackProperty(() => p.current, false),
      orientation: new Cesium.CallbackProperty(() => {
        scratchHPR.heading = p.currentHPR.heading;
        scratchHPR.pitch = p.currentHPR.pitch;
        scratchHPR.roll = p.currentHPR.roll;
        return Cesium.Transforms.headingPitchRollQuaternion(p.current, scratchHPR, undefined, scratchQuat);
      }, false),
      model: {
        uri: opts.modelUri,
        minimumPixelSize: 48,
        maximumScale: 40000,
      },
      label: {
        text: p.callsign,
        font: "600 13px Consolas, monospace",
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -28),
        // Nametags only read as useful at range.
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(2000, opts.cullDistance),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });

    players.set(id, p);
    if (initialState) applyTarget(p, initialState, true);
    return p;
  }

  function applyTarget(p, state, snap = false) {
    const hadTarget = p.hasTarget;
    p.target.x = state.x;
    p.target.y = state.y;
    p.target.z = state.z;
    p.targetHPR.heading = state.heading;
    p.targetHPR.pitch = state.pitch;
    p.targetHPR.roll = state.roll;
    p.hasTarget = true;
    // A brand new plane (or an explicit teleport) has nothing to
    // interpolate from, so it snaps; everything else eases in.
    if (snap || !hadTarget) {
      Cesium.Cartesian3.clone(p.target, p.current);
      p.currentHPR.heading = state.heading;
      p.currentHPR.pitch = state.pitch;
      p.currentHPR.roll = state.roll;
    }
  }

  function removePlayer(id) {
    const p = players.get(id);
    if (!p) return;
    if (p.entity) viewer.entities.remove(p.entity);
    players.delete(id);
    emit("left", { id, callsign: p.callsign });
  }

  // ── Interpolation loop (runs every rendered frame, ~60 FPS) ──────────────
  function interpolate() {
    if (players.size === 0) return;
    // Cesium gives us frame time; fall back to 1/60 if it is unavailable.
    const dt = Math.min(viewer.clock ? viewer.clock.getDelta() : 1 / 60, 0.25) || 1 / 60;

    for (const p of players.values()) {
      if (!p.hasTarget) continue;
      // Position uses Cesium.Cartesian3.lerp as an incremental exponential
      // approach (see stepToward), and heading takes the short way round.
      stepToward(p.current, p.target, p.currentHPR, p.targetHPR, dt, opts.interpolationTau);
    }
  }

  // ── Telemetry out ────────────────────────────────────────────────────────
  function startTelemetry() {
    stopTelemetry();
    const periodMs = 1000 / Math.max(1, Math.min(60, opts.telemetryHz));
    telemetryTimer = setInterval(() => {
      if (!socket || !socket.connected || !self.code) return;
      let position;
      try {
        position = opts.getPosition();
      } catch (e) {
        return; // the sim may not have a plane yet
      }
      if (!position) return;

      const hpr = opts.getHeadingPitchRoll
        ? opts.getHeadingPitchRoll()
        : new Cesium.HeadingPitchRoll();

      socket.emit("player-moved", {
        x: position.x,
        y: position.y,
        z: position.z,
        heading: hpr.heading,
        pitch: hpr.pitch,
        roll: hpr.roll,
      });
    }, periodMs);
  }

  function stopTelemetry() {
    if (telemetryTimer) {
      clearInterval(telemetryTimer);
      telemetryTimer = null;
    }
  }

  // ── Socket wiring ────────────────────────────────────────────────────────
  /**
   * The Socket.IO client library is served by the server itself, so a page
   * only needs this module — no separate <script> tag. If a bundler already
   * provides io, that is used instead.
   */
  let ioLoader = null;
  function ensureIoLibrary() {
    if (typeof window !== "undefined" && window.io) return Promise.resolve(window.io);
    if (ioLoader) return ioLoader;
    ioLoader = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${opts.url.replace(/\/$/, "")}/socket.io/socket.io.js`;
      script.async = true;
      script.onload = () => (window.io ? resolve(window.io) : reject(new Error("socket.io loaded but io is missing")));
      script.onerror = () => reject(new Error("Could not load the socket.io client from the server."));
      document.head.appendChild(script);
    });
    return ioLoader;
  }

  async function connect() {
    if (socket) return socket;
    const io = await ensureIoLibrary();
    socket = io(opts.url, { transports: ["websocket", "polling"] });

    socket.on("connect", () => {
      self.connected = true;
      emit("status", { connected: true });
    });
    socket.on("disconnect", () => {
      self.connected = false;
      emit("status", { connected: false });
    });
    socket.on("connect_error", (err) => emit("error", { error: err.message }));

    socket.on("player-joined", (p) => {
      ensurePlayer(p.id, p.callsign, p.state);
      emit("joined", { id: p.id, callsign: p.callsign });
    });

    socket.on("player-moved", (p) => {
      const rec = ensurePlayer(p.id);
      applyTarget(rec, p);
      emit("moved", { id: p.id, callsign: rec.callsign });
    });

    socket.on("player-left", (p) => removePlayer(p.id));

    return socket;
  }

  /** Ask the server for a fresh lobby code. Resolves with the code. */
  async function createLobby() {
    await connect();
    return new Promise((resolve, reject) => {
      socket.emit("create-lobby", { callsign: opts.callsign }, (res) => {
        if (!res || !res.ok) {
          const error = (res && res.error) || "Could not create lobby.";
          emit("error", { error });
          reject(new Error(error));
          return;
        }
        self.code = res.code;
        self.selfId = res.selfId;
        startTelemetry();
        resolve(res.code);
      });
    });
  }

  /** Join an existing lobby. Resolves with { code, players }. */
  async function joinLobby(code) {
    await connect();
    return new Promise((resolve, reject) => {
      socket.emit("join-lobby", { code, callsign: opts.callsign }, (res) => {
        if (!res || !res.ok) {
          const error = (res && res.error) || "Could not join lobby.";
          emit("error", { error });
          reject(new Error(error));
          return;
        }
        self.code = res.code;
        self.selfId = res.selfId;
        // Spawn everyone already in the room, at their last known state.
        for (const p of res.players) {
          if (p.id === self.selfId) continue;
          ensurePlayer(p.id, p.callsign, p.state);
        }
        startTelemetry();
        resolve(res);
      });
    });
  }

  function leave() {
    stopTelemetry();
    if (socket && socket.connected) socket.emit("leave-lobby");
    for (const id of [...players.keys()]) removePlayer(id);
    self.code = null;
  }

  // Hook the interpolation into Cesium's render loop.
  const removePreRender = viewer.scene.preRender.addEventListener(interpolate);

  return {
    createLobby,
    joinLobby,
    leave,
    destroy() {
      leave();
      removePreRender();
      if (socket) socket.disconnect();
      socket = null;
    },
    on(event, fn) {
      if (listeners[event]) listeners[event].push(fn);
      return this;
    },
    get code() { return self.code; },
    get connected() { return self.connected; },
    get players() { return players; },
    /** Local player's own last-sent state, for UI/debug. */
    playerCount() { return players.size; },
  };
}
