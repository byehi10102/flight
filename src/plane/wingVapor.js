import * as THREE from "three";

/**
 * Wingtip vapor puffs.
 *
 * NOTE: dimartarmizi/web-flight-simulator has no wing-vapor system — its
 * speed feel is afterburner flames + boost roll + FOV/shake/vignette (all
 * already in this repo). This is built fresh in the same visual language:
 * soft additive puffs at the wingtips that fade in with maneuver G, speed
 * and boost, sized from the measured model bounding box so it fits any GLB.
 */
function makePuffTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,0.85)");
  grad.addColorStop(0.4, "rgba(230,240,255,0.35)");
  grad.addColorStop(1, "rgba(220,235,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export class WingVapor {
  // parent: scaled model group; size: unscaled bounding-box size (local units).
  constructor(parent, size) {
    this.baseScale = Math.max(0.8, (size?.x || 4) * 0.28);
    this.baseZ = (size?.z || 4) * 0.2;
    this.halfSpan = (size?.x || 4) / 2;
    this.puffs = [];
    const tex = makePuffTexture();
    for (const side of [-1, 1]) {
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      });
      const s = new THREE.Sprite(mat);
      s.position.set(side * this.halfSpan, 0, this.baseZ);
      s.scale.set(this.baseScale, this.baseScale * 0.6, 1);
      s.renderOrder = 10;
      s.layers.set(1);
      parent.add(s);
      this.puffs.push({ sprite: s, seed: Math.random() * 10 });
    }
    this.intensity = 0;
  }

  update(dt, target, time) {
    this.intensity += (target - this.intensity) * Math.min(1, dt * 4);
    const k = Math.max(0, Math.min(1, this.intensity));
    for (const p of this.puffs) {
      const flick = 0.85 + 0.15 * Math.sin(time * 9 + p.seed * 7);
      p.sprite.material.opacity = Math.min(0.75, k * flick);
      const grow = 1 + k * 0.6 + 0.05 * Math.sin(time * 7 + p.seed * 3);
      p.sprite.scale.set(this.baseScale * grow, this.baseScale * 0.6 * grow, 1);
      p.sprite.position.z = this.baseZ + k * 1.5;
    }
  }

  reset() {
    this.intensity = 0;
    for (const p of this.puffs) p.sprite.material.opacity = 0;
  }
}
