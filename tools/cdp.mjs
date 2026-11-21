// A minimal Chrome DevTools Protocol driver: launch the Playwright Chromium binary headless with
// --remote-debugging-port, talk to it over Node 22's built-in WebSocket, and give the other tools a
// small page API (goto, evaluate, screenshot, console + exception capture, request log).
//
// No npm packages. Everything here is standard library plus the browser binary on disk.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.CHROMIUM_PATH,
  process.env.CHROME_PATH,
  join(process.env.HOME ?? '', '.cache/ms-playwright/chromium-1254/chrome-linux64/chrome'),
  join(process.env.HOME ?? '', '.cache/ms-playwright/chromium-1254/chrome-linux/chrome'),
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
];

export function findChromium() {
  for (const c of CANDIDATES) {
    if (c && existsSync(c)) return c;
  }
  // Fall back to scanning the playwright cache for any chromium build.
  const cache = join(process.env.HOME ?? '', '.cache/ms-playwright');
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache)) {
      if (!dir.startsWith('chromium')) continue;
      for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
        const p = join(cache, dir, sub);
        if (existsSync(p)) return p;
      }
    }
  }
  throw new Error('No Chromium binary found. Set CHROMIUM_PATH to the Playwright Chromium executable.');
}

async function fetchJson(url, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch { /* the port is not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`DevTools endpoint never answered: ${url}`);
}

export class Page {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.consoleMessages = [];
    this.exceptions = [];
    this.requests = [];
    this.loaded = false;
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      this._event(msg);
    });
  }

  _event(msg) {
    const { method, params } = msg;
    if (method === 'Runtime.consoleAPICalled') {
      const text = (params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      this.consoleMessages.push({ type: params.type, text });
      if (params.type === 'error') this.consoleMessages.push({ type: 'error-detected', text });
    } else if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails;
      const text = d.exception?.description ?? d.text ?? 'unknown exception';
      this.exceptions.push({ text, url: d.url, line: d.lineNumber });
    } else if (method === 'Log.entryAdded') {
      const e = params.entry;
      this.consoleMessages.push({ type: e.level, text: e.text });
    } else if (method === 'Network.requestWillBeSent') {
      this.requests.push({ url: params.request.url, method: params.request.method, type: params.type });
    } else if (method === 'Page.loadEventFired') {
      this.loaded = true;
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  async enable() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Network.enable');
  }

  async setViewport(width, height, deviceScaleFactor = 1) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor, mobile: false,
    });
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
  }

  async waitForLoad(timeoutMs = 15000) {
    const start = Date.now();
    while (!this.loaded && Date.now() - start < timeoutMs) await new Promise((r) => setTimeout(r, 100));
    return this.loaded;
  }

  /** Evaluate an expression, returning its JSON value. Throws on page exceptions. */
  async evaluate(expression, awaitPromise = true) {
    const res = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise, userGesture: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`page eval failed: ${d.exception?.description ?? d.text}`);
    }
    return res.result?.value;
  }

  async waitFor(expression, timeoutMs = 20000, pollMs = 60) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const v = await this.evaluate(expression);
        if (v) return v;
      } catch { /* keep polling through transient errors */ }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return null;
  }

  async screenshot(file, quality = 90) {
    const res = await this.send('Page.captureScreenshot', {
      format: 'jpeg', quality, captureBeyondViewport: false, fromSurface: true,
    });
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(file), { recursive: true });
    const buf = Buffer.from(res.data, 'base64');
    writeFileSync(file, buf);
    return buf.length;
  }

  errors() {
    return [
      ...this.exceptions.map((e) => `exception: ${e.text} @ ${e.url ?? '?'}:${e.line ?? '?'}`),
      ...this.consoleMessages.filter((m) => m.type === 'error' || m.type === 'error-detected').map((m) => `console.error: ${m.text}`),
    ];
  }
}

export async function launch({ width = 1280, height = 800 } = {}) {
  const bin = findChromium();
  const userDataDir = mkdtempSync(join(tmpdir(), 'solmar-chrome-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--disable-extensions',
    '--force-device-scale-factor=1',
    `--window-size=${width},${height}`,
    'about:blank',
  ];
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.on('exit', (code) => { if (code !== 0 && code !== null) stderr += `\nchrome exited ${code}`; });

  // --remote-debugging-port=0 writes the chosen port to DevToolsActivePort in the profile dir.
  const { readFileSync } = await import('node:fs');
  let port = null;
  for (let i = 0; i < 100; i += 1) {
    try {
      const txt = readFileSync(join(userDataDir, 'DevToolsActivePort'), 'utf8').split('\n');
      port = Number.parseInt(txt[0], 10);
      if (Number.isInteger(port) && port > 0) break;
    } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!port) {
    proc.kill('SIGKILL');
    throw new Error(`Chromium never opened a DevTools port.\n${stderr.slice(-3000)}`);
  }

  const listUrl = `http://127.0.0.1:${port}/json/list`;
  const targets = await fetchJson(listUrl);
  const pageTarget = targets.find((t) => t.type === 'page');
  if (!pageTarget) throw new Error('no page target');

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', (e) => reject(new Error(`ws error: ${e.message ?? 'unknown'}`)), { once: true });
  });

  const page = new Page(ws);
  await page.enable();
  await page.setViewport(width, height);

  return {
    page,
    chromium: bin,
    port,
    async close() {
      try { ws.close(); } catch { /* already closed */ }
      try { proc.kill('SIGTERM'); } catch { /* already dead */ }
      await new Promise((r) => setTimeout(r, 200));
    },
    stderr: () => stderr,
  };
}
