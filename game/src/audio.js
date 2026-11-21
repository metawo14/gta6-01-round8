// All audio is synthesised: no files ship. The context is only created on the first user
// gesture, because browsers refuse to start audio otherwise, and every call no-ops safely
// before that point.

export class AudioBus {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.master = null;
    this.engine = null;
    this.siren = null;
    this.music = null;
    this.sirenGain = null;
    this.sirenOscA = null;
    this.sirenOscB = null;
    this._sirenPhase = 0;
    this._musicTimer = 0;
  }

  /** Called from a real key press or click. Safe to call repeatedly. */
  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); return true; }
    const Ctor = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!Ctor) return false;
    try { this.ctx = new Ctor(); } catch { return false; }
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.55;
    this.master.connect(this.ctx.destination);
    this._buildEngine();
    this._buildSiren();
    this._buildMusic();
    return true;
  }

  get ready() { return !!this.ctx && !this.muted; }

  _buildEngine() {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 520;
    filter.Q.value = 0.8;
    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.value = 60;
    const sub = ctx.createOscillator();
    sub.type = 'square';
    sub.frequency.value = 40;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.35;
    saw.connect(filter);
    sub.connect(subGain).connect(filter);
    filter.connect(gain).connect(this.master);
    saw.start(); sub.start();
    this.engine = { gain, filter, saw, sub };
  }

  _buildSiren() {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const a = ctx.createOscillator();
    a.type = 'triangle';
    a.frequency.value = 640;
    const b = ctx.createOscillator();
    b.type = 'triangle';
    b.frequency.value = 960;
    a.connect(gain);
    b.connect(gain);
    gain.connect(this.master);
    a.start(); b.start();
    this.siren = gain;
    this.sirenOscA = a;
    this.sirenOscB = b;
  }

  _buildMusic() {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0.16;
    gain.connect(this.master);
    this.music = { gain, nextBeat: 0, beat: 0 };
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : 0.55;
  }
  toggleMute() { this.setMuted(!this.muted); return this.muted; }

  /** Engine note + throttle, called each frame while driving. */
  setEngine(speed01, throttle01) {
    if (!this.ready || !this.engine) return;
    const t = this.ctx.currentTime;
    const hz = 46 + speed01 * 120 + throttle01 * 18;
    this.engine.saw.frequency.setTargetAtTime(hz, t, 0.09);
    this.engine.sub.frequency.setTargetAtTime(hz * 0.5, t, 0.09);
    this.engine.filter.frequency.setTargetAtTime(360 + speed01 * 900, t, 0.12);
    this.engine.gain.gain.setTargetAtTime(0.055 + speed01 * 0.10, t, 0.12);
  }
  engineOff() {
    if (!this.ready || !this.engine) return;
    this.engine.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.18);
  }

  /** Two-tone wail scaled by distance. */
  setSiren(distance, active) {
    if (!this.ready || !this.siren) return;
    const t = this.ctx.currentTime;
    const near = Math.max(0, 1 - distance / 90);
    this.siren.gain.setTargetAtTime(active ? 0.012 + near * 0.07 : 0, t, 0.15);
    if (active) {
      this._sirenPhase += 0.016;
      const wobble = Math.sin(this._sirenPhase * 3.0) * 0.5 + 0.5;
      this.sirenOscA.frequency.setTargetAtTime(600 + wobble * 300, t, 0.06);
      this.sirenOscB.frequency.setTargetAtTime(900 + (1 - wobble) * 380, t, 0.06);
    }
  }

  /** Slow bassline with a hat tick; quicker under heat. */
  tickMusic(dt, heat) {
    if (!this.ready || !this.music) return;
    const ctx = this.ctx;
    this.music.nextBeat -= dt;
    if (this.music.nextBeat > 0) return;
    const beatLen = heat ? 0.28 : 0.5;
    this.music.nextBeat = beatLen;
    const t = ctx.currentTime;
    const step = this.music.beat++ % 8;
    const roots = [55, 55, 73.4, 65.4];
    const root = roots[Math.floor(this.music.beat / 8) % roots.length];
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = step % 4 === 2 ? root * 1.5 : root;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.32, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + beatLen * 0.9);
    osc.connect(g).connect(this.music.gain);
    osc.start(t); osc.stop(t + beatLen);
    if (step % 2 === 1) this._noiseHit(t, 0.05, 5200, 0.05);
  }

  _noiseHit(start, duration, hz, level) {
    const ctx = this.ctx;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = hz;
    const g = ctx.createGain();
    g.gain.value = level;
    src.connect(filter).connect(g).connect(this.master);
    src.start(start);
  }

  gunshot() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    this._noiseHit(t, 0.13, 900, 0.5);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(420, t);
    osc.frequency.exponentialRampToValueAtTime(70, t + 0.14);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.28, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    osc.connect(g).connect(this.master);
    osc.start(t); osc.stop(t + 0.18);
  }

  punch() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.35, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc.connect(g).connect(this.master);
    osc.start(t); osc.stop(t + 0.14);
    this._noiseHit(t, 0.07, 2200, 0.16);
  }

  crash(strength = 1) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const level = Math.min(0.55, 0.14 + strength * 0.35);
    this._noiseHit(t, 0.2 + strength * 0.1, 320, level);
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(110, t);
    osc.frequency.exponentialRampToValueAtTime(48, t + 0.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(level * 0.6, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    osc.connect(g).connect(this.master);
    osc.start(t); osc.stop(t + 0.26);
  }

  pickup() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    [660, 990].forEach((hz, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + i * 0.09);
      g.gain.exponentialRampToValueAtTime(0.3, t + i * 0.09 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.16);
      osc.connect(g).connect(this.master);
      osc.start(t + i * 0.09); osc.stop(t + i * 0.09 + 0.18);
    });
  }

  missionComplete() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    [523, 659, 784, 1047].forEach((hz, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = hz;
      const g = ctx.createGain();
      const at = t + i * 0.11;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.3, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.34);
      osc.connect(g).connect(this.master);
      osc.start(at); osc.stop(at + 0.36);
    });
  }

  wantedUp() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    [98, 78].forEach((hz, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = hz;
      const g = ctx.createGain();
      const at = t + i * 0.12;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.22, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
      osc.connect(g).connect(this.master);
      osc.start(at); osc.stop(at + 0.2);
    });
  }

  busted() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    [392, 330, 262, 196].forEach((hz, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = hz;
      const g = ctx.createGain();
      const at = t + i * 0.14;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.26, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.4);
      osc.connect(g).connect(this.master);
      osc.start(at); osc.stop(at + 0.42);
    });
  }

  horn() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    [340, 452].forEach((hz) => {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.10, t + 0.02);
      g.gain.setValueAtTime(0.10, t + 0.22);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
      osc.connect(g).connect(this.master);
      osc.start(t); osc.stop(t + 0.36);
    });
  }
}

export const audio = new AudioBus();
