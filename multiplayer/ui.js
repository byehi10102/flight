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
          <button id="mpManualBtn" class="menu-btn menu-btn-ghost">MANUAL CONNECT (NO SERVER)</button>
          <button id="mpBackBtn" class="menu-btn menu-btn-ghost">BACK</button>
        </div>
      </div>`;
    document.body.appendChild(mpPanel);
  }

  // Manual (copy/paste) connect — no server, no relays.
  let manualPanel = document.getElementById("manualPanel");
  if (!manualPanel) {
    manualPanel = document.createElement("div");
    manualPanel.id = "manualPanel";
    manualPanel.className = "overlay hidden";
    manualPanel.innerHTML = `
      <div class="menu-container wide">
        <div class="menu-content">
          <div class="menu-header">
            <span class="logo-main">MANUAL CONNECT</span>
            <span class="logo-sub">NO SERVER · CODE EXCHANGE</span>
          </div>
          <p class="menu-desc">Swap two text codes by any means (Discord, SMS, email).
            Nothing of ours is involved — the two browsers talk directly.</p>

          <div class="mn-cols">
            <div class="mn-col">
              <div class="mn-title">HOST</div>
              <div class="mn-step">1. Create an invite, send it to your friend</div>
              <button id="mnCreateBtn" class="menu-btn">CREATE INVITE</button>
              <textarea id="mnInviteOut" class="mn-code" readonly placeholder="invite code appears here"></textarea>
              <button id="mnCopyInvite" class="wr-copy">COPY INVITE</button>
              <div class="mn-step">2. Paste the reply they send back</div>
              <textarea id="mnReplyIn" class="mn-code" placeholder="paste their reply code here"></textarea>
              <button id="mnFinishBtn" class="menu-btn">CONNECT</button>
            </div>

            <div class="mn-col">
              <div class="mn-title">JOINER</div>
              <div class="mn-step">1. Paste the invite you were sent</div>
              <textarea id="mnInviteIn" class="mn-code" placeholder="paste the invite code here"></textarea>
              <button id="mnReplyBtn" class="menu-btn">GENERATE REPLY</button>
              <div class="mn-step">2. Send this reply back to the host</div>
              <textarea id="mnReplyOut" class="mn-code" readonly placeholder="reply code appears here"></textarea>
              <button id="mnCopyReply" class="wr-copy">COPY REPLY</button>
            </div>
          </div>

          <div id="mnStatus" class="mp-status"></div>
          <button id="mnBackBtn" class="menu-btn menu-btn-ghost">BACK</button>
        </div>
      </div>`;
    document.body.appendChild(manualPanel);
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
          <div id="wrDiag" class="wr-diag"></div>
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
    manualPanel,
    waitingRoom,
    badge,
    mpCallsign: document.getElementById("mpCallsign"),
    mpCreateBtn: document.getElementById("mpCreateBtn"),
    mpJoinBtn: document.getElementById("mpJoinBtn"),
    mpCodeInput: document.getElementById("mpCodeInput"),
    mpStatusEl: document.getElementById("mpStatus"),
    mpBackBtn: document.getElementById("mpBackBtn"),
    mpManualBtn: document.getElementById("mpManualBtn"),
    mnCreateBtn: document.getElementById("mnCreateBtn"),
    mnInviteOut: document.getElementById("mnInviteOut"),
    mnCopyInvite: document.getElementById("mnCopyInvite"),
    mnReplyIn: document.getElementById("mnReplyIn"),
    mnFinishBtn: document.getElementById("mnFinishBtn"),
    mnInviteIn: document.getElementById("mnInviteIn"),
    mnReplyBtn: document.getElementById("mnReplyBtn"),
    mnReplyOut: document.getElementById("mnReplyOut"),
    mnCopyReply: document.getElementById("mnCopyReply"),
    mnStatusEl: document.getElementById("mnStatus"),
    mnBackBtn: document.getElementById("mnBackBtn"),
    wrCodeEl: document.getElementById("wrCode"),
    wrCopyBtn: document.getElementById("wrCopyBtn"),
    wrSelfEl: document.getElementById("wrSelf"),
    wrPeerEl: document.getElementById("wrPeer"),
    wrStatusEl: document.getElementById("wrStatus"),
    wrDiagEl: document.getElementById("wrDiag"),
    wrLeaveBtn: document.getElementById("wrLeaveBtn"),
    badgeStatus: document.getElementById("mp-badge-status"),
    badgePeers: document.getElementById("mp-badge-peers"),
  };
}
