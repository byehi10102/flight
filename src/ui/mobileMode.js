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
