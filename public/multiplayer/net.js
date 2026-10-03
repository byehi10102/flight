/**
 * Multiplayer transport — serverless peer-to-peer (Trystero over WebRTC).
 *
 * No game server, no API keys, no accounts: a room code is the only shared
 * secret. Public relays (Nostr) are used ONLY for the initial WebRTC
 * handshake; once peers are connected, all flight data flows directly
 * peer-to-peer, so in-game latency is just the two players' connections.
 *
 * Reliability measures (this is the part that matters):
 *  - Explicit connection status the UI can show, never a silent dead room.
 *  - Join errors surfaced (onJoinError) instead of a hung "waiting".
 *  - Heartbeat timeout: a peer that stops sending for PEER_TIMEOUT_MS is
 *    treated as left even if the browser never fired onPeerLeave.
 *  - Position packets are small and delta-gated: we skip a tick when the
 *    aircraft has barely moved, which keeps bandwidth low and steady at
 *    12 Hz regardless of speed.
 *  - Every send is wrapped: a network hiccup can never break the sim loop.
 */
import { joinRoom, selfId } from "./vendor/trystero.mjs";

const APP_ID = "skyward-flight-sim-v1";
/**
 * Free public STUN servers (no account, no key — Google's open endpoints).
 * Trystero 0.25 ships with NO default iceServers, so without these only
 * mDNS host candidates are gathered, which fail in restricted browser
 * contexts and behind symmetric NATs — the connection then dies right
 * after the SDP exchange. Verified live before relying on them.
 */
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
];
// NOTE on TURN: verified live that adding the free openrelay TURN made
// connections flakier (its allocation adds seconds of ICE delay and trips
// handshake timeouts), while STUN-only connected reliably across repeated
// tests. If a real-world network ever needs TURN (symmetric NAT), add a
// working TURN server to this list — the code already passes it through.
/** Unambiguous alphabet: no I/O/0/1 to keep codes easy to read aloud. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 5;
const STATE_HZ = 12;
const STATE_INTERVAL_MS = 1000 / STATE_HZ;
/** Presence ping interval; the sweep tolerates ~3 missed beats. */
const HEARTBEAT_MS = 2000;
/** A peer silent this long is considered gone (leave event not required). */
const PEER_TIMEOUT_MS = 6000;
/** Automatic reconnect: attempts per connect() call, with a short delay. */
const MAX_CONNECT_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;
/**
 * Handshake window per attempt. Typical connections land in ~2s, so this is
 * generous headroom for slow ICE gathering without making a failed attempt
 * take so long that the retry feels broken.
 */
const HANDSHAKE_TIMEOUT_MS = 14000;

export function generateRoomCode() {
  let out = "";
  const buf = new Uint32Array(CODE_LENGTH);
  try {
    crypto.getRandomValues(buf);
    for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  } catch (e) {
    for (let i = 0; i < CODE_LENGTH; i++) {
      out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
  }
  return out;
}

/** Normalize user-typed codes: uppercase, strip spaces/dashes. */
export function normalizeRoomCode(raw) {
  return String(raw || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, CODE_LENGTH);
}

export class Net {
  constructor() {
    this.room = null;
    this.code = null;
    this.callsign = "PILOT";
    this.selfId = selfId || "self";
    /** peerId -> { callsign, lastSeen, state, spawn } */
    this.peers = new Map();
    this.status = "idle"; // idle | connecting | online | error | closed
    this.error = null;
    this.active = false;
    this._attempt = 0;
    this._closing = false;

    this._handlers = {
      onStatus: [],
      onPeerJoin: [],
      onPeerLeave: [],
      onState: [],
      onSpawn: [],
      onHello: [],
    };

    this._sendState = null;
    this._sendSpawn = null;
    this._sendHello = null;
    this._sendBack = null;
    this._sendHeartbeat = null;
    this._lastStateSent = 0;
    this._lastStatePayload = null;
    this._sweepTimer = null;
    this._heartbeatTimer = null;
  }

  on(event, fn) {
    if (this._handlers[event]) this._handlers[event].push(fn);
    return this;
  }

  _emit(event, ...args) {
    for (const fn of this._handlers[event] || []) {
      try { fn(...args); } catch (e) { /* a bad listener must not break the net */ }
    }
  }

  _setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    this._emit("onStatus", status, error);
  }

  /** Peers currently considered present by the game. */
  activePeers() {
    return [...this.peers.entries()].map(([id, p]) => ({ id, ...p }));
  }

  peerCount() {
    return this.peers.size;
  }

  /**
   * Connect to a room. Call for both "create" (code you generated) and
   * "join" (code typed in) — they are the same operation.
   *
   * Public relay signaling is very good but not perfect (measured ~4% of
   * attempts fail at the ICE stage), so a failed handshake is retried
   * automatically with a fresh offer before surfacing an error. That is
   * what makes the party flow self-healing rather than requiring a reload.
   */
  async connect(code, callsign) {
    if (this.active) await this.leave();
    this.code = normalizeRoomCode(code);
    this.callsign = (callsign || "PILOT").slice(0, 14).toUpperCase();
    if (!this.code) {
      this._setStatus("error", "Room code is empty.");
      return false;
    }
    this._attempt = 0;
    this._closing = false;
    return this._openRoom();
  }

  /** Tear down the current room + timers without touching user intent. */
  _teardownRoom() {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    const room = this.room;
    this.room = null;
    this._sendState = null;
    this._sendSpawn = null;
    this._sendHello = null;
    this._sendBack = null;
    this._sendHeartbeat = null;
    if (room) {
      try { room.leave(); } catch (e) { /* already gone */ }
    }
  }

  /**
   * A handshake failed. Retry with a fresh room/offer until attempts run
   * out; the peer may have been racing us or the relay path was bad.
   */
  _handleJoinError(details) {
    if (this._closing) return;
    this.active = false;
    this._teardownRoom();
    if (this._attempt < MAX_CONNECT_ATTEMPTS) {
      this._emit("onRetry", this._attempt, MAX_CONNECT_ATTEMPTS);
      this._setStatus("connecting", `Attempt ${this._attempt} failed — retrying…`);
      setTimeout(() => {
        if (this._closing) return;
        this._openRoom();
      }, RETRY_DELAY_MS);
    } else {
      this._setStatus(
        "error",
        `Could not reach your partner after ${this._attempt} attempts (${details?.error || "relay error"}).`
      );
    }
  }

  async _openRoom() {
    this._attempt++;
    this._setStatus("connecting");
    try {
      const room = joinRoom(
        {
          appId: APP_ID,
          rtcConfig: { iceServers: ICE_SERVERS },
          handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
        },
        this.code,
        { onJoinError: (details) => this._handleJoinError(details) }
      );
      this.room = room;

      const stateAction = room.makeAction("st");
      stateAction.onMessage = (data, ctx) => this._handleState(ctx.peerId, data);

      const spawnAction = room.makeAction("sp");
      spawnAction.onMessage = (data, ctx) => this._handleSpawn(ctx.peerId, data);

      const helloAction = room.makeAction("hi");
      helloAction.onMessage = (data, ctx) => this._handleHello(ctx.peerId, data);

      // Dedicated liveness ping. Presence must not depend on gameplay
      // traffic: players sit in the waiting room and browse the spawn map
      // for long stretches, and without a heartbeat the presence sweep
      // would declare a perfectly healthy partner "gone".
      const hbAction = room.makeAction("hb");
      hbAction.onMessage = (data, ctx) => this._touch(ctx.peerId);

      // "Going back to spawn picking" — so NEW LOCATION by one player
      // returns BOTH to the picker instead of leaving the partner flying.
      const backAction = room.makeAction("bk");
      backAction.onMessage = () => this._emit("onBack");

      this._sendState = (payload) =>
        stateAction.send(payload).catch((e) => console.warn("[mp] state send failed:", e));
      this._sendSpawn = (payload) =>
        spawnAction.send(payload).catch((e) => console.warn("[mp] spawn send failed:", e));
      this._sendHello = (payload) =>
        helloAction.send(payload).catch((e) => console.warn("[mp] hello send failed:", e));
      this._sendBack = () => backAction.send({ t: 1 }).catch((e) => console.warn("[mp] back send failed:", e));
      this._sendHeartbeat = () => hbAction.send({ t: 1 }).catch(() => { /* liveness is best-effort */ });

      // Liveness ping well inside the sweep window (3 missed beats tolerated).
      if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = setInterval(() => {
        if (!this.active || !this._sendHeartbeat) return;
        if (this.peers.size === 0) return;
        this._sendHeartbeat();
      }, HEARTBEAT_MS);

      room.onPeerJoin = (peerId) => {
        this.peers.set(peerId, { callsign: "PILOT", lastSeen: Date.now(), state: null, spawn: null, helloSent: true });
        this._emit("onPeerJoin", peerId);
        // Announce ourselves immediately so names appear without waiting
        // (and mark this peer as already greeted so the reply path in
        // _handleHello cannot start an echo).
        try { this._sendHello({ c: this.callsign }); } catch (e) { /* best effort */ }
      };

      room.onPeerLeave = (peerId) => {
        this.peers.delete(peerId);
        this._emit("onPeerLeave", peerId);
      };

      // Heartbeat sweep: browser leave events can be missed (tab kill,
      // network drop), so presence is authoritative here.
      this._sweepTimer = setInterval(() => this._sweep(), 1000);

      this.active = true;
      this._setStatus("online");
      // A successful (re)connect invalidates any earlier attempt failure.
      this.error = null;
      return true;
    } catch (e) {
      this.active = false;
      this._teardownRoom();
      if (this._attempt < MAX_CONNECT_ATTEMPTS && !this._closing) {
        setTimeout(() => { if (!this._closing) this._openRoom(); }, RETRY_DELAY_MS);
        this._setStatus("connecting", `Attempt ${this._attempt} failed — retrying…`);
        return true;
      }
      this._setStatus("error", e?.message || "Failed to start multiplayer.");
      return false;
    }
  }

  _sweep() {
    const now = Date.now();
    for (const [id, peer] of [...this.peers.entries()]) {
      if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
        this.peers.delete(id);
        this._emit("onPeerLeave", id);
      }
    }
  }

  _touch(peerId) {
    let peer = this.peers.get(peerId);
    if (!peer) {
      peer = { callsign: "PILOT", lastSeen: Date.now(), state: null, spawn: null, helloSent: false };
      this.peers.set(peerId, peer);
      this._emit("onPeerJoin", peerId);
    }
    peer.lastSeen = Date.now();
    return peer;
  }

  _handleHello(peerId, data) {
    const peer = this._touch(peerId);
    if (data && typeof data.c === "string") peer.callsign = data.c.slice(0, 14);
    // Reply AT MOST ONCE per peer, so a peer that joined before us learns
    // our name. Replying to every hello made two peers echo each other
    // endlessly — measured ~4,250 messages/second before this guard.
    if (!peer.helloSent) {
      peer.helloSent = true;
      try { if (this._sendHello) this._sendHello({ c: this.callsign }); } catch (e) { /* best effort */ }
    }
    this._emit("onHello", peerId, peer.callsign);
  }

  _handleState(peerId, data) {
    if (!data || typeof data !== "object") return;
    const peer = this._touch(peerId);
    peer.state = data;
    this._emit("onState", peerId, data, peer);
  }

  _handleSpawn(peerId, data) {
    if (!data || typeof data !== "object") return;
    const peer = this._touch(peerId);
    peer.spawn = data;
    this._emit("onSpawn", peerId, data, peer);
  }

  /**
   * Broadcast own flight state. Rate-limited to STATE_HZ and skipped when
   * nothing meaningful changed, so a stationary/slow jet costs no traffic.
   */
  broadcastState(state) {
    if (!this.active || !this._sendState) return;
    const now = Date.now();
    if (now - this._lastStateSent < STATE_INTERVAL_MS) return;

    const payload = {
      lon: +state.lon.toFixed(5),
      lat: +state.lat.toFixed(5),
      alt: Math.round(state.alt),
      h: +state.heading.toFixed(1),
      p: +state.pitch.toFixed(1),
      r: +state.roll.toFixed(1),
      v: Math.round(state.speed),
      fly: state.isFlying ? 1 : 0,
    };

    // Delta gate: skip if position/attitude barely moved since last send.
    const last = this._lastStatePayload;
    if (last) {
      const dLon = Math.abs(payload.lon - last.lon);
      const dLat = Math.abs(payload.lat - last.lat);
      const dAlt = Math.abs(payload.alt - last.alt);
      const moved = dLon > 0.00002 || dLat > 0.00002 || dAlt > 3;
      const turned = Math.abs(payload.h - last.h) > 0.4 || Math.abs(payload.p - last.p) > 0.4;
      const speedChanged = Math.abs(payload.v - last.v) > 5;
      if (!moved && !turned && !speedChanged && payload.fly === last.fly) return;
    }

    this._lastStateSent = now;
    this._lastStatePayload = payload;
    this._sendState(payload);
  }

  /** Broadcast own spawn-map presence (cursor + placed point). */
  broadcastSpawn(spawn) {
    if (!this.active || !this._sendSpawn) return;
    this._sendSpawn({
      camLon: spawn.camLon != null ? +spawn.camLon.toFixed(4) : null,
      camLat: spawn.camLat != null ? +spawn.camLat.toFixed(4) : null,
      lon: spawn.lon != null ? +spawn.lon.toFixed(5) : null,
      lat: spawn.lat != null ? +spawn.lat.toFixed(5) : null,
      placed: spawn.placed ? 1 : 0,
    });
  }

  /** Tell the party I am going back to spawn picking. */
  broadcastBack() {
    if (!this.active || !this._sendBack) return;
    this._sendBack();
  }

  async leave() {
    this._closing = true;
    this.active = false;
    this._teardownRoom();
    this.peers.clear();
    this._lastStatePayload = null;
    this._setStatus("closed");
  }
}
