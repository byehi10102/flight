import * as THREE from "three";
import * as Cesium from "cesium";
import { Bullet } from "./bullet.js";
import { Missile } from "./missile.js";
import { Flare } from "./flare.js";
import { movePosition } from "./math.js";
import { soundManager } from "../utils/soundManager.js";

/**
 * Weapon system, from dimartarmizi/web-flight-simulator
 * src/systems/weaponSystem.js.
 *
 * ref-flight data + rules kept: M61A1 cannon (infinite ammo, 0.05 s rate,
 * heat → overheat), AIM-9 Sidewinder ×50 (1.0 s rate, alternating wing
 * rails), MJU-7A flares ×30 in 6-round 0.15 s pulses, empty-click warnings,
 * weapon-switch sounds. Launch points come from calculateWeaponPos
 * (verbatim): gun at the nose, missiles on alternating wing rails,
 * flares behind the tail. Rounds fly world-space ballistics from the
 * firing attitude, so later plane movement never bends their path.
 *
 * Omitted with the NPC systems they track: target lock/RWR loop
 * (findPotentialTarget, rwr-tws/lock sounds). Missiles dumb-fire straight.
 */
export class WeaponSystem {
  // getPlayerModel: () => THREE.Group (the overlay jet; loads async).
  constructor(scene, viewer, getPlayerModel) {
    this.scene = scene;
    this.viewer = viewer;
    this.getPlayerModel = getPlayerModel;

    this.weapons = [
      { id: "gun", name: "M61A1 CANNON", ammo: Infinity, maxAmmo: Infinity, fireRate: 0.05, lastFire: 0 },
      { id: "missile", name: "AIM-9 SIDEWINDER", ammo: 50, maxAmmo: 50, fireRate: 1.0, lastFire: 0, type: "AIM-9" }
    ];

    this.flareWeapon = { id: "flare", name: "MJU-7A", ammo: 30, maxAmmo: 30, fireRate: 0.2, lastFire: 0 };

    this.selectedWeaponIndex = 0;
    this.projectiles = [];
    this.flares = [];

    this.isGunOverheated = false;
    this.gunHeat = 0;

    this.flareQueue = 0;
    this.flareInterval = 0.15;
    this.lastFlarePulse = 0;

    this.lastMissileSide = false;

    this.emptyWarningTimers = { gun: 0, missile: 0, flare: 0 };
    this.lastEmptyWarningSoundTime = 0;
  }

  resetAmmo() {
    this.selectedWeaponIndex = 0;
    for (const w of this.weapons) {
      if (typeof w.maxAmmo !== "undefined") w.ammo = w.maxAmmo;
    }
    if (this.flareWeapon && typeof this.flareWeapon.maxAmmo !== "undefined") {
      this.flareWeapon.ammo = this.flareWeapon.maxAmmo;
    }
    this.gunHeat = 0;
    this.isGunOverheated = false;
    this.emptyWarningTimers = { gun: 0, missile: 0, flare: 0 };
  }

  /** Drop every live round silently (respawn / new location). */
  clear() {
    const strip = (obj) => {
      if (!obj) return;
      try { this.scene.remove(obj); } catch (e) { /* cosmetic */ }
      try {
        obj.traverse((child) => {
          child.geometry?.dispose?.();
          if (Array.isArray(child.material)) child.material.forEach((m) => { m.map?.dispose?.(); m.dispose?.(); });
          else { child.material?.map?.dispose?.(); child.material?.dispose?.(); }
        });
      } catch (e) { /* cosmetic */ }
    };
    for (const p of this.projectiles) {
      strip(p.mesh || p.group);
      for (const t of (p.trail || [])) strip(t);
    }
    this.projectiles = [];
    for (const f of this.flares) {
      strip(f.group);
      for (const t of (f.trail || [])) strip(t);
    }
    this.flares = [];
    this.flareQueue = 0;
  }

  getCurrentWeapon() {
    return this.weapons[this.selectedWeaponIndex];
  }

  toggleWeapon() {
    this.selectedWeaponIndex = (this.selectedWeaponIndex + 1) % this.weapons.length;
    try { soundManager.play("weapon-switch"); } catch (e) { }
  }

  selectWeapon(index) {
    if (index >= 0 && index < this.weapons.length) {
      this.selectedWeaponIndex = index;
    }
    try { soundManager.play("weapon-switch"); } catch (e) { }
  }

  calculateWeaponPos(offset) {
    const playerModel = this.getPlayerModel ? this.getPlayerModel() : null;
    if (!playerModel || !this.viewer) return null;

    const scale = playerModel.scale.x;
    const scaledOffset = offset.clone().multiplyScalar(scale);

    scaledOffset.applyQuaternion(playerModel.quaternion);
    scaledOffset.add(playerModel.position);

    const planeFov = 75;
    const worldFov = Cesium.Math.toDegrees(this.viewer.camera.frustum.fovy);

    const factor = Math.tan(Cesium.Math.toRadians(worldFov) * 0.5) / Math.tan(Cesium.Math.toRadians(planeFov) * 0.5);

    scaledOffset.x *= factor;
    scaledOffset.y *= factor;

    const cam = this.viewer.camera;
    const right = cam.right;
    const up = cam.up;
    const dir = cam.direction;

    const worldOffset = new Cesium.Cartesian3();

    const xVec = Cesium.Cartesian3.multiplyByScalar(right, scaledOffset.x, new Cesium.Cartesian3());
    const yVec = Cesium.Cartesian3.multiplyByScalar(up, scaledOffset.y, new Cesium.Cartesian3());
    const zVec = Cesium.Cartesian3.multiplyByScalar(dir, -scaledOffset.z, new Cesium.Cartesian3());

    Cesium.Cartesian3.add(xVec, yVec, worldOffset);
    Cesium.Cartesian3.add(worldOffset, zVec, worldOffset);

    const camPos = cam.positionWC;
    const finalPos = new Cesium.Cartesian3();
    Cesium.Cartesian3.add(camPos, worldOffset, finalPos);

    const carto = Cesium.Cartographic.fromCartesian(finalPos);

    return {
      lon: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
      alt: carto.height
    };
  }

  // playerState: { lon, lat, alt, heading, pitch, speed } with speed in m/s.
  fire(playerState) {
    const weapon = this.weapons[this.selectedWeaponIndex];
    if (!weapon) return;

    const now = performance.now() * 0.001;

    if (weapon.ammo <= 0) {
      if (now - this.lastEmptyWarningSoundTime > 2.0) {
        this.emptyWarningTimers[weapon.id] = 1.0;
        this.lastEmptyWarningSoundTime = now;
        try { soundManager.play("weapon-warning"); } catch (e) { }
      }
      return;
    }
    if (weapon.id === "gun" && this.isGunOverheated) return;
    if (now - weapon.lastFire < weapon.fireRate) return;

    weapon.lastFire = now;
    if (weapon.ammo !== Infinity) weapon.ammo--;

    const startPos = { lon: playerState.lon, lat: playerState.lat, alt: playerState.alt };

    if (weapon.id === "gun") {
      this.gunHeat += 0.02;
      if (this.gunHeat >= 1.0) {
        this.isGunOverheated = true;
        try { soundManager.play("weapon-warning"); } catch (e) { }
      }

      const gunOffset = new THREE.Vector3(0, 0, 0);
      const nosePos = this.calculateWeaponPos(gunOffset) || movePosition(startPos.lon, startPos.lat, startPos.alt, playerState.heading, playerState.pitch, 5);

      const bullet = new Bullet(
        this.scene, this.viewer, nosePos,
        playerState.heading, playerState.pitch, playerState.speed
      );
      this.projectiles.push(bullet);
    } else if (weapon.id === "missile") {
      this.lastMissileSide = !this.lastMissileSide;
      const side = this.lastMissileSide ? 1 : -1;
      const missileOffset = new THREE.Vector3(15.0 * side, -15.0, 0.0);

      const launchPos = this.calculateWeaponPos(missileOffset) || startPos;

      const missile = new Missile(
        this.scene, this.viewer, launchPos,
        playerState.heading, playerState.pitch, playerState.speed
      );
      this.projectiles.push(missile);

      try { soundManager.play("missile-fire"); } catch (e) { }
    }
  }

  fireFlare(playerState) {
    const flareWeapon = this.flareWeapon;
    const now = performance.now() * 0.001;

    if (!flareWeapon || flareWeapon.ammo <= 0) {
      if (now - this.lastEmptyWarningSoundTime > 2.0) {
        this.emptyWarningTimers["flare"] = 1.0;
        this.lastEmptyWarningSoundTime = now;
        try { soundManager.play("weapon-warning"); } catch (e) { }
      }
      return;
    }
    if (now - flareWeapon.lastFire < 1.0) return;

    flareWeapon.ammo--;
    flareWeapon.lastFire = now;

    this.flareQueue = 6;
    this.lastFlarePulse = 0;
  }

  _spawnSingleFlare(playerState) {
    const flareOffset = new THREE.Vector3(0, -10.0, 6.0);
    const startPos = this.calculateWeaponPos(flareOffset) || {
      lon: playerState.lon, lat: playerState.lat, alt: playerState.alt
    };

    const flare = new Flare(
      this.scene, this.viewer, startPos,
      playerState.heading, playerState.pitch, playerState.speed
    );

    this.flares.push(flare);
  }

  update(dt, playerState, input = null) {
    const currentWeapon = this.getCurrentWeapon();

    try {
      const isFiringGun = input && input.fire && currentWeapon.id === "gun" && !this.isGunOverheated && currentWeapon.ammo > 0;
      if (isFiringGun) {
        if (!soundManager.isPlaying("m61-firing")) {
          soundManager.play("m61-firing");
        }
      } else {
        if (soundManager.isPlaying("m61-firing")) {
          soundManager.stop("m61-firing");
        }
      }
    } catch (e) { }

    if (this.flareQueue > 0) {
      this.lastFlarePulse += dt;
      if (this.lastFlarePulse >= this.flareInterval || this.flareQueue === 6) {
        this._spawnSingleFlare(playerState);
        this.flareQueue--;
        this.lastFlarePulse = 0;
      }
    }

    if (this.gunHeat > 0) {
      this.gunHeat -= dt * 0.2;
      if (this.gunHeat <= 0) {
        this.gunHeat = 0;
        this.isGunOverheated = false;
      }
      if (this.isGunOverheated && this.gunHeat < 0.3) {
        this.isGunOverheated = false;
      }
    }

    for (const key in this.emptyWarningTimers) {
      if (this.emptyWarningTimers[key] > 0) {
        this.emptyWarningTimers[key] -= dt;
        if (this.emptyWarningTimers[key] < 0) this.emptyWarningTimers[key] = 0;
      }
    }

    const npcs = playerState.npcs || [];

    // Removal contract: classes exposing a `done` getter (missile/flare:
    // inactive AND trail faded) use it; plain rounds (bullet) drop when
    // inactive.
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.update(dt, npcs);
      const finished = typeof p.done === "boolean" ? p.done : !p.active;
      if (finished) this.projectiles.splice(i, 1);
    }

    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i];
      f.update(dt);
      if (f.done) this.flares.splice(i, 1);
    }
  }
}
