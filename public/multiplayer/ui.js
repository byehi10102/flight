/**
 * Multiplayer DOM: mode button, lobby, waiting room, HUD badge.
 *
 * Everything is built dynamically so the whole feature lives in this
 * folder — deleting public/multiplayer/ removes every trace of it and the
 * game falls back to single player (the host app guards its calls with
 * optional chaining on the init handle).
 */

export function buildMpUi(ctx) {
  // Stylesheet (raw file in this folder; a JS import would be parsed as
  // JavaScript here because nothing bundles public/ files).
  if (!document.getElementById("mp-style")) {
    const link = document.createElement("link");
    link.id = "mp-style";
    link.rel = "stylesheet";
    link.href = "/multiplayer/style.css";
    document.head.appendChild(link);
  }

  // Mode button, injected into the slot the main menu reserves.
  let mpBtn = null;
  const slot = document.getElementById("mp-slot");
  if (slot && !slot.querySelector("#mpBtn")) {
    mpBtn = document.createElement("button");
    mpBtn.id = "mpBtn";
    mpBtn.className = "menu-btn menu-btn-secondary";
    mpBtn.innerHTML = 'MULTIPLAYER <span class="beta-tag">BETA</span>';
    slot.appendChild(mpBtn);
  }

  // Lobby: create or join a party.
  let mpPanel = document.getElementById("mpPanel");
  if (!mpPanel) {
    mpPanel = document.createElement("div");
    mpPanel.id = "mpPanel";
    mpPanel.className = "overlay hidden";
    mpPanel.innerHTML = `
      <div class="menu-container">
        <div class="menu-content">
          <div class="menu-header">
            <span class="logo-main">MULTIPLAYER</span>
            <span class="logo-sub">BETA</span>
          </div>
          <p class="menu-desc">Peer-to-peer — the code is the only thing you share. No accounts, no servers holding your flight.</p>
          <label class="mp-field">
            <span class="mp-field-label">CALLSIGN</span>
            <input id="mpCallsign" type="text" maxlength="14" placeholder="PILOT" autocomplete="off" />
          </label>
          <div class="mp-actions">
            <button id="mpCreateBtn" class="menu-btn">CREATE PARTY</button>
            <div class="mp-or"><span>OR JOIN WITH A CODE</span></div>
            <div class="mp-join-row">
              <input id="mpCodeInput" type="text" maxlength="5" placeholder="CODE" autocomplete="off" />
              <button id="mpJoinBtn" class="menu-btn">JOIN</button>
            </div>
          </div>
          <div id="mpStatus" class="mp-status"></div>
          <button id="mpBackBtn" class="menu-btn menu-btn-ghost">BACK</button>
        </div>
      </div>`;
    document.body.appendChild(mpPanel);
  }

  // Waiting room.
  let waitingRoom = document.getElementById("waitingRoom");
  if (!waitingRoom) {
    waitingRoom = document.createElement("div");
    waitingRoom.id = "waitingRoom";
    waitingRoom.className = "overlay hidden";
    waitingRoom.innerHTML = `
      <div class="menu-container">
        <div class="menu-content">
          <div class="menu-header">
            <span class="logo-main">PARTY</span>
            <span class="logo-sub">WAITING ROOM</span>
          </div>
          <div class="wr-code-block">
            <span class="wr-label">ROOM CODE</span>
            <div class="wr-code">
              <span id="wrCode">-----</span>
              <button id="wrCopyBtn" class="wr-copy" title="Copy code">COPY</button>
            </div>
            <span class="wr-hint">Your partner enters this under MULTIPLAYER → JOIN.</span>
          </div>
          <div class="wr-players">
            <div id="wrSelf" class="wr-player">YOU</div>
            <div id="wrPeer" class="wr-player wr-peer-empty">WAITING FOR PLAYER…</div>
          </div>
          <div id="wrStatus" class="mp-status"></div>
          <button id="wrLeaveBtn" class="menu-btn menu-btn-ghost">LEAVE PARTY</button>
        </div>
      </div>`;
    document.body.appendChild(waitingRoom);
  }

  // In-flight badge (lives in the HUD container so Hide UI hides it too).
  let badge = document.getElementById("mp-badge");
  if (!badge && ctx.dom.uiContainer) {
    badge = document.createElement("div");
    badge.id = "mp-badge";
    badge.className = "hidden";
    badge.innerHTML = '<span id="mp-badge-status">MP</span><span id="mp-badge-peers">0</span>';
    ctx.dom.uiContainer.appendChild(badge);
  }

  return {
    mpBtn,
    mpPanel,
    waitingRoom,
    badge,
    mpCallsign: document.getElementById("mpCallsign"),
    mpCreateBtn: document.getElementById("mpCreateBtn"),
    mpJoinBtn: document.getElementById("mpJoinBtn"),
    mpCodeInput: document.getElementById("mpCodeInput"),
    mpStatusEl: document.getElementById("mpStatus"),
    mpBackBtn: document.getElementById("mpBackBtn"),
    wrCodeEl: document.getElementById("wrCode"),
    wrCopyBtn: document.getElementById("wrCopyBtn"),
    wrSelfEl: document.getElementById("wrSelf"),
    wrPeerEl: document.getElementById("wrPeer"),
    wrStatusEl: document.getElementById("wrStatus"),
    wrLeaveBtn: document.getElementById("wrLeaveBtn"),
    badgeStatus: document.getElementById("mp-badge-status"),
    badgePeers: document.getElementById("mp-badge-peers"),
  };
}
