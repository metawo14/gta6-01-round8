// Input: keyboard + mouse, pointer lock with a drag-to-look fallback, and an override object the
// headless playtest and the screenshot staging use to drive the game without a real keyboard.

const ACTIONS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  jump: ['Space'],
  enter: ['KeyE'],
  punch: ['KeyF'],
  reload: ['KeyR'],
  pause: ['KeyP', 'Escape'],
  mute: ['KeyM'],
  horn: ['KeyH'],
  weapon1: ['Digit1'],
  weapon2: ['Digit2'],
};

export class Input {
  constructor(canvas) {
    this.canvas = canvas ?? null;
    this.held = new Set();
    this.pressed = new Set();
    this.mouseX = 0;
    this.mouseY = 0;
    this.mouseButtons = new Set();
    this.mousePressed = new Set();
    this.locked = false;
    this.dragging = false;
    this.lastDrag = { x: 0, y: 0 };
    this.onFirstGesture = null;
    this.enabled = true;
    /** When set, fully replaces real keyboard/mouse state (playtest, shots). */
    this.override = null;
    this._bind();
  }

  _bind() {
    if (typeof window === 'undefined') return;
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      // Never swallow browser shortcuts the player might want (devtools, reload).
      if (e.metaKey || e.ctrlKey) return;
      this.held.add(e.code);
      this.pressed.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
      this._gesture();
    });
    window.addEventListener('keyup', (e) => { this.held.delete(e.code); });
    window.addEventListener('blur', () => { this.held.clear(); this.mouseButtons.clear(); });

    const target = this.canvas ?? window;
    target.addEventListener('mousedown', (e) => {
      this.mouseButtons.add(e.button);
      this.mousePressed.add(e.button);
      if (e.button === 0 && !this.locked) { this.dragging = true; this.lastDrag = { x: e.clientX, y: e.clientY }; }
      if (this.canvas?.requestPointerLock && !this.override) {
        try { this.canvas.requestPointerLock(); } catch { /* pointer lock can be refused; drag-to-look covers it */ }
      }
      this._gesture();
    });
    window.addEventListener('mouseup', (e) => {
      this.mouseButtons.delete(e.button);
      if (e.button === 0) this.dragging = false;
    });
    window.addEventListener('mousemove', (e) => {
      if (this.locked) {
        this.mouseX += e.movementX || 0;
        this.mouseY += e.movementY || 0;
      } else if (this.dragging) {
        this.mouseX += e.clientX - this.lastDrag.x;
        this.mouseY += e.clientY - this.lastDrag.y;
        this.lastDrag = { x: e.clientX, y: e.clientY };
      }
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
    });
    window.addEventListener('contextmenu', (e) => { if (this.locked) e.preventDefault(); });
  }

  _gesture() {
    if (this.onFirstGesture) { const fn = this.onFirstGesture; this.onFirstGesture = null; fn(); }
  }

  /** Read an action from the override first, then the real keyboard. */
  _action(name) {
    if (this.override) {
      const v = this.override[name];
      if (v !== undefined) return !!v;
      return false;
    }
    const codes = ACTIONS[name];
    if (!codes) return false;
    return codes.some((code) => this.held.has(code));
  }

  down(name) { return this._action(name); }

  justPressed(name) {
    if (name === 'fire') return this.firePressed();
    if (this.override) {
      const p = this.override.pressed;
      if (!p) return false;
      return !!p[name];
    }
    const codes = ACTIONS[name];
    if (!codes) return false;
    return codes.some((code) => this.pressed.has(code));
  }

  /** -1..1 on both axes, camera-relative in main.js. */
  axis() {
    let x = 0, y = 0;
    if (this.down('forward')) y += 1;
    if (this.down('back')) y -= 1;
    if (this.down('right')) x += 1;
    if (this.down('left')) x -= 1;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    return { x, y };
  }

  fireDown() {
    if (this.override) return !!this.override.fire;
    return this.mouseButtons.has(0);
  }
  firePressed() {
    if (this.override) return !!(this.override.pressed && this.override.pressed.fire);
    return this.mousePressed.has(0);
  }

  /** Mouse movement since last frame, then cleared. */
  takeLook() {
    const look = { x: this.mouseX, y: this.mouseY };
    this.mouseX = 0;
    this.mouseY = 0;
    return look;
  }

  endFrame() {
    this.pressed.clear();
    this.mousePressed.clear();
    if (this.override?.pressed) this.override.pressed = {};
  }

  /** Used by shots/playtest: install a scripted override for this frame onwards. */
  setOverride(override) { this.override = override; }
  clearOverride() { this.override = null; }
}
