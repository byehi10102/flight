/**
 * Real-time WebSocket transport — the hexanaut-style path.
 *
 * Speaks to the repo's own relay (server/server.js) over a NATIVE WebSocket
 * (multiplayer ships as raw files, so there is no bundler to resolve a
 * client library through — and none is needed). Compared with the P2P path:
 *
 *   - one direct TCP connection to a server on the LAN/host machine:
 *     round trips are ~1-5 ms instead of a Nostr-relay handshake plus a
 *     WebRTC gather, so the party connects in well under a second;
 *   - the server relays each packet immediately and drops nothing into a
 *     queue; there is no single ordered DataChannel to head-of-line block
 *     the state stream behind a slow event (the P2P path's known limit);
 *   - the SAME DIS threshold sending (netmath.shouldTransmitState) governs
 *     both transports, so packet rates and receiver interpolation behave
 *     identically — only the latency changes.
 *
 * The server URL resolution order: ?mpserver= URL param, then the
 * skyward_mp_server localStorage value, then the same host on :3000.
 */
import { shouldTransmitState } from "./netmath.js";

const PEER_TIMEOUT_MS = 45000;
const STATE_HEARTBEAT_MS = 150;

/** Where the real-time server lives (probe order: URL param, storage, :3000). */
export function resolveServerUrl() {
  try {
    const q = new URLSearchParams(location.search).get("mpserver");
    if (q) return q;
    const saved = localStorage.getItem("skyward_mp_server");
    if (saved) return saved;
  } catch (e) { /* storage can throw in some privacy modes */ }
  return `${location.protocol}//${location.hostname || "127.0.0.1"}:3000`;
}

function toWsUrl(base) {
  const u = new URL(base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws";
  return u;
}

export class WsNet {
  constructor() {
    this.mode = "ws";
    this.code = null;
    this.callsign = "PILOT";
    this.selfId = null;       // server-assigned socket id
    /** peerId -> { callsign, lastSeen, state, spawn, helloSent } */
    this.peers = new Map();
    this.status = "idle";     // idle | connecting | online | error | closed
    this.error = null;
    this.active = false;
    this._closing = false;
    this._ws = null;
    this._sweepTimer = null;
    this._heartbeatTimer = null;
    this._sentLog = [];
    this.worldSpeedScale = 1.8;
    this.stateStats = { sent: 0, skipped: 0, forcedByThreshold: 0 };
    this.serverUrl = null;

    this._handlers = {
      onStatus: [], onPeerJoin: [], onPeerLeave: [], onState: [], onSpawn: [],
      onHello: [], onGo: [], onLaunch: [], onBullet: [], onBack: [],
      onRetry: [],
    };
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

  activePeers() {
    return [...this.peers.entries()].map(([id, p]) => ({ id, ...p }));
  }

  peerCount() {
    return this.peers.size;
  }

  /** Diagnostics parity with the P2P transport (index.js reads both). */
  relayStats() {
    return { mode: "ws", server: this.serverUrl, open: this._ws?.readyState === 1 };
  }

  /**
   * Join (or, as the first arrival, create) the room on the real-time server.
   * Resolves when the socket is open and the room joined; rejects on failure
   * so index.js can fall back to the P2P path.
   */
  connect(code, callsign, isHost = false) {
    this.code = code;
    this._isHost = isHost;
    this.callsign = (callsign || "PILOT").slice(0, 14);
    this.serverUrl = resolveServerUrl();
    let url;
    try {
      url = toWsUrl(this.serverUrl);
      url.searchParams.set("code", code);
      url.searchParams.set("name", this.callsign);
      if (isHost) url.searchParams.set("host", "1");
    } catch (e) {
      return Promise.reject(new Error("bad server url"));
    }
    this._setStatus("connecting");
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        this._setStatus("error", String(e));
        return reject(e);
      }
      this._ws = ws;
      // The P2P path retries through Nostr relays for ~30 s; here the server
      // is supposed to be CLOSE (same machine / LAN). Anything past 8 s is
      // a dead end — fail fast so the caller can fall back to P2P. (3.5 s
      // was too tight: a page still climbing out of its boot CPU spike can
      // stall the WebSocket handshake past it, which silently flipped real
      // runs onto the slow path — measured in the e2e.)
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch (e) { /* already closing */ }
        this._setStatus("error", "server timeout");
        reject(new Error("ws connect timeout"));
      }, 8000);

      ws.onopen = () => {
        // joined confirmation arrives as the first "welcome" frame.
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this._setStatus("error", "socket error");
        reject(new Error("ws error"));
      };
      ws.onclose = () => {
        clearTimeout(timeout);
        this.active = false;
        if (!settled) {
          settled = true;
          this._setStatus("error", "closed before join");
          reject(new Error("ws closed"));
          return;
        }
        if (!this._closing) {
          this._setStatus("closed");
          for (const id of [...this.peers.keys()]) {
            this.peers.delete(id);
            this._emit("onPeerLeave", id);
          }
        }
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        this._handleServerFrame(msg, () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.active = true;
          this._setStatus("online");
          resolve();
        });
      };
    });
  }

  _handleServerFrame(msg, onJoined) {
    if (!msg || typeof msg.t !== "string") return;
    // Every frame from a known peer is liveness (picker-idle peers send
    // presence, not state — the sweep must not drop them).
    if (msg.from && this.peers.has(msg.from)) this.peers.get(msg.from).lastSeen = performance.now();
    switch (msg.t) {
      case "welcome": {
        this.selfId = msg.id;
        this.code = msg.code || this.code;
        for (const p of msg.players || []) {
          this.peers.set(p.id, {
            callsign: p.name || "PILOT",
            state: p.state || null,
            spawn: p.spawn || null,
            lastSeen: performance.now(),
            helloSent: false,
          });
          this._emit("onPeerJoin", p.id);
        }
        onJoined();
        this._startSweep();
        this._startHeartbeat();
        // Tell the room who we are ( Net's hello protocol: others reply once).
        this._send({ t: "hi", d: { c: this.callsign } });
        break;
      }
      case "join": {
        this.peers.set(msg.id, {
          callsign: msg.name || "PILOT",
          state: msg.state || null,
          spawn: null,
          lastSeen: performance.now(),
          helloSent: false,
        });
        this._emit("onPeerJoin", msg.id);
        break;
      }
      case "left": {
        if (this.peers.delete(msg.id)) this._emit("onPeerLeave", msg.id);
        break;
      }
      case "hi": {
        const peer = this.peers.get(msg.from);
        if (!peer) break;
        if (msg.d && typeof msg.d.c === "string") peer.callsign = msg.d.c.slice(0, 14);
        // Reply AT MOST ONCE per peer (Net's echo guard).
        if (!peer.helloSent) {
          peer.helloSent = true;
          this._send({ t: "hi", d: { c: this.callsign } });
        }
        this._emit("onHello", msg.from, peer.callsign);
        break;
      }
      case "st": {
        const peer = this.peers.get(msg.from);
        if (!peer || !msg.d || typeof msg.d !== "object") break;
        peer.state = msg.d;
        peer.lastSeen = performance.now();
        this._emit("onState", msg.from, msg.d, peer);
        break;
      }
      case "sp": {
        const peer = this.peers.get(msg.from);
        if (!peer || !msg.d || typeof msg.d !== "object") break;
        peer.spawn = msg.d;
        this._emit("onSpawn", msg.from, msg.d, peer);
        break;
      }
      case "bk": this._emit("onBack"); break;
      case "error":
        // The server rejected the join (party does not exist).
        this._setStatus("error", msg.d || "party not found");
        try { this._ws.close(); } catch (e) { /* already closing */ }
        break;
      case "go": this._emit("onGo", msg.from, msg.d); break;
      case "ln": this._emit("onLaunch", msg.from, msg.d); break;
      case "bl": this._emit("onBullet", msg.from, msg.d); break;
      default: break; // unknown frame types are ignored, never fatal
    }
  }

  _send(frame) {
    const ws = this._ws;
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(JSON.stringify(frame)); } catch (e) { /* a hiccup must not break the sim */ }
  }

  /** Same DIS threshold policy as the P2P transport (shared pure rule). */
  broadcastState(state) {
    if (!this.active) return;
    const now = performance.now();
    const transmit = shouldTransmitState(this._sentLog, state, now, this.worldSpeedScale);
    if (transmit && this._sentLog.length) {
      const last = this._sentLog[this._sentLog.length - 1];
      if (performance.now() - last.ts < STATE_HEARTBEAT_MS) this.stateStats.forcedByThreshold++;
    }
    if (!transmit) {
      this.stateStats.skipped++;
      return;
    }
    const payload = {
      ts: now,
      lon: +state.lon.toFixed(5),
      lat: +state.lat.toFixed(5),
      alt: Math.round(state.alt),
      h: +state.heading.toFixed(1),
      p: +state.pitch.toFixed(1),
      r: +state.roll.toFixed(1),
      v: Math.round(state.speed),
      fly: state.isFlying ? 1 : 0,
    };
    this._send({ t: "st", d: payload });
    this.stateStats.sent++;
    this._sentLog.push(payload);
    if (this._sentLog.length > 2) this._sentLog.shift();
  }

  broadcastSpawn(spawn) {
    if (!this.active) return;
    this._send({
      t: "sp",
      d: {
        camLon: spawn.camLon != null ? +spawn.camLon.toFixed(4) : null,
        camLat: spawn.camLat != null ? +spawn.camLat.toFixed(4) : null,
        lon: spawn.lon != null ? +spawn.lon.toFixed(5) : null,
        lat: spawn.lat != null ? +spawn.lat.toFixed(5) : null,
        placed: spawn.placed ? 1 : 0,
      },
    });
  }

  broadcastBack() { if (this.active) this._send({ t: "bk", d: { t: 1 } }); }
  broadcastGo(payload) { if (this.active) this._send({ t: "go", d: payload || { t: 1 } }); }
  broadcastLaunch(payload) { if (this.active) this._send({ t: "ln", d: payload || { t: 1 } }); }
  broadcastBullet(payload) { if (this.active) this._send({ t: "bl", d: payload }); }

  async leave() {
    this._closing = true;
    this.active = false;
    if (this._sweepTimer) { clearInterval(this._sweepTimer); this._sweepTimer = null; }
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    try { this._ws?.close(); } catch (e) { /* already gone */ }
    this._ws = null;
    this.peers.clear();
    this._setStatus("closed");
  }

  /** Peer liveness: a peer silent for PEER_TIMEOUT_MS counts as left, even
   *  if the server's close frame never arrives (same rule as the P2P path).
   *  The heartbeat keeps QUIET phases alive (see _startHeartbeat), and the
   *  45 s window absorbs the spawn launch, which blocks the main thread —
   *  and therefore every timer on it — for tens of seconds on slow devices
   *  (measured: a 6 s window reaped live peers mid-launch in the e2e). A
   *  peer that dies properly still cleans up instantly via its close frame. */
  _startHeartbeat() {
    if (this._heartbeatTimer) return;
    this._heartbeatTimer = setInterval(() => {
      if (this.active) this._send({ t: "hb", d: { t: 1 } });
    }, 2000);
  }

  _startSweep() {
    if (this._sweepTimer) return;
    this._sweepTimer = setInterval(() => {
      const now = performance.now();
      for (const [id, peer] of this.peers) {
        if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
          this.peers.delete(id);
          this._emit("onPeerLeave", id);
        }
      }
    }, 1000);
  }
}
