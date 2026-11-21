// The player on foot: an articulated box figure in a bright yellow jacket, a walk/sprint/jump
// cycle, fists and a pistol with a 12-round magazine, camera-relative movement and a city
// resolver that keeps him out of walls. While driving the figure hides and rides the car.

import * as THREE from 'three';
import { PLAYER, PALETTE, CITY } from './config.js';
import { clamp, damp, wrapAngle, lerp, TAU } from './random.js';
import { softGlowTexture } from './world.js';

const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({
  color, roughness: opts.roughness ?? 0.7, metalness: opts.metalness ?? 0.06,
  emissive: opts.emissive ?? 0x000000, emissiveIntensity: opts.emissiveIntensity ?? 0,
});

export class Player {
  constructor(scene, world, audio) {
    this.scene = scene;
    this.world = world;
    this.audio = audio;
    this.pos = new THREE.Vector3(150, 0, -150);
    this.vel = new THREE.Vector3();
    this.heading = Math.PI;
    this.health = PLAYER.health;
    this.cash = 250;
    this.car = null;
    this.weapon = 'pistol';
    this.ammo = PLAYER.magSize;
    this.reserve = PLAYER.reserve;
    this.reloading = 0;
    this.fireCooldown = 0;
    this.punchTimer = 0;
    this.walkPhase = 0;
    this.aiming = false;
    this.onGround = true;
    this.vy = 0;
    this.dead = false;
    this.muzzleTimer = 0;
    this.tracers = [];
    this._build();
  }

  _build() {
    const g = new THREE.Group();
    g.name = 'player';
    const jacket = mat(PALETTE.playerJacket, { roughness: 0.62 });
    const jacketDark = mat(0xe0b32c, { roughness: 0.65 });
    const trousers = mat(0x2b3a4a, { roughness: 0.8 });
    const skin = mat(0xd8a175, { roughness: 0.75 });
    const hair = mat(0x2a1d16, { roughness: 0.85 });
    const shoe = mat(0x1a1c1f, { roughness: 0.85 });
    const gun = mat(0x25282c, { roughness: 0.4, metalness: 0.6 });

    this.hips = new THREE.Group();
    this.hips.position.y = 0.92;
    g.add(this.hips);

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.72, 0.36), jacket);
    torso.position.y = 0.36;
    torso.castShadow = true;
    this.hips.add(torso);
    // Jacket zip line, so the yellow reads as clothing and not a box.
    const zip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.7, 0.02), jacketDark);
    zip.position.set(0, 0.36, 0.185);
    this.hips.add(zip);

    const hipsMesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.24, 0.32), trousers);
    hipsMesh.position.y = -0.02;
    hipsMesh.castShadow = true;
    this.hips.add(hipsMesh);

    this.head = new THREE.Group();
    this.head.position.y = 0.82;
    this.hips.add(this.head);
    const skull = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.32), skin);
    skull.castShadow = true;
    this.head.add(skull);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.37, 0.13, 0.35), hair);
    cap.position.y = 0.16;
    this.head.add(cap);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.05, 0.03), mat(0x33241b));
    brow.position.set(0, 0.04, 0.17);
    this.head.add(brow);

    // Arms as pivoted groups hanging from the shoulders.
    this.armL = this._limb(0.16, 0.6, jacket, skin, -0.4, 0.62, 'arm');
    this.armR = this._limb(0.16, 0.6, jacket, skin, 0.4, 0.62, 'arm');
    this.legL = this._limb(0.2, 0.82, trousers, shoe, -0.16, -0.02, 'leg');
    this.legR = this._limb(0.2, 0.82, trousers, shoe, 0.16, -0.02, 'leg');

    // Pistol in the right hand.
    this.gun = new THREE.Group();
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 0.42), gun);
    barrel.position.z = 0.16;
    this.gun.add(barrel);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.1), gun);
    grip.position.set(0, -0.13, 0.02);
    grip.rotation.x = -0.18;
    this.gun.add(grip);
    this.gun.position.set(0, -0.5, 0.08);
    this.armR.add(this.gun);
    this.gun.visible = false;

    this.muzzle = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xfff0b0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.muzzle.position.set(0, 0, 0.4);
    this.gun.add(this.muzzle);
    this.muzzleLight = new THREE.PointLight(0xffcf7a, 0, 14, 2);
    this.muzzleLight.position.set(0, 0, 0.5);
    this.gun.add(this.muzzleLight);

    // Contact shadow blob keeps the figure planted on asphalt.
    this.blob = new THREE.Mesh(
      new THREE.CircleGeometry(0.62, 16),
      new THREE.MeshBasicMaterial({ map: softGlowTexture(), color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.position.y = 0.03;
    g.add(this.blob);

    this.group = g;
    this.group.position.copy(this.pos);
    this.scene.add(g);
  }

  _limb(w, len, upperMat, lowerMat, x, y, kind) {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const upper = new THREE.Mesh(new THREE.BoxGeometry(w, len * 0.55, w), upperMat);
    upper.position.y = -len * 0.275;
    upper.castShadow = true;
    pivot.add(upper);
    const joint = new THREE.Group();
    joint.position.y = -len * 0.55;
    pivot.add(joint);
    const lower = new THREE.Mesh(
      new THREE.BoxGeometry(w * (kind === 'leg' ? 0.92 : 0.85), len * 0.45, w * 0.92),
      lowerMat === undefined ? upperMat : (kind === 'leg' ? upperMat : lowerMat),
    );
    lower.position.y = -len * 0.225;
    lower.castShadow = true;
    joint.add(lower);
    if (kind === 'leg') {
      const foot = new THREE.Mesh(new THREE.BoxGeometry(w * 0.95, 0.14, w * 1.7), lowerMat);
      foot.position.set(0, -len * 0.44, 0.09);
      foot.castShadow = true;
      joint.add(foot);
    } else {
      const hand = new THREE.Mesh(new THREE.BoxGeometry(w * 0.85, 0.14, w * 0.9), lowerMat);
      hand.position.y = -len * 0.47;
      joint.add(hand);
    }
    this.hips.add(pivot);
    return pivot;
  }

  get radius() { return PLAYER.radius; }
  get driving() { return !!this.car; }

  teleport(x, z, heading = this.heading) {
    this.pos.set(x, 0, z);
    this.heading = heading;
    this.vel.set(0, 0, 0);
    this.vy = 0;
    if (this.car) this.car.place(x, z, heading);
    this.group.position.set(x, 0, z);
  }

  setWeapon(name) {
    if (name !== 'pistol' && name !== 'fists') return;
    this.weapon = name;
    this.gun.visible = name === 'pistol' && !this.driving && this.aiming;
  }

  startReload() {
    if (this.weapon !== 'pistol' || this.reloading > 0 || this.ammo >= PLAYER.magSize || this.reserve <= 0) return false;
    this.reloading = PLAYER.reloadTime;
    return true;
  }

  /** Returns a shot descriptor when a round leaves the barrel this frame. */
  tryFire() {
    if (this.weapon !== 'pistol' || this.reloading > 0 || this.fireCooldown > 0) return null;
    if (this.ammo <= 0) { this.startReload(); return null; }
    this.ammo -= 1;
    this.fireCooldown = 60 / PLAYER.rpm;
    this.muzzleTimer = 0.06;
    this.muzzle.material.opacity = 1;
    this.muzzleLight.intensity = 4;
    this.audio?.gunshot();
    const dirX = Math.sin(this.heading), dirZ = Math.cos(this.heading);
    const origin = new THREE.Vector3(this.pos.x + dirX * 0.6, 1.35, this.pos.z + dirZ * 0.6);
    this._addTracer(origin, new THREE.Vector3(this.pos.x + dirX * 40, 1.2, this.pos.z + dirZ * 40));
    if (this.ammo === 0) this.startReload();
    return { x: this.pos.x, z: this.pos.z, dirX, dirZ, range: PLAYER.bulletRange, cone: PLAYER.aimCone };
  }

  _addTracer(from, to) {
    const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.85 }));
    this.scene.add(line);
    this.tracers.push({ line, life: 0.09 });
  }

  punch() {
    if (this.punchTimer > 0 || this.driving) return false;
    this.punchTimer = 0.3;
    this.audio?.punch();
    return true;
  }

  enterCar(car) {
    if (!car || car.wrecked || this.car) return false;
    this.car = car;
    car.occupied = true;
    car.ai = null;
    this.group.visible = false;
    this.blob.visible = false;
    return true;
  }

  exitCar() {
    if (!this.car) return null;
    const car = this.car;
    car.occupied = false;
    // Step out beside the driver's door.
    const side = new THREE.Vector3(Math.cos(car.heading), 0, -Math.sin(car.heading));
    const pos = new THREE.Vector3(car.pos.x + side.x * (car.spec.width / 2 + 0.9), 0, car.pos.z + side.z * (car.spec.width / 2 + 0.9));
    this.world.resolveCircle(pos, PLAYER.radius);
    this.car = null;
    this.pos.copy(pos);
    this.vel.set(0, 0, 0);
    this.group.visible = true;
    this.blob.visible = true;
    this.group.position.copy(this.pos);
    return car;
  }

  /** Camera-relative movement, jump, resolver, animation. */
  step(dt, input, cameraYaw) {
    if (this.punchTimer > 0) this.punchTimer = Math.max(0, this.punchTimer - dt);
    if (this.fireCooldown > 0) this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    if (this.reloading > 0) {
      this.reloading = Math.max(0, this.reloading - dt);
      if (this.reloading === 0) {
        const need = PLAYER.magSize - this.ammo;
        const take = Math.min(need, this.reserve);
        this.ammo += take;
        this.reserve -= take;
      }
    }
    if (this.muzzleTimer > 0) {
      this.muzzleTimer -= dt;
      if (this.muzzleTimer <= 0) {
        this.muzzle.material.opacity = 0;
        this.muzzleLight.intensity = 0;
      }
    }
    for (let i = this.tracers.length - 1; i >= 0; i -= 1) {
      const t = this.tracers[i];
      t.life -= dt;
      t.line.material.opacity = Math.max(0, t.life / 0.09) * 0.85;
      if (t.life <= 0) { this.scene.remove(t.line); t.line.geometry.dispose(); t.line.material.dispose(); this.tracers.splice(i, 1); }
    }

    if (this.driving || this.dead) {
      this.aiming = false;
      this.gun.visible = false;
      if (this.driving) {
        this.pos.set(this.car.pos.x, 0, this.car.pos.z);
        this.heading = this.car.heading;
        this.group.position.copy(this.pos);
      }
      return;
    }

    const axis = input.axis();
    const sprinting = input.down('sprint');
    const speed = sprinting ? PLAYER.sprint : PLAYER.walk;

    // Camera-relative: +y is away from the camera.
    const forward = new THREE.Vector3(Math.sin(cameraYaw), 0, Math.cos(cameraYaw));
    const right = new THREE.Vector3(Math.cos(cameraYaw), 0, -Math.sin(cameraYaw));
    const move = new THREE.Vector3()
      .addScaledVector(forward, axis.y)
      .addScaledVector(right, axis.x);
    const moveLen = move.length();
    if (moveLen > 1) move.multiplyScalar(1 / moveLen);

    const targetVX = move.x * speed;
    const targetVZ = move.z * speed;
    const accel = this.onGround ? 18 : 6;
    this.vel.x = damp(this.vel.x, targetVX, accel, dt);
    this.vel.z = damp(this.vel.z, targetVZ, accel, dt);

    if (input.justPressed('jump') && this.onGround) {
      this.vy = PLAYER.jump;
      this.onGround = false;
    }
    this.vy -= PLAYER.gravity * dt;

    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.pos.y += this.vy * dt;
    if (this.pos.y <= 0) { this.pos.y = 0; this.vy = 0; this.onGround = true; }
    this.world.resolveCircle(this.pos, PLAYER.radius);

    // Turn toward motion.
    const planarSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (planarSpeed > 0.4) {
      const want = Math.atan2(this.vel.x, this.vel.z);
      this.heading += wrapAngle(want - this.heading) * Math.min(1, dt * 11);
    }

    // Aim pose when the pistol is the active weapon and the player holds fire.
    this.aiming = this.weapon === 'pistol' && (input.fireDown() || input.justPressed('fire'));
    this.gun.visible = this.aiming;

    this._animate(dt, planarSpeed, sprinting);
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.heading;
    this.blob.position.set(0, 0.03 - this.pos.y, 0);
    this.blob.scale.setScalar(clamp(1 - this.pos.y * 0.08, 0.5, 1));
  }

  _animate(dt, speed, sprinting) {
    const moving = speed > 0.35;
    const cycleRate = sprinting ? 9.6 : 6.4;
    if (moving) this.walkPhase += dt * cycleRate * clamp(speed / (sprinting ? PLAYER.sprint : PLAYER.walk), 0.4, 1.3);
    const swing = moving ? Math.sin(this.walkPhase) * (sprinting ? 0.95 : 0.62) : 0;
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;
    this.hips.position.y = 0.92 + (moving ? Math.abs(Math.sin(this.walkPhase * 2)) * 0.045 : 0);

    if (this.punchTimer > 0) {
      const t = 1 - this.punchTimer / 0.3;
      const jab = Math.sin(t * Math.PI) * 2.0;
      this.armR.rotation.x = -jab;
      this.armR.rotation.z = -0.4 - jab * 0.15;
      this.armL.rotation.x = swing * 0.4;
    } else if (this.aiming) {
      this.armR.rotation.x = -1.45;
      this.armR.rotation.z = 0.12;
      this.armL.rotation.x = -1.2;
      this.armL.rotation.z = -0.25;
    } else {
      this.armR.rotation.x = -swing * 0.8;
      this.armR.rotation.z = 0.12;
      this.armL.rotation.x = swing * 0.8;
      this.armL.rotation.z = -0.12;
    }
    this.torsoLean = moving ? (sprinting ? -0.1 : -0.04) : 0;
    this.hips.rotation.x = damp(this.hips.rotation.x, this.torsoLean, 8, dt);
  }

  hurt(amount) {
    if (this.dead) return;
    this.health = clamp(this.health - amount, 0, 100);
    if (this.health <= 0) {
      this.health = 0;
      this.dead = true;
    }
  }

  heal(amount) { this.health = clamp(this.health + amount, 0, 100); }

  hide() { this.group.visible = false; }
  show() { this.group.visible = !this.driving; this.blob.visible = !this.driving; }

  reset() {
    this.health = PLAYER.health;
    this.dead = false;
    this.vel.set(0, 0, 0);
    this.reloading = 0;
    this.ammo = PLAYER.magSize;
    this.reserve = PLAYER.reserve;
    this.weapon = 'pistol';
    this.car = null;
    this.group.visible = true;
    this.blob.visible = true;
  }
}
