/**
 * Mobile detection + landscape handling.
 *
 * ── Detection ──────────────────────────────────────────────────────────────
 * "Touch + small screen, or a mobile UA."
 *   - `coarse pointer && small screen` catches phones/tablets honestly,
 *   - the UA regex catches the cases where the pointer test lies (desktop
 *     mode, some Android-on-Chromebook resizes). An iPad that reports itself
 *     as a Mac is caught by the `Macintosh + multi-touch` arm.
 * A big touchscreen laptop has a coarse pointer but a large screen and no
 * mobile UA, so it keeps the desktop UI — its keyboard still works, and the
 * joystick path is additive (never replaces keys), satisfying "hybrid
 * devices must work at once".
 *
 * ── Landscape lock ─────────────────────────────────────────────────────────
 * The only bulletproof order is: user gesture → requestFullscreen() →
 * screen.orientation.lock("landscape"). iOS Safari supports NEITHER
 * fullscreen nor lock, so the lock is best-effort: try/catch every call,
 * and when the phone is held in portrait anyway, the rotate overlay covers
 * the game instead of letting the layout collapse.
 */

/** True on phones and tablets, false on desktops (incl. touch laptops). */
export function isMobileDevice() {
  try {
    // Test hook: ?forceMobile=1 forces the mobile front-end (rotate overlay,
    // joysticks, scaled HUD) so the phone layout can be exercised in a
    // desktop browser. Diagnostic only - never set in production links.
    if (new URLSearchParams(window.location.search).has("forceMobile")) return true;
    const ua = (navigator.userAgent || "").toLowerCase();
    const uaMobile = /android|webos|iphone|ipod|blackberry|iemobile|opera mini|mobi/.test(ua);
    const iPadOs = /macintosh/.test(ua) && navigator.maxTouchPoints > 1;
    const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
    const smallScreen = Math.min(window.screen.width, window.screen.height) <= 900;
    return uaMobile || iPadOs || (coarse && navigator.maxTouchPoints > 0 && smallScreen);
  } catch (e) {
    return false;
  }
}

// ── HUD scale ───────────────────────────────────────────────────────────────
// The mobile HUD is the DESKTOP HUD, uniformly scaled — not a re-laid-out
// variant. One factor scales every HUD element together (plates, minimap,
// compass, ladder), computed against the desktop reference viewport
// (1280x720): whichever screen dimension is relatively smaller decides the
// scale, clamped to a 0.5 readability floor. Pure so it's unit-testable.

export const HUD_SCALE_REF_W = 1280;
export const HUD_SCALE_REF_H = 720;
export const HUD_SCALE_MIN = 0.5;

/** Uniform HUD scale for a viewport (1 on reference-or-bigger screens). */
export function computeHudScale(vw, vh) {
  const w = Number(vw) || HUD_SCALE_REF_W;
  const h = Number(vh) || HUD_SCALE_REF_H;
  const s = Math.min(w / HUD_SCALE_REF_W, h / HUD_SCALE_REF_H);
  return Math.max(HUD_SCALE_MIN, Math.min(1, s));
}

export class MobileMode {
  constructor() {
    this.enabled = isMobileDevice();
    this.overlay = document.getElementById("rotateOverlay");
    if (!this.enabled) return;

    document.body.classList.add("mobile-mode");
    // Orientation changes can come from the OS, and also from a successful
    // lock() — watch both.
    this._portraitQuery = window.matchMedia("(orientation: portrait)");
    const onLayoutChange = () => this._syncOverlay();
    try {
      this._portraitQuery.addEventListener("change", onLayoutChange);
    } catch (e) {
      window.addEventListener("orientationchange", onLayoutChange);
    }
    window.addEventListener("resize", onLayoutChange);
    this._syncOverlay();
  }

  get isPortrait() {
    // Media query first (cheap and authoritative); fall back to pixels so a
    // square-nearly window doesn't end up overlay-less.
    try {
      if (this._portraitQuery) return this._portraitQuery.matches;
    } catch (e) { /* fall through to pixels */ }
    return window.innerHeight >= window.innerWidth;
  }

  _syncOverlay() {
    const portrait = this.isPortrait;
    if (this.overlay) this.overlay.classList.toggle("hidden", !portrait);
    // The HUD restyle runs in LANDSCAPE only; portrait shows the overlay.
    document.body.classList.toggle("mobile-landscape", !portrait);
    // Publish the uniform HUD scale: hud.js composes it into the per-frame
    // #uiContainer transform (tilt/shake already own that property), and the
    // CSS uses it for the picker/menus. One factor, one look — desktop,
    // proportionally smaller.
    document.documentElement.style.setProperty(
      "--hud-scale",
      String(portrait ? 1 : computeHudScale(window.innerWidth, window.innerHeight)),
    );
  }

  /**
   * Ask the OS for landscape. Called from user-gesture handlers (start / the
   * shared spawn-pick entry). Never throws: an unsupported browser just gets
   * the rotate overlay instead.
   */
  async lockLandscape() {
    if (!this.enabled) return;
    try {
      if (!document.fullscreenElement) {
        const el = document.documentElement;
        const req = el.requestFullscreen
          || el.webkitRequestFullscreen || el.msRequestFullscreen;
        if (req) await Promise.resolve(req.call(el, { navigationUI: "hide" }));
      }
    } catch (e) { /* fullscreen refused — fine, lock might still work */ }
    try {
      if (screen.orientation && typeof screen.orientation.lock === "function") {
        await screen.orientation.lock("landscape");
      }
    } catch (e) { /* not supported/denied — the overlay covers it */ }
    this._syncOverlay();
  }

  /** Release the lock (back to menu). Also best-effort. */
  async unlock() {
    if (!this.enabled) return;
    try {
      if (screen.orientation && typeof screen.orientation.unlock === "function") {
        screen.orientation.unlock();
      }
    } catch (e) { /* nothing to do */ }
    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        await document.exitFullscreen();
      }
    } catch (e) { /* already out */ }
  }
}
