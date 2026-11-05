// Laptop simulator entry point: wiring only.
//   anatomy (procedural or glTF) -> LumenModel -> Scope <- InputManager <- {phone, keyboard/mouse, gamepad}
//   Scope -> EndoRenderer (fisheye view) ; Scope -> Training (score) ; HUD

import { DEFAULT_LIMITS, randomRoomId } from '../common/protocol.js';
import { createHost } from '../common/transport.js';
import { InputManager } from './input/InputManager.js';
import { KeyboardMouseSource } from './input/KeyboardMouseSource.js';
import { PhoneSource } from './input/PhoneSource.js';
import { GamepadSource } from './input/GamepadSource.js';
import { generateCanineUGI } from './anatomy/proceduralCanineUGI.js';
import { LumenModel } from './anatomy/LumenModel.js';
import { loadAnatomyGLB, loadAnatomyFiles, exportAnatomy } from './anatomy/AnatomyIO.js';
import { Scope } from './Scope.js';
import { EndoRenderer } from './Renderer.js';
import { Training } from './Training.js';
import { OrientationOverlay, patientAxes, calibrateRoll, POSITIONS } from './Orientation.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const LOCAL = params.has('local');

// ------------------------------------------------------------ settings ----
const settings = Object.assign(
  { invertWheel: false, wheelSens: 1.0, invertTorque: false, guide: true,
    orientRef: 'lesser12', rollTrim: 0, position: 'leftLateral', compass: true, curvLabels: false, guideView: 'vd' },
  JSON.parse(localStorage.getItem('k9scope.settings') || '{}'));
const wheelCfg = { get wheelCmPerPx() { return 0.012 * settings.wheelSens; }, get invertWheel() { return settings.invertWheel; } };
const saveSettings = () => localStorage.setItem('k9scope.settings', JSON.stringify(settings));

// ------------------------------------------------------------ renderer ----
const renderer = new EndoRenderer($('gl'));
renderer.guide.enabled = settings.guide;
document.body.classList.toggle('noguide', !settings.guide);
renderer.guide.viewName = settings.guideView;
const orient = new OrientationOverlay(renderer);
orient.showCompass = settings.compass;
orient.showCurvature = settings.curvLabels;
orient.position = settings.position;
let baseRoll = 0;
function applyRoll(recalibrate = false) {
  if (!model || !scope) return;
  if (recalibrate) baseRoll = calibrateRoll(model, limits, settings.orientRef);
  scope.rollOffset = baseRoll + settings.rollTrim;
  $('rollInfo').textContent = `Scope roll at insertion: ${scope.rollOffset.toFixed(0)}° (auto ${baseRoll.toFixed(0)}° + trim ${settings.rollTrim}°)`;
}

// --------------------------------------------------------------- input ----
const limits = { ...DEFAULT_LIMITS };
const input = new InputManager(limits);
input.add(new KeyboardMouseSource(window, wheelCfg));
input.add(new GamepadSource(limits));

const room = params.get('room') || randomRoomId();
const host = createHost(room, LOCAL);
const phone = input.add(new PhoneSource(host, limits));

const phoneUrl = new URL('phone.html', location.href);
if (LOCAL) phoneUrl.search = '?local';
phoneUrl.hash = room;
$('roomId').textContent = room;
$('phoneLink').href = phoneUrl.href;
try {
  const qr = qrcode(0, 'M');
  qr.addData(phoneUrl.href);
  qr.make();
  $('qr').innerHTML = qr.createSvgTag({ cellSize: 3, margin: 0, scalable: true });
} catch (e) { $('qr').textContent = 'QR unavailable'; }
if (location.protocol === 'file:') $('connDetail').textContent = 'Open via a web server (see README) - file:// cannot load modules.';
else if (/^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname) && !LOCAL)
  $('connDetail').innerHTML = 'Note: phone motion sensors need <b>https</b>. Use the GitHub Pages URL for full phone features.';

phone.onStatus = (state, detail) => {
  const pill = $('connPill');
  const map = { starting: ['wait', 'starting…'], waiting: ['wait', 'waiting for phone'], connected: ['ok', 'phone connected'], disconnected: ['bad', 'disconnected'], error: ['bad', 'error'] };
  const [cls, txt] = map[state] || ['wait', state];
  pill.className = 'pill ' + cls; pill.textContent = txt;
  $('pairCard').classList.toggle('connected', state === 'connected');
  $('connDetail').textContent = detail || '';
};

// ------------------------------------------------------------- anatomy ----
let model, scope, training, anatomyData;

async function buildAnatomy(source) {
  $('loading').classList.remove('hidden');
  $('loadMsg').textContent = '';
  await new Promise((r) => setTimeout(r, 30));
  try {
    if (source.kind === 'procedural') anatomyData = generateCanineUGI(source.seed);
    else if (source.kind === 'url') anatomyData = await loadAnatomyGLB(source.url);
    else if (source.kind === 'files') anatomyData = await loadAnatomyFiles(source.files);
    const t0 = performance.now();
    model = new LumenModel(anatomyData.geometry, anatomyData.centerline, anatomyData.meta);
    console.log(`LumenModel: ${model.length.toFixed(1)} cm, ${model.n} samples, built in ${(performance.now() - t0).toFixed(0)} ms`);
    for (const k of ['cardia', 'pylorus', 'target']) if (model.landmarks[k] === undefined) throw new Error('Model metadata is missing landmark: ' + k);
    const axes = patientAxes(anatomyData.meta);
    renderer.axes = axes;
    renderer.setAnatomy(model, anatomyData.capGeometry);
    orient.setModel(model, axes);
    scope = new Scope(model, { limits });
    applyRoll(true);
    training = new Training(model);
    buildChecklist();
    $('modelName').textContent = 'Current model: ' + (anatomyData.meta.name || 'custom') + ` · ${model.length.toFixed(1)} cm`;
    $('loading').classList.add('hidden');
    window.k9 = { model, scope, training, input, renderer, anatomyData, orient }; // for debugging in the console
  } catch (e) {
    console.error(e);
    $('loadMsg').textContent = 'Failed: ' + e.message;
    throw e;
  }
}

function buildChecklist() {
  const ol = $('checklist');
  ol.innerHTML = '';
  for (const m of training.milestones) { const li = document.createElement('li'); li.textContent = m.label; li.dataset.id = m.id; ol.appendChild(li); }
  const li = document.createElement('li'); li.className = 'bonus'; li.dataset.id = 'retro'; li.textContent = '★ ' + training.retroflex.label; ol.appendChild(li);
}

// ----------------------------------------------------------------- HUD ----
function toast(text) {
  const d = document.createElement('div'); d.textContent = text; $('toast').appendChild(d);
  setTimeout(() => d.remove(), 3300);
}
const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

let hudTick = 0;
function updateHUD(frame, dt) {
  hudTick += dt;
  $('warn').classList.toggle('hidden', !scope.inContact);
  const msgEl = $('msg');
  msgEl.textContent = scope.msg;
  msgEl.classList.toggle('hidden', !scope.msg);
  if (hudTick < 0.08) return;
  hudTick = 0;
  $('mTime').textContent = fmtTime(training.t);
  $('mDepth').textContent = scope.depth.toFixed(1) + ' cm';
  $('mContacts').textContent = training.contacts;
  const reg = model.regionAt(scope.tip.s);
  $('mRegion').textContent = reg ? reg.name : '-';
  const inf = (scope.inflate - 0.4) / (1.2 - 0.4);
  const bar = $('mInfl');
  bar.style.width = (inf * 100).toFixed(0) + '%';
  bar.style.background = scope.inflate > 1.05 ? 'linear-gradient(90deg,#b06a3a,#ffb547)' : '';
  const ud = scope.ud, lr = scope.lr;
  $('mTip').textContent = `${ud >= 0 ? 'U' : 'D'} ${Math.abs(ud).toFixed(0)}° · ${lr >= 0 ? 'R' : 'L'} ${Math.abs(lr).toFixed(0)}°`;
  $('mTorque').textContent = `${scope.torque.toFixed(0)}°`;
  $('mSource').textContent = frame.source + (phone.rtt != null && $('pairCard').classList.contains('connected') ? ` · ${phone.rtt.toFixed(0)} ms` : '');
  $('vAir').classList.toggle('on', frame.air);
  $('vWater').classList.toggle('on', frame.water);
  $('vSuc').classList.toggle('on', frame.suction);
  const ts = $('taskState');
  ts.textContent = training.state; ts.className = 'pill ' + (training.state === 'running' ? 'wait' : training.state === 'done' ? 'ok' : '');
  for (const li of $('checklist').children) {
    const id = li.dataset.id;
    const done = id === 'retro' ? training.retroflex.done : training.milestones.find((m) => m.id === id)?.done;
    li.classList.toggle('done', !!done);
  }
  $('osdTime').textContent = new Date().toLocaleTimeString();
}

function showResult(r) {
  const row = (a, b) => `<tr><td>${a}</td><td>${b}</td></tr>`;
  $('resultBody').innerHTML = `
    <div class="row between"><div><div class="score">${r.total}</div><div class="hint">${r.grade}</div></div>
    <div class="hint" style="text-align:right">Time ${fmtTime(r.time)}<br>${r.contacts} wall contact${r.contacts === 1 ? '' : 's'}<br>Max insertion ${r.maxDepth.toFixed(1)} cm</div></div>
    <table class="res">
      ${row('Time (40)', r.parts.timeScore)}
      ${row('Mucosal contact avoidance (40)', r.parts.contactScore)}
      ${row('Insufflation control (10)', r.parts.inflScore + (r.overInflTime > 0.5 ? ` <span class="hint">(${r.overInflTime.toFixed(0)} s over-distended)</span>` : ''))}
      ${row('Retroflexion bonus (10)', r.parts.bonus)}
    </table>
    <table class="res">${r.splits.map((s) => row(s.label, s.time != null ? fmtTime(s.time) : '-')).join('')}</table>
    <p class="hint">Contact time ${r.contactTime.toFixed(1)} s. Over-insufflation in dogs can compress the caudal vena cava and impair ventilation - insufflate only as much as you need to see.</p>`;
  $('resultModal').classList.remove('hidden');
}

// ------------------------------------------------------------ UI wiring ----
const openModal = (id) => $(id).classList.remove('hidden');
document.querySelectorAll('.modal .close').forEach((b) => b.addEventListener('click', () => b.closest('.modal').classList.add('hidden')));
$('btnHelp').onclick = () => openModal('helpModal');
$('btnSettings').onclick = () => openModal('settingsModal');
const restart = () => { scope.reset(); training.reset(); buildChecklist(); input.trigger({ name: 'ui' }, 'straighten'); $('resultModal').classList.add('hidden'); };
$('btnRestart').onclick = restart;
$('btnAgain').onclick = restart;
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'h' || e.key === 'H' || e.key === '?') { $('helpModal').classList.toggle('hidden'); }
  if (e.key === 'g' || e.key === 'G') { settings.guide = !settings.guide; renderer.guide.enabled = settings.guide; document.body.classList.toggle('noguide', !settings.guide); $('sGuide').checked = settings.guide; saveSettings(); }
  if (e.key === 'o' || e.key === 'O') { settings.compass = !settings.compass; orient.showCompass = settings.compass; $('sCompass').checked = settings.compass; saveSettings(); }
  if (e.key === 'v' || e.key === 'V') toggleGuideView();
  if (e.key === 'Escape') document.querySelectorAll('.modal').forEach((m) => m.id !== 'loading' && m.classList.add('hidden'));
});

$('sInvertWheel').checked = settings.invertWheel;
$('sInvertTorque').checked = settings.invertTorque;
$('sGuide').checked = settings.guide;
$('sWheelSens').value = settings.wheelSens;
$('sWheelSensV').textContent = settings.wheelSens + '×';
$('sInvertWheel').onchange = (e) => { settings.invertWheel = e.target.checked; saveSettings(); };
$('sInvertTorque').onchange = (e) => { settings.invertTorque = e.target.checked; saveSettings(); };
$('sGuide').onchange = (e) => { settings.guide = e.target.checked; renderer.guide.enabled = settings.guide; document.body.classList.toggle('noguide', !settings.guide); saveSettings(); };
$('sWheelSens').oninput = (e) => { settings.wheelSens = +e.target.value; $('sWheelSensV').textContent = settings.wheelSens + '×'; saveSettings(); };
function toggleGuideView() {
  settings.guideView = settings.guideView === 'vd' ? 'lateral' : 'vd';
  renderer.setGuideView(settings.guideView);
  $('guideViewName').textContent = settings.guideView === 'vd' ? 'ventrodorsal' : 'lateral (right side up)';
  saveSettings();
}
$('guideViewName').textContent = settings.guideView === 'vd' ? 'ventrodorsal' : 'lateral (right side up)';
$('guideToggle').onclick = toggleGuideView;
for (const [k, v] of Object.entries(POSITIONS)) { const o = document.createElement('option'); o.value = k; o.textContent = v.label; $('sPosition').appendChild(o); }
$('sPosition').value = settings.position;
$('sPosition').onchange = (e) => { settings.position = e.target.value; orient.position = settings.position; saveSettings(); };
$('sOrientRef').value = settings.orientRef;
$('sOrientRef').onchange = (e) => { settings.orientRef = e.target.value; saveSettings(); applyRoll(true); };
$('sRollTrim').value = settings.rollTrim;
$('sRollTrimV').textContent = settings.rollTrim + '°';
$('sRollTrim').oninput = (e) => { settings.rollTrim = +e.target.value; $('sRollTrimV').textContent = settings.rollTrim + '°'; saveSettings(); applyRoll(false); };
$('sCompass').checked = settings.compass;
$('sCompass').onchange = (e) => { settings.compass = e.target.checked; orient.showCompass = settings.compass; saveSettings(); };
$('sCurv').checked = settings.curvLabels;
$('sCurv').onchange = (e) => { settings.curvLabels = e.target.checked; orient.showCurvature = settings.curvLabels; saveSettings(); };
$('btnNewPatient').onclick = async () => { $('settingsModal').classList.add('hidden'); await buildAnatomy({ kind: 'procedural', seed: Math.floor(Math.random() * 1e6) }); };
$('btnExport').onclick = async () => {
  const { glb, json } = await exportAnatomy(anatomyData);
  download(new Blob([glb], { type: 'model/gltf-binary' }), 'canine_ugi.glb');
  download(new Blob([json], { type: 'application/json' }), 'canine_ugi.json');
};
$('fileModel').onchange = async (e) => { $('settingsModal').classList.add('hidden'); await buildAnatomy({ kind: 'files', files: e.target.files }); };
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------------------------------------------------------------- loop ----
let last = performance.now();
let hapticCooldown = 0;
function loop(now) {
  requestAnimationFrame(loop);
  if (!scope) return;
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const frame = input.poll(dt);
  if (settings.invertTorque) frame.torque = -frame.torque;
  scope.update(frame, dt);
  for (const ev of training.update(scope, dt)) {
    if (ev.type === 'milestone') toast('✓ ' + ev.label);
    if (ev.type === 'contact' && hapticCooldown <= 0) { phone.haptic(35); hapticCooldown = 0.3; }
    if (ev.type === 'finish') { phone.haptic(200); setTimeout(() => showResult(ev.result), 600); }
  }
  hapticCooldown -= dt;
  renderer.render(scope, now / 1000);
  orient.update(scope);
  updateHUD(frame, dt);
}

const modelUrl = params.get('model');
await buildAnatomy(modelUrl ? { kind: 'url', url: modelUrl } : { kind: 'procedural', seed: +(params.get('seed') || 1) });
requestAnimationFrame(loop);
