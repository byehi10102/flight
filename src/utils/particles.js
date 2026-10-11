import * as THREE from "three";
import { getQualityProfile } from "../core/quality.js";

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
 *
 * POOLING: the whole burst is built ONCE and recycled. The original flow
 * created ~112 sprites + their SpriteMaterials inside the impact frame — an
 * allocation spike that stuttered weak GPUs at the exact moment two full
 * renderers were already busy. Pooled sprites keep their own materials (the
 * per-sprite colour ramp and opacity need them), are reset on release, and
 * never get disposed — three.js's program cache stays warm across crashes.
 */

let _puffTexture = null;

/**
 * Shared soft puff texture: an opaque hot centre fading to a transparent edge,
 * with a few low-frequency holes punched in so the silhouette is billowy
 * rather than a perfect disc. Built once, reused by every sprite, never
 * disposed (tiny, and re-uploading it per crash is the stall it avoids).
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
  sprite.visible = false; // pooled: hidden until a burst acquires it
  return sprite;
}

/** The pressure-wave ring (pooled like the puffs; geometry is reused). */
function makeRing() {
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
  ring.layers.set(1);
  ring.visible = false;
  return ring;
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

/**
 * Tier-scaled burst budget (pure, unit-tested). The caller's explicit counts
 * (the crash site's 72/22/16) are the high-tier baseline; the auto quality
 * tier's explosionScale trims every category proportionally so weak GPUs get
 * a leaner — but identically styled — burst.
 */
export function explosionCounts(profile = {}, opts = {}) {
  const big = opts.big !== false;
  const scale = Number(profile && profile.explosionScale) > 0 ? profile.explosionScale : 1;
  const base = {
    fire: Number.isFinite(opts.count) ? opts.count : (big ? 40 : 22),
    sparks: big ? 22 : 12,
    smoke: Number.isFinite(opts.smokeCount) ? opts.smokeCount : (big ? 8 : 4),
  };
  return {
    fire: Math.max(1, Math.round(base.fire * scale)),
    sparks: Math.max(1, Math.round(base.sparks * scale)),
    smoke: Math.max(1, Math.round(base.smoke * scale)),
  };
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
  // Sprite pool, built once at init from the tier budget (+ headroom) and
  // recycled forever. _pool[category] holds released sprites.
  _pool: null,

  init(scene) {
    this.scene = scene;
    if (!this._flashLight) {
      this._flashLight = new THREE.PointLight(0xffaa55, 0, 7, 2);
      this._flashLight.layers.enable(1);
      this.scene.add(this._flashLight);
    }
    this._initPool();
  },

  /** Build the pool once. Sized from the tier's biggest possible burst. */
  _initPool() {
    if (this._pool) return;
    // Biggest burst in the game: the crash site's big detonation.
    const budget = explosionCounts(getQualityProfile(), { big: true, count: 72, smokeCount: 16 });
    const sizes = {
      flash: 2,
      ring: 2,
      fire: budget.fire + 4,
      sparks: budget.sparks + 4,
      smoke: budget.smoke + 2,
    };
    this._pool = { flash: [], ring: [], fire: [], sparks: [], smoke: [] };
    for (let i = 0; i < sizes.flash; i++) this._pool.flash.push(makePuff(1.4));
    for (let i = 0; i < sizes.ring; i++) this._pool.ring.push(makeRing());
    for (let i = 0; i < sizes.fire; i++) this._pool.fire.push(makePuff(0.5));
    for (let i = 0; i < sizes.sparks; i++) this._pool.sparks.push(makePuff(0.08));
    for (let i = 0; i < sizes.smoke; i++) this._pool.smoke.push(makePuff(0.6, { additive: false }));
  },

  _acquire(cat, make) {
    this._initPool();
    const sprite = this._pool[cat].pop() || make();
    sprite._poolCat = cat;
    sprite.visible = true;
    this.scene.add(sprite);
    return sprite;
  },

  _release(p) {
    try { this.scene?.remove(p); } catch (e) { /* already detached */ }
    p.visible = false;
    p._delay = 0;
    if (this._pool && p._poolCat && this._pool[p._poolCat]) {
      this._pool[p._poolCat].push(p);
    }
  },

  clear() {
    for (const p of this.list) {
      this._release(p);
    }
    this.list.length = 0;
    // The shared puff texture and the pool are deliberately NOT disposed:
    // they are the whole point (nothing is rebuilt on the next crash). The
    // persistent light is dimmed instead of removed, so the light count (and
    // shader programs) never change.
    this._lightLife = 0;
    if (this._flashLight) this._flashLight.intensity = 0;
  },

  spawnExplosion(center, opts = {}) {
    if (!this.scene) return;
    const big = opts.big !== false;
    const origin = center?.clone?.() ?? new THREE.Vector3(0, -0.8, -2.75);
    const budget = explosionCounts(getQualityProfile(), { big, count: opts.count, smokeCount: opts.smokeCount });

    // ── Detonation light: re-aim the persistent light and re-arm its fade ──
    if (this._flashLight) {
      this._flashLight.position.copy(origin);
      this._lightBase = big ? 4 : 2;
      this._flashLight.intensity = this._lightBase;
      this._lightMax = 0.22;
      this._lightLife = this._lightMax;
    }

    // ── White flash: bright additive puff, decays very fast ────────────────
    const flash = this._acquire("flash", () => makePuff(big ? 1.8 : 1.1));
    const flashSize = big ? 1.8 : 1.1;
    flash._baseScale = flashSize;
    flash.scale.set(flashSize, flashSize, 1);
    flash.material.color.setRGB(1, 1, 1);
    flash.material.opacity = 1.0;
    flash.position.copy(origin);
    flash._colorFrom = new THREE.Color(1, 1, 1);
    flash._colorTo = new THREE.Color(1, 0.92, 0.7);
    flash.life = 0.22;
    flash.maxLife = 0.22;
    flash._expand = true;
    flash._expandAmount = big ? 1.8 : 1.2;
    this.list.push(flash);

    // ── Shock ring: thin, camera-facing pressure wave, fast ease-out ───────
    const ring = this._acquire("ring", makeRing);
    ring.scale.set(1, 1, 1);
    ring.material.opacity = 0.55;
    ring.position.copy(origin);
    ring.visible = true;
    ring.life = 0.45;
    ring.maxLife = 0.45;
    ring._expand = true;
    ring._expandAmount = big ? 8.0 : 4.5;
    ring._baseScale = 1;
    this.list.push(ring);

    // ── Main + secondary fireball puffs (temperature ramp, buoyant) ───────
    // Sizes/expansion are deliberately modest: the overlay camera shows only
    // ~4 world units at the plane, so a single oversized additive sprite can
    // fill the screen and stall a weak GPU. Keep each puff well under one
    // screen and let the group read as a fireball.
    for (let i = 0; i < budget.fire; i++) {
      const size = (big ? 0.28 : 0.18) + Math.random() * (big ? 0.7 : 0.4);
      const puff = this._acquire("fire", () => makePuff(size));
      puff._baseScale = size;
      puff.scale.set(size, size, 1);
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
      puff._delay = i < budget.fire * 0.4 ? 0 : Math.random() * 0.35;
      puff.visible = puff._delay <= 0;
      puff.life = (big ? 0.75 : 0.5) + Math.random() * (big ? 0.8 : 0.5);
      puff.maxLife = puff.life;
      puff._expand = true;
      puff._expandAmount = (big ? 1.6 : 1.2) * (0.7 + size * 0.6);
      this.list.push(puff);
    }

    // ── Sparks: fast, strong gravity, drag, flicker, cooling colour ─────────
    for (let i = 0; i < budget.sparks; i++) {
      const size = 0.05 + Math.random() * 0.08;
      const puff = this._acquire("sparks", () => makePuff(size));
      puff._baseScale = size;
      puff.scale.set(size, size, 1);
      puff.visible = true;
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
      this.list.push(puff);
    }

    // ── Smoke: buoyant, expanding, darkening, trailing the fireball ────────
    for (let i = 0; i < budget.smoke; i++) {
      const size = (big ? 0.5 : 0.3) + Math.random() * (big ? 0.7 : 0.35);
      const puff = this._acquire("smoke", () => makePuff(size, { additive: false }));
      puff._baseScale = size;
      puff.scale.set(size, size, 1);
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
        this._release(p);
        // Pooled sprites keep their materials and geometry — nothing is
        // disposed, so the next burst never recompiles or re-uploads.
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
