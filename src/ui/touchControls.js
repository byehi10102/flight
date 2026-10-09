/**
 * Dual virtual joysticks, mobile landscape. Brawl Stars style.
 *
 * ── Why pointer events, nothing else ───────────────────────────────────────
 * Pointer Events give one event type for mouse AND touch, and carry a stable
 * `pointerId` per finger. That is what makes the two sticks genuinely
 * independent: each stick tracks its OWN pointerId only, so a second thumb
 * landing while the first is held never steals or resets it, and a pinch
 * gesture can't break one stick.
 *
 * ── Layout ─────────────────────────────────────────────────────────────────
 * Two fixed hit zones: bottom-left (throttle + yaw, mirrors W/S + A/D) and
 * bottom-right (pitch + roll, mirrors arrow keys). The sticks are FIXED: the
 * base ring never moves; touching anywhere in a zone drives the knob relative
 * to that one anchor point, so the controls can't wander across the screen.
 * Release recenters smoothly (CSS transition).
 *
 * ── Output ─────────────────────────────────────────────────────────────────
 * Normalized -1..1 per axis with a 10% dead zone, pushed through
 * `onAxis(side, x, y)` which the host routes into PlaneController. The stick
 * never touches the physics directly.
 *
 * ── Haptics ────────────────────────────────────────────────────────────────
 * navigator.vibrate(12) fires the moment full deflection is reached, once per
 * engagement, where supported (Android Chrome). Wrapped so a browser without
 * vibration never throws.
 */

export const STICK_LABELS = {
  left:  { horizontal: "YAW",     vertical: "THROTTLE", up: "FULL", down: "SLOW" },
  right: { horizontal: "ROLL",    vertical: "PITCH",    up: "UP",   down: "DOWN" },
  fire:  { horizontal: "FIRE",    vertical: "HOLD",     up: "",     down: "" },
};

const FULL_DEFLECTION = 0.92; // normalized value that fires the haptic tick

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** distance -> normalized axis value, clamped to the stick radius. */
function toAxis(delta, radius) {
  const v = clamp(delta / radius, -1, 1);
  return v;
}

class VirtualStick {
  /**
   * @param zone the fixed hit-zone element (left, right or fire)
   * @param opts { side, radius, deadZone, onAxis, labels, onStart, onEnd }
   */
  constructor(zone, opts) {
    this.zone = zone;
    this.side = opts.side;
    this.radius = opts.radius;
    this.onAxis = opts.onAxis;
    this.onStart = opts.onStart || null; // trigger-style sticks: grab
    this.onEnd = opts.onEnd || null;    // trigger-style sticks: release
    this.deadZone = opts.deadZone;
    this.pointerId = null; // the ONE finger this stick owns; null = free
    this.x = 0;
    this.y = 0;
    this.full = false;

    // Visuals: base ring + knob, absolutely positioned inside the zone.
    this.base = document.createElement("div");
    this.base.className = "stick-base";
    this.knob = document.createElement("div");
    this.knob.className = "stick-knob";
    this.base.appendChild(this.knob);
    zone.appendChild(this.base);

    // Per-axis glyph labels (throttle/yaw vs pitch/roll) baked in as data.
    if (opts.labels) {
      const l = document.createElement("div");
      l.className = "stick-hint";
      l.textContent = `${opts.labels.horizontal} · ${opts.labels.vertical}`;
      zone.appendChild(l);
    }

    zone.addEventListener("pointerdown", (e) => this._down(e));
    // Listen on the WINDOW so a finger sliding past the zone edge keeps
    // driving the stick — Brawl Stars behaviour; the zone is only the grab
    // area, not the travel area.
    window.addEventListener("pointermove", (e) => this._move(e), { passive: false });
    window.addEventListener("pointerup", (e) => this._up(e));
    window.addEventListener("pointercancel", (e) => this._up(e));
  }

  _down(e) {
    if (this.pointerId !== null) return;        // already owned by another finger
    if (!e.isPrimary && e.pointerType === "mouse") return;
    e.preventDefault();
    try { this.zone.setPointerCapture(e.pointerId); } catch (err) { /* idiom */ }
    this.pointerId = e.pointerId;

    // FIXED base: the stick never re-centres under the thumb. The knob's
    // origin is always the base's own centre (CSS pins the base at 50%/50%),
    // so tapping anywhere in the zone starts steering from that one anchor.
    const rect = this.zone.getBoundingClientRect();
    this.originX = rect.width / 2;
    this.originY = rect.height / 2;
    this.knob.style.transform = "translate(-50%, -50%)";
    this.base.classList.add("active");
    if (this.onStart) this.onStart();

    // First contact can already be a displacement from the fixed centre -
    // run one move pass so the knob jumps to the finger immediately.
    this._move(e);
  }

  _move(e) {
    if (this.pointerId === null || e.pointerId !== this.pointerId) return;
    e.preventDefault();

    const rect = this.zone.getBoundingClientRect();
    const px = e.clientX - rect.left - this.originX;
    const py = e.clientY - rect.top - this.originY;

    // Clamp the knob to the stick radius.
    const dist = Math.hypot(px, py);
    const scale = dist > this.radius ? this.radius / dist : 1;
    const kx = px * scale;
    const ky = py * scale;
    this.knob.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))`;

    let x = toAxis(kx, this.radius);
    let y = -toAxis(ky, this.radius); // screen-Y grows downward; up = positive input

    // Dead zone. Below it the axis reports 0 and the physics sees neutral.
    if (Math.abs(x) < this.deadZone) x = 0;
    if (Math.abs(y) < this.deadZone) y = 0;

    this.x = x;
    this.y = y;

    // Single tick when full deflection is reached, then not again until the
    // stick drops below FULL_DEFLECTION — vibration spam is worse than none.
    const nowFull = Math.hypot(x, y) >= FULL_DEFLECTION;
    if (nowFull && !this.full) {
      this.full = true;
      try {
        if (navigator.vibrate) navigator.vibrate(12);
      } catch (err) { /* unsupported */ }
    } else if (!nowFull) {
      this.full = false;
    }

    if (this.onAxis) this.onAxis(this.side, x, y);
  }

  _up(e) {
    if (this.pointerId === null || e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.x = 0;
    this.y = 0;
    this.full = false;
    this.base.classList.remove("active");
    // Smooth recenter: the CSS transition on .stick-knob closes over the
    // transform, so the knob floats back to centre instead of snapping.
    this.knob.style.transform = "translate(-50%, -50%)";
    if (this.onAxis) this.onAxis(this.side, 0, 0);
    if (this.onEnd) this.onEnd();
  }

  /** Hard-reset (state changed, e.g. leaving flight): release any thumb. */
  cancel() {
    if (this.pointerId !== null) {
      this.pointerId = null;
      this.x = 0;
      this.y = 0;
      this.full = false;
      this.base.classList.remove("active");
      this.knob.style.transform = "translate(-50%, -50%)";
      if (this.onAxis) this.onAxis(this.side, 0, 0);
      if (this.onEnd) this.onEnd();
    }
  }
}

export class TouchControls {
  /**
   * @param opts { onAxis(side,-1..1), onBoost(), radius, knobRadius, deadZone }
   */
  constructor(opts = {}) {
    this.onAxis = opts.onAxis || null;
    this.onBoost = opts.onBoost || null;
    this._visible = false;
    this._lastTap = null; // { t, x, y }
    this.fireHeld = false; // the green fire stick's trigger state

    // Double-tap anywhere outside the sticks = boost (the mobile replacement
    // for the spacebar). Firing is NOT tap-anywhere anymore - it lives on the
    // green fire stick. Taps on a stick zone stay stick gestures. Only while
    // the sticks are shown (i.e. actually flying), so menu taps are inert.
    const TAP_WINDOW_MS = 300;
    const TAP_TRAVEL = 30; // px between the two taps before it stops being a double-tap
    window.addEventListener("pointerdown", (e) => {
      if (!this._visible || e.pointerType !== "touch") return;
      if (e.target && e.target.closest && e.target.closest(".stick-zone")) return;
      const now = performance.now();
      const last = this._lastTap;
      if (last && now - last.t <= TAP_WINDOW_MS
          && Math.hypot(e.clientX - last.x, e.clientY - last.y) <= TAP_TRAVEL) {
        this._lastTap = null;
        if (this.onBoost) {
          this.onBoost();
          try { if (navigator.vibrate) navigator.vibrate(25); } catch (err) { /* unsupported */ }
        }
      } else {
        this._lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
    }, { passive: true });
    this.radius = opts.radius ?? 56;
    this.deadZone = opts.deadZone ?? 0.10;

    // Root overlay covering the whole screen but NEVER intercepting input
    // except on its three zones — the game behind keeps pointer events for
    // minimap/HUD taps.
    this.root = document.createElement("div");
    this.root.id = "touchControls";
    this.root.className = "hidden";

    this.zoneLeft = document.createElement("div");
    this.zoneLeft.className = "stick-zone stick-zone-left";
    this.zoneRight = document.createElement("div");
    this.zoneRight.className = "stick-zone stick-zone-right";
    this.zoneFire = document.createElement("div");
    this.zoneFire.className = "stick-zone stick-zone-fire";

    // Press-and-hold BOTH flight sticks = boost. Rising-edge only (one boost
    // per both-held gesture); releases and re-grabs re-arm it. Double-tap
    // boost elsewhere stays working.
    this._bothSticks = false;
    const checkBothSticks = () => {
      const both = this.left && this.right
        && this.left.pointerId !== null && this.right.pointerId !== null;
      if (both && !this._bothSticks) {
        if (this.onBoost) {
          this.onBoost();
          try { if (navigator.vibrate) navigator.vibrate(25); } catch (err) { /* unsupported */ }
        }
      }
      this._bothSticks = both;
    };

    this.left = new VirtualStick(this.zoneLeft, {
      side: "left", radius: this.radius, deadZone: this.deadZone,
      onAxis: this.onAxis, labels: STICK_LABELS.left,
      onStart: checkBothSticks, onEnd: checkBothSticks,
    });
    this.right = new VirtualStick(this.zoneRight, {
      side: "right", radius: this.radius, deadZone: this.deadZone,
      onAxis: this.onAxis, labels: STICK_LABELS.right,
      onStart: checkBothSticks, onEnd: checkBothSticks,
    });
    // Green trigger stick: smaller, below-left of the right stick. Pushing it
    // fires along the plane's CURRENT nose direction - main.js polls
    // isFiringHeld() every frame and streams rounds off the nose while held;
    // each round freezes its path at its own fire moment.
    this.fire = new VirtualStick(this.zoneFire, {
      side: "fire", radius: 32, deadZone: 0.05,
      onAxis: null, labels: STICK_LABELS.fire,
      onStart: () => {
        this.fireHeld = true;
        try { if (navigator.vibrate) navigator.vibrate(10); } catch (err) { /* unsupported */ }
      },
      onEnd: () => { this.fireHeld = false; },
    });

    this.root.appendChild(this.zoneLeft);
    this.root.appendChild(this.zoneRight);
    // The fire zone overlaps the right zone's lower-left corner; being LAST
    // in the DOM keeps it on top so those grabs belong to the trigger.
    this.root.appendChild(this.zoneFire);

    document.body.appendChild(this.root);
  }

  attach() {
    return this.root;
  }

  /** True while the green fire stick is held: main.js streams rounds off the
   *  plane's nose (each frozen at its own fire moment). */
  isFiringHeld() {
    return this._visible && this.fireHeld;
  }

  /** Show the zones (flying on mobile). Does not synthesize input. */
  show() {
    this._visible = true;
    this.root.classList.remove("hidden");
  }

  /** Hide the zones and release any thumbs so stale axes can't linger. */
  hide() {
    this._visible = false;
    this._lastTap = null;
    this.fireHeld = false;
    this.root.classList.add("hidden");
    this.left.cancel();
    this.right.cancel();
    this.fire.cancel();
  }

  /** Frame-rate idempotent show/hide — safe to call every frame. */
  setVisible(v) {
    if (v) this.show(); else this.hide();
  }

  /** Current-axes snapshot, used by tests. */
  axes() {
    return {
      left: { x: this.left.x, y: this.left.y },
      right: { x: this.right.x, y: this.right.y },
    };
  }
}
