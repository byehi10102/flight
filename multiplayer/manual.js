/**
 * True serverless multiplayer — manual WebRTC signal exchange.
 *
 * No signaling server, no relays, no accounts. Two players swap two text
 * codes by hand (Discord, email, SMS):
 *
 *   HOST                                        JOINER
 *   1. "CREATE INVITE"      ─── invite code ──▶
 *                                               2. paste invite, "GENERATE REPLY"
 *                           ◀── reply code ───
 *   3. paste reply, "CONNECT"
 *
 * ── The one subtlety that makes manual signaling work ─────────────────────
 * Normally ICE candidates trickle to the peer as they are discovered, which
 * is why a server (or relay) is needed. With hand-copied codes there is no
 * live channel, so we wait for ICE gathering to FINISH and ship every
 * candidate inside the SDP ("vanilla ICE"). Only then is the code complete.
 * `_waitForIce` does that, with a timeout so a slow/missing STUN server
 * cannot hang the flow forever.
 *
 * The public STUN servers below are keyless and are NOT a service of ours —
 * they only help each side discover its own public address. Without them,
 * connections work on the same LAN but fail across most home routers. Set
 * `iceServers: []` for a strictly local, zero-external-contact mode.
 *
 * The class deliberately mirrors Net (multiplayer/net.js) — same events, same
 * methods — so the game's spawn gate, presence markers and remote planes all
 * work on either transport without knowing which is in use.
 */

const CODE_PREFIX = "SKW1:";
/** Extra room on top of the prefix so `looksLikeCode` can spot a pasted code. */
export const MANUAL_CODE_PREFIX = CODE_PREFIX;

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

/** How long to wait for ICE gathering before shipping what we have. */
const ICE_GATHER_TIMEOUT_MS = 8000;

/** Base64 of a UTF-8 string, chunked so large SDPs cannot blow the stack. */
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** True if a pasted string looks like one of our codes. */
export function looksLikeCode(text) {
  return String(text || "").trim().startsWith(CODE_PREFIX);
}

export class ManualLink {
  constructor(options = {}) {
    this.mode = "manual";
    this.iceServers = options.iceServers ?? ICE_SERVERS;

    this.pc = null;
    this.dc = null;
    this.status = "idle"; // idle | gathering | awaiting-reply | connecting | online | error | closed
    this.error = null;
    this.active = false;
    this.callsign = "PILOT";
    this.selfId = "self";

    /** One remote peer, keyed "peer" (there is exactly one). */
    this.peers = new Map();

    this._handlers = {
      onStatus: [], onPeerJoin: [], onPeerLeave: [],
      onState: [], onSpawn: [], onHello: [], onRetry: [], onBack: [],
    };
    // Kept so the lobby can render a status line like the relay transport.
    this._lastStatusMessage = "";
  }

  on(event, fn) {
    // Create the slot if it does not exist yet: a missing key would
    // otherwise swallow the listener silently, which is exactly the sort of
    // bug that is invisible until something does not happen.
    (this._handlers[event] ||= []).push(fn);
    return this;
  }

  _emit(event, ...args) {
    for (const fn of this._handlers[event] || []) {
      try { fn(...args); } catch (e) { /* a bad listener must not break the link */ }
    }
  }

  _setStatus(status, error = null, message = "") {
    this.status = status;
    this.error = error;
    this._lastStatusMessage = message;
    this._emit("onStatus", status, error);
  }

  peerCount() { return this.peers.size; }
  activePeers() { return [...this.peers.entries()].map(([id, p]) => ({ id, ...p })); }

  /**
   * The relay transport reports reachable relays here; a manual link has no
   * signaling to report, so the UI shows its own line for this mode.
   */
  relayStats() { return { total: 0, open: 0 }; }

  // ── Connection plumbing ──────────────────────────────────────────────────
  _newPeerConnection() {
    this.close();
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "connected") {
        this.active = true;
        // The app-level link is the data channel, but a connection that is
        // up with an open channel means the peer is present — recover
        // presence here so a transient "disconnected" cannot strand us.
        if (this.dc && this.dc.readyState === "open") this._markPeerPresent();
        this._setStatus("online", null, "Connected directly — no server involved.");
      } else if (st === "failed") {
        this.active = false;
        this._dropPeer("connection failed");
        this._setStatus("error", "The direct connection failed.",
          "Both networks refused a direct route (common on strict mobile/corporate NAT). Try a different network.");
      } else if (st === "disconnected") {
        // Transient in Chrome — the channel often survives and recovers, so
        // presence is NOT dropped here, only reported.
        this._setStatus("connecting", null, "Link interrupted — waiting for it to recover…");
      } else if (st === "closed") {
        this.active = false;
        this._dropPeer("connection closed");
        this._setStatus("closed", null, "The other player disconnected.");
      }
    };
    return pc;
  }

  /** Idempotent: announces the peer only on the absent → present edge. */
  _markPeerPresent() {
    const existed = this.peers.has("peer");
    const peer = this._touchPeer();
    if (!existed) {
      this._emit("onPeerJoin", "peer");
      this._emit("onHello", "peer", peer.callsign);
    }
    return peer;
  }

  _wireDataChannel(dc) {
    this.dc = dc;
    dc.onopen = () => {
      this._markPeerPresent();
      this._announceCallsign();
    };
    dc.onclose = () => {
      this._dropPeer("data channel closed");
      if (this.active) this._setStatus("closed", null, "The other player disconnected.");
    };
    dc.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg !== "object") return;
      this._touchPeer();
      switch (msg.t) {
        case "st": this._emit("onState", "peer", msg.d, this.peers.get("peer")); break;
        case "sp": this._emit("onSpawn", "peer", msg.d, this.peers.get("peer")); break;
        case "hi":
          // _send wraps payloads as { t, d }, so the callsign is in msg.d.
          if (msg.d && typeof msg.d.c === "string") {
            const peer = this._touchPeer();
            peer.callsign = msg.d.c.slice(0, 16);
            this._gotCallsign = true;
            this._emit("onHello", "peer", peer.callsign);
          }
          break;
        case "bk": this._emit("onBack"); break;
      }
    };
  }

  /**
   * Announce our callsign until the peer's arrives.
   *
   * The two data channels do NOT open at the same instant, so a single
   * "hello" sent the moment our side opens can be dropped by a peer whose
   * channel is still connecting — leaving both players labelled "PILOT".
   * Retrying briefly makes the handshake deterministic.
   */
  _announceCallsign() {
    this._gotCallsign = false;
    if (this._helloTimer) clearInterval(this._helloTimer);
    let attempts = 0;
    const send = () => {
      attempts++;
      this._send("hi", { c: this.callsign });
      if (this._gotCallsign || attempts >= 8) {
        clearInterval(this._helloTimer);
        this._helloTimer = null;
      }
    };
    send();
    this._helloTimer = setInterval(send, 500);
  }

  _touchPeer() {
    let peer = this.peers.get("peer");
    if (!peer) {
      peer = { callsign: "PILOT", lastSeen: Date.now(), state: null, spawn: null };
      this.peers.set("peer", peer);
    }
    peer.lastSeen = Date.now();
    return peer;
  }

  _dropPeer(reason) {
    if (!this.peers.has("peer")) return;
    this.peers.delete("peer");
    this._emit("onPeerLeave", "peer", reason);
  }

  _send(t, data) {
    if (!this.dc || this.dc.readyState !== "open") return;
    try { this.dc.send(JSON.stringify({ t, d: data })); } catch (e) { /* link closed */ }
  }

  _encode(desc) {
    return CODE_PREFIX + toBase64(JSON.stringify({ t: desc.type, s: desc.sdp }));
  }

  _decode(code) {
    const raw = String(code || "").trim();
    const body = raw.startsWith(CODE_PREFIX) ? raw.slice(CODE_PREFIX.length) : raw;
    // Tolerate pasted whitespace/newlines from chat clients.
    const obj = JSON.parse(fromBase64(body.replace(/\s+/g, "")));
    if (!obj || typeof obj.s !== "string" || typeof obj.t !== "string") {
      throw new Error("That code is not a valid Skyward invite or reply.");
    }
    return { type: obj.t, sdp: obj.s };
  }

  /** Wait until ICE gathering finishes, or the timeout elapses. */
  _waitForIce() {
    const pc = this.pc;
    if (!pc || pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      };
      const onChange = () => { if (pc.iceGatheringState === "complete") finish(); };
      pc.addEventListener("icegatheringstatechange", onChange);
      const timer = setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
    });
  }

  // ── HOST: step 1 ─────────────────────────────────────────────────────────
  /** Creates the invite code to send to the other player. */
  async createInvite(callsign) {
    this.callsign = (callsign || "PILOT").slice(0, 16);
    this._setStatus("gathering", null, "Building your invite code…");
    const pc = this._newPeerConnection();
    this._wireDataChannel(pc.createDataChannel("skyward", { ordered: true }));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this._waitForIce();
    this._setStatus("awaiting-reply", null, "Send this invite, then paste the reply you get back.");
    return this._encode(pc.localDescription);
  }

  // ── JOINER: step 2 ───────────────────────────────────────────────────────
  /** Consumes the host's invite and returns the reply code to send back. */
  async acceptInvite(inviteCode, callsign) {
    this.callsign = (callsign || "PILOT").slice(0, 16);
    this._setStatus("gathering", null, "Building your reply code…");
    const pc = this._newPeerConnection();
    pc.ondatachannel = (ev) => this._wireDataChannel(ev.channel);
    await pc.setRemoteDescription(this._decode(inviteCode));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this._waitForIce();
    this._setStatus("connecting", null, "Reply ready — send it back to finish connecting.");
    return this._encode(pc.localDescription);
  }

  // ── HOST: step 3 ─────────────────────────────────────────────────────────
  /** Consumes the joiner's reply; the data channel opens on its own. */
  async acceptReply(replyCode) {
    if (!this.pc) throw new Error("Create an invite before pasting a reply.");
    this._setStatus("connecting", null, "Connecting…");
    await this.pc.setRemoteDescription(this._decode(replyCode));
    this._setStatus("connecting", null, "Reply accepted — waiting for the direct link…");
  }

  // ── Same surface as the relay transport ──────────────────────────────────
  broadcastState(state) {
    if (!state) return;
    this._send("st", {
      ts: performance.now(),
      lon: +state.lon.toFixed(5),
      lat: +state.lat.toFixed(5),
      alt: Math.round(state.alt),
      h: +state.heading.toFixed(1),
      p: +state.pitch.toFixed(1),
      r: +state.roll.toFixed(1),
      v: Math.round(state.speed),
      fly: state.isFlying ? 1 : 0,
    });
  }

  broadcastSpawn(spawn) {
    this._send("sp", {
      camLon: spawn.camLon != null ? +spawn.camLon.toFixed(4) : null,
      camLat: spawn.camLat != null ? +spawn.camLat.toFixed(4) : null,
      lon: spawn.lon != null ? +spawn.lon.toFixed(5) : null,
      lat: spawn.lat != null ? +spawn.lat.toFixed(5) : null,
      placed: spawn.placed ? 1 : 0,
    });
  }

  broadcastBack() { this._send("bk", 1); }

  /** Manual signaling is one-shot: recover by starting a new invite. */
  async reconnect() { this.close(); this._setStatus("idle", null, "Start a new invite to retry."); }

  close() {
    this.active = false;
    if (this._helloTimer) {
      clearInterval(this._helloTimer);
      this._helloTimer = null;
    }
    this._dropPeer("closed");
    if (this.dc) {
      try { this.dc.close(); } catch (e) { /* already closed */ }
      this.dc = null;
    }
    if (this.pc) {
      try { this.pc.close(); } catch (e) { /* already closed */ }
      this.pc = null;
    }
  }

  async leave() {
    this.close();
    this._setStatus("closed", null, "");
  }
}
