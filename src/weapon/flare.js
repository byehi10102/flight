import * as THREE from "three";

/**
 * MJU-7A countermeasure flare, adapted from dimartarmizi/web-flight-simulator
 * src/weapon/flare.js.
 *
 * Sprite recipe copied verbatim (white-yellow core + orange halo, flicker,
 * gravity sag, cooling). Ref moves in world space through the Cesium
 * camera; here it ejects backward/down in overlay-local space from the
 * tail and burns out over 4 s, laying gray smoke puffs like the ref trail.
 */
export class Flare {
  // tail: THREE.Vector3 overlay-local spawn point (behind the jet).
  constructor(scene, tail) {
    this.scene = scene;
    this.pos = tail.clone();
    this.vel = new THREE.Vector3(
      (Math.random() - 0.5) * 2.4,
      -0.6 - Math.random() * 1.2,
      5.0 + Math.random() * 2.0
    );
    this.gravity = 5.0;
    this.life = 4.0;
    this.maxLife = 4.0;
    this.active = true;
    this.trail = [];
    this.trailTimer = 0;
    this.initMesh();
  }

  initMesh() {
    this.group = new THREE.Group();
    const coreSize = 64;
    const canvas = document.createElement("canvas");
    canvas.width = coreSize;
    canvas.height = coreSize;
    const ctx = canvas.getContext("2d");
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "#ffffff");
    grad.addColorStop(0.2, "#ffff66");
    grad.addColorStop(0.5, "#ffff00");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, coreSize, coreSize);
    const flareTexture = new THREE.CanvasTexture(canvas);

    this.flareSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: flareTexture, color: 0xffff44, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false
    }));
    this.flareSprite.scale.set(0.5, 0.5, 1.0);
    this.group.add(this.flareSprite);

    this.glowSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: flareTexture, color: 0xffaa00, transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false
    }));
    this.glowSprite.scale.set(1.3, 1.3, 1.0);
    this.group.add(this.glowSprite);

    this.group.position.copy(this.pos);
    this.group.renderOrder = 9;
    this.group.traverse((child) => child.layers.set(1));
    this.scene.add(this.group);
  }

  spawnPuff() {
    const gray = 0.4 + Math.random() * 0.4;
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 8, 6),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5, depthWrite: false })
    );
    m.material.color.setRGB(gray, gray, gray);
    m.position.copy(this.pos);
    m.layers.set(1);
    m.renderOrder = 8;
    this.scene.add(m);
    this.trail.push({ mesh: m, life: 2.5, maxLife: 2.5, seed: 0.5 + Math.random() * 0.5 });
  }

  updateTrail(dt) {
    if (this.active) {
      this.trailTimer += dt;
      while (this.trailTimer >= 0.1) {
        this.trailTimer -= 0.1;
        this.spawnPuff();
      }
    }
    for (let i = this.trail.length - 1; i >= 0; i--) {
      const t = this.trail[i];
      t.life -= dt;
      if (t.life <= 0) {
        this.scene.remove(t.mesh);
        t.mesh.geometry.dispose();
        t.mesh.material.dispose();
        this.trail.splice(i, 1);
        continue;
      }
      const lifeRatio = t.life / t.maxLife;
      const s = t.seed * (1.0 + (1.0 - lifeRatio) * 8.0) * 0.12;
      t.mesh.scale.set(s, s, s);
      t.mesh.material.opacity = lifeRatio * 0.4;
      t.mesh.position.y += 0.15 * dt;
    }
  }

  update(dt) {
    if (!this.active) {
      this.updateTrail(dt);
      return this.trail.length > 0;
    }
    this.life -= dt;
    if (this.life <= 0) {
      this.destroy();
      return this.trail.length > 0;
    }
    this.vel.y -= this.gravity * dt;
    // Ref-flight drag (speed *= 0.98 per 60 fps frame), made dt-correct.
    this.vel.multiplyScalar(Math.pow(0.98, dt * 60));
    this.pos.addScaledVector(this.vel, dt);
    this.group.position.copy(this.pos);
    this.updateTrail(dt);
    const t = this.life / this.maxLife;
    if (this.flareSprite) {
      this.flareSprite.material.opacity = Math.min(1.0, t * 1.5);
      const flicker = 0.9 + Math.random() * 0.2;
      this.flareSprite.scale.set(0.5 * flicker, 0.5 * flicker, 1.0);
    }
    if (this.glowSprite) {
      this.glowSprite.material.opacity = Math.min(0.8, t * 1.2);
      const flicker = 0.8 + Math.random() * 0.4;
      this.glowSprite.scale.set(1.3 * flicker, 1.3 * flicker, 1.0);
    }
    return true;
  }

  destroy() {
    this.active = false;
    if (this.group) {
      this.scene.remove(this.group);
      this.group.traverse((child) => {
        if (Array.isArray(child.material)) child.material.forEach((m) => { m.map?.dispose?.(); m.dispose?.(); });
        else { child.material?.map?.dispose?.(); child.material?.dispose?.(); }
      });
      this.group = null;
    }
  }

  get done() {
    return !this.active && this.trail.length === 0;
  }
}
