/**
 * HUD — ported from dimartarmizi/web-flight-simulator src/ui/hud.js
 * (flight-display parts only: horizon + pitch ladder, compass tape,
 * speed/alt/heading/coords, region + pull-up warnings, tactical minimap,
 * UI tilt/shake). Weapon/NPC systems omitted — this repo has no weapon or
 * NPC systems, so those calls are guarded out. The tactical minimap pairs a
 * live Cesium top-down view (like ref-flight) with the canvas overlay.
 *
 * Public API kept compatible with src/main.js:
 *   update(state, now), showRegion(name), setPullUpWarning(bool),
 *   updateMinimap(state), resetScore(), resetTime(), resizeMinimap()
 */
import { getViewer } from "../core/viewer.js";
export class Hud {
  constructor() {
    this.speedEl = document.getElementById("speed");
    this.altEl = document.getElementById("altitude");
    this.headingEl = document.getElementById("heading-display");
    this.coordsEl = document.getElementById("coords");
    this.compassTape = document.getElementById("compass-tape");
    this.regionNotification = document.getElementById("region-notification");
    this.regionName = document.getElementById("region-name");
    this.pullUpWarning = document.getElementById("pull-up-warning");
    this.timeEl = document.getElementById("time");
    this.fpsEl = document.getElementById("fps");
    this.scoreEl = document.getElementById("score");
    this.localDatetimeEl = document.getElementById("local-datetime");
    this.statusEl = document.getElementById("hud-status");
    this.boostFill = document.getElementById("boost-fill");
    this.boostLabel = document.getElementById("boost-label");
    this.uiContainer = document.getElementById("uiContainer");
    this.vignette = document.getElementById("transition-vignette");

    this.minimapCanvas = document.getElementById("minimap");
    this.minimapCtx = this.minimapCanvas ? this.minimapCanvas.getContext("2d") : null;

    this.startTime = Date.now();
    this._last = 0;
    this._fpsFrames = 0;
    this._fpsLast = performance.now();
    this._score = 0;
    this.regionTimeout = null;

    // Smoothed attitude (ref-flight): HUD eases toward true state so the
    // ladder/compass visibly track the controls instead of snapping.
    this.smoothedPitch = 0;
    this.smoothedRoll = 0;
    this.smoothedHeading = 0;
    this.smoothedThrottle = 0;
    this.smoothedYaw = 0;
    this.smoothedBoostScale = 1.0;
    this.currentShakeX = 0;
    this.currentShakeY = 0;

    this.createHorizon();
    this.createCompass();
  }

  // â”€â”€ Horizon: crosshair + pitch ladder, rotated/translated by attitude â”€â”€
  createHorizon() {
    if (document.getElementById("horizon-container")) return;
    const ui = document.getElementById("uiContainer");
    if (!ui) return;

    const horizon = document.createElement("div");
    horizon.id = "horizon-container";

    const crosshair = document.createElement("div");
    crosshair.id = "normal-crosshair";

    const ring = document.createElement("div");
    ring.className = "xh-ring";
    const leftLine = document.createElement("div");
    leftLine.className = "xh-left";
    const rightLine = document.createElement("div");
    rightLine.className = "xh-right";
    const topTick = document.createElement("div");
    topTick.className = "xh-top";

    crosshair.appendChild(leftLine);
    crosshair.appendChild(rightLine);
    crosshair.appendChild(ring);
    crosshair.appendChild(topTick);
    horizon.appendChild(crosshair);

    const pitchLines = document.createElement("div");
    pitchLines.id = "pitch-lines";
    for (let i = -90; i <= 90; i += 10) {
      if (i === 0) continue;
      const line = document.createElement("div");
      line.className = "pitch-line";
      line.style.top = `${50 - i}%`;
      line.innerText = String(i);
      pitchLines.appendChild(line);
    }

    // Attitude panel: fixed bottom-right corner box holding the sliding
    // ladder plus a static center reference line so pitch reads against it.
    const panel = document.createElement("div");
    panel.id = "attitude-panel";
    panel.appendChild(pitchLines);
    const refLine = document.createElement("div");
    refLine.id = "pitch-ref";
    const refLabel = document.createElement("span");
    refLabel.innerText = "0";
    refLine.appendChild(refLabel);
    panel.appendChild(refLine);
    ui.appendChild(panel);
  }

  // â”€â”€ Compass tape: 5Â° steps, 4px/deg, N/E/S/W labels (ref-flight) â”€â”€
  createCompass() {
    if (!this.compassTape) return;
    const step = 5;
    const pixelsPerDegree = 4;
    this.compassTape.innerHTML = "";
    for (let i = -360; i <= 720; i += step) {
      const tick = document.createElement("div");
      tick.className = "compass-tick";
      const isMajor = i % 10 === 0;
      tick.style.left = `${(i + 360) * pixelsPerDegree}px`;
      tick.style.height = isMajor ? "10px" : "5px";
      if (isMajor) {
        const label = document.createElement("div");
        label.className = "compass-label";
        label.style.left = `${(i + 360) * pixelsPerDegree}px`;
        let degree = i % 360;
        if (degree < 0) degree += 360;
        let text = String(Math.round(degree)).padStart(3, "0");
        if (Math.round(degree) === 0 || Math.round(degree) === 360) text = "N";
        else if (Math.round(degree) === 90) text = "E";
        else if (Math.round(degree) === 180) text = "S";
        else if (Math.round(degree) === 270) text = "W";
        label.innerText = text;
        this.compassTape.appendChild(label);
      }
      this.compassTape.appendChild(tick);
    }
  }

  resetTime() {
    this.startTime = Date.now();
  }

  resizeMinimap() {
    // No Cesium mini-viewer in this repo; canvas sizes itself in updateMinimap.
  }

  resetScore() {
    this._score = 0;
    if (this.scoreEl) this.scoreEl.textContent = "000000";
  }

  showRegion(name) {
    if (!this.regionNotification || !this.regionName) return;
    if (this.regionTimeout) clearTimeout(this.regionTimeout);
    this.regionName.innerText = name;
    this.regionNotification.classList.remove("hidden");
    this.regionNotification.classList.remove("region-exit");
    this.regionTimeout = setTimeout(() => {
      this.regionNotification.classList.add("region-exit");
      this.regionTimeout = setTimeout(() => {
        this.regionNotification.classList.add("hidden");
        this.regionTimeout = null;
      }, 1000);
    }, 4000);
  }

  setPullUpWarning(show) {
    if (this.pullUpWarning) {
      this.pullUpWarning.classList.toggle("hidden", !show);
    }
  }

  update(state, now) {
    const t = now ?? performance.now();
    if (t - this._last < 100) return;
    this._last = t;

    // â”€â”€ Smooth attitude toward true state (ref-flight lerp) â”€â”€
    const lerpFactor = 0.5;
    const lerpAngle = (current, target, factor) => {
      let diff = target - current;
      while (diff < -180) diff += 360;
      while (diff > 180) diff -= 360;
      return current + diff * factor;
    };
    const getAngleDiff = (target, current) => {
      let diff = target - current;
      while (diff < -180) diff += 360;
      while (diff > 180) diff -= 360;
      return diff;
    };
    const normalizeAngle = (a) => {
      while (a <= -180) a += 360;
      while (a > 180) a -= 360;
      return a;
    };

    this.smoothedPitch = normalizeAngle(lerpAngle(this.smoothedPitch, state.pitch, lerpFactor));
    this.smoothedRoll = normalizeAngle(lerpAngle(this.smoothedRoll, state.roll, lerpFactor));
    this.smoothedHeading = normalizeAngle(lerpAngle(this.smoothedHeading, state.heading || 0, lerpFactor));
    this.smoothedThrottle += ((state.throttle || 0) - this.smoothedThrottle) * (lerpFactor * 0.4);
    this.smoothedYaw += ((state.yaw || 0) - this.smoothedYaw) * lerpFactor;

    // â”€â”€ Boost vignette (flight only; transitions own the solid fade) â”€â”€
    const isBoosting = state.isBoosting || false;
    if (this.vignette && state.isFlying) {
      this.vignette.style.opacity = isBoosting ? "1" : "0";
    }

    // â”€â”€ UI tilt/shake: the whole HUD shifts with control deflection â”€â”€
    const pitchDiff = getAngleDiff(state.pitch, this.smoothedPitch);
    const rollDiff = getAngleDiff(state.roll, this.smoothedRoll);
    const yawDiff = (state.yaw || 0) - this.smoothedYaw;
    const throttleDiff = (state.throttle || 0) - this.smoothedThrottle;
    if (this.uiContainer) {
      const maxTilt = 15;
      const tiltX = Math.max(-maxTilt, Math.min(maxTilt, pitchDiff * 0.8));
      const tiltY = Math.max(-maxTilt, Math.min(maxTilt, -rollDiff * 0.3 + yawDiff * 5.0));
      const maxShift = 50;
      const shiftX = Math.max(-maxShift, Math.min(maxShift, -rollDiff * 1.5 - yawDiff * 20.0));
      const shiftY = Math.max(-maxShift, Math.min(maxShift, pitchDiff * 3.0 + throttleDiff * 15.0));
      const targetBoostScale = isBoosting ? 1.02 : 1.0;
      this.smoothedBoostScale += (targetBoostScale - this.smoothedBoostScale) * 0.1;
      const scale = (1 + throttleDiff * 0.25) * this.smoothedBoostScale;
      if (isBoosting) {
        const time = Date.now() * 0.05;
        this.currentShakeX = Math.sin(time * 1.5) * 2 + Math.cos(time * 2.1) * 1.5;
        this.currentShakeY = Math.cos(time * 1.7) * 2 + Math.sin(time * 2.3) * 1.5;
      } else {
        this.currentShakeX *= 0.85;
        this.currentShakeY *= 0.85;
      }
      this.uiContainer.style.transform =
        `perspective(1000px) rotateX(${tiltX}deg) rotateY(${tiltY}deg) ` +
        `translate(${shiftX + this.currentShakeX}px, ${shiftY + this.currentShakeY}px) scale(${scale})`;
    }

    // â”€â”€ Speed / altitude (ref-flight formatting) â”€â”€
    if (this.speedEl) this.speedEl.innerText = Math.round(state.speed).toString().padStart(3, "0");
    const altFeet = Math.max(0, Math.round((state.agl ?? state.alt) * 3.28084));
    if (this.altEl) this.altEl.innerText = altFeet.toString().padStart(5, "0");

    // â”€â”€ Heading + cardinal + compass tape â”€â”€
    let compassHeading = this.smoothedHeading;
    while (compassHeading < 0) compassHeading += 360;
    while (compassHeading >= 360) compassHeading -= 360;
    if (this.headingEl) {
      let displayHeading = Math.round(compassHeading);
      if (displayHeading === 360) displayHeading = 0;
      let cardinal = "";
      if (displayHeading >= 337.5 || displayHeading < 22.5) cardinal = "N";
      else if (displayHeading >= 22.5 && displayHeading < 67.5) cardinal = "NE";
      else if (displayHeading >= 67.5 && displayHeading < 112.5) cardinal = "E";
      else if (displayHeading >= 112.5 && displayHeading < 157.5) cardinal = "SE";
      else if (displayHeading >= 157.5 && displayHeading < 202.5) cardinal = "S";
      else if (displayHeading >= 202.5 && displayHeading < 247.5) cardinal = "SW";
      else if (displayHeading >= 247.5 && displayHeading < 292.5) cardinal = "W";
      else if (displayHeading >= 292.5 && displayHeading < 337.5) cardinal = "NW";
      this.headingEl.innerText = `${displayHeading.toString().padStart(3, "0")} ${cardinal}`;
    }
    if (this.compassTape) {
      const pixelsPerDegree = 4;
      const centerOffset = 160;
      const targetPosOnTape = (compassHeading + 360) * pixelsPerDegree;
      this.compassTape.style.transform = `translateX(${centerOffset - targetPosOnTape}px)`;
    }

    // â”€â”€ Score / mission time / local datetime / coords â”€â”€
    if (this.scoreEl) {
      if (typeof state.score === "number") {
        this.scoreEl.innerText = state.score.toString().padStart(6, "0");
      } else {
        this._score += Math.round(state.speed * 0.1);
        this.scoreEl.innerText = this._score.toString().padStart(6, "0");
      }
    }
    if (this.timeEl) {
      const elapsedMs = Date.now() - this.startTime;
      const m = Math.floor(elapsedMs / 60000);
      const s = Math.floor((elapsedMs % 60000) / 1000);
      const cs = Math.floor((elapsedMs % 1000) / 10);
      this.timeEl.innerText =
        `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}:${cs.toString().padStart(2, "0")}`;
    }
    if (this.localDatetimeEl) {
      const d = new Date();
      const utc = d.getTime() + d.getTimezoneOffset() * 60000;
      const tzOffsetHours = Math.round((state.lon || 0) / 15);
      const local = new Date(utc + 3600000 * tzOffsetHours);
      const yyyy = local.getFullYear();
      const mm = (local.getMonth() + 1).toString().padStart(2, "0");
      const dd = local.getDate().toString().padStart(2, "0");
      const hh = local.getHours().toString().padStart(2, "0");
      const mi = local.getMinutes().toString().padStart(2, "0");
      const ss = local.getSeconds().toString().padStart(2, "0");
      this.localDatetimeEl.innerText = `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}Z`;
    }
    if (this.coordsEl) {
      const latDir = state.lat >= 0 ? "N" : "S";
      const lonDir = state.lon >= 0 ? "E" : "W";
      this.coordsEl.innerText =
        `POS: ${Math.abs(state.lat).toFixed(4)}Â°${latDir} ${Math.abs(state.lon).toFixed(4)}Â°${lonDir}`;
    }
    if (this.statusEl) {
      const stallFactor = state.stallFactor || 0;
      this.statusEl.textContent = state.onGround
        ? (state.speed < 1 ? "PARKED" : "TAXIING")
        : stallFactor > 0.35 ? "STALL" : "AIRBORNE";
    }

    // â”€â”€ FPS â”€â”€
    this._fpsFrames++;
    if (t - this._fpsLast >= 1000) {
      const fps = (this._fpsFrames * 1000) / (t - this._fpsLast);
      if (this.fpsEl) this.fpsEl.textContent = Math.round(fps);
      this._fpsFrames = 0;
      this._fpsLast = t;
    }

    // â”€â”€ Boost meter: drains across one boost, refills right after â”€â”€
    const charge = Math.max(0, Math.min(1, state.boostCharge ?? 1));
    if (this.boostFill) {
      this.boostFill.style.width = `${Math.round(charge * 100)}%`;
      this.boostFill.classList.toggle("low", charge < 0.3);
      this.boostFill.classList.toggle("draining", !!state.isBoosting);
    }
    if (this.boostLabel) {
      this.boostLabel.innerText = state.isBoosting
        ? "BOOST"
        : charge >= 0.999 ? "BOOST READY" : `CHARGING ${Math.round(charge * 100)}%`;
    }

    // â”€â”€ Horizon follows smoothed attitude â”€â”€
    // The pitch ladder lives in its own bottom-right panel (out of the
    // center view); roll rotates the panel, pitch slides it vertically.
    const pitchLines = document.getElementById("pitch-lines");
    if (pitchLines) {
      pitchLines.style.transform =
        `rotate(${-this.smoothedRoll}deg) translateY(${this.smoothedPitch * 2}px)`;
    }
  }

  updateMinimap(state) {
    if (!this.minimapCtx || !this.minimapCanvas) return;
    const ctx = this.minimapCtx;
    const w = (this.minimapCanvas.width = 180);
    const h = (this.minimapCanvas.height = 180);
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(cx, cy) - 10;

    ctx.clearRect(0, 0, w, h);

    // Range rings scaled to the selected range (thirds of the view radius).
    ctx.strokeStyle = "rgba(0, 255, 0, 0.35)";
    ctx.lineWidth = 1;
    for (const rr of [radius / 3, (radius * 2) / 3, radius]) {
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Heading-rotated, meter-true grid (ref-flight): each line is exactly
    // one range-unit (rangeKm Ã— 1000 m), so grid matches the world scale.
    // `heading` is the SAME smoothed value driving the real-map camera.
    const heading = state.minimapHeading ?? this.smoothedHeading;
    const rangeKm = (state.minimapRange || 1000) / 1000;
    const zoomAlt = state.minimapZoom || rangeKm * 1500;
    const verticalMeters = zoomAlt * 1.1547;
    const pixelsPerMeter = h / verticalMeters;
    const metersPerGrid = rangeKm * 1000;
    const gridSize = (metersPerGrid * h) / verticalMeters;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((-heading * Math.PI) / 180);
    ctx.strokeStyle = "rgba(0, 255, 0, 0.35)";
    const gridLimit = radius * 2;
    for (let x = 0; x <= gridLimit; x += gridSize) {
      ctx.beginPath(); ctx.moveTo(x, -gridLimit); ctx.lineTo(x, gridLimit); ctx.stroke();
      if (x > 0) { ctx.beginPath(); ctx.moveTo(-x, -gridLimit); ctx.lineTo(-x, gridLimit); ctx.stroke(); }
    }
    for (let y = 0; y <= gridLimit; y += gridSize) {
      ctx.beginPath(); ctx.moveTo(-gridLimit, y); ctx.lineTo(gridLimit, y); ctx.stroke();
      if (y > 0) { ctx.beginPath(); ctx.moveTo(-gridLimit, -y); ctx.lineTo(gridLimit, -y); ctx.stroke(); }
    }
    ctx.restore();

    // FOV wedge from the LIVE main-camera frustum (follows the boost FOV
    // kick), falling back to 45Â° if the viewer is unreachable.
    ctx.strokeStyle = "rgba(0, 255, 0, 0.7)";
    ctx.lineWidth = 1.2;
    let halfHFov = Math.PI / 4;
    try {
      const mainViewer = getViewer();
      if (mainViewer?.camera?.frustum) {
        const fovy = mainViewer.camera.frustum.fovy;
        const aspect = window.innerWidth / window.innerHeight;
        halfHFov = Math.atan(Math.tan(fovy / 2) * aspect);
      }
    } catch (e) { /* fallback stands */ }
    const len = w + h;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx - Math.sin(halfHFov) * len, cy - Math.cos(halfHFov) * len);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(halfHFov) * len, cy - Math.cos(halfHFov) * len);
    ctx.stroke();
    ctx.strokeStyle = "rgba(0, 255, 0, 0.3)";
    ctx.beginPath();
    ctx.moveTo(cx - 90, cy); ctx.lineTo(cx + 90, cy);
    ctx.moveTo(cx, cy - 90); ctx.lineTo(cx, cy + 90);
    ctx.stroke();

    // Original spawn point (red pin) relative to the jet, rotated by heading.
    // Same shared zoom the real-map camera uses (state.minimapZoom).
    if (state.spawnLon != null && state.spawnLat != null) {
      const ppm = pixelsPerMeter;
      const dxm = (state.spawnLon - state.lon) * 111320 * Math.cos((state.lat * Math.PI) / 180);
      const dym = (state.spawnLat - state.lat) * 111320;
      const hdg = (heading * Math.PI) / 180;
      const rx = dxm * Math.cos(hdg) - dym * Math.sin(hdg);
      const ry = -dxm * Math.sin(hdg) - dym * Math.cos(hdg);
      const px = rx * ppm;
      const py = ry * ppm;
      if (Math.sqrt(px * px + py * py) < radius - 6) {
        ctx.fillStyle = "#f00";
        ctx.beginPath();
        ctx.arc(cx + px, cy + py, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = "#f00";
        ctx.font = "bold 9px monospace";
        ctx.fillText("SPAWN", cx + px, cy + py - 10);
      } else {
        // Spawn is off the map: red arrow on the rim pointing back at it.
        const a = Math.atan2(px, -py);
        const ex = cx + Math.sin(a) * (radius - 12);
        const ey = cy - Math.cos(a) * (radius - 12);
        ctx.save();
        ctx.translate(ex, ey);
        ctx.rotate(a);
        ctx.fillStyle = "#f00";
        ctx.beginPath();
        ctx.moveTo(0, -9);
        ctx.lineTo(7, 7);
        ctx.lineTo(-7, 7);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }

    // Player wedge
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = "#0f0";
    ctx.beginPath();
    ctx.moveTo(0, -12); ctx.lineTo(8, 10); ctx.lineTo(0, 5); ctx.lineTo(-8, 10);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Cardinal edge labels + sweep
    ctx.fillStyle = "#0f0";
    ctx.font = "bold 12px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const pad = 12;
    const edgeX = cx - pad;
    const edgeY = cy - pad;
    [
      { label: "N", angle: 0 },
      { label: "E", angle: 90 },
      { label: "S", angle: 180 },
      { label: "W", angle: 270 },
    ].forEach((dir) => {
      const rel = ((dir.angle - heading) * Math.PI) / 180;
      const sinA = Math.sin(rel);
      const cosA = Math.cos(rel);
      let dx, dy;
      if (edgeX * Math.abs(cosA) > edgeY * Math.abs(sinA)) {
        dy = cosA > 0 ? -edgeY : edgeY;
        dx = (dy * sinA) / -cosA;
      } else {
        dx = sinA > 0 ? edgeX : -edgeX;
        dy = (dx * -cosA) / sinA;
      }
      ctx.fillText(dir.label, cx + dx, cy + dy);
    });
    const sweep = (Date.now() / 1500) % 1;
    ctx.strokeStyle = `rgba(0, 255, 0, ${0.7 * (1 - sweep)})`;
    ctx.beginPath();
    ctx.arc(cx, cy, sweep * radius, 0, Math.PI * 2);
    ctx.stroke();

    // Heading readout
    const headingDeg = ((heading % 360) + 360) % 360;
    ctx.fillStyle = "#0f0";
    ctx.font = "10px monospace";
    ctx.fillText(`${Math.round(headingDeg).toString().padStart(3, "0")}`, cx, 12);
  }
}
