// USB gamepad / custom hardware controller source (Gamepad API).
//
// Intended for a home-made control section: Arduino Leonardo/Micro or a
// Raspberry Pi Pico enumerating as a USB HID gamepad, with potentiometers or
// encoders on real angulation knobs. No sim code changes are needed - just
// match this mapping (or edit MAP below):
//
//   axis 0  up/down knob      -1 = full DOWN, 0 = neutral, +1 = full UP
//   axis 1  left/right knob   -1 = full LEFT, +1 = full RIGHT
//   axis 2  torque            -1..+1 = -180..+180 deg (absolute, e.g. IMU yaw or pot)
//   axis 3  insertion         absolute position of an encoder/wheel on the tube,
//                             -1..+1 = -INSERT_SPAN/2..+INSERT_SPAN/2 cm; wraps around
//                             (we only use the change, so wraparound is handled)
//   button 0 air/water (air)   button 1 water (lens wash)   button 2 suction
//   button 3 straighten tip
//
// Axes are only applied after they move, so a random gamepad plugged in won't
// fight the phone.

const MAP = { ud: 0, lr: 1, torque: 2, insert: 3, air: 0, water: 1, suction: 2, straighten: 3 };
const INSERT_SPAN = 40; // cm represented by the full -1..+1 axis range
const DEAD = 0.02;

export class GamepadSource {
  constructor(limits) {
    this.name = 'gamepad';
    this.limits = limits;
    this.prev = null;
    this.index = null;
    this.connectedName = null;
  }

  attach(m) {
    this.m = m;
    window.addEventListener('gamepadconnected', (e) => { this.index = e.gamepad.index; this.connectedName = e.gamepad.id; this.prev = null; });
    window.addEventListener('gamepaddisconnected', (e) => { if (e.gamepad.index === this.index) { this.index = null; this.connectedName = null; } });
  }

  update() {
    if (this.index === null || !navigator.getGamepads) return;
    const gp = navigator.getGamepads()[this.index];
    if (!gp) return;
    const ax = (i) => (gp.axes[i] ?? 0);
    const bt = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
    const cur = { ud: ax(MAP.ud), lr: ax(MAP.lr), torque: ax(MAP.torque), insert: ax(MAP.insert), b3: bt(MAP.straighten) };
    if (this.prev) {
      const moved = (k) => Math.abs(cur[k] - this.prev[k]) > DEAD;
      const L = this.limits;
      const abs = {};
      if (moved('ud')) abs.ud = cur.ud >= 0 ? cur.ud * L.up : cur.ud * L.down;
      if (moved('lr')) abs.lr = cur.lr >= 0 ? cur.lr * L.right : cur.lr * L.left;
      if (moved('torque')) abs.torque = cur.torque * 180;
      if (Object.keys(abs).length) { this.m.setAbsolute(this, abs); this.prev.ud = cur.ud; this.prev.lr = cur.lr; this.prev.torque = cur.torque; }
      let d = cur.insert - this.prev.insert;
      if (d > 1) d -= 2; else if (d < -1) d += 2; // wraparound
      if (Math.abs(d) > 0.0005) { this.m.addRelative(this, { insert: d * INSERT_SPAN / 2 }); this.prev.insert = cur.insert; }
      if (cur.b3 && !this.prev.b3) this.m.trigger(this, 'straighten');
      this.prev.b3 = cur.b3;
    } else {
      this.prev = { ...cur };
    }
    this.m.setButtons(this, { air: bt(MAP.air), water: bt(MAP.water), suction: bt(MAP.suction) });
  }
}
