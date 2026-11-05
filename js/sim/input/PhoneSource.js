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
      if (state === 'connected') this.t.send({ t: 'config', limits: this.limits });
      if (state === 'disconnected') m.setButtons(this, { air: false, water: false, suction: false });
      this.onStatus(state, detail);
    };
    this.t.onMessage = (msg) => this._handle(msg);
    this._pinger = setInterval(() => this.t.send({ t: 'ping', ts: performance.now() }), 1000);
  }

  _handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    this.lastMsg = performance.now();
    switch (msg.t) {
      case 'hello':
        this.t.send({ t: 'config', limits: this.limits });
        break;
      case 'state':
        this.m.setAbsolute(this, { ud: +msg.ud || 0, lr: +msg.lr || 0, torque: +msg.torque || 0 });
        this.m.setButtons(this, { air: !!msg.air, water: !!msg.water, suction: !!msg.suction });
        break;
      case 'straighten':
        this.m.trigger(this, 'straighten');
        break;
      case 'pong':
        this.rtt = performance.now() - msg.ts;
        this.t.send({ t: 'rtt', ms: Math.round(this.rtt) });
        break;
    }
  }

  haptic(ms) { this.t.send({ t: 'haptic', ms }); }
  status(text) { this.t.send({ t: 'status', text }); }
}
