// Screenshot staging. Four pure presets (chase, onfoot, mission, night) that pose the world, park
// the cars, seat the pedestrians, set the HUD state, aim the camera and hand back a small per-frame
// script. The shared runner clears police and missions, sets play mode, runs the preset, steps the
// script, refreshes the HUD once, then sets __shotReady.

import * as THREE from 'three';
import { PALETTE, CITY, PLAYER, CAMERA } from './config.js';
import { clamp, seeded } from './random.js';
import { roadCenter } from './world.js';

const ROAD = CITY.road / 2;

function hideScreens(game) {
  game.overlay.dataset.mode = 'play';
  for (const s of game.overlay.querySelectorAll('.screen')) s.classList.remove('show');
  game.mode = 'play';
}

function clearScene(game) {
  game.police.clear();
  game.missions.reset();
  game.missions.beacon.visible = false;
  game.missions.packageMesh.visible = false;
  for (const v of [...game.vehicles.vehicles]) {
    if (v.jobCar) { game.vehicles.remove(v); }
  }
  // Remove every police cruiser and every non-parked car, so the preset owns the street.
  for (const v of [...game.vehicles.vehicles]) {
    if (v.type === 'police') game.vehicles.remove(v);
  }
  game.player.exitCar();
  game.player.car = null;
  game.player.show();
}

function resetTraffic(game) {
  // Move every existing traffic car out of the way, then re-seat the ones the preset wants.
  for (const entry of game.traffic.cars) {
    entry.vehicle.pos.set(0, 0, -CITY.bound - 200);
    entry.vehicle.group.position.set(0, 0, -CITY.bound - 200);
  }
}

function parkCar(game, type, x, z, heading, colour) {
  const car = game.vehicles.spawn(type, x, z, heading, colour !== undefined ? { color: colour } : {});
  car.ai = { kind: 'parked' };
  car.throttle = 0;
  car.brake = 0;
  return car;
}

function posePed(game, index, x, z, heading, fear = 0, running = false) {
  const ped = game.traffic.peds[index % game.traffic.peds.length];
  if (!ped) return null;
  game.traffic.pose(ped, x, z, heading, fear);
  const swing = running ? 0.8 : 0.42;
  ped.legL.rotation.x = swing;
  ped.legR.rotation.x = -swing;
  ped.armL.rotation.x = -swing * 0.85;
  ped.armR.rotation.x = swing * 0.85;
  ped.group.position.set(x, 0, z);
  ped.group.rotation.y = heading;
  return ped;
}

function aimCamera(game, pos, look, fov) {
  game.camera.position.set(pos[0], pos[1], pos[2]);
  game.cameraLook.set(look[0], look[1], look[2]);
  game.camera.fov = fov ?? CAMERA.fov;
  game.camera.updateProjectionMatrix();
  game.camera.lookAt(game.cameraLook);
}

function baseTick(game) {
  game.vehicles.updateParticles(1 / 60);
  game.world.stepProps(1 / 60);
  for (const car of game.vehicles.vehicles) car.stepVisuals(1 / 60, game.vehicles);
}

function setHudState(game, { cash, clock, health, stars, ammo, reserve, weapon, prompt }) {
  game.player.cash = cash;
  game.clockMinutes = clock;
  game.player.health = health;
  game.police.stars = stars;
  game.police.heat = clamp(stars / 5, 0, 1);
  game.player.ammo = ammo;
  game.player.reserve = reserve;
  game.player.weapon = weapon ?? 'pistol';
  game.player.reloading = 0;
  game.player.pistolVisible = true;
  game.lastPrompt = prompt ?? '';
  game.world.stepDay(clock);
}

// ---------------------------------------------------------------- presets

const chase = {
  ticks: 12,
  stage(game) {
    resetTraffic(game);
    const rng = seeded(7, 4242);
    // The hero: a red sports car mid-drift, tail out, on the north-south road at x = 0.
    const hero = parkCar(game, 'sports', 1.6, -46, 0.18, 0xd8332f);
    hero.speed = 21;
    hero.handbrake = true;
    hero.steer = 0.55;
    hero.bodyRoll = 0.1;
    hero.vel.set(4.5, 0, 20);
    hero.health = hero.maxHealth * 0.74;
    hero.braking = true;
    // A couple of skid marks and smoke puffs already on the road.
    for (let i = 0; i < 14; i += 1) game.vehicles.emitSkid(hero);
    for (let i = 0; i < 10; i += 1) game.vehicles.emitSmoke(hero, 0.8);
    // Skid marks trail behind the car along its path.
    for (let i = 0; i < 26; i += 1) {
      const slot = game.vehicles.skidPool.find((s) => s.life <= 0);
      if (!slot) break;
      const t = i / 26;
      slot.mesh.position.set(hero.pos.x + 1.1 + Math.sin(t * 2) * 0.6, 0.035, hero.pos.z - 2 - i * 1.1);
      slot.mesh.rotation.z = -hero.heading;
      slot.mesh.scale.set(1, 1.8, 1);
      slot.mesh.visible = true;
      slot.mesh.material.opacity = 0.42;
      slot.life = 12;
    }
    game.player.car = hero;
    hero.occupied = true;
    game.player.hide();

    // Two cruisers closing, one red bar and one blue.
    const p1 = parkCar(game, 'police', -1.2, -66, 0.05);
    p1.setLightMode('red');
    p1.speed = 15;
    const p2 = parkCar(game, 'police', 5.2, -79, 0.1);
    p2.setLightMode('blue');
    p2.speed = 17;

    // Traffic cars on the road ahead, all heading away.
    parkCar(game, 'taxi', -6.2, 4, Math.PI, 0xf2c53d);
    parkCar(game, 'sedan', 6.4, 26, Math.PI, 0x8fb3c9);
    parkCar(game, 'truck', -6.6, 48, Math.PI, 0xd9d4c6);

    // Pedestrians fleeing on both pavements.
    for (let i = 0; i < 8; i += 1) {
      const side = i % 2 === 0 ? -1 : 1;
      posePed(game, i, side * (ROAD + 2.6) + rng.range(-1.4, 1.4), -30 + i * 7.5, side * 1.4, 3, true);
    }

    // A big mission beacon up the road.
    game.missions.index = 2;
    game.missions.step = 1;
    game.missions.active = true;
    game.missions.beacon.position.set(-1, 0, 44);
    game.missions.beacon.visible = true;
    game.missions.packageMesh.visible = false;

    setHudState(game, { cash: 1450, clock: 17 * 60 + 20, health: 74, stars: 3, ammo: 9, reserve: 36 });
    game.police.heat = 0.8;

    aimCamera(game, [1.4, 3.6, -58.5], [0.6, 2.2, 12], 64);
    game.world.liftNight(1);
  },
  tick(game) { baseTick(game); },
};

const onfoot = {
  ticks: 8,
  stage(game) {
    resetTraffic(game);
    const rng = seeded(7, 91);
    // The player stands by a damaged blue sedan with its brake lights on.
    const sedan = parkCar(game, 'sedan', 4.4, -150, Math.PI / 2, 0x6f8fb5);
    sedan.health = sedan.maxHealth * 0.42;
    sedan.braking = true;
    sedan.tailMat.emissiveIntensity = 3.4;
    sedan.tailGlowMat.opacity = 0.7;
    sedan.bodyMesh.material.color.setHex(0x5b7897);

    game.player.teleport(-2.6, -151.4, 1.25);
    game.player.show();
    game.player.aiming = false;
    game.player.gun.visible = false;

    // A taxi, a truck and another sedan passing on the road.
    const taxi = parkCar(game, 'taxi', -3.4, -128, Math.PI, 0xf2c53d);
    taxi.speed = 9;
    const truck = parkCar(game, 'truck', 3.6, -186, 0, 0xd9d4c6);
    truck.speed = 7;
    const other = parkCar(game, 'sedan', 6.2, -108, Math.PI, 0xd6d2c4);
    other.speed = 11;

    // Seven pedestrians walking the pavement.
    for (let i = 0; i < 7; i += 1) {
      const x = -14 - rng.range(0, 6) + (i % 3) * 5;
      posePed(game, i, x, -168 + i * 6.4, 0.2 + i * 0.2, 0, false);
    }

    // A mission beacon down the road.
    game.missions.index = 0;
    game.missions.step = 1;
    game.missions.active = true;
    game.missions.beacon.position.set(0, 0, -112);
    game.missions.beacon.visible = true;

    // Two static officers in the middle distance.
    game.police.placeOfficers([
      { x: 14, z: -132, heading: -1.6 },
      { x: 16.6, z: -129, heading: -1.9 },
    ]);

    setHudState(game, { cash: 640, clock: 17 * 60 + 5, health: 88, stars: 1, ammo: 11, reserve: 37, prompt: 'E — take the car' });
    game.police.heat = 0.2;

    aimCamera(game, [-11.5, 3.1, -161.5], [1.4, 1.5, -147], 60);
    game.world.liftNight(1);
  },
  tick(game) { baseTick(game); },
};

const mission = {
  ticks: 8,
  stage(game) {
    resetTraffic(game);
    const rng = seeded(7, 12);
    // The marina case, green with a glow column, under a big beacon.
    game.missions.index = 2;
    game.missions.step = 0;
    game.missions.active = true;
    game.missions.packageMesh.position.set(282, 0, -150);
    game.missions.packageMesh.visible = true;
    game.missions.beacon.position.set(282, 0, -150);
    game.missions.beacon.visible = true;

    game.player.teleport(278.5, -147.5, 2.5);
    game.player.show();

    // Two cruisers closing with opposite light bars.
    const p1 = parkCar(game, 'police', 264, -152, Math.PI / 2 + 0.15);
    p1.setLightMode('red');
    p1.speed = 12;
    const p2 = parkCar(game, 'police', 268, -141, Math.PI / 2 - 0.2);
    p2.setLightMode('blue');
    p2.speed = 14;

    // A parked white sedan and five pedestrians.
    parkCar(game, 'sedan', 291, -160, Math.PI * 0.9, 0xf0eae0);
    for (let i = 0; i < 5; i += 1) {
      posePed(game, i, 288 + rng.range(-4, 4), -156 + i * 4.2, -1.2 + rng.range(-0.4, 0.4), 1.4, i % 2 === 0);
    }

    setHudState(game, { cash: 980, clock: 19 * 60 + 30, health: 61, stars: 2, ammo: 7, reserve: 24 });
    game.police.heat = 0.55;

    aimCamera(game, [269, 4.4, -159], [283, 2.4, -149], 62);
    game.world.liftNight(1.05);
  },
  tick(game) { baseTick(game); },
};

const night = {
  ticks: 10,
  stage(game) {
    resetTraffic(game);
    const rng = seeded(7, 77);
    // A green sports car at night with headlights on, framed fully inside a wider lens.
    const hero = parkCar(game, 'sports', -1.4, -20, 0.06, 0x2fa36b);
    hero.speed = 16;
    hero.throttle = 0.5;
    game.player.car = hero;
    hero.occupied = true;
    game.player.hide();

    // One cruiser behind with a blue bar.
    const cop = parkCar(game, 'police', 0.4, -40, 0.04);
    cop.setLightMode('blue');
    cop.speed = 14;

    // A taxi ahead and a sedan oncoming.
    parkCar(game, 'taxi', 3.6, 24, Math.PI, 0xf2c53d);
    parkCar(game, 'sedan', -5.6, 62, 0, 0x8fb3c9);

    // Six pedestrians on the pavements.
    for (let i = 0; i < 6; i += 1) {
      const side = i % 2 === 0 ? -1 : 1;
      posePed(game, i, side * (ROAD + 2.8) + rng.range(-1.2, 1.2), -6 + i * 8.5, side * 1.5, 0.8, false);
    }

    // A beacon far down the road.
    game.missions.index = 3;
    game.missions.step = 2;
    game.missions.active = true;
    game.missions.beacon.position.set(0, 0, 96);
    game.missions.beacon.visible = true;

    setHudState(game, { cash: 3120, clock: 23 * 60 + 40, health: 92, stars: 2, ammo: 12, reserve: 48 });
    game.police.heat = 0.5;

    // Night must be bright, not murky: lift sky, fog, sun, hemi, ambient, exposure and glow.
    const world = game.world;
    world.liftNight(1.55);
    world.sun.intensity = Math.max(world.sun.intensity, 0.62);
    world.hemi.intensity = Math.max(world.hemi.intensity, 0.68);
    world.ambient.intensity = Math.max(world.ambient.intensity, 0.52);
    world.scene.fog.near = 55;
    world.scene.fog.far = 640;
    world.scene.fog.color.setHex(0x2c4160);
    world.skyUniforms.topColor.value.setHex(0x1d3564);
    world.skyUniforms.horizonColor.value.setHex(0x40608c);
    world.skyUniforms.nightMix.value = 0.35;
    game.renderer.toneMappingExposure = 1.95;

    aimCamera(game, [-2.2, 3.4, -34.5], [-0.8, 1.5, 6], 70);
  },
  tick(game) { baseTick(game); },
};

export const SHOT_PRESETS = { chase, onfoot, mission, night };

/** The shared runner. */
export async function runShot(game, name) {
  const preset = SHOT_PRESETS[name];
  if (!preset) throw new Error(`unknown shot: ${name}`);
  hideScreens(game);
  clearScene(game);
  // Reset exposure/glow so a second staging does not stack lifts.
  game.renderer.toneMappingExposure = CAMERA.exposure;
  game.world.liftNight(1);
  game.world.stepDay(game.world.clockMinutes);

  preset.stage(game);
  const ticks = preset.ticks ?? 8;
  for (let i = 0; i < ticks; i += 1) preset.tick(game, i);

  // One more camera settle so the staged pose is exactly what is rendered.
  game.camera.lookAt(game.cameraLook);
  game.camera.updateMatrixWorld();
  game.hud.update(game._hudState());
  game.world.update(1 / 60, game.player.pos);

  // Let the compositor draw two frames so WebGL has the final buffers.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  game.renderer.render(game.scene, game.camera);
  game.hud.update(game._hudState());
  window.__shotReady = true;
  return true;
}
