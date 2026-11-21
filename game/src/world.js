// The city of SOLMAR: a seeded 12x12 block grid of whitewashed buildings with terracotta roofs,
// a turquoise sea on the east, palms along the waterfront, and a baked-glow night economy of
// windows, neon, shop fronts, lamp halos and light pools. Everything here is deterministic for a
// given seed, and everything here can answer three questions for the rest of the game: is this
// point solid, push this circle out of solid things, and where can a car park.

import * as THREE from 'three';
import { CITY, PALETTE } from './config.js';
import { Rng, seeded, clamp, lerp, smoothstep, TAU } from './random.js';

const CELL = CITY.pitch;
const ROAD = CITY.road;
const WALK = CITY.pavement;
const HALF = CITY.bound;
const LINES = CITY.grid;
const ROAD_HALF = ROAD / 2;
const BUILD_INSET = ROAD_HALF + WALK;      // from block edge to buildable land
const BLOCK_INNER = CELL - BUILD_INSET * 2; // usable buildable width inside a block

/** Road centre line for grid index i (0..grid). */
export const roadCenter = (i) => -HALF + i * CELL;
export const blockCenter = (i) => -HALF + CELL / 2 + i * CELL;

/** Which block contains a world point (clamped to the grid). */
export function blockAt(x, z) {
  const i = Math.floor((x + HALF) / CELL);
  const j = Math.floor((z + HALF) / CELL);
  return { i: clamp(i, 0, LINES - 1), j: clamp(j, 0, LINES - 1) };
}

// Mission locations sit inside blocks, so those blocks become open yards instead of built lots.
// A beacon you cannot drive to is not a job.
const RESERVED_BLOCKS = new Set([
  '9,5',   // lock-up on Marlin Row  (214, -40)
  '8,8',   // north quay             (150, 190)
  '2,9',   // hideout                (-240, 210)
  '4,7',   // debt collector target  (-120, 120)
  '1,6',   // harbour deck           (-262, 40)
]);

/** Nearest road line index + signed distance, used by traffic and parking. */
export function nearestRoad(x, z) {
  const ix = Math.round((x + HALF) / CELL);
  const iz = Math.round((z + HALF) / CELL);
  return {
    ix: clamp(ix, 0, LINES), iz: clamp(iz, 0, LINES),
    dx: x - roadCenter(clamp(ix, 0, LINES)), dz: z - roadCenter(clamp(iz, 0, LINES)),
  };
}

// ---------------------------------------------------------------- textures

function makeWindowTextures(rng) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f7f7f2';
  ctx.fillRect(0, 0, size, size);
  // A little plaster grain so walls are not perfectly flat.
  for (let i = 0; i < 260; i += 1) {
    const v = 235 + Math.floor(rng.float() * 20);
    ctx.fillStyle = `rgba(${v},${v},${v - 4},0.5)`;
    ctx.fillRect(rng.float() * size, rng.float() * size, 3, 3);
  }
  const lit = document.createElement('canvas');
  lit.width = size; lit.height = size;
  const lctx = lit.getContext('2d');
  lctx.fillStyle = '#000000';
  lctx.fillRect(0, 0, size, size);

  const cols = 4, rows = 4;
  const cw = size / cols, ch = size / rows;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const wx = x * cw + cw * 0.22;
      const wy = y * ch + ch * 0.2;
      const ww = cw * 0.56;
      const wh = ch * 0.52;
      const isLit = rng.chance(0.34);
      ctx.fillStyle = isLit ? '#3b4a52' : '#2b353c';
      ctx.fillRect(wx, wy, ww, wh);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillRect(wx, wy, ww, 1.5);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(wx, wy + wh - 1.5, ww, 1.5);
      if (isLit) {
        const warm = 200 + Math.floor(rng.float() * 55);
        lctx.fillStyle = `rgb(${warm},${Math.floor(warm * 0.78)},${Math.floor(warm * 0.44)})`;
        lctx.fillRect(wx, wy, ww, wh);
      }
    }
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 4;
  const emissive = new THREE.CanvasTexture(lit);
  emissive.colorSpace = THREE.SRGBColorSpace;
  emissive.wrapS = emissive.wrapT = THREE.RepeatWrapping;
  return { map, emissive };
}

function makeShopTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 32;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f2f0e8';
  ctx.fillRect(0, 0, 64, 32);
  ctx.fillStyle = '#1e2a30';
  ctx.fillRect(2, 4, 60, 24);
  ctx.fillStyle = 'rgba(255,214,140,0.95)';
  ctx.fillRect(5, 7, 54, 18);
  ctx.fillStyle = 'rgba(30,42,48,0.85)';
  for (let i = 0; i < 4; i += 1) ctx.fillRect(6 + i * 14, 0, 2, 32);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeSignTexture(text, colorA, colorB) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 96;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 256, 96);
  const grad = ctx.createLinearGradient(0, 0, 256, 96);
  grad.addColorStop(0, colorA);
  grad.addColorStop(1, colorB);
  ctx.fillStyle = grad;
  ctx.globalAlpha = 0.22;
  ctx.fillRect(0, 0, 256, 96);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = colorB;
  ctx.lineWidth = 4;
  ctx.strokeRect(3, 3, 250, 90);
  ctx.font = 'bold 46px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = colorB;
  ctx.shadowBlur = 18;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, 128, 50);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// A soft radial sprite used for lamp halos, sun glow, headlight bloom and dust.
let softSprite = null;
function softGlowTexture() {
  if (softSprite) return softSprite;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.28, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.62, 'rgba(255,255,255,0.13)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  softSprite = new THREE.CanvasTexture(canvas);
  softSprite.colorSpace = THREE.SRGBColorSpace;
  return softSprite;
}
export { softGlowTexture };

// ---------------------------------------------------------------- day ramp

// Keyframes across one in-game day. Colours are the backbone of the whole look: bright blue at
// noon, gold at golden hour, warm rose at dusk, deep readable blue at night.
const DAY_KEYS = [
  { m: 0,    top: 0x0a1230, hor: 0x1d2f57, fog: 0x131f3a, sun: 0.10, hemi: 0.22, amb: 0.16, glow: 1.00, tint: 0x9db4e8 },
  { m: 300,  top: 0x132349, hor: 0x8a6f8e, fog: 0x2c3350, sun: 0.25, hemi: 0.28, amb: 0.20, glow: 0.92, tint: 0xd8b9c4 },
  { m: 400,  top: 0x2a5a93, hor: 0xffc79a, fog: 0xd8c2b0, sun: 1.10, hemi: 0.52, amb: 0.30, glow: 0.60, tint: 0xffd9b8 },
  { m: 520,  top: 0x2f7fc8, hor: 0xcfe6f6, fog: 0xd6e8f4, sun: 2.30, hemi: 0.82, amb: 0.34, glow: 0.18, tint: 0xfff3e2 },
  { m: 720,  top: 0x2f86d6, hor: 0xc4e6f8, fog: 0xcfe6f2, sun: 2.70, hemi: 0.92, amb: 0.36, glow: 0.05, tint: 0xfffaf0 },
  { m: 900,  top: 0x3583cd, hor: 0xd7e8f2, fog: 0xd5e6ef, sun: 2.50, hemi: 0.86, amb: 0.34, glow: 0.12, tint: 0xfff0d8 },
  { m: 1000, top: 0x3d7cbf, hor: 0xffd9a4, fog: 0xf0dcc2, sun: 2.20, hemi: 0.70, amb: 0.32, glow: 0.34, tint: 0xffd9ae },
  { m: 1090, top: 0x3a6aa8, hor: 0xffb37a, fog: 0xe8c3a8, sun: 1.55, hemi: 0.55, amb: 0.28, glow: 0.55, tint: 0xffc094 },
  { m: 1160, top: 0x2c4472, hor: 0xff9367, fog: 0xd9a68f, sun: 0.85, hemi: 0.40, amb: 0.24, glow: 0.78, tint: 0xffb08c },
  { m: 1240, top: 0x1c2b4f, hor: 0xa25f6a, fog: 0x6b5a66, sun: 0.30, hemi: 0.28, amb: 0.19, glow: 0.94, tint: 0xc9a2a8 },
  { m: 1320, top: 0x0d1733, hor: 0x26345c, fog: 0x1a2540, sun: 0.13, hemi: 0.24, amb: 0.17, glow: 1.00, tint: 0xa9bfe4 },
  { m: 1440, top: 0x0a1230, hor: 0x1d2f57, fog: 0x131f3a, sun: 0.10, hemi: 0.22, amb: 0.16, glow: 1.00, tint: 0x9db4e8 },
];

function lerpColor(out, a, b, t) {
  const ca = new THREE.Color(a), cb = new THREE.Color(b);
  out.copy(ca).lerp(cb, t);
  return out;
}

export class World {
  constructor(scene, seed = 7) {
    this.scene = scene;
    this.seed = seed >>> 0;
    this.rng = seeded(this.seed, 11);
    this.city = new THREE.Group();
    this.city.name = 'city';
    scene.add(this.city);

    this.boxes = [];       // solid axis-aligned rectangles: { x, z, hw, hd, height, kind }
    this.props = [];       // small knockables: { mesh, x, z, r, kind, alive }
    this.neonLights = [];
    this.windowMaterials = [];
    this.glowMaterials = [];   // { mat, base }
    this.clockMinutes = 16 * 60 + 40;
    this.glowScale = 1;
    this.nightLift = 1;
    this.sun = null;
    this.hemi = null;
    this.ambient = null;
    this.skyUniforms = null;
    this.sea = null;
    this.lampSpots = [];
    this.parkingSpots = [];

    this._buildSky();
    this._buildLights();
    this._buildGround();
    this._buildSea();
    this._buildBlocks();
    this._buildStreetProps();
    this._buildPalms();
    this.stepDay(this.clockMinutes);
  }

  // -------------------------------------------------------------- sky & light

  _buildSky() {
    const uniforms = {
      topColor: { value: new THREE.Color(PALETTE.skyTop) },
      horizonColor: { value: new THREE.Color(PALETTE.skyHorizon) },
      sunDir: { value: new THREE.Vector3(0.7, 0.3, -0.4).normalize() },
      sunColor: { value: new THREE.Color(PALETTE.sun) },
      sunStrength: { value: 1 },
      nightMix: { value: 0 },
    };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1200, 32, 20),
      new THREE.ShaderMaterial({
        uniforms,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        vertexShader: /* glsl */`
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */`
          uniform vec3 topColor;
          uniform vec3 horizonColor;
          uniform vec3 sunColor;
          uniform vec3 sunDir;
          uniform float sunStrength;
          uniform float nightMix;
          varying vec3 vDir;
          void main() {
            float h = clamp(vDir.y * 1.25 + 0.06, 0.0, 1.0);
            vec3 col = mix(horizonColor, topColor, pow(h, 0.72));
            float sunDot = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
            float halo = pow(sunDot, 6.0) * 0.55 + pow(sunDot, 90.0) * 1.4;
            col += sunColor * halo * sunStrength;
            float disc = smoothstep(0.9975, 0.9992, sunDot);
            col += sunColor * disc * 3.0 * max(sunStrength, 0.0);
            // A warm band right on the horizon, the way a port town glows at golden hour.
            col += sunColor * pow(1.0 - h, 6.0) * 0.16 * sunStrength;
            col = mix(col, col * vec3(0.86, 0.92, 1.10), nightMix * 0.35);
            gl_FragColor = vec4(col, 1.0);
          }`,
      }),
    );
    sky.frustumCulled = false;
    sky.name = 'sky';
    this.sky = sky;
    this.skyUniforms = uniforms;
    this.scene.add(sky);

    this.scene.fog = new THREE.Fog(PALETTE.fog, 120, 780);
  }

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0xdff1ff, 0xc9a877, 0.9);
    this.scene.add(this.hemi);

    this.ambient = new THREE.AmbientLight(0xffe7c8, 0.34);
    this.scene.add(this.ambient);

    const sun = new THREE.DirectionalLight(PALETTE.sun, 2.6);
    sun.position.set(160, 110, -90);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const cam = sun.shadow.camera;
    cam.left = -130; cam.right = 130; cam.top = 130; cam.bottom = -130;
    cam.near = 1; cam.far = 520;
    sun.shadow.bias = -0.0009;
    sun.shadow.normalBias = 0.5;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;
    this.sunTarget = sun.target;

    // Rim light from the opposite side: keeps silhouettes crisp against the bright sky.
    this.rim = new THREE.DirectionalLight(0x9fd0ff, 0.55);
    this.rim.position.set(-120, 70, 120);
    this.scene.add(this.rim);
  }

  // -------------------------------------------------------------- ground & sea

  _buildGround() {
    const size = HALF * 2 + 300;
    const asphalt = new THREE.MeshStandardMaterial({
      color: PALETTE.asphalt, roughness: 0.62, metalness: 0.06,
    });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size), asphalt);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, 0, 0);
    ground.receiveShadow = true;
    this.city.add(ground);

    // Pavement slabs sit a touch above the asphalt so lanes read clearly.
    const walkMat = new THREE.MeshStandardMaterial({ color: PALETTE.pavement, roughness: 0.85 });
    const kerbMat = new THREE.MeshStandardMaterial({ color: PALETTE.kerb, roughness: 0.9 });
    const slabGeo = new THREE.BoxGeometry(1, 0.28, 1);
    const slabs = new THREE.InstancedMesh(slabGeo, walkMat, LINES * LINES * 3);
    slabs.castShadow = false; slabs.receiveShadow = true;
    const kerbs = new THREE.InstancedMesh(slabGeo, kerbMat, LINES * LINES * 2);
    kerbs.receiveShadow = true;
    const m = new THREE.Matrix4();
    let n = 0;
    let kn = 0;
    const walkWidth = BLOCK_INNER + WALK * 2;
    for (let i = 0; i < LINES; i += 1) {
      for (let j = 0; j < LINES; j += 1) {
        const cx = blockCenter(i), cz = blockCenter(j);
        if (cx > CITY.seaEdge - 40) continue;
        // Four pavement strips around the block interior.
        const strip = (sx, sz, sw, sd) => {
          m.makeScale(sw, 1, sd);
          m.setPosition(sx, 0.14, sz);
          slabs.setMatrixAt(n++, m);
        };
        strip(cx, cz - (walkWidth / 2 - WALK / 2), walkWidth, WALK);
        strip(cx, cz + (walkWidth / 2 - WALK / 2), walkWidth, WALK);
        strip(cx - (walkWidth / 2 - WALK / 2), cz, WALK, BLOCK_INNER);
        strip(cx + (walkWidth / 2 - WALK / 2), cz, WALK, BLOCK_INNER);
        // Kerb lips facing the road.
        const kerb = (sx, sz, sw, sd) => {
          m.makeScale(sw, 1, sd);
          m.setPosition(sx, 0.2, sz);
          kerbs.setMatrixAt(kn++, m);
        };
        kerb(cx, cz - walkWidth / 2, walkWidth, 0.5);
        kerb(cx, cz + walkWidth / 2, walkWidth, 0.5);
      }
    }
    slabs.count = n; kerbs.count = kn;
    slabs.instanceMatrix.needsUpdate = true;
    kerbs.instanceMatrix.needsUpdate = true;
    this.city.add(slabs, kerbs);

    // Lane dashes: a light strip down the middle of every road.
    const dashMat = new THREE.MeshBasicMaterial({ color: 0xf0ead6, transparent: true, opacity: 0.5 });
    const dashGeo = new THREE.PlaneGeometry(0.55, 3.4);
    const dashes = new THREE.InstancedMesh(dashGeo, dashMat, LINES * LINES * 18);
    let dn = 0;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    for (let i = 0; i < LINES + 1; i += 1) {
      for (let j = 0; j < LINES + 1; j += 1) {
        const x = roadCenter(i), z = roadCenter(j);
        if (x > CITY.seaEdge - 20) continue;
        for (let k = -3; k <= 3; k += 1) {
          const off = k * 7.5;
          const p1 = new THREE.Vector3(x + off, 0.05, z);
          if (Math.abs(off) > 4 && Math.abs(z) < HALF) {
            m.compose(p1, q, new THREE.Vector3(1, 1, 1));
            dashes.setMatrixAt(dn++, m);
          }
          const p2 = new THREE.Vector3(x, 0.05, z + off);
          if (Math.abs(off) > 4 && Math.abs(x) < HALF) {
            m.compose(p2, q, new THREE.Vector3(1, 1, 1));
            dashes.setMatrixAt(dn++, m);
          }
        }
      }
    }
    dashes.count = dn;
    dashes.instanceMatrix.needsUpdate = true;
    this.city.add(dashes);
  }

  _buildSea() {
    const water = new THREE.MeshStandardMaterial({
      color: PALETTE.sea, roughness: 0.24, metalness: 0.28, transparent: false,
    });
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(1500, 1500, 1, 1), water);
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(CITY.seaEdge + 750, -0.35, 0);
    sea.receiveShadow = false;
    this.city.add(sea);
    this.sea = sea;

    const deep = new THREE.Mesh(
      new THREE.PlaneGeometry(1500, 1500),
      new THREE.MeshStandardMaterial({ color: PALETTE.seaDeep, roughness: 0.3, metalness: 0.2 }),
    );
    deep.rotation.x = -Math.PI / 2;
    deep.position.set(CITY.seaEdge + 750, -0.42, 0);
    this.city.add(deep);

    // Beach + a bright foam lip where the city meets the water.
    const sand = new THREE.Mesh(
      new THREE.PlaneGeometry(70, HALF * 2 + 200),
      new THREE.MeshStandardMaterial({ color: PALETTE.sand, roughness: 0.95 }),
    );
    sand.rotation.x = -Math.PI / 2;
    sand.position.set(CITY.seaEdge - 20, 0.03, 0);
    sand.receiveShadow = true;
    this.city.add(sand);

    const foam = new THREE.Mesh(
      new THREE.PlaneGeometry(4, HALF * 2 + 200),
      new THREE.MeshBasicMaterial({ color: 0xe8fbff, transparent: true, opacity: 0.55 }),
    );
    foam.rotation.x = -Math.PI / 2;
    foam.position.set(CITY.seaEdge + 2, 0.05, 0);
    this.city.add(foam);

    // A quay line so the waterfront reads as built, not as a sand bar.
    const quayMat = new THREE.MeshStandardMaterial({ color: 0xdcd4c4, roughness: 0.9 });
    const quay = new THREE.Mesh(new THREE.BoxGeometry(8, 1.6, HALF * 2 + 200), quayMat);
    quay.position.set(CITY.seaEdge - 34, 0.8, 0);
    quay.castShadow = true; quay.receiveShadow = true;
    this.city.add(quay);
  }

  // -------------------------------------------------------------- buildings

  _windowMaterial(variant, tint) {
    const key = `${variant}|${tint}`;
    this._matCache = this._matCache || new Map();
    if (this._matCache.has(key)) return this._matCache.get(key);
    const tex = this._winTex[variant];
    const mat = new THREE.MeshStandardMaterial({
      color: tint,
      map: tex.map,
      emissive: 0xffcb82,
      emissiveMap: tex.emissive,
      emissiveIntensity: 0.0,
      roughness: 0.86,
      metalness: 0.03,
    });
    this._matCache.set(key, mat);
    this.windowMaterials.push(mat);
    return mat;
  }

  _buildBlocks() {
    this._winTex = [makeWindowTextures(seeded(this.seed, 101)), makeWindowTextures(seeded(this.seed, 102)), makeWindowTextures(seeded(this.seed, 103))];
    const shopTex = makeShopTexture();
    this.shopMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: shopTex, emissive: 0xffbe6a, emissiveIntensity: 0.1, roughness: 0.8,
    });

    const roofMat = new THREE.MeshStandardMaterial({ color: PALETTE.terracotta, roughness: 0.9 });
    const tankMat = new THREE.MeshStandardMaterial({ color: 0xd9cfbc, roughness: 0.9 });
    const awningMats = [PALETTE.neon[0], PALETTE.neon[1], PALETTE.neon[2], PALETTE.neon[3], PALETTE.neon[4]]
      .map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, emissive: c, emissiveIntensity: 0.25 }));

    const rng = this.rng;
    let count = 0;
    const neonTexts = ['HOTEL', 'MARISCO', 'SOL', 'BAR', 'PESCA', 'FERRY', 'RENT', 'CLUB', 'TAPAS', 'MOTEL'];

    for (let i = 0; i < LINES; i += 1) {
      for (let j = 0; j < LINES; j += 1) {
        const cx = blockCenter(i), cz = blockCenter(j);
        if (cx > CITY.seaEdge - 60) continue;
        // Mission yards stay open so every beacon is actually drivable to.
        if (RESERVED_BLOCKS.has(`${i},${j}`)) { this._makeYard(cx, cz, rng); continue; }

        // Outskirts are looser: more empty lots, lower buildings.
        const core = Math.max(0, 1 - Math.hypot(cx, cz) / 420);
        const plazaChance = 0.34 - core * 0.22;
        if (rng.chance(plazaChance)) { this._makePlaza(cx, cz, rng); continue; }

        const split = rng.chance(0.42);
        const plots = split
          ? (rng.chance(0.5)
            ? [{ x: cx - BLOCK_INNER / 4, z: cz, w: BLOCK_INNER / 2 - 1, d: BLOCK_INNER - 2 },
              { x: cx + BLOCK_INNER / 4, z: cz, w: BLOCK_INNER / 2 - 1, d: BLOCK_INNER - 2 }]
            : [{ x: cx, z: cz - BLOCK_INNER / 4, w: BLOCK_INNER - 2, d: BLOCK_INNER / 2 - 1 },
              { x: cx, z: cz + BLOCK_INNER / 4, w: BLOCK_INNER - 2, d: BLOCK_INNER / 2 - 1 }])
          : [{ x: cx, z: cz, w: BLOCK_INNER - rng.range(0, 6), d: BLOCK_INNER - rng.range(0, 6) }];

        for (const plot of plots) {
          if (count >= CITY.buildingMax) break;
          const variant = rng.int(0, 2);
          const tint = rng.pick(PALETTE.wall);
          const h = clamp(rng.range(7, 15) + core * rng.range(4, 30) + rng.range(0, 9), 6, 52);
          const b = this._makeBuilding(plot.x, plot.z, plot.w, plot.d, h, variant, tint, roofMat, tankMat, rng);
          count += 1;

          // Shopfronts and neon on the street-facing side.
          const face = rng.int(0, 3);
          const dirs = [[0, 1, 0], [0, -1, Math.PI], [1, 0, Math.PI / 2], [-1, 0, -Math.PI / 2]];
          const [dx, dz, rot] = dirs[face];
          const halfW = (face < 2 ? plot.w : plot.d) / 2;
          const shop = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(halfW * 1.5, 12), 3.1), this.shopMat);
          shop.position.set(
            plot.x + dx * (plot.w / 2 + 0.06),
            1.85,
            plot.z + dz * (plot.d / 2 + 0.06),
          );
          shop.rotation.y = rot;
          this.city.add(shop);
          this._registerGlow(this.shopMat, 0.12);

          // Awning over the shop.
          const awning = new THREE.Mesh(
            new THREE.BoxGeometry(Math.min(halfW * 1.5, 12), 0.3, 1.6),
            rng.pick(awningMats),
          );
          awning.position.set(shop.position.x + dx * 0.9, 3.5, shop.position.z + dz * 0.9);
          awning.castShadow = true;
          this.city.add(awning);

          if (rng.chance(0.42)) {
            const text = rng.pick(neonTexts);
            const colA = `#${new THREE.Color(PALETTE.neon[rng.int(0, 4)]).getHexString()}`;
            const colB = `#${new THREE.Color(PALETTE.neon[rng.int(0, 4)]).getHexString()}`;
            const tex = makeSignTexture(text, colA, colB);
            const signMat = new THREE.MeshBasicMaterial({
              map: tex, transparent: true, blending: THREE.AdditiveBlending,
              depthWrite: false, side: THREE.DoubleSide, opacity: 0.9,
            });
            const sign = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 2.7), signMat);
            const sy = Math.min(h * 0.62, 8 + rng.range(0, 6));
            sign.position.set(
              plot.x + dx * (plot.w / 2 + 0.18),
              sy,
              plot.z + dz * (plot.d / 2 + 0.18),
            );
            sign.rotation.y = rot;
            this.city.add(sign);
            this._registerGlow(signMat, 1.0);
          }
        }
      }
    }
    this.buildingCount = count;
  }

  _makeBuilding(x, z, w, d, h, variant, tint, roofMat, tankMat, rng) {
    const geo = new THREE.BoxGeometry(w, h, d);
    scaleBoxUV(geo, w, h, d, 6, 6);
    const mesh = new THREE.Mesh(geo, this._windowMaterial(variant, tint));
    mesh.position.set(x, h / 2, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.city.add(mesh);

    // Terracotta roof cap, slightly oversized, with a little overhang.
    const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.9, 0.9, d + 0.9), roofMat);
    cap.position.set(x, h + 0.35, z);
    cap.castShadow = true;
    this.city.add(cap);

    // Rooftop clutter: water tank, AC box, or a stair head. Cheap, reads as a real skyline.
    if (rng.chance(0.55)) {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 1.9, 8), tankMat);
      tank.position.set(x + rng.range(-w / 4, w / 4), h + 1.6, z + rng.range(-d / 4, d / 4));
      tank.castShadow = true;
      this.city.add(tank);
    } else if (rng.chance(0.6)) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.1, 2.0), tankMat);
      box.position.set(x + rng.range(-w / 4, w / 4), h + 1.4, z + rng.range(-d / 4, d / 4));
      box.castShadow = true;
      this.city.add(box);
    }

    this.boxes.push({ x, z, hw: w / 2, hd: d / 2, height: h, kind: 'building' });

    // Baked window glow: a few additive cards on the facade so night has depth beyond the
    // emissive map. They are grouped so the ramp can lift them together.
    if (rng.chance(0.5)) {
      const glowMat = new THREE.MeshBasicMaterial({
        map: softGlowTexture(), color: 0xffc978, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.12,
      });
      this._registerGlow(glowMat, 0.12);
      const card = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.5, h * 0.4), glowMat);
      card.position.set(x, h * 0.55, z + d / 2 + 0.1);
      this.city.add(card);
    }
    return mesh;
  }

  _makePlaza(cx, cz, rng) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xd9d0bd, roughness: 0.92 });
    const ground = new THREE.Mesh(new THREE.BoxGeometry(BLOCK_INNER + 2, 0.2, BLOCK_INNER + 2), mat);
    ground.position.set(cx, 0.1, cz);
    ground.receiveShadow = true;
    this.city.add(ground);
    // A couple of palms and a bench-ish crate so empty lots still look lived in.
    const n = rng.int(1, 3);
    for (let i = 0; i < n; i += 1) this._makePalm(cx + rng.range(-8, 8), cz + rng.range(-8, 8), rng);
  }

  /** An open yard: cracked concrete, a low wall at the back, crates. Mission targets live here. */
  _makeYard(cx, cz, rng) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xbdb3a2, roughness: 0.95 });
    const ground = new THREE.Mesh(new THREE.BoxGeometry(BLOCK_INNER + 2, 0.18, BLOCK_INNER + 2), mat);
    ground.position.set(cx, 0.09, cz);
    ground.receiveShadow = true;
    this.city.add(ground);

    // A painted stop box, so the yard reads as somewhere you deliver to.
    const paint = new THREE.Mesh(
      new THREE.PlaneGeometry(11, 11),
      new THREE.MeshBasicMaterial({ color: 0x2ff0d0, transparent: true, opacity: 0.16 }),
    );
    paint.rotation.x = -Math.PI / 2;
    paint.position.set(cx, 0.19, cz);
    this.city.add(paint);

    // Low wall round the far edge only, leaving the street side open.
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xe8e0cf, roughness: 0.9 });
    const wall = new THREE.Mesh(new THREE.BoxGeometry(BLOCK_INNER + 2, 2.6, 1.2), wallMat);
    wall.position.set(cx, 1.3, cz + BLOCK_INNER / 2);
    wall.castShadow = true; wall.receiveShadow = true;
    this.city.add(wall);
    this.boxes.push({ x: cx, z: cz + BLOCK_INNER / 2, hw: (BLOCK_INNER + 2) / 2, hd: 0.6, height: 2.6, kind: 'wall' });

    const crateMat = new THREE.MeshStandardMaterial({ color: 0xb48a55, roughness: 0.85 });
    for (let i = 0; i < 3; i += 1) {
      const crate = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), crateMat);
      const ox = cx + rng.range(-BLOCK_INNER / 3, BLOCK_INNER / 3);
      const oz = cz + rng.range(-BLOCK_INNER / 3, BLOCK_INNER / 3);
      crate.position.set(ox, 0.7, oz);
      crate.rotation.y = rng.range(0, TAU);
      crate.castShadow = true;
      this.city.add(crate);
      this.props.push({ x: ox, z: oz, r: 0.72, kind: 'crate', mesh: crate, alive: true, solid: true, vy: 0, tipped: false });
    }
  }

  _registerGlow(mat, base) {
    if (this.glowMaterials.some((g) => g.mat === mat)) return;
    mat.userData.baseOpacity = base;
    this.glowMaterials.push({ mat, base });
  }

  // -------------------------------------------------------------- street props

  _buildStreetProps() {
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x3b4048, roughness: 0.6, metalness: 0.4 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xfff3d0, emissive: 0xffd68a, emissiveIntensity: 0.6, roughness: 0.4 });
    const lampGlowMat = new THREE.MeshBasicMaterial({
      map: softGlowTexture(), color: 0xffd79a, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.3,
    });
    const poolMat = new THREE.MeshBasicMaterial({
      map: softGlowTexture(), color: 0xffca85, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.16,
    });
    this._registerGlow(lampGlowMat, 0.3);
    this._registerGlow(poolMat, 0.16);
    this.lampGlowMat = lampGlowMat;
    this.poolMat = poolMat;

    const poleGeo = new THREE.CylinderGeometry(0.16, 0.22, 7.2, 6);
    const armGeo = new THREE.BoxGeometry(2.0, 0.18, 0.18);
    const headGeo = new THREE.BoxGeometry(1.2, 0.28, 0.6);
    const poolGeo = new THREE.PlaneGeometry(11, 11);

    const rng = this.rng;
    for (let i = 0; i < LINES + 1; i += 1) {
      for (let j = 0; j < LINES + 1; j += 1) {
        if ((i + j) % CITY.lampSpacing !== 0) continue;
        const x = roadCenter(i), z = roadCenter(j);
        if (x > CITY.seaEdge - 30) continue;
        // One lamp per corner, offset into the pavement quadrant.
        const ox = rng.chance(0.5) ? 1 : -1;
        const oz = rng.chance(0.5) ? 1 : -1;
        const px = x + ox * (ROAD_HALF + 2.4);
        const pz = z + oz * (ROAD_HALF + 2.4);
        const pole = new THREE.Mesh(poleGeo, poleMat);
        pole.position.set(px, 3.6, pz);
        pole.castShadow = true;
        this.city.add(pole);

        const arm = new THREE.Mesh(armGeo, poleMat);
        arm.position.set(px - ox * 1.0, 7.1, pz);
        arm.rotation.y = ox > 0 ? Math.PI / 2 : -Math.PI / 2;
        this.city.add(arm);

        const head = new THREE.Mesh(headGeo, headMat);
        head.position.set(px - ox * 2.0, 6.95, pz);
        this.city.add(head);

        const halo = new THREE.Mesh(new THREE.SphereGeometry(1.5, 8, 6), lampGlowMat);
        halo.position.set(px - ox * 2.0, 6.9, pz);
        this.city.add(halo);

        const pool = new THREE.Mesh(poolGeo, poolMat);
        pool.rotation.x = -Math.PI / 2;
        pool.position.set(px - ox * 2.0, 0.07, pz);
        this.city.add(pool);

        this.props.push({ x: px, z: pz, r: 0.34, kind: 'lamp', mesh: pole, alive: true, solid: true });
        this.lampSpots.push({ x: px - ox * 2.0, z: pz });
      }
    }

    // Hydrants, crates and bins along the kerbs — everything here is knockable by a car.
    const hydrantMat = new THREE.MeshStandardMaterial({ color: 0xd9412f, roughness: 0.6 });
    const hydrantGeo = new THREE.CylinderGeometry(0.28, 0.34, 1.1, 8);
    const crateMat = new THREE.MeshStandardMaterial({ color: 0xb48a55, roughness: 0.85 });
    const crateGeo = new THREE.BoxGeometry(1.1, 1.1, 1.1);
    const binMat = new THREE.MeshStandardMaterial({ color: 0x3f6b58, roughness: 0.7 });

    for (let i = 0; i < 150; i += 1) {
      const ix = rng.int(0, LINES);
      const iz = rng.int(0, LINES);
      const x = roadCenter(ix) + rng.range(-ROAD_HALF - 3, ROAD_HALF + 3);
      const z = roadCenter(iz) + rng.range(-ROAD_HALF - 3, ROAD_HALF + 3);
      if (x > CITY.seaEdge - 30) continue;
      if (Math.abs(x - roadCenter(ix)) < ROAD_HALF - 1 && Math.abs(z - roadCenter(iz)) < ROAD_HALF - 1) continue;
      if (this.isBlocked(x, z, 1.2)) continue;
      const kind = rng.pick(['hydrant', 'crate', 'bin', 'crate']);
      let mesh;
      if (kind === 'hydrant') mesh = new THREE.Mesh(hydrantGeo, hydrantMat);
      else if (kind === 'crate') mesh = new THREE.Mesh(crateGeo, crateMat);
      else mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.42, 1.2, 8), binMat);
      mesh.position.set(x, kind === 'hydrant' ? 0.55 : 0.6, z);
      mesh.rotation.y = rng.range(0, TAU);
      mesh.castShadow = true;
      this.city.add(mesh);
      this.props.push({ x, z, r: kind === 'crate' ? 0.7 : 0.5, kind, mesh, alive: true, solid: kind !== 'crate', vy: 0, tipped: false });
    }
  }

  _buildPalms() {
    const rng = this.rng;
    // Waterfront palms, plus a scatter through the plazas.
    for (let i = 0; i < 46; i += 1) {
      const nearSea = i < 34;
      const x = nearSea ? rng.range(CITY.seaEdge - 120, CITY.seaEdge - 40) : rng.range(-HALF + 40, CITY.seaEdge - 80);
      const z = rng.range(-HALF + 30, HALF - 30);
      if (this.isBlocked(x, z, 2.2)) continue;
      this._makePalm(x, z, rng);
    }
  }

  _makePalm(x, z, rng) {
    const h = rng.range(6.5, 10.5);
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.26, 0.42, h, 6),
      new THREE.MeshStandardMaterial({ color: PALETTE.palmTrunk, roughness: 0.9 }),
    );
    trunk.position.set(x, h / 2, z);
    trunk.castShadow = true;
    this.city.add(trunk);

    const leafMat = new THREE.MeshStandardMaterial({ color: PALETTE.palmLeaf, roughness: 0.8, side: THREE.DoubleSide });
    const crowns = new THREE.Group();
    for (let i = 0; i < 7; i += 1) {
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.55, 3.6, 4), leafMat);
      leaf.position.y = 0;
      leaf.rotation.z = Math.PI / 2.4;
      leaf.rotation.y = (i / 7) * TAU + rng.range(-0.2, 0.2);
      leaf.translateY(1.5);
      leaf.castShadow = true;
      crowns.add(leaf);
    }
    crowns.position.set(x, h, z);
    this.city.add(crowns);
    this.props.push({ x, z, r: 0.55, kind: 'palm', mesh: trunk, alive: true, solid: true });
  }

  // -------------------------------------------------------------- collision

  /** Is (x,z) within radius of a solid building or prop? */
  isBlocked(x, z, radius = 0) {
    if (Math.abs(x) > HALF + 40 || Math.abs(z) > HALF + 40) return true;
    if (x > CITY.seaEdge - 30) return true;
    for (const b of this.boxes) {
      const dx = Math.abs(x - b.x) - b.hw;
      const dz = Math.abs(z - b.z) - b.hd;
      if (dx < radius && dz < radius) {
        if (dx < 0 && dz < 0) return true;
        if (Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) < radius) return true;
      }
    }
    for (const p of this.props) {
      if (!p.solid || !p.alive) continue;
      if (Math.hypot(x - p.x, z - p.z) < radius + p.r) return true;
    }
    return false;
  }

  /** Push a circle out of every solid rectangle; returns {x,z,hit}. */
  resolveCircle(pos, radius) {
    let hit = false;
    for (const b of this.boxes) {
      const dx = pos.x - b.x;
      const dz = pos.z - b.z;
      const cx = clamp(dx, -b.hw, b.hw);
      const cz = clamp(dz, -b.hd, b.hd);
      let ox = dx - cx;
      let oz = dz - cz;
      const d = Math.hypot(ox, oz);
      if (d < radius) {
        hit = true;
        if (d > 1e-5) {
          const push = (radius - d) / d;
          pos.x += ox * push;
          pos.z += oz * push;
        } else {
          // Deep inside: escape along the shallowest axis.
          const px = b.hw + radius - Math.abs(dx);
          const pz = b.hd + radius - Math.abs(dz);
          if (px < pz) pos.x += Math.sign(dx || 1) * px;
          else pos.z += Math.sign(dz || 1) * pz;
        }
      }
    }
    for (const p of this.props) {
      if (!p.solid || !p.alive) continue;
      const dx = pos.x - p.x;
      const dz = pos.z - p.z;
      const d = Math.hypot(dx, dz);
      const min = radius + p.r;
      if (d < min && d > 1e-5) {
        const push = (min - d) / d;
        pos.x += dx * push;
        pos.z += dz * push;
        hit = true;
      }
    }
    const lim = HALF + 20;
    if (pos.x > CITY.seaEdge - 34) pos.x = CITY.seaEdge - 34;
    if (pos.x < -lim) pos.x = -lim;
    if (pos.z < -lim) pos.z = -lim;
    if (pos.z > lim) pos.z = lim;
    return hit;
  }

  /** Knock a prop over: it tilts, hops, and stops blocking. */
  knockProp(prop, dirX, dirZ, force = 1) {
    if (!prop || !prop.alive || prop.tipped) return;
    prop.tipped = true;
    prop.solid = false;
    prop.vy = 3.4 * force;
    prop.spin = (dirX + dirZ) * 2.2;
    prop.tilt = 0;
  }

  stepProps(dt) {
    for (const p of this.props) {
      if (!p.tipped || !p.mesh) continue;
      p.vy -= 22 * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.rotation.z += (p.spin || 0) * dt;
      p.mesh.rotation.x += (p.spin || 0) * 0.4 * dt;
      if (p.mesh.position.y <= 0.28) {
        p.mesh.position.y = 0.28;
        p.vy = 0;
        p.spin = 0;
      }
    }
  }

  // -------------------------------------------------------------- parking

  /** Kerbside parking spots, found deterministically once, then queried at runtime. */
  findParkingSpot(nearX = 0, nearZ = 0, wantFree = true) {
    if (!this.parkingSpots.length) {
      const rng = seeded(this.seed, 55);
      for (let i = 0; i < LINES + 1; i += 1) {
        for (let j = 0; j < LINES + 1; j += 1) {
          const rx = roadCenter(i), rz = roadCenter(j);
          if (rx > CITY.seaEdge - 40) continue;
          for (let k = 0; k < 2; k += 1) {
            const along = rng.range(-CELL / 2 + 9, CELL / 2 - 9);
            const side = rng.chance(0.5) ? 1 : -1;
            const spot = rng.chance(0.5)
              ? { x: rx + side * (ROAD_HALF - 1.9), z: rz + along, heading: rng.chance(0.5) ? 0 : Math.PI }
              : { x: rx + along, z: rz + side * (ROAD_HALF - 1.9), heading: rng.chance(0.5) ? Math.PI / 2 : -Math.PI / 2 };
            if (this.isBlocked(spot.x, spot.z, 1.6)) continue;
            this.parkingSpots.push({ ...spot, taken: false });
          }
        }
      }
    }
    let best = null;
    let bestD = Infinity;
    for (const s of this.parkingSpots) {
      if (wantFree && s.taken) continue;
      const d = (s.x - nearX) ** 2 + (s.z - nearZ) ** 2;
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  /** Reserve the nearest free spot to a point (used when spawning/parking scripts). */
  takeParkingSpot(nearX, nearZ) {
    const spot = this.findParkingSpot(nearX, nearZ, true);
    if (spot) spot.taken = true;
    return spot;
  }

  // -------------------------------------------------------------- day ramp

  _daySample(minutes) {
    const m = ((minutes % 1440) + 1440) % 1440;
    let a = DAY_KEYS[0], b = DAY_KEYS[DAY_KEYS.length - 1];
    for (let i = 0; i < DAY_KEYS.length - 1; i += 1) {
      if (m >= DAY_KEYS[i].m && m <= DAY_KEYS[i + 1].m) { a = DAY_KEYS[i]; b = DAY_KEYS[i + 1]; break; }
    }
    const t = b.m === a.m ? 0 : smoothstep(clamp((m - a.m) / (b.m - a.m), 0, 1));
    return {
      top: lerpColor(new THREE.Color(), a.top, b.top, t),
      hor: lerpColor(new THREE.Color(), a.hor, b.hor, t),
      fog: lerpColor(new THREE.Color(), a.fog, b.fog, t),
      tint: lerpColor(new THREE.Color(), a.tint, b.tint, t),
      sun: lerp(a.sun, b.sun, t),
      hemi: lerp(a.hemi, b.hemi, t),
      amb: lerp(a.amb, b.amb, t),
      glow: lerp(a.glow, b.glow, t),
    };
  }

  /** Slow lighting shift as the in-game clock moves. */
  stepDay(minutes) {
    this.clockMinutes = minutes;
    const s = this._daySample(minutes);
    const hourAngle = ((minutes % 1440) - 360) / 1440 * TAU;
    const elev = Math.sin(hourAngle) * 0.92;
    const dirX = -Math.cos(hourAngle) * 0.86;
    const dirZ = -0.34;
    const dirY = Math.max(-0.22, elev);
    const dir = new THREE.Vector3(dirX, dirY, dirZ).normalize();

    this.skyUniforms.topColor.value.copy(s.top);
    this.skyUniforms.horizonColor.value.copy(s.hor);
    this.skyUniforms.sunDir.value.copy(dir);
    this.skyUniforms.sunColor.value.copy(s.tint);
    this.skyUniforms.sunStrength.value = clamp(s.sun * 0.55, 0, 1.6);
    this.skyUniforms.nightMix.value = 1 - clamp(elev * 1.6 + 0.25, 0, 1);

    this.scene.fog.color.copy(s.fog);
    this.scene.fog.near = 120 - s.glow * 40;
    this.scene.fog.far = 780 - s.glow * 190;

    this.sun.position.copy(dir).multiplyScalar(260);
    this.sun.position.y = Math.max(28, this.sun.position.y);
    this._sunDirX = dir.x;
    this._sunDirZ = dir.z;
    this._sunY = Math.max(60, dir.y * 260);
    this.sun.color.copy(s.tint);
    this.sun.intensity = s.sun;
    this.hemi.intensity = s.hemi;
    this.hemi.color.copy(s.hor).lerp(new THREE.Color(0xffffff), 0.5);
    this.hemi.groundColor.set(0xc9a877).lerp(new THREE.Color(0x2a3550), s.glow * 0.7);
    this.ambient.intensity = s.amb;
    this.ambient.color.copy(s.tint).lerp(new THREE.Color(0xffffff), 0.6);
    this.rim.intensity = 0.55 * (1 - s.glow * 0.55);
    this.rim.color.copy(s.hor);

    if (this.sea) {
      this.sea.material.color.copy(new THREE.Color(PALETTE.sea)).lerp(new THREE.Color(0x0d3550), s.glow * 0.8);
      this.sea.material.metalness = 0.28 + s.glow * 0.35;
    }

    this.baseGlow = s.glow;
    this._applyGlow();
    this._applyWindows();
  }

  /** Extra lift for the night staging: brighter night, still readable. */
  liftNight(amount = 1.35) {
    this.nightLift = amount;
    this._applyGlow();
    this._applyWindows();
  }

  _applyGlow() {
    const k = this.baseGlow * this.nightLift;
    for (const { mat, base } of this.glowMaterials) {
      mat.opacity = clamp(base * k, 0, 1);
      if (mat.opacity < 0.005) mat.opacity = 0;
    }
  }

  _applyWindows() {
    const k = this.baseGlow * this.nightLift;
    for (const mat of this.windowMaterials) mat.emissiveIntensity = k * 1.25;
    if (this.shopMat) this.shopMat.emissiveIntensity = 0.1 + k * 0.85;
  }

  update(dt, playerPos) {
    this.stepProps(dt);
    if (this.sun && playerPos) {
      // Keep the shadow frustum around the player so the shadow budget buys sharp detail.
      this.sun.target.position.set(playerPos.x, 0, playerPos.z);
      this.sun.position.set(
        playerPos.x + this._sunDirX * 240,
        Math.max(60, this._sunY),
        playerPos.z + this._sunDirZ * 240,
      );
      this.sun.target.updateMatrixWorld();
    }
  }
}

// ---------------------------------------------------------------- helpers

/** Scale a BoxGeometry's per-face UVs so windows tile at a stable real-world size. */
function scaleBoxUV(geo, w, h, d, unitX, unitY) {
  const uv = geo.attributes.uv;
  const su = [d / unitX, d / unitX, w / unitX, w / unitX, w / unitX, w / unitX];
  const sv = [h / unitY, h / unitY, d / unitY, d / unitY, h / unitY, h / unitY];
  for (let f = 0; f < 6; f += 1) {
    for (let v = 0; v < 4; v += 1) {
      const i = f * 4 + v;
      uv.setXY(i, uv.getX(i) * su[f], uv.getY(i) * sv[f]);
    }
  }
  uv.needsUpdate = true;
}

export function blockBounds(i, j) {
  const cx = blockCenter(i), cz = blockCenter(j);
  return { cx, cz, half: BLOCK_INNER / 2 + WALK };
}
