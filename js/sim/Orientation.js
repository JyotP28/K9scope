// Orientation: where the patient's dorsal/ventral, left/right and cranial/caudal
// lie in the endoscope image, plus the calibration that decides how the scope is
// "held" at insertion (which sets the image orientation in the stomach).
//
// Patient axes come from the anatomy metadata:
//   meta.axes = { dorsal: [x,y,z], left: [x,y,z], cranial: [x,y,z] }   (unit vectors)
// The procedural model uses dorsal = +Y, left = +X, cranial = +Z.
//
// Image-orientation reference (settings.orientRef):
//   'lesser12' - roll the scope so that, entering the stomach with the knobs
//                neutral and no torque, the lesser curvature is at 12 o'clock
//                (the usual reference view in gastroscopy texts).
//   'dorsal12' - dorsal at 12 o'clock in the esophagus (raw model frame).
// settings.rollTrim (deg) is added on top, to match a particular instructor/scope.

import * as THREE from 'three';
import { Scope } from './Scope.js';

const DEG = 180 / Math.PI;

export const POSITIONS = {
  leftLateral: { label: 'Left lateral recumbency (standard)', down: (a) => a.left.clone() },
  rightLateral: { label: 'Right lateral recumbency', down: (a) => a.left.clone().negate() },
  dorsal: { label: 'Dorsal recumbency', down: (a) => a.dorsal.clone() },
  sternal: { label: 'Sternal recumbency', down: (a) => a.dorsal.clone().negate() },
};

export function patientAxes(meta) {
  const ax = meta.axes || { dorsal: [0, 1, 0], left: [1, 0, 0], cranial: [0, 0, 1] };
  const v = (a) => new THREE.Vector3(a[0], a[1], a[2]).normalize();
  return { dorsal: v(ax.dorsal), left: v(ax.left), cranial: v(ax.cranial) };
}

// Centre of the gastric "J": average of the osculating-circle centres along the
// stomach, weighted by curvature. The lesser curvature faces this point.
export function stomachCenter(model) {
  const lm = model.landmarks;
  const s0 = lm.cardia + 1, s1 = lm.pylorus - 1.5;
  const c = new THREE.Vector3(), p = new THREE.Vector3(), k = new THREE.Vector3();
  let w = 0;
  for (let s = s0; s <= s1; s += 0.5) {
    model.curvatureAt(s, k);
    const kap = k.length();
    if (kap < 1e-3) continue;
    model.pointAt(s, p);
    p.addScaledVector(k, 1 / (kap * kap)); // centre of the osculating circle
    c.addScaledVector(p, kap); w += kap;
  }
  return w > 0 ? c.multiplyScalar(1 / w) : model.pointAt((s0 + s1) / 2, c);
}

// clock angle (deg, clockwise from 12 o'clock) of a world direction in the current image
export function imageAngle(tip, dir) {
  const right = _r.crossVectors(tip.fwd, tip.up);
  return Math.atan2(dir.dot(right), dir.dot(tip.up)) * DEG;
}
// how much a world direction lies in the image plane (0 = straight along the view axis, 1 = in plane)
export function inPlane(tip, dir) {
  const f = dir.dot(tip.fwd);
  return Math.sqrt(Math.max(0, 1 - f * f));
}

// direction from the centerline toward the lesser curvature at arc length s
export function lesserDir(model, center, s, out = new THREE.Vector3()) {
  const p = model.pointAt(s, _p), t = model.tangentAt(s, _t);
  out.subVectors(center, p);
  out.addScaledVector(t, -out.dot(t));
  return out.normalize();
}

// Roll offset (deg) for the chosen reference.
export function calibrateRoll(model, limits, ref) {
  if (ref === 'dorsal12') return 0;
  const lm = model.landmarks;
  const sEntry = Math.min(lm.cardia + 4, (lm.cardia + lm.pylorus) / 2);
  const center = stomachCenter(model);
  const sc = new Scope(model, { limits, rollOffset: 0 });
  const frame = { ud: 0, lr: 0, torque: 0, insert: 0, air: false, water: false, suction: false, events: [] };
  let roll = 0;
  // two passes: the tube's position shifts slightly with roll-independent stiffness, so this converges at once
  for (let pass = 0; pass < 2; pass++) {
    sc.rollOffset = roll;
    sc.inflate = 1; sc.depth = sc.depthTarget = sEntry;
    for (let i = 0; i < 4; i++) sc.update(frame, 0.05);
    roll += imageAngle(sc.tip, lesserDir(model, center, sc.tip.s));
  }
  return ((roll + 540) % 360) - 180;
}

// ------------------------------------------------------------ overlay UI ----

const AXIS_LABELS = [
  ['dorsal', 'D', 'Dorsal'], ['ventral', 'V', 'Ventral'],
  ['left', 'L', 'Left'], ['right', 'R', 'Right'],
  ['cranial', 'Cr', 'Cranial'], ['caudal', 'Cd', 'Caudal'],
];

export class OrientationOverlay {
  constructor(renderer) {
    this.renderer = renderer;
    this.showCompass = true;
    this.showCurvature = false;
    this.position = 'leftLateral';

    this.compass = document.createElement('div');
    this.compass.id = 'compass';
    this.compass.innerHTML = `
      <svg viewBox="-60 -60 120 120">
        <circle r="44" class="ring"/>
        <circle r="3" class="hub"/>
        <path d="M0 -52 L5 -45 L-5 -45Z" class="topmark"/>
        <g id="cmpFluid"><line x1="0" y1="0" x2="0" y2="-30" class="fluid"/><circle cy="-32" r="4" class="fluidDot"/></g>
        <g id="cmpLabels"></g>
      </svg>
      <div class="cmpText"><span id="cmpLook"></span><span id="cmpPos"></span></div>`;
    document.body.appendChild(this.compass);
    const g = this.compass.querySelector('#cmpLabels');
    this.labelEls = {};
    for (const [key, short] of AXIS_LABELS) {
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.textContent = short;
      t.setAttribute('class', 'axl ' + key);
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('dominant-baseline', 'central');
      g.appendChild(t);
      this.labelEls[key] = t;
    }

    // lesser / greater curvature markers on the image rim
    this.curv = document.createElement('div');
    this.curv.id = 'curvMarks';
    this.curv.innerHTML = '<span class="lc">Lesser curv.</span><span class="gc">Greater curv.</span>';
    document.body.appendChild(this.curv);

    // labels around the guide inset
    this.guideLabels = document.createElement('div');
    this.guideLabels.id = 'guideLabels';
    document.body.appendChild(this.guideLabels);
    this.gl = {};
    for (const [key, short] of AXIS_LABELS) {
      const s = document.createElement('span'); s.textContent = short; s.className = 'gax ' + key;
      this.guideLabels.appendChild(s); this.gl[key] = s;
    }
  }

  setModel(model, axes) {
    this.model = model;
    this.axes = axes;
    this.dirs = {
      dorsal: axes.dorsal, ventral: axes.dorsal.clone().negate(),
      left: axes.left, right: axes.left.clone().negate(),
      cranial: axes.cranial, caudal: axes.cranial.clone().negate(),
    };
    this.center = stomachCenter(model);
  }

  gravity() { return (POSITIONS[this.position] || POSITIONS.leftLateral).down(this.axes); }

  update(scope) {
    if (!this.model) return;
    const tip = scope.tip, v = this.renderer.view;
    // ---- compass ----
    this.compass.classList.toggle('hidden', !this.showCompass);
    if (this.showCompass) {
      const size = 118;
      this.compass.style.left = (v.x + v.size - size - 6) + 'px';
      this.compass.style.top = (v.y + 6) + 'px';
      let look = null, lookDot = 0;
      for (const [key, , name] of AXIS_LABELS) {
        const d = this.dirs[key];
        const a = imageAngle(tip, d) / DEG, m = inPlane(tip, d);
        const el = this.labelEls[key];
        el.setAttribute('x', (Math.sin(a) * 44).toFixed(1));
        el.setAttribute('y', (-Math.cos(a) * 44).toFixed(1));
        el.style.opacity = Math.max(0, (m - 0.25) / 0.5).toFixed(2);
        const f = d.dot(tip.fwd);
        if (f > lookDot) { lookDot = f; look = name; }
      }
      const gdir = this.gravity();
      const ga = imageAngle(tip, gdir);
      const fl = this.compass.querySelector('#cmpFluid');
      fl.setAttribute('transform', `rotate(${(ga + 180).toFixed(1)})`);
      fl.style.opacity = Math.max(0.15, inPlane(tip, gdir)).toFixed(2);
      this.compass.querySelector('#cmpLook').textContent = 'looking ' + (lookDot > 0.5 ? look.toLowerCase() : 'oblique');
      this.compass.querySelector('#cmpPos').textContent = (POSITIONS[this.position] || {}).label?.replace(' (standard)', '') || '';
    }
    // ---- curvature marks (stomach only) ----
    const lm = this.model.landmarks;
    const inStomach = tip.s > lm.cardia + 0.5 && tip.s < lm.pylorus - 1;
    const showC = this.showCurvature && inStomach;
    this.curv.classList.toggle('hidden', !showC);
    if (showC) {
      const ld = lesserDir(this.model, this.center, tip.s);
      const a = imageAngle(tip, ld) / DEG, m = inPlane(tip, ld);
      const cx = v.x + v.size / 2, cy = v.y + v.size / 2, R = v.size * 0.43;
      const place = (el, ang) => {
        el.style.left = (cx + Math.sin(ang) * R) + 'px';
        el.style.top = (cy - Math.cos(ang) * R) + 'px';
        el.style.opacity = Math.max(0, (m - 0.3) / 0.4).toFixed(2);
      };
      place(this.curv.querySelector('.lc'), a);
      place(this.curv.querySelector('.gc'), a + Math.PI);
    }
    // ---- guide labels ----
    const r = this.renderer;
    const show = r.guide.enabled && r.guide.center;
    this.guideLabels.classList.toggle('hidden', !show);
    if (show) {
      const gs = r.guideSize();
      this.guideLabels.style.width = this.guideLabels.style.height = gs + 'px';
      for (const [key] of AXIS_LABELS) {
        const p = r.guide.center.clone().addScaledVector(this.dirs[key], r.guide.radius * 0.95);
        const q = r.guideProject(p);
        const el = this.gl[key];
        const cx = q.x - gs / 2, cy = q.y - gs / 2;
        const len = Math.hypot(cx, cy);
        // axes pointing at/away from the viewer collapse to the centre: hide them
        el.style.display = len < gs * 0.12 ? 'none' : '';
        const k = Math.min(1, (gs / 2 - 10) / Math.max(len, 1));
        el.style.left = (gs / 2 + cx * k) + 'px';
        el.style.top = (gs / 2 + cy * k) + 'px';
      }
    }
  }
}

const _r = new THREE.Vector3(), _p = new THREE.Vector3(), _t = new THREE.Vector3();
