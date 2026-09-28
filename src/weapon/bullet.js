import * as THREE from "three";

/**
 * Cannon tracer, adapted from dimartarmizi/web-flight-simulator
 * src/weapon/bullet.js.
 *
 * Ref flies bullets in world space (lon/lat/alt) and places their mesh
 * through the Cesium camera matrix. This repo's Three.js layer is a
 * camera-locked overlay (Cesium owns world tracking), so the SAME tracer
 * visuals — red→yellow→white gradient planes + white tip, shader copied
 * verbatim — fly in overlay-local space straight ahead (-Z) from the nose
 * and burn out after ~1.2 s. NPC hit checks are omitted: this repo has no
 * NPC systems.
 */
const FORWARD = new THREE.Vector3(0, 0, -1);

export class Bullet {
  // nose: THREE.Vector3 overlay-local spawn point (plane nose).
  constructor(scene, nose) {
    this.scene = scene;
    this.pos = nose.clone();
    // Slight spread so sustained fire reads as a stream, not one line.
    this.vel = new THREE.Vector3(
      (Math.random() - 0.5) * 1.6,
      (Math.random() - 0.5) * 1.6,
      -46 - Math.random() * 8
    );
    this.life = 1.2;
    this.maxLife = 1.2;
    this.active = true;
    this.initMesh();
  }

  initMesh() {
    // Gradient shader copied from ref-flight bullet.js.
    const createGradientMaterial = (opacity, intensity) => {
      return new THREE.ShaderMaterial({
        uniforms: {
          colorStart: { value: new THREE.Color(0xff3300) },
          colorMid: { value: new THREE.Color(0xffcc00) },
          colorEnd: { value: new THREE.Color(0xffffff) },
          opacity: { value: opacity },
          intensity: { value: intensity }
        },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 colorStart;
          uniform vec3 colorMid;
          uniform vec3 colorEnd;
          uniform float opacity;
          uniform float intensity;
          varying vec2 vUv;
          void main() {
            float t = clamp(vUv.y, 0.0, 1.0);
            vec3 a = mix(colorStart, colorMid, smoothstep(0.0, 0.5, t));
            vec3 b = mix(colorMid, colorEnd, smoothstep(0.5, 1.0, t));
            vec3 col = mix(a, b, smoothstep(0.0, 1.0, t));
            float alpha = opacity * pow(t, 0.6) * intensity;
            float edge = 1.0 - smoothstep(0.0, 0.5, abs(vUv.x - 0.5) * 2.0);
            alpha *= edge;
            gl_FragColor = vec4(col, alpha);
          }
        `,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide
      });
    };

    // Ref geometry points +Y (its matrix maps +Y to flight direction);
    // overlay flight direction is -Z, so bake a -90° X rotation and keep
    // the +Y-forward recipe untouched below it.
    const align = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    const mainLen = 4;

    this.mesh = new THREE.Group();

    const createPlaneMesh = (width, len, opacity, intensity) => {
      const geom = new THREE.PlaneGeometry(width, len, 1, 1);
      geom.translate(0, -len / 2, 0);
      return new THREE.Mesh(geom, createGradientMaterial(opacity, intensity));
    };

    for (let i = 0; i < 3; i++) {
      const p = createPlaneMesh(0.06, mainLen, 1.0, 1.0);
      p.rotateY((i * Math.PI * 2) / 3);
      this.mesh.add(p);
    }

    for (let i = 0; i < 3; i++) {
      const g = createPlaneMesh(0.16, mainLen * 1.1, 0.35, 0.65);
      g.rotateY((i * Math.PI * 2) / 3 + Math.PI / 6);
      this.mesh.add(g);
    }

    const tipGeom = new THREE.ConeGeometry(0.012, 0.08, 12);
    tipGeom.translate(0, -0.04, 0);
    const tip = new THREE.Mesh(
      tipGeom,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1.0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false })
    );
    this.mesh.add(tip);

    this.mesh.quaternion.copy(align);
    this.mesh.position.copy(this.pos);
    this.mesh.renderOrder = 9;
    this.mesh.traverse((child) => child.layers.set(1));
    this.scene.add(this.mesh);
  }

  update(dt) {
    if (!this.active) return;
    this.life -= dt;
    if (this.life <= 0) {
      this.destroy();
      return;
    }
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.position.copy(this.pos);
    const fade = Math.min(1, this.life / (this.maxLife * 0.4));
    this.mesh.traverse((child) => {
      if (child.material && child.material.uniforms && child.material.uniforms.opacity) {
        child.material.uniforms.opacity.value = fade;
      } else if (child.material && child.material.transparent) {
        child.material.opacity = fade;
      }
    });
  }

  destroy() {
    this.active = false;
    if (!this.mesh) return;
    this.scene.remove(this.mesh);
    this.mesh.traverse((child) => {
      child.geometry?.dispose?.();
      if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose?.());
      else child.material?.dispose?.();
    });
    this.mesh = null;
  }
}
