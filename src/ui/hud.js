import { MPS_TO_KNOTS, M_TO_FT, RAD } from "../core/config.js";

/**
 * HUD — DOM overlay showing speed, altitude, heading, throttle.
 * Updates at 10 Hz to avoid layout thrash.
 */
export class Hud {
  constructor() {
    this.speedEl = document.getElementById("speed");
    this.altEl = document.getElementById("altitude");
    this.headingEl = document.getElementById("heading");
    this.throttleEl = document.getElementById("throttle");
    this.coordsEl = document.getElementById("coords");
    this._last = 0;
  }

  update(state, now) {
    if (now - this._last < 100) return;
    this._last = now;

    const headingDeg = ((state.heading % 360) + 360) % 360;
    const altFt = state.alt * M_TO_FT;
    const speedKt = state.speed * MPS_TO_KNOTS;
    const throttlePct = Math.round(state.throttle * 100);

    if (this.speedEl) this.speedEl.textContent = Math.round(speedKt);
    if (this.altEl) this.altEl.textContent = Math.round(altFt).toLocaleString();
    if (this.headingEl) this.headingEl.textContent = String(Math.round(headingDeg)).padStart(3, "0");
    if (this.throttleEl) this.throttleEl.textContent = throttlePct;
    if (this.coordsEl) this.coordsEl.textContent = `${state.lat.toFixed(4)}, ${state.lon.toFixed(4)}`;
  }
}
