import * as THREE from "three";
import { Bullet } from "./bullet.js";
import { Missile } from "./missile.js";
import { Flare } from "./flare.js";
import { soundManager } from "../utils/soundManager.js";

/**
 * Weapon system, adapted from dimartarmizi/web-flight-simulator
 * src/systems/weaponSystem.js.
 *
 * ref-flight data + rules copied exactly: M61A1 cannon (infinite ammo,
 * 0.05 s fire rate, heat → overheat), AIM-9 Sidewinder ×50 (1.0 s rate,
 * alternating wing rails), MJU-7A flares ×30 in 6-round 0.15 s pulses,
 * empty-click warnings, weapon-switch sounds.
 *
 * Divergences forced by architecture (documented, not silent):
 * - ref-flight projectiles fly in world space through the Cesium camera and
 *   home onto locked NPC targets. This repo's Three.js layer is a
 *   camera-locked overlay with no NPC systems, so rounds fly in
 *   overlay-local space straight ahead and missiles dumb-fire (no lock
 *   gate — with no targets a lock could never complete).
 * - ref-flight lock/RWR loop (findPotentialTarget, rwr-tws/lock sounds) is
 *   omitted with the NPCs it tracks.
 */
export class WeaponSystem {
  constructor(scene) {
    this.scene = scene;
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
      for (const t of (p.trail || [])) strip(t.mesh || t);
    }
    this.projectiles = [];
    for (const f of this.flares) {
      strip(f.group);
      for (const t of (f.trail || [])) strip(t.mesh || t);
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

  fire(nosePos) {
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

    if (weapon.id === "gun") {
      this.gunHeat += 0.02;
      if (this.gunHeat >= 1.0) {
        this.isGunOverheated = true;
        try { soundManager.play("weapon-warning"); } catch (e) { }
      }
      this.projectiles.push(new Bullet(this.scene, nosePos));
    } else if (weapon.id === "missile") {
      // Alternating wing rails, like ref-flight (no lock gate: no NPCs).
      this.lastMissileSide = !this.lastMissileSide;
      const side = this.lastMissileSide ? 1 : -1;
      const rail = nosePos.clone();
      rail.x += 0.55 * side;
      this.projectiles.push(new Missile(this.scene, rail));
      try { soundManager.play("missile-fire"); } catch (e) { }
    }
  }

  fireFlare(tailPos) {
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

  _spawnSingleFlare(tailPos) {
    this.flares.push(new Flare(this.scene, tailPos));
  }

  update(dt, nosePos, tailPos, input = null) {
    const currentWeapon = this.getCurrentWeapon();
    try {
      const isFiringGun = input && input.fire && currentWeapon.id === "gun" && !this.isGunOverheated && currentWeapon.ammo > 0;
      if (isFiringGun) {
        if (!soundManager.isPlaying("m61-firing")) soundManager.play("m61-firing");
      } else if (soundManager.isPlaying("m61-firing")) {
        soundManager.stop("m61-firing");
      }
    } catch (e) { }

    if (this.flareQueue > 0) {
      this.lastFlarePulse += dt;
      if (this.lastFlarePulse >= this.flareInterval || this.flareQueue === 6) {
        this._spawnSingleFlare(tailPos);
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

    // Removal contract: classes exposing a `done` getter (missile/flare:
    // inactive AND trail faded) use it; plain rounds (bullet) drop when
    // inactive.
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.update(dt);
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
