import { MPS_TO_KNOTS, M_TO_FT, RAD } from "../core/config.js";

/**
 * HUD — DOM overlay with compass tape, speed, altitude, heading, coordinates,
 * region notification, pull-up warning, and a 2D minimap.
 */
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

    this.minimapCanvas = document.getElementById("minimap");
    this.minimapCtx = this.minimapCanvas ? this.minimapCanvas.getContext("2d") : null;

    this._last = 0;
    this._fpsFrames = 0;
    this._fpsLast = performance.now();
    this._score = 0;

    this._buildCompassTape();
  }

  _buildCompassTape() {
    if (!this.compassTape) return;
    const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    let html = "";
    // Build 3 copies for seamless wrapping
    for (let copy = 0; copy < 3; copy++) {
      for (let deg = 0; deg < 360; deg += 10) {
        const isMajor = deg % 30 === 0;
        const label = isMajor ? directions[deg / 45] : deg.toString();
        html += `<span class="compass-tick${isMajor ? " major" : ""}" style="width:30px">${label}</span>`;
      }
    }
    this.compassTape.innerHTML = html;
  }

  update(state, now) {
    if (now - this._last < 100) return;
    this._last = now;

    const headingDeg = ((state.heading % 360) + 360) % 360;
    const altFt = state.alt * M_TO_FT;
    const speedKt = state.speed * MPS_TO_KNOTS;

    if (this.speedEl) this.speedEl.textContent = Math.round(speedKt);
    if (this.altEl) this.altEl.textContent = Math.round(altFt).toLocaleString();
    if (this.headingEl) this.headingEl.textContent = String(Math.round(headingDeg)).padStart(3, "0");
    if (this.coordsEl) this.coordsEl.textContent = `${state.lat.toFixed(4)}, ${state.lon.toFixed(4)}`;

    // Update compass tape position
    if (this.compassTape) {
      const tickWidth = 30;
      const centerOffset = 150; // half of compass-container width (300px / 2)
      const headingOffset = headingDeg * (tickWidth / 10);
      const transform = centerOffset - headingOffset - 10 * tickWidth; // offset for first copy
      this.compassTape.style.transform = `translateX(${transform}px)`;
    }

    // FPS counter
    this._fpsFrames++;
    if (now - this._fpsLast >= 1000) {
      const fps = (this._fpsFrames * 1000) / (now - this._fpsLast);
      if (this.fpsEl) this.fpsEl.textContent = Math.round(fps);
      this._fpsFrames = 0;
      this._fpsLast = now;
    }

    // Time display
    if (this.timeEl) {
      this.timeEl.textContent = new Date().toISOString().split(".")[0] + "Z";
    }

    // Local datetime
    if (this.localDatetimeEl) {
      const d = new Date();
      const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
      this.localDatetimeEl.textContent =
        `${d.getUTCDate().toString().padStart(2, "0")} ${months[d.getUTCMonth()]} ${d.getUTCFullYear().toString().slice(2)} | ${d.toISOString().split("T")[1].split(".")[0]}Z`;
    }

    // Score (increases with distance flown)
    if (this.scoreEl) {
      this._score += Math.round(state.speed * 0.1);
      this.scoreEl.textContent = this._score.toString().padStart(6, "0");
    }
  }

  showRegion(name) {
    if (!this.regionNotification || !this.regionName) return;
    this.regionName.textContent = name;
    this.regionNotification.classList.remove("hidden");
    setTimeout(() => this.regionNotification.classList.add("hidden"), 4000);
  }

  setPullUpWarning(show) {
    if (this.pullUpWarning) {
      this.pullUpWarning.classList.toggle("hidden", !show);
    }
  }

  updateMinimap(state) {
    if (!this.minimapCtx || !this.minimapCanvas) return;

    const ctx = this.minimapCtx;
    const w = this.minimapCanvas.width = 180;
    const h = this.minimapCanvas.height = 180;
    const cx = w / 2;
    const cy = h / 2;

    // Clear
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.beginPath();
    ctx.arc(cx, cy, 90, 0, Math.PI * 2);
    ctx.fill();

    // Draw grid rings
    ctx.strokeStyle = "rgba(0, 255, 0, 0.2)";
    ctx.lineWidth = 1;
    for (let r = 30; r <= 90; r += 30) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Crosshair
    ctx.strokeStyle = "rgba(0, 255, 0, 0.3)";
    ctx.beginPath();
    ctx.moveTo(cx - 90, cy);
    ctx.lineTo(cx + 90, cy);
    ctx.moveTo(cx, cy - 90);
    ctx.lineTo(cx, cy + 90);
    ctx.stroke();

    // Player dot (center)
    ctx.fillStyle = "#0f0";
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();

    // Heading indicator
    const headingRad = (state.heading * Math.PI) / 180;
    ctx.strokeStyle = "#0f0";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(headingRad) * 20, cy - Math.cos(headingRad) * 20);
    ctx.stroke();

    // Heading label
    const headingDeg = ((state.heading % 360) + 360) % 360;
    ctx.fillStyle = "#0f0";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    ctx.fillText(`${Math.round(headingDeg).toString().padStart(3, "0")}`, cx, 12);
  }

  resetScore() {
    this._score = 0;
    if (this.scoreEl) this.scoreEl.textContent = "000000";
  }
}
