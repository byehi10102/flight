/**
 * Procedural engine note. No audio assets: two detuned sawtooth oscillators
 * through a lowpass, both tracking airspeed, plus filtered noise for airflow
 * that rises with dynamic pressure. Silence costs more realism than any shader.
 */
export class EngineAudio {
  constructor() {
    this.ctx = null;
    this.enabled = false;
  }

  start() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.0;
    this.master.connect(ctx.destination);

    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 900;
    this.filter.Q.value = 0.7;
    this.filter.connect(this.master);

    this.osc1 = ctx.createOscillator();
    this.osc1.type = "sawtooth";
    this.osc1.frequency.value = 70;
    this.osc1.connect(this.filter);

    this.osc2 = ctx.createOscillator();
    this.osc2.type = "sawtooth";
    this.osc2.frequency.value = 70 * 1.007;
    this.osc2.connect(this.filter);

    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noise = ctx.createBufferSource();
    this.noise.buffer = buf;
    this.noise.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = "bandpass";
    this.windFilter.frequency.value = 1200;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.0;
    this.noise.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.master);

    this.osc1.start();
    this.osc2.start();
    this.noise.start();
    this.enabled = true;
  }

  update(plane) {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    const throttle = plane.throttle || 0;
    const speed = plane.speed || 0;
    const f = 60 + 130 * throttle;
    this.osc1.frequency.setTargetAtTime(f, t, 0.08);
    this.osc2.frequency.setTargetAtTime(f * 1.007, t, 0.08);
    this.filter.frequency.setTargetAtTime(500 + 2600 * throttle, t, 0.1);
    this.master.gain.setTargetAtTime(0.05 + 0.10 * throttle, t, 0.15);
    const q = 0.5 * 1.225 * speed * speed;
    this.windGain.gain.setTargetAtTime(Math.min(0.09, q / 90000), t, 0.2);
    this.windFilter.frequency.setTargetAtTime(700 + speed * 9, t, 0.2);
  }

  toggle() {
    if (!this.ctx) {
      this.start();
      return true;
    }
    this.enabled = !this.enabled;
    this.master.gain.setTargetAtTime(this.enabled ? 0.08 : 0.0, this.ctx.currentTime, 0.1);
    return this.enabled;
  }
}
