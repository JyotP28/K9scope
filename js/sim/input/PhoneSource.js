// Phone controller source: receives control state over the transport
// (PeerJS/WebRTC or local BroadcastChannel) and feeds the InputManager.

export class PhoneSource {
  constructor(transport, limits) {
    this.name = 'phone';
    this.t = transport;
    this.limits = limits;
    this.rtt = null;
    this.onStatus = () => {};
    this.lastMsg = 0;
  }

  attach(m) {
    this.m = m;
    this.t.onStatus = (state, detail) => {
      if (state === 'connected') { this.t.send({ t: 'config', limits: this.limits }); this._lastTool = null; this._tin = this._text = undefined; }
      if (state === 'disconnected') m.setButtons(this, { air: false, water: false, suction: false });
      this.onStatus(state, detail);
    };
    this.t.onMessage = (msg) => this._handle(msg);
    this._pinger = setInterval(() => this.t.send({ t: 'ping', ts: performance.now() }), this.t.pingIntervalMs || 1000);
  }

  _handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    this.lastMsg = performance.now();
    switch (msg.t) {
      case 'hello':
        this._tin = this._text = undefined; this._lastTool = null;
        this.t.send({ t: 'config', limits: this.limits });
        break;
      case 'state':
        this.m.setAbsolute(this, { ud: +msg.ud || 0, lr: +msg.lr || 0, torque: +msg.torque || 0 });
        this.m.setButtons(this, { air: !!msg.air, water: !!msg.water, suction: !!msg.suction, jaws: !!msg.jaws });
        // forceps: only apply when the phone changes them, so keyboard/mouse changes aren't overwritten
        // (the first message after connecting only records the phone's values: it must not undo the sim's state)
        if (this._tin === undefined) { this._tin = msg.tin; this._text = msg.text; break; }
        if (msg.tin !== undefined && msg.tin !== this._tin) { this._tin = msg.tin; this.m.setTool(this, { inserted: msg.tin }); }
        if (msg.text !== undefined && msg.text !== this._text) { this._text = msg.text; this.m.setTool(this, { ext: msg.text }); }
        break;
      case 'straighten':
        this.m.trigger(this, 'straighten');
        break;
      case 'pong':
        this.rtt = performance.now() - msg.ts;
        if (this._lastRtt === undefined || Math.abs(this._lastRtt - this.rtt) >= 3) { this._lastRtt = this.rtt; this.t.send({ t: 'rtt', ms: Math.round(this.rtt) }); }
        break;
    }
  }

  haptic(ms) { this.t.send({ t: 'haptic', ms }); }
  // keep the phone's forceps controls in sync with the sim (e.g. after B on the keyboard)
  toolState(st) {
    const key = JSON.stringify(st);
    if (key !== this._lastTool) { this._lastTool = key; this.t.send({ t: 'tool', ...st }); }
  }
  status(text) { this.t.send({ t: 'status', text }); }
}
