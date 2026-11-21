// Cars. Five classes built from boxes, arcade handling that actually feels good: forward thrust
// along the nose, lateral grip that bleeds sideways slide away, a handbrake that lets the tail
// step out, steering that weakens with speed and reverses in reverse, plus collisions, damage,
// smoke, skid marks and the police light bar.

import * as THREE from 'three';
import { VEHICLE_CLASSES, PALETTE, CITY } from './config.js';
import { clamp, lerp, damp, wrapAngle, TAU, seeded } from './random.js';
import { softGlowTexture } from './world.js';

const UP = new THREE.Vector3(0, 1, 0);
const WHEEL_R = 0.36;

const sharedGeo = {};
function geo(key, make) {
  if (!sharedGeo[key]) sharedGeo[key] = make();
  return sharedGeo[key];
}

const matCache = new Map();
function stdMat(color, opts = {}) {
  const key = `${color}|${JSON.stringify(opts)}`;
  if (!matCache.has(key)) {
    matCache.set(key, new THREE.MeshStandardMaterial({
      color, roughness: opts.roughness ?? 0.45, metalness: opts.metalness ?? 0.35,
      emissive: opts.emissive ?? 0x000000, emissiveIntensity: opts.emissiveIntensity ?? 0,
      flatShading: opts.flatShading ?? false,
    }));
  }
  return matCache.get(key);
}

export class Vehicle {
  constructor(scene, type, x, z, heading = 0, opts = {}) {
    const spec = VEHICLE_CLASSES[type] ?? VEHICLE_CLASSES.sedan;
    this.scene = scene;
    this.type = type;
    this.spec = spec;
    this.label = spec.label;
    this.pos = new THREE.Vector3(x, 0, z);
    this.heading = heading;
    this.vel = new THREE.Vector3();   // world velocity
    this.speed = 0;                   // signed forward speed
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.handbrake = false;
    this.health = spec.health;
    this.maxHealth = spec.health;
    this.wrecked = false;
    this.occupied = false;         // driven by the player
    this.ai = null;                // ai driver state, set by traffic/police
    this.crashCooldown = 0;
    this.smokeTimer = 0;
    this.skidTimer = 0;
    this.braking = false;
    this.spin = 0;
    this.bodyRoll = 0;
    this.lightMode = 'auto';       // auto | red | blue | off
    this.lightPhase = 0;
    this.color = opts.color ?? spec.body;
    this.group = new THREE.Group();
    this.group.position.copy(this.pos);
    this.group.rotation.y = heading;
    scene.add(this.group);
    this._build(type, spec);
    this.wheels = this._wheels;
  }

  _build(type, spec) {
    const g = this.group;
    const L = spec.length, W = spec.width, H = spec.height;
    const bodyMat = stdMat(this.color, { roughness: 0.34, metalness: 0.42 });
    const sillMat = stdMat(0x151719, { roughness: 0.8, metalness: 0.2 });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x1d2c38, roughness: 0.12, metalness: 0.65, transparent: true, opacity: 0.86,
    });
    const chromeMat = stdMat(0xd8dde2, { roughness: 0.25, metalness: 0.9 });

    // Three-layer body: dark sill, painted shoulder, roof/cabin.
    const sill = new THREE.Mesh(new THREE.BoxGeometry(W * 0.98, 0.26, L * 0.96), sillMat);
    sill.position.y = WHEEL_R * 0.55;
    sill.castShadow = true;
    g.add(sill);

    const shoulderH = type === 'truck' ? H * 0.5 : H * 0.44;
    const shoulder = new THREE.Mesh(new THREE.BoxGeometry(W, shoulderH, L), bodyMat);
    shoulder.position.y = WHEEL_R * 0.55 + 0.13 + shoulderH / 2;
    shoulder.castShadow = true;
    shoulder.receiveShadow = true;
    g.add(shoulder);
    this.bodyMesh = shoulder;

    const cabinH = type === 'truck' ? H * 0.28 : H * 0.3;
    const cabinLen = L * (type === 'truck' ? 0.34 : 0.5);
    const cabinZ = type === 'truck' ? -L * 0.3 : -L * 0.02;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(W * 0.9, cabinH, cabinLen), glassMat);
    cabin.position.set(0, shoulder.position.y + shoulderH / 2 + cabinH / 2 - 0.02, cabinZ);
    cabin.castShadow = true;
    g.add(cabin);

    const roof = new THREE.Mesh(new THREE.BoxGeometry(W * 0.94, 0.14, cabinLen * 0.94), bodyMat);
    roof.position.set(0, cabin.position.y + cabinH / 2 + 0.05, cabinZ);
    roof.castShadow = true;
    g.add(roof);

    // Bumpers.
    const bumperMat = stdMat(0x2a2d31, { roughness: 0.6, metalness: 0.4 });
    for (const zSign of [1, -1]) {
      const bumper = new THREE.Mesh(new THREE.BoxGeometry(W * 0.96, 0.22, 0.34), bumperMat);
      bumper.position.set(0, WHEEL_R * 0.55 + 0.08, zSign * (L / 2 - 0.06));
      g.add(bumper);
    }
    // Front grille strip to read the nose.
    const grille = new THREE.Mesh(new THREE.BoxGeometry(W * 0.7, 0.16, 0.1), chromeMat);
    grille.position.set(0, shoulder.position.y - shoulderH * 0.1, L / 2 + 0.02);
    g.add(grille);

    if (type === 'truck') {
      const boxH = H * 0.62;
      const cargo = new THREE.Mesh(
        new THREE.BoxGeometry(W * 1.02, boxH, L * 0.55),
        stdMat(0xe9e3d5, { roughness: 0.8, metalness: 0.1 }),
      );
      cargo.position.set(0, WHEEL_R * 0.55 + 0.2 + boxH / 2, L * 0.16);
      cargo.castShadow = true;
      cargo.receiveShadow = true;
      g.add(cargo);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(W * 1.03, 0.3, L * 0.555), stdMat(0xc2522f, { roughness: 0.7 }));
      stripe.position.set(0, WHEEL_R * 0.55 + 0.55, L * 0.16);
      g.add(stripe);
    }

    if (type === 'taxi') {
      const sign = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, 0.28, 0.36),
        new THREE.MeshStandardMaterial({ color: 0xffe9a8, emissive: 0xffc53d, emissiveIntensity: 1.4, roughness: 0.4 }),
      );
      sign.position.set(0, roof.position.y + 0.2, cabinZ);
      g.add(sign);
      this.taxiSign = sign;
      // Checker band, the quickest way to read "taxi" at distance.
      const band = new THREE.Mesh(new THREE.BoxGeometry(W * 1.005, 0.16, L * 0.9), stdMat(0x1b1b1b, { roughness: 0.8 }));
      band.position.y = shoulder.position.y - shoulderH * 0.18;
      g.add(band);
    }

    if (type === 'police') {
      // White band around the doors, exactly the classic cruiser read.
      const bandMat = stdMat(0xf2f4f8, { roughness: 0.4, metalness: 0.3 });
      const band = new THREE.Mesh(new THREE.BoxGeometry(W * 1.004, shoulderH * 0.42, L * 0.72), bandMat);
      band.position.set(0, shoulder.position.y, 0);
      g.add(band);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(W * 1.006, 0.1, L * 0.73), stdMat(0x101a30, { roughness: 0.5 }));
      stripe.position.set(0, shoulder.position.y - shoulderH * 0.24, 0);
      g.add(stripe);
      this._buildLightBar(g, roof, cabinZ, W);
    }

    // Wheels with hubs. The front pair steers.
    const wheelGeo = geo('wheel', () => new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.28, 12));
    const hubGeo = geo('hub', () => new THREE.CylinderGeometry(WHEEL_R * 0.46, WHEEL_R * 0.46, 0.3, 8));
    const tyreMat = stdMat(0x181a1c, { roughness: 0.95, metalness: 0.02 });
    const hubMat = stdMat(0xb9c0c6, { roughness: 0.3, metalness: 0.8 });
    this._wheels = [];
    const wx = W / 2 - 0.1;
    const wz = L / 2 - (type === 'truck' ? 1.4 : 0.95);
    const positions = [[-wx, wz, true], [wx, wz, true], [-wx, -wz, false], [wx, -wz, false]];
    for (const [x, z, steers] of positions) {
      const pivot = new THREE.Group();
      pivot.position.set(x, WHEEL_R, z);
      const wheel = new THREE.Mesh(wheelGeo, tyreMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.castShadow = true;
      const hub = new THREE.Mesh(hubGeo, hubMat);
      hub.rotation.z = Math.PI / 2;
      wheel.add(hub);
      pivot.add(wheel);
      g.add(pivot);
      this._wheels.push({ pivot, wheel, steers });
    }

    // Headlight lenses + soft glow cards + short dim beam cones + a road pool.
    const lensMat = new THREE.MeshStandardMaterial({ color: 0xfffdf2, emissive: 0xfff0c0, emissiveIntensity: 0.9, roughness: 0.25 });
    this.headlightMats = [lensMat];
    const glowMat = new THREE.MeshBasicMaterial({
      map: softGlowTexture(), color: 0xfff0c4, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.5,
    });
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0xffeec0, transparent: true, opacity: 0.055,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const poolMat = new THREE.MeshBasicMaterial({
      map: softGlowTexture(), color: 0xffe9b0, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.14,
    });
    this.headlightGlowMat = glowMat;
    this.beamMat = beamMat;
    this.poolMat = poolMat;

    for (const side of [-1, 1]) {
      const lens = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.2, 0.1), lensMat);
      lens.position.set(side * (W * 0.32), WHEEL_R * 0.55 + 0.34, L / 2 + 0.02);
      g.add(lens);

      const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 1.9), glowMat);
      glow.position.set(side * (W * 0.32), WHEEL_R * 0.55 + 0.34, L / 2 + 0.16);
      g.add(glow);

      const beam = new THREE.Mesh(new THREE.ConeGeometry(1.5, 9, 10, 1, true), beamMat);
      beam.rotation.x = Math.PI / 2;
      beam.position.set(side * (W * 0.28), WHEEL_R * 0.55 + 0.3, L / 2 + 4.6);
      g.add(beam);
    }
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(8, 12), poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(0, 0.06, L / 2 + 4.2);
    g.add(pool);

    // Tail lamps that flare red under braking.
    this.tailMat = new THREE.MeshStandardMaterial({ color: 0xff5533, emissive: 0xff2211, emissiveIntensity: 0.7, roughness: 0.35 });
    for (const side of [-1, 1]) {
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.18, 0.1), this.tailMat);
      tail.position.set(side * (W * 0.32), WHEEL_R * 0.55 + 0.36, -L / 2 - 0.02);
      g.add(tail);
    }
    this.tailGlowMat = new THREE.MeshBasicMaterial({
      map: softGlowTexture(), color: 0xff3a22, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0,
    });
    for (const side of [-1, 1]) {
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), this.tailGlowMat);
      glow.position.set(side * (W * 0.32), WHEEL_R * 0.55 + 0.36, -L / 2 - 0.12);
      glow.rotation.y = Math.PI;
      g.add(glow);
    }
  }

  _buildLightBar(g, roof, cabinZ, W) {
    const barY = roof.position.y + 0.28;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(W * 0.62, 0.12, 0.34), stdMat(0x24282c, { roughness: 0.6 }));
    bar.position.set(0, barY, cabinZ);
    g.add(bar);
    this.redLens = new THREE.MeshStandardMaterial({ color: 0xff5555, emissive: 0xff1a1a, emissiveIntensity: 1.6, roughness: 0.3 });
    this.blueLens = new THREE.MeshStandardMaterial({ color: 0x6688ff, emissive: 0x1133ff, emissiveIntensity: 1.6, roughness: 0.3 });
    const lensGeo = new THREE.BoxGeometry(W * 0.26, 0.1, 0.28);
    const left = new THREE.Mesh(lensGeo, this.redLens);
    left.position.set(-W * 0.15, barY + 0.1, cabinZ);
    g.add(left);
    const right = new THREE.Mesh(lensGeo, this.blueLens);
    right.position.set(W * 0.15, barY + 0.1, cabinZ);
    g.add(right);

    this.haloRed = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 10, 8),
      new THREE.MeshBasicMaterial({ color: PALETTE.redLight, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.haloRed.position.set(-W * 0.15, barY + 0.16, cabinZ);
    g.add(this.haloRed);
    this.haloBlue = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 10, 8),
      new THREE.MeshBasicMaterial({ color: PALETTE.blueLight, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.haloBlue.position.set(W * 0.15, barY + 0.16, cabinZ);
    g.add(this.haloBlue);

    this.spillMat = new THREE.MeshBasicMaterial({
      map: softGlowTexture(), color: 0xff2244, transparent: true, opacity: 0.22,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.spill = new THREE.Mesh(new THREE.PlaneGeometry(W * 3.4, W * 4.2), this.spillMat);
    this.spill.rotation.x = -Math.PI / 2;
    this.spill.position.y = 0.08;
    g.add(this.spill);

    this.policeLight = new THREE.PointLight(0xff3355, 0.0, 22, 2);
    this.policeLight.position.set(0, barY + 0.4, cabinZ);
    g.add(this.policeLight);
  }

  get length() { return this.spec.length; }
  get width() { return this.spec.width; }

  /** A point in car-local space -> world. */
  localToWorld(lx, lz, out = new THREE.Vector3()) {
    const s = Math.sin(this.heading), c = Math.cos(this.heading);
    return out.set(this.pos.x + lx * c + lz * s, 0, this.pos.z - lx * s + lz * c);
  }

  damage(amount, from) {
    if (this.wrecked) return 0;
    const before = this.health;
    this.health = clamp(this.health - amount, 0, this.maxHealth);
    if (this.health <= 0) {
      this.health = 0;
      this.wrecked = true;
    }
    return before - this.health;
  }

  setLightMode(mode) { this.lightMode = mode; }

  applyPhysics(dt, world, opts = {}) {
    if (this.wrecked) { this.throttle = 0; this.brake = 1; }

    const spec = this.spec;
    const forward = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    const right = new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading));

    let vF = this.vel.dot(forward);
    let vR = this.vel.dot(right);

    // Engine / brake along the nose axis.
    const throttle = clamp(this.throttle, 0, 1);
    const reverse = clamp(-this.throttle, 0, 1);
    const accel = spec.accel * (this.wrecked ? 0.1 : 1);
    if (throttle > 0.01) {
      vF += accel * throttle * dt * (vF < 0 ? 2.0 : 1.0);
    }
    if (reverse > 0.01) {
      if (vF > 0.5) vF -= accel * 1.35 * reverse * dt;
      else vF -= accel * 0.72 * reverse * dt;
    }
    this.braking = this.brake > 0.3 && vF > 0.2;
    if (this.brake > 0.01) {
      const drag = this.brake * 26 * dt;
      if (vF > 0) vF = Math.max(0, vF - drag);
      else vF = Math.min(0, vF + drag);
    }
    // Rolling resistance and a hard top speed clamp, forward and reverse.
    vF *= 1 - 0.55 * dt;
    const top = spec.topSpeed * (this.wrecked ? 0.25 : 1);
    vF = clamp(vF, -spec.reverseSpeed, top);
    if (Math.abs(vF) < 0.03 && throttle < 0.01 && reverse < 0.01) vF = 0;

    // Steering: weaker with speed, reversed in reverse, and stronger with handbrake.
    const speedAbs = Math.abs(vF);
    const speedFactor = 1 / (1 + speedAbs * 0.045);
    const dirSign = vF < -0.4 ? -1 : 1;
    const targetSteer = clamp(this.steer, -1, 1);
    const turnRate = spec.turn * speedFactor * dirSign * (this.handbrake ? 1.35 : 1);
    if (speedAbs > 0.35) {
      this.heading += targetSteer * turnRate * dt * clamp(speedAbs / 6, 0.25, 1.2);
    }

    // Lateral grip: bleed sideways slide away, less when handbraking or on low grip.
    const gripRate = this.handbrake ? spec.grip * 0.28 : spec.grip;
    vR *= Math.exp(-gripRate * dt);

    // Rebuild world velocity from the new axes.
    const nf = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    const nr = new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading));
    this.vel.copy(nf).multiplyScalar(vF).addScaledVector(nr, vR);

    // Integrate.
    this.pos.addScaledVector(this.vel, dt);
    this.speed = vF;

    // Body roll + pitch for weight.
    const rollTarget = clamp(-vR * 0.02 + targetSteer * speedAbs * 0.0035, -0.12, 0.12);
    this.bodyRoll = damp(this.bodyRoll, rollTarget, 8, dt);

    // Four-point collision probe against the city.
    const halfL = spec.length / 2;
    const halfW = spec.width / 2;
    const probes = [
      [-halfW * 0.85, halfL * 0.92], [halfW * 0.85, halfL * 0.92],
      [-halfW * 0.85, -halfL * 0.92], [halfW * 0.85, -halfL * 0.92],
    ];
    let worst = 0;
    let hitNormal = null;
    for (const [lx, lz] of probes) {
      const p = this.localToWorld(lx, lz);
      if (world.isBlocked(p.x, p.z, 0.2)) {
        // Find the escape direction by sampling the local frame.
        const back = this.localToWorld(lx * 1.4, lz * 1.4);
        const dx = p.x - this.pos.x, dz = p.z - this.pos.z;
        const len = Math.hypot(dx, dz) || 1;
        hitNormal = new THREE.Vector3(dx / len, 0, dz / len);
        worst = Math.max(worst, 0.9);
        // Push the whole car back toward its centre.
        this.pos.addScaledVector(hitNormal, -1.05);
        break;
      }
    }
    if (worst > 0) {
      const impact = Math.abs(vF) + Math.abs(vR);
      // Bounce: kill the into-wall component, keep a little slide.
      if (hitNormal) {
        const into = this.vel.dot(hitNormal);
        if (into > 0) this.vel.addScaledVector(hitNormal, -into * 1.45);
        this.vel.multiplyScalar(0.62);
      }
      if (impact > 3.2 && this.crashCooldown <= 0) {
        const dmg = clamp((impact - 3.0) * 1.5, 0, 46);
        this.damage(dmg);
        this.crashCooldown = 0.42;
        this.lastCrash = { x: this.pos.x, z: this.pos.z, speed: impact };
        if (opts.onCrash) opts.onCrash(this, impact, dmg);
      }
      // Knock over small props we ran into.
      for (const prop of world.props) {
        if (!prop.alive || prop.tipped) continue;
        if (prop.kind === 'palm' || prop.kind === 'lamp') continue;
        const d = Math.hypot(this.pos.x - prop.x, this.pos.z - prop.z);
        if (d < halfL + 1.6) {
          world.knockProp(prop, this.vel.x, this.vel.z, clamp(impact / 14, 0.3, 1.4));
        }
      }
    }
    if (this.crashCooldown > 0) this.crashCooldown -= dt;

    // Parked speckle: keep the car glued to the ground.
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.heading;
    this.group.rotation.z = this.bodyRoll;
  }

  /** Visual step: wheels, lights, tail flare, smoke, skid marks, light bar. */
  stepVisuals(dt, manager) {
    const speedAbs = Math.abs(this.speed);
    const spinRate = (this.speed / WHEEL_R) * dt;
    for (const w of this._wheels) {
      w.wheel.rotation.x += spinRate;
      if (w.steers) w.pivot.rotation.y = clamp(this.steer, -1, 1) * 0.44;
    }

    // Brake flare.
    const brakeK = this.braking || (this.speed < -0.2) ? 1 : 0.35;
    if (this.tailMat) this.tailMat.emissiveIntensity = damp(this.tailMat.emissiveIntensity, 0.7 + brakeK * 3.2, 12, dt);
    if (this.tailGlowMat) this.tailGlowMat.opacity = damp(this.tailGlowMat.opacity, brakeK * 0.75, 12, dt);

    // Headlight brightness: dimmer by day, strong at night.
    const nightK = manager?.world ? manager.world.baseGlow : 0;
    if (this.headlightMats) {
      for (const m of this.headlightMats) m.emissiveIntensity = 0.7 + nightK * 2.2;
    }
    if (this.headlightGlowMat) this.headlightGlowMat.opacity = 0.18 + nightK * 0.55;
    if (this.beamMat) this.beamMat.opacity = 0.02 + nightK * 0.075;
    if (this.poolMat) this.poolMat.opacity = 0.04 + nightK * 0.24;

    // Police light bar.
    if (this.type === 'police' && this.redLens) {
      const mode = this.lightMode;
      this.lightPhase += dt;
      let redOn = false, blueOn = false;
      if (mode === 'red') redOn = true;
      else if (mode === 'blue') blueOn = true;
      else if (mode === 'auto') {
        const phase = (this.lightPhase * 3.0) % 1;
        redOn = phase < 0.5;
        blueOn = !redOn;
      }
      this.redLens.emissiveIntensity = redOn ? 4.2 : 0.15;
      this.blueLens.emissiveIntensity = blueOn ? 4.2 : 0.15;
      if (this.haloRed) this.haloRed.material.opacity = redOn ? 0.85 : 0.06;
      if (this.haloBlue) this.haloBlue.material.opacity = blueOn ? 0.85 : 0.06;
      if (this.spillMat) {
        this.spillMat.color.setHex(redOn ? PALETTE.redLight : PALETTE.blueLight);
        this.spillMat.opacity = redOn || blueOn ? 0.28 : 0;
      }
      if (this.policeLight) {
        this.policeLight.color.setHex(redOn ? PALETTE.redLight : PALETTE.blueLight);
        this.policeLight.intensity = redOn || blueOn ? 2.6 : 0;
      }
    }

    // Sliding: skid marks + dust.
    if (manager && speedAbs > 6) {
      const lateral = Math.abs(this.vel.dot(new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading))));
      this.skidTimer -= dt;
      if ((lateral > 3.4 || this.handbrake) && this.skidTimer <= 0) {
        this.skidTimer = 0.035;
        manager.emitSkid(this);
      }
      this.smokeTimer -= dt;
      if (this.smokeTimer <= 0) {
        this.smokeTimer = this.wrecked ? 0.07 : 0.24;
        if (this.wrecked || this.health < this.maxHealth * 0.45) manager.emitSmoke(this, this.wrecked ? 1 : 0.55);
      }
    }
    if (this.wrecked) {
      this.smokeTimer -= dt;
      if (this.smokeTimer <= 0) { this.smokeTimer = 0.08; manager?.emitSmoke(this, 1); }
    }
  }

  /** Reset everything a scripted staging needs to re-pose this car. */
  place(x, z, heading = this.heading) {
    this.pos.set(x, 0, z);
    this.heading = heading;
    this.vel.set(0, 0, 0);
    this.speed = 0;
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.group.position.copy(this.pos);
    this.group.rotation.set(0, heading, 0);
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.isMesh && o.geometry && !Object.values(sharedGeo).includes(o.geometry)) {
        // Only dispose geometry we created per-instance; shared geos live on.
      }
    });
    this.alive = false;
  }
}

// ---------------------------------------------------------------- manager

export class VehicleManager {
  constructor(scene, world, audio, hooks = {}) {
    this.scene = scene;
    this.world = world;
    this.audio = audio;
    this.hooks = hooks;
    this.vehicles = [];
    this.smoke = [];
    this.skids = [];
    this.rng = seeded(world.seed, 909);
    this._buildPools();
  }

  _buildPools() {
    const smokeMat = new THREE.MeshBasicMaterial({
      map: softGlowTexture(), color: PALETTE.smoke, transparent: true,
      depthWrite: false, opacity: 0.4,
    });
    this.smokeGeo = new THREE.PlaneGeometry(1, 1);
    this.smokeMat = smokeMat;
    this.smokePool = [];
    for (let i = 0; i < 64; i += 1) {
      const m = new THREE.Mesh(this.smokeGeo, smokeMat.clone());
      m.visible = false;
      m.renderOrder = 3;
      this.scene.add(m);
      this.smokePool.push({ mesh: m, life: 0, max: 1, vy: 0, vx: 0, vz: 0, scale: 1 });
    }

    const skidMat = new THREE.MeshBasicMaterial({
      color: PALETTE.skid, transparent: true, opacity: 0.5, depthWrite: false,
    });
    this.skidMat = skidMat;
    this.skidGeo = new THREE.PlaneGeometry(0.3, 1.0);
    this.skidPool = [];
    for (let i = 0; i < 220; i += 1) {
      const m = new THREE.Mesh(this.skidGeo, skidMat);
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      m.renderOrder = 2;
      this.scene.add(m);
      this.skidPool.push({ mesh: m, life: 0 });
    }
  }

  emitSmoke(car, strength) {
    const slot = this.smokePool.find((s) => s.life <= 0);
    if (!slot) return;
    const p = car.localToWorld(0, -car.spec.length * 0.3);
    slot.mesh.position.set(p.x + this.rng.range(-0.4, 0.4), 0.7, p.z + this.rng.range(-0.4, 0.4));
    slot.life = slot.max = 0.8 + this.rng.float() * 0.7;
    slot.vy = 1.1 + this.rng.float();
    slot.vx = this.rng.range(-0.5, 0.5);
    slot.vz = this.rng.range(-0.5, 0.5);
    slot.scale = 0.7 + strength * 1.4;
    slot.mesh.visible = true;
    slot.mesh.material.opacity = 0.34 * strength;
    slot.mesh.scale.setScalar(slot.scale);
  }

  emitSkid(car) {
    const rear = car.localToWorld(0, -car.spec.length * 0.36);
    for (const side of [-1, 1]) {
      const slot = this.skidPool.find((s) => s.life <= 0);
      if (!slot) return;
      const p = car.localToWorld(side * car.spec.width * 0.38, -car.spec.length * 0.36);
      slot.mesh.position.set(p.x, 0.035, p.z);
      slot.mesh.rotation.z = -car.heading;
      slot.mesh.scale.set(1, 1.6, 1);
      slot.mesh.visible = true;
      slot.mesh.material.opacity = 0.45;
      slot.life = 9;
    }
  }

  spawn(type, x, z, heading = 0, opts = {}) {
    const car = new Vehicle(this.scene, type, x, z, heading, opts);
    this.vehicles.push(car);
    return car;
  }

  remove(car) {
    if (!car || !car.alive) return;
    car.dispose();
    const i = this.vehicles.indexOf(car);
    if (i >= 0) this.vehicles.splice(i, 1);
  }

  clearAll() {
    for (const car of [...this.vehicles]) car.dispose();
    this.vehicles.length = 0;
  }

  nearest(x, z, filter = null) {
    let best = null, bestD = Infinity;
    for (const car of this.vehicles) {
      if (filter && !filter(car)) continue;
      const d = (car.pos.x - x) ** 2 + (car.pos.z - z) ** 2;
      if (d < bestD) { bestD = d; best = car; }
    }
    return best ? { car: best, distance: Math.sqrt(bestD) } : null;
  }

  playerDrivingStep(player, input, dt) {
    const car = player.car;
    if (!car) return;
    if (car.wrecked) {
      car.throttle = 0; car.brake = 1;
      if (this.hooks.onWrecked) this.hooks.onWrecked(car);
      return;
    }
    const fwd = input.down('forward') ? 1 : 0;
    const back = input.down('back') ? 1 : 0;
    car.throttle = fwd ? 1 : back ? -0.85 : 0;
    car.brake = 0;
    car.handbrake = input.down('sprint');
    if (car.handbrake && Math.abs(car.speed) > 2) car.brake = 0.25;
    const steerTarget = (input.down('right') ? 1 : 0) - (input.down('left') ? 1 : 0);
    car.steer = damp(car.steer, steerTarget, 9, dt);
    car.applyPhysics(dt, this.world, {
      onCrash: (c, impact, dmg) => {
        this.hooks.onCrash?.(c, impact, dmg);
        if (impact > 4) {
          this.audio?.crash(clamp(impact / 26, 0, 1));
          this.hooks.onCameraShake?.(clamp(impact / 30, 0.1, 0.9));
        }
      },
    });
    car.stepVisuals(dt, this);
    this.pushApart(car);
  }

  /** AI-driven car (traffic / police): the ai object supplies throttle/steer/brake. */
  aiStep(car, dt, ai) {
    car.throttle = ai.throttle ?? 0;
    car.brake = ai.brake ?? 0;
    car.handbrake = !!ai.handbrake;
    car.steer = ai.steer ?? 0;
    car.applyPhysics(dt, this.world, {
      onCrash: (c, impact) => {
        if (impact > 9) this.audio?.crash(clamp(impact / 30, 0, 0.8));
        this.hooks.onCrash?.(c, impact, impact);
      },
    });
  }

  coastStep(car, dt) {
    // Parked / abandoned cars still settle, roll down slopes in spirit: friction only.
    car.throttle = 0;
    car.brake = 0.35;
    car.steer *= 1 - 3 * dt;
    car.applyPhysics(dt, this.world, {});
  }

  /** Cars push each other apart and damage each other on hard hits. */
  pushApart(source = null) {
    const list = this.vehicles;
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j += 1) {
        const b = list[j];
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const d = Math.hypot(dx, dz);
        const min = (a.spec.length + b.spec.length) * 0.36;
        if (d > 1e-4 && d < min) {
          const push = (min - d) * 0.5;
          const nx = dx / d, nz = dz / d;
          const ma = a.spec.mass, mb = b.spec.mass;
          a.pos.x -= nx * push * (mb / (ma + mb)) * 2;
          a.pos.z -= nz * push * (mb / (ma + mb)) * 2;
          b.pos.x += nx * push * (ma / (ma + mb)) * 2;
          b.pos.z += nz * push * (ma / (ma + mb)) * 2;
          if ((a === source || b === source) && d < min * 0.82 && a.crashCooldown <= 0 && b.crashCooldown <= 0) {
            const impact = Math.abs(a.speed - b.speed) + 3;
            const dmg = clamp(impact * 0.9, 2, 28);
            a.damage(dmg * 0.8);
            b.damage(dmg);
            a.crashCooldown = 0.5; b.crashCooldown = 0.5;
            this.hooks.onCrash?.(source ?? a, impact, dmg);
            this.audio?.crash(clamp(impact / 24, 0.1, 0.9));
            this.hooks.onCameraShake?.(clamp(impact / 40, 0.08, 0.6));
          }
          a.group.position.copy(a.pos);
          b.group.position.copy(b.pos);
        }
      }
    }
  }

  updateParticles(dt) {
    for (const s of this.smokePool) {
      if (s.life <= 0) { if (s.mesh.visible) s.mesh.visible = false; continue; }
      s.life -= dt;
      s.mesh.position.y += s.vy * dt;
      s.mesh.position.x += s.vx * dt;
      s.mesh.position.z += s.vz * dt;
      const t = 1 - s.life / s.max;
      s.mesh.scale.setScalar(s.scale * (1 + t * 2.2));
      s.mesh.material.opacity = Math.max(0, 0.34 * (1 - t));
      if (s.mesh.isMesh) s.mesh.quaternion.copy(this.camQuat ?? s.mesh.quaternion);
      if (s.life <= 0) s.mesh.visible = false;
    }
    for (const k of this.skidPool) {
      if (k.life <= 0) { if (k.mesh.visible) k.mesh.visible = false; continue; }
      k.life -= dt;
      k.mesh.material.opacity = clamp(k.life / 12, 0, 0.45);
      if (k.life <= 0) k.mesh.visible = false;
    }
  }

  update(dt) {
    this.updateParticles(dt);
  }
}
