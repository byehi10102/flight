export class PlaneController {
	constructor() {
		this.keys = {};
		this.prevKeys = {};
		window.addEventListener('keydown', (e) => this.keys[e.key.toLowerCase()] = true);
		window.addEventListener('keyup', (e) => this.keys[e.key.toLowerCase()] = false);

		this.mouseDragging = false;
		this.mouseDeltaX = 0;
		this.mouseDeltaY = 0;
		this.lastMouseX = 0;
		this.lastMouseY = 0;

		window.addEventListener('mousedown', (e) => {
			if (e.button === 0) {
				this.mouseDragging = true;
				this.lastMouseX = e.clientX;
				this.lastMouseY = e.clientY;
			}
		});

		window.addEventListener('mousemove', (e) => {
			if (this.mouseDragging) {
				this.mouseDeltaX += e.clientX - this.lastMouseX;
				this.mouseDeltaY += e.clientY - this.lastMouseY;
				this.lastMouseX = e.clientX;
				this.lastMouseY = e.clientY;
			}
		});

		window.addEventListener('mouseup', (e) => {
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
			cameraYaw: 0,
			cameraPitch: 0,
			isDragging: false
		};

		this.sensitivity = 0.2;

		// Analog touch-stick channels, -1..1 per axis, fed by TouchControls via
		// setStickInput(). The keyboard and the sticks are two front-ends over
		// THIS one input state: update() sums them into the same targets, so
		// touch never forks the physics. left: x = yaw (A/D), y = throttle
		// (W/S); right: x = roll (arrows), y = pitch (arrows).
		this.stickLeft = { x: 0, y: 0 };
		this.stickRight = { x: 0, y: 0 };

		// Seconds remaining on a touch double-tap boost press. The physics boost
		// is edge-triggered, so one pulse is all it takes; 0.4 s survives frame
		// jitter but ends long before the 3 s meter refill could re-trigger.
		this.boostTap = 0;
	}

	/** Mobile double-tap: behaves like a quick spacebar tap. */
	requestBoost() {
		this.boostTap = 0.4;
	}

	/** Feed one joystick's axes, -1..1 with 10% dead zone already applied. */
	setStickInput(side, x, y) {
		const stick = side === 'left' ? this.stickLeft : this.stickRight;
		stick.x = x;
		stick.y = y;
	}

	setSensitivity(value) {
		this.sensitivity = value;
	}

	update() {
		// Spacebar OR a touch double-tap pulse. Same edge the physics wants.
		if (this.boostTap > 0) this.boostTap -= 0.016;
		this.input.boost = !!this.keys[' '] || this.boostTap > 0;
		this.input.isDragging = this.mouseDragging;

		const accelRate = 0.5;
		if (this.keys['w']) {
			this.input.throttle = Math.min(1, this.input.throttle + accelRate * 0.016);
		} else if (this.keys['s']) {
			this.input.throttle = Math.max(0, this.input.throttle - accelRate * 0.016);
		}
		// Left stick vertical mirrors W/S at the same rate: full deflection up
		// accelerates exactly like holding W; release holds the level, like
		// releasing the key. Analog, so half-deflection throttles half-rate.
		if (this.stickLeft.y !== 0) {
			this.input.throttle = Math.min(1, Math.max(0, this.input.throttle + this.stickLeft.y * accelRate * 0.016));
		}

		// The sticks sum into the SAME targets the keys set, clamped to the
		// band the physics expects. push-up/on-the-right follows the arrow/A-D
		// key semantics: stick-up == ArrowUp (-1), stick-down == ArrowDown (+1),
		// stick-right == ArrowRight or D (+1).
		const pitchTarget = this.clampAxis(
			(this.keys['arrowup'] ? -1 : (this.keys['arrowdown'] ? 1 : 0)) - this.stickRight.y);
		this.input.pitch = this.lerp(this.input.pitch, pitchTarget, 0.1);

		const rollTarget = this.clampAxis(
			(this.keys['arrowleft'] ? -1 : (this.keys['arrowright'] ? 1 : 0)) + this.stickRight.x);
		this.input.roll = this.lerp(this.input.roll, rollTarget, 0.1);

		const yawTarget = this.clampAxis(
			(this.keys['a'] ? -1 : (this.keys['d'] ? 1 : 0)) + this.stickLeft.x);
		this.input.yaw = this.lerp(this.input.yaw, yawTarget, 0.1);

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
		this.stickLeft.x = 0; this.stickLeft.y = 0;
		this.stickRight.x = 0; this.stickRight.y = 0;
		this.boostTap = 0;
	}

	lerp(start, end, amt) {
		return (1 - amt) * start + amt * end;
	}

	clampAxis(v) {
		return Math.max(-1, Math.min(1, v));
	}
}
