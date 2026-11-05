// Shared message protocol between the controller (phone, or any future device)
// and the simulator. Keep this file tiny and dependency-free: it is the contract.
//
// Controller -> Sim
//   { t: 'state', seq, ud, lr, torque, air, water, suction }
//       ud      tip up(+)/down(-) angulation command, degrees
//       lr      tip right(+)/left(-) angulation command, degrees
//       torque  insertion-tube rotation, degrees (clockwise as seen by operator = +)
//       air, water, suction   booleans (valve pressed)
//   { t: 'straighten' }          release/straighten tip (one-shot)
//   { t: 'pong', ts }            reply to ping
//   { t: 'hello', device }       first message after connecting
//
// Sim -> Controller
//   { t: 'config', limits: { up, down, left, right } }   deflection limits (deg)
//   { t: 'ping', ts }
//   { t: 'rtt', ms }             measured round-trip latency, for display
//   { t: 'haptic', ms }          buzz the controller (wall contact etc.)
//   { t: 'status', text }        short status line for the controller screen

export const PEER_PREFIX = 'k9scope-';

// Default angulation limits for a small-animal gastroscope (degrees).
// Typical 9 mm GI scopes: up 180–210, down 90–180, left/right 100–160.
export const DEFAULT_LIMITS = { up: 210, down: 90, left: 100, right: 100 };

export function randomRoomId(len = 6) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes
  let s = '';
  const a = new Uint32Array(len);
  crypto.getRandomValues(a);
  for (let i = 0; i < len; i++) s += alphabet[a[i] % alphabet.length];
  return s;
}
