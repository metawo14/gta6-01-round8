// Deterministic number generation. Same seed, same city, every load.

export class Rng {
  constructor(seed = 7) {
    this.seed = (seed >>> 0) || 1;
    this.state = this.seed;
  }
  /** SplitMix-ish 32-bit integer stream. */
  next() {
    let x = (this.state = (this.state + 0x9e3779b9) >>> 0);
    x ^= x >>> 16; x = Math.imul(x, 0x21f0aaad) >>> 0;
    x ^= x >>> 15; x = Math.imul(x, 0x735a2d97) >>> 0;
    x ^= x >>> 15;
    return x >>> 0;
  }
  float() { return this.next() / 4294967296; }
  range(min, max) { return min + (max - min) * this.float(); }
  int(min, max) { return Math.floor(this.range(min, max + 1)); }
  pick(list) { return list[Math.floor(this.float() * list.length) % list.length]; }
  chance(p) { return this.float() < p; }
  sign() { return this.float() < 0.5 ? -1 : 1; }
  reset() { this.state = this.seed; }
}

/** A stable hash for strings, used to salt sub-generators. */
export function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function seeded(seed, salt = 0) {
  return new Rng(((seed >>> 0) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0 || 1);
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const TAU = Math.PI * 2;
export function wrapAngle(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}
export function angleTo(fromX, fromZ, toX, toZ) { return Math.atan2(toX - fromX, toZ - fromZ); }
export function dist2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; }
export function dist(ax, az, bx, bz) { return Math.sqrt(dist2(ax, az, bx, bz)); }
