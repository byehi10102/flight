import * as THREE from "three";

/**
 * Explosion particles, adapted from dimartarmizi/web-flight-simulator
 * src/utils/particles.js.
 *
 * Ref positions particles in world space through the Cesium camera matrix,
 * but this repo's Three.js camera is locked at the origin (overlay
 * architecture — Cesium owns world tracking). So the same explosion recipe
 * (white flash + orange fireballs + fast sparks + gray smoke, with expand,
 * gravity and fade) runs in Three.js local space around the crash point,
 * which is the plane's on-screen position.
 */
export const particles = {
  scene: null,
  list: [],

  init(scene) {
    this.scene = scene;
  },

  clear() {
    for (const p of this.list) {
      this.scene?.remove(p);
      p.geometry?.dispose?.();
      p.material?.dispose?.();
    }
    this.list.length = 0;
  },

  spawnExplosion(center, opts = {}) {
    if (!this.scene) return;
    const big = opts.big !== false;
    const origin = center?.clone?.() ?? new THREE.Vector3(0, -0.8, -2.75);

    // White flash (bigger, holds a beat longer so impact reads instantly)
    const flashSize = big ? 3.0 : 1.6;
    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(flashSize, 12, 10),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, opacity: 1.0, depthWrite: false,
      })
    );
    flash.position.copy(origin);
    flash.layers.set(1);
    flash.life = 0.3;
    flash.maxLife = 0.3;
    flash._expand = true;
    flash._expandAmount = big ? 3.0 : 1.5;
    this.scene.add(flash);
    this.list.push(flash);

    // Shockwave ring, face-on to the chase camera, expanding + fading.
    // The generic update() loop below drives life/opacity/growth.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.0, 48),
      new THREE.MeshBasicMaterial({
        color: 0xffddaa, blending: THREE.AdditiveBlending, transparent: true,
        opacity: 0.9, side: THREE.DoubleSide, depthWrite: false,
      })
    );
    ring.position.copy(origin);
    ring.layers.set(1);
    ring.life = 0.5;
    ring.maxLife = 0.5;
    ring._expand = true;
    ring._expandAmount = big ? 7.0 : 4.0;
    this.scene.add(ring);
    this.list.push(ring);

    // Fireballs (orange HSL, additive) with a white-hot core fraction
    const fireCount = opts.count || (big ? 48 : 24);
    for (let i = 0; i < fireCount; i++) {
      const size = (big ? 0.25 : 0.15) + Math.random() * (big ? 1.1 : 0.4);
      const color = i % 3 === 0
        ? new THREE.Color().setHSL(0.12, 1.0, 0.75 + Math.random() * 0.15)
        : new THREE.Color().setHSL(0.08 - Math.random() * 0.05, 1.0, 0.5 + Math.random() * 0.2);
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(size, 8, 6),
        new THREE.MeshBasicMaterial({
          color, blending: THREE.AdditiveBlending, transparent: true, opacity: 1.0, depthWrite: false,
        })
      );
      m.position.copy(origin);
      m.layers.set(1);
      const h = Math.random() * Math.PI * 2;
      const p = (Math.random() * 120 - 60) * (Math.PI / 180);
      const speed = (big ? 6 : 3) + Math.random() * (big ? 22 : 12);
      m._vel = new THREE.Vector3(
        Math.sin(h) * Math.cos(p) * speed,
        Math.sin(p) * speed,
        Math.cos(h) * Math.cos(p) * speed
      );
      m.life = (big ? 0.9 : 0.6) + Math.random() * (big ? 1.4 : 0.8);
      m.maxLife = m.life;
      m._expand = true;
      m._expandAmount = big ? 2.8 : 1.8;
      m._gravity = 9.81;
      this.scene.add(m);
      this.list.push(m);
    }

    // Sparks (fast, pale yellow)
    const sparkCount = big ? 28 : 14;
    for (let i = 0; i < sparkCount; i++) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.03 + Math.random() * 0.06, 6, 6),
        new THREE.MeshBasicMaterial({
          color: 0xffffcc, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
        })
      );
      m.position.copy(origin);
      m.layers.set(1);
      const h = Math.random() * Math.PI * 2;
      const p = (Math.random() * 120 - 60) * (Math.PI / 180);
      const speed = (big ? 12 : 6) + Math.random() * (big ? 40 : 20);
      m._vel = new THREE.Vector3(
        Math.sin(h) * Math.cos(p) * speed,
        Math.sin(p) * speed,
        Math.cos(h) * Math.cos(p) * speed
      );
      m.life = 0.18 + Math.random() * 0.36;
      m.maxLife = m.life;
      m._gravity = 9.81;
      this.scene.add(m);
      this.list.push(m);
    }

    // Smoke (gray, rising, opaque-ish)
    const smokeCount = opts.smokeCount ?? (big ? 10 : 5);
    for (let i = 0; i < smokeCount; i++) {
      const size = (big ? 0.9 : 0.5) + Math.random() * (big ? 1.4 : 0.6);
      const gray = 0.08 + Math.random() * 0.3;
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(size, 12, 10),
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(gray, gray, gray), transparent: true, opacity: 0.75, depthWrite: false,
        })
      );
      m.position.set(
        origin.x + (Math.random() - 0.5) * 0.6,
        origin.y + (Math.random() - 0.5) * 0.6,
        origin.z + (Math.random() - 0.5) * 0.6
      );
      m.layers.set(1);
      m._vel = new THREE.Vector3(
        (Math.random() - 0.5) * 1.2,
        0.6 + Math.random() * 2.0,
        (Math.random() - 0.5) * 1.2
      );
      m.life = (big ? 1.2 : 0.8) + Math.random() * (big ? 1.4 : 0.8);
      m.maxLife = m.life;
      m.isSmoke = true;
      m._gravity = -1.5;
      this.scene.add(m);
      this.list.push(m);
    }
  },

  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.life -= dt * (p.isSmoke ? 1.1 : 1.0);
      if (p.life <= 0) {
        this.scene.remove(p);
        p.geometry?.dispose?.();
        p.material?.dispose?.();
        this.list.splice(i, 1);
        continue;
      }
      if (p._vel) {
        p._vel.y -= (p._gravity ?? 9.81) * dt;
        p.position.addScaledVector(p._vel, dt);
      }
      const t = p.life / p.maxLife;
      if (p.material?.opacity !== undefined) {
        p.material.opacity = Math.max(0, p.isSmoke ? t * 0.85 : t);
      }
      if (p._expand) {
        const grow = 1.0 + (1.0 - t) * (p._expandAmount || 1.0);
        p.scale.set(grow, grow, grow);
      } else if (p.isSmoke) {
        const grow = 1.0 + (1.0 - t) * 2.0;
        p.scale.set(grow, grow, grow);
      }
    }
  },
};
