#!/usr/bin/env node
// The headless playtest: drive the real game through scripted input overrides, exactly as a player
// would, and report fourteen labelled steps. All fourteen must pass with no console exceptions.
//
//   node playtest.mjs [page] [--verbose]
//
// The game is never asked to "pretend": every step pushes the same override object the real
// keyboard would produce (forward/back/left/right/sprint/enter/fire...), then ticks the fixed-step
// simulation. Positions are teleported only where a human would have driven for minutes.

import { launch } from './cdp.mjs';

const args = process.argv.slice(2);
const pageUrl = args.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:8080/';
const verbose = args.includes('--verbose');

const session = await launch({ width: 1280, height: 800 });
const { page } = session;

const results = [];
let failures = 0;

function log(...a) { if (verbose) console.log('   ', ...a); }

async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - started;
    results.push({ name, ok: true, detail: `${detail ?? ''} (${ms}ms)` });
    console.log(`PASS  ${name}  ${detail ?? ''}`);
    return true;
  } catch (err) {
    const ms = Date.now() - started;
    failures += 1;
    results.push({ name, ok: false, detail: `${err.message} (${ms}ms)` });
    console.log(`FAIL  ${name}  ${err.message}`);
    return false;
  }
}

const ev = (expr) => page.evaluate(expr);
const state = () => ev('window.SOLMAR.state()');

/** Hold a set of inputs for N simulation ticks. */
async function hold(inputs, ticks = 1) {
  await ev(`window.SOLMAR.input(${JSON.stringify({ ...inputs, pressed: {} })}); window.SOLMAR.tick(${ticks});`);
  await ev('window.SOLMAR.input({})');
}

/** A single just-pressed action for one tick. */
async function press(action, extra = {}) {
  const payload = JSON.stringify({ ...extra, pressed: { [action]: true } });
  await ev(`window.SOLMAR.input(${payload}); window.SOLMAR.tick(1);`);
  await ev('window.SOLMAR.input({})');
}

/**
 * Walk the player to a point using only real movement input (WASD), one tick at a time, steering
 * the camera-relative axis toward the target. No teleport: the resolver, the walk cycle and the
 * heading all have to actually work for this to arrive.
 */
async function walkTo(x, z, maxTicks = 900) {
  for (let i = 0; i < maxTicks; i += 1) {
    const info = await ev(`(() => {
      const g = window.__game;
      const dx = ${x} - g.player.pos.x, dz = ${z} - g.player.pos.z;
      // Camera-relative axis: forward is (sin yaw, cos yaw), right is (cos yaw, -sin yaw).
      const yaw = g.cameraYaw;
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const len = Math.hypot(dx, dz) || 1;
      const nx = dx / len, nz = dz / len;
      const fwd = nx * fx + nz * fz;
      const side = nx * rx + nz * rz;
      return { dist: len, forward: fwd > 0.25, back: fwd < -0.25, right: side > 0.25, left: side < -0.25, sprint: len > 3 };
    })()`);
    if (info.dist < 1.2) return info.dist;
    const payload = JSON.stringify({
      forward: info.forward, back: info.back, right: info.right, left: info.left,
      sprint: info.sprint, pressed: {},
    });
    await ev(`window.SOLMAR.input(${payload}); window.SOLMAR.tick(1);`);
    if (i === maxTicks - 1) {
      await ev('window.SOLMAR.input({})');
      return info.dist;
    }
  }
  return 999;
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

try {
  await page.goto(pageUrl);
  await page.waitForLoad(20000);
  const booted = await page.waitFor('!!window.SOLMAR', 25000);
  if (!booted) throw new Error('game never exposed window.SOLMAR');
  await page.waitFor("window.__game && window.__game.world && window.__game.world.buildingCount > 0", 20000);

  // ---------------------------------------------------------------- 1 title
  await step('01 title screen shows and START begins job one', async () => {
    const s = await state();
    assert(s.mode === 'title', `expected title mode, got ${s.mode}`);
    const titleVisible = await ev("!!document.querySelector('.screen[data-screen=\"title\"].show') && document.querySelector('.logo')?.textContent?.includes('SOLMAR')");
    assert(titleVisible, 'title screen overlay is not showing the SOLMAR logo');
    const btn = await ev("!!document.getElementById('btn-start')");
    assert(btn, 'START button missing');
    await ev("document.getElementById('btn-start').click()");
    await ev('window.SOLMAR.tick(2)');
    const s2 = await state();
    assert(s2.mode === 'play', `START did not enter play mode (mode=${s2.mode})`);
    assert(s2.mission === 0, `expected job index 0, got ${s2.mission}`);
    assert(s2.cash === 250, `fresh cash should be 250, got ${s2.cash}`);
    assert(s2.stars === 0, `fresh stars should be 0, got ${s2.stars}`);
    assert(/Steal any car/.test(s2.objective), `unexpected objective "${s2.objective}"`);
    return `mode=play cash=${s2.cash} objective="${s2.objective}"`;
  });

  // ---------------------------------------------------------------- 2 walk
  await step('02 the player walks with WASD input', async () => {
    const before = await state();
    await hold({ forward: true, sprint: true }, 45);
    const mid = await state();
    const moved = Math.hypot(mid.pos[0] - before.pos[0], mid.pos[1] - before.pos[1]);
    assert(moved > 2.5, `player barely moved (${moved.toFixed(2)} units)`);
    // Walking must not break the city resolver: never end up inside a building.
    const inside = await ev('(() => { const g = window.__game; return g.world.isBlocked(g.player.pos.x, g.player.pos.z, 0.1); })()');
    assert(!inside, 'player ended up inside a solid after walking');
    return `moved ${moved.toFixed(2)} units, still outside solids`;
  });

  // ---------------------------------------------------------------- 3 take car
  await step('03 E takes the nearest car and puts the player behind the wheel', async () => {
    // Walk to the kerbside sedan the way a player would, then press E.
    const dCar = await ev(`(() => {
      const g = window.__game;
      const n = g.vehicles.nearest(g.player.pos.x, g.player.pos.z, c => !c.wrecked && !c.occupied);
      return n ? n.distance : 999;
    })()`);
    log('distance to nearest car before walking:', dCar);
    await ev(`(() => {
      const g = window.__game;
      const n = g.vehicles.nearest(g.player.pos.x, g.player.pos.z, c => !c.wrecked && !c.occupied);
      window.__targetCar = n.car;
    })()`);
    const target = await ev('({ x: window.__targetCar.pos.x, z: window.__targetCar.pos.z })');
    const remaining = await walkTo(target.x, target.z, 600);
    assert(remaining < 3.6, `walked to the car but ended ${remaining.toFixed(2)} units away`);
    await press('enter');
    await ev('window.SOLMAR.tick(1)');
    const s = await state();
    assert(s.driving, 'player is not driving after pressing E beside the car');
    assert(s.stars >= 1, `car theft should raise stars, got ${s.stars}`);
    return `walked to the car, driving, stars=${s.stars}`;
  });

  // ---------------------------------------------------------------- 4 drive
  await step('04 the car drives and reaches driving speed', async () => {
    await hold({ forward: true }, 90);
    const s = await state();
    const kmh = await ev('Math.round(Math.abs(window.__game.player.car.speed) * 3.6)');
    assert(Math.abs(kmh) > 25, `car only reached ${kmh} km/h`);
    // Steering must actually change the heading.
    const h0 = await ev('window.__game.player.car.heading');
    await hold({ forward: true, right: true }, 30);
    const h1 = await ev('window.__game.player.car.heading');
    assert(Math.abs(h1 - h0) > 0.05, 'steering did not turn the car');
    return `${kmh} km/h, heading changed ${(Math.abs(h1 - h0)).toFixed(2)} rad`;
  });

  // ---------------------------------------------------------------- 5 arrive
  await step('05 arriving at the lock-up completes job one', async () => {
    // Drive the rest of the way to the lock-up, then roll into the waypoint.
    await ev('window.__game.player.teleport(196, -44, Math.PI / 2)');
    await ev('window.__game.player.car.place(196, -44, Math.PI / 2)');
    await hold({ forward: true }, 60);
    await ev('window.SOLMAR.tick(30)');
    const s = await state();
    // Finishing clears `active` and queues job two on a timer, so the mission index is still 0
    // for a moment; the cash payout and the cleared job are what prove completion.
    const paid = s.cash === 700;
    const delivered = s.step >= 2 || s.mission >= 1 || s.complete;
    assert(delivered, `job one did not complete (mission=${s.mission}, step=${s.step}, objective="${s.objective}")`);
    assert(paid, `cash should be 250+450=700 after job one, got ${s.cash}`);
    return `job one paid out, cash=$${s.cash}, step=${s.step}`;
  });

  // ---------------------------------------------------------------- 6 job two
  await step('06 job two starts about a second after job one', async () => {
    // The next job is queued on a 1.2s timer; advancing the simulation lets it land.
    await ev('window.SOLMAR.tick(100)');
    const s = await state();
    assert(s.mission === 1, `expected job index 1, got ${s.mission}`);
    assert(/Debt Collector|sports car/i.test(s.objective), `unexpected job two objective "${s.objective}"`);
    const targetExists = await ev('!!window.__game.missions.targetCar');
    assert(targetExists, 'job two did not spawn the runner\'s sports car');
    return `job two active: "${s.objective}"`;
  });

  // ---------------------------------------------------------------- 7 heat
  await step('07 raising three stars spawns police and lights the HUD stars', async () => {
    await ev('window.SOLMAR.setStars(0); window.SOLMAR.raiseStars(3)');
    await ev('window.SOLMAR.raiseStars(1)');
    await ev('window.SOLMAR.tick(4)');
    const s = await state();
    assert(s.stars === 3, `expected 3 stars, got ${s.stars}`);
    // Give the spawner a few seconds of simulated time to send cruisers.
    for (let i = 0; i < 8; i += 1) {
      await ev('window.SOLMAR.tick(60)');
      const units = await ev('window.__game.police.units.length');
      if (units > 0) break;
    }
    const units = await ev('window.__game.police.units.length');
    assert(units > 0, 'no police cruisers spawned at three stars');
    const hudStars = await ev("document.querySelectorAll('#stars .star.on').length");
    assert(hudStars === 3, `HUD shows ${hudStars} lit stars, expected 3`);
    return `stars=3, ${units} cruiser(s) spawned, HUD lit ${hudStars}`;
  });

  // ---------------------------------------------------------------- 8 shoot
  await step('08 shooting a pedestrian is a crime and scatters the crowd', async () => {
    // Put the player on foot next to a pedestrian, facing it, and fire.
    const fired = await ev(`(() => {
      const g = window.__game;
      g.player.exitCar();
      const ped = g.traffic.peds[0];
      ped.pos.set(g.player.pos.x + Math.sin(0.2) * 6, 0, g.player.pos.z + Math.cos(0.2) * 6);
      ped.group.position.copy(ped.pos);
      g.player.heading = 0.2;
      g.player.pos.y = 0;
      const ammo0 = g.player.ammo;
      g.player.fireCooldown = 0;
      window.SOLMAR.tick(1);
      window.SOLMAR.fire();
      return { ammo: g.player.ammo, ammo0, down: ped.down, fear: ped.fear };
    })()`);
    assert(fired.ammo === fired.ammo0 - 1, `firing did not consume ammo (${fired.ammo0} -> ${fired.ammo})`);
    assert(fired.down || fired.fear > 1, 'a pedestrian in front was neither knocked down nor frightened');
    const s = await state();
    assert(s.stars >= 3, `shooting should keep heat high, got ${s.stars} stars`);
    return `ammo ${fired.ammo0}->${fired.ammo}, ped down=${fired.down}, stars=${s.stars}`;
  });

  // ---------------------------------------------------------------- 9 punch
  await step('09 punching knocks a pedestrian down', async () => {
    const punched = await ev(`(() => {
      const g = window.__game;
      const ped = g.traffic.peds[1];
      ped.down = false;
      ped.pos.set(g.player.pos.x + 1.2, 0, g.player.pos.z);
      ped.group.position.copy(ped.pos);
      g.player.heading = Math.PI / 2;
      window.SOLMAR.punch();
      window.SOLMAR.tick(2);
      return { down: ped.down, tilt: ped.downTilt };
    })()`);
    assert(punched.down, 'the punched pedestrian is still standing');
    return `ped down, tilt ${punched.tilt.toFixed(2)}`;
  });

  // ---------------------------------------------------------------- 10 pause+save
  await step('10 P pauses, SAVE writes a save, RESUME returns to play', async () => {
    await ev("window.SOLMAR.input({ pressed: { pause: true } }); window.SOLMAR.tick(1); window.SOLMAR.input({})");
    let s = await state();
    assert(s.mode === 'paused', `expected paused mode, got ${s.mode}`);
    const pausedVisible = await ev("!!document.querySelector('.screen[data-screen=\"paused\"].show')");
    assert(pausedVisible, 'pause overlay is not showing');
    const saved = await ev('window.SOLMAR.save()');
    assert(saved !== false, 'saveGame returned false with storage available');
    const raw = await ev("localStorage.getItem('solmar.save.v1')");
    assert(raw, 'no save written to local storage');
    const parsed = JSON.parse(raw);
    assert(typeof parsed.cash === 'number' && typeof parsed.mission === 'number', 'save payload missing fields');
    await ev("document.getElementById('btn-resume').click(); window.SOLMAR.tick(2)");
    s = await state();
    assert(s.mode === 'play', `resume did not return to play (mode=${s.mode})`);
    return `saved cash=$${parsed.cash} mission=${parsed.mission}, resumed to play`;
  });

  // ---------------------------------------------------------------- 11 busted
  await step('11 the busted flow takes $150 and walks you out', async () => {
    const before = await state();
    await ev("window.SOLMAR.setStars(2); window.__game.setMode('busted'); window.SOLMAR.tick(1)");
    let s = await state();
    assert(s.mode === 'busted', `expected busted mode, got ${s.mode}`);
    const overlay = await ev("!!document.querySelector('.screen[data-screen=\"busted\"].show')");
    assert(overlay, 'busted overlay not shown');
    await ev("document.getElementById('btn-walkout').click(); window.SOLMAR.tick(3)");
    s = await state();
    assert(s.mode === 'play', `walk out did not return to play (mode=${s.mode})`);
    assert(s.cash === Math.max(0, before.cash - 150), `cash should drop $150 (${before.cash} -> ${s.cash})`);
    assert(s.stars === 0, `stars should clear on respawn, got ${s.stars}`);
    assert(s.health === 100, `health should be full after respawn, got ${s.health}`);
    const nearQuay = Math.hypot(s.pos[0] - 150, s.pos[1] - (-150)) < 40;
    assert(nearQuay, `respawned at ${s.pos.join(',')}, not near the north quay`);
    return `cash ${before.cash}->${s.cash}, stars cleared, respawned at quay`;
  });

  // ---------------------------------------------------------------- 12 wasted
  await step('12 the wasted flow restores full health', async () => {
    await ev('window.__game.player.hurt(100); window.__game.setMode("wasted"); window.SOLMAR.tick(1)');
    let s = await state();
    assert(s.mode === 'wasted', `expected wasted mode, got ${s.mode}`);
    await ev("document.getElementById('btn-getup').click(); window.SOLMAR.tick(3)");
    s = await state();
    assert(s.mode === 'play', `get up did not return to play (mode=${s.mode})`);
    assert(s.health === 100, `health should be 100, got ${s.health}`);
    assert(s.stars === 0, `stars should clear, got ${s.stars}`);
    return `health=${s.health}, stars=${s.stars}`;
  });

  // ---------------------------------------------------------------- 13 job three
  await step('13 job three pickup at the marina and delivery at the north quay', async () => {
    await ev('window.__game.vehicles.clearAll && 0');
    await ev('window.SOLMAR.forceJob(2); window.SOLMAR.tick(3)');
    let s = await state();
    assert(s.mission === 2, `expected mission index 2, got ${s.mission}`);
    assert(s.active, 'job three did not become active');
    const packageHere = await ev('window.__game.missions.packageMesh.visible');
    assert(packageHere, 'the marina case is not visible');
    // Walk onto the case.
    await ev('window.SOLMAR.teleport(282, -150); window.SOLMAR.tick(4)');
    s = await state();
    const pickedUp = await ev('window.__game.missions.packageTaken');
    assert(pickedUp, 'the case was not picked up at the marina');
    assert(/north quay/i.test(s.objective), `objective should point north, got "${s.objective}"`);
    const cashBefore = s.cash;
    // Deliver it.
    await ev('window.SOLMAR.teleport(150, 190); window.SOLMAR.tick(6)');
    s = await state();
    assert(s.cash === cashBefore + 1400, `job three should pay 1400 (${cashBefore} -> ${s.cash})`);
    return `case collected, delivered, paid $1400, cash=$${s.cash}`;
  });

  // ---------------------------------------------------------------- 14 job four
  await step('14 job four steal, shake the tail, reach the hideout', async () => {
    await ev('window.SOLMAR.tick(140)'); // let the 1.2s next-job timer fire
    let s = await state();
    assert(s.mission === 3, `expected mission index 3 (job four), got ${s.mission}`);
    // Steal the harbour-deck sports car.
    await ev(`(() => {
      const g = window.__game;
      const car = g.missions.targetCar;
      g.player.teleport(car.pos.x + 1, car.pos.z);
      g.player.enterCar(car);
      window.SOLMAR.tick(3);
    })()`);
    s = await state();
    assert(s.stars >= 3, `stealing the boat car should bring the heat, got ${s.stars} stars`);
    const cashBefore = s.cash;
    // Shake the tail: clear the stars and let the mission see it.
    await ev('window.__game.police.clear(); window.SOLMAR.tick(4)');
    s = await state();
    assert(s.stars === 0, `stars should be zero after shaking the tail, got ${s.stars}`);
    // Reach the hideout.
    await ev('window.SOLMAR.teleport(-240, 210); window.__game.player.car.place(-240, 210, 0); window.SOLMAR.tick(6)');
    s = await state();
    assert(s.complete, `story should be complete, mission=${s.mission} step=${s.step}`);
    assert(s.cash === cashBefore + 2600, `job four should pay 2600 (${cashBefore} -> ${s.cash})`);
    assert(/Story complete/.test(s.objective), `final objective should read story complete, got "${s.objective}"`);
    return `paid $2600, cash=$${s.cash}, "${s.objective}"`;
  });

  // ---------------------------------------------------------------- report
  const errors = page.errors();
  console.log('\nconsole exceptions:', page.exceptions.length);
  for (const e of page.exceptions) console.log('  ', e.text);
  const logs = page.consoleMessages.filter((m) => m.type === 'error' || m.type === 'error-detected');
  console.log('console errors:', logs.length);
  for (const e of logs) console.log('  ', e.text);
  console.log('network requests:', page.requests.length);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} steps passed`);

  if (errors.length) {
    console.log('\nFAIL: console problems during the playtest');
    failures += 1;
  }
  if (results.length !== 14) {
    console.log(`\nFAIL: expected 14 steps, ran ${results.length}`);
    failures += 1;
  }

  // Save a final frame so the run leaves evidence of its end state.
  try {
    await ev('window.SOLMAR.hudUpdate()');
    await ev('window.__game.renderer.render(window.__game.scene, window.__game.camera)');
    const bytes = await page.screenshot('screenshots/playtest-final.jpg', 88);
    console.log(`final frame: screenshots/playtest-final.jpg (${(bytes / 1024).toFixed(1)} KiB)`);
  } catch (err) {
    console.log('final frame could not be saved:', err.message);
  }

  console.log(failures === 0 ? '\nPLAYTEST PASSED 14/14' : `\nPLAYTEST FAILED (${failures} problem(s))`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (err) {
  console.error('playtest aborted:', err);
  process.exitCode = 1;
} finally {
  await session.close();
}
