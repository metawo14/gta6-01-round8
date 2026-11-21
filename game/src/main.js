// SOLMAR — the game. Fixed-step loop, four modes (title, play, paused, busted, wasted), the camera,
// the crime feed that feeds the wanted level, saving, and the title screen. The page exposes the
// instance as window.__game and sets window.__shotReady when a staged screenshot frame is up.

import * as THREE from 'three';
import {
  CAMERA, PLAYER, TIME, PALETTE, VEHICLE_CLASSES, MISSIONS, CITY,
} from './config.js';
import { Input } from './input.js';
import { audio } from './audio.js';
import { World } from './world.js';
import { VehicleManager } from './vehicles.js';
import { Player } from './player.js';
import { TrafficSystem } from './traffic.js';
import { PoliceSystem } from './police.js';
import { MissionSystem } from './missions.js';
import { HUD, phaseWord } from './hud.js';
import { runShot, SHOT_PRESETS } from './shots.js';
import { clamp, damp, wrapAngle, seeded, dist } from './random.js';

const SAVE_KEY = 'solmar.save.v1';
const FIXED = 1 / 60;

class Game {
  constructor({ canvas, hudRoot, overlay, seed = 7 }) {
    this.seed = seed;
    this.canvas = canvas;
    this.overlay = overlay;
    this.mode = 'title';
    this.accumulator = 0;
    this.lastTime = performance.now();
    this.clockMinutes = TIME.startMinutes;
    this.dayMs = 0;
    this.vignetteFlash = 0;
    this.cameraYaw = Math.PI;
    this.cameraPitch = 0.2;
    this.cameraPos = new THREE.Vector3(150, 8, -140);
    this.cameraLook = new THREE.Vector3(150, 1.6, -150);
    this.cameraShake = 0;
    this.time = 0;
    this.stats = { cars: 0, buildings: 0 };
    this.save = null;
    this.lastPrompt = '';
    this.onStateChange = null;
    this.ready = false;
    this.paused = false;
    this.arrestFlash = 0;
    this.hornCooldown = 0;
    this.crimeFlash = 0;

    this.renderer = this._createRenderer(canvas);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, 16 / 9, CAMERA.near, CAMERA.far);
    this.camera.position.copy(this.cameraPos);

    this.input = new Input(canvas);
    this.input.onFirstGesture = () => { audio.ensure(); };

    this.world = new World(this.scene, this.seed);
    this.stats.buildings = this.world.buildingCount ?? 0;

    this.vehicles = new VehicleManager(this.scene, this.world, audio, {
      onCrash: (car, impact, dmg) => this._onCrash(car, impact, dmg),
      onCameraShake: (v) => { this.cameraShake = Math.max(this.cameraShake, v); },
      onWrecked: (car) => this._onPlayerWrecked(car),
    });
    this.player = new Player(this.scene, this.world, audio);
    this.traffic = new TrafficSystem(this.scene, this.world, this.vehicles, audio);
    this.stats.cars = this.vehicles.vehicles.length;
    this.police = new PoliceSystem(this.scene, this.world, this.vehicles, this.player, this.traffic, audio, {
      onBusted: () => this.setMode('busted'),
      onRam: (car, dmg) => { this._spawnCrime('ram', dmg); },
      onWanted: () => { this.crimeFlash = 1; },
      onStarsChanged: () => {},
      onCrash: (car, impact, dmg) => this._onCrash(car, impact, dmg),
      onCameraShake: (v) => { this.cameraShake = Math.max(this.cameraShake, v); },
    });
    this.missions = new MissionSystem(this.scene, this.world, this.player, this.vehicles, this.police, this.traffic, audio, {
      onJobComplete: (job, index) => { this.police.noteCrime(); this.crimeFlash = 0; },
      onJobStart: () => {},
    });
    this.hud = new HUD(hudRoot);

    this._spawnParkedCars();
    this._placePlayerStart();
    this.save = this._loadSave();
    this._bindTitleScreen();
    this._bindPauseScreen();
    this.ready = true;
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
    if (this.input) this.input.onFirstGesture = () => { audio.ensure(); };
  }

  _createRenderer(canvas) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = CAMERA.exposure;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0xbfe4f6, 1);
    return renderer;
  }

  // ------------------------------------------------------------ world setup

  _spawnParkedCars() {
    const rng = seeded(this.seed, 3131);
    const types = ['sedan', 'sedan', 'taxi', 'truck', 'sports', 'sedan'];
    const colours = [0x8fb3c9, 0xd6d2c4, 0x6f8f6a, 0xb56b5a, 0xf0eae0, 0x5a6b8c, 0xc9c2b0];
    for (let i = 0; i < 6; i += 1) {
      const spot = this.world.findParkingSpot(rng.range(-200, 200), rng.range(-200, 200), true);
      if (!spot) continue;
      spot.taken = true;
      const type = rng.pick(types);
      const car = this.vehicles.spawn(type, spot.x, spot.z, spot.heading, {
        color: type === 'taxi' ? 0xf2c53d : rng.pick(colours),
      });
      car.ai = { kind: 'parked' };
    }
  }

  _placePlayerStart() {
    this.player.teleport(150, -150, Math.PI);
    // A sedan waiting right beside the player so job one is one keypress away.
    const car = this.vehicles.spawn('sedan', 156, -152, Math.PI * 0.5, { color: 0xd6d2c4 });
    car.ai = { kind: 'parked' };
  }

  // ------------------------------------------------------------ title / pause

  _bindTitleScreen() {
    const start = document.getElementById('btn-start');
    const cont = document.getElementById('btn-continue');
    const best = document.getElementById('title-best');
    if (best) {
      best.textContent = this.save ? `Best save · $${this.save.cash.toLocaleString('en-US')} · Job ${this.save.mission + 1}` : 'No save yet';
    }
    if (start) start.addEventListener('click', () => { audio.ensure(); this.startFresh(); });
    if (cont) {
      cont.disabled = !this.save;
      cont.addEventListener('click', () => { audio.ensure(); this.continueSave(); });
    }
  }

  _bindPauseScreen() {
    document.getElementById('btn-resume')?.addEventListener('click', () => this.setMode('play'));
    document.getElementById('btn-save')?.addEventListener('click', () => { this.saveGame(); this._flashPauseNote('Saved'); });
    document.getElementById('btn-restart')?.addEventListener('click', () => { this.startFresh(); });
    document.getElementById('btn-walkout')?.addEventListener('click', () => this._respawn('busted'));
    document.getElementById('btn-getup')?.addEventListener('click', () => this._respawn('wasted'));
  }

  _flashPauseNote(text) {
    const note = document.getElementById('pause-note');
    if (!note) return;
    note.textContent = text;
    note.classList.add('show');
    setTimeout(() => note.classList.remove('show'), 1400);
  }

  startFresh() {
    this.missions.reset();
    this.police.clear();
    this.player.reset();
    this.player.cash = 250;
    this.player.health = 100;
    this.clockMinutes = TIME.startMinutes;
    this.dayMs = 0;
    this._placePlayerStart();
    this.missions.start(0);
    this.setMode('play');
    this.cameraYaw = Math.PI;
    this.cameraPitch = 0.22;
    this._updateCamera(0.016, true);
  }

  continueSave() {
    if (!this.save) return this.startFresh();
    const s = this.save;
    this.player.reset();
    this.player.cash = s.cash ?? 250;
    this.player.health = 100;
    this.clockMinutes = s.clock ?? TIME.startMinutes;
    this.player.teleport(s.x ?? 150, s.z ?? -150, s.heading ?? Math.PI);
    this.police.clear();
    this.police.stars = clamp(s.stars ?? 0, 0, 5);
    this.missions.forceStart(clamp(s.mission ?? 0, 0, MISSIONS.length - 1));
    this.missions.step = clamp(s.step ?? 0, 0, 3);
    this.setMode('play');
    this.cameraYaw = this.player.heading;
    this._updateCamera(0.016, true);
  }

  setMode(mode) {
    this.mode = mode;
    this.overlay.dataset.mode = mode;
    for (const screen of this.overlay.querySelectorAll('.screen')) {
      screen.classList.toggle('show', screen.dataset.screen === mode);
    }
    if (mode === 'paused') this.saveGame();
    if (mode === 'busted') { audio.busted(); this.player.exitCar(); }
    if (mode === 'wasted') { audio.busted(); }
    if (mode === 'play') this.input && (this.input.override = this.input.override);
    this.onStateChange?.(mode);
  }

  _respawn(kind) {
    const took = kind === 'busted' ? 150 : 0;
    if (kind === 'busted') this.player.cash = Math.max(0, this.player.cash - took);
    this.player.exitCar();
    this.player.reset();
    this.player.teleport(150, -150, Math.PI);
    this.player.health = 100;
    this.police.clear();
    this.missions.step = Math.max(0, this.missions.step);
    this.cameraYaw = Math.PI;
    this.cameraPitch = 0.22;
    this.setMode('play');
    this._updateCamera(0.016, true);
  }

  // ------------------------------------------------------------ save

  _loadSave() {
    try {
      const raw = window.localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || typeof s !== 'object') return null;
      return s;
    } catch { return null; }
  }

  saveGame() {
    const data = {
      version: 1,
      cash: this.player.cash,
      health: this.player.health,
      mission: this.missions.index,
      step: this.missions.step,
      x: Math.round((this.player.car ? this.player.car.pos.x : this.player.pos.x) * 10) / 10,
      z: Math.round((this.player.car ? this.player.car.pos.z : this.player.pos.z) * 10) / 10,
      heading: Math.round(this.player.heading * 100) / 100,
      clock: Math.floor(this.clockMinutes),
      stars: this.police.stars,
      savedAt: Date.now(),
    };
    try {
      window.localStorage.setItem(SAVE_KEY, JSON.stringify(data));
      this.save = data;
      return true;
    } catch {
      // Private mode / quota: keep it in memory so CONTINUE still works this session.
      this.save = data;
      return false;
    }
  }

  // ------------------------------------------------------------ crimes

  _spawnCrime(kind, detail) {
    this.police.noteCrime();
    this.crimeFlash = 1;
    switch (kind) {
      case 'car-theft': this.police.raise(1); break;
      case 'police-theft': this.police.raise(2); break;
      case 'homicide': this.police.raise(2); break;
      case 'assault': this.police.raise(2); break;
      case 'assault-officer': this.police.raise(1); break;
      case 'vehicular': this.police.raise(1); break;
      case 'ram': this.police.raise(0); break;
      default: break;
    }
  }

  _onCrash(car, impact, dmg) {
    if (impact > 8) this.hud.flashImpact(clamp(impact / 30, 0.15, 0.7));
    if (car === this.player.car) {
      this.cameraShake = Math.max(this.cameraShake, clamp(impact / 30, 0.1, 0.9));
      this.vignetteFlash = Math.max(this.vignetteFlash, clamp(impact / 40, 0.05, 0.5));
    }
  }

  _onPlayerWrecked(car) {
    if (car !== this.player.car) return;
    this.player.exitCar();
    this.player.hurt(100);
    this.setMode('wasted');
  }

  /** Fire the pistol: generous aim cone, raycast toward nearest ped/police car in front. */
  _fire() {
    const shot = this.player.tryFire();
    if (!shot) return;
    const cosCone = Math.cos(PLAYER.aimCone * 0.5);
    const hits = this.traffic.pedsInCone(shot.x, shot.z, shot.dirX, shot.dirZ, shot.range, cosCone);
    if (hits.length) {
      const ped = hits[0].ped;
      this.traffic.knockDown(ped, shot.x, shot.z, 1.2);
      this.traffic.scatter(shot.x, shot.z, 30);
      this._spawnCrime('homicide');
      this.hud.flashImpact(0.35);
      return;
    }
    // Police car in the cone takes the round.
    for (const unit of this.police.units) {
      const car = unit.car;
      const dx = car.pos.x - shot.x, dz = car.pos.z - shot.z;
      const d = Math.hypot(dx, dz);
      if (d > shot.range) continue;
      const dot = (dx / d) * shot.dirX + (dz / d) * shot.dirZ;
      if (dot < cosCone) continue;
      car.damage(12);
      this._spawnCrime('assault-officer');
      return;
    }
    // Shooting near people scares them even when nobody is hit.
    this.traffic.scatter(shot.x, shot.z, 26);
  }

  _punch() {
    if (!this.player.punch()) return;
    const hit = this.traffic.nearestPed(this.player.pos.x, this.player.pos.z, 2.6);
    if (hit) {
      const ped = hit.ped;
      const isOfficer = false;
      this.traffic.knockDown(ped, this.player.pos.x, this.player.pos.z, 1.1);
      this.traffic.scatter(ped.pos.x, ped.pos.z, 24);
      this._spawnCrime(isOfficer ? 'assault-officer' : 'assault');
      this.hud.flashImpact(0.25);
      return;
    }
    // Punching a cop on foot counts too.
    for (const o of this.police.officers) {
      if (o.down) continue;
      if (dist(o.pos.x, o.pos.z, this.player.pos.x, this.player.pos.z) < 2.6) {
        o.down = true;
        o.downTilt = 0;
        this._spawnCrime('assault-officer');
        return;
      }
    }
  }

  // ------------------------------------------------------------ enter / exit

  _nearestEnterableCar() {
    if (this.player.car) return null;
    const near = this.vehicles.nearest(this.player.pos.x, this.player.pos.z, (c) => !c.wrecked && !c.occupied);
    if (!near || near.distance > PLAYER.enterRange) return null;
    return near.car;
  }

  _handleEnter() {
    if (this.player.car) {
      const car = this.player.exitCar();
      if (car) car.ai = car.ai ?? { kind: 'traffic' };
      return;
    }
    const car = this._nearestEnterableCar();
    if (!car) return;
    this.player.enterCar(car);
    const policeCar = car.type === 'police';
    this._spawnCrime(policeCar ? 'police-theft' : 'car-theft');
  }

  // ------------------------------------------------------------ camera

  _updateCamera(dt, snap = false) {
    const player = this.player;
    const target = new THREE.Vector3();
    let desired = new THREE.Vector3();
    if (player.car) {
      const car = player.car;
      const speedK = clamp(Math.abs(car.speed) / car.spec.topSpeed, 0, 1);
      const back = CAMERA.driveDistance + speedK * 3.4;
      const height = CAMERA.driveHeight - speedK * 0.9;
      const heading = car.heading;
      // Tuck behind and a touch above, with lag.
      desired.set(
        car.pos.x - Math.sin(heading) * back,
        height,
        car.pos.z - Math.cos(heading) * back,
      );
      target.set(car.pos.x + Math.sin(heading) * 3, 1.4, car.pos.z + Math.cos(heading) * 3);
      this.cameraYaw = damp(wrapAngle(this.cameraYaw), heading, 3.5, dt) === 0 ? this.cameraYaw : this.cameraYaw;
    } else {
      const back = CAMERA.footDistance;
      desired.set(
        player.pos.x - Math.sin(this.cameraYaw) * back,
        player.pos.y + CAMERA.footHeight,
        player.pos.z - Math.cos(this.cameraYaw) * back,
      );
      target.set(player.pos.x, player.pos.y + 1.45, player.pos.z);
    }
    // Mouse look (on foot: orbit; driving: small nudge for flavour only).
    if (!player.car) {
      this.cameraYaw += 0;
    }
    if (player.car && dt > 0) {
      // Let mouse orbit the car a little, then spring back to the tail.
      const look = this.input.takeLook();
      if (Math.abs(look.x) > 0) {
        this.orbitOffset = clamp((this.orbitOffset ?? 0) + look.x * 0.004, -1.2, 1.2);
      }
      this.orbitOffset = (this.orbitOffset ?? 0) * Math.exp(-2.4 * dt);
      // Rotate the rig around the car by orbitOffset.
      desired.applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.orbitOffset, new THREE.Vector3());
      const pivot = new THREE.Vector3(player.car.pos.x, 0, player.car.pos.z);
      desired.sub(pivot).applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.orbitOffset).add(pivot);
    } else {
      const look = this.input.takeLook();
      if (Math.abs(look.x) > 0 || Math.abs(look.y) > 0) {
        this.cameraYaw -= look.x * 0.0032;
        this.cameraPitch = clamp(this.cameraPitch + look.y * 0.0022, -0.15, 0.6);
      }
      const back = CAMERA.footDistance;
      const pitchHeight = CAMERA.footHeight + this.cameraPitch * 3.4;
      desired.set(
        player.pos.x - Math.sin(this.cameraYaw) * back,
        player.pos.y + pitchHeight,
        player.pos.z - Math.cos(this.cameraYaw) * back,
      );
      // Don't let the camera sit inside a building: pull it in toward the player.
      const probe = new THREE.Vector3(desired.x, 0, desired.z);
      if (this.world.isBlocked(probe.x, probe.z, 0.4)) {
        desired.x = player.pos.x - Math.sin(this.cameraYaw) * 2.4;
        desired.z = player.pos.z - Math.cos(this.cameraYaw) * 2.4;
        desired.y = player.pos.y + 2.4;
      }
    }

    // Ground clamp.
    desired.y = Math.max(desired.y, 1.2);

    if (snap) {
      this.camera.position.copy(desired);
      this.cameraLook.copy(target);
    } else {
      this.camera.position.lerp(desired, clamp(dt * (player.car ? 5.5 : 9), 0, 1));
      this.cameraLook.lerp(target, clamp(dt * 9, 0, 1));
    }

    // Impact shake.
    if (this.cameraShake > 0.001) {
      const s = this.cameraShake;
      this.camera.position.x += (Math.random() - 0.5) * s * 0.7;
      this.camera.position.y += (Math.random() - 0.5) * s * 0.5;
      this.camera.position.z += (Math.random() - 0.5) * s * 0.7;
      this.cameraShake *= 0.88;
    }

    this.camera.lookAt(this.cameraLook);
    // Slight FOV stretch at speed gives the chase a pulse.
    const fovTarget = CAMERA.fov + (player.car ? clamp(Math.abs(player.car.speed) / player.car.spec.topSpeed, 0, 1) * 9 : 0);
    this.camera.fov = damp(this.camera.fov, fovTarget, 4, dt);
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ loop

  _loop(now) {
    const raw = (now - this.lastTime) / 1000;
    this.lastTime = now;
    const dt = clamp(raw, 0, 0.1);

    if (this.mode === 'play') {
      this.accumulator += dt;
      let guard = 0;
      while (this.accumulator >= FIXED && guard < 6) {
        this._step(FIXED);
        this.accumulator -= FIXED;
        guard += 1;
      }
      this._updateCamera(dt);
    } else if (this.mode === 'title') {
      this._titleCamera(dt);
    }

    this.time += dt;
    this.renderer.render(this.scene, this.camera);
    this.hud.update(this._hudState());
    if (this.input) this.input.endFrame();
    requestAnimationFrame(this._loop);
  }

  _titleCamera(dt) {
    // A slow orbit over the harbour: the title screen's moving postcard.
    const t = this.time * 0.06;
    const r = 190;
    const cx = 60 + Math.cos(t) * r;
    const cz = -40 + Math.sin(t) * r;
    this.camera.position.set(cx, 88, cz);
    this.camera.lookAt(90, 0, -60);
    this.camera.fov = 58;
    this.camera.updateProjectionMatrix();
  }

  _step(dt) {
    const input = this.input;
    if (this.mode !== 'play') return;

    // Global keys.
    if (input.justPressed('pause')) { this.setMode('paused'); return; }
    if (input.justPressed('mute')) { audio.toggleMute(); }
    if (input.justPressed('weapon1')) this.player.setWeapon('pistol');
    if (input.justPressed('weapon2')) this.player.setWeapon('fists');
    if (input.justPressed('reload')) this.player.startReload();
    if (input.justPressed('enter')) this._handleEnter();
    if (input.justPressed('punch')) this._punch();
    if (this.player.weapon === 'pistol' && (input.firePressed() || (input.fireDown() && this.player.fireCooldown <= 0))) this._fire();
    if (input.justPressed('horn') && this.player.car && this.hornCooldown <= 0) {
      audio.horn(); this.hornCooldown = 0.6;
    }
    this.hornCooldown = Math.max(0, this.hornCooldown - dt);

    // Sim.
    this.player.step(dt, input, this.cameraYaw);
    if (this.player.car) this.vehicles.playerDrivingStep(this.player, input, dt);
    this.vehicles.pushApart(this.player.car);
    this.traffic.update(dt, this.player);
    this.police.update(dt);
    this.missions.update(dt, this);

    // Time of day: one full day every seven real minutes.
    this.dayMs += dt * 1000;
    this.clockMinutes = (TIME.startMinutes + (this.dayMs / TIME.realMsPerDay) * 1440) % 1440;
    if (Math.floor(this.time * 4) % 2 === 0) this.world.stepDay(this.clockMinutes);

    // Pedestrian hit by the player's car.
    if (this.player.car) {
      const hit = this.traffic.checkCarHits(this.player.car);
      if (hit) {
        this._spawnCrime('vehicular');
        this.traffic.scatter(hit.pos.x, hit.pos.z, 30);
        this.cameraShake = Math.max(this.cameraShake, 0.35);
      }
    }

    // Police shooting back on foot at high heat would be cruel; instead, contact damage.
    if (!this.player.car && this.police.stars >= 3) {
      for (const o of this.police.officers) {
        if (o.down) continue;
        if (dist(o.pos.x, o.pos.z, this.player.pos.x, this.player.pos.z) < 1.6) {
          this.player.hurt(22 * dt);
          if (this.player.dead) { this.setMode('wasted'); }
        }
      }
    }

    // Health zero wastes the player.
    if (this.player.health <= 0 && this.mode === 'play') this.setMode('wasted');

    this.world.update(dt, this.player.pos);
    this.vehicles.update(dt);

    this.vignetteFlash = Math.max(0, this.vignetteFlash - dt * 1.6);
    this.crimeFlash = Math.max(0, this.crimeFlash - dt * 0.8);

    audio.setEngine(
      this.player.car ? clamp(Math.abs(this.player.car.speed) / this.player.car.spec.topSpeed, 0, 1) : 0,
      this.player.car ? Math.abs(this.player.car.throttle) : 0,
    );
    audio.tickMusic(dt, this.police.stars > 0);

    // Prompt for the context line.
    const ent = this._nearestEnterableCar();
    if (this.player.car) {
      this.lastPrompt = 'E — get out · Shift — handbrake · H — horn';
    } else if (ent) {
      this.lastPrompt = ent.type === 'police' ? 'E — take the cruiser (2 stars)' : 'E — take the car';
    } else {
      this.lastPrompt = '';
    }
  }

  _hudState() {
    const ent = this.player.car ? null : this._nearestEnterableCar();
    let prompt = this.lastPrompt;
    if (this.mode !== 'play') prompt = '';
    return {
      player: this.player,
      game: this,
      mission: this.missions,
      police: this.police,
      traffic: this.vehicles,
      clockMinutes: this.clockMinutes,
      prompt,
    };
  }

  // ------------------------------------------------------------ shots

  async presentShot(name) {
    await runShot(this, name);
    return true;
  }
}

// ---------------------------------------------------------------- boot

function readSeed() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('seed');
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 7;
}

function boot() {
  const canvas = document.getElementById('game');
  const hudRoot = document.getElementById('hud');
  const overlay = document.getElementById('overlay');
  let game;
  try {
    game = new Game({ canvas, hudRoot, overlay, seed: readSeed() });
  } catch (err) {
    console.error('SOLMAR failed to boot:', err);
    document.body.dataset.bootError = String(err);
    return;
  }
  window.__game = game;
  window.__shotReady = false;

  const params = new URLSearchParams(window.location.search);
  const shot = params.get('shot');
  const seed = readSeed();
  window.SOLMAR_SEED = seed;

  const resize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    game.renderer.setSize(w, h, false);
    game.camera.aspect = w / Math.max(1, h);
    game.camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  // A shot query stages the frame instead of showing the title screen.
  if (shot && SHOT_PRESETS[shot]) {
    overlay.dataset.mode = 'play';
    for (const screen of overlay.querySelectorAll('.screen')) screen.classList.remove('show');
    game.mode = 'play';
    game.hud.update(game._hudState());
    // Expose the shot runner so tooling (and the page itself) can stage twice.
    window.__stageShot = async (name) => {
      window.__shotReady = false;
      await game.presentShot(name);
      return true;
    };
    window.__stageShot(shot).catch((err) => console.error('shot staging failed', err));
  } else {
    game.setMode('title');
    game.hud.update(game._hudState());
  }

  // A simple API the headless harnesses drive.
  window.SOLMAR = {
    game,
    start: () => game.startFresh(),
    continueSave: () => game.continueSave(),
    tick: (n = 1) => {
      for (let i = 0; i < n; i += 1) game._step(1 / 60);
      game.hud.update(game._hudState());
    },
    hudUpdate: () => game.hud.update(game._hudState()),
    state: () => ({
      mode: game.mode,
      stars: game.police.stars,
      cash: game.player.cash,
      health: game.player.health,
      mission: game.missions.index,
      step: game.missions.step,
      active: game.missions.active,
      complete: game.missions.complete,
      objective: game.missions.objectiveText,
      driving: !!game.player.car,
      pos: [game.player.pos.x, game.player.pos.z],
      buildings: game.world.buildingCount,
      cars: game.vehicles.vehicles.length,
      peds: game.traffic.peds.length,
      units: game.police.units.length,
      clock: game.clockMinutes,
    }),
    input: (override) => { game.input.setOverride(override); },
    teleport: (x, z, heading) => { game.player.teleport(x, z, heading ?? game.player.heading); },
    giveCar: (type = 'sedan') => {
      const car = game.vehicles.spawn(type, game.player.pos.x + 2, game.player.pos.z, game.player.heading);
      return !!car;
    },
    enterNearest: () => { const c = game._nearestEnterableCar(); if (c) { game.player.enterCar(c); return true; } return false; },
    exitCar: () => { const c = game.player.exitCar(); return !!c; },
    setStars: (n) => { game.police.stars = clamp(n, 0, 5); },
    raiseStars: (n = 1) => game.police.raise(n),
    forceJob: (i) => game.missions.forceStart(i),
    fire: () => game._fire(),
    punch: () => game._punch(),
    pause: () => game.setMode('paused'),
    resume: () => game.setMode('play'),
    save: () => game.saveGame(),
    respawn: (k) => game._respawn(k),
    stageShot: (name) => window.__stageShot(name),
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
