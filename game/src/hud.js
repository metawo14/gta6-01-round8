// The HUD. Everything is DOM except the minimap, which is a 2D canvas redrawn each frame. Text is
// cached so the DOM is only touched when a value actually changes, and the star fragments are
// cached by star/heat state so a five-star chase does not rebuild them 60 times a second.

import { HUD as HUDCFG, CITY, PALETTE } from './config.js';
import { clamp } from './random.js';
import { roadCenter } from './world.js';

const AMBER = '#ffc23d';
const RED = '#ff5340';
const TEAL = '#2ff0d0';

export class HUD {
  constructor(root) {
    this.root = root;
    this.cache = new Map();
    this.starKey = '';
    this.mapSize = HUDCFG.minimapSize;
    this._build();
    this.mapCtx = this.mapCanvas.getContext('2d');
    this._mapTick = 0;
    this._lastMapSig = '';
  }

  _build() {
    const el = (id) => this.root.querySelector(`#${id}`);
    this.healthFill = el('health-fill');
    this.healthWrap = el('health-wrap');
    this.healthNum = el('health-num');
    this.cashValue = el('cash-value');
    this.starsWrap = el('stars');
    this.clockMain = el('clock-main');
    this.clockPhase = el('clock-phase');
    this.weaponName = el('weapon-name');
    this.weaponAmmo = el('weapon-ammo');
    this.objJob = el('obj-job');
    this.objStep = el('obj-step');
    this.objCard = el('objective');
    this.speedo = el('speedo');
    this.speedNum = el('speed-num');
    this.speedGear = el('speed-gear');
    this.prompt = el('prompt');
    this.banner = el('banner');
    this.bannerTitle = el('banner-title');
    this.bannerCash = el('banner-cash');
    this.vignette = el('vignette');
    this.status = el('status');
    this.mapCanvas = el('minimap');
    if (this.mapCanvas) {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      this.mapCanvas.width = this.mapSize * dpr;
      this.mapCanvas.height = this.mapSize * dpr;
      this.mapCanvas.style.width = `${this.mapSize}px`;
      this.mapCanvas.style.height = `${this.mapSize}px`;
      this.mapDpr = dpr;
      this.mapCtxScale = dpr;
    }
    this._starEls = [];
    for (let i = 0; i < 5; i += 1) {
      const s = document.createElement('span');
      s.className = 'star';
      s.textContent = '★';
      this.starsWrap.appendChild(s);
      this._starEls.push(s);
    }
    this.vignettePulse = 0;
  }

  _set(key, node, text) {
    if (this.cache.get(key) === text) return;
    this.cache.set(key, text);
    if (node) node.textContent = text;
  }

  update(state) {
    const { player, game, mission, police, clockMinutes } = state;

    // Health: colour shifts amber then red as it falls.
    const hp = clamp(player.health, 0, 100);
    const hpPct = `${hp.toFixed(0)}%`;
    if (this.cache.get('hpw') !== hpPct) {
      this.cache.set('hpw', hpPct);
      this.healthFill.style.width = hpPct;
      const colour = hp > 60 ? '#64ff9a' : hp > 30 ? AMBER : RED;
      this.healthFill.style.background = colour;
      this.healthFill.style.boxShadow = `0 0 12px ${colour}`;
    }
    this._set('hpn', this.healthNum, `${Math.round(hp)}`);

    this._set('cash', this.cashValue, `$${player.cash.toLocaleString('en-US')}`);

    // Stars: pulse pale when heat is high.
    const stars = police.stars;
    const heat = police.heat;
    const starKey = `${stars}|${heat > 0.55 ? 1 : 0}`;
    if (starKey !== this.starKey) {
      this.starKey = starKey;
      this._starEls.forEach((s, i) => {
        const on = i < stars;
        s.classList.toggle('on', on);
        s.classList.toggle('hot', on && heat > 0.55);
      });
    }

    // Clock, normalised into a day first so a bad value can never reach the face.
    const mins = ((Math.floor(clockMinutes) % 1440) + 1440) % 1440;
    const hh = String(Math.floor(mins / 60)).padStart(2, '0');
    const mm = String(mins % 60).padStart(2, '0');
    this._set('clock', this.clockMain, `${hh}:${mm}`);
    this._set('phase', this.clockPhase, phaseWord(mins));

    // Weapon chip.
    const weapon = player.weapon === 'pistol' ? 'PISTOL' : 'FISTS';
    this._set('wn', this.weaponName, weapon);
    this._set('wa', this.weaponAmmo, player.weapon === 'pistol' ? `${player.ammo} / ${player.reserve}` : '—');

    // Objective card.
    const job = mission.current;
    this._set('objj', this.objJob, job ? `JOB ${mission.index + 1} · ${job.name.toUpperCase()}` : 'STORY COMPLETE');
    this._set('objs', this.objStep, mission.active ? mission.objectiveText : (mission.complete ? 'Story complete — the city is yours' : 'Get to work'));
    this.objCard.classList.toggle('done', !!mission.complete);

    // Speedometer only while driving.
    if (player.car) {
      this.speedo.classList.add('show');
      const kmh = Math.round(Math.abs(player.car.speed) * 3.6);
      this._set('spd', this.speedNum, `${kmh}`);
      const gear = player.car.speed < -0.4 ? 'R' : Math.abs(player.car.speed) < 0.4 ? 'N' : player.car.handbrake ? 'N' : 'D';
      this._set('gear', this.speedGear, gear);
    } else {
      this.speedo.classList.remove('show');
    }

    // Context prompt.
    this._set('prompt', this.prompt, state.prompt ?? '');
    this.prompt.classList.toggle('show', !!state.prompt);

    // Mission banner.
    if (mission.banner) {
      this.banner.classList.add('show');
      this._set('bt', this.bannerTitle, mission.banner.title);
      this._set('bc', this.bannerCash, `+$${mission.banner.cash.toLocaleString('en-US')}`);
    } else {
      this.banner.classList.remove('show');
    }

    // Damage vignette: pulses low, flashes on impact.
    const low = hp < 40 ? (1 - hp / 40) : 0;
    this.vignettePulse = Math.max(0, this.vignettePulse - 0.02);
    const flash = game.vignetteFlash ?? 0;
    const strength = clamp(Math.max(low * (0.45 + Math.sin(performance.now() / 260) * 0.2), flash), 0, 0.95);
    this.vignette.style.opacity = strength.toFixed(3);

    // Live region status.
    const status = `${mission.objectiveText}. ${stars} stars. $${player.cash}.`;
    this._set('status', this.status, status);

    // Minimap.
    this._drawMinimap(state);
  }

  flashImpact(amount = 0.6) { this.vignettePulse = clamp(this.vignettePulse + amount, 0, 1); }

  _drawMinimap(state) {
    const ctx = this.mapCtx;
    if (!ctx) return;
    const size = this.mapSize;
    const s = this.mapCtxScale;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    const { player, police, traffic, mission } = state;

    // Window on the world: a 260-unit square around the player, clamped to the city.
    const view = 260;
    const px = player.car ? player.car.pos.x : player.pos.x;
    const pz = player.car ? player.car.pos.z : player.pos.z;
    const left = clamp(px - view / 2, -CITY.bound - 40, CITY.bound + 40 - view);
    const top = clamp(pz - view / 2, -CITY.bound - 40, CITY.bound + 40 - view);
    const toMap = (x, z) => [((x - left) / view) * size, ((z - top) / view) * size];

    ctx.clearRect(0, 0, size, size);
    // Roads read lighter than the blocks: that is the whole legibility trick of a minimap.
    ctx.fillStyle = '#31576e';
    ctx.fillRect(0, 0, size, size);

    // Blocks as near-black rectangles between the roads.
    ctx.fillStyle = '#071119';
    for (let i = 0; i < CITY.grid; i += 1) {
      for (let j = 0; j < CITY.grid; j += 1) {
        const bx = -CITY.bound + CITY.pitch / 2 + i * CITY.pitch;
        const bz = -CITY.bound + CITY.pitch / 2 + j * CITY.pitch;
        const half = (CITY.pitch - CITY.road) / 2;
        const [mx, mz] = toMap(bx - half, bz - half);
        const w = ((half * 2) / view) * size;
        if (mx + w < 0 || mz + w < 0 || mx > size || mz > size) continue;
        ctx.fillRect(mx, mz, w, w);
      }
    }
    // Lit blocks: a warm scatter so the grid is not one flat texture.
    ctx.fillStyle = 'rgba(255, 198, 128, 0.16)';
    for (let i = 0; i < CITY.grid; i += 3) {
      for (let j = 0; j < CITY.grid; j += 4) {
        const bx = -CITY.bound + CITY.pitch / 2 + i * CITY.pitch;
        const bz = -CITY.bound + CITY.pitch / 2 + j * CITY.pitch;
        const half = (CITY.pitch - CITY.road) / 2;
        const [mx, mz] = toMap(bx - half, bz - half);
        const w = ((half * 2) / view) * size;
        ctx.fillRect(mx, mz, w, w);
      }
    }
    // Lane lines down the middle of every road: crisp, high-contrast, reads at 230px.
    ctx.strokeStyle = 'rgba(198, 236, 255, 0.42)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= CITY.grid; i += 1) {
      const rc = roadCenter(i);
      const [ax, az] = toMap(rc, top);
      const [, bz2] = toMap(rc, top + view);
      if (ax > -2 && ax < size + 2) { ctx.moveTo(ax, az); ctx.lineTo(ax, bz2); }
      const [cx2, cz2] = toMap(left, rc);
      const [dx2] = toMap(left + view, rc);
      if (cz2 > -2 && cz2 < size + 2) { ctx.moveTo(cx2, cz2); ctx.lineTo(dx2, cz2); }
    }
    ctx.stroke();
    // Water on the east.
    const [wx] = toMap(CITY.seaEdge, 0);
    if (wx < size) {
      const grad = ctx.createLinearGradient(wx, 0, size, 0);
      grad.addColorStop(0, 'rgba(31,159,184,0.85)');
      grad.addColorStop(1, 'rgba(22,125,148,0.95)');
      ctx.fillStyle = grad;
      ctx.fillRect(wx, 0, size - wx, size);
    }

    // Traffic dots.
    ctx.fillStyle = 'rgba(190,205,215,0.75)';
    for (const v of traffic.vehicles) {
      if (v.type === 'police') continue;
      const [mx, mz] = toMap(v.pos.x, v.pos.z);
      if (mx < -4 || mz < -4 || mx > size + 4 || mz > size + 4) continue;
      ctx.fillRect(mx - 1.6, mz - 1.6, 3.2, 3.2);
    }
    // Police dots flash red/blue.
    const flash = Math.floor(performance.now() / 260) % 2 === 0;
    for (const u of police.units) {
      const [mx, mz] = toMap(u.car.pos.x, u.car.pos.z);
      if (mx < -6 || mz < -6 || mx > size + 6 || mz > size + 6) continue;
      ctx.fillStyle = flash ? '#ff3b3b' : '#3b6bff';
      ctx.beginPath();
      ctx.arc(mx, mz, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
    // Mission marker: a teal ring.
    const marker = mission.marker?.();
    if (marker) {
      const [mx, mz] = toMap(marker.x, marker.z);
      const clampedX = clamp(mx, 9, size - 9), clampedZ = clamp(mz, 9, size - 9);
      ctx.strokeStyle = TEAL;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(clampedX, clampedZ, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(47,240,208,0.25)';
      ctx.fill();
    }

    // Player: a white arrow pointing along the heading.
    const [pmx, pmz] = toMap(px, pz);
    const heading = player.car ? player.car.heading : player.heading;
    ctx.save();
    ctx.translate(pmx, pmz);
    ctx.rotate(-heading + Math.PI);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(4.6, 6);
    ctx.lineTo(0, 3.2);
    ctx.lineTo(-4.6, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // North marker.
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', size / 2, 14);

    // Frame.
    ctx.strokeStyle = 'rgba(47,240,208,0.5)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, size - 2, size - 2);
  }
}

export function phaseWord(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  if (m >= 21 * 60 || m < 5 * 60) return 'NIGHT';
  if (m >= 18 * 60) return 'DUSK';
  if (m >= 12 * 60) return 'AFTERNOON';
  return 'MORNING';
}
