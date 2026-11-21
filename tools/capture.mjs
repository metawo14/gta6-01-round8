#!/usr/bin/env node
// Screenshot one page with the Playwright Chromium binary over the DevTools protocol.
//
//   node capture.mjs <page> <outfile> [width] [height] [wait ms]
//
// Waits until window.__shotReady is true (staged presets) or a menu overlay is showing (the title
// screen), waits a beat, then captures a JPEG at quality 90 and prints the page state, any console
// messages and exceptions, the network requests, and the screenshot size.

import { launch } from './cdp.mjs';

const [, , page, outfile, wArg, hArg, waitArg] = process.argv;
if (!page || !outfile) {
  console.error('usage: node capture.mjs <page> <outfile> [width] [height] [wait ms]');
  process.exit(2);
}
const width = Number.parseInt(wArg ?? '1280', 10) || 1280;
const height = Number.parseInt(hArg ?? '800', 10) || 800;
const waitMs = Number.parseInt(waitArg ?? '3200', 10) || 3200;

const session = await launch({ width, height });
const { page: p } = session;
try {
  await p.goto(page);
  await p.waitForLoad(20000);

  const ready = await p.waitFor(
    `(window.__shotReady === true) || (!!document.querySelector('.screen.show'))`,
    30000,
  );
  if (!ready) console.error('warning: neither __shotReady nor a menu overlay appeared');

  await new Promise((r) => setTimeout(r, waitMs));

  const state = await p.evaluate(`(() => {
    const g = window.__game;
    if (!g) return { booted: false };
    return {
      booted: true,
      shotReady: !!window.__shotReady,
      title: document.title,
      mode: g.mode,
      seed: g.seed,
      cars: g.vehicles.vehicles.length,
      buildings: g.world.buildingCount,
      peds: g.traffic.peds.length,
      stars: g.police.stars,
      cash: g.player.cash,
      health: Math.round(g.player.health),
      clock: Math.round(g.clockMinutes),
      shot: new URLSearchParams(location.search).get('shot'),
    };
  })()`);

  const bytes = await p.screenshot(outfile, 90);

  console.log('page state:', JSON.stringify(state, null, 2));
  console.log(`console messages: ${p.consoleMessages.length}`);
  for (const m of p.consoleMessages.slice(0, 40)) console.log(`  [${m.type}] ${m.text}`);
  console.log(`exceptions: ${p.exceptions.length}`);
  for (const e of p.exceptions.slice(0, 20)) console.log(`  ${e.text}`);
  console.log(`network requests: ${p.requests.length}`);
  const uniq = [...new Set(p.requests.map((r) => `${r.method} ${r.url}`))];
  for (const r of uniq.slice(0, 30)) console.log(`  ${r}`);
  console.log(`screenshot: ${outfile} ${bytes} bytes (${(bytes / 1024).toFixed(1)} KiB)`);
  console.log('errors:', p.errors().length ? p.errors().join(' | ') : 'none');
  if (p.errors().length) process.exitCode = 1;
} finally {
  await session.close();
}
