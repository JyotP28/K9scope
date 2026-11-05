// Keyboard + mouse wheel / trackpad.
//  - Mouse wheel / two-finger trackpad scroll: advance / withdraw insertion tube
//    (this is the "right hand on the tube" even when the phone is used).
//  - Keyboard fallback for the phone:
//      Arrow Up/Down    tip up/down (knob turns while held, holds when released)
//      Arrow Left/Right tip left/right
//      Q / E            torque counter-clockwise / clockwise
//      W / S            advance / withdraw
//      Space (hold)     air (insufflate)      R (hold)  water (lens wash)
//      X (hold)         suction               Z         straighten tip

export class KeyboardMouseSource {
  constructor(wheelTarget, settings) {
    this.name = 'keyboard/mouse';
    this.target = wheelTarget;
    this.settings = settings; // { wheelCmPerPx, invertWheel }
    this.keys = new Set();
    this.wheelName = 'trackpad/wheel';
  }

  attach(m) {
    this.m = m;
    const isTyping = (e) => e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA');
    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(k)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(k);
      if (k === 'z') m.trigger(this, 'straighten');
      this._buttons();
    });
    window.addEventListener('keyup', (e) => {
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      this.keys.delete(k);
      this._buttons();
    });
    window.addEventListener('blur', () => { this.keys.clear(); this._buttons(); });

    this.target.addEventListener('wheel', (e) => {
      e.preventDefault();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;      // lines -> px
      else if (e.deltaMode === 2) dy *= 400; // pages -> px
      const sign = this.settings.invertWheel ? -1 : 1;
      m.addRelative({ name: this.wheelName }, { insert: sign * dy * this.settings.wheelCmPerPx });
    }, { passive: false });
  }

  _buttons() {
    this.m.setButtons(this, { air: this.keys.has(' '), water: this.keys.has('r'), suction: this.keys.has('x') });
  }

  update(dt) {
    const k = this.keys;
    const knobRate = 120; // deg/s
    const v = {};
    if (k.has('ArrowUp')) v.ud = (v.ud || 0) + knobRate * dt;
    if (k.has('ArrowDown')) v.ud = (v.ud || 0) - knobRate * dt;
    if (k.has('ArrowRight')) v.lr = (v.lr || 0) + knobRate * dt;
    if (k.has('ArrowLeft')) v.lr = (v.lr || 0) - knobRate * dt;
    if (k.has('e')) v.torque = (v.torque || 0) + 70 * dt;
    if (k.has('q')) v.torque = (v.torque || 0) - 70 * dt;
    if (k.has('w')) v.insert = (v.insert || 0) + 5 * dt;
    if (k.has('s')) v.insert = (v.insert || 0) - 5 * dt;
    if (Object.keys(v).length) this.m.addRelative(this, v);
  }
}
