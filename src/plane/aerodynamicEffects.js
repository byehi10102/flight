import * as THREE from "three";
import { Cartesian3, Matrix4, Math as CesiumMath } from "cesium";
import {
  AERO,
  clamp01,
  expLerp,
  speedFactor,
  condensationTarget,
  vortexTarget,
  condensationSampleCounts,
  condensationGrid,
  trailPointCapacity,
  trailSpawnSteps,
  trailSpacing,
  trailKeepDistance,
} from "./aeroMath.js";

/**
 * Wing vapor + wingtip vortices, ported from the shipped flight.tarmizi.id
 * bundle (assets/index-Bkmtugvw.js, byte ~936k):
 *
 *   - Two "condensation" cloud pads per wing (a flat one over the outer wing
 *     plus a curved one that wraps the upper surface), drawn as point sprites
 *     whose position is SYNTHESISED in the vertex shader from per-particle
 *     span/chord/jitter/gust attributes, so nothing is animated on the CPU.
 *     They fade in with speed x pull-up and stream aft with a wind push.
 *   - Wingtip vortex trails: world-space samples pushed behind each wingtip
 *     every TRAIL_MIN_DISTANCE travelled, aged, then re-projected into the
 *     camera's VIEW space on the CPU each frame (the vertex shader only
 *     projects), with 4 interpolated points per gap so the ribbon is smooth.
 *
 * The reference lives in the same two-camera setup this game uses (a Three.js
 * camera parked at the origin drawing the jet, Cesium drawing the world), so
 * the port keeps its structure. Three deliberate adaptations:
 *
 *   1. Sizes: the reference's geometry numbers assume a model at scale 1.
 *      This game scales the model group by `aircraft.modelScale` (x the live
 *      FOV compensation), so every world-space size is multiplied by the live
 *      `playerModel.scale.x` to keep the same on-screen proportions.
 *   2. The reference's condensation shader hardcodes `620.0` as a pixel/unit
 *      constant and its `getWorldOffsetPosition` re-applies the FOV ratio.
 *      Here the shader uses the real half-viewport height (like the trail
 *      shader) and the FOV ratio is skipped, because this game's model group
 *      already folds that ratio into its position and scale.
 *   3. Layers: everything is put on layer 1, the overlay layer this game's
 *      plane camera renders (`camera.layers.set(1)`).
 *
 * Anything not reachable this way (the reference's NPC variant, its settings
 * toggle) is not ported.
 */

const CONDENSATION_VERTEX = `
attribute float aSize;
attribute float aOpacity;
attribute float aSpan;
attribute float aChord;
attribute float aJitterX;
attribute float aJitterY;
attribute float aJitterZ;
attribute float aG0;
attribute float aG1;
attribute float aG2;
attribute float aG3;

varying float vOpacity;

uniform vec3 uRoot;
uniform vec3 uMid;
uniform vec3 uTip;
uniform vec3 uSpread;
uniform float uSideSign;
uniform float uTime;
uniform float uIntensity;
uniform float uRelease;
uniform float uWindPush;
uniform float uBaseSize;
uniform float uCurve;
uniform float uCorePull;
uniform float uHalfHeight;

void main() {
	float spanT = pow(aSpan, 0.92);
	float chordT = pow(aChord, 1.08);
	float spanCurve = pow(spanT, 1.05);

	float rootX = uRoot.x;
	float tipX = uTip.x;
	float rootZ = uRoot.z;
	float tipZ = uTip.z;

	float baseLeadingX = mix(rootX + uSideSign * 0.05, tipX, spanCurve);
	float baseLeadingZ = mix(rootZ + 0.02, tipZ + 0.08, spanCurve);
	float invT = 1.0 - spanCurve;
	vec3 curvePos =
		vec3(rootX, uRoot.y, rootZ) * invT * invT +
		uMid * 2.0 * invT * spanCurve +
		vec3(tipX, uTip.y, tipZ) * spanCurve * spanCurve;
	float leadingX = mix(baseLeadingX, curvePos.x, uCurve);
	float leadingZ = mix(baseLeadingZ, curvePos.z, uCurve);
	float curveLift = mix(0.0, curvePos.y - mix(uRoot.y, uTip.y, spanCurve), uCurve);

	float rootChord = max(0.45, uSpread.z * 0.95);
	float tipChord = max(0.12, rootChord * 0.26);
	float chordLen = mix(rootChord, tipChord, spanCurve);
	float chordOffset = chordLen * (0.04 + chordT * 0.96);

	float spanLength = max(0.25, abs(tipX - rootX));
	float planformWidth = mix(spanLength * 0.02, spanLength * 0.008, spanCurve);
	float wingX = leadingX + aJitterX * planformWidth;
	wingX -= uSideSign * uCorePull * pow(1.0 - spanT, 1.7);

	float camber = sin((1.0 - chordT) * 3.14159265) * 0.004;
	float wingY =
		uRoot.y +
		curveLift +
		camber +
		aJitterY * max(0.006, uSpread.y * 0.16) +
		sin(uTime * (3.3 + aG0 * 1.4) + aG1 * 11.0) * 0.006 * uIntensity;

	float aft =
		leadingZ +
		chordOffset +
		uWindPush * (0.18 + chordT * 0.7 + spanT * 0.5 + aG0 * 0.18) +
		aJitterZ * 0.03;

	float spanBand = clamp(1.0 - abs(spanT - 0.56) * 1.35, 0.0, 1.0);
	float chordBand = clamp(1.0 - chordT * 0.78, 0.0, 1.0);
	float shapeFade = clamp(0.2 + spanBand * chordBand, 0.0, 1.0);
	float coreBand = clamp(1.0 - spanT * 1.75, 0.0, 1.0);
	shapeFade *= mix(1.0, 0.74 + coreBand * 0.58, uCurve);
	float rearBiasedFade = mix(1.0, pow(chordT, 0.55), uRelease * 1.15);
	float gust = max(0.42,
		(0.65 + 0.35 * sin(uTime * (2.8 + aG0 * 1.3) + aG1 * 9.0)) *
		(0.7 + 0.3 * sin(uTime * (4.4 + aG2 * 1.9) + aG3 * 11.0))
	);

	vOpacity = uIntensity * aOpacity * shapeFade * gust * rearBiasedFade;
	vec3 simPos = vec3(wingX, wingY, aft);
	vec4 mvPosition = modelViewMatrix * vec4(simPos, 1.0);
	gl_Position = projectionMatrix * mvPosition;
	float dist = max(0.1, -mvPosition.z);
	float simSize = uBaseSize * aSize * shapeFade;
	gl_PointSize = clamp(simSize * projectionMatrix[1][1] / dist * uHalfHeight, 1.0, 360.0);
}`;

const CONDENSATION_FRAGMENT = `
precision mediump float;

varying float vOpacity;

void main() {
	vec2 uv = gl_PointCoord - vec2(0.5);
	vec2 ellipse = vec2(uv.x * 0.24, uv.y * 1.35);
	float dist = length(ellipse);
	if (dist > 0.54) discard;
	float edgeMask = 1.0 - smoothstep(0.4, 0.54, dist);
	float body = 1.0 - smoothstep(0.04, 0.5, dist);
	float core = 1.0 - smoothstep(0.0, 0.28, dist);
	float tipFade = 1.0 - smoothstep(0.24, 0.5, abs(uv.x));
	float edgeSoftness = 1.0 - smoothstep(0.1, 0.5, abs(uv.y));
	float alpha = (body * 0.75 + core * 0.5) * tipFade * edgeSoftness * edgeMask * vOpacity;
	gl_FragColor = vec4(0.97, 0.99, 1.0, alpha);
}`;

const TRAIL_VERTEX = `
attribute float aSize;
attribute float aOpacity;

varying float vOpacity;

uniform float uHalfHeight;

void main() {
	vOpacity = aOpacity;
	gl_Position = projectionMatrix * vec4(position, 1.0);
	float dist = max(0.1, -position.z);
	gl_PointSize = clamp(aSize * projectionMatrix[1][1] / dist * uHalfHeight, 1.0, 512.0);
}`;

const TRAIL_FRAGMENT = `
precision mediump float;

varying float vOpacity;

void main() {
	vec2 uv = gl_PointCoord - vec2(0.5);
	float dist = length(uv);
	if (dist > 0.5) discard;
	float falloff = 1.0 - dist * 2.0;
	float alpha = falloff * falloff * vOpacity;
	gl_FragColor = vec4(0.96, 0.98, 1.0, alpha);
}`;

const OVERLAY_LAYER = 1;

/** Scratch objects, reused every frame (nothing allocates in the hot path). */
const scratchWorld = new Cartesian3();
const scratchEye = new Cartesian3();
const scratchOffset = new THREE.Vector3();
const scratchLerp = new Cartesian3();
const scratchHead = new Cartesian3();
// Dedicated to getWorldOffsetPosition: `result` there is one of the above, so
// the camera-basis intermediates must live in their own slots.
const scratchRight = new Cartesian3();
const scratchUp = new Cartesian3();
const scratchAft = new Cartesian3();
const scratchPrune = new Cartesian3();

export class AerodynamicEffects {
  /**
   * @param {{scene: THREE.Scene, viewer: object, playerModel: THREE.Object3D,
   *          config: {condensation: {size: number, pos: object, tip: object,
   *          spread: object}, vortex: {pos: object}},
   *          maxSpeed: number, minSpeed: number}} opts
   */
  constructor({ scene, viewer, playerModel, config, maxSpeed, minSpeed = 0 }) {
    this.scene = scene;
    this.viewer = viewer;
    this.playerModel = playerModel;
    this.config = config;
    this.maxSpeed = maxSpeed;
    this.minSpeed = Math.min(minSpeed, maxSpeed);

    this.enabled = true;
    this.condensationIntensity = 0;
    this.vortexIntensity = 0;
    this.trail = [];
    this.lastSpawnBySide = { left: null, right: null };

    this._pointCap = AERO.TRAIL_POINT_CAP;
    this._trailPos = new Float32Array(this._pointCap * 3);
    this._trailSize = new Float32Array(this._pointCap);
    this._trailOpacity = new Float32Array(this._pointCap);

    this._condensationTime = 0;
    this._condensationSimAccum = 0;
    this._pendingTrailDt = 0;
    // Ribbon sampling window, re-derived from the live camera-to-wingtip
    // distance every frame (see trailSpacing/trailKeepDistance).
    this._spacing = AERO.TRAIL_MIN_DISTANCE;
    this._keepDistance = 3;

    this.condensationClouds = [];
    this.condensationGroup = new THREE.Group();
    this.condensationGroup.matrixAutoUpdate = true;
    this.condensationGroup.layers.set(OVERLAY_LAYER);

    this.vortexTips = {
      left: { x: -4.8, y: 0.2, z: 3 },
      right: { x: 4.8, y: 0.2, z: 3 },
    };

    this.initCondensation();
    this.initVortexTrail();
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) {
      this.condensationIntensity = 0;
      this.vortexIntensity = 0;
      this._pendingTrailDt = 0;
      this._condensationSimAccum = 0;
      this.trail.length = 0;
      clearSpawnState(this.lastSpawnBySide);
      this.vortexTrailPoints?.geometry?.setDrawRange(0, 0);
    }
    if (this.condensationGroup) {
      this.condensationGroup.visible = this.enabled && this.condensationIntensity > 0.01;
    }
    if (this.vortexTrailPoints) this.vortexTrailPoints.visible = this.enabled;
  }

  /** Spawn/reset: drop every sample so a new flight starts clean. */
  resetState() {
    this.condensationIntensity = 0;
    this.vortexIntensity = 0;
    this._pendingTrailDt = 0;
    this._condensationSimAccum = 0;
    this._lastState = null;
    this.trail.length = 0;
    clearSpawnState(this.lastSpawnBySide);
    this.vortexTrailPoints?.geometry?.setDrawRange(0, 0);
  }

  // ── Wing vapor ────────────────────────────────────────────────────────────

  initCondensation() {
    const material = new THREE.ShaderMaterial({
      vertexShader: CONDENSATION_VERTEX,
      fragmentShader: CONDENSATION_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    const root = this.config.condensation.pos;
    const tip = this.config.condensation.tip;
    const rootX = Math.abs(root.x);
    const tipX = Math.max(rootX + 0.05, Math.abs(tip.x));

    // Four pads: a flat one per wing over the outer panel, plus a curved one
    // per wing that wraps the upper surface (curve 1, pulled inboard/upward).
    const specs = [
      {
        side: "left", sideSign: -1,
        root: { x: -rootX, y: root.y, z: root.z },
        tip: { x: -tipX, y: tip.y, z: tip.z },
        mid: { x: -CesiumMath.lerp(rootX, tipX, 0.5), y: CesiumMath.lerp(root.y, tip.y, 0.5), z: CesiumMath.lerp(root.z + 0.02, tip.z + 0.08, 0.5) },
        curve: 0, corePull: 0, baseSizeMul: 1, intensityMul: 1,
      },
      {
        side: "right", sideSign: 1,
        root: { x: rootX, y: root.y, z: root.z },
        tip: { x: tipX, y: tip.y, z: tip.z },
        mid: { x: CesiumMath.lerp(rootX, tipX, 0.5), y: CesiumMath.lerp(root.y, tip.y, 0.5), z: CesiumMath.lerp(root.z + 0.02, tip.z + 0.08, 0.5) },
        curve: 0, corePull: 0, baseSizeMul: 1, intensityMul: 1,
      },
      {
        side: "left", sideSign: -1,
        root: { x: -Math.max(0.2, rootX * 0.14), y: root.y + 0.03, z: root.z - 0.08 },
        tip: { x: -Math.max(1.2, tipX * 0.72), y: tip.y + 0.06, z: tip.z + 0.42 },
        mid: { x: -Math.max(0.65, rootX * 0.42), y: root.y + 0.54, z: root.z + 0.28 },
        curve: 1, corePull: 0.22, baseSizeMul: 1.18, intensityMul: 0.92,
      },
      {
        side: "right", sideSign: 1,
        root: { x: Math.max(0.2, rootX * 0.14), y: root.y + 0.03, z: root.z - 0.08 },
        tip: { x: Math.max(1.2, tipX * 0.72), y: tip.y + 0.06, z: tip.z + 0.42 },
        mid: { x: Math.max(0.65, rootX * 0.42), y: root.y + 0.54, z: root.z + 0.28 },
        curve: 1, corePull: 0.22, baseSizeMul: 1.18, intensityMul: 0.92,
      },
    ];

    const counts = condensationSampleCounts();
    for (const spec of specs) {
      this.createCondensationCloud(spec, spec.curve > 0 ? counts.curved : counts.flat, material);
    }
    this.playerModel.add(this.condensationGroup);
  }

  createCondensationCloud(spec, count, baseMaterial) {
    const { spanSamples, chordSamples } = condensationGrid(count);

    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const opacities = new Float32Array(count);
    const span = new Float32Array(count);
    const chord = new Float32Array(count);
    const jitterX = new Float32Array(count);
    const jitterY = new Float32Array(count);
    const jitterZ = new Float32Array(count);
    const gust0 = new Float32Array(count);
    const gust1 = new Float32Array(count);
    const gust2 = new Float32Array(count);
    const gust3 = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const col = Math.floor(i / chordSamples);
      const row = i % chordSamples;
      // Checkerboard offset so the lattice never reads as a grid.
      const checker = ((col + row) & 1) === 0 ? 0.22 : -0.22;
      const jx = (Math.random() - 0.5 + checker * 0.5) * (1 / spanSamples) * 0.42;
      const jz = (Math.random() - 0.5 - checker * 0.5) * (1 / chordSamples) * 0.42;
      span[i] = clamp01(col / Math.max(1, spanSamples - 1) + jx);
      chord[i] = clamp01(row / Math.max(1, chordSamples - 1) + jz);
      jitterX[i] = Math.random() - 0.5;
      jitterY[i] = Math.random() - 0.5;
      jitterZ[i] = Math.random() - 0.5;
      gust0[i] = Math.random();
      gust1[i] = Math.random();
      gust2[i] = Math.random();
      gust3[i] = Math.random();
      sizes[i] = 0.24 + Math.random() * 0.14;
      opacities[i] = 0.14 + Math.random() * 0.13;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute("aOpacity", new THREE.BufferAttribute(opacities, 1));
    geometry.setAttribute("aSpan", new THREE.BufferAttribute(span, 1));
    geometry.setAttribute("aChord", new THREE.BufferAttribute(chord, 1));
    geometry.setAttribute("aJitterX", new THREE.BufferAttribute(jitterX, 1));
    geometry.setAttribute("aJitterY", new THREE.BufferAttribute(jitterY, 1));
    geometry.setAttribute("aJitterZ", new THREE.BufferAttribute(jitterZ, 1));
    geometry.setAttribute("aG0", new THREE.BufferAttribute(gust0, 1));
    geometry.setAttribute("aG1", new THREE.BufferAttribute(gust1, 1));
    geometry.setAttribute("aG2", new THREE.BufferAttribute(gust2, 1));
    geometry.setAttribute("aG3", new THREE.BufferAttribute(gust3, 1));
    geometry.setDrawRange(0, count);

    const material = baseMaterial.clone();
    material.uniforms = {
      uRoot: { value: new THREE.Vector3(spec.root.x, spec.root.y, spec.root.z) },
      uMid: { value: new THREE.Vector3(spec.mid.x, spec.mid.y, spec.mid.z) },
      uTip: { value: new THREE.Vector3(spec.tip.x, spec.tip.y, spec.tip.z) },
      uSpread: { value: new THREE.Vector3(0, 0, 0) },
      uSideSign: { value: spec.sideSign },
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uRelease: { value: 0 },
      uWindPush: { value: 0 },
      uBaseSize: { value: 1 },
      uCurve: { value: spec.curve },
      uCorePull: { value: spec.corePull },
      uHalfHeight: { value: 360 },
    };

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.layers.set(OVERLAY_LAYER);
    this.condensationGroup.add(points);

    this.condensationClouds.push({
      side: spec.side,
      baseSizeMul: spec.baseSizeMul,
      intensityMul: spec.intensityMul,
      points,
      material,
    });
  }

  // ── Wingtip vortices ──────────────────────────────────────────────────────

  initVortexTrail() {
    const tip = this.config.vortex.pos;
    const tipX = Math.max(0.05, Math.abs(tip.x));
    this.vortexTips.left = { x: -tipX, y: tip.y, z: tip.z };
    this.vortexTips.right = { x: tipX, y: tip.y, z: tip.z };

    const geometry = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(this._trailPos, 3).setUsage(THREE.DynamicDrawUsage);
    const size = new THREE.BufferAttribute(this._trailSize, 1).setUsage(THREE.DynamicDrawUsage);
    const opacity = new THREE.BufferAttribute(this._trailOpacity, 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", position);
    geometry.setAttribute("aSize", size);
    geometry.setAttribute("aOpacity", opacity);
    geometry.setDrawRange(0, 0);

    this.trailAttributes = { position, size, opacity };

    const material = new THREE.ShaderMaterial({
      vertexShader: TRAIL_VERTEX,
      fragmentShader: TRAIL_FRAGMENT,
      uniforms: { uHalfHeight: { value: 360 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.vortexTrailPoints = new THREE.Points(geometry, material);
    this.vortexTrailPoints.matrixAutoUpdate = false;
    this.vortexTrailPoints.frustumCulled = false;
    this.vortexTrailPoints.layers.set(OVERLAY_LAYER);
    this.scene.add(this.vortexTrailPoints);
  }

  // ── Per-frame ─────────────────────────────────────────────────────────────

  /**
   * @param {number} dt seconds (sim step)
   * @param {{lon: number, lat: number, alt: number, pitch: number,
   *          roll: number, speed?: number}} state (attitude in DEGREES)
   * @param {{speed?: number}} physics
   */
  update(dt, state, physics) {
    if (!this.enabled) return;
    const speed = physics?.speed ?? state.speed ?? 0;
    this.updateCondensation(dt, state, physics, speed);
    this.updateVortex(dt, state, physics, speed);
  }

  /**
   * Rebuild the trail geometry. Called from the RENDER loop (the reference
   * calls it after the visual transform is settled), never from the sim step.
   *
   * The spawn lives here too, and that ordering is load-bearing: at this
   * game's world speed the camera advances tens of units per frame, so
   * samples stamped against the PREVIOUS frame's camera pose are already
   * behind the camera by the time the frame renders. Sampling against the
   * pose being rendered is what makes the ribbon visible at all.
   */
  syncVisualState() {
    if (!this.enabled) return;
    if (this.vortexIntensity > 0.02 && this._lastState) {
      this.spawnVortexTrail(this._lastState, "left", this.vortexTips.left);
      this.spawnVortexTrail(this._lastState, "right", this.vortexTips.right);
    } else {
      clearSpawnState(this.lastSpawnBySide);
    }
    const dt = this._pendingTrailDt;
    this._pendingTrailDt = 0;
    this.updateTrailGeometry(dt);
  }

  updateCondensation(dt, state, physics, speed) {
    const factor = speedFactor(speed, this.minSpeed, this.maxSpeed);
    const target = condensationTarget(factor, rawPitch(physics, state));
    this.condensationIntensity = expLerp(
      this.condensationIntensity, target, dt, AERO.CONDENSATION_RATE,
    );

    this._condensationSimAccum += dt;
    const visible = this.condensationIntensity > 0.01;
    this.condensationGroup.visible = visible;
    if (!visible) {
      this._condensationSimAccum = 0;
      return;
    }

    // The shader's own gusts run at 30 Hz, not at frame rate.
    const step = 1 / 30;
    if (this._condensationSimAccum < step) return;
    const elapsed = this._condensationSimAccum;
    this._condensationSimAccum = 0;
    this._condensationTime += elapsed;

    const spread = this.config.condensation.spread;
    const windPush = this.condensationIntensity * (0.35 + factor * 1.25);
    const release = clamp01(1 - this.condensationIntensity);
    // Live model scale: keeps the puffs tied to the jet's on-screen size.
    const sizeScale = this.playerModel.scale.x || 1;
    const halfHeight = this.viewer?.canvas ? this.viewer.canvas.clientHeight * 0.5 : 360;

    for (const cloud of this.condensationClouds) {
      const u = cloud.material.uniforms;
      u.uSpread.value.set(spread.x, spread.y, spread.z);
      u.uTime.value = this._condensationTime;
      u.uIntensity.value = this.condensationIntensity * cloud.intensityMul;
      u.uRelease.value = release;
      u.uWindPush.value = windPush;
      u.uBaseSize.value = this.config.condensation.size * cloud.baseSizeMul * sizeScale;
      u.uHalfHeight.value = halfHeight;
    }
  }

  updateVortex(dt, state, physics, speed) {
    const factor = speedFactor(speed, this.minSpeed, this.maxSpeed);
    const target = vortexTarget(factor, rawRoll(physics, state), rawPitch(physics, state));
    this.vortexIntensity = expLerp(this.vortexIntensity, target, dt, AERO.VORTEX_RATE);
    // Spawning happens in syncVisualState (render), against the pose being
    // rendered; this keeps the last state it needs.
    this._lastState = state;
    this._pendingTrailDt += dt;
  }

  spawnVortexTrail(state, side, offset) {
    const world = this.getWorldOffsetPosition(state, offset, scratchWorld);
    const previous = this.lastSpawnBySide[side];
    if (!previous) {
      this.lastSpawnBySide[side] = Cartesian3.clone(world);
      this.pushTrailSample(world, this.vortexIntensity, side);
      return;
    }

    let distance = Cartesian3.distance(previous, world);
    if (!Number.isFinite(distance)) {
      this.lastSpawnBySide[side] = Cartesian3.clone(world);
      return;
    }
    if (distance < this._spacing) return;

    // Only the head of this segment can be on screen (the jet outruns its own
    // trail inside one frame at this camera distance), so the walk starts at
    // the window head rather than replaying the invisible rest of the gap.
    let from = previous;
    if (distance > this._keepDistance) {
      Cartesian3.lerp(previous, world, 1 - this._keepDistance / distance, scratchHead);
      from = scratchHead;
      distance = this._keepDistance;
    }

    const steps = Math.max(
      1,
      trailSpawnSteps(distance, this._spacing),
    );
    for (let i = 1; i <= steps; i++) {
      Cartesian3.lerp(from, world, (this._spacing * i) / distance, scratchLerp);
      this.pushTrailSample(scratchLerp, this.vortexIntensity, side);
    }
    this.lastSpawnBySide[side] = Cartesian3.clone(world);
  }

  pushTrailSample(position, strength, side) {
    this.trail.push({
      x: position.x,
      y: position.y,
      z: position.z,
      life: AERO.TRAIL_SAMPLE_LIFE,
      maxLife: AERO.TRAIL_SAMPLE_LIFE,
      side,
      strength,
      randomScale: 0.82 + Math.random() * 0.18,
      randomOpacity: 0.96 + Math.random() * 0.14,
    });
  }

  /**
   * World position of a model-local offset (a wingtip): local offset scaled by
   * the model's live scale, rotated by its quaternion, added to its position —
   * all in the overlay camera's frame — then rebuilt in world space from the
   * Cesium camera basis, exactly as the reference does it.
   */
  getWorldOffsetPosition(state, offset, result) {
    if (!this.playerModel || !this.viewer) {
      return Cartesian3.fromDegrees(state.lon, state.lat, state.alt, undefined, result);
    }
    const scale = this.playerModel.scale.x;
    scratchOffset.set(offset.x, offset.y, offset.z)
      .multiplyScalar(scale)
      .applyQuaternion(this.playerModel.quaternion)
      .add(this.playerModel.position);

    // The camera-to-wingtip distance is this game's stand-in for the
    // reference's fixed 25-unit chase distance: everything ribbon-shaped
    // (sample spacing, how much of it is worth keeping) scales with it.
    const spawnDistance = Math.abs(scratchOffset.z);
    this._spacing = trailSpacing(spawnDistance);
    this._keepDistance = trailKeepDistance(spawnDistance);

    const camera = this.viewer.camera;
    const right = Cartesian3.multiplyByScalar(camera.right, scratchOffset.x, scratchRight);
    const up = Cartesian3.multiplyByScalar(camera.up, scratchOffset.y, scratchUp);
    const aft = Cartesian3.multiplyByScalar(camera.direction, -scratchOffset.z, scratchAft);
    Cartesian3.add(right, up, result);
    Cartesian3.add(result, aft, result);
    return Cartesian3.add(camera.positionWC, result, result);
  }

  updateTrailGeometry(dt) {
    ageTrail(this.trail, dt);
    pruneTrailBehindCamera(this.trail, this.viewer.camera, this._keepDistance);
    const { left, right } = countSides(this.trail);
    const needed = trailPointCapacity(left, right);

    if (needed > this._pointCap) {
      // Grow once, with headroom, and re-attach the (bigger) buffers.
      this._pointCap = Math.ceil(needed * 1.35);
      this._trailPos = new Float32Array(this._pointCap * 3);
      this._trailSize = new Float32Array(this._pointCap);
      this._trailOpacity = new Float32Array(this._pointCap);
      const geometry = this.vortexTrailPoints.geometry;
      this.trailAttributes.position = new THREE.BufferAttribute(this._trailPos, 3).setUsage(THREE.DynamicDrawUsage);
      this.trailAttributes.size = new THREE.BufferAttribute(this._trailSize, 1).setUsage(THREE.DynamicDrawUsage);
      this.trailAttributes.opacity = new THREE.BufferAttribute(this._trailOpacity, 1).setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute("position", this.trailAttributes.position);
      geometry.setAttribute("aSize", this.trailAttributes.size);
      geometry.setAttribute("aOpacity", this.trailAttributes.opacity);
    }

    const viewMatrix = this.viewer.camera.viewMatrix;
    const sizeScale = this.playerModel.scale.x || 1;
    let written = 0;
    written = buildTrailSide({
      trail: this.trail,
      sideName: "left",
      viewMatrix,
      sizeScale,
      positions: this._trailPos,
      sizes: this._trailSize,
      opacities: this._trailOpacity,
      startPointCount: written,
    });
    written = buildTrailSide({
      trail: this.trail,
      sideName: "right",
      viewMatrix,
      sizeScale,
      positions: this._trailPos,
      sizes: this._trailSize,
      opacities: this._trailOpacity,
      startPointCount: written,
    });

    this.vortexTrailPoints.geometry.setDrawRange(0, written);
    this.trailAttributes.position.needsUpdate = true;
    this.trailAttributes.size.needsUpdate = true;
    this.trailAttributes.opacity.needsUpdate = true;
    if (this.viewer.canvas) {
      this.vortexTrailPoints.material.uniforms.uHalfHeight.value = this.viewer.canvas.clientHeight * 0.5;
    }
  }
}

/** Attitude in radians: the reference gates on physics.rawPitch/rawRoll. */
function rawPitch(physics, state) {
  if (Number.isFinite(physics?.rawPitch)) return physics.rawPitch;
  return CesiumMath.toRadians(state.pitch || 0);
}

function rawRoll(physics, state) {
  if (Number.isFinite(physics?.rawRoll)) return physics.rawRoll;
  return CesiumMath.toRadians(state.roll || 0);
}

function clearSpawnState(lastSpawnBySide) {
  lastSpawnBySide.left = null;
  lastSpawnBySide.right = null;
}

/** Age samples in place and compact the array (no allocation). */
function ageTrail(trail, dt) {
  let write = 0;
  for (let i = 0; i < trail.length; i++) {
    const sample = trail[i];
    sample.life -= dt;
    if (sample.life > 0) trail[write++] = sample;
  }
  trail.length = write;
}

/**
 * Drop samples that are already too far behind the camera to ever be drawn.
 * The reference keeps all of them (1.5 s worth) because its jet hangs 25
 * units in front of the camera; here that backlog would be tens of thousands
 * of points rebuilt and uploaded every frame for nothing.
 */
function pruneTrailBehindCamera(trail, camera, keepDistance) {
  if (!camera) return;
  let write = 0;
  for (let i = 0; i < trail.length; i++) {
    const sample = trail[i];
    scratchPrune.x = sample.x - camera.positionWC.x;
    scratchPrune.y = sample.y - camera.positionWC.y;
    scratchPrune.z = sample.z - camera.positionWC.z;
    // Positive = ahead of the camera, negative = behind it.
    if (Cartesian3.dot(scratchPrune, camera.direction) > -keepDistance) {
      trail[write++] = sample;
    }
  }
  trail.length = write;
}

function countSides(trail) {
  let left = 0;
  let right = 0;
  for (let i = 0; i < trail.length; i++) {
    if (trail[i].side === "right") right++;
    else left++;
  }
  return { left, right };
}

/**
 * Write one side's ribbon into the shared buffers in the camera's VIEW space.
 * Consecutive samples of a side get TRAIL_SMOOTH_STEPS interpolated points so
 * the ribbon is continuous even though samples land a metre apart.
 */
function buildTrailSide({
  trail,
  sideName,
  viewMatrix,
  sizeScale,
  positions,
  sizes,
  opacities,
  startPointCount,
  smoothSteps = AERO.TRAIL_SMOOTH_STEPS,
}) {
  let index = startPointCount;
  let prevX = 0;
  let prevY = 0;
  let prevZ = 0;
  let prevOpacity = 0;
  let havePrev = false;

  for (let i = 0; i < trail.length; i++) {
    const sample = trail[i];
    if (sample.side !== sideName) continue;

    const world = Cartesian3.fromElements(sample.x, sample.y, sample.z, scratchWorld);
    const eye = Matrix4.multiplyByPoint(viewMatrix, world, scratchEye);
    // At or behind the camera plane the sprite would blow up to the 512 px
    // clamp and smear across the frame, so those samples are simply skipped.
    if (eye.z > -0.05) continue;
    const x = eye.x;
    const y = eye.y;
    const z = eye.z;
    const opacity = (sample.life / sample.maxLife)
      * AERO.TRAIL_OPACITY_SCALE * sample.strength * sample.randomOpacity;

    if (havePrev) {
      for (let s = 1; s <= smoothSteps; s++) {
        const t = s / smoothSteps;
        const base = index * 3;
        positions[base] = CesiumMath.lerp(prevX, x, t);
        positions[base + 1] = CesiumMath.lerp(prevY, y, t);
        positions[base + 2] = CesiumMath.lerp(prevZ, z, t);
        sizes[index] = AERO.TRAIL_BASE_SIZE * sizeScale * CesiumMath.lerp(0.92, 1.12, t);
        opacities[index] = CesiumMath.lerp(prevOpacity, opacity, t) * 0.82;
        index++;
      }
    } else {
      const base = index * 3;
      positions[base] = x;
      positions[base + 1] = y;
      positions[base + 2] = z;
      sizes[index] = AERO.TRAIL_BASE_SIZE * sizeScale * 0.95;
      opacities[index] = opacity * 0.82;
      index++;
      havePrev = true;
    }

    prevX = x;
    prevY = y;
    prevZ = z;
    prevOpacity = opacity;
  }

  return index;
}
