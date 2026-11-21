#!/usr/bin/env node
// A tiny prober: load the page, report boot errors and the counts the build cares about.
//   node probe.mjs <page> [width] [height]

import { launch } from './cdp.mjs';

const [, , page = 'http://127.0.0.1:8080/', wArg, hArg] = process.argv;
const width = Number.parseInt(wArg ?? '1280', 10) || 1280;
const height = Number.parseInt(hArg ?? '800', 10) || 800;

const session = await launch({ width, height });
const { page: p } = session;
try {
  await p.goto(page);
  await p.waitForLoad(20000);
  const booted = await p.waitFor('!!window.__game', 20000);
  const state = booted
    ? await p.evaluate(`(() => {
        const g = window.__game;
        const w = g.world;
        return {
          mode: g.mode,
          seed: g.seed,
          buildings: w.buildingCount,
          buildingBoxes: w.boxes.length,
          props: w.props.length,
          cars: g.vehicles.vehicles.length,
          trafficCars: g.traffic.cars.length,
          peds: g.traffic.peds.length,
          parkingSpots: w.parkingSpots.length,
          glowMaterials: w.glowMaterials.length,
          lamps: w.lampSpots.length,
          canvas: [g.renderer.domElement.width, g.renderer.domElement.height],
          objective: g.missions.objectiveText,
        };
      })()`)
    : null;

  console.log('booted:', booted);
  console.log('state:', JSON.stringify(state, null, 2));
  console.log('exceptions:', p.exceptions.length);
  for (const e of p.exceptions) console.log('  ', e.text);
  const errs = p.consoleMessages.filter((m) => m.type === 'error' || m.type === 'error-detected');
  console.log('console errors:', errs.length);
  for (const e of errs) console.log('  ', e.text);
  console.log('requests:', p.requests.length);
  if (!booted || p.exceptions.length || errs.length) process.exitCode = 1;
} finally {
  await session.close();
}
