// Four linked jobs, "Wheelman to Waterfront King". Each has a beacon, a package where it needs one,
// and steps with a check function the game calls every frame. Completing a job pays out, cools the
// heat by a star, and queues the next one about a second later.

import * as THREE from 'three';
import { MISSIONS, PALETTE, PLAYER } from './config.js';
import { clamp, dist, damp } from './random.js';
import { softGlowTexture } from './world.js';

const WAYPOINT_RANGE = 14;

export class MissionSystem {
  constructor(scene, world, player, vehicles, police, traffic, audio, hooks = {}) {
    this.scene = scene;
    this.world = world;
    this.player = player;
    this.vehicles = vehicles;
    this.police = police;
    this.traffic = traffic;
    this.audio = audio;
    this.hooks = hooks;
    this.index = 0;
    this.step = 0;
    this.active = false;
    this.complete = false;
    this.banner = null;
    this.bannerTimer = 0;
    this.nextTimer = 0;
    this.beacon = null;
    this.marker = null;
    this.targetCar = null;
    this.packageMesh = null;
    this.packageTaken = false;
    this.dirty = true;
    this.clock = 0;
    this.completedIds = [];
    this._buildBeacon();
    this._buildPackage();
  }

  // ------------------------------------------------------------ visuals

  _buildBeacon() {
    const g = new THREE.Group();
    g.visible = false;

    const ringMat = new THREE.MeshBasicMaterial({
      color: PALETTE.missionTeal, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(5.2, 6.4, 40), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.12;
    g.add(ring);
    this.ring = ring;
    this.ringMat = ringMat;

    const pillarMat = new THREE.MeshBasicMaterial({
      color: PALETTE.missionTeal, transparent: true, opacity: 0.14,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(4.0, 4.6, 42, 18, 1, true), pillarMat);
    pillar.position.y = 21;
    g.add(pillar);
    this.pillarMat = pillarMat;

    const diamondMat = new THREE.MeshBasicMaterial({
      color: PALETTE.missionGold, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const diamond = new THREE.Mesh(new THREE.OctahedronGeometry(1.7, 0), diamondMat);
    diamond.position.y = 9.5;
    g.add(diamond);
    this.diamond = diamond;

    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(3.2, 12, 10),
      new THREE.MeshBasicMaterial({ map: softGlowTexture(), color: PALETTE.missionTeal, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    halo.position.y = 9.5;
    g.add(halo);

    this.beacon = g;
    this.scene.add(g);
  }

  _buildPackage() {
    const g = new THREE.Group();
    g.visible = false;
    const crate = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 1.2, 1.1),
      new THREE.MeshStandardMaterial({ color: PALETTE.crate, roughness: 0.55, emissive: 0x1c7a3c, emissiveIntensity: 0.5 }),
    );
    crate.position.y = 0.75;
    crate.castShadow = true;
    g.add(crate);
    const handle = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.16, 0.3),
      new THREE.MeshStandardMaterial({ color: 0x1f3a2a, roughness: 0.7 }),
    );
    handle.position.y = 1.45;
    g.add(handle);
    const column = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 1.25, 16, 14, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x64ffb0, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    column.position.y = 8.6;
    g.add(column);
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(2.4, 12, 10),
      new THREE.MeshBasicMaterial({ map: softGlowTexture(), color: 0x6dffb0, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    glow.position.y = 1.1;
    g.add(glow);
    const light = new THREE.PointLight(0x64ffb0, 2.6, 20, 2);
    light.position.y = 1.8;
    g.add(light);
    this.packageMesh = g;
    this.scene.add(g);
  }

  // ------------------------------------------------------------ lifecycle

  get current() { return MISSIONS[this.index] ?? null; }

  get objectiveText() {
    if (this.complete) return 'Story complete — the city is yours';
    if (!this.current) return 'Story complete — the city is yours';
    return this._stepText();
  }

  _stepText() {
    const job = this.current;
    if (!job) return 'Story complete — the city is yours';
    switch (job.id) {
      case 'borrowed':
        return this.step === 0 ? 'Steal any car' : 'Bring it to the lock-up on Marlin Row';
      case 'collector':
        return this.step === 0 ? 'Find the runner\'s sports car' : 'Wreck it';
      case 'harbour':
        return this.step === 0 ? 'Pick up the case at the marina' : 'Deliver it to the north quay';
      case 'lastboat':
        return this.step === 0 ? 'Lift the sports car from the harbour deck'
          : this.step === 1 ? 'Shake the tail — lose the police' : 'Reach the hideout';
      default: return '';
    }
  }

  reset() {
    this._clearJobObjects();
    this.index = 0;
    this.step = 0;
    this.active = false;
    this.complete = false;
    this.packageTaken = false;
    this.banner = null;
    this.nextTimer = 0;
    this.completedIds = [];
    this.dirty = true;
  }

  start(index = 0) {
    this._clearJobObjects();
    this.index = clamp(index, 0, MISSIONS.length - 1);
    this.step = 0;
    this.active = true;
    this.complete = false;
    this.packageTaken = false;
    this.dirty = true;
    this._enterJob();
  }

  _clearJobObjects() {
    this.beacon.visible = false;
    this.packageMesh.visible = false;
    if (this.targetCar) {
      this.targetCar.jobCar = false;
      this.targetCar = null;
    }
  }

  _enterJob() {
    const job = this.current;
    if (!job) { this.active = false; return; }
    this.packageTaken = false;
    if (job.id === 'lastboat') {
      // The harbour-deck car, parked and waiting to be lifted.
      const spot = this.world.findParkingSpot(job.pickup.x, job.pickup.z, false);
      const x = spot ? spot.x : job.pickup.x;
      const z = spot ? spot.z : job.pickup.z;
      this.targetCar = this.vehicles.spawn('sports', x, z, spot?.heading ?? 0, { color: 0x2fa36b });
      this.targetCar.jobCar = true;
      this.targetCar.ai = { kind: 'parked' };
      if (spot) spot.taken = true;
      this.beacon.position.set(job.pickup.x, 0, job.pickup.z);
      this.beacon.visible = true;
    } else if (job.id === 'collector') {
      // Spawn the runner's sports car on a road near the job target, then point the beacon at it.
      const spot = this.world.findParkingSpot(job.target.x, job.target.z, false);
      const x = spot ? spot.x : job.target.x;
      const z = spot ? spot.z : job.target.z;
      this.targetCar = this.vehicles.spawn('sports', x, z, spot?.heading ?? 0, { color: 0xe8d24a });
      this.targetCar.jobCar = true;
      this.targetCar.ai = { kind: 'parked' };
      if (spot) spot.taken = true;
      this.beacon.position.set(x, 0, z);
      this.beacon.visible = true;
    } else if (job.id === 'borrowed') {
      this.beacon.position.set(job.target.x, 0, job.target.z);
      this.beacon.visible = true;
    } else if (job.pickup) {
      this.beacon.position.set(job.pickup.x, 0, job.pickup.z);
      this.beacon.visible = true;
    }
    this.dirty = true;
    this.hooks.onJobStart?.(job, this.index);
  }

  _showPackage(x, z) {
    this.packageMesh.position.set(x, 0, z);
    this.packageMesh.visible = true;
    this.packageTaken = false;
  }

  completeStep() {
    const job = this.current;
    if (!job) return;
    this.step += 1;
    this.dirty = true;
    if (job.id === 'harbour') {
      if (this.step === 1) {
        // Case picked up: move the beacon to the delivery point.
        this._showPackage(this.player.pos.x, this.player.pos.z);
        this.beacon.position.set(job.target.x, 0, job.target.z);
        this.hooks.onStep?.(job, this.step);
        return;
      }
      if (this.step >= 2) this._finishJob();
      return;
    }
    if (job.id === 'lastboat') {
      if (this.step === 1) {
        this.beacon.position.set(job.target.x, 0, job.target.z);
        this.beacon.visible = true;
        this.hooks.onStep?.(job, this.step);
        return;
      }
      if (this.step >= 2) this._finishJob();
      return;
    }
    if (this.step >= 2) this._finishJob();
  }

  _finishJob() {
    const job = this.current;
    if (!job) return;
    this.active = false;
    this.complete = this.index >= MISSIONS.length - 1;
    this.player.cash += job.reward;
    this.audio?.missionComplete();
    this.banner = { title: `${job.name.toUpperCase()} — COMPLETE`, cash: job.reward, timer: 3.4 };
    this.bannerTimer = 3.4;
    this.completedIds.push(job.id);
    this.police.cool(1);
    this._clearJobObjects();
    this.hooks.onJobComplete?.(job, this.index, job.reward);
    if (!this.complete) {
      this.nextTimer = 1.2;
      this.dirty = true;
    } else {
      this.dirty = true;
      this.hooks.onStoryComplete?.();
    }
  }

  /** The scripted path the playtest walks jobs with: jump straight to a job index. */
  forceStart(index) {
    if (index >= MISSIONS.length) {
      this.index = MISSIONS.length - 1;
      this.step = 2;
      this._finishJob();
      return;
    }
    this.index = index;
    this.step = 0;
    this.active = false;
    this.complete = false;
    this.nextTimer = 0;
    this._enterJob();
    this.active = true;
  }

  update(dt, game) {
    this.clock += dt;
    if (this.banner) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.banner = null;
    }
    if (this.nextTimer > 0) {
      this.nextTimer -= dt;
      if (this.nextTimer <= 0) {
        this.index += 1;
        this.step = 0;
        this.active = true;
        this._enterJob();
        this.dirty = true;
      }
    }
    if (!this.active || !this.current) return;

    // Animate the beacon so it reads from across the street.
    this.beacon.rotation.y += dt * 0.8;
    const bob = Math.sin(this.clock * 2.2) * 0.5;
    this.diamond.position.y = 9.5 + bob;
    this.diamond.rotation.y += dt * 1.6;
    this.ring.scale.setScalar(1 + Math.sin(this.clock * 3) * 0.04);
    this.pillarMat.opacity = 0.1 + Math.abs(Math.sin(this.clock * 1.4)) * 0.1;

    const player = this.player;
    const job = this.current;
    const target = this._currentTarget(job);

    if (target) this.beacon.position.set(target.x, 0, target.z);

    switch (job.id) {
      case 'borrowed': {
        if (this.step === 0) {
          if (player.car) { this.step = 1; this.dirty = true; this.hooks.onStep?.(job, this.step); }
        } else if (player.car) {
          if (dist(player.car.pos.x, player.car.pos.z, job.target.x, job.target.z) < WAYPOINT_RANGE) {
            this._deliverJobCar();
          }
        }
        break;
      }
      case 'collector': {
        if (!this.targetCar) { this._finishJob(); break; }
        if (this.step === 0) {
          if (dist(player.pos.x, player.pos.z, this.targetCar.pos.x, this.targetCar.pos.z) < 22) {
            this.step = 1; this.dirty = true; this.hooks.onStep?.(job, this.step);
          }
        }
        if (this.step >= 1 && this.targetCar.wrecked) this._finishJob();
        break;
      }
      case 'harbour': {
        if (this.step === 0) {
          if (!this.packageMesh.visible) this._showPackage(job.pickup.x, job.pickup.z);
          this.beacon.position.set(job.pickup.x, 0, job.pickup.z);
          if (dist(player.pos.x, player.pos.z, job.pickup.x, job.pickup.z) < 9 && !player.car) {
            this.packageMesh.visible = false;
            this.packageTaken = true;
            this.audio?.pickup();
            this.step = 1;
            this.dirty = true;
            this.beacon.position.set(job.target.x, 0, job.target.z);
            this.hooks.onStep?.(job, this.step);
          } else if (dist(player.pos.x, player.pos.z, job.pickup.x, job.pickup.z) < 12 && player.car) {
            this.packageMesh.visible = false;
            this.packageTaken = true;
            this.audio?.pickup();
            this.step = 1;
            this.dirty = true;
            this.beacon.position.set(job.target.x, 0, job.target.z);
            this.hooks.onStep?.(job, this.step);
          }
        } else if (this.step === 1) {
          this.beacon.position.set(job.target.x, 0, job.target.z);
          if (dist(player.pos.x, player.pos.z, job.target.x, job.target.z) < WAYPOINT_RANGE) {
            this.packageMesh.visible = false;
            this.step = 2;
            this.dirty = true;
            this._finishJob();
          }
        }
        break;
      }
      case 'lastboat': {
        if (!this.targetCar) { this._finishJob(); break; }
        if (this.step === 0) {
          this.beacon.position.set(this.targetCar.pos.x, 0, this.targetCar.pos.z);
          if (player.car === this.targetCar) {
            this.step = 1;
            this.dirty = true;
            this.police.raise(3);
            this.beacon.position.set(job.target.x, 0, job.target.z);
            this.hooks.onStep?.(job, this.step);
          }
        } else if (this.step === 1) {
          this.beacon.position.set(job.target.x, 0, job.target.z);
          if (this.police.stars === 0) {
            this.step = 2;
            this.dirty = true;
            this.hooks.onStep?.(job, this.step);
          }
        } else if (this.step >= 2) {
          this.beacon.position.set(job.target.x, 0, job.target.z);
          if (dist(player.pos.x, player.pos.z, job.target.x, job.target.z) < WAYPOINT_RANGE) {
            this.step = 3;
            this._finishJob();
          }
        }
        break;
      }
      default: break;
    }
  }

  _currentTarget(job) {
    if (!job) return null;
    if (job.id === 'collector' && this.targetCar) return { x: this.targetCar.pos.x, z: this.targetCar.pos.z };
    if (job.id === 'lastboat') {
      if (this.step === 0 && this.targetCar) return { x: this.targetCar.pos.x, z: this.targetCar.pos.z };
      return job.target;
    }
    if (job.id === 'harbour') return this.step === 0 ? job.pickup : job.target;
    return job.target;
  }

  _deliverJobCar() {
    const job = this.current;
    const car = this.player.car;
    if (car) {
      // The lock-up swallows the car: drop the player out beside it, then remove it.
      this.player.exitCar();
      this.vehicles.remove(car);
    }
    this.step = 2;
    this.dirty = true;
    this._finishJob();
  }

  /** Marker position for the minimap / HUD. */
  marker() {
    const job = this.current;
    if (!job) return null;
    const t = this._currentTarget(job);
    return t ? { x: t.x, z: t.z } : null;
  }

  dispose() {
    this._clearJobObjects();
    this.scene.remove(this.beacon);
    this.scene.remove(this.packageMesh);
  }
}
