// Transport layer: gets JSON messages between the controller and the simulator.
//
//  - PeerJS (WebRTC data channel, brokered by the free PeerJS cloud server).
//    Works on static hosting (GitHub Pages); data flows phone <-> laptop directly.
//  - Ably (pub/sub relay over a normal secure websocket on port 443). For networks
//    that block peer-to-peer WebRTC (most campus / enterprise Wi-Fi). Needs an Ably
//    API key; messages go phone -> Ably -> laptop, so latency is a little higher.
//  - Local (BroadcastChannel). Both pages open in the SAME browser on one machine
//    (add ?local to both URLs). Handy for testing without a phone.
//
// All expose the same tiny API:
//   t.onStatus = (state, detail) => {}   state: 'starting'|'waiting'|'connected'|'disconnected'|'error'
//   t.onMessage = (msg) => {}
//   t.send(msg)
//   t.close()
//   t.keepAliveMs / t.pingIntervalMs     how often idle state / latency pings are sent

import { PEER_PREFIX } from './protocol.js';

class BaseTransport {
  constructor() {
    this.onStatus = () => {};
    this.onMessage = () => {};
    this.state = 'starting';
    this.keepAliveMs = 250;
    this.pingIntervalMs = 1000;
    this.label = '';
  }
  _status(state, detail = '') {
    this.state = state;
    this.onStatus(state, detail);
  }
}

// ---------------------------------------------------------------- PeerJS ----

function peerOptions() {
  // PeerJS default config already includes Google STUN and a PeerJS TURN relay.
  return { debug: 1 };
}

export class PeerHost extends BaseTransport {
  constructor(roomId) {
    super();
    this.label = 'WebRTC (peer-to-peer)';
    this.roomId = roomId;
    this.conn = null;
    if (typeof Peer === 'undefined') {
      setTimeout(() => this._status('error', 'PeerJS library failed to load'), 0);
      return;
    }
    this.peer = new Peer(PEER_PREFIX + roomId, peerOptions());
    this.peer.on('open', () => this._status('waiting', 'Scan the QR code with your phone'));
    this.peer.on('connection', (conn) => this._adopt(conn));
    this.peer.on('disconnected', () => {
      // Lost the broker (not the phone). Existing data channel keeps working.
      try { this.peer.reconnect(); } catch (e) { /* ignore */ }
    });
    this.peer.on('error', (err) => {
      if (err.type === 'unavailable-id') this._status('error', 'Room id taken - reload the page');
      else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error')
        this._status('error', 'Cannot reach the PeerJS broker (check internet)');
      else this._status(this.conn ? 'connected' : 'error', err.type || String(err));
    });
  }
  _adopt(conn) {
    if (this.conn && this.conn.open) {
      // Newest controller wins; close the old one.
      try { this.conn.close(); } catch (e) { /* ignore */ }
    }
    this.conn = conn;
    conn.on('open', () => this._status('connected', 'Phone connected'));
    conn.on('data', (d) => this.onMessage(d));
    conn.on('close', () => {
      if (this.conn === conn) { this.conn = null; this._status('disconnected', 'Phone disconnected - rescan to rejoin'); }
    });
    conn.on('error', () => {});
  }
  send(msg) {
    if (this.conn && this.conn.open) this.conn.send(msg);
  }
  close() {
    try { this.peer && this.peer.destroy(); } catch (e) { /* ignore */ }
  }
}

export class PeerClient extends BaseTransport {
  constructor(roomId) {
    super();
    this.label = 'WebRTC';
    this.roomId = roomId;
    this.conn = null;
    if (typeof Peer === 'undefined') {
      setTimeout(() => this._status('error', 'PeerJS library failed to load'), 0);
      return;
    }
    this.peer = new Peer(peerOptions());
    this.peer.on('open', () => this._connect());
    this.peer.on('disconnected', () => { try { this.peer.reconnect(); } catch (e) { /* ignore */ } });
    this.peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') this._status('error', 'Simulator not found - is the laptop page open?');
      else this._status('error', err.type || String(err));
    });
  }
  _connect() {
    this._status('starting', 'Connecting to simulator...');
    // reliable:false -> unordered/unreliable data channel = lowest latency.
    // We always send the full control state, so a lost packet is harmless.
    const conn = this.peer.connect(PEER_PREFIX + this.roomId, { reliable: false, serialization: 'json' });
    this.conn = conn;
    conn.on('open', () => this._status('connected', 'Connected'));
    conn.on('data', (d) => this.onMessage(d));
    conn.on('close', () => this._status('disconnected', 'Disconnected'));
    conn.on('error', () => this._status('error', 'Connection error'));
  }
  reconnect() {
    if (this.conn) try { this.conn.close(); } catch (e) { /* ignore */ }
    if (this.peer && !this.peer.destroyed) this._connect();
  }
  send(msg) {
    if (this.conn && this.conn.open) this.conn.send(msg);
  }
  close() {
    try { this.peer && this.peer.destroy(); } catch (e) { /* ignore */ }
  }
}

// ------------------------------------------------------- BroadcastChannel ----

export class LocalHost extends BaseTransport {
  constructor(roomId) {
    super();
    this.label = 'local (same browser)';
    this.ch = new BroadcastChannel(PEER_PREFIX + roomId);
    this.ch.onmessage = (e) => {
      const m = e.data;
      if (m && m.__from === 'client') {
        if (this.state !== 'connected') this._status('connected', 'Local controller connected');
        this.onMessage(m.msg);
      }
    };
    setTimeout(() => this._status('waiting', 'Local mode: open phone.html?local#' + roomId + ' in this browser'), 0);
  }
  send(msg) { this.ch.postMessage({ __from: 'host', msg }); }
  close() { this.ch.close(); }
}

export class LocalClient extends BaseTransport {
  constructor(roomId) {
    super();
    this.ch = new BroadcastChannel(PEER_PREFIX + roomId);
    this.ch.onmessage = (e) => {
      const m = e.data;
      if (m && m.__from === 'host') {
        if (this.state !== 'connected') this._status('connected', 'Connected (local)');
        this.onMessage(m.msg);
      }
    };
    setTimeout(() => { this._status('connected', 'Local mode'); }, 0);
  }
  reconnect() {}
  send(msg) { this.ch.postMessage({ __from: 'client', msg }); }
  close() { this.ch.close(); }
}

// ------------------------------------------------------------------ Ably ----
//
// One channel per room: "k9scope:<room>". Controller -> sim messages use the
// event name 'c2s', sim -> controller 's2c'. Presence tells each side whether
// the other is there. Ably counts every publish AND every delivery against the
// account's monthly quota, and limits each connection to 50 msg/s (free plan),
// so high-rate messages are coalesced: only the newest 'state' is sent, at most
// every STATE_MS, and 'tool' updates at most every TOOL_MS.

const ABLY_CHANNEL_PREFIX = 'k9scope:';
const COALESCE = { state: 50, tool: 200, rtt: 2000 };   // ms between sends, per message type
const MAX_RATE = 30;                                     // publishes/s budget (limit is 50)
const WATCHDOG_MS = 4000;                                // no messages for this long = other side gone

class AblyTransport extends BaseTransport {
  constructor(roomId, key, role) {
    super();
    this.role = role;
    this.label = 'Ably relay';
    this.keepAliveMs = 1000;    // idle keep-alive (state is resent only this often when nothing changes)
    this.pingIntervalMs = 5000;
    this.peerSeen = 0;
    this.pending = new Map();   // msg type -> latest msg waiting to be sent
    this.lastSent = new Map();
    this.timer = null;
    this.bucket = MAX_RATE;
    this.lastRefill = performance.now();
    this.queue = [];
    this.inName = role === 'host' ? 'c2s' : 's2c';
    this.outName = role === 'host' ? 's2c' : 'c2s';
    if (typeof Ably === 'undefined') { setTimeout(() => this._status('error', 'Ably library failed to load'), 0); return; }
    if (!key) { setTimeout(() => this._status('error', 'No Ably API key - add it in Settings'), 0); return; }
    this._status('starting', 'Connecting to Ably…');
    try {
      this.client = new Ably.Realtime({
        key,
        clientId: role + '-' + Math.random().toString(36).slice(2, 8),
        echoMessages: false,
        disconnectedRetryTimeout: 3000,
      });
    } catch (e) {
      setTimeout(() => this._status('error', 'Ably: ' + e.message), 0);
      return;
    }
    const conn = this.client.connection;
    conn.on((change) => {
      const st = change.current;
      if (st === 'connected') this._onAblyConnected();
      else if (st === 'disconnected' || st === 'suspended') this._status('disconnected', 'Lost connection to Ably - retrying…');
      else if (st === 'failed') {
        const r = change.reason;
        const bad = r && (r.code === 40101 || r.code === 40400 || r.code === 40100 || (r.statusCode === 401));
        this._status('error', bad ? 'Ably rejected the API key - check it in Settings' : 'Ably connection failed' + (r ? ': ' + r.message : ''));
      }
    });
    this.ch = this.client.channels.get(ABLY_CHANNEL_PREFIX + roomId);
    this.ch.subscribe(this.inName, (m) => { this._peerAlive(); this.onMessage(m.data); });
    this.ch.presence.subscribe((p) => {
      if (!this._isPeer(p.clientId)) return;
      if (p.action === 'enter' || p.action === 'present' || p.action === 'update') this._peerAlive();
      if (p.action === 'leave') this._peerGone();
    });
    this.watchdog = setInterval(() => {
      if (this.state === 'connected' && performance.now() - this.peerSeen > WATCHDOG_MS) this._peerGone();
    }, 1000);
  }

  _isPeer(clientId) { return !!clientId && clientId.startsWith(this.role === 'host' ? 'ctl-' : 'host-'); }

  async _onAblyConnected() {
    try {
      await this.ch.attach();
      await this.ch.presence.enter({ role: this.role });
      const members = await this.ch.presence.get();
      if (members.some((m) => this._isPeer(m.clientId))) this._peerAlive();
      else if (this.role === 'host') this._status('waiting', 'Ably ready - scan the QR code with your phone');
      else this._status('error', 'Simulator not found - is the laptop page open (in Ably mode)?');
    } catch (e) {
      const code = e && e.code;
      if (code === 40160 || code === 40161) this._status('error', 'This Ably key lacks permission for k9scope:* channels (needs publish, subscribe, presence)');
      else this._status('error', 'Ably: ' + (e && e.message || e));
    }
  }

  _peerAlive() {
    this.peerSeen = performance.now();
    if (this.state !== 'connected') this._status('connected', this.role === 'host' ? 'Phone connected (Ably)' : 'Connected (Ably)');
  }
  _peerGone() {
    if (this.state === 'connected') this._status(this.role === 'host' ? 'waiting' : 'disconnected', this.role === 'host' ? 'Phone disconnected - rescan to rejoin' : 'Simulator left');
  }

  send(msg) {
    if (!this.ch || !msg) return;
    const iv = COALESCE[msg.t];
    if (iv) {
      this.pending.set(msg.t, msg);
      const wait = (this.lastSent.get(msg.t) || 0) + iv - performance.now();
      if (wait <= 0) this._flushType(msg.t);
      else if (!this.timer) this.timer = setTimeout(() => { this.timer = null; for (const t of [...this.pending.keys()]) this.send(this.pending.get(t)); }, Math.min(wait, 50));
      return;
    }
    this._publish(msg);
  }
  _flushType(t) {
    const msg = this.pending.get(t);
    this.pending.delete(t);
    this.lastSent.set(t, performance.now());
    this._publish(msg);
  }
  _publish(msg) {
    const now = performance.now();
    this.bucket = Math.min(MAX_RATE, this.bucket + (now - this.lastRefill) * MAX_RATE / 1000);
    this.lastRefill = now;
    if (this.bucket < 1) {
      // over budget: drop superseded state messages, keep one-shots (haptic, straighten…)
      if (msg.t !== 'state' && msg.t !== 'tool' && msg.t !== 'ping' && msg.t !== 'pong' && this.queue.length < 20) {
        this.queue.push(msg);
        if (!this.qTimer) this.qTimer = setTimeout(() => { this.qTimer = null; const q = this.queue; this.queue = []; q.forEach((m) => this._publish(m)); }, 100);
      }
      return;
    }
    this.bucket -= 1;
    if (this.client.connection.state !== 'connected') return;
    this.ch.publish(this.outName, msg).catch((e) => {
      if (e && e.code === 42911) console.warn('Ably rate limit hit');
      else console.warn('Ably publish failed', e && e.message);
    });
  }

  reconnect() {
    if (this.client) { this.client.connection.connect(); this._onAblyConnected(); }
  }
  close() {
    clearInterval(this.watchdog);
    try { this.ch && this.ch.presence.leave(); } catch (e) { /* ignore */ }
    try { this.client && this.client.close(); } catch (e) { /* ignore */ }
  }
}

export class AblyHost extends AblyTransport { constructor(roomId, key) { super(roomId, key, 'host'); } }
export class AblyClient extends AblyTransport { constructor(roomId, key) { super(roomId, key, 'ctl'); } }

// mode: 'local' | 'ably' | 'peer'
export function createHost(roomId, mode, key) {
  if (mode === true || mode === 'local') return new LocalHost(roomId);
  if (mode === 'ably') return new AblyHost(roomId, key);
  return new PeerHost(roomId);
}
export function createClient(roomId, mode, key) {
  if (mode === true || mode === 'local') return new LocalClient(roomId);
  if (mode === 'ably') return new AblyClient(roomId, key);
  return new PeerClient(roomId);
}
