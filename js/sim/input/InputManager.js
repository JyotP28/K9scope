// InputManager: merges any number of control sources into ONE control frame
// that the simulator consumes each tick. The simulator never knows (or cares)
// whether the input came from the phone, the keyboard, or a USB gamepad /
// custom Arduino-Pico controller.
//
// A source is any object with:
//   attach(manager)   called once
//   update(dt)        called every frame (optional; for polling/rate controls)
//   name              string shown in the HUD
//
// Sources talk to the manager with:
//   manager.setAbsolute(src, { ud?, lr?, torque? })   absolute knob / torque angles (deg)
//   manager.addRelative(src, { ud?, lr?, torque?, insert? })  increments (deg, cm)
//   manager.setButtons(src, { air?, water?, suction? })
//   manager.trigger(src, 'straighten' | 'zeroTorque')

export class InputManager {
  constructor(limits) {
    this.limits = limits;
    this.sources = [];
    this.ud = 0; this.lr = 0; this.torque = 0;
    this.buttons = new Map(); // src -> {air, water, suction}
    this.insertAccum = 0;
    this.events = [];
    this.lastActive = null;
    this.lastActiveTime = 0;
  }

  add(source) {
    this.sources.push(source);
    source.attach(this);
    return source;
  }

  _touch(src) { this.lastActive = src; this.lastActiveTime = performance.now(); }

  _clamp() {
    const L = this.limits;
    this.ud = Math.max(-L.down, Math.min(L.up, this.ud));
    this.lr = Math.max(-L.left, Math.min(L.right, this.lr));
  }

  setAbsolute(src, v) {
    if (v.ud !== undefined) this.ud = v.ud;
    if (v.lr !== undefined) this.lr = v.lr;
    if (v.torque !== undefined) this.torque = v.torque;
    this._clamp();
    this._touch(src);
  }

  addRelative(src, v) {
    if (v.ud) this.ud += v.ud;
    if (v.lr) this.lr += v.lr;
    if (v.torque) this.torque += v.torque;
    if (v.insert) this.insertAccum += v.insert;
    this._clamp();
    this._touch(src);
  }

  setButtons(src, b) {
    const prev = this.buttons.get(src) || { air: false, water: false, suction: false };
    const next = { ...prev, ...b };
    this.buttons.set(src, next);
    if (b.air || b.water || b.suction) this._touch(src);
  }

  trigger(src, name) {
    this.events.push(name);
    this._touch(src);
  }

  // Called by the sim once per frame. Returns the merged frame and clears one-shots.
  poll(dt) {
    for (const s of this.sources) if (s.update) s.update(dt);
    let air = false, water = false, suction = false;
    for (const b of this.buttons.values()) { air ||= b.air; water ||= b.water; suction ||= b.suction; }
    for (const e of this.events) {
      if (e === 'straighten') { this.ud = 0; this.lr = 0; }
    }
    const frame = {
      ud: this.ud, lr: this.lr, torque: this.torque,
      air, water, suction,
      insert: this.insertAccum,
      events: this.events,
      source: this.lastActive ? this.lastActive.name : '-',
    };
    this.insertAccum = 0;
    this.events = [];
    return frame;
  }
}
