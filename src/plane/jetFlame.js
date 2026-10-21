import * as THREE from "three";

/**
 * Afterburner flame: an additive cylinder in the tailpipe whose length,
 * colour and shock diamonds are all driven from the fragment shader.
 *
 * Ported from the SHIPPED flight.tarmizi.id bundle (assets/index-Bkmtugvw.js,
 * byte ~995k) — that build is newer than the public repo this file originally
 * came from, and its afterburner is the one to match:
 *   - normal plume 2.4x longer (was 1.3x), boost plume 4x (was 2.2x)
 *   - blue-white boost tint plus an extra blue glow wash while boosting
 *   - a much tighter length fade when boosting (exponent 15 vs 5), so the
 *     plume reads as a sharp streak instead of a soft cone
 *   - `size` scales the NOZZLE (radius + base length) per aircraft; the
 *     engine offsets and the per-frame length scale stay as tuned here.
 */
export class JetFlame {
  constructor({ size = 1 } = {}) {
    this.size = size;
    this.group = new THREE.Group();

    const vertexShader = `
            varying vec2 vUv;
            varying vec3 vPosition;
            void main() {
                vUv = uv;
                vPosition = position;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `;

    const fragmentShader = `
            uniform float time;
            uniform float throttle;
            uniform float isBoosting;
            varying vec2 vUv;
            varying vec3 vPosition;

            float noise(vec2 p) {
                return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
            }

            void main() {
                float v = 1.0 - vUv.y;
                
                float effThrottle = max(throttle, isBoosting);

                float nonBoostLen = 0.4 + throttle * 1.0;
                float boostLen = 2.4;
                float activeLen = mix(nonBoostLen, boostLen, isBoosting);

                float nonBoostIntensity = 0.9 + throttle * 0.8;
                float boostIntensity = 1.3;
                float intensity = mix(nonBoostIntensity, boostIntensity, isBoosting);

                if (v > activeLen + 0.1) discard;

                vec3 coreColor = vec3(1.0, 0.9, 0.6); 
                
                vec3 normalMid = vec3(1.0, 0.3, 0.05);
                vec3 normalOuter = vec3(0.15, 0.35, 1.0);
                vec3 boostMid = vec3(0.4, 0.6, 1.0);
                vec3 boostOuter = vec3(0.1, 0.2, 1.0);

                vec3 midColor = mix(normalMid, boostMid, isBoosting);
                vec3 outerColor = mix(normalOuter, boostOuter, isBoosting);

                float radial = length(vPosition.xy);
                float glow = exp(-radial * 8.0);
                float core = exp(-radial * 22.0);
                
                float shockFreq = 20.0;
                float shock = pow(max(0.0, sin(v * shockFreq - time * 50.0)), 4.0);
                shock *= (0.2 + effThrottle * 0.8 + isBoosting * 0.2);
                
                float diamondPos = sin(v * 26.0 - time * 40.0);
                float diamondMesh = pow(max(0.0, diamondPos), 7.0) * (1.0 - v/activeLen);

                float flicker = 1.0 + 0.18 * noise(vec2(time * 20.0, v * 10.0));

                vec3 finalColor = mix(outerColor * 0.7, midColor, glow);
                
                float coreMix = core + diamondMesh * 0.7;
                vec3 detailColor = mix(coreColor, midColor, isBoosting * 0.3);
                finalColor = mix(finalColor, detailColor, coreMix);
                
                finalColor += detailColor * shock * glow;
                finalColor += mix(vec3(0.0), vec3(0.2, 0.4, 1.0), isBoosting) * glow;

                float currentFadeExp = mix(5.0, 15.0, isBoosting);
                float fade = pow(max(0.0, 1.0 - v / activeLen), currentFadeExp);
                
                float edgeFade = smoothstep(activeLen, activeLen * 0.2, v);
                
                float alpha = fade * intensity * (glow * 2.2 + core) * edgeFade;
                alpha = clamp(alpha * flicker, 0.0, 1.0);

                gl_FragColor = vec4(finalColor * intensity, alpha);
            }
        `;

    this.uniforms = {
      time: { value: 0 },
      throttle: { value: 0 },
      isBoosting: { value: 0 },
    };

    this.boostFactor = 0;

    const radial = 0.15 * this.size;
    const tip = 0.03 * this.size;
    const geometry = new THREE.CylinderGeometry(radial, tip, 2 * this.size, 16, 32, true);
    geometry.translate(0, -1, 0);
    geometry.rotateX(-Math.PI / 2);

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    this.flame = new THREE.Mesh(geometry, this.material);
    this.group.add(this.flame);

    this.light = new THREE.PointLight(0xff7a22, 1, 5);
    this.light.position.set(0, 0, 0);
    this.group.add(this.light);

    this.cNormal = new THREE.Color(0xff7a22);
    this.cBoost = new THREE.Color(0x9999ff);
  }

  update(throttle, isBoosting, time, dt) {
    const targetBoost = isBoosting ? 1.0 : 0.0;
    const boostSpeed = 5.0;
    this.boostFactor += (targetBoost - this.boostFactor) * Math.min(dt * boostSpeed, 1.0);

    this.uniforms.throttle.value = throttle;
    this.uniforms.isBoosting.value = this.boostFactor;
    this.uniforms.time.value = time;

    const length = (1.0 - this.boostFactor) * (0.6 + throttle * 1.4) + this.boostFactor * 4.0;

    const effectiveThrottle = Math.max(throttle, this.boostFactor);
    const widthScale = 1.1 + effectiveThrottle * 0.4;
    this.flame.scale.set(widthScale, widthScale, length);

    this.light.intensity = (1.0 - this.boostFactor) * (1.0 + throttle * 2.5) + this.boostFactor * 7.5;
    this.light.color.copy(this.cNormal).lerp(this.cBoost, this.boostFactor);
  }
}
