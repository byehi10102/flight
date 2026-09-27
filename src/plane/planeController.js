import { CONFIG } from "../core/config.js";

/**
 * Flight controller.
 *
 * Controls:
 *   W — accelerate (throttle up)
 *   S — slow down (throttle down)
 *   A — turn left (yaw left)
 *   D — turn right (yaw right)
 *   Up Arrow — nose down (descend along flight path)
 *   Down Arrow — nose up (climb along flight path)
 *   Left Arrow — roll left
 *   Right Arrow — roll right
 *   Space — boost (afterburner)
 *   Mouse drag — look around
 */
export class PlaneController {
  constructor() {
    this.keys = {};
    this.prevKeys = {};
    window.addEventListener("keydown", (e) => {
      const tag = e.target.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      this.keys[e.code] = true;
    });
    window.addEventListener("keyup", (e) => {
      const tag = e.target.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      this.keys[e.code] = false;
    });

    this.mouseDragging = false;
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.lastMouseX = 0;
    this.lastMouseY = 0;

    window.addEventListener("mousedown", (e) => {
      if (e.button === 0) {
        this.mouseDragging = true;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
      }
    });

    window.addEventListener("mousemove", (e) => {
      if (this.mouseDragging) {
        this.mouseDeltaX += e.clientX - this.lastMouseX;
        this.mouseDeltaY += e.clientY - this.lastMouseY;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
      }
    });

    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) {
        this.mouseDragging = false;
      }
    });

    this.input = {
      throttle: 0,
      pitch: 0,
      roll: 0,
      yaw: 0,
      boost: false,
      deceleration: false,
      cameraYaw: 0,
      cameraPitch: 0,
      isDragging: false,
    };

    this.sensitivity = CONFIG.camera.mouseSensitivity;
  }

  setSensitivity(value) {
    this.sensitivity = value;
  }

  update() {
    this.input.boost = !!this.keys["Space"];
    this.input.deceleration = !!this.keys["KeyS"];
    this.input.isDragging = this.mouseDragging;

    // W/S: throttle up/down
    const accelRate = 0.5;
    if (this.keys["KeyW"]) {
      this.input.throttle = Math.min(1, this.input.throttle + accelRate * 0.016);
    } else if (this.keys["KeyS"]) {
      this.input.throttle = Math.max(0, this.input.throttle - accelRate * 0.016);
    }

    // Up arrow = nose down (descend), Down arrow = nose up (climb)
    // The plane always moves forward, so pitch changes the flight path angle
    const pitchTarget = this.keys["ArrowUp"] ? -1 : this.keys["ArrowDown"] ? 1 : 0;
    this.input.pitch = this.lerp(this.input.pitch, pitchTarget, 0.1);

    // Left arrow = roll left, Right arrow = roll right
    const rollTarget = this.keys["ArrowLeft"] ? -1 : this.keys["ArrowRight"] ? 1 : 0;
    this.input.roll = this.lerp(this.input.roll, rollTarget, 0.1);

    // A/D: yaw left/right
    const yawTarget = this.keys["KeyA"] ? -1 : this.keys["KeyD"] ? 1 : 0;
    this.input.yaw = this.lerp(this.input.yaw, yawTarget, 0.1);

    // Mouse drag: look around
    if (this.mouseDragging) {
      this.input.cameraYaw += this.mouseDeltaX * this.sensitivity;
      this.input.cameraPitch -= this.mouseDeltaY * this.sensitivity;
      this.input.cameraPitch = Math.max(-85, Math.min(85, this.input.cameraPitch));
      this.mouseDeltaX = 0;
      this.mouseDeltaY = 0;
    } else {
      this.input.cameraYaw = this.lerp(this.input.cameraYaw, 0, 0.1);
      this.input.cameraPitch = this.lerp(this.input.cameraPitch, 0, 0.1);
    }

    this.prevKeys = { ...this.keys };
    return this.input;
  }

  reset() {
    this.input.cameraYaw = 0;
    this.input.cameraPitch = 0;
    this.mouseDragging = false;
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.input.throttle = 0;
    this.input.pitch = 0;
    this.input.roll = 0;
    this.input.yaw = 0;
    this.input.deceleration = false;
  }

  lerp(start, end, amt) {
    return (1 - amt) * start + amt * end;
  }
}
