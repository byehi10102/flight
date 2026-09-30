import * as THREE from "three";

/**
 * Crash-detonation particles.
 *
 * The effect is built entirely from procedural, camera-facing sprite puffs
 * (one shared canvas texture, no asset files) so fire and smoke read as soft
 * billowing volumes instead of faceted spheres. Each particle carries a
 * start/end colour so fire visibly cools (white-hot -> yellow -> orange ->
 * red -> dark), hot gas is buoyant, ejecta decelerate under drag, expansion
 * eases out (fast blast front, then decelerating), and the burst is staged
 * (flash + shock ring first, main fireball, then secondary fireballs and
 * smoke) rather than one simultaneous frame.
 *
 * The Three.js camera is fixed at the origin (Cesium owns world tracking), so
 * the whole effect runs in local space around the crash point — the plane's
 * on-screen position — and every object stays on layer 1.
 */

let _puffTexture = null;

/**
 * Shared soft puff texture: an opaque hot centre fading to a transparent edge,
 * with a few low-frequency holes punched in so the silhouette is billowy
 * rather than a perfect disc. Built once, reused by every sprite, disposed in
 * clear().
 */
function getPuffTexture() {
  if (_puffTexture) return _puffTexture;
  const size = 128;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d");
  const cx = size / 2;

  const grad = g.createRadialGradient(cx, cx, 0, cx, cx, cx);
  grad.addColorStop(0.0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.72)");
  grad.addColorStop(0.7, "rgba(255,255,255,0.26)");
  grad.addColorStop(1.0, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);

  g.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 6; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = cx * (0.45 + Math.random() * 0.4);
    const bx = cx + Math.cos(a) * d;
    const by = cx + Math.sin(a) * d;
    const br = cx * (0.18 + Math.random() * 0.22);
    const hole = g.createRadialGradient(bx, by, 0, bx, by, br);
    hole.addColorStop(0, "rgba(0,0,0,0.55)");
    hole.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = hole;
    g.beginPath();
    g.arc(bx, by, br, 0, Math.PI * 2);
    g.fill();
  }
  g.globalCompositeOperation = "source-over";

  _puffTexture = new THREE.CanvasTexture(c);
  try {
    _puffTexture.colorSpace = THREE.SRGBColorSpace;
  } catch (e) { /* older three */ }
  return _puffTexture;
}

/** A single layer-1 sprite puff with the shared texture. */
function makePuff(size, { additive = true } = {}) {
  const mat = new THREE.SpriteMaterial({
    map: getPuffTexture(),
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(size, size, 1);
  sprite.layers.set(1);
  sprite._baseScale = size;
  return sprite;
}

/** Radial ejecta velocity, biased slightly upward. */
function radialVelocity(speed) {
  const h = Math.random() * Math.PI * 2;
  const p = ((Math.random() * 120 - 60) * Math.PI) / 180;
  return new THREE.Vector3(
    Math.sin(h) * Math.cos(p) * speed,
    Math.sin(p) * speed + speed * 0.15,
    Math.cos(h) * Math.cos(p) * speed
  );
}

export const particles = {
  scene: null,
  list: [],
  // Persistent detonation light: created once so the scene's light count never
  // changes. Adding a light at crash time makes three.js recompile every lit
  // material (including the aircraft), which is a visible one-time stutter.
  _flashLight: null,
  _lightLife: 0,
  _lightMax: 0.22,
  _lightBase: 0,

  init(scene) {
    this.scene = scene;
    if (!this._flashLight) {
      this._flashLight = new THREE.PointLight(0xffaa55, 0, 7, 2);
      this._flashLight.layers.enable(1);
      this.scene.add(this._flashLight);
    }
  },

  clear() {
    for (const p of this.list) {
      this.scene?.remove(p);
      p.geometry?.dispose?.();
      // Materials are deliberately NOT disposed: disposing them evicts their
      // shader programs, so the next crash would recompile them (a visible
      // stall). Leaving them to be GC'd lets three.js's program cache reuse
      // the same programs. Geometry (the ring) is unique per burst, so it is.
    }
    this.list.length = 0;
    // The shared puff texture is intentionally NOT disposed here: it is tiny
    // and reused by every burst, so keeping it cached avoids a canvas redraw
    // and GPU re-upload on every crash. The persistent light is dimmed instead
    // of removed, so the light count (and shader programs) never change.
    this._lightLife = 0;
    if (this._flashLight) this._flashLight.intensity = 0;
  },

  spawnExplosion(center, opts = {}) {
    if (!this.scene) return;
    const big = opts.big !== false;
    const origin = center?.clone?.() ?? new THREE.Vector3(0, -0.8, -2.75);

    // ── Detonation light: re-aim the persistent light and re-arm its fade ──
    if (this._flashLight) {
      this._flashLight.position.copy(origin);
      this._lightBase = big ? 4 : 2;
      this._flashLight.intensity = this._lightBase;
      this._lightMax = 0.22;
      this._lightLife = this._lightMax;
    }

    // ── White flash: bright additive puff, decays very fast ────────────────
    const flash = makePuff(big ? 1.8 : 1.1);
    flash.material.color.setRGB(1, 1, 1);
    flash.material.opacity = 1.0;
    flash.position.copy(origin);
    flash._colorFrom = new THREE.Color(1, 1, 1);
    flash._colorTo = new THREE.Color(1, 0.92, 0.7);
    flash.life = 0.22;
    flash.maxLife = 0.22;
    flash._expand = true;
    flash._expandAmount = big ? 1.8 : 1.2;
    this.scene.add(flash);
    this.list.push(flash);

    // ── Shock ring: thin, camera-facing pressure wave, fast ease-out ───────
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.96, 1.0, 48),
      new THREE.MeshBasicMaterial({
        color: 0xffddaa,
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    ring.position.copy(origin);
    ring.layers.set(1);
    ring.life = 0.45;
    ring.maxLife = 0.45;
    ring._expand = true;
    ring._expandAmount = big ? 8.0 : 4.5;
    ring._baseScale = 1;
    this.scene.add(ring);
    this.list.push(ring);

    // ── Main + secondary fireball puffs (temperature ramp, buoyant) ────────
    // Sizes/expansion are deliberately modest: the overlay camera shows only
    // ~4 world units at the plane, so a single oversized additive sprite can
    // fill the screen and stall a weak GPU. Keep each puff well under one
    // screen and let the group read as a fireball.
    const fireCount = opts.count || (big ? 40 : 22);
    for (let i = 0; i < fireCount; i++) {
      const size = (big ? 0.28 : 0.18) + Math.random() * (big ? 0.7 : 0.4);
      const puff = makePuff(size);
      puff.position.copy(origin);
      // White-hot core fraction, otherwise yellow flame.
      puff._colorFrom = i % 4 === 0
        ? new THREE.Color().setHSL(0.13, 0.6, 0.95)
        : new THREE.Color().setHSL(0.11, 1.0, 0.8);
      puff._colorTo = new THREE.Color().setHSL(0.02, 1.0, 0.12);
      puff.material.color.copy(puff._colorFrom);
      puff.material.opacity = 1.0;
      puff._vel = radialVelocity((big ? 1.5 : 1.0) + Math.random() * (big ? 5 : 3));
      puff._gravity = -(0.8 + Math.random() * 1.2);
      puff._drag = 1.2;
      // Staged: the first ~40% detonate at t=0, the rest trail in behind.
      puff._delay = i < fireCount * 0.4 ? 0 : Math.random() * 0.35;
      puff.visible = puff._delay <= 0;
      puff.life = (big ? 0.75 : 0.5) + Math.random() * (big ? 0.8 : 0.5);
      puff.maxLife = puff.life;
      puff._expand = true;
      puff._expandAmount = (big ? 1.6 : 1.2) * (0.7 + size * 0.6);
      this.scene.add(puff);
      this.list.push(puff);
    }

    // ── Sparks: fast, strong gravity, drag, flicker, cooling colour ────────
    const sparkCount = big ? 22 : 12;
    for (let i = 0; i < sparkCount; i++) {
      const puff = makePuff(0.05 + Math.random() * 0.08);
      puff.position.copy(origin);
      puff._colorFrom = new THREE.Color(0xffffcc);
      puff._colorTo = new THREE.Color(0xcc5500);
      puff.material.color.copy(puff._colorFrom);
      puff._vel = radialVelocity((big ? 12 : 6) + Math.random() * (big ? 40 : 20));
      puff._gravity = 9.81;
      puff._drag = 0.6;
      puff._flicker = true;
      puff.life = 0.18 + Math.random() * 0.36;
      puff.maxLife = puff.life;
      this.scene.add(puff);
      this.list.push(puff);
    }

    // ── Smoke: buoyant, expanding, darkening, trailing the fireball ────────
    const smokeCount = opts.smokeCount ?? (big ? 8 : 4);
    for (let i = 0; i < smokeCount; i++) {
      const size = (big ? 0.5 : 0.3) + Math.random() * (big ? 0.7 : 0.35);
      const puff = makePuff(size, { additive: false });
      const gray = 0.3 + Math.random() * 0.2;
      puff._colorFrom = new THREE.Color(gray, gray, gray);
      puff._colorTo = new THREE.Color(0.05, 0.05, 0.05);
      puff.material.color.copy(puff._colorFrom);
      puff.material.opacity = 0.75;
      puff.position.set(
        origin.x + (Math.random() - 0.5) * 0.6,
        origin.y + (Math.random() - 0.5) * 0.6,
        origin.z + (Math.random() - 0.5) * 0.6
      );
      puff._vel = new THREE.Vector3(
        (Math.random() - 0.5) * 1.2,
        0.6 + Math.random() * 2.0,
        (Math.random() - 0.5) * 1.2
      );
      puff._gravity = -0.8;
      puff._drag = 1.0;
      puff._delay = 0.12 + Math.random() * 0.4;
      puff.visible = false;
      puff.isSmoke = true;
      puff.life = (big ? 1.4 : 0.9) + Math.random() * (big ? 1.2 : 0.7);
      puff.maxLife = puff.life;
      puff._expand = true;
      puff._expandAmount = (big ? 2.0 : 1.4) * (0.7 + size * 0.5);
      this.scene.add(puff);
      this.list.push(puff);
    }
  },

  update(dt) {
    // Fade the persistent detonation light (not part of the list, so the
    // light count stays constant).
    if (this._lightLife > 0 && this._flashLight) {
      this._lightLife -= dt;
      const k = Math.max(0, this._lightLife / this._lightMax);
      this._flashLight.intensity = this._lightBase * k;
    }

    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];

      // Staged spawn: hold invisible until the delay elapses.
      if (p._delay > 0) {
        p._delay -= dt;
        if (p._delay > 0) continue;
        p.visible = true;
      }

      p.life -= dt * (p.isSmoke ? 1.1 : 1.0);
      if (p.life <= 0) {
        this.scene.remove(p);
        p.geometry?.dispose?.();
        // Materials stay alive so their shader programs are reused next crash.
        this.list.splice(i, 1);
        continue;
      }

      const t = Math.max(0, Math.min(1, p.life / p.maxLife));

      if (p._vel) {
        if (p._drag) p._vel.multiplyScalar(Math.max(0, 1 - p._drag * dt));
        p._vel.y -= (p._gravity ?? 9.81) * dt;
        p.position.addScaledVector(p._vel, dt);
      }

      // Temperature ramp: t=1 at birth (colourFrom), t=0 at death (colourTo).
      if (p._colorFrom && p._colorTo) {
        p.material.color.copy(p._colorTo).lerp(p._colorFrom, t);
      }

      if (p.material.opacity !== undefined) {
        p.material.opacity = Math.max(0, p.isSmoke ? t * 0.85 : t);
      }

      if (p._expand) {
        // Ease-out: the blast front moves fast, then decelerates.
        const easeOut = 1 - Math.pow(t, 3);
        const grow = 1.0 + easeOut * (p._expandAmount || 1.0);
        const base = p._baseScale || 1;
        p.scale.set(base * grow, base * grow, 1);
      }

      if (p._flicker) {
        p.material.opacity *= 0.6 + Math.random() * 0.4;
        p.scale.multiplyScalar(0.85 + Math.random() * 0.3);
      }
    }
  },
};
