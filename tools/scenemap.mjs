#!/usr/bin/env node
// verify.py's companion for a first look: downscale checks are in verify.py. This dumps the scene
// map of a shot URL (where the cars, peds and camera actually are) so composition problems are
// diagnosable instead of guessed at.

import { launch } from './cdp.mjs';

const [, , url = 'http://127.0.0.1:8080/?shot=chase&seed=7'] = process.argv;

const session = await launch();
const { page } = session;
try {
  await page.goto(url);
  await page.waitForLoad(20000);
  await page.waitFor('window.__shotReady === true', 30000);
  const map = await page.evaluate(`(() => {
    const g = window.__game;
    const cam = g.camera;
    const project = (x, y, z) => {
      const v = new (window.__THREE_V3 || Object)();
      // Project with the camera matrices straight off the three object.
      const p = { x, y, z };
      const m = cam.matrixWorldInverse;
      const e = cam.projectionMatrix.elements;
      const mw = m.elements;
      const vx = mw[0]*p.x + mw[4]*p.y + mw[8]*p.z + mw[12];
      const vy = mw[1]*p.x + mw[5]*p.y + mw[9]*p.z + mw[13];
      const vz = mw[2]*p.x + mw[6]*p.y + mw[10]*p.z + mw[14];
      const cx = e[0]*vx + e[4]*vy + e[8]*vz + e[12];
      const cy = e[1]*vx + e[5]*vy + e[9]*vz + e[13];
      const cw = e[3]*vx + e[7]*vy + e[11]*vz + e[15];
      const ndcX = cx / cw, ndcY = cy / cw;
      return {
        sx: Math.round((ndcX * 0.5 + 0.5) * innerWidth),
        sy: Math.round((-ndcY * 0.5 + 0.5) * innerHeight),
        behind: cw <= 0,
      };
    };
    const cars = g.vehicles.vehicles.map((c) => ({
      type: c.type,
      pos: [Math.round(c.pos.x), Math.round(c.pos.z)],
      screen: project(c.pos.x, 1, c.pos.z),
    }));
    const camPos = cam.position;
    return {
      cam: { pos: [Math.round(camPos.x), Math.round(camPos.y), Math.round(camPos.z)], fov: cam.fov },
      look: [Math.round(g.cameraLook.x), Math.round(g.cameraLook.y), Math.round(g.cameraLook.z)],
      exposure: g.renderer.toneMappingExposure,
      stars: g.police.stars,
      cash: g.player.cash,
      clock: Math.round(g.clockMinutes),
      mode: g.mode,
      viewport: [innerWidth, innerHeight],
      cars,
      peds: g.traffic.peds.slice(0, 10).map((p) => ({ pos: [Math.round(p.pos.x), Math.round(p.pos.z)], screen: project(p.pos.x, 1, p.pos.z) })),
      beacon: g.missions.beacon.visible ? { pos: [g.missions.beacon.position.x, g.missions.beacon.position.z], screen: project(g.missions.beacon.position.x, 4, g.missions.beacon.position.z) } : null,
    };
  })()`);
  console.log(JSON.stringify(map, null, 2));
} finally {
  await session.close();
}
