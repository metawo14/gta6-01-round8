// Police and the wanted level. The module never raises stars itself: the game's crime feed calls
// raise(), one step per second at most. From there it spawns cruisers at the map edge, steers them
// at the player with a little lead, rams, and on foot closes in to arrest. Heat decays after a
// quiet spell, and at zero stars every unit despawns.

import * as THREE from 'three';
import { POLICE, CITY, PALETTE } from './config.js';
import { clamp, damp, wrapAngle, seeded, dist, TAU } from './random.js';
import { roadCenter } from './world.js';

const LINES = CITY.grid;

export class PoliceSystem {
  constructor(scene, world, vehicles, player, traffic, audio, hooks = {}) {
    this.scene = scene;
    this.world = world;
    this.vehicles = vehicles;
    this.player = player;
    this.traffic = traffic;
    this.audio = audio;
    this.hooks = hooks;
    this.stars = 0;
    this.units = [];
    this.officers = [];
    this.spawnTimer = 0;
    this.sinceCrime = 999;
    this.sinceStep = 999;
    this.heat = 0;              // 0..1 cosmetic, drives star pulse
    this.arrestTimer = 0;
    this.rng = seeded(world.seed, 777);
    this.lastArrest = 0;
  }

  /** One star step, at most once a second; the only way stars go up. */
  raise(steps = 1) {
    if (this.sinceStep < 1) return false;
    const before = this.stars;
    this.stars = clamp(this.stars + steps, 0, POLICE.maxStars);
    this.sinceStep = 0;
    this.sinceCrime = 0;
    this.heat = Math.max(this.heat, clamp(this.stars / POLICE.maxStars, 0.2, 1));
    if (this.stars > before) {
      this.audio?.wantedUp();
      this.hooks.onWanted?.(this.stars, before);
      return true;
    }
    return false;
  }

  cool(steps = 1) {
    this.stars = clamp(this.stars - steps, 0, POLICE.maxStars);
    if (this.stars === 0) this.despawnAll();
  }

  clear() {
    this.stars = 0;
    this.despawnAll();
    for (const o of this.officers) this.scene.remove(o.group);
    this.officers.length = 0;
    this.arrestTimer = 0;
  }

  despawnAll() {
    for (const unit of this.units) this.vehicles.remove(unit.car);
    this.units.length = 0;
  }

  _edgeSpawnPoint() {
    const rng = this.rng;
    // Prefer the map edge away from the player so units arrive rather than pop in.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const side = rng.int(0, 3);
      const along = rng.range(-CITY.bound + 60, CITY.bound - 60);
      const edge = CITY.bound - 22;
      let x, z;
      if (side === 0) { x = along; z = -edge; }
      else if (side === 1) { x = along; z = edge; }
      else if (side === 2) { x = -edge; z = along; }
      else { x = edge - 40; z = along; }
      if (x > CITY.seaEdge - 60) continue;
      if (this.world.isBlocked(x, z, 3)) continue;
      const d = dist(x, z, this.player.pos.x, this.player.pos.z);
      if (d < 70) continue;
      const heading = Math.atan2(this.player.pos.x - x, this.player.pos.z - z);
      return { x, z, heading };
    }
    const heading = Math.atan2(this.player.pos.x, this.player.pos.z);
    return { x: -CITY.bound + 30, z: -CITY.bound + 30, heading };
  }

  spawnUnit() {
    const spot = this._edgeSpawnPoint();
    const car = this.vehicles.spawn('police', spot.x, spot.z, spot.heading);
    car.localWidth = 0;
    const unit = {
      car, state: 'pursue', ramCooldown: 0, heading: spot.heading,
      stars: this.stars, aggressive: 1 + this.stars * 0.12,
    };
    car.ai = { kind: 'police' };
    this.units.push(unit);
    return unit;
  }

  maxUnitsForStars() {
    if (this.stars <= 0) return 0;
    return Math.min(POLICE.maxUnits, Math.max(1, this.stars * POLICE.perStar - 1));
  }

  _unitStep(unit, dt) {
    const car = unit.car;
    const player = this.player;
    if (car.wrecked) {
      unit.state = 'wrecked';
      car.throttle = 0; car.brake = 1;
      this.vehicles.aiStep(car, dt, { throttle: 0, brake: 1, steer: 0 });
      car.stepVisuals(dt, this.vehicles);
      return;
    }

    // Target: the player's car if driving, else the player on foot.
    const targetX = player.car ? player.car.pos.x : player.pos.x;
    const targetZ = player.car ? player.car.pos.z : player.pos.z;
    const lead = player.car ? 0.32 : 0.1;
    const vx = player.car ? player.car.vel.x : player.vel.x;
    const vz = player.car ? player.car.vel.z : player.vel.z;
    const aimX = targetX + vx * lead;
    const aimZ = targetZ + vz * lead;

    // If the player is on foot and close, park and go on foot.
    const d = dist(car.pos.x, car.pos.z, targetX, targetZ);
    if (!player.car && d < 16 && Math.abs(car.speed) < 3) {
      unit.state = 'deployed';
      this._deployOfficer(car);
    }

    if (unit.state === 'deployed') {
      car.throttle = 0; car.brake = 1;
      this.vehicles.aiStep(car, dt, { throttle: 0, brake: 1, steer: 0 });
      car.stepVisuals(dt, this.vehicles);
      return;
    }

    const wantHeading = Math.atan2(aimX - car.pos.x, aimZ - car.pos.z);
    const err = wrapAngle(wantHeading - car.heading);
    car.ai = car.ai ?? {};
    car.ai.steer = clamp(err * 2.2, -1, 1);
    const speed = Math.abs(car.speed);
    // Ram when close and pointing the right way; otherwise flat out.
    unit.ramCooldown -= dt;
    let throttle = 1;
    if (speed > car.spec.topSpeed * 0.94) throttle = 0.6;
    if (d < 5 && unit.ramCooldown <= 0 && player.car) {
      throttle = 1;
      car.ai.steer = clamp(err * 1.2, -1, 1);
      if (speed > 4) {
        const dmg = 6 + this.stars * 2.4;
        player.car.damage(dmg);
        car.damage(dmg * 0.55);
        unit.ramCooldown = 0.9;
        this.hooks.onRam?.(player.car, dmg);
        this.audio?.crash(0.5);
        this.hooks.onCameraShake?.(0.5);
        this.hooks.onCrash?.(player.car, 14, dmg);
      }
    }
    // Keep the throttle down when the turn is hard so they corner instead of ploughing on.
    if (Math.abs(err) > 1.4 && speed > 12) throttle = 0.35;
    car.ai.throttle = throttle;
    car.ai.brake = 0;

    this.vehicles.aiStep(car, dt, car.ai);
    car.stepVisuals(dt, this.vehicles);

    // Fast units are tougher: heal-scaling gives higher stars more staying power.
    if (this.stars >= 3 && car.health < car.maxHealth * 0.4) car.health = Math.max(car.health, car.maxHealth * 0.4);
  }

  _deployOfficer(car) {
    if (this.officers.some((o) => o.car === car)) return;
    const o = this._makeOfficer(car.pos.x + 1.6, car.pos.z + 0.4, car.heading, car);
    this.officers.push(o);
  }

  _makeOfficer(x, z, heading, car = null) {
    const g = new THREE.Group();
    const uniform = new THREE.MeshStandardMaterial({ color: 0x22315a, roughness: 0.7 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xd8a175, roughness: 0.78 });
    const gear = new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 0.6, metalness: 0.25 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.7, 0.3), uniform);
    body.position.y = 1.05; body.castShadow = true; g.add(body);
    const vest = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.42, 0.32), gear);
    vest.position.y = 1.12; g.add(vest);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.29, 0.29, 0.27), skin);
    head.position.y = 1.53; head.castShadow = true; g.add(head);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.11, 0.3), uniform);
    cap.position.y = 1.66; g.add(cap);
    const legL = new THREE.Group(); legL.position.set(-0.13, 0.72, 0);
    const legR = new THREE.Group(); legR.position.set(0.13, 0.72, 0);
    for (const grp of [legL, legR]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.7, 0.19), gear);
      leg.position.y = -0.35; leg.castShadow = true; grp.add(leg); g.add(grp);
    }
    g.position.set(x, 0, z);
    g.rotation.y = heading;
    this.scene.add(g);
    return { group: g, pos: new THREE.Vector3(x, 0, z), heading, phase: 0, car, speed: 3.4, down: false, downTilt: 0 };
  }

  _officerStep(o, dt) {
    const player = this.player;
    if (o.down) {
      o.downTilt = Math.min(1.5, o.downTilt + dt * 3.2);
      o.group.rotation.x = -o.downTilt;
      return;
    }
    const d = dist(o.pos.x, o.pos.z, player.pos.x, player.pos.z);
    if (!player.car && d > 1.4) {
      const want = Math.atan2(player.pos.x - o.pos.x, player.pos.z - o.pos.z);
      o.heading += wrapAngle(want - o.heading) * Math.min(1, dt * 6);
      const step = o.speed * dt;
      const nx = o.pos.x + Math.sin(o.heading) * step;
      const nz = o.pos.z + Math.cos(o.heading) * step;
      if (!this.world.isBlocked(nx, nz, 0.45)) { o.pos.x = nx; o.pos.z = nz; }
      o.phase += dt * 8;
      o.group.position.set(o.pos.x, Math.abs(Math.sin(o.phase * 2)) * 0.04, o.pos.z);
      o.group.rotation.y = o.heading;
    }
  }

  /** Two static officers for the on-foot staging. */
  placeOfficers(list) {
    for (const o of this.officers) this.scene.remove(o.group);
    this.officers.length = 0;
    for (const spec of list) {
      const o = this._makeOfficer(spec.x, spec.z, spec.heading ?? 0, null);
      o.static = true;
      this.officers.push(o);
    }
  }

  nearestUnitDistance() {
    let best = Infinity;
    for (const u of this.units) {
      const d = dist(u.car.pos.x, u.car.pos.z, this.player.pos.x, this.player.pos.z);
      if (d < best) best = d;
    }
    return best;
  }

  update(dt) {
    this.sinceStep += dt;
    this.sinceCrime += dt;
    this.heat = damp(this.heat, this.stars / POLICE.maxStars, 2, dt);

    const max = this.maxUnitsForStars();
    this.spawnTimer -= dt;
    if (this.stars > 0 && this.units.length < max && this.spawnTimer <= 0) {
      this.spawnUnit();
      this.spawnTimer = POLICE.spawnEvery;
    }

    for (const unit of this.units) this._unitStep(unit, dt);
    for (const o of this.officers) this._officerStep(o, dt);

    // Arrest: on foot, a live officer within range for long enough.
    const player = this.player;
    let arresting = false;
    if (!player.car && this.stars > 0) {
      for (const o of this.officers) {
        if (o.down) continue;
        if (dist(o.pos.x, o.pos.z, player.pos.x, player.pos.z) < POLICE.arrestRange) { arresting = true; break; }
      }
      if (!arresting) {
        for (const u of this.units) {
          if (u.car.wrecked) continue;
          if (dist(u.car.pos.x, u.car.pos.z, player.pos.x, player.pos.z) < POLICE.arrestRange + 1.2) { arresting = true; break; }
        }
      }
    }
    if (arresting) {
      this.arrestTimer += dt;
      if (this.arrestTimer >= POLICE.arrestTime) {
        this.arrestTimer = 0;
        this.hooks.onBusted?.();
      }
    } else this.arrestTimer = Math.max(0, this.arrestTimer - dt * 2);

    // Heat decay: no unit near, no recent crime, after a delay lose a star.
    const near = this.nearestUnitDistance();
    if (this.stars > 0 && this.sinceCrime > POLICE.decayDelay && near > 46) {
      this.sinceStep += 0;
      this.decayTimer = (this.decayTimer ?? 0) + dt;
      if (this.decayTimer > 1.2) {
        this.decayTimer = 0;
        this.cool(1);
        this.hooks.onStarsChanged?.(this.stars);
      }
    } else {
      this.decayTimer = 0;
    }
    if (this.stars === 0 && this.units.length) this.despawnAll();

    // Siren follows the nearest unit.
    this.audio?.setSiren(Number.isFinite(near) ? near : 999, this.stars > 0 && this.units.length > 0);
  }

  noteCrime() { this.sinceCrime = 0; }
}
