// Traffic and pedestrians. Cars keep to their lane, slow into junctions, keep a gap, occasionally
// turn onto a cross street and turn around at the city edge. Pedestrians walk the pavements,
// wander, cross at corners and flee from trouble. Both are placed by the seeded generator, so the
// same seed gives the same street life.

import * as THREE from 'three';
import { TRAFFIC, CITY, PALETTE, PLAYER } from './config.js';
import { clamp, damp, wrapAngle, seeded, dist, TAU } from './random.js';
import { roadCenter, blockCenter, blockBounds } from './world.js';

const LINES = CITY.grid;
const LANE = TRAFFIC.laneOffset;
const ROAD_HALF = CITY.road / 2;

const shirtColours = [0xe76f51, 0x2a9d8f, 0xf4a261, 0x6d597a, 0x3d5a80, 0xf2e8cf, 0xd62828, 0x4cc9f0, 0xffafcc, 0x8ac926];
const trouserColours = [0x2b3a4a, 0x3d3d3d, 0x6b5b4b, 0x1f2933, 0x4a5568];
const skinColours = [0xd8a175, 0xb97a52, 0x8d5524, 0xf1c27d, 0xe0ac69, 0x6b4226];

export class TrafficSystem {
  constructor(scene, world, vehicles, audio) {
    this.scene = scene;
    this.world = world;
    this.vehicles = vehicles;
    this.audio = audio;
    this.rng = seeded(world.seed, 4242);
    this.cars = [];
    this.peds = [];
    this._buildCars();
    this._buildPeds();
  }

  // ------------------------------------------------------------ traffic cars

  _carSpawnPoint() {
    const rng = this.rng;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const axis = rng.chance(0.5);
      const line = rng.int(1, LINES - 1);
      const along = rng.range(-CITY.bound + 30, CITY.bound - 30);
      const dir = rng.chance(0.5) ? 1 : -1;
      let x, z, heading;
      if (axis) {
        // Travelling along x on a z-road.
        x = along;
        z = roadCenter(line) + (dir > 0 ? LANE : -LANE);
        heading = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
      } else {
        z = along;
        x = roadCenter(line) + (dir > 0 ? -LANE : LANE);
        heading = dir > 0 ? 0 : Math.PI;
      }
      if (x > CITY.seaEdge - 45) continue;
      if (this.world.isBlocked(x, z, 2.4)) continue;
      if (this.cars.some((c) => dist(c.vehicle.pos.x, c.vehicle.pos.z, x, z) < 12)) continue;
      return { x, z, heading, axis, dir, line };
    }
    return { x: 0, z: 0, heading: 0, axis: false, dir: 1, line: 6 };
  }

  _buildCars() {
    const types = ['sedan', 'sedan', 'sedan', 'taxi', 'taxi', 'sports', 'truck'];
    const palette = [0x8fb3c9, 0xd6d2c4, 0x6f8f6a, 0xb56b5a, 0xf0eae0, 0x5a6b8c, 0xc9c2b0, 0x7a4f6e, 0x2f6f7a];
    for (let i = 0; i < TRAFFIC.cars; i += 1) {
      const spot = this._carSpawnPoint();
      const type = this.rng.pick(types);
      const car = this.vehicles.spawn(type, spot.x, spot.z, spot.heading, { color: type === 'taxi' ? 0xf2c53d : this.rng.pick(palette) });
      car.localWidth = 0;
      car.ai = { kind: 'traffic', targetSpeed: this.rng.range(9, 15), cruise: this.rng.range(9, 15), axis: spot.axis, dir: spot.dir, line: spot.line, nextTurn: 4 + this.rng.float() * 10 };
      this.cars.push({ vehicle: car, axis: spot.axis, dir: spot.dir, line: spot.line, stuck: 0, turnCooldown: 0 });
    }
  }

  _otherLaneOccupied(car, x, z) {
    for (const other of this.cars) {
      if (other.vehicle === car) continue;
      if (dist(other.vehicle.pos.x, other.vehicle.pos.z, x, z) < 7.5) return true;
    }
    return false;
  }

  _trafficStep(entry, dt, player) {
    const car = entry.vehicle;
    if (car.occupied || car.wrecked) { car.ai = null; return; }
    const rng = this.rng;
    const pos = car.pos;

    // Work out which road we're on and how far to the next junction.
    let targetHeading;
    let crossCentre;
    let distToJunction;
    if (entry.axis) {
      // moving on x, road at z = roadCenter(line)
      const laneZ = roadCenter(entry.line) + (entry.dir > 0 ? LANE : -LANE);
      const crossIndex = Math.round((pos.x + CITY.bound) / CITY.pitch);
      crossCentre = roadCenter(clamp(crossIndex, 0, LINES));
      distToJunction = Math.abs(pos.x - crossCentre);
      targetHeading = entry.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
      // Nudge back into lane.
      car.pos.z = damp(car.pos.z, laneZ, 2.2, dt);
    } else {
      const laneX = roadCenter(entry.line) + (entry.dir > 0 ? LANE : -LANE);
      const crossIndex = Math.round((pos.z + CITY.bound) / CITY.pitch);
      crossCentre = roadCenter(clamp(crossIndex, 0, LINES));
      distToJunction = Math.abs(pos.z - crossCentre);
      targetHeading = entry.dir > 0 ? 0 : Math.PI;
      car.pos.x = damp(car.pos.x, laneX, 2.2, dt);
    }

    // Keep a gap from whatever is ahead.
    const ahead = new THREE.Vector3(Math.sin(car.heading), 0, Math.cos(car.heading));
    let gapHit = false;
    for (const other of this.cars) {
      if (other === entry) continue;
      const dx = other.vehicle.pos.x - car.pos.x;
      const dz = other.vehicle.pos.z - car.pos.z;
      const along = dx * ahead.x + dz * ahead.z;
      const side = Math.abs(dx * ahead.z - dz * ahead.x);
      if (along > 0 && along < TRAFFIC.gap + car.spec.length && side < 2.6) { gapHit = true; break; }
    }
    if (player?.car && !player.car.wrecked) {
      const dx = player.car.pos.x - car.pos.x, dz = player.car.pos.z - car.pos.z;
      const along = dx * ahead.x + dz * ahead.z;
      const side = Math.abs(dx * ahead.z - dz * ahead.x);
      if (along > 0 && along < TRAFFIC.gap + car.spec.length && side < 2.8) gapHit = true;
    }

    // Junction slowing, and sometimes a turn.
    let throttle = 1;
    const speed = Math.abs(car.speed);
    if (distToJunction < 9 && speed > 4) throttle = 0.35;
    if (gapHit && speed > 2) throttle = 0;
    car.ai = car.ai ?? {};
    car.ai.throttle = throttle;
    car.ai.brake = gapHit && speed > 2 ? 0.8 : 0;
    // Steer toward the target heading.
    const err = wrapAngle(targetHeading - car.heading);
    car.ai.steer = clamp(err * 2.4, -1, 1);

    entry.turnCooldown -= dt;
    if (distToJunction < 2.2 && entry.turnCooldown <= 0 && rng.chance(0.02 * dt * 60)) {
      // Turn onto a cross street if the way looks clear.
      const crossX = entry.axis ? roadCenter(clamp(Math.round((pos.x + CITY.bound) / CITY.pitch), 0, LINES)) : pos.x;
      const crossZ = entry.axis ? pos.z : roadCenter(clamp(Math.round((pos.z + CITY.bound) / CITY.pitch), 0, LINES));
      if (!this.world.isBlocked(crossX, crossZ, 4)) {
        entry.axis = !entry.axis;
        entry.dir = rng.chance(0.5) ? 1 : -1;
        entry.line = entry.axis
          ? clamp(Math.round((pos.z + CITY.bound) / CITY.pitch), 1, LINES - 1)
          : clamp(Math.round((pos.x + CITY.bound) / CITY.pitch), 1, LINES - 1);
        entry.turnCooldown = 6;
      }
    }

    // Turn around at the city edge.
    if (Math.abs(pos.x) > CITY.bound - 30 || Math.abs(pos.z) > CITY.bound - 30) {
      entry.dir *= -1;
      entry.turnCooldown = 5;
    }
    if (pos.x > CITY.seaEdge - 40) entry.dir = -1;

    // Stuck recovery: if we've barely moved and we're not gapped, reverse a moment.
    if (speed < 1.2 && !gapHit) entry.stuck += dt; else entry.stuck = 0;
    if (entry.stuck > 3.5) {
      car.ai.throttle = -0.6;
      car.ai.steer = 0.6;
      entry.stuck = 0;
      entry.turnCooldown = 1.5;
    }

    this.vehicles.aiStep(car, dt, car.ai);
    car.stepVisuals(dt, this.vehicles);
  }

  // ------------------------------------------------------------ pedestrians

  _pedSpawnPoint() {
    const rng = this.rng;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const i = rng.int(0, LINES - 1), j = rng.int(0, LINES - 1);
      const b = blockBounds(i, j);
      const edge = rng.int(0, 3);
      const along = rng.range(-b.half + 2, b.half - 2);
      const off = b.half - CITY.pavement / 2 - 0.6;
      let x, z;
      if (edge < 2) { x = b.cx + along; z = b.cz + (edge === 0 ? -off : off); }
      else { x = b.cx + (edge === 2 ? -off : off); z = b.cz + along; }
      if (x > CITY.seaEdge - 40) continue;
      if (this.world.isBlocked(x, z, 0.8)) continue;
      return { x, z };
    }
    return { x: 0, z: 40 };
  }

  _buildPeds() {
    for (let i = 0; i < TRAFFIC.peds; i += 1) {
      const p = this._pedSpawnPoint();
      this.peds.push(this._makePed(p.x, p.z, i));
    }
  }

  _makePed(x, z, index) {
    const rng = this.rng;
    const g = new THREE.Group();
    const shirt = new THREE.MeshStandardMaterial({ color: rng.pick(shirtColours), roughness: 0.75 });
    const trousers = new THREE.MeshStandardMaterial({ color: rng.pick(trouserColours), roughness: 0.82 });
    const skin = new THREE.MeshStandardMaterial({ color: rng.pick(skinColours), roughness: 0.78 });
    const hair = new THREE.MeshStandardMaterial({ color: rng.pick([0x1c1410, 0x3b2a1a, 0x6b4a2a, 0x101010]), roughness: 0.9 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.68, 0.28), shirt);
    body.position.y = 1.02;
    body.castShadow = true;
    g.add(body);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 0.26), skin);
    head.position.y = 1.5;
    head.castShadow = true;
    g.add(head);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.28), hair);
    cap.position.y = 1.64;
    g.add(cap);
    const legL = new THREE.Group(); legL.position.set(-0.13, 0.72, 0);
    const legR = new THREE.Group(); legR.position.set(0.13, 0.72, 0);
    for (const [grp] of [[legL], [legR]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.7, 0.18), trousers);
      leg.position.y = -0.35;
      leg.castShadow = true;
      grp.add(leg);
      g.add(grp);
    }
    const armL = new THREE.Group(); armL.position.set(-0.31, 1.28, 0);
    const armR = new THREE.Group(); armR.position.set(0.31, 1.28, 0);
    for (const grp of [armL, armR]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.58, 0.14), shirt);
      arm.position.y = -0.29;
      arm.castShadow = true;
      grp.add(arm);
      g.add(grp);
    }

    g.position.set(x, 0, z);
    g.rotation.y = rng.range(0, TAU);
    this.scene.add(g);

    return {
      group: g, body, head, legL, legR, armL, armR,
      pos: new THREE.Vector3(x, 0, z),
      heading: g.rotation.y,
      speed: rng.range(1.1, 1.9),
      baseSpeed: rng.range(1.1, 1.9),
      walkPhase: rng.range(0, TAU),
      fear: 0,
      down: false,
      downTimer: 0,
      downTilt: 0,
      downVel: 0,
      index,
      wander: rng.range(0, TAU),
      wanderTimer: rng.range(1, 4),
      alive: true,
      hitByCar: false,
    };
  }

  _pedStep(ped, dt, player) {
    if (!ped.alive) return;
    const g = ped.group;
    if (ped.down) {
      ped.downTimer -= dt;
      ped.downVel -= 16 * dt;
      g.position.y += ped.downVel * dt;
      ped.downTilt = Math.min(1.5, ped.downTilt + dt * 3.4);
      g.rotation.x = -ped.downTilt;
      if (g.position.y <= 0.16) { g.position.y = 0.16; ped.downVel = 0; }
      if (ped.downTimer <= 0) {
        // Get back up.
        ped.down = false;
        ped.downTilt = 0;
        g.rotation.x = 0;
        g.position.y = 0;
      }
      return;
    }

    // Fear: run away from the player when a crime happened nearby or a fast car is close.
    let fleeing = ped.fear > 0;
    if (player) {
      const d = dist(ped.pos.x, ped.pos.z, player.pos.x, player.pos.z);
      if (player.car && Math.abs(player.car.speed) > 12 && d < 14) {
        ped.fear = Math.max(ped.fear, 1.4);
        fleeing = true;
      }
      if (d < 9 && Math.abs(player.car?.speed ?? 0) > 3) ped.fear = Math.max(ped.fear, 1.1);
    }
    if (ped.fear > 0) ped.fear = Math.max(0, ped.fear - dt * 0.5);

    let wantHeading;
    let speed;
    if (fleeing && player) {
      wantHeading = Math.atan2(ped.pos.x - player.pos.x, ped.pos.z - player.pos.z);
      speed = 4.6;
    } else {
      ped.wanderTimer -= dt;
      if (ped.wanderTimer <= 0) {
        ped.wanderTimer = this.rng.range(1.6, 4.2);
        ped.wander += this.rng.range(-0.8, 0.8);
      }
      wantHeading = ped.heading + Math.sin(ped.wander) * 0.4;
      speed = ped.baseSpeed;
    }
    ped.heading += wrapAngle(wantHeading - ped.heading) * Math.min(1, dt * (fleeing ? 7 : 3));
    const nx = ped.pos.x + Math.sin(ped.heading) * speed * dt;
    const nz = ped.pos.z + Math.cos(ped.heading) * speed * dt;

    if (this.world.isBlocked(nx, nz, 0.45) || nx > CITY.seaEdge - 36 || Math.abs(nx) > CITY.bound - 8 || Math.abs(nz) > CITY.bound - 8) {
      ped.heading += 2.1 + this.rng.float();
      ped.wander += 1.4;
    } else {
      ped.pos.set(nx, 0, nz);
    }

    ped.walkPhase += dt * (fleeing ? 13 : 7) * (speed / 1.6);
    const swing = Math.sin(ped.walkPhase) * (fleeing ? 0.85 : 0.45);
    ped.legL.rotation.x = swing;
    ped.legR.rotation.x = -swing;
    ped.armL.rotation.x = -swing * 0.8;
    ped.armR.rotation.x = swing * 0.8;
    g.position.set(ped.pos.x, 0, ped.pos.z);
    g.rotation.y = ped.heading;
  }

  knockDown(ped, fromX, fromZ, force = 1) {
    if (!ped || !ped.alive || ped.down) return false;
    ped.down = true;
    ped.downTimer = 2.6;
    ped.downVel = 3.0 * force;
    ped.downTilt = 0;
    ped.fear = 3;
    const dx = ped.pos.x - fromX, dz = ped.pos.z - fromZ;
    const len = Math.hypot(dx, dz) || 1;
    ped.pos.x += (dx / len) * 0.6;
    ped.pos.z += (dz / len) * 0.6;
    ped.group.position.set(ped.pos.x, 0, ped.pos.z);
    return true;
  }

  /** Frighten everyone near a point (a crime happened, someone got hit). */
  scatter(x, z, radius = 26) {
    for (const p of this.peds) {
      if (!p.alive) continue;
      if (dist(p.pos.x, p.pos.z, x, z) < radius) p.fear = Math.max(p.fear, 2.6);
    }
  }

  nearestPed(x, z, maxDist = 6) {
    let best = null, bestD = maxDist;
    for (const p of this.peds) {
      if (!p.alive || p.down) continue;
      const d = dist(p.pos.x, p.pos.z, x, z);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best ? { ped: best, distance: bestD } : null;
  }

  /** Pedestrians in a cone in front of the player, nearest first (for shooting rays). */
  pedsInCone(x, z, dirX, dirZ, range, cosHalfAngle) {
    const hits = [];
    for (const p of this.peds) {
      if (!p.alive || p.down) continue;
      const dx = p.pos.x - x, dz = p.pos.z - z;
      const d = Math.hypot(dx, dz);
      if (d > range || d < 0.2) continue;
      const dot = (dx / d) * dirX + (dz / d) * dirZ;
      if (dot < cosHalfAngle) continue;
      hits.push({ ped: p, distance: d, dot });
    }
    hits.sort((a, b) => a.distance - b.distance);
    return hits;
  }

  /** Did the player's car hit a pedestrian this frame? Returns the hit ped or null. */
  checkCarHits(playerCar) {
    if (!playerCar || Math.abs(playerCar.speed) < 5.5) return null;
    const halfL = playerCar.spec.length / 2 + 0.4;
    const halfW = playerCar.spec.width / 2 + 0.4;
    for (const p of this.peds) {
      if (!p.alive || p.down) continue;
      const dx = p.pos.x - playerCar.pos.x;
      const dz = p.pos.z - playerCar.pos.z;
      const cos = Math.cos(-playerCar.heading), sin = Math.sin(-playerCar.heading);
      const lx = dx * cos - dz * sin;
      const lz = dx * sin + dz * cos;
      if (Math.abs(lx) < halfW && Math.abs(lz) < halfL) {
        this.knockDown(p, playerCar.pos.x, playerCar.pos.z, 1.3);
        p.hitByCar = true;
        return p;
      }
    }
    return null;
  }

  update(dt, player) {
    for (const entry of this.cars) this._trafficStep(entry, dt, player);
    for (const ped of this.peds) this._pedStep(ped, dt, player);
  }

  /** Seat scripted pedestrians for the screenshot staging. */
  pose(ped, x, z, heading, fear = 0) {
    ped.pos.set(x, 0, z);
    ped.heading = heading;
    ped.fear = fear;
    ped.down = false;
    ped.downTilt = 0;
    ped.group.position.set(x, 0, z);
    ped.group.rotation.set(0, heading, 0);
  }
}
