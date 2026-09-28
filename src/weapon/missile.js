import * as THREE from "three";
import { particles } from "../utils/particles.js";
import { soundManager } from "../utils/soundManager.js";

/**
 * AIM-9 Sidewinder, adapted from dimartarmizi/web-flight-simulator
 * src/weapon/missile.js.
 *
 * Mesh recipe copied verbatim (body, nose, band, fins, exhaust flame +
 * core, canvas glow sprite), scaled to overlay-local space. Ref steers
 * toward a locked NPC and positions through the Cesium camera; this repo
 * has no NPC systems, so the missile dumb-fires straight ahead (-Z) with
 * a slight wobble, lays the same growing-smoke trail (in overlay space),
 * and detonates through the shared particles system at fuse-out.
 */
export class Missile {
  // nose: THREE.Vector3 overlay-local spawn point (alternating wing rail).
  constructor(scene, nose) {
    this.scene = scene;
    this.pos = nose.clone();
    this.vel = new THREE.Vector3((Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.4, -15);
    this.life = 5.0;
    this.maxLife = 5.0;
    this.active = true;
    this.trail = [];
    this.trailTimer = 0;
    this.wobbleSeed = Math.random() * 10;
    this.initMesh();
  }

  initMesh() {
    this.mesh = new THREE.Group();

    const bodyLen = 2.6;
    const radius = 0.07;
    const bodyGeom = new THREE.CylinderGeometry(radius, radius, bodyLen, 16);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.4, roughness: 0.5 });
    this.mesh.add(new THREE.Mesh(bodyGeom, bodyMat));

    const noseLen = 0.35;
    const noseGeom = new THREE.ConeGeometry(radius, noseLen, 16);
    noseGeom.translate(0, bodyLen / 2 + noseLen / 2, 0);
    this.mesh.add(new THREE.Mesh(noseGeom, new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.8, roughness: 0.3 })));

    const bandGeom = new THREE.CylinderGeometry(radius + 0.001, radius + 0.001, 0.15, 16);
    bandGeom.translate(0, bodyLen / 2 - 0.4, 0);
    this.mesh.add(new THREE.Mesh(bandGeom, new THREE.MeshBasicMaterial({ color: 0xffcc00 })));

    const finMat = new THREE.MeshStandardMaterial({ color: 0x444444, metalness: 0.3, roughness: 0.6 });
    const rearFinGeom = new THREE.BoxGeometry(0.35, 0.4, 0.02);
    rearFinGeom.translate(radius + 0.175, 0, 0);
    for (let i = 0; i < 4; i++) {
      const finGroup = new THREE.Group();
      finGroup.add(new THREE.Mesh(rearFinGeom, finMat));
      finGroup.position.y = -bodyLen / 2 + 0.3;
      finGroup.rotation.y = i * (Math.PI / 2);
      this.mesh.add(finGroup);
    }
    const frontFinGeom = new THREE.BoxGeometry(0.2, 0.15, 0.015);
    frontFinGeom.translate(radius + 0.1, 0, 0);
    for (let i = 0; i < 4; i++) {
      const finGroup = new THREE.Group();
      finGroup.add(new THREE.Mesh(frontFinGeom, finMat));
      finGroup.position.y = bodyLen / 2 - 0.6;
      finGroup.rotation.y = i * (Math.PI / 2);
      this.mesh.add(finGroup);
    }

    const flameGeom = new THREE.ConeGeometry(radius * 0.9, 1.0, 16, 1, true);
    flameGeom.rotateX(Math.PI);
    flameGeom.translate(0, -0.5, 0);
    this.flameMesh = new THREE.Mesh(flameGeom, new THREE.MeshBasicMaterial({
      color: new THREE.Color(1.0, 0.6, 0.2), transparent: true, opacity: 0.8,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending
    }));
    this.flameMesh.position.y = -bodyLen / 2;
    this.mesh.add(this.flameMesh);

    const coreGeom = new THREE.ConeGeometry(radius * 0.5, 0.6, 16, 1, true);
    coreGeom.rotateX(Math.PI);
    coreGeom.translate(0, -0.3, 0);
    this.flameCore = new THREE.Mesh(coreGeom, new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.9,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending
    }));
    this.flameMesh.add(this.flameCore);

    // Glow sprite recipe copied from ref-flight missile.js.
    const canvSize = 128;
    const canv = document.createElement("canvas");
    canv.width = canv.height = canvSize;
    const ctx = canv.getContext("2d");
    const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0.0, "rgba(255,255,255,1)");
    grad.addColorStop(0.18, "rgba(255,245,200,1)");
    grad.addColorStop(0.38, "rgba(255,160,30,0.95)");
    grad.addColorStop(0.62, "rgba(220,60,10,0.6)");
    grad.addColorStop(1.0, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvSize, canvSize);
    const glowTexture = new THREE.CanvasTexture(canv);
    glowTexture.minFilter = THREE.LinearFilter;
    glowTexture.magFilter = THREE.LinearFilter;
    this.flameGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture, color: new THREE.Color(1.0, 0.95, 0.9),
      transparent: true, opacity: 0.98, blending: THREE.AdditiveBlending,
      depthTest: false, depthWrite: false
    }));
    this.flameGlow.scale.set(2.2, 2.2, 1.0);
    this.flameGlow.position.y = -bodyLen / 2 - 0.08;
    this.mesh.add(this.flameGlow);

    // Ref geometry points +Y (nose +Y); overlay forward is -Z.
    this.mesh.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    // World-meter recipe shrunk to overlay scale (jet reads ~2 units).
    this.mesh.scale.setScalar(0.18);
    this.mesh.position.copy(this.pos);
    this.mesh.renderOrder = 9;
    this.mesh.traverse((child) => child.layers.set(1));
    this.scene.add(this.mesh);
  }

  spawnPuff() {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 8, 6),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false })
    );
    const gray = 0.5 + Math.random() * 0.4;
    m.material.color.setRGB(gray, gray, gray);
    m.position.copy(this.pos);
    m.layers.set(1);
    m.renderOrder = 8;
    this.scene.add(m);
    this.trail.push({ mesh: m, life: 2.2, maxLife: 2.2, seed: 0.8 + Math.random() * 0.5 });
  }

  updateTrail(dt) {
    if (this.active) {
      this.trailTimer += dt;
      while (this.trailTimer >= 0.08) {
        this.trailTimer -= 0.08;
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
      // Ref growth recipe: launch scale blooming ~15x over life.
      const s = t.seed * (1.0 + (1.0 - t.life / t.maxLife) * 15.0) * 0.12;
      t.mesh.scale.set(s, s, s);
      t.mesh.material.opacity = (t.life / t.maxLife) * 0.5;
    }
  }

  update(dt) {
    if (!this.active) {
      this.updateTrail(dt);
      return this.trail.length > 0;
    }
    // Exhaust flicker, copied from ref-flight missile.js.
    if (this.flameMesh) {
      const flicker = 0.8 + Math.random() * 0.4;
      const flickerLen = 0.9 + Math.random() * 0.2;
      this.flameMesh.scale.set(flicker, flickerLen, flicker);
      this.flameMesh.material.opacity = 0.7 + Math.random() * 0.3;
      if (this.flameCore) this.flameCore.scale.set(flicker, flickerLen, flicker);
    }
    this.life -= dt;
    if (this.life <= 0) {
      this.detonate();
      return true;
    }
    const t = performance.now() * 0.001;
    this.pos.addScaledVector(this.vel, dt);
    this.pos.x += Math.sin(t * 7 + this.wobbleSeed) * dt * 0.35;
    this.mesh.position.copy(this.pos);
    this.updateTrail(dt);
    return true;
  }

  detonate() {
    this.active = false;
    try {
      particles.spawnExplosion(this.pos.clone(), { big: true, count: 36, smokeCount: 8 });
      soundManager.play("explosion-random");
    } catch (e) { /* explosion is cosmetic */ }
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.traverse((child) => {
        child.geometry?.dispose?.();
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose?.());
        else child.material?.dispose?.();
      });
      this.mesh = null;
    }
  }

  get done() {
    return !this.active && this.trail.length === 0;
  }
}
