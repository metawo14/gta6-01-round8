// SOLMAR — the grader entrypoint (Node 22, standard library only).
//
// The game is game/: plain static files a desktop browser loads offline (index.html plus its ES
// modules and the vendored Three.js). This program checks that game/index.html exists, copies
// game/ and screenshots/ from beside this file into the output directory, and writes
// dossier.json, the summary the judge reads, using the kit's vendored buildDossier library.
//
// Local test:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
// Then play it with: node serve.ts

import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const indexPath = join(here, 'game', 'index.html');
if (!existsSync(indexPath)) {
  console.error(`SOLMAR: game/index.html is missing at ${indexPath}. The entry cannot be built.`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
cpSync(join(here, 'game'), join(out, 'game'), { recursive: true });

const shotsSrc = join(here, 'screenshots');
mkdirSync(join(out, 'screenshots'), { recursive: true });
if (existsSync(shotsSrc)) {
  cpSync(shotsSrc, join(out, 'screenshots'), { recursive: true });
}

// The scorer's caps: only text_max_bytes shapes the bytes; the rest refuse an entry the scorer
// would refuse (more than 4 screenshots or any over 256 KiB; more than 993 files under game/,
// 48 MiB of game files in all, or a game path over 1000 bytes).
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 50331648,
    game_path_max_bytes: 1000,
  }),
);

// One line per screenshot with its size in KiB, then the summary line.
let shotCount = 0;
for (const name of ['1-chase.jpg', '2-onfoot.jpg', '3-mission.jpg', '4-night.jpg']) {
  const p = join(out, 'screenshots', name);
  if (existsSync(p)) {
    shotCount += 1;
    console.log(`${name}: ${(statSync(p).size / 1024).toFixed(1)} KiB`);
  }
}
const dossierSize = statSync(join(out, 'dossier.json')).size;
console.log(`SOLMAR: wrote ${shotCount} screenshot${shotCount === 1 ? '' : 's'} and dossier.json (${dossierSize} bytes) to ${out}`);
