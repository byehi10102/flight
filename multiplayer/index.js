/**
 * Skyward multiplayer — single entry point.
 *
 * Everything the feature needs lives in this folder: transport (net.js),
 * remote rendering (remotePlanes.js), spawn-map presence (spawnPresence.js),
 * UI (ui.js + style.css), and the party/spawn-gate logic below.
 *
 * Loaded by the host app with a guarded dynamic import:
 *   import("/multiplayer/index.js").then(m => { mp = m.initMp(ctx) })
 * Deleting this folder makes that import fail, the app's optional-chaining
 * calls become no-ops, and the game falls back to pure single player.
 *
 * The ctx from the host app carries everything this file may not import
 * (it loads raw, outside the bundler): the Cesium namespace, the shared
 * game state by reference, DOM handles, and the spawn-flow hooks.
 */
import { ManualLink, looksLikeCode } from "./manual.js";
import { createRemotePlanes } from "./remotePlanes.js";
import { createSpawnPresence } from "./spawnPresence.js";
import { buildMpUi } from "./ui.js";

/**
 * Flight-state send rate. Decoupled from the render loop so a dropped frame
 * cannot punch a gap into the other player's view of you.
 */
const STATE_HZ = 30;

// ── Performance mode (moved out of core/viewer.js so it lives here) ─────────
let perfMode = false;
function applyPerformance(ctx, on) {
  perfMode = !!on;
  try {
    const globe = ctx.viewer.scene.globe;
    globe.maximumScreenSpaceError = perfMode ? 4 : 2;
    globe.loadingDescendantLimit = perfMode ? 24 : 48;
    globe.tileCacheSize = perfMode ? 1024 : 2048;
  } catch (e) { /* quality is best-effort */ }
  try {
    const mv = ctx.getMiniViewer();
    if (mv) mv.resolutionScale = perfMode ? 0.5 : 1.0;
  } catch (e) { /* minimap is cosmetic */ }
  try {
    if (ctx.renderer) {
      ctx.renderer.setPixelRatio(perfMode ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    }
  } catch (e) { /* best effort */ }
}

// ── Multiplayer runtime ──────────────────────────────────────────────────────
export function initMp(ctx) {
  const ui = buildMpUi(ctx);
  const { state, dom } = ctx;

  let net = new ManualLink();
  const remotePlanes = createRemotePlanes({
    Cesium: ctx.Cesium,
    viewer: ctx.viewer,
    worldSpeedScale: ctx.worldSpeedScale,
  });
  const spawnPresence = createSpawnPresence({
    Cesium: ctx.Cesium,
    viewer: ctx.viewer,
  });

  // phase: idle (single player) | lobby | waiting | spawn | flying
  let phase = "idle";
  let active = false;
  let roomCode = null;
  let spawnPlaced = false;
  let partnerLeft = false;
  let knownPeers = new Set();
  let presenceTimer = 0;

  function setStatus(el, text, kind = "") {
    if (!el) return;
    el.textContent = text || "";
    el.className = "mp-status" + (kind ? " " + kind : "");
  }

  function showScreen(which) {
    if (dom.mainMenu) dom.mainMenu.classList.toggle("hidden", which !== "menu");
    if (ui.mpPanel) ui.mpPanel.classList.toggle("hidden", which !== "lobby");
    if (ui.waitingRoom) ui.waitingRoom.classList.toggle("hidden", which !== "waiting");
  }

  function refreshBadge() {
    if (!ui.badge) return;
    if (!active) {
      ui.badge.classList.add("hidden");
      return;
    }
    ui.badge.classList.remove("hidden");
    const peers = net.peerCount();
    if (ui.badgePeers) ui.badgePeers.textContent = `${peers}/2`;
    const healthy = net.status === "online" && peers > 0;
    const linkDown = net.status === "error";
    ui.badge.classList.toggle("offline", linkDown);
    ui.badge.classList.toggle("stale", !linkDown && !healthy);
    if (ui.badgeStatus) {
      ui.badgeStatus.textContent = linkDown ? "MP OFFLINE" : healthy ? "MP LIVE" : "MP SYNCING";
    }
  }

  function updateWaitingRoom() {
    const peers = net.activePeers();
    if (ui.wrSelfEl) ui.wrSelfEl.textContent = `YOU — ${net.callsign}`;
    if (ui.wrPeerEl) {
      if (peers.length) {
        ui.wrPeerEl.classList.remove("wr-peer-empty");
        ui.wrPeerEl.textContent = peers.map((p) => p.callsign || "PILOT").join(", ");
      } else {
        ui.wrPeerEl.classList.add("wr-peer-empty");
        ui.wrPeerEl.textContent = "WAITING FOR PLAYER…";
      }
    }
    updateDiag();
    refreshBadge();
  }

  /**
   * Live signaling readout. A failed join is almost always one of two
   * things — no relay reachable from this network, or the two networks
   * cannot reach each other directly — and both are invisible without
   * this line, which is what made the earlier failure so confusing.
   */
  function updateDiag() {
    const el = ui.wrDiagEl;
    if (!el) return;
    if (!active) { el.textContent = ""; el.className = "wr-diag"; return; }
    if (net.mode === "manual") {
      // No signaling to report in manual mode — say what the link is doing.
      const peers = net.peerCount();
      const label = {
        idle: "WAITING FOR A CODE",
        gathering: "BUILDING CODE…",
        "awaiting-reply": "WAITING FOR THE REPLY CODE",
        connecting: "CONNECTING DIRECTLY…",
        online: "DIRECT LINK UP",
        error: "LINK FAILED",
        closed: "LINK CLOSED",
      }[net.status] || net.status.toUpperCase();
      el.textContent = `MANUAL · ${label} · PEERS ${peers}/2`;
      el.className = "wr-diag" + (net.status === "error" ? " bad" : peers > 0 ? "" : " warn");
      return;
    }
    const { open, total } = net.relayStats();
    const peers = net.peerCount();
    let text = `SIGNALING ${open}/${total} RELAYS · PEERS ${peers}/2`;
    let cls = "wr-diag";
    if (total > 0 && open === 0) {
      text += " — NO RELAY REACHABLE FROM THIS NETWORK";
      cls += " bad";
    } else if (open > 0 && open < 3) {
      text += " — THIN SIGNALING PATH";
      cls += " warn";
    }
    el.textContent = text;
    el.className = cls;
  }

  /**
   * Shared transport wiring. Both the relay Net and the manual ManualLink
   * expose the same events, so the spawn gate, presence markers and remote
   * planes work identically on either — the game cannot tell them apart.
   */
  function attachHandlers(link) {
    link
      .on("onStatus", (status, error) => {
        refreshBadge();
        if (status === "online") {
          setStatus(ui.wrStatusEl, "Connected directly — no server involved.", "ok");
          updateWaitingRoom();
        } else if (status === "error") {
          setStatus(ui.wrStatusEl, error || "Connection failed.", "error");
        } else if (status === "connecting" && link._lastStatusMessage) {
          setStatus(ui.wrStatusEl, link._lastStatusMessage, "busy");
        }
      })
      .on("onRetry", (attempt, max) => {
        setStatus(ui.wrStatusEl, `Connection attempt ${attempt} of ${max} failed — retrying…`, "busy");
        updateWaitingRoom();
      })
      .on("onPeerJoin", (peerId) => {
        partnerLeft = false;
        knownPeers.add(peerId);
        updateWaitingRoom();
        setStatus(ui.wrStatusEl, "Player joined — starting spawn selection…", "ok");
        setTimeout(() => {
          if (active && phase === "waiting") beginSpawnPhase();
        }, 600);
      })
      .on("onPeerLeave", (peerId) => {
        knownPeers.delete(peerId);
        remotePlanes.remove(peerId);
        spawnPresence.remove(peerId);
        updateWaitingRoom();
        if (phase === "waiting") {
          setStatus(ui.wrStatusEl, "Player left the party.", "error");
        } else if (phase === "spawn") {
          spawnPlaced = false;
          partnerLeft = true;
          updateSpawnGate();
          setStatus(ui.wrStatusEl, "Partner disconnected.", "error");
        } else {
          setStatus(ui.wrStatusEl, "Partner disconnected.", "error");
        }
        refreshBadge();
      })
      .on("onState", (peerId, data, peer) => {
        knownPeers.add(peerId);
        remotePlanes.setState(peerId, data);
        if (peer.callsign) remotePlanes.setCallsign(peerId, peer.callsign);
      })
      .on("onSpawn", (peerId, data, peer) => {
        knownPeers.add(peerId);
        spawnPresence.setPresence(peerId, data);
        if (peer.callsign) spawnPresence.setCallsign(peerId, peer.callsign);
        updateSpawnGate();
      })
      .on("onHello", (peerId, callsign) => {
        remotePlanes.setCallsign(peerId, callsign);
        spawnPresence.setCallsign(peerId, callsign);
        updateWaitingRoom();
      })
      .on("onBack", () => goBackToPicking());
  }

  // ── Party start: no server, no relays — two codes exchanged by hand ─────
  /**
   * Because "join by code" is the manual WebRTC exchange, CREATE PARTY and
   * JOIN lead into the same waiting room with different roles: the host shows
   * an invite and pastes a reply, the joiner pastes an invite and shows a
   * reply. Both end at the identical spawn flow.
   */
  function beginManualParty() {
    active = true;
    phase = "waiting";
    spawnPlaced = false;
    partnerLeft = false;
    knownPeers = new Set();
    roomCode = "MANUAL";
    showScreen("waiting");
    setStatus(ui.wrStatusEl, "");
    updateWaitingRoom();
  }

  function setWaitingRole(role) {
    if (ui.wrHostBlock) ui.wrHostBlock.classList.toggle("hidden", role !== "host");
    if (ui.wrJoinBlock) ui.wrJoinBlock.classList.toggle("hidden", role !== "joiner");
    if (ui.wrRoleEl) {
      ui.wrRoleEl.textContent = role === "host" ? "STEP 1 OF 2 — SHARE YOUR INVITE" : "YOUR MOVE — SEND THE REPLY";
    }
  }

  function myCallsign() {
    return (ui.mpCallsign?.value || "PILOT").trim().slice(0, 14) || "PILOT";
  }

  /** CREATE PARTY — build an invite code, then wait for the reply. */
  async function hostParty() {
    beginManualParty();
    setWaitingRole("host");
    if (ui.wrInviteOut) ui.wrInviteOut.value = "";
    if (ui.wrReplyIn) ui.wrReplyIn.value = "";
    net = new ManualLink();
    attachHandlers(net);
    setStatus(ui.wrStatusEl, "Building your invite code…", "busy");
    try {
      const code = await net.createInvite(myCallsign());
      if (ui.wrInviteOut) ui.wrInviteOut.value = code;
      setStatus(ui.wrStatusEl, "Send your invite, then paste the reply you get back.", "ok");
    } catch (e) {
      setStatus(ui.wrStatusEl, "Could not build an invite: " + e.message, "error");
    }
  }

  /** JOIN — read the host's invite and produce the reply to send back. */
  async function joinParty(inviteCode) {
    if (!looksLikeCode(inviteCode)) {
      setStatus(ui.mpStatusEl, "That does not look like a Skyward invite code.", "error");
      return;
    }
    beginManualParty();
    setWaitingRole("joiner");
    if (ui.wrReplyOut) ui.wrReplyOut.value = "";
    net = new ManualLink();
    attachHandlers(net);
    setStatus(ui.wrStatusEl, "Reading the invite…", "busy");
    try {
      const reply = await net.acceptInvite(inviteCode, myCallsign());
      if (ui.wrReplyOut) ui.wrReplyOut.value = reply;
      setStatus(ui.wrStatusEl, "Send this reply back to the host — you connect as soon as they paste it.", "ok");
    } catch (e) {
      setStatus(ui.wrStatusEl, "Could not read that invite: " + e.message, "error");
    }
  }

  /** HOST step 2 — paste the joiner's reply to finish the handshake. */
  async function finishHostHandshake() {
    const reply = (ui.wrReplyIn?.value || "").trim();
    if (!looksLikeCode(reply)) {
      setStatus(ui.wrStatusEl, "That does not look like a reply code.", "error");
      return;
    }
    setStatus(ui.wrStatusEl, "Connecting…", "busy");
    try {
      await net.acceptReply(reply);
    } catch (e) {
      setStatus(ui.wrStatusEl, "Could not read that reply: " + e.message, "error");
    }
  }

  function beginSpawnPhase() {
    phase = "spawn";
    spawnPlaced = false;
    partnerLeft = false;
    presenceTimer = 0;
    if (ui.waitingRoom) ui.waitingRoom.classList.add("hidden");
    ctx.enterSpawnPicking(true);
    setStatus(ui.wrStatusEl, "", "");
    refreshBadge();
    updateSpawnGate();
    // enterSpawnPicking's transition timer rewrites the instruction text
    // 500 ms in — reassert the multiplayer wording just after it.
    setTimeout(() => {
      if (active && phase === "spawn") updateSpawnGate();
    }, 620);
    broadcastSpawn();
  }

  function bothSpawnPlaced() {
    if (!active) return true;
    if (net.peerCount() === 0) return false;
    if (!spawnPlaced) return false;
    for (const peer of net.activePeers()) {
      if (!spawnPresence.hasPlaced(peer.id)) return false;
    }
    return true;
  }

  function updateSpawnGate() {
    const btn = dom.confirmSpawnBtn;
    if (!btn) return;
    if (!active) {
      btn.disabled = false;
      btn.classList.remove("mp-waiting");
      return;
    }
    if (!spawnPlaced) {
      btn.classList.add("hidden");
      btn.disabled = true;
      btn.classList.remove("mp-waiting");
      if (dom.instructionText) {
        dom.instructionText.textContent = "PICK YOUR SPAWN — BOTH PLAYERS MUST CHOOSE BEFORE LAUNCH";
      }
      return;
    }
    const ready = bothSpawnPlaced();
    btn.classList.remove("hidden");
    btn.disabled = !ready;
    btn.classList.toggle("mp-waiting", !ready);
    if (dom.instructionText) {
      if (partnerLeft) {
        dom.instructionText.textContent = "YOUR PARTNER LEFT — WAITING FOR A PLAYER TO REJOIN";
      } else if (ready) {
        dom.instructionText.textContent = "BOTH PLAYERS READY — LAUNCH WHEN YOU ARE";
      } else {
        const waiting = net.activePeers().filter((p) => !spawnPresence.hasPlaced(p.id));
        dom.instructionText.textContent = waiting.length
          ? `WAITING FOR ${(waiting[0].callsign || "PARTNER").toUpperCase()} TO PICK A SPAWN`
          : "WAITING FOR YOUR PARTNER TO CONNECT";
      }
    }
  }

  function broadcastSpawn() {
    if (!active || !net) return;
    try {
      const carto = ctx.viewer.camera.positionCartographic;
      net.broadcastSpawn({
        camLon: carto ? ctx.Cesium.Math.toDegrees(carto.longitude) : null,
        camLat: carto ? ctx.Cesium.Math.toDegrees(carto.latitude) : null,
        lon: spawnPlaced ? state.lon : null,
        lat: spawnPlaced ? state.lat : null,
        placed: spawnPlaced,
      });
    } catch (e) { /* presence is best-effort */ }
  }

  function noteSpawnPlaced() {
    if (!active) return;
    spawnPlaced = true;
    broadcastSpawn();
    updateSpawnGate();
  }

  function leaveParty() {
    const had = active;
    active = false;
    phase = "idle";
    spawnPlaced = false;
    partnerLeft = false;
    knownPeers = new Set();
    remotePlanes.clear();
    spawnPresence.clear();
    net.leave();
    roomCode = null;
    refreshBadge();
    applyPerformance(ctx, false);
    if (dom.confirmSpawnBtn) {
      dom.confirmSpawnBtn.disabled = false;
      dom.confirmSpawnBtn.classList.remove("mp-waiting");
    }
    if (had) showScreen("menu");
  }

  /** Partner went back to picking: follow, whatever state I am in. */
  function goBackToPicking() {
    if (!active) return;
    if (ctx.isPickSpawn()) {
      updateSpawnGate();
      return;
    }
    if (dom.pauseMenu) dom.pauseMenu.classList.add("hidden");
    spawnPlaced = false;
    partnerLeft = false;
    remotePlanes.clear();
    phase = "spawn";
    ctx.enterSpawnPicking(true);
    broadcastSpawn();
    updateSpawnGate();
    setTimeout(() => {
      if (active && phase === "spawn") updateSpawnGate();
    }, 620);
  }

  // ── Minimap peer markers (moved out of ui/hud.js so it lives here) ──
  function drawMinimap() {
    const canvas = dom.minimapCanvas;
    if (!canvas) return;
    const c2d = canvas.getContext("2d");
    if (!c2d) return;
    const peers = [];
    for (const peerId of knownPeers) {
      const live = remotePlanes.getLive(peerId);
      if (!live) continue;
      const info = net.peers.get(peerId);
      peers.push({ lon: live.lon, lat: live.lat, callsign: info?.callsign || "PILOT" });
    }
    if (!peers.length) return;

    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(cx, cy) - 10;
    const heading = state.minimapHeading ?? 0;
    const rangeKm = (state.minimapRange || 1000) / 1000;
    const zoomAlt = state.minimapZoom || rangeKm * 1500;
    const pixelsPerMeter = h / (zoomAlt * 1.1547);
    const hdg = (heading * Math.PI) / 180;
    const cosLat = Math.cos((state.lat * Math.PI) / 180);

    c2d.font = "bold 9px monospace";
    for (const peer of peers) {
      if (!Number.isFinite(peer.lon) || !Number.isFinite(peer.lat)) continue;
      const dxm = (peer.lon - state.lon) * 111320 * cosLat;
      const dym = (peer.lat - state.lat) * 111320;
      const rx = dxm * Math.cos(hdg) - dym * Math.sin(hdg);
      const ry = -dxm * Math.sin(hdg) - dym * Math.cos(hdg);
      const px = rx * pixelsPerMeter;
      const py = ry * pixelsPerMeter;
      const dist = Math.sqrt(px * px + py * py);
      if (dist < radius - 8) {
        c2d.fillStyle = "#f00";
        c2d.beginPath();
        c2d.arc(cx + px, cy + py, 5, 0, Math.PI * 2);
        c2d.fill();
        c2d.strokeStyle = "#fff";
        c2d.lineWidth = 1.5;
        c2d.stroke();
        c2d.fillStyle = "#fff";
        c2d.textAlign = "left";
        c2d.textBaseline = "middle";
        c2d.fillText(String(peer.callsign).slice(0, 8), cx + px + 8, cy + py);
      } else {
        const a = Math.atan2(px, -py);
        const ex = cx + Math.sin(a) * (radius - 12);
        const ey = cy - Math.cos(a) * (radius - 12);
        c2d.save();
        c2d.translate(ex, ey);
        c2d.rotate(a);
        c2d.fillStyle = "#f00";
        c2d.beginPath();
        c2d.moveTo(0, -9); c2d.lineTo(7, 7); c2d.lineTo(-7, 7);
        c2d.closePath();
        c2d.fill();
        c2d.restore();
        c2d.fillStyle = "#f00";
        c2d.textAlign = "center";
        c2d.textBaseline = "bottom";
        c2d.fillText(String(peer.callsign).slice(0, 8), ex, ey - 11);
      }
    }
  }

  // ── Per-frame tick: called by the host from its FLYING render loop ──
  function tick(dt) {
    if (!active) return;
    try {
      // Remote motion is reconstructed from buffered snapshots; pass the
      // local clock so it can place each plane on the sender's timeline.
      remotePlanes.update(dt, performance.now());
    } catch (e) { /* multiplayer is best-effort; never break flight */ }
  }

  // ── Presence + gate run in EVERY state (the picker is not a flying one) ──
  setInterval(() => {
    if (!active) return;
    updateDiag();
    refreshBadge();
    if (phase !== "spawn") return;
    broadcastSpawn();
    updateSpawnGate();
  }, 300);

  // Steady flight-state broadcast, on its own timer rather than the render
  // loop: a dropped frame must not create a gap in everyone else's view of
  // you, and the peer needs a regular stream to interpolate smoothly.
  setInterval(() => {
    if (!active || phase !== "flying") return;
    try { net.broadcastState({ ...state }); } catch (e) { /* best effort */ }
  }, 1000 / STATE_HZ);

  // ── UI events (all inside this module) ──
  try {
    ui.mpCallsign.value = localStorage.getItem("skywardCallsign") || "";
  } catch (e) { /* storage unavailable */ }
  ui.mpCallsign?.addEventListener("input", () => {
    try { localStorage.setItem("skywardCallsign", ui.mpCallsign.value); } catch (e) { /* cosmetic */ }
  });
  ui.mpCallsign?.addEventListener("keydown", (e) => e.stopPropagation());
  ui.mpCodeInput?.addEventListener("keydown", (e) => e.stopPropagation());

  ui.mpBtn?.addEventListener("click", () => {
    showScreen("lobby");
    setStatus(ui.mpStatusEl, "");
  });
  ui.mpBackBtn?.addEventListener("click", () => showScreen("menu"));

  // Lobby → the two halves of the manual (no-server) handshake.
  ui.mpCreateBtn?.addEventListener("click", () => hostParty());
  ui.mpJoinBtn?.addEventListener("click", () => {
    const code = (ui.mpCodeInput?.value || "").trim();
    if (!code) {
      setStatus(ui.mpStatusEl, "Paste the invite code you were sent first.", "error");
      return;
    }
    joinParty(code);
  });
  ui.mpCodeInput?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const code = (ui.mpCodeInput.value || "").trim();
    if (code) joinParty(code);
  });

  const copyFrom = async (el, btn, doneLabel) => {
    const text = (el?.value || "").trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      if (btn) {
        const was = btn.textContent;
        btn.textContent = doneLabel;
        setTimeout(() => { btn.textContent = was; }, 1500);
      }
    } catch (e) {
      // Clipboard can be blocked; the field is selectable as a fallback.
      el?.select?.();
    }
  };
  ui.wrCopyInvite?.addEventListener("click", () => copyFrom(ui.wrInviteOut, ui.wrCopyInvite, "COPIED"));
  ui.wrCopyReply?.addEventListener("click", () => copyFrom(ui.wrReplyOut, ui.wrCopyReply, "COPIED"));
  ui.wrConnectBtn?.addEventListener("click", () => finishHostHandshake());
  ui.wrReplyIn?.addEventListener("keydown", (e) => e.stopPropagation());
  // Clicking a code field selects it, so a blocked clipboard is not a dead end.
  ui.wrInviteOut?.addEventListener("click", (e) => e.target.select?.());
  ui.wrReplyOut?.addEventListener("click", (e) => e.target.select?.());
  ui.wrLeaveBtn?.addEventListener("click", () => leaveParty());

  return {
    isActive: () => active,
    bothSpawnPlaced,
    noteSpawnPlaced,
    goBackToPicking,
    leaveParty,
    onFlightStart() {
      // Flight phase begins: presence markers hand off to live remote
      // planes and the performance diet turns on.
      if (!active) return;
      phase = "flying";
      spawnPresence.clear();
      applyPerformance(ctx, true);
      refreshBadge();
    },
    tick,
    drawMinimap,
  };
}
