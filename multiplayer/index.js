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
import { Net, generateRoomCode, normalizeRoomCode } from "./net.js";
import { createRemotePlanes } from "./remotePlanes.js";
import { createSpawnPresence } from "./spawnPresence.js";
import { buildMpUi } from "./ui.js";

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

  const net = new Net();
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
  let fpsSamples = [];
  let perfForced = false;
  let perfCooldown = 0;

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
    if (ui.wrCodeEl) ui.wrCodeEl.textContent = roomCode || "-----";
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

  async function startParty(code, callsign) {
    roomCode = normalizeRoomCode(code);
    active = true;
    phase = "waiting";
    spawnPlaced = false;
    partnerLeft = false;
    knownPeers = new Set();

    showScreen("waiting");
    updateWaitingRoom();
    setStatus(ui.wrStatusEl, "Connecting to matchmaking…", "busy");

    net
      .on("onStatus", (status, error) => {
        refreshBadge();
        if (status === "online") {
          setStatus(ui.wrStatusEl, "Connected — share your code.", "ok");
          updateWaitingRoom();
        } else if (status === "error") {
          // Say WHY, with the relay count, so a blocked network is obvious.
          const { open, total } = net.relayStats();
          let msg = error || "Connection failed.";
          if (total > 0 && open === 0) {
            msg += " No signaling relay is reachable from this network.";
          } else if (net.peerCount() === 0) {
            msg += ` Signaling is fine (${open}/${total} relays) — the two` +
              " networks could not reach each other directly (often a" +
              " restrictive NAT). Try a different network, or a phone hotspot.";
          }
          setStatus(ui.wrStatusEl, msg, "error");
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
      });

    const ok = await net.connect(roomCode, callsign);
    if (!ok) {
      setStatus(ui.wrStatusEl, net.error || "Could not connect.", "error");
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
      remotePlanes.update(dt);
      // Adaptive quality: drop detail if frames sag, restore with headroom.
      if (dt > 0) fpsSamples.push(1 / dt);
      if (fpsSamples.length >= 90) {
        const avg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;
        fpsSamples = [];
        if (perfCooldown <= 0) {
          if (avg < 45 && !perfForced) {
            perfForced = true;
            applyPerformance(ctx, true);
            perfCooldown = 10;
          } else if (avg > 58 && perfForced) {
            perfForced = false;
            applyPerformance(ctx, false);
            perfCooldown = 10;
          }
        }
      }
      perfCooldown -= dt;

      // Broadcast flight state (rate-limited inside net) after the sim step.
      net.broadcastState({ ...state, isFlying: true });
      refreshBadge();
    } catch (e) { /* multiplayer is best-effort; never break flight */ }
  }

  // ── Presence + gate run in EVERY state (the picker is not a flying one) ──
  setInterval(() => {
    if (!active) return;
    updateDiag();
    if (phase !== "spawn") return;
    broadcastSpawn();
    updateSpawnGate();
  }, 300);

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
  ui.mpCreateBtn?.addEventListener("click", () => {
    startParty(generateRoomCode(), ui.mpCallsign?.value || "PILOT");
  });
  ui.mpJoinBtn?.addEventListener("click", () => {
    const code = normalizeRoomCode(ui.mpCodeInput?.value);
    if (!code) {
      setStatus(ui.mpStatusEl, "Enter a 5-character party code first.", "error");
      return;
    }
    startParty(code, ui.mpCallsign?.value || "PILOT");
  });
  ui.mpCodeInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const code = normalizeRoomCode(ui.mpCodeInput.value);
      if (code) startParty(code, ui.mpCallsign?.value || "PILOT");
    }
  });
  ui.wrCopyBtn?.addEventListener("click", async () => {
    if (!roomCode) return;
    try {
      await navigator.clipboard.writeText(roomCode);
      ui.wrCopyBtn.textContent = "COPIED";
      setTimeout(() => { if (ui.wrCopyBtn) ui.wrCopyBtn.textContent = "COPY"; }, 1500);
    } catch (e) {
      setStatus(ui.wrStatusEl, `Code: ${roomCode} — write it down.`, "busy");
    }
  });
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
