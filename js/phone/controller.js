// Phone = endoscope control section.
// Concentric dials (inner wheel = up/down, outer ring = right/left) turned with
// circular thumb swipes, two valves, locks, straighten, gyro torque.
// Sends the full control state to the simulator over the transport.

import { DEFAULT_LIMITS } from '../common/protocol.js';
import { createClient } from '../common/transport.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const LOCAL = params.has('local');
const room = (location.hash || '').replace('#', '').trim();

const S = Object.assign({ invUD: false, invLR: false, invTq: false, axis: 'long', haptic: true },
  JSON.parse(localStorage.getItem('k9scope.phone') || '{}'));
const save = () => localStorage.setItem('k9scope.phone', JSON.stringify(S));

const state = { ud: 0, lr: 0, torque: 0, air: false, water: false, suction: false };
let limits = { ...DEFAULT_LIMITS };
const locks = { ud: false, lr: false };

// ------------------------------------------------------------- haptics ----
const canVibrate = typeof navigator.vibrate === 'function';
function buzz(ms) { if (S.haptic && canVibrate) try { navigator.vibrate(ms); } catch (e) { /* iOS: silently nothing */ } }

// ----------------------------------------------------------- transport ----
let t = null;
function connect() {
  if (!room) { setConn('bad', 'no room - scan the QR code'); return; }
  if (t) t.close();
  t = createClient(room, LOCAL);
  t.onStatus = (st, detail) => {
    if (st === 'connected') { setConn('ok', 'connected'); t.send({ t: 'hello', device: navigator.userAgent.slice(0, 60) }); sendState(true); }
    else if (st === 'error') setConn('bad', detail || 'error');
    else if (st === 'disconnected') setConn('bad', 'disconnected');
    else setConn('wait', detail || 'connecting…');
  };
  t.onMessage = (m) => {
    if (!m) return;
    if (m.t === 'ping') t.send({ t: 'pong', ts: m.ts });
    else if (m.t === 'rtt') $('rtt').textContent = `latency ${m.ms} ms`;
    else if (m.t === 'config' && m.limits) { limits = { ...limits, ...m.limits }; clampAll(); render(); }
    else if (m.t === 'haptic') { buzz(m.ms || 30); document.body.classList.add('flash'); setTimeout(() => document.body.classList.remove('flash'), 120); }
  };
}
function setConn(cls, text) { const p = $('conn'); p.className = 'pill ' + cls; p.textContent = text; }

let lastSent = '', lastSendT = 0;
function sendState(force = false) {
  if (!t) return;
  const msg = { t: 'state', ud: +state.ud.toFixed(2), lr: +state.lr.toFixed(2), torque: +state.torque.toFixed(2), air: state.air, water: state.water, suction: state.suction };
  const key = JSON.stringify(msg);
  const now = performance.now();
  if (force || key !== lastSent || now - lastSendT > 250) { // keep-alive 4 Hz when idle
    t.send(msg); lastSent = key; lastSendT = now;
  }
}

// ---------------------------------------------------------------- dial ----
const R_IN = 118, R_RING0 = 136, R_RING1 = 192;
const svg = $('dial');
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs, parent = svg) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent.appendChild(e); return e; };

function buildDial() {
  const defs = el('defs', {});
  defs.innerHTML = `
    <radialGradient id="gWheel" cx="40%" cy="35%" r="75%"><stop offset="0" stop-color="#4a5257"/><stop offset=".6" stop-color="#262c30"/><stop offset="1" stop-color="#111416"/></radialGradient>
    <radialGradient id="gRing" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#3a4146"/><stop offset="1" stop-color="#15191b"/></radialGradient>
    <radialGradient id="gHub" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#9aa3a8"/><stop offset="1" stop-color="#3d4448"/></radialGradient>`;
  // outer ring with grip teeth
  const ring = el('g', { id: 'ring' });
  let d = '';
  const teeth = 28;
  for (let i = 0; i <= teeth * 4; i++) {
    const a = (i / (teeth * 4)) * Math.PI * 2;
    const r = R_RING1 - ((i % 4 === 1 || i % 4 === 2) ? 0 : 9);
    d += (i ? 'L' : 'M') + (Math.cos(a) * r).toFixed(1) + ' ' + (Math.sin(a) * r).toFixed(1);
  }
  d += 'Z M' + R_RING0 + ' 0 A' + R_RING0 + ' ' + R_RING0 + ' 0 1 0 ' + (-R_RING0) + ' 0 A' + R_RING0 + ' ' + R_RING0 + ' 0 1 0 ' + R_RING0 + ' 0Z';
  el('path', { d, fill: 'url(#gRing)', 'fill-rule': 'evenodd', stroke: '#0b0d0e', 'stroke-width': 2 }, ring);
  el('text', { x: 0, y: -(R_RING0 + R_RING1) / 2 + 6, 'text-anchor': 'middle', fill: '#e6b44a', 'font-size': 18, 'font-weight': 800 }, ring).textContent = 'R';
  el('text', { x: 0, y: (R_RING0 + R_RING1) / 2 + 6, 'text-anchor': 'middle', fill: '#9aa3a8', 'font-size': 18, 'font-weight': 800 }, ring).textContent = 'L';
  el('circle', { cx: 0, cy: -(R_RING0 + R_RING1) / 2 - 14, r: 3, fill: '#e6b44a' }, ring);

  // inner wheel: 5-lobed star knob (like a real U/D angulation knob)
  const wheel = el('g', { id: 'wheel' });
  let w = '';
  const N = 360;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = R_IN - 16 * Math.pow(Math.abs(Math.sin(a * 2.5)), 0.7) * -1 - 16 + 4 * Math.cos(a * 60);
    w += (i ? 'L' : 'M') + (Math.cos(a) * r).toFixed(1) + ' ' + (Math.sin(a) * r).toFixed(1);
  }
  el('path', { d: w + 'Z', fill: 'url(#gWheel)', stroke: '#0b0d0e', 'stroke-width': 2 }, wheel);
  el('circle', { r: 46, fill: 'url(#gHub)', stroke: '#0b0d0e', 'stroke-width': 2 }, wheel);
  el('text', { x: 0, y: -66, 'text-anchor': 'middle', fill: '#4fd1ff', 'font-size': 22, 'font-weight': 800 }, wheel).textContent = 'U';
  el('text', { x: 0, y: 82, 'text-anchor': 'middle', fill: '#9aa3a8', 'font-size': 22, 'font-weight': 800 }, wheel).textContent = 'D';
  el('path', { d: 'M0 -104 L7 -90 L-7 -90Z', fill: '#4fd1ff' }, wheel);
  el('text', { x: 0, y: 6, 'text-anchor': 'middle', fill: '#1b2023', 'font-size': 13, 'font-weight': 800, 'letter-spacing': 1 }, wheel).textContent = 'K9';

  // fixed neutral index mark
  el('path', { d: `M0 ${-R_RING1 - 2} L-8 ${-R_RING1 - 14} L8 ${-R_RING1 - 14}Z`, fill: '#e6edf0' });
  el('text', { x: -150, y: -172, fill: '#7d8b92', 'font-size': 11 }).textContent = 'ring = R/L';
  el('text', { x: 92, y: -172, fill: '#7d8b92', 'font-size': 11 }).textContent = 'wheel = U/D';
}
buildDial();

// knob angles (deg) shown on screen; tip angle = knob angle (1:1), sign by convention:
//   inner wheel: turning COUNTER-clockwise = UP     outer ring: turning CLOCKWISE = RIGHT
let wheelDeg = 0, ringDeg = 0;
function knobToTip() {
  state.ud = (S.invUD ? 1 : -1) * wheelDeg;
  state.lr = (S.invLR ? -1 : 1) * ringDeg;
}
function clampAll() {
  // clamp in tip space, then map back
  knobToTip();
  const ud = Math.max(-limits.down, Math.min(limits.up, state.ud));
  const lr = Math.max(-limits.left, Math.min(limits.right, state.lr));
  wheelDeg = (S.invUD ? 1 : -1) * ud;
  ringDeg = (S.invLR ? -1 : 1) * lr;
  knobToTip();
}

const active = new Map(); // pointerId -> { which, lastAng, accum }
function svgPoint(e) {
  const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
  return p.matrixTransform(svg.getScreenCTM().inverse());
}
svg.addEventListener('pointerdown', (e) => {
  const p = svgPoint(e);
  const r = Math.hypot(p.x, p.y);
  let which = null;
  if (r < R_IN + 6) which = 'wheel';
  else if (r < R_RING1 + 30) which = 'ring';
  if (!which) return;
  if ((which === 'wheel' && locks.ud) || (which === 'ring' && locks.lr)) { buzz(15); flashLock(which === 'wheel' ? 'lockUD' : 'lockLR'); return; }
  if (r < 20) return; // too close to centre for a stable angle
  svg.setPointerCapture(e.pointerId);
  active.set(e.pointerId, { which, lastAng: Math.atan2(p.y, p.x), tick: 0 });
  e.preventDefault();
});
svg.addEventListener('pointermove', (e) => {
  const a = active.get(e.pointerId);
  if (!a) return;
  const p = svgPoint(e);
  if (Math.hypot(p.x, p.y) < 18) return;
  const ang = Math.atan2(p.y, p.x);
  let d = ang - a.lastAng;
  if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
  a.lastAng = ang;
  const deg = d * 180 / Math.PI; // + = clockwise on screen (SVG y down)
  const before = a.which === 'wheel' ? wheelDeg : ringDeg;
  if (a.which === 'wheel') wheelDeg += deg; else ringDeg += deg;
  clampAll();
  const after = a.which === 'wheel' ? wheelDeg : ringDeg;
  // detent tick every 10 degrees
  if (Math.floor(before / 10) !== Math.floor(after / 10)) buzz(4);
  if (after === before && Math.abs(deg) > 0.5) { a.tick += Math.abs(deg); if (a.tick > 25) { buzz(25); a.tick = 0; } } // at the stop
  render();
});
const endPtr = (e) => active.delete(e.pointerId);
svg.addEventListener('pointerup', endPtr);
svg.addEventListener('pointercancel', endPtr);

function flashLock(id) { const b = $(id); b.animate([{ transform: 'scale(1.15)' }, { transform: 'none' }], { duration: 200 }); }
function setLock(k, v) {
  locks[k] = v;
  const b = $(k === 'ud' ? 'lockUD' : 'lockLR');
  b.classList.toggle('locked', v);
  b.querySelector('b').textContent = v ? '🔒' : '🔓';
}
$('lockUD').onclick = () => { setLock('ud', !locks.ud); buzz(10); };
$('lockLR').onclick = () => { setLock('lr', !locks.lr); buzz(10); };

// straighten: animate knobs back to neutral and release locks
$('btnStraight').onclick = () => {
  setLock('ud', false); setLock('lr', false);
  if (t) t.send({ t: 'straighten' });
  const w0 = wheelDeg, r0 = ringDeg, t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / 280), e = 1 - Math.pow(1 - k, 3);
    wheelDeg = w0 * (1 - e); ringDeg = r0 * (1 - e); knobToTip(); render();
    if (k < 1) requestAnimationFrame(step); else sendState(true);
  };
  requestAnimationFrame(step);
  buzz(20);
};

// -------------------------------------------------------------- valves ----
function valve(id, onDown, onMove, onUp) {
  const v = $(id);
  let pid = null, y0 = 0;
  v.addEventListener('pointerdown', (e) => { pid = e.pointerId; y0 = e.clientY; v.setPointerCapture(pid); onDown(); buzz(8); render(); e.preventDefault(); });
  v.addEventListener('pointermove', (e) => { if (e.pointerId === pid && onMove) { onMove(e.clientY - y0); render(); } });
  const up = (e) => { if (e.pointerId === pid) { pid = null; onUp(); render(); } };
  v.addEventListener('pointerup', up); v.addEventListener('pointercancel', up);
}
valve('vAir', () => { state.air = true; state.water = false; },
  (dy) => { const w = dy > 30; if (w !== state.water) buzz(12); state.water = w; state.air = !w; },
  () => { state.air = false; state.water = false; });
valve('vSuc', () => { state.suction = true; }, null, () => { state.suction = false; });

// ---------------------------------------------------------- gyro torque ----
// W3C deviceorientation: R = Rz(alpha) * Rx(beta) * Ry(gamma) (intrinsic Z-X'-Y'')
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qaxis = (ax, deg) => { const h = deg * Math.PI / 360, s = Math.sin(h); return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(h)]; };
const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];
let q0 = null, qNow = null, gotOrientation = false, tqSmooth = 0, tqUnwrap = 0, lastTw = 0;

function onOrient(e) {
  if (e.alpha == null && e.beta == null) return;
  gotOrientation = true;
  const q = qmul(qmul(qaxis([0, 0, 1], e.alpha || 0), qaxis([1, 0, 0], e.beta || 0)), qaxis([0, 1, 0], e.gamma || 0));
  qNow = q;
  if (!q0) { q0 = q; tqUnwrap = 0; lastTw = 0; }
  const r = qmul(qconj(q0), q);              // rotation relative to calibration, in device frame
  const c = S.axis === 'screen' ? r[2] : r[1]; // twist about device Y (long axis) or Z (screen normal)
  let tw = 2 * Math.atan2(c, r[3]) * 180 / Math.PI;
  tw = ((tw + 540) % 360) - 180;
  let d = tw - lastTw; if (d > 180) d -= 360; else if (d < -180) d += 360;
  lastTw = tw; tqUnwrap += d;               // allow > 180 deg of accumulated torque
  const sign = S.invTq ? 1 : -1;           // + = clockwise as seen looking down the handle
  tqSmooth += (sign * tqUnwrap - tqSmooth) * 0.6;
  state.torque = tqSmooth;
}
function zeroTorque() { q0 = qNow; tqUnwrap = 0; lastTw = 0; tqSmooth = 0; state.torque = 0; stripVal = 0; render(); buzz(20); }
$('btnZero').onclick = zeroTorque;

// fallback when there is no gyroscope (desktop testing)
let stripVal = 0;
(function torqueStrip() {
  const s = $('torqueStrip');
  let pid = null, x0 = 0, v0 = 0;
  s.addEventListener('pointerdown', (e) => { pid = e.pointerId; x0 = e.clientX; v0 = stripVal; s.setPointerCapture(pid); });
  s.addEventListener('pointermove', (e) => { if (e.pointerId !== pid) return; stripVal = Math.max(-180, Math.min(180, v0 + (e.clientX - x0) * 1.2)); state.torque = stripVal; render(); });
  s.addEventListener('pointerup', () => { pid = null; });
})();

async function enableMotion() {
  const note = $('startNote');
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const res = await DeviceOrientationEvent.requestPermission(); // iOS 13+: must be inside a tap
      if (res !== 'granted') note.textContent = 'Motion permission denied - torque disabled (use the strip).';
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        try { await DeviceMotionEvent.requestPermission(); } catch (e) { /* optional */ }
      }
    }
  } catch (e) { note.textContent = 'Motion sensors unavailable: ' + e.message; }
  window.addEventListener('deviceorientation', onOrient);
  if (!window.isSecureContext) note.textContent = 'Not on https - motion sensors are blocked. Use the GitHub Pages URL.';
  setTimeout(() => { if (!gotOrientation) $('torqueStrip').classList.remove('hidden'); }, 1500);
}

// --------------------------------------------------------- start / misc ----
$('btnStart').onclick = async () => {
  await enableMotion();
  try { if (navigator.wakeLock) await navigator.wakeLock.request('screen'); } catch (e) { /* optional */ }
  try { if (/Android/i.test(navigator.userAgent) && document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen(); } catch (e) { /* optional */ }
  $('start').classList.add('hidden');
  buzz(30);
};
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') try { if (navigator.wakeLock) await navigator.wakeLock.request('screen'); } catch (e) { /* ignore */ }
});
$('gear').onclick = () => $('settings').classList.remove('hidden');
$('btnClose').onclick = () => $('settings').classList.add('hidden');
$('btnReconnect').onclick = () => { $('settings').classList.add('hidden'); connect(); };
for (const [id, key] of [['sInvUD', 'invUD'], ['sInvLR', 'invLR'], ['sInvTq', 'invTq'], ['sHaptic', 'haptic']]) {
  $(id).checked = S[key];
  $(id).onchange = (e) => { S[key] = e.target.checked; save(); clampAll(); render(); };
}
$('sAxis').value = S.axis;
$('sAxis').onchange = (e) => { S.axis = e.target.value; save(); zeroTorque(); };
document.addEventListener('gesturestart', (e) => e.preventDefault()); // iOS pinch
document.addEventListener('contextmenu', (e) => e.preventDefault());

// -------------------------------------------------------------- render ----
function render() {
  $('wheel').setAttribute('transform', `rotate(${wheelDeg.toFixed(1)})`);
  $('ring').setAttribute('transform', `rotate(${ringDeg.toFixed(1)})`);
  $('rUD').textContent = `${state.ud >= 0 ? 'U' : 'D'} ${Math.abs(state.ud).toFixed(0)}°`;
  $('rLR').textContent = `${state.lr >= 0 ? 'R' : 'L'} ${Math.abs(state.lr).toFixed(0)}°`;
  $('rTq').textContent = `${state.torque >= 0 ? '↻' : '↺'} ${Math.abs(state.torque).toFixed(0)}°`;
  const pos = (v, lo, hi) => `${(50 + 50 * (v >= 0 ? v / hi : v / lo)).toFixed(1)}%`;
  $('gUD').style.left = pos(state.ud, limits.down, limits.up);
  $('gLR').style.left = pos(state.lr, limits.left, limits.right);
  $('gTq').style.left = pos(Math.max(-180, Math.min(180, state.torque)), 180, 180);
  $('tsKnob').style.left = `${50 + stripVal / 3.6}%`;
  $('vAir').classList.toggle('on', state.air || state.water);
  $('vAir').classList.toggle('water', state.water);
  $('vAir').querySelector('.lbl').textContent = state.water ? 'WATER' : 'AIR / WATER';
  $('vSuc').classList.toggle('on', state.suction);
}

function loop() { sendState(); $('rTq') && (gotOrientation && render()); requestAnimationFrame(loop); }
render();
connect();
requestAnimationFrame(loop);
