// Biopsy forceps passed through the working channel.
//
// Workflow (as in a real procedure):
//   1. insert the forceps into the biopsy port; they take ~1 s to travel the channel
//   2. advance them out of the tip (0 - 2.5 cm), open the jaws
//   3. press the open jaws onto the mucosa (ideally en face, not tangential), close = bite
//   4. withdraw the forceps completely to retrieve the sample, then repeat
// Opening the jaws again with a sample inside drops it. Moving the scope with the
// forceps extended is flagged (risk of mucosal trauma).
//
// The channel exits at about 7 o'clock in the image (scope-specific; CHANNEL below).

import * as THREE from 'three';

export const MAX_EXT = 2.5;              // cm the forceps can extend beyond the tip
const CHANNEL = { x: -0.14, y: -0.24 };  // exit offset on the tip face (cm, image right/up)
const CONVERGE = 0.05;                   // slight convergence toward the optical axis
const TRAVEL_TIME = 1.0;                 // s to pass through the channel
const JAW_LEN = 0.3;

export class Forceps {
  constructor(model) {
    this.model = model;
    this.reset();
  }

  reset() {
    this.inserted = false;   // in the channel at all
    this.travel = 0;         // 0 = at the port, 1 = at the tip
    this.ext = 0;            // cm beyond the tip (actual)
    this.open = 0;           // jaw opening 0..1
    this.touch = false;      // jaws against mucosa
    this.wallDist = 99;
    this.loaded = null;      // sample in the jaws
    this._wasOpenCmd = false;
    this._pending = null;
    this.status = '';
    this.exitPos = new THREE.Vector3();
    this.dir = new THREE.Vector3();
    this.jawPos = new THREE.Vector3();
  }

  get emerged() { return this.inserted && this.travel >= 1; }

  update(scope, tool, dt) {
    const ev = [];
    const m = this.model, tip = scope.tip;

    // ---- channel travel ----
    if (tool.inserted && !this.inserted) { this.inserted = true; this.travel = 0; ev.push({ type: 'toolIn' }); }
    if (!tool.inserted && this.inserted) {
      // pulling out: first retract into the channel, then out of the port
      this.ext = Math.max(0, this.ext - 6 * dt);
      if (this.ext <= 0) this.travel = Math.max(0, this.travel - dt / 0.6);
      if (this.travel <= 0) {
        this.inserted = false;
        ev.push({ type: 'toolOut' });
        if (this.loaded) { ev.push({ type: 'sample', sample: this.loaded }); this.loaded = null; }
      }
    } else if (this.inserted) {
      this.travel = Math.min(1, this.travel + dt / TRAVEL_TIME);
    }

    // ---- geometry in world space ----
    const right = _r.crossVectors(tip.fwd, tip.up);
    this.exitPos.copy(tip.pos).addScaledVector(right, CHANNEL.x).addScaledVector(tip.up, CHANNEL.y).addScaledVector(tip.fwd, 0.02);
    this.dir.copy(tip.fwd).addScaledVector(right, -CHANNEL.x * CONVERGE / 0.28).addScaledVector(tip.up, -CHANNEL.y * CONVERGE / 0.28).normalize();

    // distance from the channel exit to the mucosa along the forceps path
    let wall = MAX_EXT + 1;
    for (let t = 0; t <= MAX_EXT + JAW_LEN + 0.3; t += 0.04) {
      _p.copy(this.exitPos).addScaledVector(this.dir, t);
      if (m.locate(_p, tip.s, scope.inflate).gap < 0.03) { wall = t; break; }
    }
    this.wallDist = wall;

    // ---- extension: follows the command, stops at the wall (mucosa indents ~1.5 mm) ----
    const want = this.emerged && tool.inserted ? THREE.MathUtils.clamp(tool.ext, 0, 1) * MAX_EXT : 0;
    const stop = Math.max(0, wall - JAW_LEN + 0.15);
    const target = Math.min(want, stop);
    const rate = 5; // cm/s
    if (tool.inserted) this.ext += THREE.MathUtils.clamp(target - this.ext, -rate * dt, rate * dt);
    this.ext = Math.max(0, Math.min(this.ext, stop));
    this.touch = this.emerged && this.ext + JAW_LEN >= wall - 0.05 && this.ext > 0.15;
    this.jawPos.copy(this.exitPos).addScaledVector(this.dir, this.ext + JAW_LEN);

    // ---- jaws ----
    const canOpen = this.emerged && this.ext > 0.35 && !(this.touch && this.open < 0.3 && this.wallDist < this.ext + 0.1);
    const openCmd = !!tool.jaws && canOpen;
    this.open += THREE.MathUtils.clamp((openCmd ? 1 : 0) - this.open, -dt / 0.25, dt / 0.35);

    if (openCmd && !this._wasOpenCmd && this.loaded) {
      ev.push({ type: 'lost', sample: this.loaded });
      this.loaded = null;
    }
    if (!openCmd && this._wasOpenCmd && this.open > 0.6) {
      // closing: were the open jaws on the mucosa at the moment of closing?
      this._pending = { snap: this.touch ? this._snapshot(scope) : null };
    }
    this._wasOpenCmd = openCmd;
    if (this._pending && this.open < 0.12) {
      if (this._pending.snap) { this.loaded = this._pending.snap; ev.push({ type: 'bite', sample: this.loaded }); }
      else ev.push({ type: 'miss' });
      this._pending = null;
    }

    // ---- status line ----
    if (!this.inserted) this.status = 'not inserted';
    else if (!tool.inserted) this.status = 'withdrawing…';
    else if (this.travel < 1) this.status = 'passing channel…';
    else if (this.ext < 0.05) this.status = 'at tip (retracted)';
    else this.status = `${this.ext.toFixed(1)} cm out${this.open > 0.5 ? ' · jaws open' : ''}${this.touch ? ' · on mucosa' : ''}`;
    if (this.loaded) this.status += ' · sample in jaws';
    if (tool.jaws && this.emerged && !canOpen) {
      this.status += this.wallDist < JAW_LEN + 0.4 ? ' · too close to the wall to open - pull the scope back' : ' · extend further to open the jaws';
    }
    return ev;
  }

  // sample description at the bite site
  _snapshot(scope) {
    const m = this.model;
    const loc = m.locate(this.jawPos, scope.tip.s, scope.inflate);
    const c = m.pointAt(loc.s, new THREE.Vector3());
    const t = m.tangentAt(loc.s, new THREE.Vector3());
    const radial = new THREE.Vector3().subVectors(this.jawPos, c);
    radial.addScaledVector(t, -radial.dot(t));
    if (radial.lengthSq() < 1e-6) radial.copy(m.normalAt(loc.s, new THREE.Vector3()));
    radial.normalize();
    // en-face (perpendicular) bites give deeper, better-oriented samples than tangential ones
    const enFace = Math.abs(this.dir.dot(radial));
    const quality = enFace > 0.55 ? 'good' : enFace > 0.3 ? 'adequate' : 'poor';
    const wallR = m.radius(loc.s, loc.ang, 1);                         // rest-space radius
    const rest = c.clone().addScaledVector(radial, wallR / m.inflateScale(loc.s, 1));
    const region = m.regionAt(loc.s);
    return { s: loc.s, region: region ? region.name : '?', quality, enFace, rest, time: performance.now() / 1000 };
  }
}

// ------------------------------------------------------------- 3D mesh ----
// Built in CAMERA space (child of the endoscope camera: +X right, +Y up, -Z forward).

export function buildForcepsMesh() {
  const g = new THREE.Group();
  g.visible = false;
  g.renderOrder = 1;

  // coiled sheath: stripe texture for the spiral wire
  const cv = document.createElement('canvas'); cv.width = 8; cv.height = 64;
  const cx = cv.getContext('2d');
  for (let y = 0; y < 64; y++) { const v = Math.round(168 + 22 * Math.sin((y / 64) * Math.PI * 2 * 4)); cx.fillStyle = `rgb(${v},${v + 4},${v + 10})`; cx.fillRect(0, y, 8, 1); }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const sheathMat = new THREE.MeshStandardMaterial({ map: tex, color: 0x9aa4ab, metalness: 0.55, roughness: 0.35 });
  const sheath = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 1, 20, 1, true), sheathMat);
  sheath.rotation.x = Math.PI / 2;
  g.add(sheath);

  const jawMat = new THREE.MeshStandardMaterial({ color: 0xb9c2c8, metalness: 0.7, roughness: 0.28, side: THREE.DoubleSide });
  const mkJaw = (sign) => {
    const pivot = new THREE.Group();
    // elongated half-ellipsoid cup; dome toward +Y (upper jaw) or -Y (lower), open side facing the other jaw
    const geo = new THREE.SphereGeometry(0.09, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    geo.scale(1, 0.8, JAW_LEN / 0.18);
    if (sign < 0) geo.rotateZ(Math.PI);
    const cup = new THREE.Mesh(geo, jawMat);
    cup.position.z = -JAW_LEN / 2; // hinge at z = 0, cup extends forward (-Z)
    pivot.add(cup);
    return pivot;
  };
  const upper = mkJaw(1), lower = mkJaw(-1);
  g.add(upper, lower);
  const sample = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), new THREE.MeshStandardMaterial({ color: 0xc8606a, roughness: 0.5 }));
  sample.scale.set(1, 0.7, 1.5);
  sample.position.z = -JAW_LEN * 0.55;
  lower.add(sample);
  g.userData = { sheath, upper, lower, sample, tex };
  return g;
}

export function updateForcepsMesh(g, forceps, scope) {
  const { sheath, upper, lower, sample, tex } = g.userData;
  const show = forceps.inserted && forceps.travel >= 1;
  g.visible = show;
  if (!show) return;
  // camera-space exit point & direction
  g.position.set(CHANNEL.x, CHANNEL.y, -0.02);
  _d.set(-CHANNEL.x * CONVERGE / 0.28, -CHANNEL.y * CONVERGE / 0.28, -1).normalize();
  _q.setFromUnitVectors(_z.set(0, 0, -1), _d);
  g.quaternion.copy(_q);
  const back = 0.8, len = back + forceps.ext;
  sheath.scale.y = len;
  sheath.position.z = (back - forceps.ext) / 2;
  tex.repeat.set(1, len * 22);
  const a = forceps.open * 0.75; // ~43 deg per jaw
  upper.position.z = lower.position.z = -forceps.ext;
  upper.rotation.x = a;
  lower.rotation.x = -a;
  sample.visible = !!forceps.loaded;
}

const _r = new THREE.Vector3(), _p = new THREE.Vector3(), _d = new THREE.Vector3(), _z = new THREE.Vector3();
const _q = new THREE.Quaternion();
