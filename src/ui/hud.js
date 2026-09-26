/**
 * HUD.
 *
 * Deliberately a DOM overlay rather than Cesium labels: text stays crisp at
 * any DPR, costs nothing per frame, and can be styled like a real instrument
 * panel. It updates at CONFIG.sim.hudHz (10 Hz) rather than per frame — a
 * readout that updates 144 times a second is just noise, and it keeps layout
 * work off the render thread.
 */
import { MPS_TO_KNOTS, M_TO_FT, RAD } from "../core/config.js";

const el = (tag, className, parent) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (parent) parent.appendChild(node);
  return node;
};

export class Hud {
  constructor(root) {
    this.root = root;
    this.node = el("div", "hud", root);

    // Top-left: position + place.
    const left = el("div", "hud-block hud-tl", this.node);
    this.position = el("div", "hud-readout", left);
    this.place = el("div", "hud-sub", left);

    // Top-right: time of day + data sources.
    const right = el("div", "hud-block hud-tr", this.node);
    this.clock = el("div", "hud-readout", right);
    this.attribution = el("div", "hud-sub", right);

    // Bottom-left: attitude indicator.
    const horizon = el("div", "hud-horizon", this.node);
    this.horizonClip = el("div", "hud-horizon-clip", horizon);
    this.horizonSky = el("div", "hud-horizon-sky", this.horizonClip);
    this.horizonGround = el("div", "hud-horizon-ground", this.horizonClip);
    this.horizonLine = el("div", "hud-horizon-line", this.horizonClip);
    this.bankPointer = el("div", "hud-bank-pointer", horizon);
    this.pitchLadder = el("div", "hud-pitch-ladder", horizon);
    this._ladder = [];
    for (let deg = -30; deg <= 30; deg += 10) {
      if (deg === 0) continue;
      const rung = el("div", "hud-ladder-rung", this.pitchLadder);
      rung.dataset.deg = String(deg);
      rung.textContent = `${deg > 0 ? "+" : ""}${deg}`;
      this._ladder.push(rung);
    }

    // Bottom-centre: primary flight display.
    const pfd = el("div", "hud-pfd", this.node);
    this.speedValue = el("div", "pfd-value", pfd);
    el("div", "pfd-label", pfd).textContent = "KIAS";
    this.altValue = el("div", "pfd-value", pfd);
    // Deliberately not "FT MSL". The DEM is ellipsoidal (EGM2008-referenced),
    // which is what every 3D globe uses and what the terrain is actually
    // rendered from. Re:Earth's `/geoid` and `/ellipsoid` endpoints serve the
    // same blended dataset, so no keyless source gives a separate geoid grid to
    // convert with — claiming MSL would be a label the number cannot support.
    el("div", "pfd-label", pfd).textContent = "ALT FT";
    this.vsValue = el("div", "pfd-value", pfd);
    el("div", "pfd-label", pfd).textContent = "VS F/M";
    this.headingValue = el("div", "pfd-value", pfd);
    el("div", "pfd-label", pfd).textContent = "HDG";
    // Height above the rendered terrain surface. This one is genuinely AGL, and
    // it is the number that matters for terrain clearance.
    this.aglValue = el("div", "pfd-value", pfd);
    el("div", "pfd-label", pfd).textContent = "AGL FT";

    this.throttleBar = el("div", "hud-throttle", this.node);
    this.throttleFill = el("div", "hud-throttle-fill", this.throttleBar);
    el("div", "hud-throttle-label", this.throttleBar).textContent = "THR";

    // Status strip.
    this.status = el("div", "hud-status", this.node);
    this.stall = el("div", "hud-stall", this.node);
    this._last = 0;
  }

  update(plane, info, now) {
    if (now - this._last < 1000 / 10) return;
    this._last = now;

    const headingDeg = (plane.heading * RAD + 360) % 360;
    const altFt = plane.alt * M_TO_FT;
    const aglFt = Math.max(0, info.altitudeAgl * M_TO_FT);
    const vsFpm = plane.verticalSpeed * M_TO_FT * 60;

    this.speedValue.textContent = Math.round(plane.speed * MPS_TO_KNOTS);
    this.altValue.textContent = Math.round(altFt).toLocaleString();
    this.vsValue.textContent = `${vsFpm >= 0 ? "+" : ""}${Math.round(vsFpm / 10) * 10}`;
    this.headingValue.textContent = String(Math.round(headingDeg / 10) * 10).padStart(3, "0");
    this.aglValue.textContent = Math.round(aglFt).toLocaleString();

    this.position.textContent =
      `${plane.lat.toFixed(5)}°, ${plane.lon.toFixed(5)}°`;
    this.place.textContent = info.place || "—";
    this.clock.textContent = `${String(Math.floor(info.hour)).padStart(2, "0")}:${String(Math.floor((info.hour % 1) * 60)).padStart(2, "0")}`;

    // Attitude indicator: translate the horizon by pitch, rotate by bank.
    const pitchPx = (plane.pitch * RAD * 3.2).toFixed(1);
    this.horizonClip.style.transform = `rotate(${(-plane.roll * RAD).toFixed(2)}deg)`;
    this.horizonSky.style.transform = `translateY(${pitchPx}px)`;
    this.horizonGround.style.transform = `translateY(${pitchPx}px)`;
    this.horizonLine.style.transform = `translateY(${pitchPx}px)`;
    this.pitchLadder.style.transform = `translateY(${pitchPx}px)`;
    for (const rung of this._ladder) {
      const deg = Number(rung.dataset.deg);
      const y = -deg * 3.2;
      rung.style.top = `${(100 + y).toFixed(1)}%`;
    }

    this.throttleFill.style.height = `${(plane.throttle * 100).toFixed(0)}%`;

    this.status.textContent = plane.onGround
      ? plane.speed < 1
        ? "PARKED"
        : plane.brakes
          ? "BRAKING"
          : "TAXIING"
      : plane.stallFactor > 0.35
        ? "STALL"
        : "AIRBORNE";
    if (plane.flaps && !plane.onGround) this.status.textContent += " · FLAPS";
    this.stall.style.opacity = plane.stallFactor > 0.2 ? "1" : "0";
  }
}
