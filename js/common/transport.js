// Transport layer: gets JSON messages between the controller and the simulator.
//
//  - PeerJS (WebRTC data channel, brokered by the free PeerJS cloud server).
//    Works on static hosting (GitHub Pages); data flows phone <-> laptop directly.
//  - Local (BroadcastChannel). Both pages open in the SAME browser on one machine
//    (add ?local to both URLs). Handy for testing without a phone.
//
// Both expose the same tiny API:
//   t.onStatus = (state, detail) => {}   state: 'starting'|'waiting'|'connected'|'disconnected'|'error'
//   t.onMessage = (msg) => {}
//   t.send(msg)
//   t.close()

import { PEER_PREFIX } from './protocol.js';

class BaseTransport {
  constructor() {
    this.onStatus = () => {};
    this.onMessage = () => {};
    this.state = 'starting';
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

export function createHost(roomId, local) {
  return local ? new LocalHost(roomId) : new PeerHost(roomId);
}
export function createClient(roomId, local) {
  return local ? new LocalClient(roomId) : new PeerClient(roomId);
}
